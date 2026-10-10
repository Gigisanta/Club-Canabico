import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { profileCapabilities, type CommandEnvelope } from "../shared/operations/contracts.js";
import { canonicalJson } from "../shared/operations/exact.js";
import { canonicalCommandBodyHash } from "../server/operations/canonical.js";
import {
  APPSHEET_CANONICAL_IMPORTER_VERSION,
  APPSHEET_CANONICAL_MAPPING_ID,
  APPSHEET_CANONICAL_SCHEMA_VERSION,
  APPSHEET_CANONICAL_SOURCE_SYSTEM,
  prepareAppSheetCaptureManifest,
} from "../shared/operations/appsheet-canonical.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { legacyPayloadHash } from "../server/operations/legacy-upload-contract.js";
import {
  APPSHEET_HISTORY_IMPORTER_VERSION,
  APPSHEET_HISTORY_MAPPING_ID,
  APPSHEET_HISTORY_STAGE_SCHEMA_VERSION_V2,
  APPSHEET_HISTORY_SOURCE_SYSTEM,
} from "../shared/operations/appsheet-history.js";
import { splitSqlStatements } from "./migration-sql.js";

test("AppSheet canonical member and SKU writes require capture-bound review evidence", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");
  const schema = `appsheet_member_eligibility_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: "appsheet-member-test-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://appsheet-member.test",
  });

  const { APPSHEET_EXPECTED_LIVE_APP_ID, appSheetAppliedDefinitionHash, appSheetCanonicalCurrentDestinationHash,
    appSheetDefinitionProductionReadiness } = await import("../server/operations/appsheet-canonical.js");
  const { definitionInventory, project } = await import("./support/appsheet-canonical-fixture.js");
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

    const ownerId = "appsheet-member-eligibility-owner";
    const passwordText = randomUUID();
    const password = await bcrypt.hash(passwordText, 4);
    await db.user.create({ data: { id: ownerId, name: "Synthetic owner", email: `${ownerId}@appsheet-member.test`, password, role: "owner" } });
    // This isolated fixture opts its synthetic owner into clinical review so the
    // positive and rejected-member cases reach the clinical eligibility checks.
    await db.operationAccess.create({ data: {
      userId: ownerId,
      profile: "owner",
      enabled: true,
      capabilities: [...profileCapabilities.owner, "clinical.review"],
      scope: {},
    } });

    const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
    const inputJson = (value: unknown): Prisma.InputJsonValue => {
      const serialized = JSON.stringify(value);
      if (serialized === undefined) throw new TypeError("Synthetic JSON fixture is not serializable");
      return JSON.parse(serialized) as Prisma.InputJsonValue;
    };
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);
    await db.operationAuthority.create({
      data: { id: "operations", mode: "shadow", cutoverProfile: "legacy", captureManifestId: null, epoch: 1 },
    });
    const locationId = "appsheet-member-eligibility-location";
    await db.location.create({ data: { id: locationId, key: locationId, name: "Synthetic order location" } });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const origin = "http://appsheet-member.test";
    let cookie = "";
    async function call(path: string, body?: unknown, sessionCookie = cookie) {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(sessionCookie ? { Cookie: sessionCookie } : {}), Origin: origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, body: await response.json() as Record<string, any> };
    }
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${ownerId}@appsheet-member.test`, password: passwordText }),
    });
    assert.equal(login.status, 200, await login.text());
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const envelope = (targetId: string, command: string, data: Record<string, unknown>): CommandEnvelope => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command,
      data,
      expectedVersion: 0,
      occurredAt: new Date().toISOString(),
    });
    async function successfulCommand(targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0) {
      const request = { ...envelope(targetId, command, data), expectedVersion };
      const result = await call("/operations/commands", request);
      assert.equal(result.response.status, 200, `${command}: ${JSON.stringify(result.body)}`);
      return { request, ...result };
    }
    const deniedEffects = async (request: CommandEnvelope, targetId: string, expectedVersion: number | null) => {
      const denied = await call("/operations/commands", request);
      assert.equal(denied.response.status, 423, `${request.command}: ${JSON.stringify(denied.body)}`);
      assert.equal(denied.body.code, "APPSHEET_MEMBER_NOT_ELIGIBLE");
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }).then(row => row?.version ?? null), expectedVersion);
      assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: request.requestId } }), 0);
      return denied;
    };

    // Synthetic, complete staged contract: the actual review/mutation/order
    // commands below create their own receipts and audits. This fixture is not
    // evidence that the AppSheet stage writer observed real bots or editor state.
    const canonicalProjection = project({ captureRevision: `member-eligibility-${randomUUID()}` });
    const canonicalManifest = canonicalProjection.capture;
    const pageRefs = canonicalManifest.pageManifest.map(page => ({ path: page.path, sheetId: page.sheetId, pageIndex: page.pageIndex,
      startRow: page.startRow, endRow: page.endRow, pageHash: page.pageHash, counts: page.counts }));
    const canonicalDataHash = hash(pageRefs);
    const captureSheets: Array<Record<string, unknown>> = canonicalManifest.pageManifest.map(page => ({ sheetId: page.sheetId, title: page.title,
      pageCount: 1, verifiedPageCount: 1, stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false }));
    captureSheets.push({ sheetId: 99, title: "T_Usuarios", pageCount: 0, verifiedPageCount: 0, stablePageCount: 0,
      changedPageCount: 0, bodyRead: false, bodyExcluded: true, bodyExclusionReason: "authentication-table-body-redacted" });
    const canonicalCapture = prepareAppSheetCaptureManifest({
      schemaVersion: APPSHEET_CANONICAL_SCHEMA_VERSION,
      ...canonicalManifest,
      dataHash: canonicalDataHash,
      stability: { ...canonicalManifest.stability, cutoverEligible: true, missingPages: 0, unresolvedFormulaCount: 0,
        sourceWriteDetected: false, bodyExcludedSheets: ["T_Usuarios"] },
      coverage: { ...canonicalManifest.dataCoverage, metadataStable: true, headersStableAll: true, failedPages: 0,
        changedPages: 0, unresolvedFormulaCount: 0, dataRecordCount: canonicalManifest.dataRecordCount, sheets: captureSheets },
      pages: canonicalManifest.pageManifest,
    });
    await db.appSheetCaptureManifest.create({ data: {
      ...canonicalCapture,
      stability: inputJson(canonicalCapture.stability),
      dataCoverage: inputJson(canonicalCapture.dataCoverage),
      pageManifest: inputJson(canonicalCapture.pageManifest),
      definitionCoverage: Prisma.DbNull,
      firstReadAt: new Date(canonicalCapture.firstReadAt),
      verificationStartedAt: new Date(canonicalCapture.verificationStartedAt),
      verificationCompletedAt: new Date(canonicalCapture.verificationCompletedAt),
      cutoffAt: new Date(canonicalCapture.cutoffAt),
    } });

    const stagerId = "appsheet-member-eligibility-stager";
    await db.user.create({ data: { id: stagerId, name: "Synthetic stage operator", email: `${stagerId}@appsheet-member.test`, password, role: "admin" } });
    const canonicalMemberDestination = canonicalProjection.destinations.find(destination => destination.type === "member");
    const canonicalSkuDestination = canonicalProjection.destinations.find(destination => destination.type === "sku");
    assert.ok(canonicalMemberDestination?.type === "member" && canonicalSkuDestination?.type === "sku");
    const canonicalMember = await db.operationMember.create({ data: { id: canonicalMemberDestination.id, ...canonicalMemberDestination.data } });
    const canonicalSku = await db.catalogSku.create({ data: { id: canonicalSkuDestination.id, ...canonicalSkuDestination.data } });
    const canonicalIdentityIds: string[] = [];
    for (const destination of [canonicalMemberDestination, canonicalSkuDestination]) {
      await db.operationObject.create({ data: { id: destination.id, kind: destination.type, version: 0, createdBy: stagerId } });
      const identityId = `synthetic-${destination.type}-identity-${randomUUID()}`;
      canonicalIdentityIds.push(identityId);
      await db.legacyIdentity.create({ data: {
        id: identityId,
        sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        sourceTable: destination.sourceTable,
        sourceKey: destination.sourceKey,
        destinationType: destination.type,
        destinationId: destination.id,
        approvedBy: null,
      } });
    }
    assert.equal(canonicalProjection.summary.exceptionCount, 0, "el staged fixture debe estar libre de excepciones");

    const syntheticDefinition = definitionInventory();
    const definitionCoverage = (["tables", "columns", "slices", "views", "formatRules", "actions", "bots", "workflowRules", "security", "settings", "other"] as const)
      .map(category => ({ category, state: "matched_declared_count" as const, declaredCount: category === "bots" ? 1 : 0,
        observedCount: category === "bots" ? 1 : 0, missingCount: 0, redactedFieldCount: 0, ambiguousFieldCount: 0,
        evidenceCount: category === "bots" ? 1 : 0, note: "synthetic staged contract fixture" }));
    const definitionBase = {
      ...syntheticDefinition,
      app: { ...syntheticDefinition.app, id: APPSHEET_EXPECTED_LIVE_APP_ID, name: "Synthetic verified app" },
      declaredCounts: { bots: 1 },
      observedCounts: { bots: 1 },
      coverage: definitionCoverage,
      descriptorSha256: "",
    };
    const fullDefinition = { ...definitionBase, descriptorSha256: hash(definitionBase) };
    const appliedDefinitionHash = appSheetAppliedDefinitionHash(fullDefinition);
    const destinationIdentity = appSheetDatabaseDestinationIdentity("production", databaseUrl);
    const projectionHash = hash({
      schemaVersion: canonicalProjection.schemaVersion,
      projectionKind: canonicalProjection.projectionKind,
      mappingId: APPSHEET_CANONICAL_MAPPING_ID,
      importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
      captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash,
      dataHash: canonicalCapture.dataHash,
      captureDefinitionHash: null,
      appliedDefinitionHash,
      expectedAppId: APPSHEET_EXPECTED_LIVE_APP_ID,
      definitionIdentityState: "verified",
      definitionDescriptorSha256: fullDefinition.descriptorSha256,
      definitionSourceSha256: fullDefinition.source.sha256,
      stabilityMode: "stable",
      verifiedMasterPages: canonicalProjection.verifiedMasterPages,
      deltaPageHashes: [],
      tables: canonicalProjection.tableCoverage,
      records: canonicalProjection.records.map(record => ({
        sourceTable: record.sourceTable,
        sourceKey: record.sourceKey,
        sourceRow: record.sourceRow,
        contentHash: record.contentHash,
        normalizedHash: hash(record.normalized),
        treatment: record.treatment,
        exceptions: record.exceptions,
        destination: record.destination ? { type: record.destination.type, id: record.destination.id, payloadHash: hash(record.destination.data) } : null,
      })),
    });
    const destinationFingerprints = [
      { destinationType: "member", sourceTable: canonicalMemberDestination.sourceTable, sourceKey: canonicalMemberDestination.sourceKey,
        destinationId: canonicalMember.id, dataHash: appSheetCanonicalCurrentDestinationHash(canonicalMember, "member"), operationVersion: 0 },
      { destinationType: "sku", sourceTable: canonicalSkuDestination.sourceTable, sourceKey: canonicalSkuDestination.sourceKey,
        destinationId: canonicalSku.id, dataHash: appSheetCanonicalCurrentDestinationHash(canonicalSku, "sku"), operationVersion: 0 },
    ];
    const backupEvidence = { manifestHash: hash("synthetic-backup"), snapshotAt: now.toISOString() };
    const technicalReview = {
      reviewKind: "independent-technical", approved: true, projectionHash, captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash, definitionHash: appliedDefinitionHash,
      importer: APPSHEET_CANONICAL_IMPORTER_VERSION, reviewer: "synthetic-independent-reviewer",
      reviewedAt: new Date(now.getTime() - 1_000).toISOString(), findingsCount: 0, commitSha: "1".repeat(40),
      target: "production", destinationIdentity,
    };
    const snapshotControls = { appSheetCanonical: {
      schemaVersion: 1, projectionKind: "masters", mappingId: APPSHEET_CANONICAL_MAPPING_ID,
      importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION, captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash, dataHash: canonicalCapture.dataHash, captureDefinitionHash: null,
      appliedDefinitionHash, expectedAppId: APPSHEET_EXPECTED_LIVE_APP_ID, definitionIdentityState: "verified",
      definitionInventory: fullDefinition, projectionHash, destinationFingerprints,
      botInventory: { state: "verified", evidenceSha256: hash("synthetic bot inventory fixture"), observedCount: 1 },
      stageContext: { target: "production", destinationIdentity, backupEvidence }, technicalReview,
      effects: { stock: false, cash: false, orders: false, deliveries: false, messaging: false, priceApproval: false },
    } };
    const snapshotCoverage = { appSheetCanonical: {
      captureId: canonicalCapture.captureId, manifestHash: canonicalCapture.manifestHash, dataHash: canonicalCapture.dataHash,
      captureDefinitionHash: null, identityState: "verified", projectionHash, appliedDefinitionHash,
      botInventory: snapshotControls.appSheetCanonical.botInventory,
      tables: canonicalProjection.tableCoverage,
    } };
    await db.legacyImportSnapshot.create({ data: {
      id: canonicalProjection.snapshotId, sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, filename: "synthetic-canonical-stage",
      fileHash: canonicalCapture.manifestHash, importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION, status: "staged",
      createdBy: stagerId, captureManifestId: canonicalCapture.captureId,
      controls: inputJson(snapshotControls), coverage: inputJson(snapshotCoverage),
    } });
    for (const record of canonicalProjection.records) {
      await db.legacySourceRecord.create({ data: {
        id: record.id,
        snapshotId: canonicalProjection.snapshotId,
        sourceTable: record.sourceTable,
        sourceKey: record.sourceKey,
        sourceRow: record.sourceRow,
        fileHash: record.fileHash,
        contentHash: record.contentHash,
        importerVersion: record.importerVersion,
        original: record.original,
        normalized: record.normalized,
        treatment: record.treatment,
      } });
    }
    await db.operationObject.create({ data: { id: canonicalProjection.snapshotId, kind: "legacyImport", version: 0, createdBy: stagerId } });
    await db.operationAudit.create({ data: {
      actorId: stagerId, action: "appsheet.canonical_masters_staged", objectId: canonicalProjection.snapshotId,
      details: {
        captureId: canonicalCapture.captureId, manifestHash: canonicalCapture.manifestHash, projectionHash,
        destinationIdentity, target: "production", importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
        recordCount: canonicalProjection.summary.recordCount, destinationCount: canonicalProjection.destinations.length,
        exceptionCount: 0, reviewer: technicalReview.reviewer, reviewedAt: technicalReview.reviewedAt,
        commitSha: technicalReview.commitSha, backupManifestHash: backupEvidence.manifestHash, backupSnapshotAt: backupEvidence.snapshotAt,
      },
    } });
    await db.operationAuthority.update({
      where: { id: "operations" },
      data: { mode: "shadow", cutoverProfile: "appsheet-replacement", captureManifestId: canonicalCapture.captureId, epoch: 2, approvedBy: ownerId },
    });

    const canonicalReview = await successfulCommand(canonicalProjection.snapshotId, "AppSheetCanonicalIdentitiesReviewed", {
      captureId: canonicalCapture.captureId, manifestHash: canonicalCapture.manifestHash, projectionHash,
      destinationCount: canonicalProjection.destinations.length, evidenceReference: "synthetic canonical review fixture",
    });
    assert.equal(canonicalReview.body.result.status, "reviewed");
    assert.equal((await db.legacyImportSnapshot.findUniqueOrThrow({ where: { id: canonicalProjection.snapshotId } })).reviewedBy, ownerId);
    assert.equal(await db.operationAudit.count({ where: { objectId: canonicalProjection.snapshotId, action: "appsheet.canonical_identities_reviewed" } }), 1);
    assert.equal(await db.operationAudit.count({ where: { objectId: { in: canonicalIdentityIds }, action: "appsheet.canonical_identity_reviewed" } }), 2);
    assert.equal((await call(`/operations/members/${canonicalMember.id}`)).response.status, 200,
      "la auditoría real de revisión deja visible al socio canónico");

    // Synthetic same-capture history supports the real pre-activation opening
    // command. It is a contract fixture, not proof of source-system cutover.
    const canonicalSkuSourceId = canonicalSku.sourceId;
    assert.ok(canonicalSkuSourceId);
    const historySnapshotId = `appsheet-member-eligibility-history-${randomUUID()}`;
    const historySourceRecordId = `appsheet-member-eligibility-stock-source-${randomUUID()}`;
    const historySourceKey = `synthetic-stock-source-${randomUUID()}`;
    const historyContentHash = hash({ sourceTable: "D_Stock", sourceKey: historySourceKey, quantity: "5", unit: "g" });
    const historyFactId = `appsheet-member-eligibility-stock-fact-${randomUUID()}`;
    const historyPublicationFingerprint = legacyPayloadHash({
      snapshotId: historySnapshotId,
      fileHash: canonicalCapture.manifestHash,
      mappingId: APPSHEET_HISTORY_MAPPING_ID,
      rows: 1,
      corrections: [],
    });
    const historyProjectionHash = hash({
      schemaVersion: "appsheet-history-projection/v1",
      captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash,
      dataHash: canonicalCapture.dataHash,
      sourceRecordId: historySourceRecordId,
      sourceHash: historyContentHash,
      factId: historyFactId,
    });
    const historyBackup = { manifestHash: hash("synthetic-history-backup"), snapshotAt: now.toISOString() };
    const historyTechnicalReview = {
      schemaVersion: 2,
      reviewKind: "independent-technical",
      approved: true,
      bindingSource: "explicit-target-and-destination",
      reviewer: "synthetic-independent-history-reviewer",
      reviewedAt: new Date(now.getTime() - 1_000).toISOString(),
      findingsCount: 0,
      findingsHash: hash([]),
      commitSha: technicalReview.commitSha,
    };
    const historyStage = {
      schemaVersion: APPSHEET_HISTORY_STAGE_SCHEMA_VERSION_V2,
      projectionKind: "history",
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      mappingId: APPSHEET_HISTORY_MAPPING_ID,
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash,
      dataHash: canonicalCapture.dataHash,
      captureDefinitionHash: null,
      mode: "stable",
      definitionHash: appliedDefinitionHash,
      definitionSourceSha256: fullDefinition.source.sha256,
      definitionDescriptorSha256: fullDefinition.descriptorSha256,
      definitionFileSha256: hash("synthetic history definition file"),
      definitionIdentityState: "verified",
      definitionReadiness: appSheetDefinitionProductionReadiness(fullDefinition),
      definitionInventory: fullDefinition,
      status: "staged",
      projectionHash: historyProjectionHash,
      destination: { target: "production", identity: destinationIdentity },
      humanReview: { status: "pending" },
      operationalAuthority: { status: "unchanged" },
      authorizationContext: "user-authorized-plan",
      actorUserId: stagerId,
      actor: "codex:appsheet-history-stage",
      reviewedBy: null,
      reviewedAt: null,
      effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false, documents: false, numbering: "not-generated" },
      backupManifestHash: historyBackup.manifestHash,
      backupSnapshotAt: historyBackup.snapshotAt,
      technicalReview: historyTechnicalReview,
      recordsHash: hash([{ id: historySourceRecordId, sourceTable: "D_Stock", sourceKey: historySourceKey, contentHash: historyContentHash }]),
      factsHash: hash([{ id: historyFactId, sourceRecordId: historySourceRecordId, sourceHash: historyContentHash, kind: "stock", quantity: "5", unit: "g" }]),
      exceptionsHash: hash([]),
    };
    const historyCoverage = {
      schemaVersion: "appsheet-history-coverage/v1",
      projectionKind: "history",
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      captureId: canonicalCapture.captureId,
      manifestHash: canonicalCapture.manifestHash,
      dataHash: canonicalCapture.dataHash,
      captureDefinitionHash: null,
      appliedDefinitionHash,
      mode: "stable",
      stability: { stable: true },
      pages: canonicalCapture.pageManifest.map(page => ({
        sheetId: page.sheetId, title: page.title, pageIndex: page.pageIndex, startRow: page.startRow,
        endRow: page.endRow, pageHash: page.pageHash, verifiedPageHash: page.verifiedPageHash, stable: page.stable,
      })),
      sheets: [{ sourceTable: "D_Stock", sourceRecordCount: 1, factCount: 1, definitionTableMatch: "unique", changedPageIndexes: [], unresolvedFormulaCount: 0 }],
      source: { spreadsheetId: canonicalCapture.spreadsheetId, dataRecordCount: 1 },
      totals: { recordCount: 1, factCount: 1, exceptionCount: 0 },
      exceptionTotal: 0,
      definition: {
        inventory: fullDefinition,
        identityState: "verified",
        appliedDefinitionHash,
        sourceSha256: fullDefinition.source.sha256,
        descriptorSha256: fullDefinition.descriptorSha256,
        commitSha: technicalReview.commitSha,
      },
    };
    await db.legacyImportSnapshot.create({ data: {
      id: historySnapshotId,
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      filename: "synthetic-same-capture-stock-history",
      fileHash: canonicalCapture.manifestHash,
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      status: "reviewed",
      createdBy: stagerId,
      reviewedBy: ownerId,
      reviewedAt: now,
      captureManifestId: canonicalCapture.captureId,
      controls: inputJson({ appSheetHistoryStage: historyStage }),
      coverage: inputJson(historyCoverage),
    } });
    await db.legacySourceRecord.create({ data: {
      id: historySourceRecordId,
      snapshotId: historySnapshotId,
      sourceTable: "D_Stock",
      sourceKey: historySourceKey,
      sourceRow: 2,
      fileHash: canonicalCapture.manifestHash,
      contentHash: historyContentHash,
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      original: { columns: [{ header: "Cantidad", value: "5" }, { header: "Unidad", value: "g" }] },
      normalized: { columns: [{ header: "Cantidad", value: "5", exactDecimal: "5" }, { header: "Unidad", value: "g" },
        { header: "Codigo_Detalle", value: canonicalSkuSourceId }] },
      treatment: "fact_candidate",
    } });
    await db.legacyHistoricalFact.create({ data: {
      id: historyFactId,
      snapshotId: historySnapshotId,
      sourceRecordId: historySourceRecordId,
      sourceTable: "D_Stock",
      sourceKey: historySourceKey,
      sourceRow: 2,
      sourceHash: historyContentHash,
      mappingId: APPSHEET_HISTORY_MAPPING_ID,
      kind: "stock",
      dateState: "not-applicable",
      currencyState: "not-applicable",
      amountState: "not-applicable",
      quantity: "5",
      quantityState: "known",
      unit: "g",
      unitState: "known",
      attributes: { relationships: [{ targetTable: "D_Catalogo_Mercaderia", status: "unique", targetSourceKey: canonicalSkuSourceId }] },
      createdBy: stagerId,
    } });
    await db.legacyHistoryPublication.create({ data: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      snapshotId: historySnapshotId,
      fileHash: canonicalCapture.manifestHash,
      mappingId: APPSHEET_HISTORY_MAPPING_ID,
      fingerprint: historyPublicationFingerprint,
      publishedBy: stagerId,
      evidence: { reference: "synthetic same-capture publication fixture" },
    } });
    await db.operationAudit.create({ data: {
      actorId: stagerId,
      action: "legacy.appsheet_history_staged",
      objectId: historySnapshotId,
      details: {
        sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
        importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
        captureId: canonicalCapture.captureId,
        manifestHash: canonicalCapture.manifestHash,
        dataHash: canonicalCapture.dataHash,
        projectionHash: historyProjectionHash,
        mode: "stable",
        reviewer: historyTechnicalReview.reviewer,
        technicalReviewAt: historyTechnicalReview.reviewedAt,
        commitSha: historyTechnicalReview.commitSha,
        target: "production",
        destinationIdentity,
        backupManifestHash: historyBackup.manifestHash,
        backupSnapshotAt: historyBackup.snapshotAt,
        authorizationContext: "user-authorized-plan",
        recordCount: 1,
        factCount: 1,
        exceptionCount: 0,
        reviewedBy: null,
        status: "staged",
      },
    } });

    const manualPauseStartedAt = new Date(new Date(canonicalCapture.firstReadAt).getTime() - 1_000).toISOString();
    const finalDelta = {
      schemaVersion: 1,
      manualPauseStartedAt,
      manualPauseEndedAt: null,
      manualPauseEvidenceRef: "synthetic:manual-pause-before-capture",
      capture: {
        captureId: canonicalCapture.captureId,
        manifestHash: canonicalCapture.manifestHash,
        dataHash: canonicalCapture.dataHash,
        firstReadAt: new Date(canonicalCapture.firstReadAt).toISOString(),
        verificationStartedAt: new Date(canonicalCapture.verificationStartedAt).toISOString(),
        verificationCompletedAt: new Date(canonicalCapture.verificationCompletedAt).toISOString(),
        cutoffAt: new Date(canonicalCapture.cutoffAt).toISOString(),
        sourceWriteDetected: false,
      },
      expectedHandoffChanges: { disposition: "separate-review", reference: "synthetic:handoff-delta-review" },
    };
    const finalDeltaEvidence = {
      humanEvidence: { reference: "synthetic distinct author and reviewer" },
      appSheetReplacement: {
        schemaVersion: 1,
        captureId: canonicalCapture.captureId,
        manifestHash: canonicalCapture.manifestHash,
        dataHash: canonicalCapture.dataHash,
        captureDefinitionHash: null,
        appliedDefinitionHash,
        gateProof: { finalDelta },
      },
    };
    await db.cutoverGate.create({ data: {
      id: "final-delta-reconciled",
      status: "approved",
      evidence: finalDeltaEvidence,
      captureManifestId: canonicalCapture.captureId,
      approvedBy: stagerId,
      reviewedBy: ownerId,
      approvedAt: now,
    } });

    const openingLotId = `appsheet-member-eligibility-opening-lot-${randomUUID()}`;
    const openingRequest = envelope(openingLotId, "StockOpeningRecorded", {
      skuId: canonicalSku.id,
      label: "Synthetic reviewed AppSheet stock opening",
      quantity: "5",
      unitCost: "10",
      costCurrency: "ARS",
      receivedDate: today,
      locationId,
      custodianId: ownerId,
      preparedBy: stagerId,
      evidence: { note: "Synthetic same-capture D_Stock opening" },
      sourceRecordId: historySourceRecordId,
    });
    const openingAuthorityBefore = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    const openingAuthorityObjectBefore = await db.operationObject.findUnique({ where: { id: "operations" } });
    const inactiveSkuBeforeOpening = await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalSku.id } });
    const inactiveSkuObjectBeforeOpening = await db.operationObject.findUniqueOrThrow({ where: { id: canonicalSku.id } });
    assert.equal(openingAuthorityBefore.mode, "shadow", "la apertura se prepara antes de la primera activación");
    assert.equal(inactiveSkuBeforeOpening.active, false, "la apertura precede la activación del SKU canónico");
    const openingAuthorityForOpening = await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } });
    const openedStock = await call("/operations/commands", openingRequest);
    assert.equal(openedStock.response.status, 200, JSON.stringify(openedStock.body));
    assert.equal(openedStock.body.result.lot.id, openingLotId);
    assert.equal(openedStock.body.result.lot.skuId, canonicalSku.id);
    assert.equal(openedStock.body.result.lot.unit, "g");
    assert.equal(openedStock.body.result.balance.lotId, openingLotId);
    assert.equal(openedStock.body.result.balance.quantity, "5");
    assert.ok(new Prisma.Decimal(openedStock.body.result.opening.quantity).eq("5"), "la apertura debe conservar exactamente 5 g");
    assert.equal(openedStock.body.result.opening.preparedBy, stagerId);
    assert.equal(openedStock.body.result.opening.approvedBy, ownerId);
    const openingReceipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: openingRequest.requestId } });
    assert.equal(openingReceipt.actorId, ownerId);
    assert.equal(openingReceipt.targetId, openingLotId);
    assert.equal(openingReceipt.command, "StockOpeningRecorded");
    assert.equal(openingReceipt.bodyHash, canonicalCommandBodyHash(openingRequest));
    assert.equal(openingReceipt.resultingVersion, 1);
    const openingFacts = await db.stockFact.findMany({ where: { requestId: openingRequest.requestId } });
    assert.equal(openingFacts.length, 1);
    assert.equal(openingFacts[0]!.kind, "opening");
    assert.equal(openingFacts[0]!.lotId, openingLotId);
    assert.equal(openingFacts[0]!.sourceRecordId, historySourceRecordId);
    assert.equal(openingFacts[0]!.quantity.toString(), "5");
    assert.equal(openingFacts[0]!.unit, "g");
    assert.equal(openingFacts[0]!.toLocationId, locationId);
    assert.equal(openingFacts[0]!.toCustodianId, ownerId);
    assert.equal(openingFacts[0]!.reason, "independently_reconciled_stock_opening");
    assert.equal(await db.legacySourceRecord.count({ where: { id: historySourceRecordId, sourceTable: "D_Stock" } }), 1);
    assert.equal(await db.stockFact.count({ where: { sourceRecordId: historySourceRecordId, kind: "opening" } }), 1);
    const reviewedOpeningSource = await db.legacySourceRecord.findUniqueOrThrow({ where: { id: historySourceRecordId }, include: { snapshot: true } });
    assert.equal(reviewedOpeningSource.snapshot.captureManifestId, canonicalCapture.captureId);
    assert.equal(reviewedOpeningSource.snapshot.status, "reviewed");
    assert.equal(reviewedOpeningSource.snapshot.reviewedBy, ownerId);
    assert.equal(await db.operationObject.findUniqueOrThrow({ where: { id: openingLotId } }).then(row => row.version), 1);
    assert.equal(await db.operationAudit.count({ where: { requestId: openingRequest.requestId } }), 2,
      "la apertura conserva auditoría del efecto y del comando");
    assert.equal(await db.operationOutbox.count({ where: { requestId: openingRequest.requestId } }), 1);
    assert.deepEqual(await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } }), openingAuthorityForOpening,
      "la apertura no activa ni modifica la autoridad");
    assert.deepEqual(await db.operationObject.findUnique({ where: { id: "operations" } }), openingAuthorityObjectBefore);
    assert.deepEqual(await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalSku.id } }), inactiveSkuBeforeOpening);
    assert.deepEqual(await db.operationObject.findUniqueOrThrow({ where: { id: canonicalSku.id } }), inactiveSkuObjectBeforeOpening);

    const openingEffectsAfterFirst = async () => ({
      authority: await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } }),
      authorityObject: await db.operationObject.findUnique({ where: { id: "operations" } }),
      sku: await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalSku.id } }),
      skuObject: await db.operationObject.findUniqueOrThrow({ where: { id: canonicalSku.id } }),
      lot: await db.inventoryLot.findUniqueOrThrow({ where: { id: openingLotId } }),
      lotObject: await db.operationObject.findUniqueOrThrow({ where: { id: openingLotId } }),
      balances: await db.stockBalance.findMany({ where: { lotId: openingLotId }, orderBy: { id: "asc" } }),
      facts: await db.stockFact.findMany({ where: { sourceRecordId: historySourceRecordId }, orderBy: { id: "asc" } }),
      receipt: await db.commandReceipt.findUniqueOrThrow({ where: { requestId: openingRequest.requestId } }),
      audits: await db.operationAudit.findMany({ where: { requestId: openingRequest.requestId }, orderBy: [{ action: "asc" }, { id: "asc" }] }),
      outbox: await db.operationOutbox.findMany({ where: { requestId: openingRequest.requestId }, orderBy: { id: "asc" } }),
      activationReceipts: await db.commandReceipt.count({ where: { targetId: "operations", command: "AuthorityActivated" } }),
      skuActivationAudits: await db.operationAudit.count({ where: { objectId: canonicalSku.id, action: "appsheet.canonical_sku_activated" } }),
    });
    const openingStateBeforeReplay = await openingEffectsAfterFirst();
    assert.equal(openingStateBeforeReplay.sku.active, false);
    assert.equal(openingStateBeforeReplay.skuObject.version, 0);
    assert.equal(openingStateBeforeReplay.authority.mode, "shadow");
    assert.equal(openingStateBeforeReplay.authority.epoch, openingAuthorityForOpening.epoch);
    assert.equal(openingStateBeforeReplay.activationReceipts, 0);
    assert.equal(openingStateBeforeReplay.skuActivationAudits, 0);
    const exactOpeningReplay = await call("/operations/commands", openingRequest);
    assert.equal(exactOpeningReplay.response.status, 200, JSON.stringify(exactOpeningReplay.body));
    assert.equal(exactOpeningReplay.body.replay, true, "el reintento exacto recupera el recibo existente");
    assert.deepEqual(exactOpeningReplay.body.result, openedStock.body.result);
    assert.deepEqual(await openingEffectsAfterFirst(), openingStateBeforeReplay, "el replay no duplica lote, saldo, hecho, recibo, auditoría ni outbox");

    const changedOpeningRequest = structuredClone(openingRequest);
    changedOpeningRequest.data.evidence = { note: "Changed evidence under the same request ID" };
    assert.notEqual(canonicalCommandBodyHash(changedOpeningRequest), canonicalCommandBodyHash(openingRequest));
    const changedOpeningReplay = await call("/operations/commands", changedOpeningRequest);
    assert.equal(changedOpeningReplay.response.status, 409, JSON.stringify(changedOpeningReplay.body));
    assert.equal(changedOpeningReplay.body.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(changedOpeningReplay.body.result, undefined, "el body distinto no revela el recibo previo");
    assert.deepEqual(await openingEffectsAfterFirst(), openingStateBeforeReplay, "el UUID reutilizado con otro body no escribe");

    const reviewedFinalDeltaGate = await db.cutoverGate.findUniqueOrThrow({ where: { id: "final-delta-reconciled" } });
    const publicationBeforeReplayGateChange = await db.legacyHistoryPublication.findUniqueOrThrow({
      where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM },
    });
    await db.cutoverGate.update({ where: { id: "final-delta-reconciled" }, data: { status: "pending" } });
    try {
      const replayAfterGateRevocation = await call("/operations/commands", openingRequest);
      assert.equal(replayAfterGateRevocation.response.status, 200, JSON.stringify(replayAfterGateRevocation.body));
      assert.equal(replayAfterGateRevocation.body.replay, true,
        "un recibo propio exacto sigue recuperable aunque cambie la evidencia viva del gate");
      assert.deepEqual(replayAfterGateRevocation.body.result, openedStock.body.result);
      assert.deepEqual(await openingEffectsAfterFirst(), openingStateBeforeReplay,
        "recuperar el recibo con el gate pendiente no duplica ni modifica efectos");

      const newOpeningWithSameData = structuredClone(openingRequest);
      newOpeningWithSameData.requestId = randomUUID();
      newOpeningWithSameData.targetId = `${openingLotId}-new-request`;
      assert.deepEqual(newOpeningWithSameData.data, openingRequest.data);
      const deniedByPendingGate = await call("/operations/commands", newOpeningWithSameData);
      assert.equal(deniedByPendingGate.response.status, 423, JSON.stringify(deniedByPendingGate.body));
      assert.equal(deniedByPendingGate.body.code, "APPSHEET_REPLACEMENT_NOT_READY");
      assert.deepEqual(deniedByPendingGate.body.details?.blockers, ["final_delta_gate_missing_or_invalid"]);
      assert.equal(await db.operationObject.findUnique({ where: { id: newOpeningWithSameData.targetId } }), null);
      assert.equal(await db.commandReceipt.count({ where: { requestId: newOpeningWithSameData.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: newOpeningWithSameData.requestId } }), 0);
      assert.equal(await db.operationOutbox.count({ where: { requestId: newOpeningWithSameData.requestId } }), 0);
      assert.deepEqual(await openingEffectsAfterFirst(), openingStateBeforeReplay,
        "un requestId nuevo sigue fail-closed y no vuelve a consumir ni alterar la apertura");
      assert.deepEqual(await db.legacyHistoryPublication.findUniqueOrThrow({
        where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM },
      }), publicationBeforeReplayGateChange, "la prueba del replay no muta la publicación histórica");
    } finally {
      await db.cutoverGate.update({
        where: { id: "final-delta-reconciled" },
        data: { status: reviewedFinalDeltaGate.status },
      });
    }
    // This isolated database transition enables post-activation consumer checks;
    // it is not a replay or proof of the AuthorityActivated command and its gates.
    await db.operationAuthority.update({ where: { id: "operations" }, data: { mode: "active", epoch: 3 } });

    const memberUpdate = envelope(canonicalMember.id, "MemberUpdated", {
      name: "Canonical member updated", email: canonicalMember.email, phone: canonicalMember.phone,
      address: canonicalMember.address, preferences: canonicalMember.preferences,
    });
    memberUpdate.expectedVersion = 0;
    const updatedCanonicalMember = await call("/operations/commands", memberUpdate);
    assert.equal(updatedCanonicalMember.response.status, 200, JSON.stringify(updatedCanonicalMember.body));
    const permissionDocumentId = randomUUID();
    await db.operationDocument.create({ data: {
      id: permissionDocumentId, memberId: canonicalMember.id, kind: "synthetic-permission", sensitivity: "commercial",
      state: "available", objectKey: "synthetic-permission-object", checksum: hash("synthetic-permission-bytes"),
      metadata: { fixture: true }, createdBy: ownerId,
    } });
    const permissionDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(now);
    const permissionValidUntil = `${Number(permissionDate.slice(0, 4)) + 1}${permissionDate.slice(4)}`;
    const permissionReview = await successfulCommand(canonicalMember.id, "PermissionVerified", {
      kind: "operations", validFrom: permissionDate, validUntil: permissionValidUntil,
      evidenceDocumentId: permissionDocumentId,
    }, 1);
    const permissionReceipt = await db.commandReceipt.findUniqueOrThrow({ where: { requestId: permissionReview.request.requestId } });
    const permissionResult = (permissionReceipt.response as any).result.permission;
    assert.ok(Number.isFinite(permissionReceipt.committedAt.getTime()), "el recibo conserva una fecha de commit válida");
    assert.ok(Number.isFinite(Date.parse(permissionResult.reviewedAt)), "el permiso conserva una fecha de revisión válida");
    const persistedPermission = await db.memberPermission.findUniqueOrThrow({ where: { id: permissionResult.id } });
    assert.equal(persistedPermission.memberId, canonicalMember.id);
    assert.equal(persistedPermission.kind, "operations");
    assert.equal(persistedPermission.status, "verified");
    assert.equal(persistedPermission.reviewerId, ownerId);
    assert.equal(persistedPermission.validFrom, permissionDate);
    assert.equal(persistedPermission.validUntil, permissionValidUntil);
    assert.equal(persistedPermission.evidenceDocumentId, permissionDocumentId);
    const persistedReviewedAt = persistedPermission.reviewedAt;
    assert.ok(persistedReviewedAt instanceof Date && Number.isFinite(persistedReviewedAt.getTime()),
      "el permiso persistido conserva una fecha de revisión válida");
    assert.equal(persistedReviewedAt?.toISOString(), permissionResult.reviewedAt,
      "el recibo refleja la revisión persistida");
    const clinicalDocumentId = randomUUID();
    await db.operationDocument.create({ data: {
      id: clinicalDocumentId, memberId: canonicalMember.id, kind: "synthetic-clinical", sensitivity: "clinical",
      state: "available", objectKey: "synthetic-clinical-object", checksum: hash("synthetic-clinical-bytes"),
      metadata: { fixture: true }, createdBy: ownerId,
    } });
    const clinicalReview = await successfulCommand(canonicalMember.id, "ClinicalRecordReviewed", {
      status: "verified", evidenceDocumentId: clinicalDocumentId, evidence: { note: "Synthetic eligible clinical review" },
    }, 2);
    assert.equal(clinicalReview.body.result.clinical.memberId, canonicalMember.id,
      "un socio canónico revisado puede recibir una revisión clínica legítima");

    const unreviewedMemberId = `appsheet-member-eligibility-unreviewed-${randomUUID()}`;
    const unreviewedSourceKey = `unreviewed-source-${randomUUID()}`;
    await db.operationMember.create({ data: {
      id: unreviewedMemberId, name: "Imported without identity approval", address: {}, preferences: {},
      sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: unreviewedSourceKey, legacyCustomerId: unreviewedSourceKey,
    } });
    await db.operationObject.create({ data: { id: unreviewedMemberId, kind: "member", version: 0, createdBy: ownerId } });

    const wrongCaptureMemberId = `appsheet-member-eligibility-wrong-capture-${randomUUID()}`;
    const wrongCaptureSourceKey = `wrong-capture-source-${randomUUID()}`;
    await db.operationMember.create({ data: {
      id: wrongCaptureMemberId, name: "Imported with approval for another capture", address: {}, preferences: {},
      sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: wrongCaptureSourceKey, legacyCustomerId: wrongCaptureSourceKey,
    } });
    await db.operationObject.create({ data: { id: wrongCaptureMemberId, kind: "member", version: 0, createdBy: ownerId } });
    const wrongCaptureIdentityId = `synthetic-wrong-capture-identity-${randomUUID()}`;
    const wrongCaptureManifestHash = hash("synthetic-other-capture-manifest");
    const wrongCaptureId = `appsreal-${wrongCaptureManifestHash.slice(0, 16)}`;
    await db.legacyIdentity.create({ data: {
      id: wrongCaptureIdentityId, sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceTable: "C_Cliente",
      sourceKey: wrongCaptureSourceKey, destinationType: "member", destinationId: wrongCaptureMemberId, approvedBy: ownerId,
    } });
    await db.operationAudit.create({ data: {
      actorId: ownerId, action: "appsheet.canonical_identity_reviewed", objectId: wrongCaptureIdentityId,
      requestId: randomUUID(), details: {
        schemaVersion: 1, identityId: wrongCaptureIdentityId, snapshotId: `synthetic-other-snapshot-${randomUUID()}`,
        captureId: wrongCaptureId, manifestHash: wrongCaptureManifestHash, projectionHash: hash("synthetic-other-projection"),
        destinationIdentity, sourceRecordId: `synthetic-other-record-${randomUUID()}`, sourceTable: "C_Cliente",
        sourceKey: wrongCaptureSourceKey, sourceContentHash: hash("synthetic-other-source-row"), destinationType: "member",
        destinationId: wrongCaptureMemberId, destinationDataHash: hash("synthetic-other-destination"), approvedBy: ownerId,
      },
    } });

    const partialProvenanceMemberId = `appsheet-member-eligibility-partial-${randomUUID()}`;
    await db.operationMember.create({ data: {
      id: partialProvenanceMemberId, name: "Imported with partial provenance", address: {}, preferences: {},
      sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: `partial-source-${randomUUID()}`, legacyCustomerId: null,
    } });
    await db.operationObject.create({ data: { id: partialProvenanceMemberId, kind: "member", version: 0, createdBy: ownerId } });

    const expectedRejectedMemberState = new Map([
      [unreviewedMemberId, { name: "Imported without identity approval", sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        sourceId: unreviewedSourceKey, legacyCustomerId: unreviewedSourceKey }],
      [wrongCaptureMemberId, { name: "Imported with approval for another capture", sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        sourceId: wrongCaptureSourceKey, legacyCustomerId: wrongCaptureSourceKey }],
      [partialProvenanceMemberId, { name: "Imported with partial provenance", sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        sourceId: (await db.operationMember.findUniqueOrThrow({ where: { id: partialProvenanceMemberId } })).sourceId, legacyCustomerId: null }],
    ]);
    for (const [memberId, label] of [
      [unreviewedMemberId, "sin aprobación de identidad"],
      [wrongCaptureMemberId, "aprobado sólo para otra captura"],
      [partialProvenanceMemberId, "con procedencia parcial"],
    ] as const) {
      const permissionEvidenceDocumentId = randomUUID();
      const clinicalEvidenceDocumentId = randomUUID();
      await db.operationDocument.createMany({ data: [
        { id: permissionEvidenceDocumentId, memberId, kind: "synthetic-permission", sensitivity: "commercial", state: "available",
          objectKey: `synthetic-permission-${memberId}`, checksum: hash(`permission-${memberId}`), metadata: { fixture: true }, createdBy: ownerId },
        { id: clinicalEvidenceDocumentId, memberId, kind: "synthetic-clinical", sensitivity: "clinical", state: "available",
          objectKey: `synthetic-clinical-${memberId}`, checksum: hash(`clinical-${memberId}`), metadata: { fixture: true }, createdBy: ownerId },
      ] });
      const rejectedPermission = envelope(memberId, "PermissionVerified", {
        kind: "operations", validFrom: permissionDate, validUntil: `${Number(permissionDate.slice(0, 4)) + 1}${permissionDate.slice(4)}`,
        evidenceDocumentId: permissionEvidenceDocumentId,
      });
      const rejectedClinical = envelope(memberId, "ClinicalRecordReviewed", {
        status: "verified", evidenceDocumentId: clinicalEvidenceDocumentId, evidence: { note: `Synthetic rejection: ${label}` },
      });
      await deniedEffects(rejectedPermission, memberId, 0);
      await deniedEffects(rejectedClinical, memberId, 0);
      assert.equal(await db.memberPermission.count({ where: { memberId } }), 0, `${label}: no se crea permiso`);
      assert.equal(await db.memberClinicalRecord.findUnique({ where: { memberId } }), null, `${label}: no se crea ficha clínica`);
      assert.deepEqual(await db.operationMember.findUniqueOrThrow({ where: { id: memberId } }).then(row => ({
        name: row.name, sourceSystem: row.sourceSystem, sourceId: row.sourceId, legacyCustomerId: row.legacyCustomerId,
      })), expectedRejectedMemberState.get(memberId));
    }
    const canonicalOrderId = `appsheet-member-eligibility-reviewed-order-${randomUUID()}`;
    const canonicalOrder = await successfulCommand(canonicalOrderId, "OrderCreated", {
      memberId: canonicalMember.id, channel: "local", currency: "ARS", address: {}, preorder: false,
    });
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: canonicalOrderId } })).memberId, canonicalMember.id);
    assert.ok(await db.commandReceipt.findUnique({ where: { requestId: canonicalOrder.request.requestId } }));

    // The canonical SKU is identity-reviewed but has no AuthorityActivated
    // receipt. Exercise the real write entrypoints and prove fail-closed rejects
    // before either catalogue changes or commercial lines are persisted.
    const skuBefore = await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalSku.id } });
    const skuObjectBefore = await db.operationObject.findUniqueOrThrow({ where: { id: canonicalSku.id } });
    const deniedSkuUpdate = envelope(canonicalSku.id, "CatalogSkuUpdated", {
      code: skuBefore.code, name: skuBefore.name, variety: skuBefore.variety, category: skuBefore.category,
      unit: skuBefore.unit, minQuantity: skuBefore.minQuantity.toString(), minVarieties: skuBefore.minVarieties,
      active: skuBefore.active, evidence: { note: "Synthetic pre-activation denial" },
    });
    const deniedSkuMutation = await call("/operations/commands", deniedSkuUpdate);
    assert.equal(deniedSkuMutation.response.status, 423, JSON.stringify(deniedSkuMutation.body));
    assert.equal(deniedSkuMutation.body.code, "APPSHEET_SKU_NOT_ELIGIBLE");
    assert.deepEqual(await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalSku.id } }), skuBefore);
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: canonicalSku.id } })).version, skuObjectBefore.version);
    assert.equal(await db.commandReceipt.count({ where: { requestId: deniedSkuUpdate.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: deniedSkuUpdate.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: deniedSkuUpdate.requestId } }), 0);

    const deniedQuote = envelope(canonicalOrderId, "OrderQuoted", {
      items: [{ id: `canonical-quote-line-${randomUUID()}`, skuId: canonicalSku.id, quantity: "1", manualUnitPrice: "1",
        manualReason: "Synthetic pre-activation denial" }],
      packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
      promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
    });
    deniedQuote.expectedVersion = 1;
    const deniedCanonicalQuote = await call("/operations/commands", deniedQuote);
    assert.equal(deniedCanonicalQuote.response.status, 423, JSON.stringify(deniedCanonicalQuote.body));
    assert.equal(deniedCanonicalQuote.body.code, "APPSHEET_SKU_NOT_ELIGIBLE");
    assert.equal(await db.operationOrderLine.count({ where: { orderId: canonicalOrderId } }), 0);
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: canonicalOrderId } })).quoteVersion, 1);
    assert.equal(await db.commandReceipt.count({ where: { requestId: deniedQuote.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: deniedQuote.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: deniedQuote.requestId } }), 0);

    // Synthetic activation receipt fixture exercises the full reader binding.
    // It is not evidence that the blocked production gate can activate today.
    const skuFingerprint = destinationFingerprints.find(item => item.destinationType === "sku" && item.destinationId === canonicalSku.id);
    assert.ok(skuFingerprint);
    const activatedSku = await db.catalogSku.update({ where: { id: canonicalSku.id }, data: { active: true } });
    const activatedSkuVersion = await db.operationObject.update({ where: { id: canonicalSku.id }, data: { version: 1 } });
    assert.equal(activatedSkuVersion.version, 1);
    const activatedSnapshot = {
      id: activatedSku.id, code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety,
      category: activatedSku.category, unit: activatedSku.unit, active: activatedSku.active,
      sourceSystem: activatedSku.sourceSystem, sourceId: activatedSku.sourceId, appSheet: activatedSku.appSheet,
    };
    const activationEntry = {
      skuId: canonicalSku.id, sourceKey: canonicalSkuDestination.sourceKey,
      baselineHash: skuFingerprint.dataHash, baselineVersion: skuFingerprint.operationVersion,
      activatedHash: appSheetCanonicalCurrentDestinationHash(activatedSnapshot, "sku"), activatedVersion: 1,
    };
    const activationManifest = {
      schemaVersion: 1, captureId: canonicalCapture.captureId, snapshotId: canonicalProjection.snapshotId,
      projectionHash, destinationIdentity, entries: [activationEntry],
    };
    const authorityRequestId = randomUUID();
    const authorityReplayRequest = envelope("operations", "AuthorityActivated", {
      cutoverProfile: "appsheet-replacement", captureId: canonicalCapture.captureId,
      evidence: { reference: "synthetic AuthorityActivated replay fixture" },
    });
    authorityReplayRequest.requestId = authorityRequestId;
    const authorityResponse = {
      requestId: authorityRequestId, targetId: "operations", version: 1,
      result: { authority: { id: "operations", mode: "active", cutoverProfile: "appsheet-replacement",
        captureManifestId: canonicalCapture.captureId, epoch: 3, approvedBy: ownerId }, appSheetSkuActivation: activationManifest },
    };
    await db.operationObject.upsert({
      where: { id: "operations" },
      create: { id: "operations", kind: "authority", version: 1, createdBy: ownerId },
      update: { kind: "authority", version: 1, createdBy: ownerId },
    });
    await db.commandReceipt.create({ data: {
      requestId: authorityRequestId, actorId: ownerId, targetId: "operations", command: "AuthorityActivated",
      bodyHash: canonicalCommandBodyHash(authorityReplayRequest), response: authorityResponse, resultingVersion: 1,
      authorityEpoch: 2, occurredAt: now,
    } });
    await db.operationAudit.create({ data: {
      actorId: ownerId, action: "AuthorityActivated", objectId: "operations", requestId: authorityRequestId, details: { version: 1 },
    } });
    await db.operationAudit.create({ data: {
      actorId: ownerId, action: "appsheet.canonical_sku_activated", objectId: canonicalSku.id, requestId: authorityRequestId,
      details: {
        schemaVersion: 1, captureId: canonicalCapture.captureId, snapshotId: canonicalProjection.snapshotId,
        projectionHash, destinationIdentity, ...activationEntry, snapshot: activatedSnapshot,
      },
    } });

    // This HTTP path only recovers a synthetic historical receipt. It does not
    // execute a first activation or certify that the real activation gates pass.
    const authorityReplayEffects = async () => ({
      authority: await db.operationAuthority.findUniqueOrThrow({ where: { id: "operations" } }),
      authorityObject: await db.operationObject.findUniqueOrThrow({ where: { id: "operations" } }),
      sku: await db.catalogSku.findUniqueOrThrow({ where: { id: canonicalSku.id } }),
      skuObject: await db.operationObject.findUniqueOrThrow({ where: { id: canonicalSku.id } }),
      receipt: await db.commandReceipt.findUniqueOrThrow({ where: { requestId: authorityRequestId } }),
      audits: await db.operationAudit.count({ where: { requestId: authorityRequestId } }),
      outbox: await db.operationOutbox.count({ where: { requestId: authorityRequestId } }),
    });
    const authorityStateBeforeReplay = await authorityReplayEffects();
    const previousClubApproval = process.env.CLUB_OPERATIONS_APPROVED;
    process.env.CLUB_OPERATIONS_APPROVED = "true";
    try {
      const replayedAuthority = await call("/operations/commands", authorityReplayRequest);
      assert.equal(replayedAuthority.response.status, 200, JSON.stringify(replayedAuthority.body));
      assert.equal(replayedAuthority.body.replay, true, "el HTTP recupera el recibo exacto existente");
      assert.deepEqual(replayedAuthority.body.result, authorityResponse.result);
      assert.deepEqual(await authorityReplayEffects(), authorityStateBeforeReplay, "el replay exacto no agrega efectos");

      const ownerBeforeRevocation = await db.user.findUniqueOrThrow({ where: { id: ownerId } });
      await db.user.update({ where: { id: ownerId }, data: { role: "viewer" } });
      try {
        const unauthorizedReplay = await call("/operations/commands", authorityReplayRequest);
        assert.equal(unauthorizedReplay.response.status, 403, JSON.stringify(unauthorizedReplay.body));
        assert.equal(unauthorizedReplay.body.code, "CAPABILITY_REQUIRED");
        assert.equal(unauthorizedReplay.body.replay, undefined, "la falta de permiso actual no revela el recibo");
        assert.deepEqual(await authorityReplayEffects(), authorityStateBeforeReplay, "el rechazo por capability no escribe estado");
      } finally {
        await db.user.update({ where: { id: ownerId }, data: { role: ownerBeforeRevocation.role } });
      }

      const changedAuthorityRequest = structuredClone(authorityReplayRequest);
      changedAuthorityRequest.data.evidence = { reference: "changed body under the same request ID" };
      assert.notEqual(canonicalCommandBodyHash(changedAuthorityRequest), canonicalCommandBodyHash(authorityReplayRequest));
      const changedBodyReplay = await call("/operations/commands", changedAuthorityRequest);
      assert.equal(changedBodyReplay.response.status, 409, JSON.stringify(changedBodyReplay.body));
      assert.equal(changedBodyReplay.body.code, "IDEMPOTENCY_KEY_REUSED");
      assert.equal(changedBodyReplay.body.result, undefined, "el rechazo no revela el recibo previo");
      assert.deepEqual(await authorityReplayEffects(), authorityStateBeforeReplay, "el UUID reutilizado con otro body no escribe");
    } finally {
      if (previousClubApproval === undefined) delete process.env.CLUB_OPERATIONS_APPROVED;
      else process.env.CLUB_OPERATIONS_APPROVED = previousClubApproval;
    }

    const approvedSkuUpdate = envelope(canonicalSku.id, "CatalogSkuUpdated", {
      code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety, category: activatedSku.category,
      unit: activatedSku.unit, minQuantity: activatedSku.minQuantity.toString(), minVarieties: activatedSku.minVarieties,
      active: true, evidence: { note: "Synthetic post-activation chain" },
    });
    approvedSkuUpdate.expectedVersion = 1;
    const allowedSkuMutation = await call("/operations/commands", approvedSkuUpdate);
    assert.equal(allowedSkuMutation.response.status, 200, JSON.stringify(allowedSkuMutation.body));
    const cataloguePatch = envelope(canonicalSku.id, "CatalogueSheetSaved", { patch: { availability: "Sí" } });
    cataloguePatch.expectedVersion = 2;
    const allowedCatalogueMutation = await call("/operations/commands", cataloguePatch);
    assert.equal(allowedCatalogueMutation.response.status, 200, JSON.stringify(allowedCatalogueMutation.body));
    const deactivation = envelope(canonicalSku.id, "CatalogSkuUpdated", {
      code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety, category: activatedSku.category,
      unit: activatedSku.unit, minQuantity: activatedSku.minQuantity.toString(), minVarieties: activatedSku.minVarieties,
      active: false, evidence: { note: "Synthetic reversible availability change" },
    });
    deactivation.expectedVersion = 3;
    assert.equal((await call("/operations/commands", deactivation)).response.status, 200);
    const reactivation = envelope(canonicalSku.id, "CatalogSkuUpdated", {
      code: activatedSku.code, name: activatedSku.name, variety: activatedSku.variety, category: activatedSku.category,
      unit: activatedSku.unit, minQuantity: activatedSku.minQuantity.toString(), minVarieties: activatedSku.minVarieties,
      active: true, evidence: { note: "Synthetic SKU reactivation" },
    });
    reactivation.expectedVersion = 4;
    assert.equal((await call("/operations/commands", reactivation)).response.status, 200);

    const positiveQuote = envelope(canonicalOrderId, "OrderQuoted", {
      items: [{ id: `canonical-eligible-line-${randomUUID()}`, skuId: canonicalSku.id, quantity: "1", manualUnitPrice: "1",
        manualReason: "Synthetic reviewed SKU" }],
      packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
      promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
    });
    positiveQuote.expectedVersion = 1;
    const quotedEligibleSku = await call("/operations/commands", positiveQuote);
    assert.equal(quotedEligibleSku.response.status, 200, JSON.stringify(quotedEligibleSku.body));
    const quotedLinesBeforeTamper = await db.operationOrderLine.findMany({ where: { orderId: canonicalOrderId }, select: { id: true, skuId: true } });

    // A malformed parent receipt invalidates the same SKU before a second quote
    // can replace persisted lines or emit a receipt/audit/outbox row.
    const tamperedAuthorityResponse = structuredClone(authorityResponse);
    tamperedAuthorityResponse.result.appSheetSkuActivation.captureId = "appsreal-0000000000000000";
    await db.commandReceipt.update({ where: { requestId: authorityRequestId }, data: { response: tamperedAuthorityResponse } });
    const deniedTamperedQuote = envelope(canonicalOrderId, "OrderQuoted", {
      items: [{ id: `tampered-parent-line-${randomUUID()}`, skuId: canonicalSku.id, quantity: "1", manualUnitPrice: "1",
        manualReason: "Synthetic parent receipt denial" }],
      packs: [], currency: "ARS", paymentMethod: "cash", deliveryMinor: "0", bonusDiscountMinor: "0",
      promotionEligibilityEvidence: {}, deliveryPolicyEvidence: {},
    });
    deniedTamperedQuote.expectedVersion = 2;
    const deniedTamperedParent = await call("/operations/commands", deniedTamperedQuote);
    assert.equal(deniedTamperedParent.response.status, 423, JSON.stringify(deniedTamperedParent.body));
    assert.equal(deniedTamperedParent.body.code, "APPSHEET_SKU_NOT_ELIGIBLE");
    assert.deepEqual(await db.operationOrderLine.findMany({ where: { orderId: canonicalOrderId }, select: { id: true, skuId: true } }), quotedLinesBeforeTamper);
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: canonicalOrderId } })).quoteVersion, 2);
    assert.equal(await db.commandReceipt.count({ where: { requestId: deniedTamperedQuote.requestId } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: deniedTamperedQuote.requestId } }), 0);
    assert.equal(await db.operationOutbox.count({ where: { requestId: deniedTamperedQuote.requestId } }), 0);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
