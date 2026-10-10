import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";
import { previewAppSheetInvoiceSequenceSeed } from "../server/operations/appsheet-invoice-sequence.js";
import { OperationError } from "../server/operations/core.js";
import {
  AppSheetHistoryStageError,
  prepareAppSheetHistoryProjection,
  stageAppSheetHistoryProjection,
  type AppSheetHistoryDefinition,
  type LoadedAppSheetHistoryCapture,
} from "../server/operations/appsheet-history.js";
import { finalDeltaProofForCapture } from "../server/operations/access.js";
import { APPSHEET_EXPECTED_LIVE_APP_ID } from "../server/operations/appsheet-canonical.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_MAPPING_ID, APPSHEET_HISTORY_SOURCE_SYSTEM } from "../shared/operations/appsheet-history.js";
import { APPSHEET_CANONICAL_SOURCE_SYSTEM } from "../shared/operations/appsheet-canonical.js";
import { canonicalJson } from "../shared/operations/exact.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const preciseColorRedText = "0.12345678901234566";
const preciseColorRed = Number(preciseColorRedText);
const historyTestDestinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test",
  new URL("postgresql://fixture:fixture@127.0.0.1:5432/bombo_ui_history_contract?schema=public&sslmode=require"));
function historyCapture(): LoadedAppSheetHistoryCapture {
  const manifestHash = sha256(`synthetic-history-capture:${randomUUID()}`);
  const captureId = `appsreal-${manifestHash.slice(0, 16)}`;
  const spreadsheetId = `synthetic-spreadsheet-${randomUUID()}`;
  const now = Date.now();
  const pauseStartedAt = new Date(now - 300_000).toISOString();
  const firstReadAt = new Date(now - 240_000).toISOString();
  const verificationStartedAt = new Date(now - 180_000).toISOString();
  const verificationCompletedAt = new Date(now - 120_000).toISOString();
  const cutoffAt = new Date(now - 60_000).toISOString();
  const sourceSheets = [
    { sheetId: 1, title: "C_Cliente", headers: ["Id_Cliente"], values: ["synthetic-member-1"] },
    { sheetId: 2, title: "D_Catalogo_Mercaderia", headers: ["CatalogoID"], values: ["synthetic-catalog-1"] },
    { sheetId: 3, title: "C_Facturacion", headers: ["Id_Factura", "Id_Oculto", "N_factura", "Id_Cliente", "Fecha", "Total_Facturado", "Cantidad_Gr", "Tipo_Moneda"],
      values: ["synthetic-invoice-1", 41, "2025|FA0040", "synthetic-member-1", "2026-10-08", 12, 5, "ARS"] },
    { sheetId: 4, title: "C_Detalle_Fact", headers: ["Id_Detalle", "Id_Factura", "Artículo", "Fecha", "Valor_Total", "Cantidad_Gr"],
      values: ["synthetic-detail-1", "synthetic-invoice-1", "", "2026-10-08", 12, 5] },
    { sheetId: 5, title: "Movimiento_Nueva", headers: ["ID_Movimiento_Unique", "ID_Movimiento", "Fecha", "Tipo_Movimiento", "Concepto", "Caja", "Monto", "Tipo_Moneda", "Afecta_Resultado", "Tabla_Origen", "Origen_ID", "ID_Origen_2"],
      values: ["synthetic-payment-1", "", "2026-10-08", "ingreso", "Pago de factura sintética", "Caja sintética", 12, "ARS", true, "venta", "synthetic-invoice-1", "2025|FA0040"] },
  ];
  const dataPages = sourceSheets.map((source) => {
    const columns = source.headers.map((header, index) => ({ columnIndex: index + 1, header, sensitive: false }));
    const cells = source.values.map((value, index) => {
      const cell = { columnIndex: index + 1, effectiveValue: typeof value === "number"
        ? { numberValue: value } : typeof value === "boolean" ? { boolValue: value } : { stringValue: value } };
      return source.title === "C_Cliente" && index === 0 ? {
        ...cell,
        userEnteredFormat: { backgroundColor: { red: preciseColorRed, green: Number("0.00000012345678901234567"), blue: 0.9999999999999999 } },
      } : cell;
    });
    const row = { sourceRow: 2, cells, unresolvedFormulaCells: [], rowHash: sha256(canonicalJson(cells)) };
    const counts = { rowsWithValues: 1, rowsSerialized: 1, formulaCellCount: 0, unresolvedFormulaCount: 0 };
    const pageHash = sha256(canonicalJson({ sheetId: source.sheetId, title: source.title, row }));
    const path = `pages/${source.sheetId}-0-1.json`;
    return {
      header: { sheetId: source.sheetId, title: source.title, mode: "grid", hidden: false, headerRow: 1, gridRows: 2,
        gridColumns: source.headers.length, columns, pageCount: 1, safeColumnIndexes: columns.map((column) => column.columnIndex), omittedColumnIndexes: [] },
      page: { schemaVersion: "appsheet-sheet-page/v1", spreadsheetId, sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        sheet: { sheetId: source.sheetId, title: source.title, mode: "grid", hidden: false, headerRow: 1, gridRows: 2, gridColumns: source.headers.length },
        page: { index: 0, startRow: 2, endRow: 2, a1Ranges: [], safeColumnIndexes: columns.map((column) => column.columnIndex),
          omittedColumnIndexes: [], cellFields: "effectiveValue" }, rows: [row], counts, pageHash },
      ref: { path, sheetId: source.sheetId, title: source.title, pageIndex: 0, startRow: 2, endRow: 2,
        pageHash, verifiedPageHash: pageHash, stable: true, counts },
    };
  });
  const excludedSheet = {
    sheetId: 6, title: "T_Usuarios", mode: "grid", hidden: true, headerRow: 1, gridRows: 1, gridColumns: 1,
    columns: [{ columnIndex: 1, header: "UserID", sensitive: false }], pageCount: 0,
    safeColumnIndexes: [], omittedColumnIndexes: [], bodyExcluded: true, bodyExclusionReason: "authentication-table-body-redacted",
  };
  const pageRefs = dataPages.map(({ ref }) => ({ path: ref.path, sheetId: ref.sheetId, pageIndex: ref.pageIndex,
    startRow: ref.startRow, endRow: ref.endRow, pageHash: ref.pageHash, counts: ref.counts }));
  const dataHash = sha256(canonicalJson(pageRefs));
  const dataCoverage = {
    metadataStable: true, headersStableAll: true, totalPages: dataPages.length, rowsWithValues: dataPages.length,
    bodySheetsCaptured: 5, dataRecordCount: dataPages.length, failedPages: 0, changedPages: 0, unresolvedFormulaCount: 0,
    sheets: [
      ...dataPages.map(({ ref }) => ({ sheetId: ref.sheetId, title: ref.title, pageCount: 1, verifiedPageCount: 1,
        stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false })),
      { sheetId: excludedSheet.sheetId, title: excludedSheet.title, pageCount: 0, verifiedPageCount: 0,
        stablePageCount: 0, changedPageCount: 0, bodyRead: false, bodyExcluded: true,
        bodyExclusionReason: "authentication-table-body-redacted" },
    ],
  };
  const stability = {
    stable: true, cutoverEligible: true, metadataStable: true, headersStable: true, pageHashesStable: true, scanComplete: true,
    firstPassPages: dataPages.length, verifiedPages: dataPages.length, matchedPages: dataPages.length, changedPages: 0,
    failedPages: 0, missingPages: 0, unresolvedFormulaCount: 0, sourceWriteDetected: false, bodyExcludedSheets: ["T_Usuarios"],
  };
  const manifest = {
    schemaVersion: "appsheet-capture-manifest/v1",
    captureId, sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: spreadsheetId, spreadsheetId,
    manifestHash, dataHash, metadataHash: sha256(`metadata:${manifestHash}`), headersHash: sha256(`headers:${manifestHash}`), definitionHash: null,
    firstReadAt, verificationStartedAt, verificationCompletedAt, cutoffAt, timestampGaps: [], stability,
    dataSheetCount: 5, dataPageCount: dataPages.length, dataRecordCount: dataPages.length, dataFormulaCount: 0, dataUnresolvedFormulaCount: 0,
    definitionCoverage: null, definitionTableCount: null, definitionColumnCount: null, definitionSliceCount: null, definitionViewCount: null,
    definitionActionCount: null, definitionBotCount: null, definitionWorkflowRuleCount: null, definitionFormatRuleCount: null,
    coverage: { ...dataCoverage, sheets: dataCoverage.sheets.map((sheet) => ({ ...sheet, formulaCellCount: 0, unresolvedFormulaCount: 0 })) },
    pages: dataPages.map(({ ref }) => ref),
  };
  const headers = {
    schemaVersion: "appsheet-sheet-headers/v1", spreadsheetId,
    sheets: [...dataPages.map(({ header }) => header), excludedSheet],
  };
  return {
    directory: "/synthetic/private-capture", mode: "stable", manifest,
    headers,
    pages: dataPages.map(({ page }) => page),
    pagesBySheet: new Map(), deltaEvidence: [],
  } as unknown as LoadedAppSheetHistoryCapture;
}

function historyDefinition(): AppSheetHistoryDefinition {
  const sourceSha256 = sha256("synthetic AppSheet definition source");
  const descriptorSha256 = sha256("synthetic AppSheet definition descriptor");
  const tableNames = ["C_Cliente", "D_Catalogo_Mercaderia", "C_Facturacion", "C_Detalle_Fact", "Movimiento_Nueva", "T_Usuarios"];
  return {
    inventory: { parserVersion: "bombo-appsheet-definition/1.2.0", source: { sha256: sourceSha256 }, descriptorSha256,
      app: { id: APPSHEET_EXPECTED_LIVE_APP_ID }, observedCounts: {},
      sections: [{ category: "tables", title: "Tables", sectionPath: ["Tables"], evidenceId: "synthetic-table-inventory",
        records: tableNames.map((name) => ({ category: "tables", name, fields: [], evidenceId: `synthetic-${name}`, children: [] })) }] },
    sourceSha256, descriptorSha256, fileSha256: sha256("synthetic AppSheet definition file"),
    appliedDefinitionHash: sha256(canonicalJson({ sourceSha256, descriptorSha256 })), identityState: "verified",
  } as unknown as AppSheetHistoryDefinition;
}

test("history staging rejects a missing definition parser version before starting a transaction", async () => {
  const capture = historyCapture();
  const definition = historyDefinition();
  delete (definition.inventory as Partial<typeof definition.inventory>).parserVersion;
  const prepared = prepareAppSheetHistoryProjection(capture, definition);
  const actorId = `history-stage-${randomUUID()}`;
  const commitSha = "a".repeat(40);
  const destinationIdentity = historyTestDestinationIdentity;
  const technicalReview = {
    schemaVersion: 2, reviewKind: "independent-technical", captureId: capture.manifest.captureId,
    manifestHash: capture.manifest.manifestHash, definitionHash: definition.appliedDefinitionHash,
    projectionKind: "history", projectionHash: prepared.projectionHash, commitSha,
    target: "isolated-test", destinationIdentity, importer: APPSHEET_HISTORY_IMPORTER_VERSION,
    reviewer: "synthetic-independent-reviewer", approved: true, reviewedAt: "2026-10-09T12:00:00.000Z", findings: [],
  };
  let transactionCount = 0;
  const client = { $transaction: async () => { transactionCount++; throw new Error("must_not_start"); } } as unknown as PrismaClient;
  await assert.rejects(stageAppSheetHistoryProjection(prepared, {
    actorId, technicalReview, commitSha, target: "isolated-test", destinationIdentity,
    backupEvidence: { manifestHash: sha256("synthetic backup metadata fixture"), snapshotAt: "2026-10-09T12:05:00.000Z" },
  }, client), (error) => error instanceof AppSheetHistoryStageError && error.code === "definition_parser_version_invalid");
  assert.equal(transactionCount, 0);
});

test("history writer persists its stable top-level coverage for invoice-sequence preview", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const rawDatabaseUrl = process.env.TEST_DATABASE_URL!;
  const databaseUrl = new URL(rawDatabaseUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_(?:test|ci|optimization)(?:_[a-z0-9_-]+)?$/i,
    "usar sólo una base descartable bombo_ui_test/ci/optimization");
  if (process.env.DATABASE_URL) {
    const applicationUrl = new URL(process.env.DATABASE_URL);
    assert.notEqual(`${databaseUrl.hostname}:${databaseUrl.port}${databaseUrl.pathname}`, `${applicationUrl.hostname}:${applicationUrl.port}${applicationUrl.pathname}`,
      "TEST_DATABASE_URL no puede ser la base de la aplicación");
  }
  const schema = `appsheet_invoice_seed_history_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const db = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  let schemaCreated = false;
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

    const stageActorId = `history-stage-${randomUUID()}`;
    const historyReviewerId = `history-reviewer-${randomUUID()}`;
    const gateApproverId = `history-approver-${randomUUID()}`;
    const gateReviewerId = `history-gate-reviewer-${randomUUID()}`;
    for (const [id, role] of [[stageActorId, "admin"], [historyReviewerId, "admin"], [gateApproverId, "owner"], [gateReviewerId, "admin"]] as const) {
      await db.user.create({ data: { id, name: "Synthetic AppSheet contract actor", email: `${id}@contract.test`, password: `fixture-${randomUUID()}`, role } });
    }
    await db.operationAccess.create({ data: { userId: stageActorId, profile: "admin", capabilities: ["imports.write"], scope: {} } });

    const capture = historyCapture();
    const definition = historyDefinition();
    const prepared = prepareAppSheetHistoryProjection(capture, definition);
    const commitSha = "a".repeat(40);
    const reviewedAt = "2026-10-09T12:00:00.000Z";
    const backupSnapshotAt = "2026-10-09T12:05:00.000Z";
    const technicalReview = {
      schemaVersion: 2, reviewKind: "independent-technical", captureId: capture.manifest.captureId,
      manifestHash: capture.manifest.manifestHash, definitionHash: definition.appliedDefinitionHash,
      projectionKind: "history", projectionHash: prepared.projectionHash, commitSha,
      target: "isolated-test", destinationIdentity: historyTestDestinationIdentity,
      importer: APPSHEET_HISTORY_IMPORTER_VERSION, reviewer: "synthetic-independent-reviewer", approved: true,
      reviewedAt, findings: [],
    };
    const stageOptions = {
      actorId: stageActorId, technicalReview, commitSha, target: "isolated-test" as const,
      destinationIdentity: historyTestDestinationIdentity,
      backupEvidence: { manifestHash: sha256("synthetic backup metadata fixture"), snapshotAt: backupSnapshotAt },
    };
    const moneyFact = prepared.persistedFacts.find((fact) => fact.amountMinor !== null);
    const quantityFact = prepared.persistedFacts.find((fact) => fact.quantity !== null);
    assert.ok(moneyFact && typeof moneyFact.amountMinor === "bigint", "la fixture cubre el importe exacto BigInt");
    assert.ok(quantityFact?.quantity instanceof Prisma.Decimal, "la fixture cubre el roundtrip Decimal de cantidad");
    const metadataRecord = prepared.persistedRecords.find((record) => record.sourceTable === "C_Cliente" && record.sourceRow === 2);
    assert.ok(metadataRecord, "la fixture contiene la fila con metadato numérico de formato");
    const expectedOriginal = metadataRecord.original as { columns: Array<{ value: { userEnteredFormat?: { backgroundColor?: { red?: number } } } }> };
    assert.equal(expectedOriginal.columns[0]?.value.userEnteredFormat?.backgroundColor?.red, preciseColorRed);

    const staged = await stageAppSheetHistoryProjection(prepared, stageOptions, db);
    assert.equal(staged.status, "staged");
    assert.equal(staged.replay, false);
    assert.equal(staged.metrics.recordCount, 5);
    assert.equal(staged.metrics.factCount, 5);
    assert.equal(staged.metrics.exceptionCount, 0, "los registros sintéticos tienen los vínculos mínimos para no forzar una resolución ajena a esta prueba");

    const snapshotId = staged.snapshotId;
    const rawOriginalRows = await db.$queryRaw<Array<{ originalText: string }>>(Prisma.sql`
      SELECT "original"::text AS "originalText"
      FROM "LegacySourceRecord"
      WHERE "id" = ${metadataRecord.id}
    `);
    assert.equal(rawOriginalRows.length, 1);
    assert.match(rawOriginalRows[0]!.originalText,
      new RegExp(`"red"\\s*:\\s*${preciseColorRedText.replace(".", "\\.")}(?=[,}])`),
      "PostgreSQL debe conservar el componente decimal del JSON original sin redondeo");

    const countRows = async () => ({
      records: await db.legacySourceRecord.count({ where: { snapshotId } }),
      facts: await db.legacyHistoricalFact.count({ where: { snapshotId } }),
      exceptions: await db.legacyException.count({ where: { snapshotId } }),
    });
    const countsBeforeReplay = await countRows();
    assert.deepEqual(countsBeforeReplay, { records: 5, facts: 5, exceptions: 0 });
    const snapshotBeforeReplay = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    assert.equal(snapshotBeforeReplay.status, "staged");
    assert.equal(snapshotBeforeReplay.reviewedBy, null);
    const replayed = await stageAppSheetHistoryProjection(prepared, stageOptions, db);
    assert.equal(replayed.replay, true);
    assert.deepEqual(await countRows(), countsBeforeReplay, "el replay no duplica filas persistidas");
    const snapshotAfterReplay = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    assert.equal(snapshotAfterReplay.status, "staged");
    assert.equal(snapshotAfterReplay.reviewedBy, null);

    const sourceCapture = await db.appSheetCaptureManifest.findUniqueOrThrow({ where: { captureId: capture.manifest.captureId } });
    const finalDeltaInput = {
      manualPauseStartedAt: new Date(sourceCapture.firstReadAt.getTime() - 60_000).toISOString(),
      manualPauseEndedAt: null,
      manualPauseEvidenceRef: "synthetic-fixture:manual-pause",
      expectedHandoffChangesRef: "synthetic-fixture:separate-delta-review",
    };
    const finalDelta = finalDeltaProofForCapture(sourceCapture, finalDeltaInput);
    await db.cutoverGate.create({ data: {
      id: "final-delta-reconciled", status: "approved", captureManifestId: sourceCapture.captureId,
      approvedBy: gateApproverId, reviewedBy: gateReviewerId, approvedAt: new Date(),
      evidence: { humanEvidence: { reference: "synthetic test fixture" }, appSheetReplacement: {
        schemaVersion: 1, captureId: sourceCapture.captureId, manifestHash: sourceCapture.manifestHash,
        dataHash: sourceCapture.dataHash, captureDefinitionHash: sourceCapture.definitionHash,
        appliedDefinitionHash: sha256("synthetic applied definition binding"), gateProof: { finalDelta },
      } },
    } });

    await db.legacyImportSnapshot.update({ where: { id: snapshotId }, data: {
      status: "reviewed", reviewedBy: historyReviewerId, reviewedAt: new Date(),
    } });
    const publicationFingerprint = sha256("synthetic history publication fingerprint");
    await db.legacyHistoryPublication.create({ data: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, snapshotId, fileHash: capture.manifest.manifestHash,
      mappingId: APPSHEET_HISTORY_MAPPING_ID, fingerprint: publicationFingerprint, publishedBy: historyReviewerId,
      evidence: { reference: "synthetic history publication fixture" },
    } });

    const persisted = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    const persistedCoverage = persisted.coverage as Prisma.JsonObject;
    assert.equal(persistedCoverage.schemaVersion, "appsheet-history-coverage/v1");
    assert.equal(persistedCoverage.projectionKind, "history");
    assert.equal(persistedCoverage.sourceSystem, APPSHEET_HISTORY_SOURCE_SYSTEM);
    assert.equal(persistedCoverage.captureId, capture.manifest.captureId);
    assert.equal(persistedCoverage.manifestHash, capture.manifest.manifestHash);
    assert.equal(persistedCoverage.dataHash, capture.manifest.dataHash);
    assert.equal(persistedCoverage.mode, "stable");
    assert.equal("appSheetCanonical" in persistedCoverage, false, "el writer no agrega un envelope duplicado");

    const effectsBeforePreview = {
      sequences: await db.appSheetInvoiceSequence.count(),
      reservations: await db.appSheetInvoiceNumberReservation.count(),
      ledgerEvents: await db.ledgerEvent.count(),
      stockFacts: await db.stockFact.count(),
      outbox: await db.operationOutbox.count(),
      audits: await db.operationAudit.count(),
    };
    const previewAttempt = await db.$transaction(async (tx) => {
      try {
        return { preview: await previewAppSheetInvoiceSequenceSeed(tx, { captureId: sourceCapture.captureId, snapshotId }) } as const;
      } catch (error) {
        return { error } as const;
      }
    });
    if ("error" in previewAttempt) {
      const code = previewAttempt.error instanceof OperationError ? previewAttempt.error.code : null;
      const details = previewAttempt.error instanceof OperationError ? previewAttempt.error.details : null;
      assert.fail(`el writer real debe ser aceptado por el consumer; gateCode=${code ?? "unknown"} gateDetails=${JSON.stringify(details)}`);
    }
    assert.equal(previewAttempt.preview.seedable, true);
    assert.equal(previewAttempt.preview.captureId, sourceCapture.captureId);
    assert.equal(previewAttempt.preview.snapshotId, snapshotId);
    assert.equal(previewAttempt.preview.invoiceRecordCount, 1);
    assert.equal(previewAttempt.preview.numberedInvoiceCount, 1);
    assert.equal(previewAttempt.preview.maxHiddenId, "41");
    assert.match(previewAttempt.preview.previewDigest, /^[a-f0-9]{64}$/);

    const setCoverage = async (coverage: Prisma.InputJsonValue) => db.legacyImportSnapshot.update({ where: { id: snapshotId }, data: { coverage } });
    const expectCoverageWriteRejected = async (label: string, coverage: Prisma.InputJsonValue) => {
      let writeError: unknown;
      try {
        await setCoverage(coverage);
      } catch (error) {
        writeError = error;
      }
      assert.ok(writeError instanceof Error, `${label}: la captura publicada debe rechazar el cambio de coverage`);
      assert.match(writeError.message, /23514/);
      assert.match(writeError.message, /Snapshot source and capture linkage are immutable/);
      const unchanged = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
      assert.deepEqual(unchanged.coverage, persistedCoverage, `${label}: el rechazo conserva la coverage publicada`);
    };
    const invalidBinding = { ...persistedCoverage, dataHash: sha256("mismatched capture data") } as Prisma.InputJsonValue;
    await expectCoverageWriteRejected("dataHash distinto a la captura", invalidBinding);
    const invalidStability = {
      ...persistedCoverage,
      stability: { ...(persistedCoverage.stability as Prisma.JsonObject), pageHashesStable: false },
    } as Prisma.InputJsonValue;
    await expectCoverageWriteRejected("prueba de estabilidad alterada", invalidStability);
    const previewAfterRejectedWrites = await db.$transaction((tx) =>
      previewAppSheetInvoiceSequenceSeed(tx, { captureId: sourceCapture.captureId, snapshotId }));
    assert.equal(previewAfterRejectedWrites.previewDigest, previewAttempt.preview.previewDigest,
      "los rechazos de escrituras inválidas conservan el preview válido original");

    assert.deepEqual({
      sequences: await db.appSheetInvoiceSequence.count(),
      reservations: await db.appSheetInvoiceNumberReservation.count(),
      ledgerEvents: await db.ledgerEvent.count(),
      stockFacts: await db.stockFact.count(),
      outbox: await db.operationOutbox.count(),
      audits: await db.operationAudit.count(),
    }, effectsBeforePreview, "preview y rechazos de mutación de coverage no deben escribir efectos operativos");
  } finally {
    if (schemaCreated) {
      await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await db.$disconnect();
  }
});
