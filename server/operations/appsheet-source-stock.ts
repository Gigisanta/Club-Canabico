import { createHash } from "node:crypto";
import { Prisma, type LegacySourceRecord } from "@prisma/client";
import {
  APPSHEET_CANONICAL_IMPORTER_VERSION,
  APPSHEET_CANONICAL_SCHEMA_VERSION,
  APPSHEET_CANONICAL_SOURCE_SYSTEM,
  prepareAppSheetCaptureManifest,
} from "../../shared/operations/appsheet-canonical.js";
import {
  APPSHEET_HISTORY_IMPORTER_VERSION,
  APPSHEET_HISTORY_MAPPING_ID,
  APPSHEET_HISTORY_SOURCE_SYSTEM,
} from "../../shared/operations/appsheet-history.js";
import {
  appSheetDefinitionInventorySchema,
} from "../../shared/operations/appsheet-definition.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import {
  deriveAppSheetSourceStockEvidence,
  type AppSheetSourceStockBlocked,
  type AppSheetSourceStockFact,
  type AppSheetSourceStockRecord,
  type AppSheetSourceStockResult,
  type AppSheetSourceStockSheetCoverage,
} from "../../shared/operations/appsheet-source-stock.js";
import { appSheetAppliedDefinitionHash, APPSHEET_EXPECTED_LIVE_APP_ID } from "./appsheet-canonical.js";
import type { Tx } from "./core.js";

const HASH = /^[a-f0-9]{64}$/;
const HISTORY_VERSION = APPSHEET_HISTORY_IMPORTER_VERSION;
const EXPECTED_TABLES = ["C_Mercaderia", "Mov_Stock1"] as const;
type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
const blocked = (code: AppSheetSourceStockBlocked["code"]): AppSheetSourceStockBlocked => ({ status: "blocked", code });

function verifyStableCapture(capture: {
  captureId: string; sourceSystem: string; sourceId: string; spreadsheetId: string; manifestHash: string; dataHash: string;
  metadataHash: string; headersHash: string; definitionHash: string | null; stability: unknown; firstReadAt: Date;
  verificationStartedAt: Date; verificationCompletedAt: Date; cutoffAt: Date; dataCoverage: unknown; pageManifest: unknown;
  dataSheetCount: number; dataPageCount: number; dataRecordCount: number; dataFormulaCount: number;
  dataUnresolvedFormulaCount: number; definitionCoverage: unknown;
}): boolean {
  if (capture.sourceSystem !== APPSHEET_CANONICAL_SOURCE_SYSTEM || capture.sourceId !== capture.spreadsheetId ||
      capture.definitionHash !== null || capture.definitionCoverage !== null || !HASH.test(capture.manifestHash) ||
      !HASH.test(capture.dataHash) || !HASH.test(capture.metadataHash) || !HASH.test(capture.headersHash) ||
      capture.captureId !== `appsreal-${capture.manifestHash.slice(0, 16)}`) return false;
  let prepared;
  try {
    prepared = prepareAppSheetCaptureManifest({
      schemaVersion: APPSHEET_CANONICAL_SCHEMA_VERSION,
      ...capture,
      firstReadAt: capture.firstReadAt.toISOString(),
      verificationStartedAt: capture.verificationStartedAt.toISOString(),
      verificationCompletedAt: capture.verificationCompletedAt.toISOString(),
      cutoffAt: capture.cutoffAt.toISOString(),
      coverage: capture.dataCoverage,
      pages: capture.pageManifest,
    });
  } catch {
    return false;
  }
  const stability = asObject(prepared.stability);
  const coverage = asObject(prepared.dataCoverage);
  const sheets = coverage && Array.isArray(coverage.sheets) ? coverage.sheets.map(asObject) : null;
  const pages = Array.isArray(prepared.pageManifest) ? prepared.pageManifest.map(asObject) : null;
  if (!stability || !coverage || !sheets || sheets.some((sheet) => !sheet) || !pages || pages.some((page) => !page)) return false;
  if (stability.stable !== true || stability.cutoverEligible !== true || stability.metadataStable !== true ||
      stability.headersStable !== true || stability.pageHashesStable !== true || stability.scanComplete !== true ||
      stability.changedPages !== 0 || stability.failedPages !== 0 || stability.missingPages !== 0 ||
      stability.unresolvedFormulaCount !== 0 || stability.sourceWriteDetected !== false ||
      stability.firstPassPages !== capture.dataPageCount || stability.verifiedPages !== capture.dataPageCount ||
      stability.matchedPages !== capture.dataPageCount || capture.dataPageCount !== pages.length ||
      capture.dataPageCount === 0 || capture.dataUnresolvedFormulaCount !== 0 || coverage.failedPages !== 0 ||
      coverage.changedPages !== 0 || coverage.unresolvedFormulaCount !== 0 || coverage.metadataStable !== true ||
      coverage.headersStableAll !== true) return false;
  const sheetIds = new Set<number>();
  const titles = new Set<string>();
  const pageCounts = new Map<number, number>();
  for (const sheet of sheets) {
    if (typeof sheet!.sheetId !== "number" || !Number.isSafeInteger(sheet!.sheetId) || typeof sheet!.title !== "string" ||
        !sheet!.title || sheetIds.has(sheet!.sheetId) || titles.has(sheet!.title) ||
        typeof sheet!.pageCount !== "number" || typeof sheet!.verifiedPageCount !== "number" ||
        typeof sheet!.stablePageCount !== "number" || typeof sheet!.changedPageCount !== "number" ||
        sheet!.pageCount !== sheet!.verifiedPageCount || sheet!.pageCount !== sheet!.stablePageCount ||
        sheet!.changedPageCount !== 0 || typeof sheet!.bodyRead !== "boolean" || typeof sheet!.bodyExcluded !== "boolean") return false;
    sheetIds.add(sheet!.sheetId);
    titles.add(sheet!.title);
    if (sheet!.title === "T_Usuarios") {
      if (!(sheet!.bodyExcluded === true && sheet!.bodyRead === false &&
          sheet!.bodyExclusionReason === "authentication-table-body-redacted")) return false;
    } else if (!sheet!.bodyRead || sheet!.bodyExcluded) return false;
  }
  if (!titles.has("C_Mercaderia") || !titles.has("Mov_Stock1") || !titles.has("T_Usuarios") ||
      stability.bodyExcludedSheets instanceof Array && stability.bodyExcludedSheets.length !== 1) return false;
  const pageKeys = new Set<string>();
  for (const page of pages) {
    if (typeof page!.path !== "string" || !/^pages\/[0-9]+-[0-9]+-[0-9]+\.json$/.test(page!.path) ||
        typeof page!.sheetId !== "number" || typeof page!.title !== "string" ||
        !Number.isSafeInteger(page!.pageIndex) || typeof page!.pageIndex !== "number" ||
        !Number.isSafeInteger(page!.startRow) || typeof page!.startRow !== "number" ||
        !Number.isSafeInteger(page!.endRow) || typeof page!.endRow !== "number" ||
        typeof page!.pageHash !== "string" || !HASH.test(page!.pageHash) || page!.verifiedPageHash !== page!.pageHash ||
        page!.stable !== true || !asObject(page!.counts)) return false;
    const sheet = sheets.find((candidate) => candidate!.sheetId === page!.sheetId);
    const key = `${page!.sheetId}:${page!.pageIndex}`;
    if (!sheet || sheet!.title !== page!.title || pageKeys.has(key) || page!.pageIndex < 0 || page!.startRow < 1 ||
        page!.endRow < page!.startRow) return false;
    pageKeys.add(key);
    pageCounts.set(page!.sheetId, (pageCounts.get(page!.sheetId) ?? 0) + 1);
  }
  if (sheets.some((sheet) => (pageCounts.get(sheet!.sheetId as number) ?? 0) !== sheet!.pageCount)) return false;
  const pageRefs = pages.map((page) => ({ path: page!.path, sheetId: page!.sheetId, pageIndex: page!.pageIndex,
    startRow: page!.startRow, endRow: page!.endRow, pageHash: page!.pageHash, counts: page!.counts }));
  return digest(pageRefs) === capture.dataHash;
}

function stageCoverage(snapshotCoverage: unknown): JsonObject | null {
  const coverage = asObject(snapshotCoverage);
  if (!coverage) return null;
  const nested = asObject(coverage.appSheetHistoryStage);
  return nested ?? coverage;
}

function historyTableCoverage(
  table: string,
  coverage: JsonObject,
  capture: { pageManifest: unknown; dataCoverage: unknown },
): AppSheetSourceStockSheetCoverage | null {
  const sheets = Array.isArray(coverage.sheets) ? coverage.sheets.map(asObject) : null;
  const source = asObject(coverage.source);
  const sourceSheets = asObject(capture.dataCoverage) && Array.isArray((capture.dataCoverage as JsonObject).sheets)
    ? ((capture.dataCoverage as JsonObject).sheets as unknown[]).map(asObject) : null;
  const sourceSheet = sourceSheets?.filter((sheet) => sheet?.title === table) ?? [];
  const sheetMatches = sheets?.filter((sheet) => sheet?.sourceTable === table) ?? [];
  if (!source || !sheets || sheetMatches.length !== 1 || sourceSheet.length !== 1 || !sourceSheet[0]) return null;
  const sheet = sheetMatches[0]!;
  const capturePageRefs = Array.isArray(capture.pageManifest) ? capture.pageManifest.map(asObject) : null;
  const historyPages = Array.isArray(coverage.pages) ? coverage.pages.map(asObject) : null;
  if (!capturePageRefs || !historyPages || capturePageRefs.some((page) => !page) || historyPages.some((page) => !page)) return null;
  const sourcePages = capturePageRefs.filter((page) => page!.title === table);
  const projectedPages = historyPages.filter((page) => page!.title === table);
  if (sourcePages.length !== projectedPages.length || sourcePages.length !== sheet.pageCount) return null;
  const projectedByIndex = new Map(projectedPages.map((page) => [page!.pageIndex, page!]));
  for (const page of sourcePages) {
    const historyPage = projectedByIndex.get(page!.pageIndex);
    if (!historyPage || historyPage.sheetId !== page!.sheetId || historyPage.startRow !== page!.startRow ||
        historyPage.endRow !== page!.endRow || historyPage.pageHash !== page!.pageHash ||
        historyPage.verifiedPageHash !== page!.verifiedPageHash || historyPage.stable !== true || page!.stable !== true) return null;
  }
  if (sourceSheet[0]!.bodyRead !== true || sourceSheet[0]!.bodyExcluded !== false ||
      sheet.populatedSourceRows !== sheet.sourceRecordCount ||
      typeof sheet.factCount !== "number" || typeof sheet.blockingExceptionCount !== "number" ||
      typeof sheet.reviewExceptionCount !== "number" || typeof sheet.sourceRecordUnresolvedFormulaCount !== "number" ||
      !Array.isArray(sheet.changedPageIndexes)) return null;
  return {
    sourceRecordCount: sheet.sourceRecordCount as number,
    factCount: sheet.factCount,
    blockingExceptionCount: sheet.blockingExceptionCount,
    reviewExceptionCount: sheet.reviewExceptionCount,
    sourceRecordUnresolvedFormulaCount: sheet.sourceRecordUnresolvedFormulaCount,
    changedPageIndexes: sheet.changedPageIndexes as number[],
    stable: sheet.changedPageIndexes.length === 0 && sourceSheet[0]!.bodyRead === true && sourceSheet[0]!.bodyExcluded === false,
  };
}

function appSheetRecord(value: {
  id: string; snapshotId: string; sourceTable: string; sourceKey: string; sourceRow: number; fileHash: string;
  contentHash: string; importerVersion: string; treatment: string; normalized: Prisma.JsonValue; original: Prisma.JsonValue;
}): AppSheetSourceStockRecord {
  return {
    id: value.id, snapshotId: value.snapshotId, sourceTable: value.sourceTable, sourceKey: value.sourceKey,
    sourceRow: value.sourceRow, fileHash: value.fileHash, contentHash: value.contentHash,
    importerVersion: value.importerVersion, treatment: value.treatment,
    normalized: value.normalized as AppSheetSourceStockRecord["normalized"],
    original: value.original as AppSheetSourceStockRecord["original"],
  };
}

function appSheetFact(value: {
  id: string; snapshotId: string; sourceRecordId: string; sourceTable: string; sourceKey: string; sourceRow: number;
  sourceHash: string; mappingId: string; kind: string; quantity: Prisma.Decimal | null; quantityState: string;
  unit: string | null; unitState: string; attributes: Prisma.JsonValue; correctionOf: string | null;
}): AppSheetSourceStockFact {
  return {
    id: value.id, snapshotId: value.snapshotId, sourceRecordId: value.sourceRecordId, sourceTable: value.sourceTable,
    sourceKey: value.sourceKey, sourceRow: value.sourceRow, sourceHash: value.sourceHash, mappingId: value.mappingId,
    kind: value.kind, quantity: value.quantity?.toString() ?? null, quantityState: value.quantityState,
    unit: value.unit, unitState: value.unitState, attributes: value.attributes, correctionOf: value.correctionOf,
  };
}

/** Resolve current source evidence inside the caller's transaction; no writes or external effects occur here. */
export async function deriveAppSheetSourceStock(
  tx: Tx,
  sourceRecord: Pick<LegacySourceRecord, "id" | "snapshotId">,
  selectedCaptureId: string,
): Promise<AppSheetSourceStockResult> {
  if (!sourceRecord || typeof sourceRecord.id !== "string" || typeof sourceRecord.snapshotId !== "string" ||
      !/^appsreal-[a-f0-9]{16}$/.test(selectedCaptureId)) return blocked("lot_source_invalid");
  const capture = await tx.appSheetCaptureManifest.findUnique({ where: { captureId: selectedCaptureId } });
  if (!capture || !verifyStableCapture(capture)) return blocked("capture_not_stable");

  const snapshots = await tx.legacyImportSnapshot.findMany({
    where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, captureManifestId: selectedCaptureId,
      importerVersion: { in: [APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_CANONICAL_IMPORTER_VERSION] } },
    select: { id: true, sourceSystem: true, importerVersion: true, status: true, createdBy: true, reviewedBy: true,
      reviewedAt: true, fileHash: true, captureManifestId: true, controls: true, coverage: true },
  });
  const historySnapshots = snapshots.filter((snapshot) => snapshot.importerVersion === APPSHEET_HISTORY_IMPORTER_VERSION);
  const masterSnapshots = snapshots.filter((snapshot) => snapshot.importerVersion === APPSHEET_CANONICAL_IMPORTER_VERSION);
  if (historySnapshots.length !== 1 || masterSnapshots.length !== 1) return blocked("definition_binding_missing");
  const historySnapshot = historySnapshots[0]!;
  const masterSnapshot = masterSnapshots[0]!;
  if (historySnapshot.id !== sourceRecord.snapshotId || historySnapshot.status !== "reviewed" ||
      masterSnapshot.status !== "reviewed" || historySnapshot.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM ||
      masterSnapshot.sourceSystem !== APPSHEET_CANONICAL_SOURCE_SYSTEM || historySnapshot.captureManifestId !== selectedCaptureId ||
      masterSnapshot.captureManifestId !== selectedCaptureId || historySnapshot.fileHash !== capture.manifestHash ||
      masterSnapshot.fileHash !== capture.manifestHash || !historySnapshot.reviewedBy || !masterSnapshot.reviewedBy ||
      historySnapshot.reviewedBy === historySnapshot.createdBy || masterSnapshot.reviewedBy === masterSnapshot.createdBy ||
      !historySnapshot.reviewedAt || !masterSnapshot.reviewedAt) return blocked("definition_binding_missing");

  const masterControls = asObject(masterSnapshot.controls);
  const masterProjection = masterControls && asObject(masterControls.appSheetCanonical);
  const masterCoverageRoot = asObject(masterSnapshot.coverage);
  const masterCoverage = masterCoverageRoot && asObject(masterCoverageRoot.appSheetCanonical);
  const historyControls = asObject(historySnapshot.controls);
  const historyProjection = historyControls && asObject(historyControls.appSheetHistoryStage);
  const historyCoverage = stageCoverage(historySnapshot.coverage);
  const masterReview = masterProjection && asObject(masterProjection.technicalReview);
  const masterStageContext = masterProjection && asObject(masterProjection.stageContext);
  const historyReview = historyProjection && asObject(historyProjection.technicalReview);
  const historyDestination = historyProjection && asObject(historyProjection.destination);
  if (!masterProjection || !masterCoverage || !historyProjection || !historyCoverage ||
      masterProjection.projectionKind !== "masters" || masterProjection.captureId !== selectedCaptureId ||
      masterProjection.manifestHash !== capture.manifestHash || masterProjection.dataHash !== capture.dataHash ||
      masterProjection.captureDefinitionHash !== null || masterProjection.definitionIdentityState !== "verified" ||
      masterProjection.expectedAppId !== APPSHEET_EXPECTED_LIVE_APP_ID || masterProjection.stabilityMode !== "stable" ||
      masterCoverage.projectionHash !== masterProjection.projectionHash || masterCoverage.identityState !== "verified" ||
      !masterReview || masterReview.approved !== true || masterReview.captureId !== selectedCaptureId ||
      masterReview.manifestHash !== capture.manifestHash || masterReview.target !== "production" ||
      !masterStageContext || masterStageContext.target !== "production" ||
      historyProjection.schemaVersion !== "appsheet-history-stage/v2" || historyProjection.projectionKind !== "history" ||
      historyProjection.captureId !== selectedCaptureId || historyProjection.manifestHash !== capture.manifestHash ||
      historyProjection.dataHash !== capture.dataHash || historyProjection.captureDefinitionHash !== null ||
      historyProjection.mode !== "stable" || historyProjection.definitionIdentityState !== "verified" ||
      historyCoverage.captureId !== selectedCaptureId || historyCoverage.manifestHash !== capture.manifestHash ||
      historyCoverage.dataHash !== capture.dataHash || historyCoverage.mode !== "stable" ||
      !historyReview || historyReview.approved !== true || historyReview.reviewKind !== "independent-technical" ||
      !historyDestination || historyDestination.target !== "production") return blocked("definition_binding_missing");

  const masterInventory = appSheetDefinitionInventorySchema.safeParse(masterProjection.definitionInventory);
  const historyInventory = appSheetDefinitionInventorySchema.safeParse(historyProjection.definitionInventory);
  if (!masterInventory.success || !historyInventory.success || masterInventory.data.app.id !== APPSHEET_EXPECTED_LIVE_APP_ID ||
      canonicalJson(masterInventory.data) !== canonicalJson(historyInventory.data)) return blocked("definition_invalid");
  let appliedDefinitionHash: string;
  try {
    appliedDefinitionHash = appSheetAppliedDefinitionHash(masterInventory.data);
  } catch {
    return blocked("applied_definition_hash_mismatch");
  }
  if (masterProjection.appliedDefinitionHash !== appliedDefinitionHash ||
      masterCoverage.appliedDefinitionHash !== appliedDefinitionHash ||
      historyProjection.definitionHash !== appliedDefinitionHash ||
      historyCoverage.appliedDefinitionHash !== appliedDefinitionHash ||
      historyProjection.definitionSourceSha256 !== masterInventory.data.source.sha256 ||
      historyProjection.definitionDescriptorSha256 !== masterInventory.data.descriptorSha256) return blocked("applied_definition_hash_mismatch");

  const reviewers = await Promise.all([historySnapshot.reviewedBy, masterSnapshot.reviewedBy].map((id) =>
    tx.user.findUnique({ where: { id }, select: { active: true } })));
  if (reviewers.some((reviewer) => !reviewer?.active)) return blocked("definition_binding_missing");

  const [sourceRowsRaw, factsRaw] = await Promise.all([
    tx.legacySourceRecord.findMany({ where: { snapshotId: historySnapshot.id, sourceTable: { in: [...EXPECTED_TABLES] } },
      select: { id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true, fileHash: true,
        contentHash: true, importerVersion: true, treatment: true, original: true, normalized: true } }),
    tx.legacyHistoricalFact.findMany({ where: { snapshotId: historySnapshot.id, sourceTable: { in: [...EXPECTED_TABLES] } },
      select: { id: true, snapshotId: true, sourceRecordId: true, sourceTable: true, sourceKey: true, sourceRow: true,
        sourceHash: true, mappingId: true, kind: true, quantity: true, quantityState: true, unit: true,
        unitState: true, attributes: true, correctionOf: true } }),
  ]);
  const rows = sourceRowsRaw.map(appSheetRecord);
  const facts = factsRaw.map(appSheetFact);
  if (rows.some((row) => row.fileHash !== capture.manifestHash || row.importerVersion !== HISTORY_VERSION) ||
      facts.some((fact) => fact.snapshotId !== historySnapshot.id || fact.mappingId !== APPSHEET_HISTORY_MAPPING_ID))
    return blocked("movement_rowset_incomplete");
  const rowIds = rows.map((row) => row.id);
  const openExceptions = rowIds.length ? await tx.legacyException.count({ where: {
    snapshotId: historySnapshot.id, status: "open", sourceRecordId: { in: rowIds },
  } }) : 0;
  if (openExceptions !== 0) return blocked("movement_rowset_incomplete");

  const lotRows = rows.filter((row) => row.sourceTable === "C_Mercaderia");
  const movementRows = rows.filter((row) => row.sourceTable === "Mov_Stock1");
  const lotFacts = facts.filter((fact) => fact.sourceTable === "C_Mercaderia");
  const movementFacts = facts.filter((fact) => fact.sourceTable === "Mov_Stock1");
  const lotCoverage = historyTableCoverage("C_Mercaderia", historyCoverage, capture);
  const movementCoverage = historyTableCoverage("Mov_Stock1", historyCoverage, capture);
  if (!lotCoverage || !movementCoverage) return blocked("movement_rowset_incomplete");
  const lot = lotRows.find((row) => row.id === sourceRecord.id);
  if (!lot || lot.snapshotId !== sourceRecord.snapshotId) return blocked("lot_source_invalid");
  return deriveAppSheetSourceStockEvidence({
    capture: { captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash, stableAndComplete: true },
    definitionInventory: masterInventory.data, appliedDefinitionHash, lot, lotRows, lotFacts, lotCoverage,
    movementRows, movementFacts, movementCoverage,
  }, digest);
}
