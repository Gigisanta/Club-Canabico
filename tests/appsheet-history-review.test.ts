import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "../shared/operations/exact.js";
import { APPSHEET_DEFINITION_SCHEMA_VERSION, type AppSheetDefinitionInventory } from "../shared/operations/appsheet-definition.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_MAPPING_ID, APPSHEET_HISTORY_SOURCE_SYSTEM } from "../shared/operations/appsheet-history.js";
import { commandSpecs, OperationError, type CommandContext, type Tx } from "../server/operations/core.js";
import { appSheetAppliedDefinitionHash, APPSHEET_EXPECTED_LIVE_APP_ID } from "../server/operations/appsheet-canonical.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { requireBoundAppSheetHistoryStage } from "../server/operations/appsheet-history-review.js";
import "../server/operations/legacy-import.js";
import "../server/operations/routes.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hash = (value: string) => sha256(value);
const captureHash = "a".repeat(64);
const dataHash = "b".repeat(64);
const metadataHash = "c".repeat(64);
const headersHash = "d".repeat(64);
const recordHash = "e".repeat(64);
const technicalFindingsHash = sha256("[]");
const snapshotId = "00000000-0000-5000-8000-000000000001";
const captureId = `appsreal-${captureHash.slice(0, 16)}`;
const destinationUrl = "postgresql://review:review@127.0.0.1:5432/bombo_test";
const destinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test", new URL(destinationUrl));
const timestamps = {
  firstReadAt: "2026-10-09T10:00:00.000Z",
  verificationStartedAt: "2026-10-09T10:01:00.000Z",
  verificationCompletedAt: "2026-10-09T10:02:00.000Z",
  cutoffAt: "2026-10-09T10:03:00.000Z",
};
const page = { sheetId: 1, title: "C_Facturacion", pageIndex: 0, startRow: 2, endRow: 2,
  pageHash: hash("page"), verifiedPageHash: hash("page"), stable: true };
const stability = { stable: true, metadataStable: true, headersStable: true, pageHashesStable: true, scanComplete: true,
  sourceWriteDetected: false, changedPages: 0, failedPages: 0, missingPages: 0, unresolvedFormulaCount: 0,
  firstPassPages: 1, verifiedPages: 1, matchedPages: 1 };
const dataCoverage = { metadataStable: true, headersStableAll: true, failedPages: 0, changedPages: 0,
  unresolvedFormulaCount: 0, formulaCellCount: 0, totalPages: 1, bodySheetsCaptured: 1,
  sheets: [{ sheetId: 1, title: "C_Facturacion", pageCount: 1, verifiedPageCount: 1, stablePageCount: 1,
    changedPageCount: 0, bodyRead: true, bodyExcluded: false }] };

function definitionInventory(): AppSheetDefinitionInventory {
  const inventory = {
    schemaVersion: APPSHEET_DEFINITION_SCHEMA_VERSION,
    parserVersion: "bombo-appsheet-definition/1.2.0",
    source: { sha256: hash("definition-source"), byteLength: 1, encoding: "utf-8" as const },
    app: { id: APPSHEET_EXPECTED_LIVE_APP_ID, name: "Fixture", version: null, deploymentState: null, generatedAt: null,
      identity: { method: "app-document-header" as const, evidenceId: "fixture-evidence", evidenceIds: [], sourcePathReferenceCount: 0, candidateCount: 1 } },
    declaredCounts: {}, observedCounts: {}, descriptorSha256: "0".repeat(64), coverage: [], sections: [], evidence: [],
    redactedFieldCount: 0, warnings: [],
  };
  inventory.descriptorSha256 = sha256(canonicalJson({ ...inventory, descriptorSha256: "" }));
  return inventory;
}

function fixture() {
  const inventory = definitionInventory();
  const appliedDefinitionHash = appSheetAppliedDefinitionHash(inventory);
  const metrics = {
    recordCount: 1, factCount: 1, exceptionCount: 0, reviewExceptionCount: 0, blockingExceptionCount: 0,
    archiveOnlyRecordCount: 0, overlapEvidenceRecordCount: 0,
    tableCounts: { C_Facturacion: 1 }, kindCounts: { invoice: 1 }, severityCounts: {}, pendingStatusCounts: {},
    movementOverlap: {}, globalDeltaBlockingCount: 0, formulaCount: 0, unresolvedFormulaCount: 0,
  };
  const sourceSheet = { sheetId: 1, title: "C_Facturacion", pageCount: 1, verifiedPageCount: 1,
    stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false };
  const coverageSheet = { sourceTable: "C_Facturacion", sheetId: 1, hidden: false, mode: "grid", bodyExcluded: false,
    headerRow: 1, pageCount: 1, populatedSourceRows: 1, sourceRecordCount: 1, factCount: 1,
    archiveOnlyCount: 0, overlapEvidenceCount: 0, blockingExceptionCount: 0, reviewExceptionCount: 0,
    formulaCount: 0, sourceRecordFormulaCount: 0, headerFormulaCount: 0, unresolvedFormulaCount: 0,
    sourceRecordUnresolvedFormulaCount: 0, headerUnresolvedFormulaCount: 0, changedPageIndexes: [], definitionTableMatch: "unique" };
  const capture = {
    captureId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceId: "sheet-fixture", spreadsheetId: "sheet-fixture",
    metadataHash, headersHash, manifestHash: captureHash, dataHash, definitionHash: null,
    stability, ...Object.fromEntries(Object.entries(timestamps).map(([key, value]) => [key, new Date(value)])),
    dataCoverage, pageManifest: [{ path: "pages/1-0-2.json", ...page, counts: { rowsSerialized: 1, formulaCellCount: 0, unresolvedFormulaCount: 0 } }],
    dataSheetCount: 1, dataPageCount: 1, dataRecordCount: 1, dataFormulaCount: 0, dataUnresolvedFormulaCount: 0,
  };
  const coverage = {
    schemaVersion: "appsheet-history-coverage/v1", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    captureId, manifestHash: captureHash, dataHash, captureDefinitionHash: null, appliedDefinitionHash,
    mode: "stable", window: { ...timestamps, timestampGaps: [] }, stability,
    source: { spreadsheetId: "sheet-fixture", metadataHash, headersHash, dataSheetCount: 1, dataPageCount: 1,
      dataRecordCount: 1, dataFormulaCount: 0, dataUnresolvedFormulaCount: 0, sourceRecordFormulaCount: 0,
      sourceRecordUnresolvedFormulaCount: 0, headerFormulaCount: 0, headerUnresolvedFormulaCount: 0 },
    definition: { fileSha256: hash("definition-file"), sourceSha256: inventory.source.sha256,
      descriptorSha256: inventory.descriptorSha256, appliedDefinitionHash, identityState: "verified",
      counts: inventory.observedCounts, inventory },
    sheets: [coverageSheet], pages: [page], deltaEvidence: [], totals: metrics, exceptionTotal: 0,
  };
  const technicalReview = { schemaVersion: 2, reviewKind: "independent-technical", reviewer: "technical-reviewer",
    reviewedAt: "2026-10-09T10:04:00.000Z", approved: true, bindingSource: "explicit-target-and-destination",
    findingsCount: 0, findingsHash: technicalFindingsHash, commitSha: "f".repeat(40) };
  const stage = {
    schemaVersion: "appsheet-history-stage/v2", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    mappingId: APPSHEET_HISTORY_MAPPING_ID, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, captureId,
    manifestHash: captureHash, dataHash, captureDefinitionHash: null, definitionHash: appliedDefinitionHash,
    definitionSourceSha256: inventory.source.sha256, definitionDescriptorSha256: inventory.descriptorSha256,
    definitionFileSha256: coverage.definition.fileSha256, definitionIdentityState: "verified", definitionInventory: inventory,
    mode: "stable", projectionHash: hash("projection"), recordsHash: hash("records"), factsHash: hash("facts"),
    exceptionsHash: hash("exceptions"), technicalReview, destination: { target: "isolated-test", identity: destinationIdentity },
    humanReview: { status: "pending" }, operationalAuthority: { status: "unchanged" },
    backupManifestHash: hash("backup"), backupSnapshotAt: "2026-10-09T09:00:00.000Z", actorUserId: "uploader-1",
    authorizationContext: "user-authorized-plan", reviewedBy: null, reviewedAt: null, status: "staged",
    effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false, documents: false, numbering: "not-generated" },
    metrics,
  };
  const snapshot = { id: snapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, filename: "appsheet-live-capture",
    fileHash: captureHash, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, status: "staged", createdBy: "uploader-1",
    reviewedBy: null as string | null, reviewedAt: null as Date | null, captureManifestId: captureId,
    controls: { appSheetHistoryStage: stage }, coverage };
  const stageAudit = { id: "stage-audit-1", actorId: "uploader-1", requestId: null,
    createdAt: new Date("2026-10-09T10:05:00.000Z"), details: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      captureId, manifestHash: captureHash, dataHash, projectionHash: stage.projectionHash, mode: "stable",
      recordCount: 1, factCount: 1, exceptionCount: 0, reviewer: technicalReview.reviewer,
      technicalReviewAt: technicalReview.reviewedAt, commitSha: technicalReview.commitSha, target: "isolated-test",
      destinationIdentity, backupManifestHash: stage.backupManifestHash, backupSnapshotAt: stage.backupSnapshotAt,
      authorizationContext: "user-authorized-plan", reviewedBy: null, status: "staged",
    } };
  const reviewAudits: Array<{ id: string; actorId: string; objectId: string; requestId: string | null; createdAt: Date; details: unknown }> = [];
  const writes: Array<{ kind: string; data: unknown }> = [];
  const tx = {
    legacyImportSnapshot: {
      findUnique: async () => structuredClone(snapshot),
      updateMany: async (args: { data: unknown }) => { writes.push({ kind: "snapshot", data: args.data }); snapshot.status = "reviewed"; snapshot.reviewedBy = "reviewer-1"; snapshot.reviewedAt = new Date("2026-10-10T00:00:00.000Z"); return { count: 1 }; },
    },
    appSheetCaptureManifest: { findUnique: async () => structuredClone(capture) },
    operationAudit: {
      findMany: async (args: { where?: { action?: string } }) => args.where?.action === "legacy.appsheet_history_source_reviewed" ? reviewAudits : [stageAudit],
      create: async (args: { data: unknown }) => {
        writes.push({ kind: "audit", data: args.data });
        const data = args.data as { actorId: string; action: string; objectId: string; requestId: string | null; createdAt: Date; details: unknown };
        if (data.action === "legacy.appsheet_history_source_reviewed") reviewAudits.push({ id: "review-audit-1", ...data });
        return args.data;
      },
    },
    commandReceipt: { findUnique: async () => null },
    legacySourceRecord: {
      count: async (args: { where?: { OR?: unknown[] } }) => args.where?.OR ? 0 : 1,
      groupBy: async () => [{ sourceTable: "C_Facturacion", _count: { _all: 1 } }],
    },
    legacyHistoricalFact: {
      count: async (args: { where?: { mappingId?: unknown } }) => args.where?.mappingId ? 0 : 1,
      groupBy: async () => [{ sourceTable: "C_Facturacion", _count: { _all: 1 } }],
    },
    legacyException: { count: async () => 0, groupBy: async () => [] },
    user: { findUnique: async () => ({ id: "reviewer-1", role: "owner", active: true, authorizationEpoch: 1 }) },
    operationAccess: { findUnique: async () => ({ enabled: true, profile: "owner", capabilities: ["imports.review"], scope: {} }) },
  } as unknown as Tx;
  return { snapshot, stage, capture, stageAudit, reviewAudits, writes, tx };
}

function context(tx: Tx, overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    tx,
    actor: { id: "reviewer-1", role: "owner", active: true, authorizationEpoch: 1 } as CommandContext["actor"],
    envelope: { schemaVersion: 1, requestId: randomUUID(), targetId: snapshotId, expectedVersion: 0,
      occurredAt: "2026-10-10T00:00:00.000Z", command: "AppSheetHistorySourceReviewed",
      data: { fileHash: captureHash, captureId, dataHash, projectionHash: hash("projection"),
        evidenceReference: "Acta de contraste con la captura estable" } },
    now: new Date("2026-10-10T00:00:00.000Z"), authorityEpoch: 1,
    ...overrides,
  };
}

test("registered AppSheet history source review independently reviews only a fully bound stable capture", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.DATABASE_URL = destinationUrl;
  process.env.NODE_ENV = "test";
  try {
    const spec = commandSpecs.get("AppSheetHistorySourceReviewed");
    assert.ok(spec, "routes.ts registers the dedicated command through its normal module loading path");
    const state = fixture();
    const ctx = context(state.tx);
    ctx.envelope.data = spec.schema.parse(ctx.envelope.data);
    const authorize = spec.authorize;
    assert.ok(authorize);
    await authorize(ctx);
    const result = await spec.execute(ctx);
    assert.equal(result.status, "reviewed");
    assert.deepEqual(state.writes.filter(write => write.kind === "snapshot")[0]?.data,
      { status: "reviewed", reviewedBy: "reviewer-1", reviewedAt: ctx.now },
      "source review changes only the snapshot's human review status fields");
    const reviewAudit = state.writes.find(write => write.kind === "audit")?.data as { details?: Record<string, unknown> };
    assert.equal(reviewAudit.details?.projectionHash, state.stage.projectionHash);
    assert.deepEqual(reviewAudit.details?.effects, {
      stock: false, cashLedger: false, payments: false, deliveries: false, messages: false,
      documents: false, numbering: "not-generated", masterActivation: false, historyPublication: false,
    });
    const reviewedProof = await requireBoundAppSheetHistoryStage(state.tx, snapshotId,
      { target: "isolated-test", requireReviewed: true });
    assert.equal(reviewedProof.snapshot.reviewedBy, "reviewer-1");
    assert.equal(reviewedProof.audit.id, "stage-audit-1");
    const newRequest = context(state.tx);
    newRequest.envelope.data = spec.schema.parse(newRequest.envelope.data);
    await assert.rejects(authorize(newRequest), error => error instanceof OperationError && error.code === "IMPORT_NOT_REVIEWABLE",
      "a new request cannot reuse a completed source review");
    assert.equal(state.reviewAudits.length, 1);
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("AppSheet history review rejects tampered stage audit, changed content, and self-review before snapshot writes", async t => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.DATABASE_URL = destinationUrl;
  process.env.NODE_ENV = "test";
  try {
    const spec = commandSpecs.get("AppSheetHistorySourceReviewed");
    assert.ok(spec);
    await t.test("audit projection mismatch", async () => {
      const state = fixture();
      (state.stageAudit.details as Record<string, unknown>).projectionHash = hash("other projection");
      const ctx = context(state.tx);
      ctx.envelope.data = spec.schema.parse(ctx.envelope.data);
      assert.ok(spec.authorize);
      await assert.rejects(spec.authorize(ctx), error => error instanceof OperationError && error.code === "APPSHEET_HISTORY_REVIEW_NOT_READY");
      assert.deepEqual(state.writes, []);
    });
    await t.test("changed snapshot content", async () => {
      const state = fixture();
      const ctx = context(state.tx);
      ctx.envelope.data = spec.schema.parse({ fileHash: hash("different file"), captureId, dataHash,
        projectionHash: hash("projection"), evidenceReference: "Acta de contraste" });
      assert.ok(spec.authorize);
      await assert.rejects(spec.authorize(ctx), error => error instanceof OperationError && error.code === "IMPORT_CONTENT_CHANGED");
      assert.deepEqual(state.writes, []);
    });
    await t.test("projection binding changed", async () => {
      const state = fixture();
      const ctx = context(state.tx);
      ctx.envelope.data = spec.schema.parse({ fileHash: captureHash, captureId, dataHash,
        projectionHash: hash("other projection"), evidenceReference: "Acta de contraste" });
      assert.ok(spec.authorize);
      await assert.rejects(spec.authorize(ctx), error => error instanceof OperationError && error.code === "APPSHEET_HISTORY_REVIEW_BINDING_CHANGED");
      assert.deepEqual(state.writes, []);
    });
    await t.test("uploader cannot review own source", async () => {
      const state = fixture();
      const ctx = context(state.tx, { actor: { id: "uploader-1", role: "owner", active: true, authorizationEpoch: 1 } as CommandContext["actor"] });
      ctx.envelope.data = spec.schema.parse(ctx.envelope.data);
      assert.ok(spec.authorize);
      await assert.rejects(spec.authorize(ctx), error => error instanceof OperationError && error.code === "INDEPENDENT_REVIEW_REQUIRED");
      assert.deepEqual(state.writes, []);
    });
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("reviewed history proof requires the immutable review audit and current independent reviewer grant", async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.DATABASE_URL = destinationUrl;
  process.env.NODE_ENV = "test";
  try {
    const state = fixture();
    const spec = commandSpecs.get("AppSheetHistorySourceReviewed");
    assert.ok(spec);
    const ctx = context(state.tx);
    ctx.envelope.data = spec.schema.parse(ctx.envelope.data);
    assert.ok(spec.authorize);
    await spec.authorize(ctx);
    await spec.execute(ctx);
    assert.equal(state.reviewAudits.length, 1);
    (state.reviewAudits[0]!.details as Record<string, unknown>).projectionHash = hash("tampered projection");
    await assert.rejects(requireBoundAppSheetHistoryStage(state.tx, snapshotId,
      { target: "isolated-test", requireReviewed: true }), error =>
      error instanceof OperationError && error.code === "APPSHEET_HISTORY_REVIEW_NOT_READY");
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("generic legacy review remains blocked for AppSheet's technical history source", async () => {
  const legacyReview = commandSpecs.get("LegacySnapshotReviewed");
  assert.ok(legacyReview);
  const state = fixture();
  const ctx = context(state.tx, { envelope: { schemaVersion: 1, requestId: randomUUID(), targetId: snapshotId,
    expectedVersion: 0, occurredAt: "2026-10-10T00:00:00.000Z", command: "LegacySnapshotReviewed",
    data: { fileHash: captureHash, changedContentReviewed: false, evidence: { reference: "review" } } } });
  ctx.envelope.data = legacyReview.schema.parse(ctx.envelope.data);
  await assert.rejects(legacyReview.execute(ctx), error => error instanceof OperationError && error.code === "LEGACY_TECHNICAL_SOURCE_BLOCKED");
  assert.deepEqual(state.writes, []);
});
