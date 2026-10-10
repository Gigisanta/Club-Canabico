import { z } from "zod";
import {
  APPSHEET_HISTORY_IMPORTER_VERSION,
  APPSHEET_HISTORY_MAPPING_ID,
  APPSHEET_HISTORY_SOURCE_SYSTEM,
  APPSHEET_HISTORY_STAGE_SCHEMA_VERSION_V2,
  appSheetHistoryStageHasBoundTechnicalReview,
} from "../../shared/operations/appsheet-history.js";
import { appSheetDefinitionInventorySchema } from "../../shared/operations/appsheet-definition.js";
import { APPSHEET_EXPECTED_LIVE_APP_ID } from "./appsheet-canonical.js";
import { appSheetDatabaseDestinationIdentity } from "./appsheet-database-target.js";
import { containsRecognizableCredential } from "./legacy-reader.js";
import { canonicalCommandBodyHash } from "./canonical.js";
import {
  OperationError,
  requireCapability,
  requireFullLegacySourceScope,
  registerCommand,
  type CommandContext,
  type Tx,
} from "./core.js";

const STAGE_AUDIT_ACTION = "legacy.appsheet_history_staged";
const REVIEW_AUDIT_ACTION = "legacy.appsheet_history_source_reviewed";
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const fail = (reason: string): never => {
  throw new OperationError(423, "APPSHEET_HISTORY_REVIEW_NOT_READY", "La captura AppSheet no conserva una prueba estable y vinculada para revisión humana.", { blockers: [reason] });
};
const sameJson = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right);
function stableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("invalid_json_number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const item = object(value);
  if (!item) throw new Error("invalid_json_value");
  return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${stableJson(item[key])}`).join(",")}}`;
}
function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeCountObject(value: unknown): Record<string, number> | null {
  const raw = object(value);
  if (!raw) return null;
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(raw)) {
    if (!safeCount(count)) return null;
    counts[key] = count;
  }
  return counts;
}
function safeHash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function samePerson(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" &&
    left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

function currentDestinationIdentity(target: "production" | "isolated-test", expected?: string): string {
  if (process.env.DATABASE_URL) {
    let current: string;
    try { current = appSheetDatabaseDestinationIdentity(target, new URL(process.env.DATABASE_URL)); }
    catch { return fail("runtime_database_destination_ambiguous"); }
    if (expected !== undefined && expected !== current) return fail("runtime_database_destination_changed");
    return current;
  }
  if (target === "production") return fail("production_database_destination_unavailable");
  if (process.env.NODE_ENV !== "test" || !expected || !/^appsheet-db-v1:[a-f0-9]{64}$/.test(expected))
    return fail("isolated_test_destination_unavailable");
  return expected;
}

export interface BoundAppSheetHistoryStage {
  snapshot: {
    id: string;
    sourceSystem: string;
    filename: string;
    fileHash: string;
    importerVersion: string;
    status: string;
    createdBy: string;
    reviewedBy: string | null;
    reviewedAt: Date | null;
    captureManifestId: string | null;
    controls: unknown;
    coverage: unknown;
  };
  stage: JsonObject & { projectionHash: string };
  capture: {
    captureId: string;
    sourceSystem: string;
    sourceId: string;
    spreadsheetId: string;
    metadataHash: string;
    headersHash: string;
    manifestHash: string;
    dataHash: string;
    definitionHash: string | null;
    stability: unknown;
    firstReadAt: Date;
    verificationStartedAt: Date;
    verificationCompletedAt: Date;
    cutoffAt: Date;
    dataCoverage: unknown;
    pageManifest: unknown;
    dataSheetCount: number;
    dataPageCount: number;
    dataRecordCount: number;
    dataFormulaCount: number;
    dataUnresolvedFormulaCount: number;
  };
  audit: { id: string; actorId: string; requestId: string | null; createdAt: Date; details: unknown };
  reviewAudit?: { id: string; actorId: string; objectId: string; requestId: string | null; createdAt: Date; details: unknown };
  target: "production" | "isolated-test";
  destinationIdentity: string;
  metrics: { recordCount: number; factCount: number; exceptionCount: number };
}

/**
 * Validate the writer's persisted V2 stage, stable capture, audit binding and live row counts.
 * This proves metadata/count integrity only; it deliberately does not re-hash every source row.
 * Importers that apply the projection must independently verify row/fact/exception hashes.
 */
export async function requireBoundAppSheetHistoryStage(
  tx: Tx,
  snapshotId: string,
  options: { target?: "production" | "isolated-test"; destinationIdentity?: string; requireReviewed?: boolean },
): Promise<BoundAppSheetHistoryStage> {
  const snapshot = await tx.legacyImportSnapshot.findUnique({ where: { id: snapshotId }, select: {
    id: true, sourceSystem: true, filename: true, fileHash: true, importerVersion: true, status: true,
    createdBy: true, reviewedBy: true, reviewedAt: true, captureManifestId: true, controls: true, coverage: true,
  } });
  if (!snapshot) throw new OperationError(404, "IMPORT_NOT_FOUND", "No se encontró la captura de historial AppSheet.");
  const controls = object(snapshot.controls);
  const stage = object(controls?.appSheetHistoryStage);
  const coverage = object(snapshot.coverage);
  const source = object(coverage?.source);
  const definition = object(coverage?.definition);
  const definitionInventoryRaw = definition?.inventory;
  let definitionInventory: ReturnType<typeof appSheetDefinitionInventorySchema.parse>;
  try { definitionInventory = appSheetDefinitionInventorySchema.parse(definitionInventoryRaw); }
  catch { return fail("definition_inventory_invalid"); }
  const destination = object(stage?.destination);
  const technicalReview = object(stage?.technicalReview);
  const humanReview = object(stage?.humanReview);
  const authority = object(stage?.operationalAuthority);
  const effects = object(stage?.effects);
  const metrics = object(stage?.metrics);
  const stageProjectionHash = stage?.projectionHash;
  const persistedTarget = destination?.target;
  const target = options.target ?? (persistedTarget === "production" || persistedTarget === "isolated-test" ? persistedTarget : undefined);
  if (!target || (options.target !== undefined && persistedTarget !== options.target)) return fail("stage_target_mismatch");
  const destinationIdentity = currentDestinationIdentity(target, options.destinationIdentity ??
    (typeof destination?.identity === "string" ? destination.identity : undefined));
  if (snapshot.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || snapshot.importerVersion !== APPSHEET_HISTORY_IMPORTER_VERSION ||
      snapshot.captureManifestId === null || !safeHash(snapshot.fileHash) || !stage || !coverage || !source || !definition ||
      !appSheetHistoryStageHasBoundTechnicalReview(stage, { target, destinationIdentity }) ||
      stage.schemaVersion !== APPSHEET_HISTORY_STAGE_SCHEMA_VERSION_V2 || stage.sourceSystem !== snapshot.sourceSystem ||
      stage.importerVersion !== snapshot.importerVersion || stage.mappingId !== APPSHEET_HISTORY_MAPPING_ID ||
      stage.captureId !== snapshot.captureManifestId || stage.manifestHash !== snapshot.fileHash ||
      stage.mode !== "stable" || (stage.captureDefinitionHash !== null && !safeHash(stage.captureDefinitionHash)) ||
      !safeHash(stage.definitionHash) || !safeHash(stage.definitionSourceSha256) ||
      !safeHash(stage.definitionDescriptorSha256) || !safeHash(stage.definitionFileSha256) ||
      stage.definitionIdentityState !== "verified" || definition.identityState !== "verified" ||
      !safeHash(definition.sourceSha256) || !safeHash(definition.descriptorSha256) || !safeHash(definition.fileSha256) ||
      stage.definitionHash !== definition.appliedDefinitionHash ||
      stage.definitionSourceSha256 !== definition.sourceSha256 || stage.definitionDescriptorSha256 !== definition.descriptorSha256 ||
      stage.definitionFileSha256 !== definition.fileSha256 ||
      definitionInventory.app.id !== APPSHEET_EXPECTED_LIVE_APP_ID ||
      definitionInventory.source.sha256 !== stage.definitionSourceSha256 || definitionInventory.descriptorSha256 !== stage.definitionDescriptorSha256 ||
      !sameJson(stage.definitionInventory, definitionInventoryRaw) || !safeHash(stage.recordsHash) || !safeHash(stage.factsHash) ||
      !safeHash(stage.exceptionsHash) || !safeHash(stageProjectionHash) || !humanReview || humanReview.status !== "pending" ||
      !authority || authority.status !== "unchanged" || !effects || effects.stock !== false || effects.cashLedger !== false ||
      effects.payments !== false || effects.deliveries !== false || effects.messages !== false || effects.documents !== false ||
      effects.numbering !== "not-generated" || stage.authorizationContext !== "user-authorized-plan" ||
      stage.status !== "staged" || stage.reviewedBy !== null || stage.reviewedAt !== null)
    return fail("stage_binding_or_projection_changed");

  const reviewTimestamp = typeof technicalReview?.reviewedAt === "string" ? Date.parse(technicalReview.reviewedAt) : Number.NaN;
  const backupAt = typeof stage.backupSnapshotAt === "string" ? Date.parse(stage.backupSnapshotAt) : Number.NaN;
  if (typeof stage.actorUserId !== "string" || !stage.actorUserId || typeof technicalReview?.reviewer !== "string" ||
      !technicalReview.reviewer || !Number.isFinite(reviewTimestamp) || !Number.isFinite(backupAt) ||
      !safeHash(stage.backupManifestHash) || typeof technicalReview.commitSha !== "string" || !COMMIT.test(technicalReview.commitSha))
    return fail("stage_review_or_backup_identity_invalid");

  const capture = await tx.appSheetCaptureManifest.findUnique({ where: { captureId: snapshot.captureManifestId } });
  if (!capture || capture.sourceSystem !== snapshot.sourceSystem || capture.sourceId !== capture.spreadsheetId ||
      capture.captureId !== stage.captureId || capture.manifestHash !== snapshot.fileHash || capture.manifestHash !== stage.manifestHash ||
      capture.dataHash !== stage.dataHash || capture.definitionHash !== (stage.captureDefinitionHash ?? null) ||
      !safeHash(capture.manifestHash) || !safeHash(capture.dataHash) || !safeHash(capture.metadataHash) || !safeHash(capture.headersHash) ||
      !safeHash(source.metadataHash) || !safeHash(source.headersHash) || source.spreadsheetId !== capture.spreadsheetId ||
      source.metadataHash !== capture.metadataHash || source.headersHash !== capture.headersHash ||
      coverage.schemaVersion !== "appsheet-history-coverage/v1" || coverage.projectionKind !== "history" ||
      coverage.sourceSystem !== snapshot.sourceSystem || coverage.captureId !== capture.captureId ||
      coverage.manifestHash !== capture.manifestHash || coverage.dataHash !== capture.dataHash ||
      coverage.captureDefinitionHash !== (capture.definitionHash ?? null) || coverage.appliedDefinitionHash !== stage.definitionHash ||
      definition.appliedDefinitionHash !== stage.definitionHash)
    return fail("capture_or_coverage_identity_changed");

  const captureStability = object(capture.stability);
  const sourceCoverage = object(capture.dataCoverage);
  const coverageStability = object(coverage.stability);
  const coverageWindow = object(coverage.window);
  const capturePages = Array.isArray(capture.pageManifest) ? capture.pageManifest.map(object) : null;
  const coveragePages = Array.isArray(coverage.pages) ? coverage.pages.map(object) : null;
  const sourceSheets = Array.isArray(sourceCoverage?.sheets) ? sourceCoverage.sheets.map(object) : null;
  const coverageSheets = Array.isArray(coverage.sheets) ? coverage.sheets.map(object) : null;
  const manifestTimestampsValid = [capture.firstReadAt, capture.verificationStartedAt,
    capture.verificationCompletedAt, capture.cutoffAt].every(value => value instanceof Date && Number.isFinite(value.getTime())) &&
    capture.verificationStartedAt >= capture.firstReadAt && capture.verificationCompletedAt >= capture.verificationStartedAt &&
    capture.cutoffAt >= capture.verificationCompletedAt;
  if (!captureStability || !sourceCoverage || !coverageStability || !coverageWindow || !capturePages || !coveragePages ||
      !sourceSheets || !coverageSheets || capturePages.some(page => !page) || coveragePages.some(page => !page) ||
      sourceSheets.some(sheet => !sheet) || coverageSheets.some(sheet => !sheet) || capturePages.length === 0 ||
      capture.dataPageCount !== capturePages.length || capture.dataPageCount !== coveragePages.length ||
      capture.dataSheetCount !== sourceSheets.filter(sheet => sheet!.bodyExcluded !== true).length ||
      sourceCoverage.metadataStable !== true || sourceCoverage.headersStableAll !== true || sourceCoverage.changedPages !== 0 ||
      sourceCoverage.failedPages !== 0 || !safeCount(sourceCoverage.unresolvedFormulaCount) ||
      captureStability.stable !== true || captureStability.metadataStable !== true || captureStability.headersStable !== true ||
      captureStability.pageHashesStable !== true || captureStability.scanComplete !== true || captureStability.sourceWriteDetected !== false ||
      captureStability.changedPages !== 0 || captureStability.failedPages !== 0 || captureStability.missingPages !== 0 ||
      !safeCount(captureStability.unresolvedFormulaCount) || captureStability.unresolvedFormulaCount !== capture.dataUnresolvedFormulaCount ||
      !manifestTimestampsValid || ["firstPassPages", "verifiedPages", "matchedPages"].some(key =>
        !safeCount(captureStability[key]) || captureStability[key] !== capture.dataPageCount) ||
      coverageStability.stable !== true || !sameJson(coverageStability, captureStability) ||
      coverage.mode !== "stable" ||
      ![coverageWindow.firstReadAt, coverageWindow.verificationStartedAt, coverageWindow.verificationCompletedAt, coverageWindow.cutoffAt]
        .every(value => typeof value === "string" && Number.isFinite(Date.parse(value))) ||
      Date.parse(String(coverageWindow.firstReadAt)) !== capture.firstReadAt.getTime() ||
      Date.parse(String(coverageWindow.verificationStartedAt)) !== capture.verificationStartedAt.getTime() ||
      Date.parse(String(coverageWindow.verificationCompletedAt)) !== capture.verificationCompletedAt.getTime() ||
      Date.parse(String(coverageWindow.cutoffAt)) !== capture.cutoffAt.getTime() ||
      !Array.isArray(coverageWindow.timestampGaps) ||
      sourceCoverage.unresolvedFormulaCount !== capture.dataUnresolvedFormulaCount ||
      sourceCoverage.formulaCellCount !== capture.dataFormulaCount ||
      sourceCoverage.totalPages !== capture.dataPageCount || sourceCoverage.bodySheetsCaptured !== capture.dataSheetCount ||
      source.dataSheetCount !== capture.dataSheetCount || source.dataPageCount !== capture.dataPageCount ||
      source.dataRecordCount !== capture.dataRecordCount || source.dataFormulaCount !== capture.dataFormulaCount ||
      source.dataUnresolvedFormulaCount !== capture.dataUnresolvedFormulaCount ||
      !Array.isArray(coverage.deltaEvidence) || coverage.deltaEvidence.length !== 0 ||
      sourceSheets.some(sheet => typeof sheet!.sheetId !== "number" || typeof sheet!.title !== "string" ||
        !safeCount(sheet!.pageCount) || !safeCount(sheet!.verifiedPageCount) || !safeCount(sheet!.stablePageCount) ||
        !safeCount(sheet!.changedPageCount) || sheet!.pageCount !== sheet!.verifiedPageCount ||
        sheet!.pageCount !== sheet!.stablePageCount || sheet!.changedPageCount !== 0) ||
      coverageSheets.some(sheet => typeof sheet!.sourceTable !== "string" || !safeCount(sheet!.pageCount) ||
        !safeCount(sheet!.sourceRecordCount) || !safeCount(sheet!.factCount) ||
        !safeCount(sheet!.blockingExceptionCount) || !safeCount(sheet!.reviewExceptionCount)) ||
      !sameJson(coveragePages, capturePages.map(page => ({ sheetId: page!.sheetId, title: page!.title,
        pageIndex: page!.pageIndex, startRow: page!.startRow, endRow: page!.endRow,
        pageHash: page!.pageHash, verifiedPageHash: page!.verifiedPageHash, stable: page!.stable }))) ||
      capturePages.some(page => typeof page!.sheetId !== "number" || typeof page!.title !== "string" ||
        !safeCount(page!.pageIndex) || !safeCount(page!.startRow) || !safeCount(page!.endRow) ||
        (page!.startRow as number) < 1 || (page!.endRow as number) < (page!.startRow as number) ||
        !safeHash(page!.pageHash) || page!.verifiedPageHash !== page!.pageHash || page!.stable !== true))
    return fail("capture_stability_or_page_coverage_invalid");

  const capturePagesPerSheet = new Map<number, number>();
  for (const page of capturePages) capturePagesPerSheet.set(page!.sheetId as number,
    (capturePagesPerSheet.get(page!.sheetId as number) ?? 0) + 1);
  if (sourceSheets.some(sheet => (capturePagesPerSheet.get(sheet!.sheetId as number) ?? 0) !== sheet!.pageCount))
    return fail("capture_page_counts_mismatch");
  if (coverageSheets.length !== sourceSheets.length || coverageSheets.some(sheet => {
    const capturedSheet = sourceSheets.find(row => row!.title === sheet!.sourceTable);
    return !capturedSheet || capturedSheet.pageCount !== sheet!.pageCount;
  })) return fail("source_sheet_coverage_mismatch");

  const metricRecordCount = metrics?.recordCount;
  const metricFactCount = metrics?.factCount;
  const metricExceptionCount = metrics?.exceptionCount;
  const metricTableCounts = safeCountObject(metrics?.tableCounts);
  const metricKindCounts = safeCountObject(metrics?.kindCounts);
  const metricSeverityCounts = safeCountObject(metrics?.severityCounts);
  const coverageTotals = object(coverage.totals);
  if (!metrics || !metricTableCounts || !metricKindCounts || !metricSeverityCounts || !coverageTotals ||
      !safeCount(metricRecordCount) || !safeCount(metricFactCount) || !safeCount(metricExceptionCount) ||
      coverageTotals.recordCount !== metricRecordCount || coverageTotals.factCount !== metricFactCount ||
      coverageTotals.exceptionCount !== metricExceptionCount || coverage.exceptionTotal !== metricExceptionCount ||
      metricRecordCount !== capture.dataRecordCount ||
      coverageSheets.reduce((total, sheet) => total + (sheet!.sourceRecordCount as number), 0) !== metricRecordCount ||
      coverageSheets.reduce((total, sheet) => total + (sheet!.factCount as number), 0) !== metricFactCount ||
      coverageSheets.reduce((total, sheet) => total + (sheet!.blockingExceptionCount as number) + (sheet!.reviewExceptionCount as number), 0) !== metricExceptionCount ||
      Object.values(metricTableCounts).reduce((total, count) => total + count, 0) !== metricRecordCount ||
      Object.values(metricKindCounts).reduce((total, count) => total + count, 0) !== metricFactCount ||
      Object.values(metricSeverityCounts).reduce((total, count) => total + count, 0) !== metricExceptionCount ||
      coverageSheets.some(sheet => typeof sheet!.sourceTable !== "string" ||
        (metricTableCounts[sheet!.sourceTable] ?? 0) !== sheet!.sourceRecordCount) ||
      !sameJson(coverageTotals, metrics))
    return fail("stage_metrics_or_coverage_counts_invalid");

  const [sourceRecordCount, factCount, exceptionCount, sourceTables, factTables, exceptionSeverities, invalidSourceRows, invalidFacts] = await Promise.all([
    tx.legacySourceRecord.count({ where: { snapshotId } }),
    tx.legacyHistoricalFact.count({ where: { snapshotId } }),
    tx.legacyException.count({ where: { snapshotId } }),
    tx.legacySourceRecord.groupBy({ by: ["sourceTable"], where: { snapshotId }, _count: { _all: true } }),
    tx.legacyHistoricalFact.groupBy({ by: ["sourceTable"], where: { snapshotId }, _count: { _all: true } }),
    tx.legacyException.groupBy({ by: ["severity"], where: { snapshotId }, _count: { _all: true } }),
    tx.legacySourceRecord.count({ where: { snapshotId, OR: [
      { fileHash: { not: snapshot.fileHash } }, { importerVersion: { not: snapshot.importerVersion }, },
    ] } }),
    tx.legacyHistoricalFact.count({ where: { snapshotId, mappingId: { not: APPSHEET_HISTORY_MAPPING_ID } } }),
  ]);
  if (sourceRecordCount !== metricRecordCount || factCount !== metricFactCount || exceptionCount !== metricExceptionCount ||
      invalidSourceRows !== 0 || invalidFacts !== 0 ||
      sourceTables.length > coverageSheets.length || factTables.length > coverageSheets.length)
    return fail("live_source_fact_exception_counts_changed");
  const liveSourceTableCounts = new Map(sourceTables.map(row => [row.sourceTable, row._count._all]));
  const liveFactTableCounts = new Map(factTables.map(row => [row.sourceTable, row._count._all]));
  if (coverageSheets.some(sheet => (liveSourceTableCounts.get(sheet!.sourceTable as string) ?? 0) !== sheet!.sourceRecordCount ||
      (liveFactTableCounts.get(sheet!.sourceTable as string) ?? 0) !== sheet!.factCount) ||
      [...liveSourceTableCounts.keys()].some(name => !coverageSheets.some(sheet => sheet!.sourceTable === name)) ||
      [...liveFactTableCounts.keys()].some(name => !coverageSheets.some(sheet => sheet!.sourceTable === name)))
    return fail("live_table_counts_changed");
  const liveSeverityCounts = Object.fromEntries(exceptionSeverities.map(row => [row.severity, row._count._all]));
  if (!sameJson(liveSeverityCounts, metricSeverityCounts)) return fail("live_exception_severity_counts_changed");

  const audits = await tx.operationAudit.findMany({ where: { objectId: snapshot.id, action: STAGE_AUDIT_ACTION }, select: {
    id: true, actorId: true, requestId: true, createdAt: true, details: true,
  } });
  if (audits.length !== 1) return fail("staging_audit_missing_or_ambiguous");
  const stageAudit = audits[0]!;
  const auditDetails = object(stageAudit.details);
  if (!auditDetails || stageAudit.actorId !== stage.actorUserId || auditDetails.sourceSystem !== snapshot.sourceSystem ||
      auditDetails.importerVersion !== snapshot.importerVersion || auditDetails.captureId !== stage.captureId ||
      auditDetails.manifestHash !== stage.manifestHash || auditDetails.dataHash !== stage.dataHash ||
      auditDetails.projectionHash !== stageProjectionHash || auditDetails.mode !== stage.mode ||
      auditDetails.recordCount !== metricRecordCount || auditDetails.factCount !== metricFactCount ||
      auditDetails.exceptionCount !== metricExceptionCount || auditDetails.reviewer !== technicalReview.reviewer ||
      auditDetails.technicalReviewAt !== technicalReview.reviewedAt || auditDetails.commitSha !== technicalReview.commitSha ||
      auditDetails.target !== destination?.target || auditDetails.destinationIdentity !== destinationIdentity ||
      auditDetails.backupManifestHash !== stage.backupManifestHash || auditDetails.backupSnapshotAt !== stage.backupSnapshotAt ||
      auditDetails.authorizationContext !== "user-authorized-plan" || auditDetails.reviewedBy !== null || auditDetails.status !== "staged")
    return fail("staging_audit_binding_mismatch");

  const reviewed = options.requireReviewed === true;
  let humanReviewAudit: BoundAppSheetHistoryStage["reviewAudit"];
  if (reviewed) {
    if (snapshot.status !== "reviewed" || !snapshot.reviewedBy || !(snapshot.reviewedAt instanceof Date) || !Number.isFinite(snapshot.reviewedAt.getTime()) ||
        samePerson(snapshot.reviewedBy, snapshot.createdBy) || samePerson(snapshot.reviewedBy, stage.actorUserId) ||
        samePerson(snapshot.reviewedBy, technicalReview.reviewer)) return fail("human_source_review_missing_or_not_independent");
    const reviewAudits = await tx.operationAudit.findMany({ where: { objectId: snapshot.id, action: REVIEW_AUDIT_ACTION }, select: {
      id: true, actorId: true, objectId: true, requestId: true, createdAt: true, details: true,
    } });
    if (reviewAudits.length !== 1) return fail("human_source_review_audit_missing_or_ambiguous");
    const reviewAudit = reviewAudits[0]!;
    humanReviewAudit = reviewAudit;
    const reviewDetails = object(reviewAudit.details);
    const expectedEffects = {
      stock: false, cashLedger: false, payments: false, deliveries: false, messages: false,
      documents: false, numbering: "not-generated", masterActivation: false, historyPublication: false,
    };
    if (!reviewDetails || !(reviewAudit.createdAt instanceof Date) || !Number.isFinite(reviewAudit.createdAt.getTime()) ||
        reviewAudit.createdAt.getTime() !== snapshot.reviewedAt.getTime() || reviewAudit.actorId !== snapshot.reviewedBy ||
        reviewAudit.objectId !== snapshot.id || reviewDetails.schemaVersion !== 1 || reviewDetails.snapshotId !== snapshot.id ||
        reviewDetails.captureId !== capture.captureId || reviewDetails.manifestHash !== capture.manifestHash ||
        reviewDetails.dataHash !== capture.dataHash || reviewDetails.projectionHash !== stageProjectionHash ||
        reviewDetails.target !== target || reviewDetails.destinationIdentity !== destinationIdentity ||
        reviewDetails.stagingAuditId !== stageAudit.id || reviewDetails.reviewer !== snapshot.reviewedBy ||
        reviewDetails.reviewedAt !== snapshot.reviewedAt.toISOString() || !sameJson(reviewDetails.counts, {
          recordCount: metricRecordCount, factCount: metricFactCount, exceptionCount: metricExceptionCount,
        }) || !sameJson(reviewDetails.effects, expectedEffects) ||
        typeof reviewDetails.evidenceReference !== "string" || !reviewDetails.evidenceReference.trim() ||
        containsRecognizableCredential(reviewDetails.evidenceReference))
      return fail("human_source_review_audit_binding_mismatch");
    const reviewer = await tx.user.findUnique({ where: { id: snapshot.reviewedBy } });
    if (!reviewer?.active) return fail("human_source_reviewer_inactive");
    await requireCapability(tx, reviewer, "imports.review");
    await requireFullLegacySourceScope(tx, reviewer);
  } else if (snapshot.status !== "staged" || snapshot.reviewedBy !== null || snapshot.reviewedAt !== null) {
    throw new OperationError(409, "IMPORT_NOT_REVIEWABLE", "La captura ya no está pendiente de revisión humana.");
  }
  return { snapshot, stage: { ...stage, projectionHash: stageProjectionHash }, capture, audit: stageAudit, reviewAudit: humanReviewAudit, target, destinationIdentity,
    metrics: { recordCount: metricRecordCount, factCount: metricFactCount, exceptionCount: metricExceptionCount } };
}

const sourceReviewSchema = z.strictObject({
  fileHash: z.string().regex(HASH),
  captureId: z.string().regex(/^appsreal-[a-f0-9]{16}$/),
  dataHash: z.string().regex(HASH),
  projectionHash: z.string().regex(HASH),
  evidenceReference: z.string().trim().min(1).max(2_000).refine(value => !containsRecognizableCredential(value),
    "No incluyas credenciales ni tokens en la referencia."),
});
type SourceReviewInput = z.infer<typeof sourceReviewSchema>;

function assertSourceReviewBinding(data: SourceReviewInput, proof: BoundAppSheetHistoryStage): void {
  if (data.fileHash !== proof.snapshot.fileHash)
    throw new OperationError(409, "IMPORT_CONTENT_CHANGED", "El contenido cambió desde que se preparó la revisión.");
  if (data.captureId !== proof.capture.captureId || data.dataHash !== proof.capture.dataHash ||
      data.projectionHash !== proof.stage.projectionHash)
    throw new OperationError(409, "APPSHEET_HISTORY_REVIEW_BINDING_CHANGED", "La captura o proyección cambió desde que se preparó la revisión.");
}

async function authorizeSourceReview(ctx: CommandContext): Promise<void> {
  await requireCapability(ctx.tx, ctx.actor, "imports.review");
  await requireFullLegacySourceScope(ctx.tx, ctx.actor);
  const data = sourceReviewSchema.parse(ctx.envelope.data);
  const prior = await ctx.tx.commandReceipt.findUnique({ where: { requestId: ctx.envelope.requestId }, select: {
    actorId: true, bodyHash: true, targetId: true, command: true,
  } });
  const bodyHash = canonicalCommandBodyHash(ctx.envelope);
  if (prior && prior.actorId !== ctx.actor.id)
    throw new OperationError(403, "COMMAND_ACTOR_MISMATCH", "El comando pertenece a otra autorización.");
  if (prior && (prior.bodyHash !== bodyHash || prior.targetId !== ctx.envelope.targetId ||
      prior.command !== "AppSheetHistorySourceReviewed"))
    throw new OperationError(409, "IDEMPOTENCY_KEY_REUSED", "Este UUID ya se utilizó con otro contenido.");

  // A reviewed snapshot may pass authorize only for its own exact cached command replay.
  // New request IDs (or altered bodies) must never inherit a previous human review.
  const proof = await requireBoundAppSheetHistoryStage(ctx.tx, ctx.envelope.targetId, { requireReviewed: prior !== null });
  assertSourceReviewBinding(data, proof);
  if (prior) {
    if (proof.snapshot.reviewedBy !== ctx.actor.id || proof.reviewAudit?.actorId !== ctx.actor.id ||
        proof.reviewAudit?.requestId !== ctx.envelope.requestId)
      throw new OperationError(409, "IMPORT_NOT_REVIEWABLE", "La captura ya no está pendiente de esta revisión humana.");
  } else if ([proof.snapshot.createdBy, proof.stage.actorUserId, object(proof.stage.technicalReview)?.reviewer]
    .some(person => samePerson(person, ctx.actor.id))) {
    throw new OperationError(409, "INDEPENDENT_REVIEW_REQUIRED", "La revisión requiere una persona independiente de la carga y de la revisión técnica.");
  }
  ctx.prepared = proof;
}

registerCommand("AppSheetHistorySourceReviewed", {
  kind: "legacyImport",
  capability: "imports.review",
  create: true,
  administrative: true,
  schema: sourceReviewSchema,
  authorize: authorizeSourceReview,
  execute: async ctx => {
    const data = sourceReviewSchema.parse(ctx.envelope.data);
    const proof = ctx.prepared as BoundAppSheetHistoryStage | undefined;
    if (!proof) return fail("source_review_not_authorized");
    assertSourceReviewBinding(data, proof);
    const reviewer = await ctx.tx.user.findUnique({ where: { id: ctx.actor.id }, select: { id: true, active: true, authorizationEpoch: true } });
    if (!reviewer?.active || reviewer.authorizationEpoch !== ctx.actor.authorizationEpoch)
      throw new OperationError(403, "AUTHORIZATION_REVOKED", "La autorización fue revocada.");
    if ([proof.snapshot.createdBy, proof.stage.actorUserId, object(proof.stage.technicalReview)?.reviewer].some(person => samePerson(person, ctx.actor.id)))
      throw new OperationError(409, "INDEPENDENT_REVIEW_REQUIRED", "La revisión requiere una persona independiente de la carga y de la revisión técnica.");
    const updated = await ctx.tx.legacyImportSnapshot.updateMany({ where: {
      id: proof.snapshot.id, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, fileHash: proof.snapshot.fileHash,
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, captureManifestId: proof.capture.captureId,
      status: "staged", reviewedBy: null, reviewedAt: null,
    }, data: { status: "reviewed", reviewedBy: ctx.actor.id, reviewedAt: ctx.now } });
    if (updated.count !== 1) throw new OperationError(409, "IMPORT_NOT_REVIEWABLE", "La captura cambió durante la revisión.");
    await ctx.tx.operationAudit.create({ data: {
      actorId: ctx.actor.id, action: REVIEW_AUDIT_ACTION, objectId: proof.snapshot.id, requestId: ctx.envelope.requestId,
      createdAt: ctx.now, details: {
        schemaVersion: 1, snapshotId: proof.snapshot.id, captureId: proof.capture.captureId,
        manifestHash: proof.capture.manifestHash, dataHash: proof.capture.dataHash,
        projectionHash: proof.stage.projectionHash, target: proof.target, destinationIdentity: proof.destinationIdentity,
        stagingAuditId: proof.audit.id, evidenceReference: data.evidenceReference,
        reviewer: ctx.actor.id, reviewedAt: ctx.now.toISOString(),
        counts: proof.metrics,
        effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false,
          documents: false, numbering: "not-generated", masterActivation: false, historyPublication: false },
      },
    } });
    return { snapshotId: proof.snapshot.id, captureId: proof.capture.captureId, projectionHash: proof.stage.projectionHash,
      status: "reviewed", reviewedBy: ctx.actor.id, counts: proof.metrics,
      effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false,
        documents: false, numbering: "not-generated", masterActivation: false, historyPublication: false } };
  },
});
