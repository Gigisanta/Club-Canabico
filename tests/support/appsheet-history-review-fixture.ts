import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/operations/exact.js";
import {
  APPSHEET_DEFINITION_SCHEMA_VERSION,
  appSheetDefinitionInventorySchema,
  type AppSheetDefinitionInventory,
} from "../../shared/operations/appsheet-definition.js";
import {
  APPSHEET_HISTORY_IMPORTER_VERSION,
  APPSHEET_HISTORY_MAPPING_ID,
  APPSHEET_HISTORY_SOURCE_SYSTEM,
} from "../../shared/operations/appsheet-history.js";
import { appSheetAppliedDefinitionHash, APPSHEET_EXPECTED_LIVE_APP_ID } from "../../server/operations/appsheet-canonical.js";
import type { Tx } from "../../server/operations/core.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const STAGE_AUDIT_ACTION = "legacy.appsheet_history_staged";
const REVIEW_AUDIT_ACTION = "legacy.appsheet_history_source_reviewed";
export const APP_SHEET_HISTORY_REVIEW_TEST_DATABASE_URL = "postgresql://review:review@127.0.0.1:5432/bombo_test";

export async function withAppSheetHistoryReviewTestEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.DATABASE_URL = APP_SHEET_HISTORY_REVIEW_TEST_DATABASE_URL;
  process.env.NODE_ENV = "test";
  try { return await run(); }
  finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

function definitionInventory(): AppSheetDefinitionInventory {
  const inventory = {
    schemaVersion: APPSHEET_DEFINITION_SCHEMA_VERSION,
    parserVersion: "bombo-appsheet-definition/1.2.0",
    source: { sha256: sha256("definition-source"), byteLength: 1, encoding: "utf-8" as const },
    app: { id: APPSHEET_EXPECTED_LIVE_APP_ID, name: "Synthetic fixture", version: null, deploymentState: null,
      generatedAt: null, identity: { method: "app-document-header" as const, evidenceId: "fixture", evidenceIds: [],
        sourcePathReferenceCount: 0, candidateCount: 1 } },
    declaredCounts: {}, observedCounts: {}, descriptorSha256: "0".repeat(64), coverage: [], sections: [], evidence: [],
    redactedFieldCount: 0, warnings: [],
  };
  inventory.descriptorSha256 = sha256(canonicalJson({ ...inventory, descriptorSha256: "" }));
  return appSheetDefinitionInventorySchema.parse(inventory);
}

/** Reusable synthetic stage/capture/audit/count evidence for source-history guard tests. */
export function createAppSheetHistoryReviewFixture(input: {
  snapshotId: string;
  captureId: string;
  manifestHash: string;
  dataHash: string;
  projectionHash: string;
  destinationIdentity: string;
  snapshotCreatedBy: string;
  stageActorUserId: string;
  technicalReviewer: string;
  sourceReviewer: string;
  reviewedAt?: Date;
}) {
  const reviewedAt = input.reviewedAt ?? new Date("2026-10-10T00:00:00.000Z");
  const times = {
    firstReadAt: "2026-10-09T10:00:00.000Z",
    verificationStartedAt: "2026-10-09T10:01:00.000Z",
    verificationCompletedAt: "2026-10-09T10:02:00.000Z",
    cutoffAt: "2026-10-09T10:03:00.000Z",
  };
  const inventory = definitionInventory();
  const appliedDefinitionHash = appSheetAppliedDefinitionHash(inventory);
  const pageHash = sha256("synthetic-history-page");
  const page = { sheetId: 1, title: "C_Facturacion", pageIndex: 0, startRow: 2, endRow: 2,
    pageHash, verifiedPageHash: pageHash, stable: true };
  const stability = { stable: true, metadataStable: true, headersStable: true, pageHashesStable: true,
    scanComplete: true, sourceWriteDetected: false, changedPages: 0, failedPages: 0, missingPages: 0,
    unresolvedFormulaCount: 0, firstPassPages: 1, verifiedPages: 1, matchedPages: 1 };
  const metrics = { recordCount: 1, factCount: 1, exceptionCount: 0, reviewExceptionCount: 0,
    blockingExceptionCount: 0, archiveOnlyRecordCount: 0, overlapEvidenceRecordCount: 0,
    tableCounts: { C_Facturacion: 1 }, kindCounts: { invoice: 1 }, severityCounts: {}, pendingStatusCounts: {},
    movementOverlap: {}, globalDeltaBlockingCount: 0, formulaCount: 0, unresolvedFormulaCount: 0 };
  const sourceSheet = { sheetId: 1, title: "C_Facturacion", pageCount: 1, verifiedPageCount: 1,
    stablePageCount: 1, changedPageCount: 0, bodyRead: true, bodyExcluded: false };
  const coverageSheet = { sourceTable: "C_Facturacion", sheetId: 1, hidden: false, mode: "grid", bodyExcluded: false,
    headerRow: 1, pageCount: 1, populatedSourceRows: 1, sourceRecordCount: 1, factCount: 1,
    archiveOnlyCount: 0, overlapEvidenceCount: 0, blockingExceptionCount: 0, reviewExceptionCount: 0,
    formulaCount: 0, sourceRecordFormulaCount: 0, headerFormulaCount: 0, unresolvedFormulaCount: 0,
    sourceRecordUnresolvedFormulaCount: 0, headerUnresolvedFormulaCount: 0, changedPageIndexes: [], definitionTableMatch: "unique" };
  const capture = {
    captureId: input.captureId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceId: "synthetic-spreadsheet",
    spreadsheetId: "synthetic-spreadsheet", metadataHash: sha256("metadata"), headersHash: sha256("headers"),
    manifestHash: input.manifestHash, dataHash: input.dataHash, definitionHash: null, stability,
    firstReadAt: new Date(times.firstReadAt), verificationStartedAt: new Date(times.verificationStartedAt),
    verificationCompletedAt: new Date(times.verificationCompletedAt), cutoffAt: new Date(times.cutoffAt),
    dataCoverage: { metadataStable: true, headersStableAll: true, failedPages: 0, changedPages: 0,
      unresolvedFormulaCount: 0, formulaCellCount: 0, totalPages: 1, bodySheetsCaptured: 1, sheets: [sourceSheet] },
    pageManifest: [{ path: "pages/1-0-2.json", ...page,
      counts: { rowsSerialized: 1, formulaCellCount: 0, unresolvedFormulaCount: 0 } }],
    dataSheetCount: 1, dataPageCount: 1, dataRecordCount: 1, dataFormulaCount: 0, dataUnresolvedFormulaCount: 0,
  };
  const coverage = {
    schemaVersion: "appsheet-history-coverage/v1", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    captureId: input.captureId, manifestHash: input.manifestHash, dataHash: input.dataHash,
    captureDefinitionHash: null, appliedDefinitionHash, mode: "stable", window: { ...times, timestampGaps: [] }, stability,
    source: { spreadsheetId: "synthetic-spreadsheet", metadataHash: capture.metadataHash, headersHash: capture.headersHash,
      dataSheetCount: 1, dataPageCount: 1, dataRecordCount: 1, dataFormulaCount: 0, dataUnresolvedFormulaCount: 0,
      sourceRecordFormulaCount: 0, sourceRecordUnresolvedFormulaCount: 0, headerFormulaCount: 0, headerUnresolvedFormulaCount: 0 },
    definition: { fileSha256: sha256("definition-file"), sourceSha256: inventory.source.sha256,
      descriptorSha256: inventory.descriptorSha256, appliedDefinitionHash, identityState: "verified",
      counts: inventory.observedCounts, inventory },
    sheets: [coverageSheet], pages: [page], deltaEvidence: [], totals: metrics, exceptionTotal: 0,
  };
  const technicalReview = { schemaVersion: 2, reviewKind: "independent-technical", reviewer: input.technicalReviewer,
    reviewedAt: "2026-10-09T10:04:00.000Z", approved: true, bindingSource: "explicit-target-and-destination",
    findingsCount: 0, findingsHash: sha256("[]"), commitSha: "f".repeat(40) };
  const stage = {
    schemaVersion: "appsheet-history-stage/v2", projectionKind: "history", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    mappingId: APPSHEET_HISTORY_MAPPING_ID, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    captureId: input.captureId, manifestHash: input.manifestHash, dataHash: input.dataHash, captureDefinitionHash: null,
    definitionHash: appliedDefinitionHash, definitionSourceSha256: inventory.source.sha256,
    definitionDescriptorSha256: inventory.descriptorSha256, definitionFileSha256: coverage.definition.fileSha256,
    definitionIdentityState: "verified", definitionInventory: inventory, mode: "stable", projectionHash: input.projectionHash,
    recordsHash: sha256("records"), factsHash: sha256("facts"), exceptionsHash: sha256("exceptions"), technicalReview,
    destination: { target: "isolated-test", identity: input.destinationIdentity }, humanReview: { status: "pending" },
    operationalAuthority: { status: "unchanged" }, backupManifestHash: sha256("backup"),
    backupSnapshotAt: "2026-10-09T09:00:00.000Z", actorUserId: input.stageActorUserId,
    authorizationContext: "user-authorized-plan", reviewedBy: null, reviewedAt: null, status: "staged",
    effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false, documents: false,
      numbering: "not-generated" }, metrics,
  };
  const snapshot = { id: input.snapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, filename: "synthetic-capture",
    fileHash: input.manifestHash, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, status: "reviewed",
    createdBy: input.snapshotCreatedBy, reviewedBy: input.sourceReviewer, reviewedAt,
    captureManifestId: input.captureId, controls: { appSheetHistoryStage: stage }, coverage };
  const stageAudit = { id: "history-stage-audit", actorId: input.stageActorUserId, objectId: input.snapshotId, requestId: null,
    createdAt: new Date("2026-10-09T10:05:00.000Z"), details: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      captureId: input.captureId, manifestHash: input.manifestHash, dataHash: input.dataHash,
      projectionHash: input.projectionHash, mode: "stable", recordCount: 1, factCount: 1, exceptionCount: 0,
      reviewer: input.technicalReviewer, technicalReviewAt: technicalReview.reviewedAt, commitSha: technicalReview.commitSha,
      target: "isolated-test", destinationIdentity: input.destinationIdentity,
      backupManifestHash: stage.backupManifestHash, backupSnapshotAt: stage.backupSnapshotAt,
      authorizationContext: "user-authorized-plan", reviewedBy: null, status: "staged",
    } };
  const reviewAudit = { id: "history-source-review-audit", actorId: input.sourceReviewer, objectId: input.snapshotId,
    requestId: "synthetic-source-review-request", createdAt: reviewedAt, details: {
      schemaVersion: 1, snapshotId: input.snapshotId, captureId: input.captureId, manifestHash: input.manifestHash,
      dataHash: input.dataHash, projectionHash: input.projectionHash, target: "isolated-test",
      destinationIdentity: input.destinationIdentity, stagingAuditId: stageAudit.id,
      evidenceReference: "Synthetic independent source review", reviewer: input.sourceReviewer,
      reviewedAt: reviewedAt.toISOString(), counts: { recordCount: 1, factCount: 1, exceptionCount: 0 },
      effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false,
        documents: false, numbering: "not-generated", masterActivation: false, historyPublication: false },
    } };
  const tx = {
    legacyImportSnapshot: { findUnique: async () => structuredClone(snapshot) },
    appSheetCaptureManifest: { findUnique: async () => structuredClone(capture) },
    operationAudit: { findMany: async ({ where }: { where: { action?: string } }) =>
      where.action === STAGE_AUDIT_ACTION ? [stageAudit] : where.action === REVIEW_AUDIT_ACTION ? [reviewAudit] : [] },
    legacySourceRecord: {
      count: async ({ where }: { where?: { OR?: unknown[] } }) => where?.OR ? 0 : 1,
      groupBy: async () => [{ sourceTable: "C_Facturacion", _count: { _all: 1 } }],
    },
    legacyHistoricalFact: {
      count: async ({ where }: { where?: { mappingId?: unknown } }) => where?.mappingId ? 0 : 1,
      groupBy: async () => [{ sourceTable: "C_Facturacion", _count: { _all: 1 } }],
    },
    legacyException: { count: async () => 0, groupBy: async () => [] },
  } as unknown as Tx;
  return { snapshot, capture, stage, stageAudit, reviewAudit, metrics, destinationIdentity: input.destinationIdentity, tx };
}
