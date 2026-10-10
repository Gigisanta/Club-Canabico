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

test("unmapped AppSheet stock openings stay blocked while native GoodsReceived lots can be invoiced", {
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
    // Synthetic AppSheet capture/history input only. Its D_Stock rows do not
    // establish a verified physical opening or a selectable migrated lot.
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
    const readOpeningEffects = async () => ({
      lots: await db.inventoryLot.findMany({ orderBy: { id: "asc" } }),
      balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
      facts: await db.stockFact.findMany({ orderBy: { id: "asc" } }),
      objects: await db.operationObject.findMany({ orderBy: { id: "asc" } }),
      receipts: await db.commandReceipt.findMany({ orderBy: { requestId: "asc" } }),
      audits: await db.operationAudit.findMany({ orderBy: { id: "asc" } }),
      outbox: await db.operationOutbox.findMany({ orderBy: { id: "asc" } }),
    });
    for (const sourceLot of historyRows.sourceLots) {
      const openingRecord = openingRecords.get(`opening-${sourceLot.sourceLotId}`);
      assert.ok(openingRecord, `synthetic D_Stock source exists for the negative case ${sourceLot.sourceLotId}`);
      const lotId = `appsheet-unmapped-opening-${randomUUID()}`;
      const request = envelope(lotId, "StockOpeningRecorded", {
        skuId: sourceSku.id, label: `Unmapped source opening ${sourceLot.sourceLotId}`, quantity: sourceLot.sourceStockActual,
        unitCost: "10", costCurrency: "ARS", receivedDate: sourceLot.sourceDeliveryDate, locationId, custodianId: ownerId,
        preparedBy: deniedId, evidence: { note: "D_Stock is not a verified physical opening checkpoint" }, sourceRecordId: openingRecord.id,
      });
      const before = await readOpeningEffects();
      const rejectedOpening = await send(request);
      assert.equal(rejectedOpening.response.status, 423, JSON.stringify(rejectedOpening.body));
      assert.equal(rejectedOpening.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
      assert.deepEqual(rejectedOpening.body.details?.blockers, ["stock_opening_balance_checkpoint_unavailable"]);
      assert.deepEqual(await readOpeningEffects(), before, "an unmapped D_Stock opening cannot create a lot, balance, stock fact, receipt, audit, or outbox effect");
      assert.equal(await db.inventoryLot.findUnique({ where: { id: lotId } }), null);
      assert.equal(await db.operationObject.findUnique({ where: { id: lotId } }), null);
    }

    const rejectedSourceLot = historyRows.sourceLots[0]!;
    const rejectedSourceOpening = openingRecords.get(`opening-${rejectedSourceLot.sourceLotId}`)!;
    const rejectedSourceLotId = `appsheet-unverified-source-lot-${randomUUID()}`;
    // Deliberately seed an inconsistent row only to exercise fail-closed review:
    // this direct lot/balance/fact is not a migration opening or physical proof.
    await db.inventoryLot.create({ data: {
      id: rejectedSourceLotId, skuId: sourceSku.id, label: "Unverified source-lot rejection fixture", unit: "g",
      unitCost: "10", costCurrency: "ARS", receivedAt: new Date(`${rejectedSourceLot.sourceDeliveryDate}T12:00:00-03:00`),
    } });
    await db.stockBalance.create({ data: {
      id: `appsheet-unverified-source-balance-${randomUUID()}`, lotId: rejectedSourceLotId, locationId,
      custodianId: ownerId, unit: "g", quantity: rejectedSourceLot.sourceStockActual, reserved: "0",
    } });
    await db.stockFact.create({ data: {
      requestId: randomUUID(), lotId: rejectedSourceLotId, kind: "opening", quantity: rejectedSourceLot.sourceStockActual, unit: "g",
      toLocationId: locationId, toCustodianId: ownerId, reason: "unverified_test_corruption_fixture", actorId: ownerId,
      occurredAt: new Date(), sourceRecordId: rejectedSourceOpening.id,
    } });
    await db.operationObject.create({ data: { id: rejectedSourceLotId, kind: "lot", version: 0, createdBy: ownerId } });
    const sourceReviewRequest = envelope(rejectedSourceLotId, "AppSheetSourceLotReviewed", {
      sourceRecordId: rejectedSourceLot.sourceRecord.id, sourceKey: rejectedSourceLot.sourceLotId,
      contentHash: rejectedSourceLot.sourceRecord.contentHash, preparedBy: deniedId,
      evidence: { note: "Reject source-lot review while D_Stock has no approved opening checkpoint" },
    });
    const beforeSourceReview = await readOpeningEffects();
    const rejectedSourceReview = await send(sourceReviewRequest);
    assert.equal(rejectedSourceReview.response.status, 423, JSON.stringify(rejectedSourceReview.body));
    assert.equal(rejectedSourceReview.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
    assert.deepEqual(rejectedSourceReview.body.details?.blockers, ["stock_opening_balance_checkpoint_unavailable"]);
    assert.deepEqual(await readOpeningEffects(), beforeSourceReview, "source-lot review cannot promote the deliberately unverified direct fixture");
    assert.equal((await db.inventoryLot.findUniqueOrThrow({ where: { id: rejectedSourceLotId } })).sourceSystem, null);
    assert.equal((await db.inventoryLot.findUniqueOrThrow({ where: { id: rejectedSourceLotId } })).sourceId, null);
    assert.equal(await db.legacyIdentity.count({ where: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceTable: "C_Mercaderia", sourceKey: rejectedSourceLot.sourceLotId,
      destinationType: "inventoryLot",
    } }), 0);

    // This unreviewed source binding is another negative fixture, not proof:
    // the invoice selector must hide it and reject its missing identity/review chain.
    await db.inventoryLot.update({ where: { id: rejectedSourceLotId }, data: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceId: rejectedSourceLot.sourceLotId,
    } });

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

    // Exercise a native lot through the real purchase approval and GoodsReceived
    // commands. The separate owner is the independent purchase reviewer.
    const purchaseReviewerId = `appsheet-native-purchase-reviewer-${randomUUID()}`;
    await db.user.create({ data: { id: purchaseReviewerId, name: "Synthetic purchase reviewer", email: `${purchaseReviewerId}@appsheet-invoice.test`, password, role: "owner" } });
    await login(purchaseReviewerId);
    const supplierId = `appsheet-native-supplier-${randomUUID()}`;
    await db.supplier.create({ data: { id: supplierId, name: "Synthetic receipt supplier", key: supplierId } });
    const purchaseId = `appsheet-native-purchase-${randomUUID()}`;
    const purchaseLineId = `appsheet-native-purchase-line-${randomUUID()}`;
    await command(envelope(purchaseId, "PurchaseOrderCreated", {
      supplierId, agreementDate: today, currency: "ARS",
      items: [{ lineId: purchaseLineId, skuId: sourceSku.id, unit: "g", quantity: "100", unitCost: "2" }],
      evidence: { reference: "synthetic native-lot invoice test" },
    }));
    await command(envelope(purchaseId, "PurchaseOrderApproved", {
      evidence: { reference: "independent synthetic purchase review" },
    }, 1), purchaseReviewerId);
    const goodsReceiptId = `appsheet-native-receipt-${randomUUID()}`;
    const goodsReceivedRequest = envelope(goodsReceiptId, "GoodsReceived", {
      purchaseId, receivedDate: today, locationId, custodianId: ownerId,
      items: [{ lineId: purchaseLineId, quantity: "100", lotLabel: "Lote nativo de prueba" }],
      evidence: { reference: "synthetic native-lot invoice test" },
    });
    const goodsReceived = await command(goodsReceivedRequest);
    const receivedLot = goodsReceived.body.result.lots[0] as { lotId: string; balanceId: string };
    assert.ok(receivedLot.lotId);
    assert.ok(receivedLot.balanceId);
    assert.equal(goodsReceived.body.result.receipt.receivedDate, today, "GoodsReceived command response records the persisted receipt date");
    const receivedNativeLot = await db.inventoryLot.findUniqueOrThrow({ where: { id: receivedLot.lotId } });
    assert.equal(receivedNativeLot.skuId, sourceSku.id);
    assert.equal(receivedNativeLot.receiptId, goodsReceiptId);
    assert.equal(receivedNativeLot.purchaseLineId, purchaseLineId);
    assert.equal(receivedNativeLot.sourceSystem, null);
    assert.equal(receivedNativeLot.sourceId, null);
    const nativeReceiptEffects = async () => ({
      receipt: await db.goodsReceipt.findUnique({ where: { id: goodsReceiptId } }),
      lot: await db.inventoryLot.findUnique({ where: { id: receivedLot.lotId } }),
      balance: await db.stockBalance.findUnique({ where: { id: receivedLot.balanceId } }),
      facts: await db.stockFact.findMany({ where: { requestId: goodsReceivedRequest.requestId }, orderBy: { id: "asc" } }),
      commandReceipts: await db.commandReceipt.findMany({ where: { requestId: goodsReceivedRequest.requestId } }),
      audits: await db.operationAudit.findMany({ where: { requestId: goodsReceivedRequest.requestId }, orderBy: { id: "asc" } }),
      outbox: await db.operationOutbox.findMany({ where: { requestId: goodsReceivedRequest.requestId } }),
    });
    const nativeReceiptEffectsAfterWrite = await nativeReceiptEffects();
    assert.equal(nativeReceiptEffectsAfterWrite.facts.length, 1);
    assert.equal(nativeReceiptEffectsAfterWrite.commandReceipts.length, 1);
    assert.equal(nativeReceiptEffectsAfterWrite.audits.length, 2);
    const goodsReceivedReplay = await command(goodsReceivedRequest);
    assert.equal(goodsReceivedReplay.body.replay, true);
    assert.deepEqual(await nativeReceiptEffects(), nativeReceiptEffectsAfterWrite, "GoodsReceived replay does not duplicate the receipt, balance, or stock fact");

    // A positive on-hand native lot without the immutable receipt chain must not
    // become a selectable option, even when it belongs to the eligible SKU.
    const noProofLotId = `appsheet-native-unproven-lot-${randomUUID()}`;
    const noProofBalanceId = `appsheet-native-unproven-balance-${randomUUID()}`;
    await db.inventoryLot.create({ data: {
      id: noProofLotId, skuId: sourceSku.id, receiptId: `missing-native-receipt-${randomUUID()}`, purchaseLineId: `missing-native-line-${randomUUID()}`,
      label: "Lote sin recepción", unit: "g", unitCost: "2", costCurrency: "ARS", receivedAt: new Date(),
    } });
    await db.stockBalance.create({ data: { id: noProofBalanceId, lotId: noProofLotId, locationId, custodianId: ownerId, unit: "g", quantity: "50", reserved: "0" } });

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
    assert.equal(catalogResponse.status, 200, await catalogResponse.clone().text());
    const catalog = await catalogResponse.json() as { items: Array<{ id: string; appSheetSourceLots?: Array<any>; appSheetNativeLots?: Array<any> }> };
    const catalogSku = catalog.items.find(item => item.id === sourceSku.id);
    assert.ok(catalogSku);
    const sourceLotOptions = catalogSku.appSheetSourceLots ?? [];
    assert.deepEqual(sourceLotOptions, [], "the deliberately unreviewed D_Stock fixture is not a selectable AppSheet lot");
    const nativeLotOptions = catalogSku.appSheetNativeLots ?? [];
    assert.equal(nativeLotOptions.length, 1, "only the lot with a complete Bombo GoodsReceived chain is selectable");
    const selectedNativeLot = nativeLotOptions[0]!;
    assert.deepEqual(selectedNativeLot, {
      origin: "bombo-goods-receipt", stockLotId: receivedLot.lotId, lotLabel: "Lote nativo de prueba", receivedDate: today, availableQuantity: "100.000",
    });
    await db.operationAccess.update({ where: { userId: scopedId }, data: {
      profile: "commercial", enabled: true, capabilities: ["orders.write"],
      scope: { locationIds: ["outside-native-lot-location"], custodianIds: [ownerId] },
    } });
    const scopedCatalogResponse = await call("/operations/catalog?channel=local", scopedId);
    assert.equal(scopedCatalogResponse.status, 200, await scopedCatalogResponse.clone().text());
    const scopedCatalog = await scopedCatalogResponse.json() as { items: Array<{ id: string; appSheetNativeLots?: Array<any> }> };
    const scopedCatalogSku = scopedCatalog.items.find(item => item.id === sourceSku.id);
    assert.ok(scopedCatalogSku);
    assert.deepEqual(scopedCatalogSku.appSheetNativeLots, [], "the selectable native lot is filtered by the caller's location scope");

    const nativeInvoiceTargetId = `appsheet-native-lot-invoice-${randomUUID()}`;
    const nativeInvoice = invoiceData({ preorder: false, quantity: "3", lineId: `native-lot-invoice-line-${randomUUID()}` });
    const nativeInvoiceInput: Record<string, any> = {
      ...nativeInvoice, memberId: sourceMember.id,
      lines: nativeInvoice.lines.map(line => ({ ...line, skuId: sourceSku.id, stockLotId: selectedNativeLot.stockLotId })),
    };
    delete nativeInvoiceInput.invoiceNumber;
    const nativeInvoiceRequest = envelope(nativeInvoiceTargetId, "InvoiceSaved", nativeInvoiceInput);
    const confirmedNativeInvoice = await send(nativeInvoiceRequest);
    assert.equal(confirmedNativeInvoice.response.status, 200, JSON.stringify(confirmedNativeInvoice.body));
    assert.equal(confirmedNativeInvoice.body.result.commercialState, "confirmed");
    const savedNativeOrder = await db.operationOrder.findUniqueOrThrow({ where: { id: nativeInvoiceTargetId } });
    assert.equal((savedNativeOrder.quote as any).input.lines[0].stockLotId, receivedLot.lotId);
    assert.equal((savedNativeOrder.quote as any).lines[0].stockLotId, receivedLot.lotId, "the immutable invoice snapshot retains the selected native lot");
    const nativeReservations = await db.stockReservation.findMany({ where: { orderId: nativeInvoiceTargetId } });
    assert.equal(nativeReservations.length, 1);
    assert.equal(nativeReservations[0]!.quantity.toString(), "3");
    const nativeReservedBalance = await db.stockBalance.findUniqueOrThrow({ where: { id: nativeReservations[0]!.balanceId } });
    assert.equal(nativeReservedBalance.lotId, receivedLot.lotId, "the invoice reserves only the selected Bombo GoodsReceived lot");
    assert.equal(nativeReservedBalance.reserved.toString(), "3");
    const nativeInvoiceEffects = async () => ({
      order: await db.operationOrder.findUniqueOrThrow({ where: { id: nativeInvoiceTargetId } }),
      object: await db.operationObject.findUniqueOrThrow({ where: { id: nativeInvoiceTargetId } }),
      lines: await db.operationOrderLine.findMany({ where: { orderId: nativeInvoiceTargetId }, orderBy: { id: "asc" } }),
      reservations: await db.stockReservation.findMany({ where: { orderId: nativeInvoiceTargetId }, orderBy: { id: "asc" } }),
      balance: await db.stockBalance.findUniqueOrThrow({ where: { id: receivedLot.balanceId } }),
      sequence: await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } }),
      numberReservations: await db.appSheetInvoiceNumberReservation.findMany({ where: { namespace: capture.captureId }, orderBy: { id: "asc" } }),
      receipt: await db.commandReceipt.findUniqueOrThrow({ where: { requestId: nativeInvoiceRequest.requestId } }),
      audits: await db.operationAudit.findMany({ where: { requestId: nativeInvoiceRequest.requestId }, orderBy: { id: "asc" } }),
      outbox: await db.operationOutbox.findMany({ where: { requestId: nativeInvoiceRequest.requestId }, orderBy: { id: "asc" } }),
    });
    const nativeInvoiceEffectsAfterWrite = await nativeInvoiceEffects();
    const replayedNativeInvoice = await command(nativeInvoiceRequest);
    assert.equal(replayedNativeInvoice.body.replay, true);
    assert.deepEqual(await nativeInvoiceEffects(), nativeInvoiceEffectsAfterWrite, "native invoice replay does not double-reserve stock or advance numbering");

    const nativeFailureEffects = async () => ({
      sequence: await db.appSheetInvoiceSequence.findUniqueOrThrow({ where: { namespace: capture.captureId } }),
      numberReservations: await db.appSheetInvoiceNumberReservation.findMany({ where: { namespace: capture.captureId }, orderBy: { id: "asc" } }),
      orderCount: await db.operationOrder.count(), orderLineCount: await db.operationOrderLine.count(),
      reservationCount: await db.stockReservation.count(), assignmentCount: await db.deliveryAssignment.count(),
      stockFactCount: await db.stockFact.count(), goodsReceiptCount: await db.goodsReceipt.count(), inventoryLotCount: await db.inventoryLot.count(),
      balances: await db.stockBalance.findMany({ orderBy: { id: "asc" } }),
      commandReceiptCount: await db.commandReceipt.count(), auditCount: await db.operationAudit.count(), outboxCount: await db.operationOutbox.count(),
    });
    async function assertRejectedNativeInvoice(targetId: string, line: Record<string, unknown>, status: number, code?: string, reason?: string) {
      const failedInput: Record<string, any> = { ...invoiceData({ preorder: false, quantity: "3", lineId: `native-rejected-line-${randomUUID()}` }), memberId: sourceMember.id };
      delete failedInput.invoiceNumber;
      failedInput.lines = [{ ...failedInput.lines[0], ...line, skuId: sourceSku.id }];
      const failedRequest = envelope(targetId, "InvoiceSaved", failedInput);
      const beforeFailure = await nativeFailureEffects();
      const failed = await send(failedRequest);
      assert.equal(failed.response.status, status, JSON.stringify(failed.body));
      if (code) assert.equal(failed.body.code, code, JSON.stringify(failed.body));
      if (reason) assert.equal(failed.body.details?.reason, reason, JSON.stringify(failed.body));
      assert.deepEqual(await nativeFailureEffects(), beforeFailure, "rejected native invoice leaves the invoice sequence, balances, and command effects unchanged");
      assert.equal(await db.operationOrder.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.operationOrderLine.count({ where: { orderId: targetId } }), 0);
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.appSheetInvoiceNumberReservation.findUnique({ where: { orderId: targetId } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: failedRequest.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: failedRequest.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: failedRequest.requestId } }), 0);
    }
    await assertRejectedNativeInvoice(`appsheet-native-no-proof-${randomUUID()}`, { stockLotId: noProofLotId }, 423,
      "APPSHEET_NATIVE_STOCK_LOT_NOT_ELIGIBLE", "native_goods_receipt_missing_or_date_mismatch");
    await assertRejectedNativeInvoice(`appsheet-native-wrong-sku-${randomUUID()}`, { stockLotId: lotId }, 423,
      "APPSHEET_NATIVE_STOCK_LOT_NOT_ELIGIBLE", "native_lot_binding_missing_or_sku_mismatch");
    await assertRejectedNativeInvoice(`appsheet-native-dual-source-${randomUUID()}`, {
      stockLotId: receivedLot.lotId, sourceLotId: rejectedSourceLot.sourceLotId,
    }, 400);

    const goodsReceivedCommandReceipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: goodsReceivedRequest.requestId } });
    const originalGoodsReceivedResponse = inputJson(goodsReceivedCommandReceipt.response);
    const inconsistentGoodsReceivedResponse = inputJson(originalGoodsReceivedResponse) as unknown as Record<string, any>;
    assert.equal(inconsistentGoodsReceivedResponse.result.receipt.receivedDate, today);
    inconsistentGoodsReceivedResponse.result.receipt.receivedDate = "2000-01-01";
    await db.commandReceipt.update({ where: { requestId: goodsReceivedRequest.requestId }, data: { response: inconsistentGoodsReceivedResponse } });
    try {
      const inconsistentCatalogResponse = await call("/operations/catalog?channel=local");
      assert.equal(inconsistentCatalogResponse.status, 200, await inconsistentCatalogResponse.clone().text());
      const inconsistentCatalog = await inconsistentCatalogResponse.json() as { items: Array<{ id: string; appSheetNativeLots?: Array<any> }> };
      const inconsistentCatalogSku = inconsistentCatalog.items.find(item => item.id === sourceSku.id);
      assert.ok(inconsistentCatalogSku);
      assert.deepEqual(inconsistentCatalogSku.appSheetNativeLots, [], "catalogue hides a lot when its GoodsReceived response date conflicts with the receipt");
      await assertRejectedNativeInvoice(`appsheet-native-response-date-mismatch-${randomUUID()}`, { stockLotId: receivedLot.lotId }, 423,
        "APPSHEET_NATIVE_STOCK_LOT_NOT_ELIGIBLE", "native_receipt_command_response_mismatch");
    } finally {
      await db.commandReceipt.update({ where: { requestId: goodsReceivedRequest.requestId }, data: { response: originalGoodsReceivedResponse } });
    }
    assert.deepEqual(inputJson((await db.commandReceipt.findUniqueOrThrow({ where: { requestId: goodsReceivedRequest.requestId } })).response),
      originalGoodsReceivedResponse, "the test restores the stored GoodsReceived response after its corruption case");

    const rejectedTargetId = `appsheet-source-lot-invalid-invoice-${randomUUID()}`;
    const invalidInvoice = invoiceData({ preorder: false, quantity: "3", lineId: `invalid-source-lot-line-${randomUUID()}` });
    const invalidInvoiceInput: Record<string, any> = {
      ...invalidInvoice, memberId: sourceMember.id,
      lines: invalidInvoice.lines.map(line => ({ ...line, skuId: sourceSku.id, sourceLotId: rejectedSourceLot.sourceLotId })),
    };
    delete invalidInvoiceInput.invoiceNumber;
    const invalidInvoiceRequest = envelope(rejectedTargetId, "InvoiceSaved", invalidInvoiceInput);
    const rollbackBefore = await nativeFailureEffects();
    const invalidInvoiceResult = await send(invalidInvoiceRequest);
    assert.equal(invalidInvoiceResult.response.status, 423, JSON.stringify(invalidInvoiceResult.body));
    assert.equal(invalidInvoiceResult.body.code, "APPSHEET_SOURCE_LOT_NOT_ELIGIBLE");
    assert.deepEqual(await nativeFailureEffects(), rollbackBefore,
      "an unreviewed AppSheet source lot cannot allocate an invoice number, order, reservation, or command effect");
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
