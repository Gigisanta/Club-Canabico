import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";
import { cutoverGateIds, type CommandEnvelope } from "../shared/operations/contracts.js";
import { APPSHEET_CANONICAL_IMPORTER_VERSION, APPSHEET_CANONICAL_MAPPING_ID, APPSHEET_CANONICAL_SOURCE_SYSTEM } from "../shared/operations/appsheet-canonical.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_MAPPING_ID, APPSHEET_HISTORY_SOURCE_SYSTEM } from "../shared/operations/appsheet-history.js";
import { canonicalJson } from "../shared/operations/exact.js";
import { formatAppSheetInvoiceNumberForYear } from "../shared/operations/appsheet-invoice-rules.js";

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function databaseTargetIdentity(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const normalizedHost = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")
    ? "loopback"
    : hostname;
  return JSON.stringify([normalizedHost, url.port || "5432", decodeURIComponent(url.pathname.slice(1))]);
}

test("reviewed AppSheet source lots flow through the HTTP selector and confirmed invoice reservation", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");
  if (process.env.DATABASE_URL) {
    let applicationUrl: URL;
    try {
      applicationUrl = new URL(process.env.DATABASE_URL);
    } catch {
      assert.fail("DATABASE_URL debe ser una URL PostgreSQL válida cuando está definida");
    }
    assert.ok(["postgres:", "postgresql:"].includes(applicationUrl.protocol), "DATABASE_URL debe ser PostgreSQL");
    assert.notEqual(databaseTargetIdentity(databaseUrl), databaseTargetIdentity(applicationUrl),
      "TEST_DATABASE_URL no puede apuntar a la misma base PostgreSQL que DATABASE_URL");
  }
  const schema = `appsheet_source_lot_invoice_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const destinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test", databaseUrl);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: "appsheet-invoice-test-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://appsheet-invoice.test",
  });

  const { appSheetSourceLotCanonicalConsumerFixture, appSheetSourceLotCaptureFixture } = await import("./support/appsheet-source-lot-fixture.js");
  const { db } = await import("../server/db.js");
  let schemaCreated = false;
  let server: import("node:http").Server | undefined;
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const ownerId = "appsheet-invoice-owner";
    const deniedId = "appsheet-invoice-denied";
    const scopedId = "appsheet-invoice-scoped";
    const driverId = "appsheet-invoice-driver";
    const passwordText = randomUUID();
    const password = await bcrypt.hash(passwordText, 4);
    for (const [id, role] of [[ownerId, "owner"], [deniedId, "viewer"], [scopedId, "viewer"], [driverId, "viewer"]] as const) {
      await db.user.create({
        data: { id, name: "Synthetic invoice actor", email: `${id}@appsheet-invoice.test`, password, role },
      });
    }
    await db.operationAccess.create({
      data: { userId: scopedId, profile: "commercial", capabilities: ["orders.write"], scope: { memberIds: ["invoice-other-member"] } },
    });
    await db.operationAccess.create({
      data: { userId: driverId, profile: "driver", enabled: true, capabilities: ["delivery.report", "collections.report"] },
    });

    const memberId = "appsheet-invoice-member";
    const otherMemberId = "invoice-other-member";
    const unverifiedMemberId = "appsheet-invoice-unverified-member";
    await db.operationMember.create({ data: { id: memberId, name: "Synthetic member", address: {}, preferences: {} } });
    await db.operationMember.create({ data: { id: otherMemberId, name: "Other synthetic member", address: {}, preferences: {} } });
    await db.operationMember.create({ data: { id: unverifiedMemberId, name: "Unverified synthetic member", address: {}, preferences: {} } });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const validUntil = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    await db.memberPermission.create({
      data: { memberId, kind: "operations", status: "verified", validFrom: today, validUntil },
    });

    const skuId = "appsheet-invoice-sku";
    const locationId = "appsheet-invoice-location";
    const lotId = "appsheet-invoice-lot";
    const balanceId = "appsheet-invoice-balance";
    await db.catalogSku.create({ data: { id: skuId, code: skuId, name: "Synthetic product", variety: "Fixture", category: "Fixture", unit: "g" } });
    await db.location.create({ data: { id: locationId, key: locationId, name: "Synthetic location" } });
    await db.inventoryLot.create({
      data: { id: lotId, skuId, label: "Synthetic lot", unit: "g", unitCost: "1", costCurrency: "ARS", receivedAt: new Date() },
    });
    await db.stockBalance.create({ data: { id: balanceId, lotId, locationId, custodianId: ownerId, unit: "g", quantity: "100", reserved: "0" } });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const origin = "http://appsheet-invoice.test";
    const cookies: Record<string, string> = {};

    async function call(path: string, actor = ownerId, body?: unknown) {
      return fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), Origin: origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function login(id: string) {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@appsheet-invoice.test`, password: passwordText }),
      });
      assert.equal(response.status, 200, await response.text());
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    const envelope = (targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0): CommandEnvelope => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command,
      data,
      expectedVersion,
      occurredAt: new Date().toISOString(),
    });
    async function send(request: CommandEnvelope, actor = ownerId) {
      const response = await call("/operations/commands", actor, request);
      return { request, response, body: await response.json() as Record<string, any> };
    }
    async function command(request: CommandEnvelope, actor = ownerId) {
      const result = await send(request, actor);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      return result;
    }

    await login(ownerId);
    await login(deniedId);
    await login(scopedId);
    await login(driverId);

    const invoiceDate = today;
    const invoiceData = (options: { preorder?: boolean; lineTotal?: string; quantity?: string; withMoto?: boolean; lineId?: string; pricePerGramMinor?: string } = {}) => ({
      memberId,
      invoiceNumber: "APP-2026-1042",
      invoiceDate,
      currency: "ARS",
      address: { street: "Calle sintética 123", city: "Salta" },
      note: "Aclaración de factura sintética",
      productPaymentMethod: "cash",
      lines: options.lineTotal === undefined && options.quantity === undefined && options.preorder
        ? []
        : [{
          id: options.lineId ?? `appsheet-line-${randomUUID()}`, skuId, date: "2026-10-04", scale: "escala-3",
          quantity: options.quantity ?? "3", totalMinor: options.lineTotal ?? "1201",
          ...(options.pricePerGramMinor === undefined ? {} : { pricePerGramMinor: options.pricePerGramMinor }),
        }],
      ...(options.withMoto ? {
        moto: {
          deliveryDate: "2026-10-06",
          paymentMethod: "mercado_pago",
          serviceType: "CABA",
          destination: "Av. San Martín 100",
          clientTariffMinor: "700",
          adminTariffMinor: "99",
          totalTariffMinor: "5050",
          notes: "Aclaración de moto sintética",
        },
      } : {}),
      preorder: options.preorder ?? false,
    });
    const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
    // This is a synthetic consumer precondition. The only source-lot proof
    // below is produced by the real AppSheetSourceLotReviewed command.
    const sourceFixture = appSheetSourceLotCaptureFixture(`invoice-source-lots-${randomUUID()}`);
    const capture = sourceFixture.sourceLotCapture.manifest;
    const productionDestinationIdentity = appSheetDatabaseDestinationIdentity("production", databaseUrl);
    const digestValue = (value: unknown) => digest(canonicalJson(value));
    const captureDate = (value: string) => new Date(value);
    async function persistCapture(capture: typeof sourceFixture.sourceLotCapture.manifest) {
      await db.appSheetCaptureManifest.create({ data: {
        captureId: capture.captureId, sourceSystem: capture.sourceSystem, sourceId: capture.sourceId, spreadsheetId: capture.spreadsheetId,
        metadataHash: capture.metadataHash, headersHash: capture.headersHash, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
        definitionHash: null, stability: capture.stability, firstReadAt: captureDate(capture.firstReadAt),
        verificationStartedAt: captureDate(capture.verificationStartedAt), verificationCompletedAt: captureDate(capture.verificationCompletedAt),
        cutoffAt: captureDate(capture.cutoffAt), dataCoverage: capture.coverage, pageManifest: capture.pages, definitionCoverage: Prisma.DbNull,
        dataSheetCount: capture.dataSheetCount, dataPageCount: capture.dataPageCount, dataRecordCount: capture.dataRecordCount,
        dataFormulaCount: capture.dataFormulaCount, dataUnresolvedFormulaCount: capture.dataUnresolvedFormulaCount,
        definitionTableCount: capture.definitionTableCount, definitionColumnCount: capture.definitionColumnCount,
        definitionSliceCount: capture.definitionSliceCount, definitionViewCount: capture.definitionViewCount,
        definitionActionCount: capture.definitionActionCount, definitionBotCount: capture.definitionBotCount,
        definitionWorkflowRuleCount: capture.definitionWorkflowRuleCount, definitionFormatRuleCount: capture.definitionFormatRuleCount,
      } });
    }
    await persistCapture(capture);

    // Start from the same pristine shadow state required by canonical staging.
    // The fixture never resets epoch or firstRealWriteAt after active operations.
    await db.operationAuthority.create({ data: {
      id: "operations", mode: "shadow", cutoverProfile: "appsheet-replacement",
      captureManifestId: capture.captureId, epoch: 1,
    } });

    const stagerId = `appsheet-source-lot-stager-${randomUUID()}`;
    await db.user.create({ data: { id: stagerId, name: "Synthetic source-lot stage operator", email: `${stagerId}@appsheet-invoice.test`, password, role: "admin" } });
    await db.operationAccess.create({ data: { userId: stagerId, profile: "commercial", enabled: true, capabilities: ["imports.write"] } });
    const commitSha = "2".repeat(40);
    const backupEvidence = { manifestHash: digest("synthetic source-lot backup"), snapshotAt: new Date(Date.now() - 2_000).toISOString() };
    const technicalReview = {
      schemaVersion: 2, reviewKind: "independent-technical", captureId: capture.captureId, manifestHash: capture.manifestHash,
      definitionHash: sourceFixture.projection.appliedDefinitionHash, projectionKind: "masters",
      projectionHash: sourceFixture.projection.projectionHash, commitSha, importer: APPSHEET_CANONICAL_IMPORTER_VERSION,
      reviewer: "synthetic-independent-source-lot-technical-reviewer", approved: true,
      reviewedAt: new Date(Date.now() - 1_000).toISOString(), findings: [], target: "production", destinationIdentity: productionDestinationIdentity,
    };
    const { appSheetCanonicalCurrentDestinationHash, appSheetDefinitionProductionReadiness } = await import("../server/operations/appsheet-canonical.js");
    const { finalDeltaProofForCapture } = await import("../server/operations/access.js");
    const { legacyPayloadHash } = await import("../server/operations/legacy-upload-contract.js");
    const { canonicalCommandBodyHash } = await import("../server/operations/canonical.js");
    const destinationFingerprints: Array<{
      destinationType: "member" | "sku"; sourceTable: string; sourceKey: string; destinationId: string; dataHash: string; operationVersion: number;
    }> = [];
    for (const destination of sourceFixture.projection.destinations) {
      if (destination.type === "member") {
        const member = await db.operationMember.create({ data: { id: destination.id, ...destination.data } });
        destinationFingerprints.push({ destinationType: destination.type, sourceTable: destination.sourceTable,
          sourceKey: destination.sourceKey, destinationId: destination.id,
          dataHash: appSheetCanonicalCurrentDestinationHash(member, "member"), operationVersion: 0 });
      } else {
        const sku = await db.catalogSku.create({ data: { id: destination.id, ...destination.data } });
        destinationFingerprints.push({ destinationType: destination.type, sourceTable: destination.sourceTable,
          sourceKey: destination.sourceKey, destinationId: destination.id,
          dataHash: appSheetCanonicalCurrentDestinationHash(sku, "sku"), operationVersion: 0 });
      }
      await db.operationObject.create({ data: { id: destination.id, kind: destination.type, version: 0, createdBy: stagerId } });
      await db.legacyIdentity.create({ data: {
        id: `synthetic-source-lot-canonical-identity-${randomUUID()}`,
        sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        sourceTable: destination.sourceTable,
        sourceKey: destination.sourceKey,
        destinationType: destination.type,
        destinationId: destination.id,
        approvedBy: null,
      } });
    }
    const canonicalConsumerFixture = appSheetSourceLotCanonicalConsumerFixture({
      projection: sourceFixture.projection,
      botInventory: sourceFixture.botInventory,
      destinationIdentity: productionDestinationIdentity,
      backupEvidence,
      technicalReview,
      destinationFingerprints,
    });
    const masterSnapshotId = sourceFixture.projection.snapshotId;
    // This immutable snapshot is a synthetic consumer precondition only. It
    // is created with the fixture's explicitly synthetic bot inventory and
    // does not claim to test or certify the production master-stage command.
    await db.legacyImportSnapshot.create({ data: {
      id: masterSnapshotId,
      sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
      filename: "synthetic-source-lot-consumer-precondition",
      fileHash: capture.manifestHash,
      importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
      status: "staged",
      createdBy: stagerId,
      captureManifestId: capture.captureId,
      controls: inputJson(canonicalConsumerFixture.controls),
      coverage: inputJson(canonicalConsumerFixture.coverage),
    } });
    for (const record of sourceFixture.projection.records) await db.legacySourceRecord.create({ data: {
      id: record.id,
      snapshotId: masterSnapshotId,
      sourceTable: record.sourceTable,
      sourceKey: record.sourceKey,
      sourceRow: record.sourceRow,
      fileHash: record.fileHash,
      contentHash: record.contentHash,
      importerVersion: record.importerVersion,
      original: record.original as Prisma.InputJsonValue,
      normalized: record.normalized as Prisma.InputJsonValue,
      treatment: record.treatment,
    } });
    await db.operationObject.create({ data: { id: masterSnapshotId, kind: "legacyImport", version: 0, createdBy: stagerId } });
    await db.operationAudit.create({ data: {
      actorId: stagerId,
      action: "appsheet.canonical_masters_staged",
      objectId: masterSnapshotId,
      details: canonicalConsumerFixture.stageAuditDetails as Prisma.InputJsonValue,
    } });
    const masterSnapshot = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: masterSnapshotId } });
    const safeEffects = canonicalConsumerFixture.controls.appSheetCanonical.effects;
    const { cash: _cashFlag, ...missingCashEffect } = safeEffects;
    for (const [caseName, effects] of [
      ["enabled-cash", { ...safeEffects, cash: true }],
      ["missing-cash", missingCashEffect],
      ["extra-effect", { ...safeEffects, unrelatedEffect: false }],
      ["non-boolean-cash", { ...safeEffects, cash: "false" }],
    ] as const) {
      const unsafeFixture = appSheetSourceLotCaptureFixture(`unsafe-effects-${caseName}-${randomUUID()}`);
      const unsafeCapture = unsafeFixture.sourceLotCapture.manifest;
      await persistCapture(unsafeCapture);
      const unsafeConsumer = appSheetSourceLotCanonicalConsumerFixture({
        projection: unsafeFixture.projection, botInventory: unsafeFixture.botInventory,
        destinationIdentity: productionDestinationIdentity, backupEvidence,
        technicalReview: { ...technicalReview, captureId: unsafeCapture.captureId, manifestHash: unsafeCapture.manifestHash,
          projectionHash: unsafeFixture.projection.projectionHash, definitionHash: unsafeFixture.projection.appliedDefinitionHash },
        destinationFingerprints: [],
      });
      const unsafeSnapshotId = `unsafe-master-effects-${caseName}-${randomUUID()}`;
      await db.legacyImportSnapshot.create({ data: {
        id: unsafeSnapshotId, sourceSystem: masterSnapshot.sourceSystem, filename: "synthetic-invalid-effects",
        fileHash: unsafeCapture.manifestHash, importerVersion: masterSnapshot.importerVersion, status: "staged",
        createdBy: stagerId, captureManifestId: unsafeCapture.captureId,
        controls: inputJson({ appSheetCanonical: { ...unsafeConsumer.controls.appSheetCanonical, effects } }),
        coverage: inputJson(unsafeConsumer.coverage),
      } });
      await db.operationObject.create({ data: { id: unsafeSnapshotId, kind: "legacyImport", version: 0, createdBy: stagerId } });
      const denied = await send(envelope(unsafeSnapshotId, "AppSheetCanonicalIdentitiesReviewed", {
        captureId: unsafeCapture.captureId, manifestHash: unsafeCapture.manifestHash, projectionHash: unsafeFixture.projection.projectionHash,
        destinationCount: unsafeFixture.projection.destinations.length, evidenceReference: "synthetic unsafe-effects review",
      }));
      assert.equal(denied.response.status, 423, caseName);
      assert.deepEqual(denied.body.details.blockers, ["canonical_master_effects_or_production_backup_unverified"], caseName);
      assert.equal((await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: unsafeSnapshotId } })).status, "staged");
      assert.equal(await db.commandReceipt.count({ where: { requestId: denied.request.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: denied.request.requestId } }), 0);
    }
    const canonicalReview = await command(envelope(masterSnapshot.id, "AppSheetCanonicalIdentitiesReviewed", {
      captureId: capture.captureId, manifestHash: capture.manifestHash, projectionHash: sourceFixture.projection.projectionHash,
      destinationCount: sourceFixture.projection.destinations.length, evidenceReference: "synthetic source-lot canonical identity review",
    }));
    assert.equal(canonicalReview.body.result.status, "reviewed");
    const memberDestination = sourceFixture.projection.destinations.find(destination => destination.type === "member");
    const skuDestination = sourceFixture.projection.destinations.find(destination => destination.type === "sku");
    assert.ok(memberDestination?.type === "member" && skuDestination?.type === "sku");
    const sourceMember = await db.operationMember.findUniqueOrThrow({ where: { id: memberDestination.id } });
    const sourceSku = await db.catalogSku.findUniqueOrThrow({ where: { id: skuDestination.id } });
    await db.memberPermission.create({ data: { memberId: sourceMember.id, kind: "operations", status: "verified", validFrom: today, validUntil } });

    const historySnapshotId = `appsheet-source-lot-history-${randomUUID()}`;
    const historyRows = sourceFixture.sourceRowsFor(historySnapshotId, capture.manifestHash);
    const sourceRecords = historyRows.records;
    const sourceFacts = historyRows.facts;
    const historyBackup = { manifestHash: digest("synthetic source-lot history backup"), snapshotAt: new Date(Date.now() - 2_000).toISOString() };
    const historyTechnicalReview = {
      schemaVersion: 2, reviewKind: "independent-technical", approved: true, bindingSource: "explicit-target-and-destination",
      reviewer: "synthetic-independent-source-history-reviewer", reviewedAt: new Date(Date.now() - 1_000).toISOString(),
      findingsCount: 0, findingsHash: digestValue([]), commitSha,
    };
    const recordsHash = digestValue(sourceRecords.map(record => ({ id: record.id, sourceTable: record.sourceTable,
      sourceKey: record.sourceKey, contentHash: record.contentHash })));
    const factsHash = digestValue(sourceFacts.map(fact => ({ id: fact.id, sourceRecordId: fact.sourceRecordId,
      sourceHash: fact.sourceHash, kind: fact.kind, quantityState: fact.quantityState,
      ...(fact.quantity === null ? {} : { quantity: fact.quantity }), unit: fact.unit })));
    const historyProjectionHash = digestValue({ schemaVersion: "appsheet-history-projection/v1", captureId: capture.captureId,
      manifestHash: capture.manifestHash, dataHash: capture.dataHash, recordsHash, factsHash });
    const inventory = sourceFixture.projection.definitionInventory;
    const historyStage = {
      schemaVersion: "appsheet-history-stage/v2", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      mappingId: APPSHEET_HISTORY_MAPPING_ID, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, captureId: capture.captureId,
      manifestHash: capture.manifestHash, dataHash: capture.dataHash, captureDefinitionHash: null, mode: "stable",
      definitionHash: sourceFixture.projection.appliedDefinitionHash, definitionSourceSha256: inventory.source.sha256,
      definitionDescriptorSha256: inventory.descriptorSha256, definitionFileSha256: digest("synthetic history definition file"),
      definitionIdentityState: "verified", definitionReadiness: appSheetDefinitionProductionReadiness(inventory),
      definitionInventory: inventory, status: "staged", projectionHash: historyProjectionHash, destination: { target: "production", identity: productionDestinationIdentity },
      humanReview: { status: "pending" }, operationalAuthority: { status: "unchanged" }, authorizationContext: "user-authorized-plan",
      actorUserId: stagerId, actor: "codex:appsheet-history-stage", reviewedBy: null, reviewedAt: null,
      effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false, documents: false, numbering: "not-generated" },
      backupManifestHash: historyBackup.manifestHash, backupSnapshotAt: historyBackup.snapshotAt, technicalReview: historyTechnicalReview,
      recordsHash, factsHash, exceptionsHash: digestValue([]),
    };
    const tableCounts = new Map<string, { records: number; facts: number }>();
    for (const record of sourceRecords) tableCounts.set(record.sourceTable, {
      records: (tableCounts.get(record.sourceTable)?.records ?? 0) + 1, facts: tableCounts.get(record.sourceTable)?.facts ?? 0,
    });
    for (const fact of sourceFacts) tableCounts.set(fact.sourceTable, {
      records: tableCounts.get(fact.sourceTable)?.records ?? 0, facts: (tableCounts.get(fact.sourceTable)?.facts ?? 0) + 1,
    });
    const historyCoverage = {
      schemaVersion: "appsheet-history-coverage/v1", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash, captureDefinitionHash: null,
      appliedDefinitionHash: sourceFixture.projection.appliedDefinitionHash, mode: "stable", stability: capture.stability,
      pages: capture.pages.map(page => ({ sheetId: page.sheetId, title: page.title, pageIndex: page.pageIndex, startRow: page.startRow,
        endRow: page.endRow, pageHash: page.pageHash, verifiedPageHash: page.verifiedPageHash, stable: page.stable })),
      sheets: [...tableCounts.entries()].map(([sourceTable, count]) => ({ sourceTable, pageCount: capture.pages.filter(page => page.title === sourceTable).length,
        sourceRecordCount: count.records, populatedSourceRows: count.records, factCount: count.facts,
        blockingExceptionCount: 0, reviewExceptionCount: 0, sourceRecordUnresolvedFormulaCount: 0,
        definitionTableMatch: "unique", changedPageIndexes: [], unresolvedFormulaCount: 0 })),
      source: { spreadsheetId: capture.spreadsheetId, dataRecordCount: sourceRecords.length },
      totals: { recordCount: sourceRecords.length, factCount: sourceFacts.length, exceptionCount: 0 }, exceptionTotal: 0,
      definition: { inventory, identityState: "verified", appliedDefinitionHash: sourceFixture.projection.appliedDefinitionHash,
        sourceSha256: inventory.source.sha256, descriptorSha256: inventory.descriptorSha256, commitSha },
    };
    await db.legacyImportSnapshot.create({ data: {
      id: historySnapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, filename: "synthetic-source-lot-history",
      fileHash: capture.manifestHash, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, status: "reviewed", createdBy: stagerId,
      reviewedBy: ownerId, reviewedAt: new Date(), captureManifestId: capture.captureId,
      controls: inputJson({ appSheetHistoryStage: historyStage }), coverage: inputJson(historyCoverage),
    } });
    for (const record of sourceRecords) await db.legacySourceRecord.create({ data: {
      id: record.id, snapshotId: historySnapshotId, sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow,
      fileHash: record.fileHash, contentHash: record.contentHash, importerVersion: record.importerVersion,
      original: record.original as Prisma.InputJsonValue, normalized: record.normalized as Prisma.InputJsonValue, treatment: record.treatment,
    } });
    for (const fact of sourceFacts) await db.legacyHistoricalFact.create({ data: {
      id: fact.id, snapshotId: historySnapshotId, sourceRecordId: fact.sourceRecordId, sourceTable: fact.sourceTable,
      sourceKey: fact.sourceKey, sourceRow: fact.sourceRow, sourceHash: fact.sourceHash, mappingId: fact.mappingId, kind: fact.kind,
      occurredOn: fact.occurredOn, dateState: fact.dateState, amountMinor: null, amountState: "not-applicable",
      currency: null, currencyState: "not-applicable", quantity: fact.quantity, quantityState: fact.quantityState,
      unit: fact.unit, unitState: fact.unitState, attributes: fact.attributes as Prisma.InputJsonValue, createdBy: stagerId,
    } });
    const historyPublicationFingerprint = legacyPayloadHash({ snapshotId: historySnapshotId, fileHash: capture.manifestHash,
      mappingId: APPSHEET_HISTORY_MAPPING_ID, rows: sourceRecords.length, corrections: [] });
    await db.legacyHistoryPublication.create({ data: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, snapshotId: historySnapshotId, fileHash: capture.manifestHash,
      mappingId: APPSHEET_HISTORY_MAPPING_ID, fingerprint: historyPublicationFingerprint, publishedBy: stagerId,
      evidence: { reference: "synthetic source-lot history publication prerequisite" },
    } });
    await db.operationAudit.create({ data: {
      actorId: stagerId, action: "legacy.appsheet_history_staged", objectId: historySnapshotId,
      details: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
        captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash, projectionHash: historyProjectionHash,
        mode: "stable", reviewer: historyTechnicalReview.reviewer, technicalReviewAt: historyTechnicalReview.reviewedAt,
        commitSha, target: "production", destinationIdentity: productionDestinationIdentity,
        backupManifestHash: historyBackup.manifestHash, backupSnapshotAt: historyBackup.snapshotAt,
        authorizationContext: "user-authorized-plan", recordCount: sourceRecords.length, factCount: sourceFacts.length,
        exceptionCount: 0, reviewedBy: null, status: "staged" },
    } });

    const firstReadAt = captureDate(capture.firstReadAt);
    const finalDelta = finalDeltaProofForCapture({ captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
      firstReadAt, verificationStartedAt: captureDate(capture.verificationStartedAt), verificationCompletedAt: captureDate(capture.verificationCompletedAt),
      cutoffAt: captureDate(capture.cutoffAt), stability: capture.stability } as any, {
      manualPauseStartedAt: new Date(firstReadAt.getTime() - 1_000).toISOString(), manualPauseEndedAt: null,
      manualPauseEvidenceRef: "synthetic manual pause fixture", expectedHandoffChangesRef: "synthetic separate handoff review fixture",
    });
    const finalDeltaEvidence = { humanEvidence: { reference: "synthetic distinct gate author and reviewer" }, appSheetReplacement: {
      schemaVersion: 1, captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
      captureDefinitionHash: null, appliedDefinitionHash: sourceFixture.projection.appliedDefinitionHash, gateProof: { finalDelta },
    } };
    await db.cutoverGate.create({ data: {
      id: "final-delta-reconciled", status: "approved", evidence: finalDeltaEvidence, captureManifestId: capture.captureId,
      approvedBy: stagerId, reviewedBy: ownerId, approvedAt: new Date(),
    } });

    const openingRecords = new Map(sourceRecords.filter(record => record.sourceTable === "D_Stock").map(record => [record.sourceKey, record]));
    const internalLots = new Map<string, { id: string; balanceId: string; sourceRecordId: string }>();
    for (const sourceLot of historyRows.sourceLots) {
      const openingRecord = openingRecords.get(`opening-${sourceLot.sourceLotId}`);
      assert.ok(openingRecord, `synthetic D_Stock source exists for ${sourceLot.sourceLotId}`);
      const lotId = `appsheet-source-lot-internal-${randomUUID()}`;
      const opening = await command(envelope(lotId, "StockOpeningRecorded", {
        skuId: sourceSku.id, label: `Synthetic opening for ${sourceLot.sourceLotId}`, quantity: sourceLot.sourceStockActual,
        unitCost: "10", costCurrency: "ARS", receivedDate: sourceLot.sourceDeliveryDate, locationId, custodianId: ownerId,
        preparedBy: deniedId, evidence: { note: "Synthetic D_Stock source lot opening" }, sourceRecordId: openingRecord.id,
      }));
      assert.ok(new Prisma.Decimal(opening.body.result.opening.quantity).equals(sourceLot.sourceStockActual),
        "the opening preserves the exact source quantity independently of decimal display scale");
      assert.ok(new Prisma.Decimal(opening.body.result.balance.quantity).equals(sourceLot.sourceStockActual),
        "the persisted balance equals the exact source quantity");
      const balance = await db.stockBalance.findFirstOrThrow({ where: { lotId } });
      internalLots.set(sourceLot.sourceLotId, { id: lotId, balanceId: balance.id, sourceRecordId: sourceLot.sourceRecord.id });
    }

    const sourceLotCommandRequests = new Map<string, CommandEnvelope>();
    const sourceReviewEffects = async () => ({
      identities: await db.legacyIdentity.findMany({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceTable: "C_Mercaderia" }, orderBy: { sourceKey: "asc" } }),
      lots: await db.inventoryLot.findMany({ where: { id: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
      objects: await db.operationObject.findMany({ where: { id: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
      reviews: await db.operationAudit.findMany({ where: { action: "appsheet.source_lot_reviewed", objectId: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
      receipts: await db.commandReceipt.count(), audits: await db.operationAudit.count(), outbox: await db.operationOutbox.count(),
    });
    for (const sourceLot of historyRows.sourceLots) {
      const target = internalLots.get(sourceLot.sourceLotId)!;
      const reviewRequest = envelope(target.id, "AppSheetSourceLotReviewed", {
        sourceRecordId: sourceLot.sourceRecord.id, sourceKey: sourceLot.sourceLotId, contentHash: sourceLot.sourceRecord.contentHash,
        preparedBy: deniedId, evidence: { note: "Synthetic independent review of source-derived AppSheet stock" },
      }, 1);
      sourceLotCommandRequests.set(sourceLot.sourceLotId, reviewRequest);
      const reviewed = await command(reviewRequest);
      const proof = reviewed.body.result.proof;
      assert.equal(reviewed.body.result.sourceLot.inventoryLotId, target.id);
      assert.equal(proof.sourceRecordId, sourceLot.sourceRecord.id);
      assert.ok(new Prisma.Decimal(proof.sourceStockActual).equals(sourceLot.sourceStockActual));
      assert.equal(proof.sourceDeliveryDate, sourceLot.sourceDeliveryDate);
      for (const field of ["sourceDataHash", "sourceRowHash", "sourceDerivationHash", "sourceStockDefinitionHash", "sourceMovementRowsetHash", "sourceSelectionHash"])
        assert.match(proof[field], /^[a-f0-9]{64}$/, `${field} is generated by the review command`);
    }
    const reviewedSourceState = await sourceReviewEffects();
    const firstReviewRequest = sourceLotCommandRequests.get(historyRows.sourceLots[0]!.sourceLotId)!;
    const replayedSourceReview = await command(firstReviewRequest);
    assert.equal(replayedSourceReview.body.replay, true);
    assert.deepEqual(await sourceReviewEffects(), reviewedSourceState, "the exact HTTP command replay adds no effects");

    const duplicateReview = envelope(firstReviewRequest.targetId, "AppSheetSourceLotReviewed", firstReviewRequest.data, 2);
    const duplicateResult = await send(duplicateReview);
    assert.equal(duplicateResult.response.status, 409, JSON.stringify(duplicateResult.body));
    assert.equal(duplicateResult.body.code, "APPSHEET_SOURCE_LOT_RECAPTURE_REQUIRED");
    assert.deepEqual(await sourceReviewEffects(), reviewedSourceState, "a second review request for the same capture is rejected without writes");

    await db.operationAccess.update({ where: { userId: scopedId }, data: {
      profile: "stock", enabled: true, capabilities: ["openings.approve"],
      scope: { locationIds: ["outside-source-lot-location"], custodianIds: [ownerId] },
    } });
    const scopedReviewRequest = envelope(firstReviewRequest.targetId, "AppSheetSourceLotReviewed", firstReviewRequest.data, 2);
    const scopedReview = await send(scopedReviewRequest, scopedId);
    assert.equal(scopedReview.response.status, 403, JSON.stringify(scopedReview.body));
    assert.equal(scopedReview.body.code, "LOCATION_SCOPE");
    assert.deepEqual(await sourceReviewEffects(), reviewedSourceState, "scope rejection leaves all source-lot evidence unchanged");

    // Consumer precondition only: mimic the already-reviewed activation receipt
    // chain so the active catalogue reader can validate the SKU. Do not invoke
    // AuthorityActivated from this test.
    const reviewedMaster = await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: masterSnapshot.id } });
    const controls = reviewedMaster.controls as Record<string, any>;
    const skuFingerprint = controls.appSheetCanonical.destinationFingerprints.find((item: any) => item.destinationId === sourceSku.id);
    assert.ok(skuFingerprint);
    const activatedSku = await db.catalogSku.update({ where: { id: sourceSku.id }, data: { active: true } });
    const activatedObject = await db.operationObject.update({ where: { id: sourceSku.id }, data: { version: 1 } });
    assert.equal(activatedObject.version, 1);
    const activatedSnapshot = {
      id: activatedSku.id, code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety,
      category: activatedSku.category, unit: activatedSku.unit, active: activatedSku.active,
      sourceSystem: activatedSku.sourceSystem, sourceId: activatedSku.sourceId, appSheet: activatedSku.appSheet,
    };
    const activationEntry = {
      skuId: sourceSku.id, sourceKey: skuDestination.sourceKey, baselineHash: skuFingerprint.dataHash, baselineVersion: skuFingerprint.operationVersion,
      activatedHash: appSheetCanonicalCurrentDestinationHash(activatedSnapshot, "sku"), activatedVersion: 1,
    };
    const activationManifest = { schemaVersion: 1, captureId: capture.captureId, snapshotId: masterSnapshot.id,
      projectionHash: sourceFixture.projection.projectionHash, destinationIdentity: productionDestinationIdentity, entries: [activationEntry] };
    const authorityRequestId = randomUUID();
    const activationRequest = envelope("operations", "AuthorityActivated", {
      cutoverProfile: "appsheet-replacement", captureId: capture.captureId, evidence: { reference: "synthetic activation consumer fixture" },
    });
    activationRequest.requestId = authorityRequestId;
    await db.operationAuthority.update({ where: { id: "operations" }, data: {
      mode: "active", cutoverProfile: "appsheet-replacement", captureManifestId: capture.captureId, epoch: 3, approvedBy: ownerId,
    } });
    await db.operationObject.create({ data: { id: "operations", kind: "authority", version: 1, createdBy: ownerId },
    });
    const activationResponse = { requestId: authorityRequestId, targetId: "operations", version: 1,
      result: { authority: { id: "operations", mode: "active", cutoverProfile: "appsheet-replacement",
        captureManifestId: capture.captureId, epoch: 3, approvedBy: ownerId }, appSheetSkuActivation: activationManifest } };
    await db.commandReceipt.create({ data: { requestId: authorityRequestId, actorId: ownerId, targetId: "operations", command: "AuthorityActivated",
      bodyHash: canonicalCommandBodyHash(activationRequest), response: activationResponse, resultingVersion: 1, authorityEpoch: 2,
      occurredAt: new Date() } });
    await db.operationAudit.create({ data: { actorId: ownerId, action: "AuthorityActivated", objectId: "operations", requestId: authorityRequestId,
      details: { version: 1 } } });
    await db.operationAudit.create({ data: { actorId: ownerId, action: "appsheet.canonical_sku_activated", objectId: sourceSku.id,
      requestId: authorityRequestId, details: { schemaVersion: 1, captureId: capture.captureId, snapshotId: masterSnapshot.id,
        projectionHash: sourceFixture.projection.projectionHash, destinationIdentity: productionDestinationIdentity,
        ...activationEntry, snapshot: activatedSnapshot } } });

    // Number allocation is a synthetic precondition; the test is about the
    // actual source-lot review and confirmed reservation transaction.
    const historyPublication = await db.legacyHistoryPublication.findUniqueOrThrow({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM } });
    const seededValue = BigInt(Date.now());
    await db.appSheetInvoiceSequence.create({ data: {
      namespace: capture.captureId, captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
      snapshotId: historySnapshotId, mappingId: APPSHEET_HISTORY_MAPPING_ID, publicationFingerprint: historyPublication.fingerprint,
      sourceBindingHash: digestValue({ fixture: "synthetic sequence consumer prerequisite", captureId: capture.captureId }),
      lastValue: seededValue, seededValue, invoiceRecordCount: 0, numberedInvoiceCount: 0, unnumberedInvoiceCount: 0,
      duplicateInvoiceNumberCount: 0, duplicateHiddenIdCount: 0, seedEvidence: { fixture: "synthetic sequence consumer prerequisite" },
      seededBy: ownerId, seededAt: new Date(),
    } });

    const catalogResponse = await call("/operations/catalog?channel=local");
    assert.equal(catalogResponse.status, 200, await catalogResponse.text());
    const catalog = await catalogResponse.json() as { items: Array<{ id: string; appSheetSourceLots?: Array<any> }> };
    const catalogSku = catalog.items.find(item => item.id === sourceSku.id);
    assert.ok(catalogSku);
    const sourceLotOptions = catalogSku.appSheetSourceLots ?? [];
    assert.equal(sourceLotOptions.length, 2, "both reviewed source lots with positive stock are selectable");
    assert.equal(sourceLotOptions[0]!.sourceLotId, historyRows.sourceLots[0]!.sourceLotId, "catalogue retains the older FIFO lot first");
    const selectedSourceLot = historyRows.sourceLots[1]!;
    const selectedOption = sourceLotOptions.find(item => item.sourceLotId === selectedSourceLot.sourceLotId);
    assert.ok(selectedOption);
    assert.equal(selectedOption.inventoryLotId, internalLots.get(selectedSourceLot.sourceLotId)!.id);

    const invoiceTargetId = `appsheet-source-lot-invoice-${randomUUID()}`;
    const invoice = invoiceData({ preorder: false, quantity: "3", lineId: `source-lot-invoice-line-${randomUUID()}` });
    const invoiceInput: Record<string, any> = {
      ...invoice, memberId: sourceMember.id,
      lines: invoice.lines.map(line => ({ ...line, skuId: sourceSku.id, sourceLotId: selectedSourceLot.sourceLotId })),
    };
    delete invoiceInput.invoiceNumber;
    const invoiceRequest = envelope(invoiceTargetId, "InvoiceSaved", invoiceInput);
    const confirmedInvoice = await send(invoiceRequest);
    assert.equal(confirmedInvoice.response.status, 200, JSON.stringify(confirmedInvoice.body));
    assert.equal(confirmedInvoice.body.result.commercialState, "confirmed");
    const savedOrder = await db.operationOrder.findUniqueOrThrow({ where: { id: invoiceTargetId } });
    assert.equal((savedOrder.quote as any).input.lines[0].sourceLotId, selectedSourceLot.sourceLotId);
    const reservations = await db.stockReservation.findMany({ where: { orderId: invoiceTargetId } });
    assert.equal(reservations.length, 1);
    const reservedBalance = await db.stockBalance.findUniqueOrThrow({ where: { id: reservations[0]!.balanceId } });
    assert.equal(reservedBalance.lotId, internalLots.get(selectedSourceLot.sourceLotId)!.id,
      "explicit selection reserves the second source lot instead of native FIFO's first lot");
    assert.equal(reservations[0]!.quantity.toString(), "3");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: internalLots.get(historyRows.sourceLots[0]!.sourceLotId)!.balanceId } })).reserved.toString(), "0");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: internalLots.get(selectedSourceLot.sourceLotId)!.balanceId } })).reserved.toString(), "3");
    const sequenceAfterInvoice = await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } });
    assert.equal(sequenceAfterInvoice.lastValue, seededValue + 1n);

    const confirmedInvoiceEffects = async () => ({
      order: await db.operationOrder.findUniqueOrThrow({ where: { id: invoiceTargetId } }),
      object: await db.operationObject.findUniqueOrThrow({ where: { id: invoiceTargetId } }),
      lines: await db.operationOrderLine.findMany({ where: { orderId: invoiceTargetId }, orderBy: { id: "asc" } }),
      reservations: await db.stockReservation.findMany({ where: { orderId: invoiceTargetId }, orderBy: { id: "asc" } }),
      assignments: await db.deliveryAssignment.count({ where: { orderId: invoiceTargetId } }),
      firstBalance: await db.stockBalance.findUniqueOrThrow({ where: { id: internalLots.get(historyRows.sourceLots[0]!.sourceLotId)!.balanceId } }),
      selectedBalance: await db.stockBalance.findUniqueOrThrow({ where: { id: internalLots.get(selectedSourceLot.sourceLotId)!.balanceId } }),
      sequence: await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } }),
      numberReservations: await db.appSheetInvoiceNumberReservation.findMany({ where: { namespace: capture.captureId }, orderBy: { id: "asc" } }),
      receipt: await db.commandReceipt.findUniqueOrThrow({ where: { requestId: invoiceRequest.requestId } }),
      audits: await db.operationAudit.findMany({ where: { requestId: invoiceRequest.requestId }, orderBy: { id: "asc" } }),
      outbox: await db.operationOutbox.findMany({ where: { requestId: invoiceRequest.requestId }, orderBy: { id: "asc" } }),
    });
    const effectsAfterInvoice = await confirmedInvoiceEffects();
    const replayedInvoice = await command(invoiceRequest);
    assert.equal(replayedInvoice.body.replay, true);
    assert.deepEqual(await confirmedInvoiceEffects(), effectsAfterInvoice, "invoice replay does not double-reserve stock or advance numbering");

    const rejectedTargetId = `appsheet-source-lot-invalid-invoice-${randomUUID()}`;
    const invalidInvoice = invoiceData({ preorder: false, quantity: "3", lineId: `invalid-source-lot-line-${randomUUID()}` });
    const invalidInvoiceInput: Record<string, any> = {
      ...invalidInvoice, memberId: sourceMember.id,
      lines: invalidInvoice.lines.map(line => ({ ...line, skuId: sourceSku.id, sourceLotId: `missing-source-lot-${randomUUID()}` })),
    };
    delete invalidInvoiceInput.invoiceNumber;
    const invalidInvoiceRequest = envelope(rejectedTargetId, "InvoiceSaved", invalidInvoiceInput);
    const rollbackBefore = {
      sequence: await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } }),
      numberReservations: await db.appSheetInvoiceNumberReservation.count(), stockReservations: await db.stockReservation.count(),
      orders: await db.operationOrder.count(), orderLines: await db.operationOrderLine.count(), assignments: await db.deliveryAssignment.count(),
      balances: await db.stockBalance.findMany({ where: { lotId: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
    };
    const invalidInvoiceResult = await send(invalidInvoiceRequest);
    assert.equal(invalidInvoiceResult.response.status, 423, JSON.stringify(invalidInvoiceResult.body));
    assert.equal(invalidInvoiceResult.body.code, "APPSHEET_SOURCE_LOT_NOT_ELIGIBLE");
    assert.deepEqual({
      sequence: await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } }),
      numberReservations: await db.appSheetInvoiceNumberReservation.count(), stockReservations: await db.stockReservation.count(),
      orders: await db.operationOrder.count(), orderLines: await db.operationOrderLine.count(), assignments: await db.deliveryAssignment.count(),
      balances: await db.stockBalance.findMany({ where: { lotId: { in: [...internalLots.values()].map(item => item.id) } }, orderBy: { id: "asc" } }),
    }, rollbackBefore, "failed lot resolution rolls back the provisional order, number allocation, and stock effects");
    assert.equal(await db.operationOrder.findUnique({ where: { id: rejectedTargetId } }), null);
    assert.equal(await db.operationOrderLine.count({ where: { orderId: rejectedTargetId } }), 0);
    assert.equal(await db.operationObject.findUnique({ where: { id: rejectedTargetId } }), null);
    assert.equal(await db.stockReservation.count({ where: { orderId: rejectedTargetId } }), 0);
    assert.equal(await db.appSheetInvoiceNumberReservation.findUnique({ where: { orderId: rejectedTargetId } }), null);
    assert.equal(await db.commandReceipt.count({ where: { requestId: invalidInvoiceRequest.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: invalidInvoiceRequest.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: invalidInvoiceRequest.requestId } }), 0);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
