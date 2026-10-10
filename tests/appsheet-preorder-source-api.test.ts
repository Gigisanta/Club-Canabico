import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import type { CommandEnvelope } from "../shared/operations/contracts.js";
import { canonicalJson } from "../shared/operations/exact.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION } from "../shared/operations/appsheet-history.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { splitSqlStatements } from "./migration-sql.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const sha256Canonical = (value: unknown) => sha256(canonicalJson(value));

type SyntheticSheet = { sheetId: number; title: string; headers: string[]; rows: string[][] };
type MutableCapture = {
  headers: { schemaVersion: string; spreadsheetId: string; sheets: Array<Record<string, unknown>> };
  pages: Array<Record<string, unknown>>;
  manifest: Record<string, unknown>;
};
type SyntheticPendingHistorySource = ReturnType<typeof import("./support/appsheet-pending-import-fixture.js").syntheticPendingHistorySource>;

/**
 * API owner contract: a reviewed archive reader returns only rows from its bound
 * stable capture, paginates its validated relationships, and never creates live
 * operational effects. Existing pending-import API coverage exercises the real
 * source producer/stage/review gates, but does not own this reader's HTTP boundary.
 * Regression risks: source-value disclosure after authorization loss, foreign or
 * stale cursors, changed archived bytes/coverage, and a read causing an operation.
 * This uses no test-only production seam; the real stage and human review run below.
 */
function appendSyntheticPreSales(source: SyntheticPendingHistorySource, token: string) {
  const capture = source.capture as unknown as MutableCapture;
  const tables: SyntheticSheet[] = [
    {
      sheetId: 21,
      title: "Pre_Venta",
      headers: ["Id_Preventa", "fw_Cliente", "Pre_Fechaventa", "Estado_Preventa", "Segmento_Compra",
        "Pre_Gramos", "Subtotal_Venta", "Total_Facturado", "Id_facturado", "Aclaración"],
      rows: [
        [`synthetic-preventa-${token}-a`, `synthetic-client-${token}`, "2026-10-08", "Confirmado", "SYNTH",
          "3", "30", "30", "", `Synthetic private preorder marker ${token}`],
        [`synthetic-preventa-${token}-b`, `synthetic-client-${token}`, "2026-10-08", "Confirmado", "SYNTH",
          "3", "30", "30", "", "Synthetic second preorder"],
        [`synthetic-preventa-${token}-c`, `synthetic-client-${token}`, "2026-10-08", "Confirmado", "SYNTH",
          "3", "30", "30", "", "Synthetic preorder without details"],
      ],
    },
    {
      sheetId: 22,
      title: "Pre_Detalle_Fact",
      headers: ["Id_Pre_Detalle", "Id_Pre_Venta", "Pre_Artículo", "Pre_Cantidad_Gr", "Pre_Precio_gramo_línea", "Pre_Valor_Total"],
      rows: [
        [`synthetic-detail-${token}-a1`, `synthetic-preventa-${token}-a`, `synthetic-catalog-a1`, "1", "10", "10"],
        [`synthetic-detail-${token}-a2`, `synthetic-preventa-${token}-a`, "synthetic-catalog-a2", "2", "10", "20"],
        [`synthetic-detail-${token}-b1`, `synthetic-preventa-${token}-b`, "synthetic-catalog-b1", "3", "10", "30"],
      ],
    },
  ];

  const added = tables.map((table) => {
    const columns = table.headers.map((header, index) => ({ columnIndex: index + 1, header, sensitive: false }));
    const rows = table.rows.map((values, rowIndex) => {
      const sourceRow = rowIndex + 2;
      const cells = values.map((value, index) => {
        const cellValue = { stringValue: value };
        return { columnIndex: index + 1, userEnteredValue: cellValue, effectiveValue: cellValue };
      });
      const rowBody = { sourceRow, cells, unresolvedFormulaCells: [], safeColumnIndexes: columns.map((column) => column.columnIndex) };
      return { ...rowBody, rowHash: sha256(canonicalJson(rowBody)) };
    });
    const counts = { rowsWithValues: rows.length, rowsSerialized: rows.length, formulaCellCount: 0, unresolvedFormulaCount: 0 };
    const startRow = rows[0]?.sourceRow ?? 2;
    const endRow = rows.at(-1)?.sourceRow ?? startRow;
    const safeColumnIndexes = columns.map((column) => column.columnIndex);
    const pageBody = {
      schemaVersion: "appsheet-sheet-page/v1",
      spreadsheetId: capture.headers.spreadsheetId,
      sourceSystem: source.capture.manifest.sourceSystem,
      sheet: { sheetId: table.sheetId, title: table.title, mode: "grid", hidden: false, headerRow: 1,
        gridRows: endRow, gridColumns: columns.length },
      page: { index: 0, startRow, endRow, a1Ranges: [], safeColumnIndexes, omittedColumnIndexes: [], cellFields: "effectiveValue" },
      rows,
      counts,
    };
    const pageHash = sha256Canonical(pageBody);
    return {
      header: { sheetId: table.sheetId, title: table.title, mode: "grid", hidden: false, headerRow: 1,
        gridRows: endRow, gridColumns: columns.length, columns, pageCount: 1,
        safeColumnIndexes, omittedColumnIndexes: [] },
      page: { ...pageBody, pageHash },
      ref: { path: `pages/${table.sheetId}-0-${startRow}.json`, sheetId: table.sheetId, title: table.title,
        pageIndex: 0, startRow, endRow, pageHash, verifiedPageHash: pageHash, stable: true, counts },
    };
  });

  capture.headers = { ...capture.headers, sheets: [...capture.headers.sheets, ...added.map(({ header }) => header)] };
  capture.pages = [...capture.pages, ...added.map(({ page }) => page)];

  const oldManifest = capture.manifest;
  const oldPages = oldManifest.pages as Array<Record<string, unknown>>;
  const oldRecordCount = Number(oldManifest.dataRecordCount);
  const oldRowsWithValues = Number((oldManifest.coverage as Record<string, unknown>).rowsWithValues);
  const addedRecordCount = tables.reduce((sum, table) => sum + table.rows.length, 0);
  const pages = [...oldPages, ...added.map(({ ref }) => ref)];
  const stability = structuredClone(oldManifest.stability) as Record<string, unknown>;
  for (const key of ["firstPassPages", "verifiedPages", "matchedPages"]) {
    assert.equal(stability[key], oldPages.length, `la fixture base debe conciliar ${key}`);
    stability[key] = pages.length;
  }
  const headersHash = sha256Canonical(capture.headers);
  const dataHash = sha256Canonical(pages.map((page) => ({
    path: page.path,
    sheetId: page.sheetId,
    pageIndex: page.pageIndex,
    startRow: page.startRow,
    endRow: page.endRow,
    pageHash: page.pageHash,
    counts: page.counts,
  })));
  const coverage = structuredClone(oldManifest.coverage) as Record<string, unknown>;
  const oldCoverageSheets = coverage.sheets as Array<Record<string, unknown>>;
  coverage.totalPages = pages.length;
  coverage.rowsWithValues = oldRowsWithValues + addedRecordCount;
  coverage.bodySheetsCaptured = oldCoverageSheets.length + tables.length;
  coverage.dataRecordCount = oldRecordCount + addedRecordCount;
  coverage.sheets = [
    ...oldCoverageSheets,
    ...added.map(({ header }) => ({ sheetId: header.sheetId, title: header.title, mode: "grid", hidden: false,
      pageCount: 1, verifiedPageCount: 1, stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false,
      formulaCellCount: 0, unresolvedFormulaCount: 0 })),
  ];
  const manifestBase = {
    schemaVersion: oldManifest.schemaVersion,
    sourceSystem: oldManifest.sourceSystem,
    sourceId: oldManifest.sourceId,
    spreadsheetId: oldManifest.spreadsheetId,
    metadataHash: oldManifest.metadataHash,
    headersHash,
    dataHash,
    definitionHash: oldManifest.definitionHash,
    stability,
    coverage,
    pages,
    evidence: oldManifest.evidence,
    hashContract: oldManifest.hashContract,
  };
  const manifestHash = sha256Canonical(manifestBase);
  capture.manifest = {
    ...oldManifest,
    ...manifestBase,
    manifestHash,
    captureId: `appsreal-${manifestHash.slice(0, 16)}`,
    dataSheetCount: coverage.sheets instanceof Array ? coverage.sheets.length : undefined,
    dataPageCount: pages.length,
    dataRecordCount: coverage.dataRecordCount,
  };

  const definition = source.definition as unknown as {
    inventory: Record<string, unknown> & { sections: Array<Record<string, unknown>>; descriptorSha256: string };
    sourceSha256: string;
    descriptorSha256: string;
    appliedDefinitionHash: string;
  };
  const inventory = structuredClone(definition.inventory);
  const tableSection = inventory.sections.find((section) => section.category === "tables");
  assert.ok(tableSection, "synthetic definition includes its table inventory");
  const tableRecords = tableSection.records as Array<unknown>;
  tableSection.records = [...tableRecords, ...tables.map((table) => ({ category: "tables", name: table.title,
    fields: [], evidenceId: `synthetic-${table.title}`, children: [] }))];
  inventory.descriptorSha256 = "";
  const descriptorSha256 = sha256Canonical(inventory);
  inventory.descriptorSha256 = descriptorSha256;
  definition.inventory = inventory;
  definition.descriptorSha256 = descriptorSha256;
  definition.appliedDefinitionHash = sha256Canonical({ sourceSha256: definition.sourceSha256, descriptorSha256 });
  return { privateMarker: `Synthetic private preorder marker ${token}` };
}

test("AppSheet preorder source API paginates only reviewed archive rows and rejects stale or unauthorized reads", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 90_000,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");
  if (process.env.DATABASE_URL) {
    const applicationUrl = new URL(process.env.DATABASE_URL);
    assert.notEqual(`${databaseUrl.hostname}:${databaseUrl.port}${databaseUrl.pathname}`,
      `${applicationUrl.hostname}:${applicationUrl.port}${applicationUrl.pathname}`, "TEST_DATABASE_URL no puede ser la base de la aplicación");
  }

  const schema = `appsheet_preorder_source_api_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const destinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test", databaseUrl);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: randomBytes(32).toString("base64url"),
    ALLOWED_ORIGIN: "http://appsheet-preorder-source.test",
  });

  // Import this fixture only after DATABASE_URL is redirected to the isolated test DB:
  // its dependency graph reaches server/appsheet canonical modules that import db.ts.
  const { syntheticPendingHistorySource } = await import("./support/appsheet-pending-import-fixture.js");
  const { db } = await import("../server/db.js");
  const { app } = await import("../server/app.js");
  const { prepareAppSheetHistoryProjection, stageAppSheetHistoryProjection } = await import("../server/operations/appsheet-history.js");
  const source = syntheticPendingHistorySource();
  const token = randomUUID().replaceAll("-", "").slice(0, 12);
  const fixture = appendSyntheticPreSales(source, token);

  let schemaCreated = false;
  let server: import("node:http").Server | undefined;
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const actorIds = {
      sourceStager: `preorder-stager-${randomUUID()}`,
      sourceReviewer: `preorder-reviewer-${randomUUID()}`,
      authorizedReader: `preorder-authorized-reader-${randomUUID()}`,
      scopedReader: `preorder-scoped-reader-${randomUUID()}`,
      revokedReader: `preorder-revoked-reader-${randomUUID()}`,
      unauthorizedReader: `preorder-unprivileged-reader-${randomUUID()}`,
    };
    const httpPassword = `Synthetic-preorder-api-${randomUUID()}`;
    const passwordHash = await bcrypt.hash(httpPassword, 4);
    for (const [kind, id] of Object.entries(actorIds)) {
      await db.user.create({ data: { id, name: "Synthetic AppSheet preorder reader", email: `${id}@preorder-source.test`,
        password: passwordHash, role: "admin" } });
      const capabilities = kind === "unauthorizedReader" ? ["imports.read"] : ["imports.write", "imports.review"];
      await db.operationAccess.create({ data: { userId: id, profile: "admin", capabilities, scope: {} } });
    }

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const cookies: Record<string, string> = {};
    for (const id of Object.values(actorIds)) {
      const response = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { Origin: "http://appsheet-preorder-source.test", "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@preorder-source.test`, password: httpPassword }),
      });
      assert.equal(response.status, 200, `login HTTP sintético de ${id}: ${await response.text()}`);
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    const get = (actorId: string, path: string) => fetch(`${apiBase}${path}`, {
      headers: { Cookie: cookies[actorId]!, Origin: "http://appsheet-preorder-source.test" },
    });
    const postCommand = (actorId: string, envelope: CommandEnvelope) => fetch(`${apiBase}/operations/commands`, {
      method: "POST",
      headers: { Cookie: cookies[actorId]!, Origin: "http://appsheet-preorder-source.test", "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    const prepared = prepareAppSheetHistoryProjection(source.capture, source.definition);
    const stageBackup = { manifestHash: sha256("synthetic preorder history backup"), snapshotAt: new Date(Date.now() - 60_000).toISOString() };
    const stageCommitSha = sha256("synthetic preorder source commit").slice(0, 40);
    const technicalReview = {
      schemaVersion: 2,
      reviewKind: "independent-technical",
      captureId: source.capture.manifest.captureId,
      manifestHash: source.capture.manifest.manifestHash,
      definitionHash: source.definition.appliedDefinitionHash,
      projectionKind: "history",
      projectionHash: prepared.projectionHash,
      commitSha: stageCommitSha,
      target: "isolated-test",
      destinationIdentity,
      importer: APPSHEET_HISTORY_IMPORTER_VERSION,
      reviewer: `technical-preorder-${randomUUID()}`,
      approved: true,
      reviewedAt: new Date(Date.now() - 120_000).toISOString(),
      findings: [],
    };
    const staged = await stageAppSheetHistoryProjection(prepared, {
      actorId: actorIds.sourceStager,
      technicalReview,
      commitSha: stageCommitSha,
      target: "isolated-test",
      destinationIdentity,
      backupEvidence: stageBackup,
    }, db);
    assert.equal(staged.status, "staged");
    assert.equal(staged.metrics.tableCounts.Pre_Venta, 3);
    assert.equal(staged.metrics.tableCounts.Pre_Detalle_Fact, 3);
    const snapshotId = staged.snapshotId;
    const rootPath = `/operations/appsheet-migration/snapshots/${snapshotId}/preventas`;
    const effects = async () => ({
      orders: await db.operationOrder.count(),
      deliveries: await db.deliveryAssignment.count(),
      stockFacts: await db.stockFact.count(),
      stockBalances: await db.stockBalance.count(),
      ledgerEvents: await db.ledgerEvent.count(),
      cashEntries: await db.cashEntry.count(),
      outbox: await db.operationOutbox.count(),
      audits: await db.operationAudit.count(),
      receipts: await db.commandReceipt.count(),
      operationObjects: await db.operationObject.count(),
      authority: await db.operationAuthority.findUnique({ where: { id: "operations" } }),
    });
    const beforeUnreviewedRead = await effects();
    const unreviewedResponse = await get(actorIds.authorizedReader, `${rootPath}?limit=1`);
    const unreviewedBody = await unreviewedResponse.text();
    assert.equal(unreviewedResponse.status, 423, "la fuente archivada no se lee antes de la revisión humana");
    assert.ok(!unreviewedBody.includes(fixture.privateMarker), "la captura pendiente no revela valores originales");
    assert.deepEqual(await effects(), beforeUnreviewedRead, "el rechazo previo a la revisión no escribe efectos ni auditoría");

    const request = (command: string, data: Record<string, unknown>): CommandEnvelope => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId: snapshotId,
      command,
      data,
      expectedVersion: 0,
      occurredAt: new Date().toISOString(),
    });
    const reviewRequest = request("AppSheetHistorySourceReviewed", {
      fileHash: source.capture.manifest.manifestHash,
      captureId: source.capture.manifest.captureId,
      dataHash: source.capture.manifest.dataHash,
      projectionHash: prepared.projectionHash,
      evidenceReference: "Synthetic independent review of the stable archive capture",
    });
    const reviewResponse = await postCommand(actorIds.sourceReviewer, reviewRequest);
    assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());
    const review = await reviewResponse.json() as { result: Record<string, unknown> };
    assert.equal(review.result.status, "reviewed");

    const getWithoutEffects = async (actorId: string, path: string) => {
      const before = await effects();
      const response = await get(actorId, path);
      const after = await effects();
      assert.deepEqual(after, before, `GET ${path} no debe escribir efectos operativos, audit ni receipts`);
      return response;
    };
    const readBeforeEffects = await effects();
    const firstResponse = await getWithoutEffects(actorIds.authorizedReader, `${rootPath}?limit=1`);
    assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
    const firstPage = await firstResponse.json() as {
      source: { classification: string; captureStability: string; currentBomboAuthority: unknown };
      coverage: { expectedRecords: number };
      items: Array<{ sourceRecordId: string; sourceRow: number; sourceRecordHash: string; original: unknown; normalized: unknown }>;
      nextCursor: string | null;
    };
    assert.equal(firstPage.source.classification, "provisional_archive_only");
    assert.equal(firstPage.source.captureStability, "stable_at_capture");
    assert.equal(firstPage.source.currentBomboAuthority, null, "leer archivo no exige habilitar autoridad operativa");
    assert.equal(firstPage.coverage.expectedRecords, 3);
    assert.equal(firstPage.items.length, 1);
    assert.match(firstPage.items[0]!.sourceRecordHash, /^[a-f0-9]{64}$/);
    assert.ok(JSON.stringify(firstPage.items[0]!.original).includes(fixture.privateMarker), "la fuente original se entrega al lector autorizado");
    assert.ok(firstPage.nextCursor, "la página incompleta devuelve un cursor");

    const secondResponse = await getWithoutEffects(actorIds.authorizedReader,
      `${rootPath}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`);
    assert.equal(secondResponse.status, 200, await secondResponse.clone().text());
    const secondPage = await secondResponse.json() as typeof firstPage;
    assert.equal(secondPage.items.length, 1);
    assert.notEqual(secondPage.items[0]!.sourceRecordId, firstPage.items[0]!.sourceRecordId);
    assert.ok(secondPage.nextCursor);
    const foreignSnapshotCursorPayload = JSON.parse(Buffer.from(firstPage.nextCursor!, "base64url").toString("utf8")) as Record<string, unknown>;
    foreignSnapshotCursorPayload.snapshotId = `${snapshotId}-foreign`;
    const foreignSnapshotCursor = Buffer.from(JSON.stringify(foreignSnapshotCursorPayload)).toString("base64url");
    const foreignSnapshotResponse = await getWithoutEffects(actorIds.authorizedReader,
      `${rootPath}?limit=1&cursor=${encodeURIComponent(foreignSnapshotCursor)}`);
    assert.equal(foreignSnapshotResponse.status, 400, "el cursor de otra captura se rechaza antes de devolver filas");

    const detailsPath = (sourceRecordId: string) =>
      `/operations/appsheet-migration/snapshots/${snapshotId}/preventas/${sourceRecordId}/detalles`;
    const firstDetailsResponse = await getWithoutEffects(actorIds.authorizedReader,
      `${detailsPath(firstPage.items[0]!.sourceRecordId)}?limit=1`);
    assert.equal(firstDetailsResponse.status, 200, await firstDetailsResponse.clone().text());
    const firstDetails = await firstDetailsResponse.json() as {
      relationship: { status: string; matchCount: number };
      items: Array<{ sourceRow: number; normalized: { columns: Array<{ header: string | null; value: string | null }> } }>;
      nextCursor: string | null;
    };
    assert.equal(firstDetails.relationship.status, "multiple");
    assert.equal(firstDetails.relationship.matchCount, 2);
    assert.equal(firstDetails.items.length, 1);
    assert.ok(firstDetails.nextCursor, "los detalles vinculados también se paginan");
    const secondDetailsResponse = await getWithoutEffects(actorIds.authorizedReader,
      `${detailsPath(firstPage.items[0]!.sourceRecordId)}?limit=1&cursor=${encodeURIComponent(firstDetails.nextCursor)}`);
    assert.equal(secondDetailsResponse.status, 200, await secondDetailsResponse.clone().text());
    const secondDetails = await secondDetailsResponse.json() as typeof firstDetails;
    assert.equal(secondDetails.items.length, 1);
    assert.notEqual(secondDetails.items[0]!.sourceRow, firstDetails.items[0]!.sourceRow);
    const parentForeignCursorResponse = await getWithoutEffects(actorIds.authorizedReader,
      `${detailsPath(secondPage.items[0]!.sourceRecordId)}?limit=1&cursor=${encodeURIComponent(firstDetails.nextCursor)}`);
    assert.equal(parentForeignCursorResponse.status, 400, "un cursor de detalle no se puede reutilizar con otra preventa");

    const thirdResponse = await getWithoutEffects(actorIds.authorizedReader,
      `${rootPath}?limit=1&cursor=${encodeURIComponent(secondPage.nextCursor!)}`);
    assert.equal(thirdResponse.status, 200, await thirdResponse.clone().text());
    const thirdPage = await thirdResponse.json() as typeof firstPage;
    assert.equal(thirdPage.items.length, 1);
    assert.equal(thirdPage.nextCursor, null);
    const noDetailsResponse = await getWithoutEffects(actorIds.authorizedReader,
      `${detailsPath(thirdPage.items[0]!.sourceRecordId)}?limit=10`);
    assert.equal(noDetailsResponse.status, 200, await noDetailsResponse.clone().text());
    const noDetails = await noDetailsResponse.json() as {
      relationship: { status: string; detailsAvailable: boolean };
      coverage: { linkedRecords: number };
      items: unknown[];
    };
    assert.equal(noDetails.relationship.status, "missing");
    assert.equal(noDetails.relationship.detailsAvailable, true);
    assert.equal(noDetails.coverage.linkedRecords, 0);
    assert.deepEqual(noDetails.items, []);

    const deniedResponse = await getWithoutEffects(actorIds.unauthorizedReader, `${rootPath}?limit=1`);
    assert.equal(deniedResponse.status, 403);
    assert.ok(!(await deniedResponse.text()).includes(fixture.privateMarker), "un lector sin imports.review no recibe valores originales");
    await db.operationAccess.update({ where: { userId: actorIds.scopedReader }, data: { scope: { memberIds: [] } } });
    const scopedResponse = await getWithoutEffects(actorIds.scopedReader, `${rootPath}?limit=1`);
    assert.equal(scopedResponse.status, 403, "un alcance operativo parcial no habilita lectura completa del archivo");
    assert.ok(!(await scopedResponse.text()).includes(fixture.privateMarker));
    await db.operationAccess.update({ where: { userId: actorIds.revokedReader }, data: { capabilities: ["imports.read"] } });
    const revokedResponse = await getWithoutEffects(actorIds.revokedReader, `${rootPath}?limit=1`);
    assert.equal(revokedResponse.status, 403, "la capacidad actual se comprueba en cada lectura");
    assert.ok(!(await revokedResponse.text()).includes(fixture.privateMarker));

    const sourceRow = await db.legacySourceRecord.findFirstOrThrow({ where: { snapshotId, sourceTable: "Pre_Venta" },
      select: { id: true, normalized: true } });
    const originalNormalized = structuredClone(sourceRow.normalized);
    const alteredNormalized = { ...(originalNormalized as Record<string, unknown>), syntheticMutation: "changed" };
    await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacySourceRecord" DISABLE TRIGGER "LegacySourceRecord_immutable"`);
    try {
      await db.legacySourceRecord.update({ where: { id: sourceRow.id }, data: { normalized: alteredNormalized as Prisma.InputJsonValue } });
      const changedRowResponse = await getWithoutEffects(actorIds.authorizedReader, `${rootPath}?limit=1`);
      assert.equal(changedRowResponse.status, 423, "una proyección archivada alterada se rechaza aunque conserve el hash declarado");
      assert.equal((await changedRowResponse.json() as { code: string }).code, "APPSHEET_PREORDER_SOURCE_INTEGRITY");
    } finally {
      try {
        await db.legacySourceRecord.update({ where: { id: sourceRow.id }, data: { normalized: originalNormalized as Prisma.InputJsonValue } });
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacySourceRecord" ENABLE TRIGGER "LegacySourceRecord_immutable"`);
      }
    }

    const snapshot = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId }, select: { coverage: true } });
    const originalCoverage = structuredClone(snapshot.coverage);
    const tamperedCoverage = structuredClone(originalCoverage) as { sheets: Array<Record<string, unknown>> };
    const preorderCoverage = tamperedCoverage.sheets.find((sheet) => sheet.sourceTable === "Pre_Venta");
    assert.ok(preorderCoverage);
    preorderCoverage.sourceRecordCount = Number(preorderCoverage.sourceRecordCount) + 1;
    await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacyImportSnapshot" DISABLE TRIGGER "LegacyImportSnapshot_source_capture_immutable"`);
    try {
      await db.legacyImportSnapshot.update({ where: { id: snapshotId }, data: { coverage: tamperedCoverage as Prisma.InputJsonValue } });
      const changedCoverageResponse = await getWithoutEffects(actorIds.authorizedReader, `${rootPath}?limit=1`);
      assert.ok(changedCoverageResponse.status >= 400, "la cobertura archivada alterada no puede producir una lectura aparentemente completa");
    } finally {
      try {
        await db.legacyImportSnapshot.update({ where: { id: snapshotId }, data: { coverage: originalCoverage as Prisma.InputJsonValue } });
      } finally {
        await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."LegacyImportSnapshot" ENABLE TRIGGER "LegacyImportSnapshot_source_capture_immutable"`);
      }
    }
    assert.deepEqual(await effects(), readBeforeEffects, "todas las lecturas mantienen intactos pedidos, stock, caja, ledger, audits y receipts");
  } finally {
    if (server) await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
