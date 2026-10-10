import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { canonicalJson } from "../../shared/operations/exact.js";
import { requireBoundAppSheetHistoryStage } from "./appsheet-history-review.js";
import {
  APPSHEET_PENDING_TABLES,
  APPSHEET_PENDING_MAPPING_ID,
  APPSHEET_PENDING_SCHEMA_VERSION,
  pendingMappingFingerprintPayload,
  appSheetPendingReconciliationSchema,
  type AppSheetPendingReconciliation,
} from "../../shared/operations/appsheet-pending.js";
import {
  AppSheetPendingImportError,
  APPSHEET_PENDING_DELIVERY_CARDINALITY_REVIEW_REASON,
  APPSHEET_PENDING_IMPORT_VERSION,
  APPSHEET_PENDING_IMPORT_SOURCE_SPEC,
  appSheetPendingDeliveryResolutionSchema,
  appSheetDeliveryInvoiceReferenceMatches,
  appSheetPendingDeliveryCardinalityAmbiguities,
  appSheetPendingDeliveryInvoiceCardinalityAmbiguities,
  assertAppSheetPendingImportReview,
  deriveAppSheetPendingImportDispositions,
  appSheetPendingImportReviewSchema,
  sha256Canonical,
  validatedLegacySettlement,
  type AppSheetPendingImportDisposition,
  type AppSheetPendingImportSource,
  type AppSheetPendingImportSourceCell,
} from "../../shared/operations/appsheet-pending-import.js";
import { APPSHEET_HISTORY_SOURCE_SYSTEM } from "../../shared/operations/appsheet-history.js";
import { appSheetDatabaseDestinationIdentity } from "./appsheet-database-target.js";
import { audit, OperationError, registerCommand, requireCapability, type CommandContext } from "./core.js";

type Tx = Prisma.TransactionClient;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const DUPLICATE_ORDER_DESTINATION_REASON = "duplicate_order_destination_mapping";
const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export type AppSheetOrderCommercialBasis = {
  id: string; memberId: string; channel: string; currency: string; quoteVersion: number; quote: unknown; address: unknown;
  subtotalMinor: bigint; discountMinor: bigint; deliveryMinor: bigint; deliveryDiscountMinor: bigint; surchargeMinor: bigint;
  totalMinor: bigint; sourceSystem: string | null; sourceId: string | null; legacySaleId: string | null;
  lines: Array<{
    id: string; skuId: string; unit: string; requested: { toString(): string }; unitPrice: { toString(): string };
    referenceMinor: bigint; discountMinor: bigint; revenueMinor: bigint; policyId: string | null;
    policyVersion: number | null; packId: string | null; packCount: number | null;
  }>;
};

/** Seal the live commercial snapshot while excluding later collection and fulfillment counters. */
export function appSheetPendingOrderCommercialBasisHash(order: AppSheetOrderCommercialBasis): string | null {
  const quote = asObject(order.quote);
  if (!quote || !Number.isSafeInteger(order.quoteVersion) || order.quoteVersion < 1 || !order.lines.length) return null;
  const lines = [...order.lines].sort((left, right) => left.id.localeCompare(right.id)).map(line => ({
    id: line.id, skuId: line.skuId, unit: line.unit, requested: line.requested.toString(), unitPrice: line.unitPrice.toString(),
    referenceMinor: line.referenceMinor.toString(), discountMinor: line.discountMinor.toString(), revenueMinor: line.revenueMinor.toString(),
    policyId: line.policyId, policyVersion: line.policyVersion, packId: line.packId, packCount: line.packCount,
  }));
  return sha256Canonical({ schemaVersion: "appsheet-order-commercial-basis/v1", order: {
    id: order.id, memberId: order.memberId, channel: order.channel, currency: order.currency, quoteVersion: order.quoteVersion,
    subtotalMinor: order.subtotalMinor.toString(), discountMinor: order.discountMinor.toString(),
    deliveryMinor: order.deliveryMinor.toString(), deliveryDiscountMinor: order.deliveryDiscountMinor.toString(),
    surchargeMinor: order.surchargeMinor.toString(), totalMinor: order.totalMinor.toString(),
    sourceSystem: order.sourceSystem, sourceId: order.sourceId, legacySaleId: order.legacySaleId, address: order.address,
  }, quote, lines }, sha256);
}

export class AppSheetPendingImportStageError extends OperationError {
  constructor(code: string) {
    super(423, code, "La importación histórica requiere una evidencia o revisión pendiente.", { blocker: code });
    this.name = "AppSheetPendingImportStageError";
  }
}

export interface AppSheetPendingImportPlan {
  batchId: string;
  captureId: string;
  manifestHash: string;
  dataHash: string;
  historySnapshotId: string;
  historyRecordsHash: string;
  projectionHash: string;
  target: "isolated-test" | "production";
  destinationIdentity: string;
  commitSha: string;
  backupManifestHash: string;
  backupSnapshotAt: Date;
  mappingHash: string;
  sourceSpecHash: string;
  sourceCoverageHash: string;
  dispositions: AppSheetPendingImportDisposition[];
  materializedSettlements: Array<{
    dispositionId: string;
    sourceRecordId: string;
    sourceRecordHash: string;
    reconciliationHash: string;
    sourceKeyHash: string;
    operationOrderId: string;
    operationOrderMemberId: string;
    financialBasisHash: string;
    currency: string;
    dueMinor: bigint;
    legacyPaidMinor: bigint;
    remainingMinor: bigint;
    paymentRowsHash: string;
    paymentReferences: unknown[];
    destinationHash: string;
    operationOrderVersion: number;
    operationOrderHash: string;
    orderMappingReviewerId: string;
    orderMappingEvidenceHash: string;
  }>;
  materializedDeliveries: Array<{
    dispositionId: string;
    sourceRecordId: string;
    sourceRecordHash: string;
    reconciliationHash: string;
    sourceKeyHash: string;
    invoiceRecordId: string;
    invoiceRecordHash: string;
    invoiceKeyHash: string;
    motoKeyCell: AppSheetPendingImportSourceCell;
    invoiceReferenceCell: AppSheetPendingImportSourceCell;
    invoiceKeyCell: AppSheetPendingImportSourceCell;
    invoiceAddressCell: AppSheetPendingImportSourceCell;
    operationOrderId: string;
    operationOrderVersion: number;
    operationOrderHash: string;
    destinationId: string;
    destinationHash: string;
    address: Record<string, unknown>;
    orderMappingReviewerId: string;
    resolutionReviewerId: string;
    resolutionEvidenceHash: string;
  }>;
  dispositionHash: string;
  destinationHash: string;
}

function fail(code: string): never { throw new AppSheetPendingImportStageError(code); }

function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }

/** Hash source bindings as typed metadata so field names never become money-field keys. */
function sourceSpecMetadata(value: unknown): unknown[] {
  if (value === null) return ["null"];
  if (typeof value === "string") return ["string", value];
  if (typeof value === "boolean") return ["boolean", value];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("pending_source_spec_metadata_invalid");
    return ["number", value];
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length > 0) {
      fail("pending_source_spec_metadata_invalid");
    }
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== value.length + 1 || names.some(name => name !== "length" && !/^(?:0|[1-9]\d*)$/.test(name))) {
      fail("pending_source_spec_metadata_invalid");
    }
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor)) fail("pending_source_spec_metadata_invalid");
      items.push(sourceSpecMetadata(descriptor.value));
    }
    return ["array", items];
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
      fail("pending_source_spec_metadata_invalid");
    }
    const names = Object.getOwnPropertyNames(value);
    const keys = Object.keys(value);
    if (names.length !== keys.length) fail("pending_source_spec_metadata_invalid");
    keys.sort();
    const entries = keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) fail("pending_source_spec_metadata_invalid");
      return ["entry", ["string", key], sourceSpecMetadata(descriptor.value)];
    });
    return ["object", entries];
  }
  return fail("pending_source_spec_metadata_invalid");
}

function appSheetPendingImportSourceSpecHash(): string {
  return sha256Canonical(sourceSpecMetadata(APPSHEET_PENDING_IMPORT_SOURCE_SPEC), sha256);
}

function operationOrderHash(order: {
  id: string; currency: string; totalMinor: bigint; verifiedMinor: bigint; refundedMinor: bigint;
  commercialState: string; financialState: string; version: number;
}): string {
  return sha256Canonical({
    id: order.id, currency: order.currency, totalMinor: order.totalMinor.toString(),
    verifiedMinor: order.verifiedMinor.toString(), refundedMinor: order.refundedMinor.toString(),
    commercialState: order.commercialState, financialState: order.financialState, version: order.version,
  }, sha256);
}

export function appSheetLegacyFinancialBasisHash(input: {
  orderId: string; memberId: string; currency: string; totalMinor: bigint;
  commercialBasisHash: string;
  captureId: string; sourceRecordId: string; sourceRecordHash: string; sourceKeyHash: string;
  reconciliationHash: string; mappingHash: string; mappingReviewerId: string; mappingEvidenceHash: string;
  mappedOrderVersion: number; mappedOrderHash: string;
}): string {
  return sha256Canonical({ schemaVersion: "appsheet-legacy-financial-basis/v2",
    order: { id: input.orderId, memberId: input.memberId, currency: input.currency, totalMinor: input.totalMinor.toString(),
      commercialBasisHash: input.commercialBasisHash },
    invoice: { captureId: input.captureId, sourceRecordId: input.sourceRecordId, sourceRecordHash: input.sourceRecordHash,
      sourceKeyHash: input.sourceKeyHash, reconciliationHash: input.reconciliationHash, mappingHash: input.mappingHash },
    mapping: { reviewerId: input.mappingReviewerId, evidenceHash: input.mappingEvidenceHash,
      mappedOrderVersion: input.mappedOrderVersion, mappedOrderHash: input.mappedOrderHash },
  }, sha256);
}

function planProjectionHash(plan: Pick<AppSheetPendingImportPlan,
  "captureId" | "manifestHash" | "dataHash" | "historySnapshotId" | "historyRecordsHash" | "mappingHash" |
  "sourceSpecHash" | "sourceCoverageHash" | "dispositionHash" | "destinationHash" | "target" | "destinationIdentity" | "commitSha" | "backupManifestHash" | "backupSnapshotAt">): string {
  return sha256Canonical({
    schemaVersion: APPSHEET_PENDING_IMPORT_VERSION,
    captureId: plan.captureId, manifestHash: plan.manifestHash, dataHash: plan.dataHash,
    historySnapshotId: plan.historySnapshotId, historyRecordsHash: plan.historyRecordsHash,
    mappingHash: plan.mappingHash, sourceSpecHash: plan.sourceSpecHash, sourceCoverageHash: plan.sourceCoverageHash,
    dispositionHash: plan.dispositionHash, destinationHash: plan.destinationHash,
    target: plan.target, destinationIdentity: plan.destinationIdentity, commitSha: plan.commitSha,
    backupManifestHash: plan.backupManifestHash, backupSnapshotAt: plan.backupSnapshotAt.toISOString(),
  }, sha256);
}

function batchIdFor(snapshotId: string, mappingHash: string, sourceSpecHash: string): string {
  return sha256(`appsheet-pending-batch-v1\0${snapshotId}\0${mappingHash}\0${sourceSpecHash}`);
}

function dispositionIdFor(batchId: string, sourceRecordId: string, dimension: string): string {
  return sha256(`appsheet-pending-disposition-v1\0${batchId}\0${sourceRecordId}\0${dimension}`);
}

function settlementIdFor(dispositionId: string): string { return sha256(`appsheet-legacy-settlement-v1\0${dispositionId}`); }
function deliveryAssignmentIdFor(dispositionId: string): string { return sha256(`appsheet-pending-delivery-v1\0${dispositionId}`); }
function planReviewObjectId(batchId: string): string { return `appsheet-pending-plan-review:${batchId}`; }

type CapturedSourceRow = {
  id: string;
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  contentHash: string;
  original: unknown;
  normalized: unknown;
};

function reviewedSourceCell(
  record: CapturedSourceRow,
  reference: AppSheetPendingImportSourceCell,
  expectedHeader: string,
): string | null {
  if (reference.sourceRecordId !== record.id || reference.sourceRecordHash !== record.contentHash || reference.header !== expectedHeader)
    return null;
  const originalColumns = asObject(record.original)?.columns;
  const normalizedColumns = asObject(record.normalized)?.columns;
  if (!Array.isArray(originalColumns) || !Array.isArray(normalizedColumns)) return null;
  const originals = originalColumns.map(asObject).filter((row): row is Record<string, unknown> => row !== null)
    .filter(row => row.coordinate === reference.coordinate && row.header === expectedHeader);
  const normalized = normalizedColumns.map(asObject).filter((row): row is Record<string, unknown> => row !== null)
    .filter(row => row.coordinate === reference.coordinate && row.header === expectedHeader);
  if (originals.length !== 1 || normalized.length !== 1 || !Object.hasOwn(originals[0]!, "value") ||
      sha256Canonical(originals[0]!.value, sha256) !== reference.valueHash || typeof normalized[0]!.value !== "string") return null;
  const value = (normalized[0]!.value as string).trim();
  return value ? value : null;
}

/** Build a deterministic complete four-dimension disposition set from one reviewed history snapshot. */
export interface AppSheetPendingImportBinding {
  target: "isolated-test" | "production";
  destinationIdentity: string;
  commitSha: string;
  backupManifestHash: string;
  backupSnapshotAt: Date;
}

export async function prepareAppSheetPendingImportPlan(
  tx: Tx,
  input: { snapshotId: string; binding?: AppSheetPendingImportBinding },
): Promise<AppSheetPendingImportPlan> {
  const historyProof = await requireBoundAppSheetHistoryStage(tx, input.snapshotId, {
    target: input.binding?.target, destinationIdentity: input.binding?.destinationIdentity, requireReviewed: true,
  });
  const { snapshot, capture, stage, target } = historyProof;
  const technicalReview = asObject(stage.technicalReview)!;
  const sourceStage = { target, destinationIdentity: historyProof.destinationIdentity,
    commitSha: String(technicalReview.commitSha), backupManifestHash: String(stage.backupManifestHash),
    backupSnapshotAt: new Date(String(stage.backupSnapshotAt)) };
  const binding = input.binding ?? sourceStage;
  if (binding.target !== sourceStage.target || binding.destinationIdentity !== sourceStage.destinationIdentity ||
      !/^[a-f0-9]{40}$/.test(binding.commitSha) || !validHash(binding.backupManifestHash) ||
      !Number.isFinite(binding.backupSnapshotAt.getTime()) || binding.backupSnapshotAt.getTime() < sourceStage.backupSnapshotAt.getTime())
    fail("pending_stage_target_backup_or_commit_invalid");
  const mappingHash = sha256(pendingMappingFingerprintPayload());
  const sourceSpecHash = appSheetPendingImportSourceSpecHash();
  const records = await tx.legacySourceRecord.findMany({ where: { snapshotId: snapshot.id }, orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }],
    select: { id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true, fileHash: true, contentHash: true, importerVersion: true, treatment: true, original: true, normalized: true, resolution: true } });
  // The writer seals records in capture sheet/row order. Mapping resolutions are
  // separate review data; they cannot alter the original/normalized source projection.
  const sheetOrder = new Map((asObject(snapshot.coverage)?.sheets as Array<{ sourceTable: string }>)
    .map((sheet, index) => [sheet.sourceTable, index]));
  const sealedRecords = [...records].sort((left, right) =>
    (sheetOrder.get(left.sourceTable)! - sheetOrder.get(right.sourceTable)!) || left.sourceRow - right.sourceRow)
    .map(({ resolution: _resolution, ...record }) => record);
  if (sha256Canonical(sealedRecords, sha256) !== stage.recordsHash)
    fail("history_source_projection_content_changed");
  const coverage = asObject(snapshot.coverage);
  const coverageSheets = Array.isArray(coverage?.sheets)
    ? coverage.sheets.map(asObject).filter((sheet): sheet is Record<string, unknown> => sheet !== null)
    : [];
  for (const sourceTable of APPSHEET_PENDING_TABLES) {
    const tableRecords = records.filter(record => record.sourceTable === sourceTable);
    const tableCoverage = coverageSheets.filter(sheet => sheet.sourceTable === sourceTable);
    if (tableCoverage.length > 1 || (tableCoverage.length === 0
      ? tableRecords.length !== 0
      : tableCoverage[0]?.sourceRecordCount !== tableRecords.length))
      fail("pending_source_projection_incomplete");
    for (const record of tableRecords) {
      const normalized = asObject(record.normalized);
      const parsed = appSheetPendingReconciliationSchema.safeParse(normalized?.pendingReconciliation);
      const normalizedColumns = normalized?.columns;
      if (!parsed.success || !Array.isArray(normalizedColumns)) fail("pending_source_projection_incomplete");
      const expectedSourceKeyHash = sha256Canonical(["appsheet-pending-key-v1", record.sourceTable, record.sourceKey], sha256);
      if (!record.sourceKey || parsed.data.source.sourceKeyHash !== expectedSourceKeyHash)
        fail("pending_source_key_binding_mismatch");
      if (parsed.data.source.sourceTable !== record.sourceTable || parsed.data.source.sourceRow !== record.sourceRow)
        fail("pending_source_binding_mismatch");
      const expectedSourceEvidenceHash = sha256Canonical({ sourceTable: record.sourceTable, sourceRow: record.sourceRow,
        sourceKey: record.sourceKey, original: record.original, normalizedColumns }, sha256);
      if (parsed.data.source.sourceEvidenceHash !== expectedSourceEvidenceHash) fail("pending_source_binding_mismatch");
    }
  }
  const normalizedRecords = records.flatMap(record => {
    const candidate = asObject(record.normalized)?.pendingReconciliation;
    const parsed = appSheetPendingReconciliationSchema.safeParse(candidate);
    if (!parsed.success) return [];
    const expectedSourceKeyHash = sha256Canonical(["appsheet-pending-key-v1", record.sourceTable, record.sourceKey], sha256);
    if (!record.sourceKey || parsed.data.source.sourceKeyHash !== expectedSourceKeyHash) fail("pending_source_key_binding_mismatch");
    return [{
      sourceRecordId: record.id, sourceTable: record.sourceTable, sourceRow: record.sourceRow,
      sourceKeyHash: parsed.data.source.sourceKeyHash, sourceRecordHash: record.contentHash,
      reconciliationHash: sha256Canonical(parsed.data, sha256), reconciliation: parsed.data,
      sourceKey: record.sourceKey, original: record.original, normalized: record.normalized, resolution: record.resolution,
    }];
  });
  if (!normalizedRecords.length || normalizedRecords.length !== records.filter(record => {
    const candidate = asObject(record.normalized)?.pendingReconciliation;
    return candidate !== undefined;
  }).length) fail("pending_source_projection_incomplete");
  if (normalizedRecords.some(row => row.reconciliation.schemaVersion !== APPSHEET_PENDING_SCHEMA_VERSION ||
      row.reconciliation.capture.captureId !== capture.captureId || row.reconciliation.capture.manifestHash !== capture.manifestHash ||
      row.reconciliation.capture.mode !== "stable" || row.reconciliation.capture.provisional || row.reconciliation.mappingHash !== mappingHash))
    fail("pending_reconciliation_capture_or_mapping_mismatch");

  const sourceIdentities = new Set<string>();
  for (const row of normalizedRecords) {
    const identity = `${row.sourceTable}\0${row.sourceKey}`;
    if (sourceIdentities.has(identity)) fail("pending_source_key_duplicated");
    sourceIdentities.add(identity);
  }
  const historyRecordsHash = sha256Canonical(records.map(row => [row.id, row.contentHash, row.sourceTable, row.sourceRow]), sha256);
  const sources: AppSheetPendingImportSource[] = normalizedRecords.map(row => ({
    sourceRecordId: row.sourceRecordId, sourceTable: row.sourceTable, sourceRow: row.sourceRow,
    sourceKeyHash: row.sourceKeyHash, sourceRecordHash: row.sourceRecordHash,
    reconciliationHash: row.reconciliationHash, reconciliation: row.reconciliation,
  }));
  const dispositions = deriveAppSheetPendingImportDispositions(sources, sha256);
  const batchId = batchIdFor(snapshot.id, mappingHash, sourceSpecHash);

  // A receivable becomes a separate historical settlement only when an exact, already approved invoice-to-order identity exists.
  const settlements: AppSheetPendingImportPlan["materializedSettlements"] = [];
  const duplicateOrderMappingSourceIds = new Set<string>();
  for (const row of normalizedRecords) {
    const classification = row.reconciliation.dimensions.receivable;
    if (row.sourceTable !== "C_Facturacion" || classification.status !== "confirmed_pending" || !classification.settlement) continue;
    let settlement: ReturnType<typeof validatedLegacySettlement>;
    try { settlement = validatedLegacySettlement(row.reconciliation, sha256); }
    catch (error) { fail(error instanceof AppSheetPendingImportError ? error.code : "pending_receivable_invalid"); }
    if (!row.sourceKey || row.sourceKey.startsWith("synthetic:")) continue;
    const identities = await tx.legacyIdentity.findMany({ where: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceTable: "C_Facturacion", sourceKey: row.sourceKey,
      destinationType: "order", approvedBy: { not: null },
    }, select: { id: true, destinationId: true, approvedBy: true } });
    if (identities.length !== 1 || !identities[0]?.approvedBy) continue;
    const competingIdentity = await tx.legacyIdentity.findFirst({ where: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceTable: "C_Facturacion", destinationType: "order",
      destinationId: identities[0].destinationId, sourceKey: { not: row.sourceKey },
    }, select: { id: true } });
    if (competingIdentity) {
      duplicateOrderMappingSourceIds.add(row.sourceRecordId);
      continue;
    }
    const reviewer = await tx.user.findFirst({ where: { id: identities[0].approvedBy, active: true }, select: { id: true } });
    if (!reviewer || reviewer.id === snapshot.createdBy) continue;
    const resolution = asObject(row.resolution);
    if (resolution?.status !== "mapped-to-existing-order" || resolution.destinationType !== "order" ||
        resolution.destinationId !== identities[0].destinationId || resolution.approvedBy !== reviewer.id ||
        typeof resolution.evidence !== "string" || !resolution.evidence.trim() ||
        resolution.sourceRecordHash !== row.sourceRecordHash || resolution.reconciliationHash !== row.reconciliationHash ||
        resolution.mappingHash !== mappingHash || !validHash(resolution.evidenceHash) || sha256(resolution.evidence) !== resolution.evidenceHash) continue;
    const orderMappingEvidenceHash = sha256(resolution.evidence);
    const order = await tx.operationOrder.findUnique({ where: { id: identities[0].destinationId }, select: {
      id: true, memberId: true, channel: true, currency: true, quoteVersion: true, quote: true, address: true,
      subtotalMinor: true, discountMinor: true, deliveryMinor: true, deliveryDiscountMinor: true, surchargeMinor: true,
      totalMinor: true, sourceSystem: true, sourceId: true, legacySaleId: true, commercialState: true,
      lines: { orderBy: { id: "asc" }, select: { id: true, skuId: true, unit: true, requested: true, unitPrice: true,
        referenceMinor: true, discountMinor: true, revenueMinor: true, policyId: true, policyVersion: true, packId: true, packCount: true } },
    } });
    if (!order || order.currency !== settlement.currency || order.totalMinor !== settlement.dueMinor ||
        !["confirmed", "cancelled"].includes(order.commercialState)) continue;
    const commercialBasisHash = appSheetPendingOrderCommercialBasisHash(order);
    if (!commercialBasisHash) continue;
    const orderObject = await tx.operationObject.findUnique({ where: { id: order.id }, select: { kind: true } });
    if (!orderObject || orderObject.kind !== "order") continue;
    const dispositionId = dispositionIdFor(batchId, row.sourceRecordId, "receivable");
    const conflictingSettlement = await tx.appSheetLegacySettlement.findFirst({ where: { operationOrderId: order.id }, select: { batchId: true } });
    if (conflictingSettlement && conflictingSettlement.batchId !== batchId) {
      duplicateOrderMappingSourceIds.add(row.sourceRecordId);
      continue;
    }
    // The source identity review proves which order version was inspected then. Later
    // legitimate receipts/refunds change that version; bind the invariant financial
    // basis separately so they do not erase an approved legacy settlement.
    if (typeof resolution.operationOrderVersion !== "number" || !Number.isSafeInteger(resolution.operationOrderVersion) || resolution.operationOrderVersion < 1 ||
        !validHash(resolution.operationOrderHash)) continue;
    const financialBasisHash = appSheetLegacyFinancialBasisHash({ orderId: order.id, memberId: order.memberId,
      currency: order.currency, totalMinor: order.totalMinor, commercialBasisHash, captureId: capture.captureId,
      sourceRecordId: row.sourceRecordId, sourceRecordHash: row.sourceRecordHash, sourceKeyHash: row.sourceKeyHash,
      reconciliationHash: row.reconciliationHash, mappingHash, mappingReviewerId: reviewer.id,
      mappingEvidenceHash: orderMappingEvidenceHash, mappedOrderVersion: resolution.operationOrderVersion as number,
      mappedOrderHash: resolution.operationOrderHash as string });
    const destHash = sha256Canonical({
      kind: "legacy-settlement", captureId: capture.captureId, manifestHash: capture.manifestHash,
      sourceRecordId: row.sourceRecordId, sourceRecordHash: row.sourceRecordHash,
      reconciliationHash: row.reconciliationHash, mappingHash,
      operationOrderId: order.id, operationOrderMemberId: order.memberId, financialBasisHash,
      operationOrderVersion: resolution.operationOrderVersion, operationOrderHash: resolution.operationOrderHash,
      orderMappingReviewerId: reviewer.id, orderMappingEvidenceHash,
      operationOrderCurrency: order.currency, operationOrderTotalMinor: order.totalMinor.toString(),
      dueMinor: settlement.dueMinor.toString(), legacyPaidMinor: settlement.legacyPaidMinor.toString(),
      remainingMinor: settlement.remainingMinor.toString(), paymentRowsHash: classification.settlement.paymentRowsHash,
      paymentReferences: settlement.paymentReferences,
    }, sha256);
    settlements.push({ dispositionId, sourceRecordId: row.sourceRecordId, sourceRecordHash: row.sourceRecordHash,
      reconciliationHash: row.reconciliationHash, sourceKeyHash: row.sourceKeyHash, operationOrderId: order.id,
      currency: settlement.currency, dueMinor: settlement.dueMinor, legacyPaidMinor: settlement.legacyPaidMinor,
      remainingMinor: settlement.remainingMinor, paymentRowsHash: classification.settlement.paymentRowsHash,
      paymentReferences: settlement.paymentReferences, destinationHash: destHash,
      operationOrderMemberId: order.memberId, financialBasisHash,
      operationOrderVersion: resolution.operationOrderVersion as number,
      operationOrderHash: resolution.operationOrderHash as string, orderMappingReviewerId: reviewer.id,
      orderMappingEvidenceHash });
  }
  // C_Moto can only become an unassigned pending delivery when its exact invoice reference,
  // physical invoice address cell, and independently approved invoice-to-order link all agree.
  const deliveryCandidates: AppSheetPendingImportPlan["materializedDeliveries"] = [];
  const deliveryCardinalityCandidates: { sourceRecordId: string; operationOrderId: string }[] = [];
  const sourceRecordById = new Map(records.map(record => [record.id, record]));
  const sourceRecordIdByCoordinate = new Map(normalizedRecords.map(row => [`${row.sourceTable}\0${row.sourceRow}`, row.sourceRecordId]));
  const relatedMotoInvoiceCandidates: { sourceRecordId: string; invoiceSourceRecordId: string | null; confirmedPending: boolean }[] = [];
  for (const row of normalizedRecords) {
    if (row.sourceTable !== "C_Moto") continue;
    const invoiceRelationship = row.reconciliation.dimensions.delivery.relationships.find(relationship =>
      relationship.sourceField === APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.invoiceRef.field &&
      relationship.targetTable === APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.invoiceRef.table &&
      relationship.targetField === APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.invoiceRef.key);
    const target = invoiceRelationship?.status === "unique" ? invoiceRelationship.target : undefined;
    const invoiceRecordId = target ? sourceRecordIdByCoordinate.get(`${target.sourceTable}\0${target.sourceRow}`) : undefined;
    relatedMotoInvoiceCandidates.push({ sourceRecordId: row.sourceRecordId, invoiceSourceRecordId: invoiceRecordId ?? null,
      confirmedPending: row.reconciliation.dimensions.delivery.status === "confirmed_pending" });
  }
  const ambiguousRelatedPendingMotoSourceIds = appSheetPendingDeliveryInvoiceCardinalityAmbiguities(relatedMotoInvoiceCandidates);
  for (const row of normalizedRecords) {
    const classification = row.reconciliation.dimensions.delivery;
    if (row.sourceTable !== "C_Moto" || classification.status !== "confirmed_pending") continue;
    const parsedResolution = appSheetPendingDeliveryResolutionSchema.safeParse(row.resolution);
    if (!parsedResolution.success) continue;
    const resolution = parsedResolution.data;
    if (resolution.sourceRecordId !== row.sourceRecordId || resolution.sourceRecordHash !== row.sourceRecordHash ||
        resolution.reconciliationHash !== row.reconciliationHash || resolution.mappingHash !== mappingHash ||
        resolution.sourceSpecHash !== sourceSpecHash || resolution.evidenceHash !== sha256(resolution.evidence) || !resolution.evidence.trim()) continue;
    const resolutionReceipt = await tx.commandReceipt.findUnique({ where: { requestId: resolution.requestId }, select: {
      requestId: true, actorId: true, targetId: true, command: true, resultingVersion: true, response: true,
    } });
    const resolutionReceiptResult = asObject(asObject(resolutionReceipt?.response)?.result);
    const snapshotObject = await tx.operationObject.findUnique({ where: { id: snapshot.id }, select: { kind: true, version: true } });
    if (!resolutionReceipt || resolutionReceipt.command !== "AppSheetPendingDeliveryResolved" || resolutionReceipt.targetId !== snapshot.id ||
        resolutionReceipt.actorId !== resolution.approvedBy || !snapshotObject || snapshotObject.kind !== "legacyImport" ||
        snapshotObject.version < resolutionReceipt.resultingVersion || resolutionReceiptResult?.sourceRecordId !== row.sourceRecordId ||
        resolutionReceiptResult?.resolutionHash !== sha256Canonical(resolution, sha256)) continue;
    const invoice = sourceRecordById.get(resolution.invoiceRecordId);
    if (!invoice || invoice.sourceTable !== "C_Facturacion" || !invoice.sourceKey || invoice.sourceKey.startsWith("synthetic:") ||
        invoice.contentHash !== resolution.invoiceRecordHash) continue;
    const moto = sourceRecordById.get(row.sourceRecordId);
    if (!moto || moto.sourceTable !== "C_Moto" || moto.contentHash !== row.sourceRecordHash) continue;
    const motoKey = reviewedSourceCell(moto, resolution.motoKeyCell,
      APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.key);
    const invoiceReference = reviewedSourceCell(moto, resolution.invoiceReferenceCell,
      APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.invoiceRef.field);
    const invoiceKey = reviewedSourceCell(invoice, resolution.invoiceKeyCell,
      APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.invoiceRef.key);
    const invoiceAddress = reviewedSourceCell(invoice, resolution.invoiceAddressCell,
      APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.address.sourceField);
    if (!motoKey || motoKey !== row.sourceKey || !invoiceReference || !invoiceKey || !invoiceAddress ||
        !appSheetDeliveryInvoiceReferenceMatches(invoiceReference, invoiceKey))
      continue;
    const invoiceKeyHash = sha256Canonical(["appsheet-pending-invoice-key-v1", invoice.sourceKey], sha256);
    const identityRows = await tx.legacyIdentity.findMany({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      sourceTable: "C_Facturacion", sourceKey: invoice.sourceKey, destinationType: "order", approvedBy: { not: null } },
      select: { destinationId: true, approvedBy: true } });
    if (identityRows.length !== 1 || !identityRows[0]?.approvedBy || identityRows[0].destinationId !== resolution.operationOrderId)
      continue;
    const orderMappingReviewer = await tx.user.findFirst({ where: { id: identityRows[0].approvedBy, active: true }, select: { id: true } });
    const resolutionReviewer = await tx.user.findFirst({ where: { id: resolution.approvedBy, active: true }, select: { id: true } });
    if (!orderMappingReviewer || !resolutionReviewer || resolutionReviewer.id !== resolution.approvedBy ||
        resolutionReviewer.id === snapshot.createdBy || orderMappingReviewer.id === snapshot.createdBy) continue;
    const order = await tx.operationOrder.findUnique({ where: { id: resolution.operationOrderId }, select: {
      id: true, memberId: true, channel: true, currency: true, totalMinor: true, commercialState: true,
    } });
    const orderObject = await tx.operationObject.findUnique({ where: { id: resolution.operationOrderId }, select: { kind: true } });
    if (!order || order.channel !== "delivery" || order.commercialState !== "confirmed" || !orderObject || orderObject.kind !== "order")
      continue;
    if (typeof resolution.operationOrderVersion !== "number" || !Number.isSafeInteger(resolution.operationOrderVersion) || resolution.operationOrderVersion < 1 ||
        !validHash(resolution.operationOrderHash)) continue;
    const dispositionId = dispositionIdFor(batchId, row.sourceRecordId, "delivery");
    const destinationId = deliveryAssignmentIdFor(dispositionId);
    const address = { address: invoiceAddress, source: "appsheet-pending-import", captureId: capture.captureId,
      invoiceSourceRecordId: invoice.id, invoiceSourceRecordHash: invoice.contentHash,
      invoiceAddressCoordinate: resolution.invoiceAddressCell.coordinate };
    const resolutionEvidenceHash = resolution.evidenceHash;
    const destHash = sha256Canonical({ kind: "delivery_assignment", id: destinationId, orderId: order.id,
      sourceRecordId: row.sourceRecordId, sourceRecordHash: row.sourceRecordHash, reconciliationHash: row.reconciliationHash,
      sourceKeyHash: row.sourceKeyHash, captureId: capture.captureId, invoiceRecordId: invoice.id,
      invoiceRecordHash: invoice.contentHash, invoiceKeyHash, motoKeyCell: resolution.motoKeyCell, invoiceReferenceCell: resolution.invoiceReferenceCell,
      invoiceKeyCell: resolution.invoiceKeyCell,
      invoiceAddressCell: resolution.invoiceAddressCell, address,
      operationOrderMemberId: order.memberId, operationOrderCurrency: order.currency, operationOrderTotalMinor: order.totalMinor.toString(),
      operationOrderCommercialState: order.commercialState,
      operationOrderVersion: resolution.operationOrderVersion, operationOrderHash: resolution.operationOrderHash,
      orderMappingReviewerId: orderMappingReviewer.id,
      resolutionReviewerId: resolutionReviewer.id, resolutionEvidenceHash,
      status: "pending", routeId: null, driverId: null, stopSequence: 0, dispatchedAt: null, deliveredAt: null }, sha256);
    deliveryCardinalityCandidates.push({ sourceRecordId: row.sourceRecordId, operationOrderId: order.id });
    const existingAssignments = await tx.deliveryAssignment.findMany({ where: { orderId: order.id }, select: {
      id: true, status: true, routeId: true, driverId: true, stopSequence: true, address: true, incidents: true,
      dispatchedAt: true, deliveredAt: true,
    } });
    if (existingAssignments.length) {
      if (existingAssignments.length !== 1 || existingAssignments[0]!.id !== destinationId ||
          existingAssignments[0]!.status !== "pending" || existingAssignments[0]!.routeId !== null ||
          existingAssignments[0]!.driverId !== null || existingAssignments[0]!.stopSequence !== 0 ||
          canonicalJson(existingAssignments[0]!.incidents) !== canonicalJson([]) ||
          existingAssignments[0]!.dispatchedAt !== null || existingAssignments[0]!.deliveredAt !== null ||
          canonicalJson(existingAssignments[0]!.address) !== canonicalJson(address)) continue;
      const deliveryObject = await tx.operationObject.findUnique({ where: { id: destinationId }, select: { kind: true, version: true } });
      if (!deliveryObject || deliveryObject.kind !== "delivery" || deliveryObject.version !== 1) continue;
    }
    deliveryCandidates.push({ dispositionId, sourceRecordId: row.sourceRecordId, sourceRecordHash: row.sourceRecordHash,
      reconciliationHash: row.reconciliationHash, sourceKeyHash: row.sourceKeyHash, invoiceRecordId: invoice.id,
      invoiceRecordHash: invoice.contentHash, invoiceKeyHash, invoiceReferenceCell: resolution.invoiceReferenceCell,
      motoKeyCell: resolution.motoKeyCell, invoiceKeyCell: resolution.invoiceKeyCell, invoiceAddressCell: resolution.invoiceAddressCell,
      operationOrderId: order.id, operationOrderVersion: resolution.operationOrderVersion as number,
      operationOrderHash: resolution.operationOrderHash as string, destinationId, destinationHash: destHash, address,
      orderMappingReviewerId: orderMappingReviewer.id, resolutionReviewerId: resolutionReviewer.id, resolutionEvidenceHash });
  }
  const ambiguousDeliverySourceIds = appSheetPendingDeliveryCardinalityAmbiguities(deliveryCardinalityCandidates);
  for (const sourceRecordId of ambiguousRelatedPendingMotoSourceIds) ambiguousDeliverySourceIds.add(sourceRecordId);
  const materializedDeliveries = deliveryCandidates.filter(delivery => !ambiguousDeliverySourceIds.has(delivery.sourceRecordId));
  const settlementByRecord = new Map(settlements.map(row => [row.sourceRecordId, row]));
  const deliveryByRecord = new Map(materializedDeliveries.map(row => [row.sourceRecordId, row]));
  const readyDispositions = dispositions.map(row => {
    if (row.dimension === "receivable" && duplicateOrderMappingSourceIds.has(row.sourceRecordId))
      return { ...row, state: "blocked" as const, reason: DUPLICATE_ORDER_DESTINATION_REASON,
        destinationType: null, destinationId: null, destinationVersion: null, destinationHash: null };
    if (row.dimension === "delivery" && ambiguousDeliverySourceIds.has(row.sourceRecordId))
      return { ...row, state: "blocked" as const, reason: APPSHEET_PENDING_DELIVERY_CARDINALITY_REVIEW_REASON,
        destinationType: null, destinationId: null, destinationVersion: null, destinationHash: null };
    const settlement = settlementByRecord.get(row.sourceRecordId);
    if (row.dimension === "receivable" && settlement) return { ...row, state: "materialized" as const, reason: null, destinationType: "legacy_settlement" as const,
      destinationId: settlementIdFor(settlement.dispositionId), destinationVersion: 1, destinationHash: settlement.destinationHash };
    const delivery = deliveryByRecord.get(row.sourceRecordId);
    if (row.dimension === "delivery" && delivery) return { ...row, state: "materialized" as const, reason: null, destinationType: "delivery_assignment" as const,
      destinationId: delivery.destinationId, destinationVersion: 1, destinationHash: delivery.destinationHash };
    return row;
  });
  const sourceCoverageHash = sha256Canonical({ sourceSpecHash, records: sources.map(row => [row.sourceRecordId, row.sourceTable, row.sourceRow,
    row.sourceRecordHash, row.reconciliationHash, row.reconciliation.mappingHash]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) }, sha256);
  const dispositionHash = sha256Canonical(readyDispositions, sha256);
  const destinationHash = sha256Canonical({ settlements: settlements.map(({ dueMinor, legacyPaidMinor, remainingMinor, ...row }) => ({
    ...row, dueMinor: dueMinor.toString(), legacyPaidMinor: legacyPaidMinor.toString(), remainingMinor: remainingMinor.toString(),
  })).sort((a, b) => a.dispositionId.localeCompare(b.dispositionId)), deliveries: materializedDeliveries
    .map(({ address, ...row }) => ({ ...row, addressHash: sha256Canonical(address, sha256) }))
    .sort((a, b) => a.dispositionId.localeCompare(b.dispositionId)) }, sha256);
  const planBase = {
    batchId, captureId: capture.captureId, manifestHash: capture.manifestHash, dataHash: capture.dataHash,
    historySnapshotId: snapshot.id, historyRecordsHash, target: binding.target, destinationIdentity: binding.destinationIdentity,
    commitSha: binding.commitSha, backupManifestHash: binding.backupManifestHash, backupSnapshotAt: binding.backupSnapshotAt,
    mappingHash, sourceSpecHash, sourceCoverageHash,
    dispositions: readyDispositions, materializedSettlements: settlements, materializedDeliveries, dispositionHash, destinationHash,
  };
  return { ...planBase, projectionHash: planProjectionHash(planBase) };
}

function expectedReviewBinding(plan: AppSheetPendingImportPlan) {
  return {
    captureId: plan.captureId, manifestHash: plan.manifestHash, dataHash: plan.dataHash,
    mappingHash: plan.mappingHash, sourceSpecHash: plan.sourceSpecHash, sourceCoverageHash: plan.sourceCoverageHash,
    dispositionHash: plan.dispositionHash, destinationHash: plan.destinationHash,
    destinationVersion: 1, projectionHash: plan.projectionHash,
    target: plan.target, destinationIdentity: plan.destinationIdentity, commitSha: plan.commitSha,
    backupManifestHash: plan.backupManifestHash, backupSnapshotAt: plan.backupSnapshotAt.toISOString(),
  } as const;
}

function requireUnambiguousPendingDeliveryOrders(plan: AppSheetPendingImportPlan): void {
  if (plan.dispositions.some(disposition => disposition.dimension === "delivery" &&
      disposition.reason === APPSHEET_PENDING_DELIVERY_CARDINALITY_REVIEW_REASON))
    fail("pending_delivery_order_cardinality_requires_review");
}

function sameStoredDisposition(stored: {
  id: string; sourceRecordId: string; sourceTable: string; sourceRow: number; sourceRecordHash: string;
  reconciliationHash: string; mappingHash: string; dimension: string; sourceStatus: string; state: string;
  reason: string | null; destinationType: string | null; destinationId: string | null; destinationVersion: number | null; destinationHash: string | null;
}, batchId: string, expected: AppSheetPendingImportDisposition): boolean {
  return stored.id === dispositionIdFor(batchId, expected.sourceRecordId, expected.dimension) &&
    stored.sourceRecordId === expected.sourceRecordId && stored.sourceTable === expected.sourceTable && stored.sourceRow === expected.sourceRow &&
    stored.sourceRecordHash === expected.sourceRecordHash && stored.reconciliationHash === expected.reconciliationHash &&
    stored.mappingHash === expected.mappingHash && stored.dimension === expected.dimension && stored.sourceStatus === expected.sourceStatus &&
    stored.state === expected.state && stored.reason === expected.reason && stored.destinationType === expected.destinationType &&
    stored.destinationId === expected.destinationId && stored.destinationVersion === expected.destinationVersion &&
    stored.destinationHash === expected.destinationHash;
}

function sameStoredSettlement(stored: {
  id: string; batchId: string; dispositionId: string; sourceRecordId: string; sourceRecordHash: string; reconciliationHash: string;
  mappingHash: string; captureId: string; sourceKeyHash: string; operationOrderId: string; operationOrderMemberId: string;
  financialBasisHash: string; operationOrderVersion: number;
  operationOrderHash: string; orderMappingReviewerId: string; orderMappingEvidenceHash: string; currency: string; dueMinor: bigint; legacyPaidMinor: bigint;
  remainingMinor: bigint; paymentRowsHash: string; paymentReferences: unknown; destinationHash: string; destinationVersion: number;
}, batchId: string, captureId: string, mappingHash: string, expected: AppSheetPendingImportPlan["materializedSettlements"][number]): boolean {
  return stored.id === settlementIdFor(expected.dispositionId) && stored.batchId === batchId && stored.dispositionId === expected.dispositionId &&
    stored.sourceRecordId === expected.sourceRecordId && stored.sourceRecordHash === expected.sourceRecordHash &&
    stored.reconciliationHash === expected.reconciliationHash && stored.mappingHash === mappingHash && stored.captureId === captureId &&
    stored.sourceKeyHash === expected.sourceKeyHash && stored.operationOrderId === expected.operationOrderId &&
    stored.operationOrderMemberId === expected.operationOrderMemberId && stored.financialBasisHash === expected.financialBasisHash &&
    stored.operationOrderVersion === expected.operationOrderVersion && stored.operationOrderHash === expected.operationOrderHash &&
    stored.orderMappingReviewerId === expected.orderMappingReviewerId && stored.orderMappingEvidenceHash === expected.orderMappingEvidenceHash &&
    stored.currency === expected.currency &&
    stored.dueMinor === expected.dueMinor && stored.legacyPaidMinor === expected.legacyPaidMinor && stored.remainingMinor === expected.remainingMinor &&
    stored.paymentRowsHash === expected.paymentRowsHash && canonicalJson(stored.paymentReferences) === canonicalJson(expected.paymentReferences) &&
    stored.destinationHash === expected.destinationHash && stored.destinationVersion === 1;
}

async function assertPendingDeliveryDestinations(tx: Tx, plan: AppSheetPendingImportPlan): Promise<void> {
  for (const delivery of plan.materializedDeliveries) {
    const [assignments, object] = await Promise.all([
      tx.deliveryAssignment.findMany({ where: { orderId: delivery.operationOrderId }, select: {
        id: true, orderId: true, routeId: true, driverId: true, status: true, stopSequence: true,
        address: true, incidents: true, dispatchedAt: true, deliveredAt: true,
      } }),
      tx.operationObject.findUnique({ where: { id: delivery.destinationId }, select: { kind: true, version: true } }),
    ]);
    const assignment = assignments[0];
    const expected = {
      id: delivery.destinationId, orderId: delivery.operationOrderId, routeId: null, driverId: null,
      status: "pending", stopSequence: 0, address: delivery.address, incidents: [], dispatchedAt: null, deliveredAt: null,
    };
    if (assignments.length !== 1 || !assignment || canonicalJson(assignment) !== canonicalJson(expected) ||
        !object || object.kind !== "delivery" || object.version !== 1)
      fail("pending_delivery_destination_binding_changed");
  }
}

async function assertPendingDeliveryDestinationsAbsent(tx: Tx, plan: AppSheetPendingImportPlan): Promise<void> {
  for (const delivery of plan.materializedDeliveries) {
    const [assignments, object] = await Promise.all([
      tx.deliveryAssignment.findMany({ where: { orderId: delivery.operationOrderId }, select: { id: true } }),
      tx.operationObject.findUnique({ where: { id: delivery.destinationId }, select: { id: true } }),
    ]);
    if (assignments.length || object) fail("pending_delivery_destination_preexists_before_review");
  }
}

async function materializeReviewedPendingDeliveries(ctx: CommandContext, plan: AppSheetPendingImportPlan): Promise<void> {
  await assertPendingDeliveryDestinationsAbsent(ctx.tx, plan);
  for (const delivery of plan.materializedDeliveries) {
    await ctx.tx.deliveryAssignment.create({ data: {
      id: delivery.destinationId, orderId: delivery.operationOrderId, routeId: null, driverId: null,
      status: "pending", stopSequence: 0, address: delivery.address as Prisma.InputJsonValue,
      incidents: [] as Prisma.InputJsonArray,
    } });
    await ctx.tx.operationObject.create({ data: {
      id: delivery.destinationId, kind: "delivery", version: 1, createdBy: ctx.actor.id,
    } });
  }
}

function assertStoredPlanMatches(batch: {
  id: string; captureId: string; manifestHash: string; dataHash: string; snapshotId: string; historyRecordsHash: string;
  projectionHash: string; mappingHash: string; sourceSpecHash: string; sourceCoverageHash: string; dispositionHash: string; destinationHash: string;
  destinationVersion: number; target: string; destinationIdentity: string; commitSha: string; backupManifestHash: string;
  backupSnapshotAt: Date; dispositionCount: number;
  dispositions: Array<Parameters<typeof sameStoredDisposition>[0]>;
  settlements: Array<Parameters<typeof sameStoredSettlement>[0]>;
}, plan: AppSheetPendingImportPlan) {
  if (batch.id !== plan.batchId || batch.captureId !== plan.captureId || batch.manifestHash !== plan.manifestHash ||
      batch.dataHash !== plan.dataHash || batch.snapshotId !== plan.historySnapshotId || batch.historyRecordsHash !== plan.historyRecordsHash ||
      batch.projectionHash !== plan.projectionHash || batch.mappingHash !== plan.mappingHash || batch.sourceSpecHash !== plan.sourceSpecHash ||
      batch.sourceCoverageHash !== plan.sourceCoverageHash ||
      batch.dispositionHash !== plan.dispositionHash || batch.destinationHash !== plan.destinationHash || batch.destinationVersion !== 1 ||
      batch.target !== plan.target || batch.destinationIdentity !== plan.destinationIdentity || batch.commitSha !== plan.commitSha ||
      batch.backupManifestHash !== plan.backupManifestHash || batch.backupSnapshotAt.getTime() !== plan.backupSnapshotAt.getTime() ||
      batch.dispositionCount !== plan.dispositions.length || batch.dispositions.length !== plan.dispositions.length ||
      batch.settlements.length !== plan.materializedSettlements.length ||
      plan.dispositions.filter(row => row.state === "materialized").length !==
        plan.materializedSettlements.length + plan.materializedDeliveries.length)
    fail("pending_import_stored_plan_mismatch");
  if (batch.dispositions.some(stored => {
    const expected = plan.dispositions.find(row => dispositionIdFor(plan.batchId, row.sourceRecordId, row.dimension) === stored.id);
    return !expected || !sameStoredDisposition(stored, plan.batchId, expected);
  }) || batch.settlements.some(stored => {
    const expected = plan.materializedSettlements.find(row => settlementIdFor(row.dispositionId) === stored.id);
    return !expected || !sameStoredSettlement(stored, plan.batchId, plan.captureId, plan.mappingHash, expected);
  })) fail("pending_import_stored_disposition_or_destination_mismatch");
}

async function persistAppSheetPendingImportPlan(
  ctx: CommandContext, plan: AppSheetPendingImportPlan, review: unknown,
): Promise<{ batchId: string; replay: boolean }> {
  const tx = ctx.tx;
  const actorId = ctx.actor.id;
  const existing = await tx.appSheetPendingImportBatch.findUnique({ where: { id: plan.batchId }, include: { dispositions: true, settlements: true } });
  if (existing) fail("pending_import_batch_exists_replay_same_command_receipt");
  const snapshot = await tx.legacyImportSnapshot.findUniqueOrThrow({ where: { id: plan.historySnapshotId }, select: { id: true, createdBy: true, reviewedBy: true, status: true } });
  if (snapshot.status !== "reviewed") fail("reviewed_history_snapshot_required");
  if (snapshot.reviewedBy === actorId) fail("pending_import_author_must_differ_from_history_reviewer");
  if (plan.materializedSettlements.some(settlement => settlement.orderMappingReviewerId === actorId) ||
      plan.materializedDeliveries.some(delivery => [delivery.orderMappingReviewerId, delivery.resolutionReviewerId].includes(actorId)))
    fail("pending_import_author_must_differ_from_order_mapping_reviewer");
  if (plan.dispositions.filter(row => row.state === "materialized").length !==
      plan.materializedSettlements.length + plan.materializedDeliveries.length)
    fail("pending_materialization_coverage_mismatch");
  await tx.appSheetPendingImportBatch.create({ data: {
    id: plan.batchId, snapshotId: plan.historySnapshotId, captureId: plan.captureId, projectionHash: plan.projectionHash,
    manifestHash: plan.manifestHash,
    dataHash: plan.dataHash, historyRecordsHash: plan.historyRecordsHash, mappingId: APPSHEET_PENDING_MAPPING_ID,
    mappingHash: plan.mappingHash, sourceSpecHash: plan.sourceSpecHash, sourceCoverageHash: plan.sourceCoverageHash, dispositionHash: plan.dispositionHash,
    destinationHash: plan.destinationHash, destinationVersion: 1, target: plan.target, destinationIdentity: plan.destinationIdentity,
    commitSha: plan.commitSha, backupManifestHash: plan.backupManifestHash, backupSnapshotAt: plan.backupSnapshotAt,
    stageReview: review as Prisma.InputJsonValue, sourceRecordCount: plan.dispositions.length / 4,
    dispositionCount: plan.dispositions.length, status: "staged", createdBy: actorId,
    dispositions: { create: plan.dispositions.map(row => ({ id: dispositionIdFor(plan.batchId, row.sourceRecordId, row.dimension),
      sourceRecordId: row.sourceRecordId, sourceTable: row.sourceTable, sourceRow: row.sourceRow,
      sourceRecordHash: row.sourceRecordHash, reconciliationHash: row.reconciliationHash, mappingHash: row.mappingHash,
      dimension: row.dimension, sourceStatus: row.sourceStatus, state: row.state, reason: row.reason,
      destinationType: row.destinationType, destinationId: row.destinationId, destinationVersion: row.destinationVersion,
      destinationHash: row.destinationHash })) },
  } });
  for (const settlement of plan.materializedSettlements) {
    const id = settlementIdFor(settlement.dispositionId);
    await tx.appSheetLegacySettlement.create({ data: {
      id, batchId: plan.batchId, dispositionId: settlement.dispositionId, sourceRecordId: settlement.sourceRecordId,
      sourceRecordHash: settlement.sourceRecordHash, reconciliationHash: settlement.reconciliationHash,
      mappingHash: plan.mappingHash, captureId: plan.captureId, sourceKeyHash: settlement.sourceKeyHash,
      operationOrderId: settlement.operationOrderId, operationOrderMemberId: settlement.operationOrderMemberId,
      financialBasisHash: settlement.financialBasisHash, currency: settlement.currency,
      dueMinor: settlement.dueMinor, legacyPaidMinor: settlement.legacyPaidMinor, remainingMinor: settlement.remainingMinor,
      paymentRowsHash: settlement.paymentRowsHash, paymentReferences: settlement.paymentReferences as Prisma.InputJsonValue,
      operationOrderVersion: settlement.operationOrderVersion, operationOrderHash: settlement.operationOrderHash,
      orderMappingReviewerId: settlement.orderMappingReviewerId, orderMappingEvidenceHash: settlement.orderMappingEvidenceHash,
      destinationHash: settlement.destinationHash, destinationVersion: 1, status: "staged", createdBy: actorId,
    } });
  }
  await audit(ctx, "appsheet.pending_import_staged", { captureId: plan.captureId, manifestHash: plan.manifestHash, historySnapshotId: plan.historySnapshotId,
      mappingHash: plan.mappingHash, sourceSpecHash: plan.sourceSpecHash, sourceCoverageHash: plan.sourceCoverageHash, dispositionHash: plan.dispositionHash,
      destinationHash: plan.destinationHash, projectionHash: plan.projectionHash, target: plan.target,
      destinationIdentity: plan.destinationIdentity, commitSha: plan.commitSha, backupManifestHash: plan.backupManifestHash,
      sourceRecordCount: plan.dispositions.length / 4,
      dispositionCount: plan.dispositions.length, materializedSettlementCount: plan.materializedSettlements.length,
      pendingDeliveryAssignmentCount: 0,
      effects: { stock: false, cashLedger: false, payments: false, dispatches: false, deliveryConfirmations: false,
        messages: false, documents: false, numbering: "not-generated" } });
  return { batchId: plan.batchId, replay: false };
}

const orderIdentityReviewSchema = z.strictObject({
  sourceRecordId: z.string().min(1).max(100),
  sourceRecordHash: z.string().regex(/^[a-f0-9]{64}$/),
  reconciliationHash: z.string().regex(/^[a-f0-9]{64}$/),
  mappingHash: z.string().regex(/^[a-f0-9]{64}$/),
  operationOrderId: z.string().min(1).max(100),
  operationOrderVersion: z.number().int().nonnegative(),
  operationOrderHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.string().trim().min(3).max(1000),
});

registerCommand("AppSheetPendingOrderIdentityReviewed", {
  kind: "legacyImport", capability: "imports.review", administrative: true, internal: false, transactionTimeoutMs: 30_000,
  schema: orderIdentityReviewSchema,
  execute: async ctx => {
    const value = ctx.envelope.data as z.infer<typeof orderIdentityReviewSchema>;
    const plan = await prepareAppSheetPendingImportPlan(ctx.tx, { snapshotId: ctx.envelope.targetId });
    const sourceDisposition = plan.dispositions.find(row => row.sourceRecordId === value.sourceRecordId && row.dimension === "receivable");
    if (!sourceDisposition || sourceDisposition.sourceTable !== "C_Facturacion" || sourceDisposition.sourceStatus !== "confirmed_pending")
      fail("pending_order_mapping_requires_confirmed_invoice_receivable");
    if (sourceDisposition.sourceRecordHash !== value.sourceRecordHash || sourceDisposition.reconciliationHash !== value.reconciliationHash ||
        sourceDisposition.mappingHash !== value.mappingHash)
      fail("pending_order_mapping_source_changed");
    const source = await ctx.tx.legacySourceRecord.findFirst({ where: { id: value.sourceRecordId, snapshotId: ctx.envelope.targetId },
      select: { sourceTable: true, sourceKey: true, sourceRow: true, contentHash: true, normalized: true, resolution: true } });
    if (!source || source.sourceTable !== "C_Facturacion" || !source.sourceKey || source.sourceKey.startsWith("synthetic:") ||
        source.contentHash !== value.sourceRecordHash) fail("pending_order_mapping_source_unstable");
    const reconciliation = appSheetPendingReconciliationSchema.parse(asObject(source.normalized)?.pendingReconciliation);
    const settlement = validatedLegacySettlement(reconciliation, sha256);
    const order = await ctx.tx.operationOrder.findUnique({ where: { id: value.operationOrderId }, select: {
      id: true, currency: true, totalMinor: true, verifiedMinor: true, refundedMinor: true,
      commercialState: true, financialState: true,
    } });
    const orderObject = await ctx.tx.operationObject.findUnique({ where: { id: value.operationOrderId }, select: { kind: true, version: true } });
    if (!order || order.currency !== settlement.currency || order.totalMinor !== settlement.dueMinor || order.commercialState !== "confirmed" ||
        !orderObject || orderObject.kind !== "order") fail("pending_order_mapping_target_mismatch");
    const actualOrderHash = operationOrderHash({ ...order, version: orderObject.version });
    if (orderObject.version !== value.operationOrderVersion || actualOrderHash !== value.operationOrderHash)
      fail("pending_order_mapping_target_changed");
    const snapshot = await ctx.tx.legacyImportSnapshot.findUniqueOrThrow({ where: { id: ctx.envelope.targetId },
      select: { status: true, createdBy: true, reviewedBy: true } });
    if (snapshot.status !== "reviewed" || !snapshot.reviewedBy || snapshot.createdBy === ctx.actor.id)
      fail("pending_order_mapping_reviewer_not_independent");
    const existing = await ctx.tx.legacyIdentity.findUnique({ where: { sourceSystem_sourceTable_sourceKey_destinationType: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceTable: "C_Facturacion", sourceKey: source.sourceKey, destinationType: "order",
    } } });
    const evidenceHash = sha256(value.evidence);
    const resolution = {
      status: "mapped-to-existing-order", destinationType: "order", destinationId: order.id,
      evidence: value.evidence, evidenceHash, approvedBy: ctx.actor.id, approvedAt: ctx.now.toISOString(),
      sourceRecordHash: value.sourceRecordHash, reconciliationHash: value.reconciliationHash, mappingHash: value.mappingHash,
      operationOrderVersion: orderObject.version, operationOrderHash: actualOrderHash,
    };
    if (existing) {
      const storedResolution = asObject(source.resolution);
      if (existing.destinationId !== order.id || existing.approvedBy !== ctx.actor.id || !storedResolution ||
          storedResolution.status !== resolution.status || storedResolution.destinationType !== "order" ||
          storedResolution.destinationId !== order.id || storedResolution.evidenceHash !== evidenceHash ||
          storedResolution.approvedBy !== ctx.actor.id || storedResolution.sourceRecordHash !== value.sourceRecordHash ||
          storedResolution.reconciliationHash !== value.reconciliationHash || storedResolution.mappingHash !== value.mappingHash ||
          storedResolution.operationOrderVersion !== orderObject.version || storedResolution.operationOrderHash !== actualOrderHash)
        fail("pending_order_mapping_conflict");
      fail("pending_order_mapping_exists_replay_same_command_receipt");
    }
    const competingIdentity = await ctx.tx.legacyIdentity.findFirst({ where: {
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceTable: "C_Facturacion", destinationType: "order",
      destinationId: order.id, sourceKey: { not: source.sourceKey },
    }, select: { id: true } });
    if (competingIdentity) fail("pending_order_mapping_destination_already_occupied");
    if (await ctx.tx.appSheetLegacySettlement.findFirst({ where: { operationOrderId: order.id }, select: { id: true } }))
      fail("pending_order_already_has_legacy_settlement");
    await ctx.tx.legacyIdentity.create({ data: {
      id: sha256(`${APPSHEET_HISTORY_SOURCE_SYSTEM}\0C_Facturacion\0${source.sourceKey}\0order`),
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, sourceTable: "C_Facturacion", sourceKey: source.sourceKey,
      destinationType: "order", destinationId: order.id, approvedBy: ctx.actor.id,
    } });
    await ctx.tx.legacySourceRecord.update({ where: { id: sourceDisposition.sourceRecordId }, data: { resolution: resolution as Prisma.InputJsonValue } });
    await audit(ctx, "appsheet.pending_order_identity_reviewed", {
      sourceRecordId: sourceDisposition.sourceRecordId, sourceRecordHash: value.sourceRecordHash,
      reconciliationHash: value.reconciliationHash, mappingHash: value.mappingHash,
      destinationType: "order", destinationId: order.id, destinationVersion: orderObject.version,
      destinationHash: actualOrderHash, evidenceHash,
      effects: { stock: false, cashLedger: false, payments: false, deliveries: false, messages: false, documents: false, numbering: "not-generated" },
    });
    return { snapshotId: ctx.envelope.targetId, sourceRecordId: sourceDisposition.sourceRecordId, operationOrderId: order.id, replay: false };
  },
});

const pendingDeliveryResolutionInputSchema = appSheetPendingDeliveryResolutionSchema.omit({ requestId: true, approvedBy: true, evidenceHash: true });
registerCommand("AppSheetPendingDeliveryResolved", {
  kind: "legacyImport", capability: "imports.review", administrative: true, internal: false, transactionTimeoutMs: 30_000,
  schema: pendingDeliveryResolutionInputSchema,
  execute: async ctx => {
    const value = ctx.envelope.data as z.infer<typeof pendingDeliveryResolutionInputSchema>;
    const snapshotId = ctx.envelope.targetId;
    const plan = await prepareAppSheetPendingImportPlan(ctx.tx, { snapshotId });
    const sourceDisposition = plan.dispositions.find(row => row.sourceRecordId === value.sourceRecordId && row.dimension === "delivery");
    if (!sourceDisposition || sourceDisposition.sourceTable !== "C_Moto" || sourceDisposition.sourceStatus !== "confirmed_pending" ||
        sourceDisposition.sourceRecordHash !== value.sourceRecordHash || sourceDisposition.reconciliationHash !== value.reconciliationHash ||
        sourceDisposition.mappingHash !== value.mappingHash || plan.sourceSpecHash !== value.sourceSpecHash)
      fail("pending_delivery_resolution_source_changed");
    const source = await ctx.tx.legacySourceRecord.findFirst({ where: { id: value.sourceRecordId, snapshotId },
      select: { id: true, sourceTable: true, sourceKey: true, sourceRow: true, contentHash: true, original: true, normalized: true, resolution: true } });
    if (!source || source.sourceTable !== "C_Moto" || !source.sourceKey || source.sourceKey.startsWith("synthetic:") ||
        source.contentHash !== value.sourceRecordHash || source.resolution !== null)
      fail("pending_delivery_source_unstable_or_already_resolved");
    const invoice = await ctx.tx.legacySourceRecord.findFirst({ where: { id: value.invoiceRecordId, snapshotId },
      select: { id: true, sourceTable: true, sourceKey: true, sourceRow: true, contentHash: true, original: true, normalized: true } });
    if (!invoice || invoice.sourceTable !== "C_Facturacion" || !invoice.sourceKey || invoice.sourceKey.startsWith("synthetic:") ||
        invoice.contentHash !== value.invoiceRecordHash)
      fail("pending_delivery_invoice_source_unstable");
    const motoKey = reviewedSourceCell(source, value.motoKeyCell, APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.key);
    const invoiceReference = reviewedSourceCell(source, value.invoiceReferenceCell, APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.invoiceRef.field);
    const invoiceKey = reviewedSourceCell(invoice, value.invoiceKeyCell, APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.invoiceRef.key);
    const invoiceAddress = reviewedSourceCell(invoice, value.invoiceAddressCell, APPSHEET_PENDING_IMPORT_SOURCE_SPEC.delivery.address.sourceField);
    if (!motoKey || motoKey !== source.sourceKey || !invoiceReference || !invoiceKey ||
        !appSheetDeliveryInvoiceReferenceMatches(invoiceReference, invoiceKey) || !invoiceAddress)
      fail("pending_delivery_source_cells_invalid");
    const identities = await ctx.tx.legacyIdentity.findMany({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      sourceTable: "C_Facturacion", sourceKey: invoice.sourceKey, destinationType: "order", approvedBy: { not: null } },
      select: { destinationId: true, approvedBy: true } });
    if (identities.length !== 1 || !identities[0]?.approvedBy || identities[0].destinationId !== value.operationOrderId)
      fail("pending_delivery_invoice_identity_not_unique_or_independent");
    const orderReviewer = await ctx.tx.user.findFirst({ where: { id: identities[0].approvedBy, active: true }, select: { id: true } });
    if (!orderReviewer) fail("pending_delivery_invoice_identity_reviewer_inactive");
    const snapshot = await ctx.tx.legacyImportSnapshot.findUniqueOrThrow({ where: { id: snapshotId }, select: {
      status: true, createdBy: true, reviewedBy: true,
    } });
    if (snapshot.status !== "reviewed" || !snapshot.reviewedBy || snapshot.createdBy === ctx.actor.id ||
        snapshot.createdBy === orderReviewer.id)
      fail("pending_delivery_resolution_reviewer_not_independent");
    const order = await ctx.tx.operationOrder.findUnique({ where: { id: value.operationOrderId }, select: {
      id: true, channel: true, currency: true, totalMinor: true, verifiedMinor: true, refundedMinor: true,
      commercialState: true, financialState: true,
    } });
    const orderObject = await ctx.tx.operationObject.findUnique({ where: { id: value.operationOrderId }, select: { kind: true, version: true } });
    if (!order || order.channel !== "delivery" || order.commercialState !== "confirmed" || !orderObject || orderObject.kind !== "order")
      fail("pending_delivery_destination_order_invalid");
    const actualOrderHash = operationOrderHash({ ...order, version: orderObject.version });
    if (orderObject.version !== value.operationOrderVersion || actualOrderHash !== value.operationOrderHash)
      fail("pending_delivery_destination_order_changed");
    if (await ctx.tx.deliveryAssignment.count({ where: { orderId: order.id } }) !== 0)
      fail("pending_delivery_assignment_already_exists");
    const resolution = appSheetPendingDeliveryResolutionSchema.parse({ ...value, requestId: ctx.envelope.requestId,
      approvedBy: ctx.actor.id, evidenceHash: sha256(value.evidence) });
    await ctx.tx.legacySourceRecord.update({ where: { id: source.id }, data: { resolution: resolution as Prisma.InputJsonValue } });
    const resolutionHash = sha256Canonical(resolution, sha256);
    await audit(ctx, "appsheet.pending_delivery_source_resolved", { snapshotId, sourceRecordId: source.id,
      sourceRecordHash: source.contentHash, invoiceRecordId: invoice.id, invoiceRecordHash: invoice.contentHash,
      operationOrderId: order.id, operationOrderVersion: orderObject.version, operationOrderHash: actualOrderHash,
      mappingHash: value.mappingHash, sourceSpecHash: plan.sourceSpecHash,
      invoiceReferenceCoordinate: value.invoiceReferenceCell.coordinate, invoiceKeyCoordinate: value.invoiceKeyCell.coordinate,
      invoiceAddressCoordinate: value.invoiceAddressCell.coordinate, resolutionHash,
      reviewers: { orderIdentity: orderReviewer.id, deliveryResolution: ctx.actor.id },
      effects: { stock: false, cashLedger: false, payments: false, dispatched: false, delivered: false,
        messages: false, documents: false, numbering: "not-generated" } });
    return { snapshotId, sourceRecordId: source.id, resolutionHash, approvedBy: ctx.actor.id };
  },
});

const planReviewCommandSchema = z.strictObject({
  snapshotId: z.string().min(1).max(100),
  importerId: z.string().min(1).max(100),
  target: z.enum(["isolated-test", "production"]),
  destinationIdentity: z.string().regex(/^appsheet-db-v1:[a-f0-9]{64}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  backupManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  backupSnapshotAt: z.iso.datetime(),
  review: appSheetPendingImportReviewSchema,
});

registerCommand("AppSheetPendingImportPlanReviewed", {
  kind: "legacyImport", capability: "imports.review", create: true, administrative: true, internal: false, transactionTimeoutMs: 60_000,
  schema: planReviewCommandSchema,
  execute: async ctx => {
    const value = ctx.envelope.data as z.infer<typeof planReviewCommandSchema>;
    const binding: AppSheetPendingImportBinding = { target: value.target, destinationIdentity: value.destinationIdentity,
      commitSha: value.commitSha, backupManifestHash: value.backupManifestHash, backupSnapshotAt: new Date(value.backupSnapshotAt) };
    const plan = await prepareAppSheetPendingImportPlan(ctx.tx, { snapshotId: value.snapshotId, binding });
    requireUnambiguousPendingDeliveryOrders(plan);
    if (ctx.envelope.targetId !== planReviewObjectId(plan.batchId) || value.importerId === ctx.actor.id)
      fail("pending_plan_review_target_or_identity_invalid");
    const review = assertAppSheetPendingImportReview({ review: value.review, reviewKind: "independent-pending-import-plan",
      expected: expectedReviewBinding(plan), importerId: value.importerId, reviewerId: ctx.actor.id });
    const importer = await ctx.tx.user.findUnique({ where: { id: value.importerId } });
    if (!importer?.active) fail("pending_importer_inactive");
    await requireCapability(ctx.tx, importer, "imports.write");
    const snapshot = await ctx.tx.legacyImportSnapshot.findUniqueOrThrow({ where: { id: value.snapshotId },
      select: { createdBy: true, reviewedBy: true } });
    if ([snapshot.createdBy, snapshot.reviewedBy,
      ...plan.materializedSettlements.map(item => item.orderMappingReviewerId),
      ...plan.materializedDeliveries.flatMap(item => [item.orderMappingReviewerId, item.resolutionReviewerId])].includes(ctx.actor.id))
      fail("pending_technical_reviewer_not_independent");
    return { batchId: plan.batchId, review, projectionHash: plan.projectionHash, sourceSpecHash: plan.sourceSpecHash,
      destinationHash: plan.destinationHash, reviewedBy: ctx.actor.id };
  },
});

const importStageCommandSchema = z.strictObject({
  snapshotId: z.string().min(1).max(100),
  target: z.enum(["isolated-test", "production"]),
  destinationIdentity: z.string().regex(/^appsheet-db-v1:[a-f0-9]{64}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  backupManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  backupSnapshotAt: z.iso.datetime(),
  planReviewRequestId: z.uuid(),
});

registerCommand("AppSheetPendingImportStaged", {
  kind: "legacyImport", capability: "imports.write", create: true, administrative: true, internal: true, transactionTimeoutMs: 60_000,
  schema: importStageCommandSchema,
  execute: async ctx => {
    const value = ctx.envelope.data as z.infer<typeof importStageCommandSchema>;
    const binding: AppSheetPendingImportBinding = {
      target: value.target, destinationIdentity: value.destinationIdentity, commitSha: value.commitSha,
      backupManifestHash: value.backupManifestHash, backupSnapshotAt: new Date(value.backupSnapshotAt),
    };
    const plan = await prepareAppSheetPendingImportPlan(ctx.tx, { snapshotId: value.snapshotId, binding });
    if (ctx.envelope.targetId !== plan.batchId) fail("pending_import_batch_target_mismatch");
    requireUnambiguousPendingDeliveryOrders(plan);
    const reviewReceipt = await ctx.tx.commandReceipt.findUnique({ where: { requestId: value.planReviewRequestId }, select: {
      requestId: true, actorId: true, targetId: true, command: true, resultingVersion: true, response: true,
    } });
    const reviewObject = await ctx.tx.operationObject.findUnique({ where: { id: planReviewObjectId(plan.batchId) }, select: { kind: true, version: true } });
    const response = asObject(reviewReceipt?.response);
    const reviewResult = asObject(response?.result);
    if (!reviewReceipt || reviewReceipt.command !== "AppSheetPendingImportPlanReviewed" ||
        reviewReceipt.targetId !== planReviewObjectId(plan.batchId) || !reviewObject || reviewObject.kind !== "legacyImport" ||
        reviewReceipt.resultingVersion !== reviewObject.version || !reviewResult || reviewResult.batchId !== plan.batchId ||
        reviewResult.projectionHash !== plan.projectionHash || reviewResult.destinationHash !== plan.destinationHash || reviewResult.sourceSpecHash !== plan.sourceSpecHash ||
        reviewResult.reviewedBy !== reviewReceipt.actorId)
      fail("pending_plan_review_receipt_missing_or_stale");
    const review = assertAppSheetPendingImportReview({ review: reviewResult.review, reviewKind: "independent-pending-import-plan",
      expected: expectedReviewBinding(plan), importerId: ctx.actor.id, reviewerId: reviewReceipt.actorId });
    const reviewUser = await ctx.tx.user.findUnique({ where: { id: review.reviewer } });
    if (!reviewUser?.active) throw new OperationError(409, "PENDING_REVIEWER_INACTIVE", "La persona revisora técnica debe estar activa.");
    await requireCapability(ctx.tx, reviewUser, "imports.review");
    const snapshot = await ctx.tx.legacyImportSnapshot.findUniqueOrThrow({ where: { id: value.snapshotId }, select: { createdBy: true, reviewedBy: true } });
    if ([snapshot.createdBy, snapshot.reviewedBy,
      ...plan.materializedSettlements.map(item => item.orderMappingReviewerId),
      ...plan.materializedDeliveries.flatMap(item => [item.orderMappingReviewerId, item.resolutionReviewerId])].includes(reviewUser.id))
      fail("pending_technical_reviewer_not_independent");
    const result = await persistAppSheetPendingImportPlan(ctx, plan, review);
    return { ...result, captureId: plan.captureId, projectionHash: plan.projectionHash, sourceSpecHash: plan.sourceSpecHash,
      dispositions: plan.dispositions.length, materializedSettlements: plan.materializedSettlements.length,
      pendingDeliveryAssignments: plan.materializedDeliveries.length,
      status: "staged", effects: { stock: false, cashLedger: false, payments: false, dispatches: false,
        deliveryConfirmations: false, messages: false, documents: false, numbering: "not-generated" } };
  },
});

export async function reviewAppSheetPendingImport(ctx: CommandContext): Promise<{ batchId: string; status: "reviewed"; destinationVersion: number }> {
  const review = appSheetPendingImportReviewSchema.parse(ctx.envelope.data.review);
  const batchId = ctx.envelope.targetId;
  const batch = await ctx.tx.appSheetPendingImportBatch.findUnique({ where: { id: batchId }, include: {
    dispositions: true, settlements: true, snapshot: { select: { createdBy: true, status: true, reviewedBy: true } },
    captureManifest: { select: { manifestHash: true, dataHash: true } },
  } });
  if (!batch || batch.snapshot.status !== "reviewed") fail("pending_import_batch_not_found_or_unreviewed");
  if (batch.createdBy === ctx.actor.id || batch.snapshot.createdBy === ctx.actor.id || batch.snapshot.reviewedBy === ctx.actor.id)
    fail("independent_pending_reviewer_required");
  if (batch.status !== "staged" || !batch.stageReview) fail("pending_import_plan_review_missing_or_already_reviewed");
  const object = await ctx.tx.operationObject.findUnique({ where: { id: batch.id }, select: { version: true } });
  if (!object || object.version !== ctx.envelope.expectedVersion || batch.destinationVersion !== 1)
    fail("pending_destination_version_conflict");
  const plan = await prepareAppSheetPendingImportPlan(ctx.tx, { snapshotId: batch.snapshotId, binding: {
    target: batch.target as AppSheetPendingImportBinding["target"], destinationIdentity: batch.destinationIdentity,
    commitSha: batch.commitSha, backupManifestHash: batch.backupManifestHash, backupSnapshotAt: batch.backupSnapshotAt,
  } });
  assertStoredPlanMatches(batch, plan);
  const planReview = assertAppSheetPendingImportReview({ review: batch.stageReview, reviewKind: "independent-pending-import-plan",
    expected: expectedReviewBinding(plan), importerId: batch.createdBy });
  if (planReview.reviewer === batch.snapshot.createdBy ||
      planReview.reviewer === batch.snapshot.reviewedBy || plan.materializedSettlements.some(row => row.orderMappingReviewerId === ctx.actor.id) ||
      plan.materializedDeliveries.some(row => [row.orderMappingReviewerId, row.resolutionReviewerId].includes(ctx.actor.id)))
    fail("pending_destination_reviewer_not_independent");
  const destinationReview = assertAppSheetPendingImportReview({ review, reviewKind: "independent-pending-import-destination",
    expected: expectedReviewBinding(plan), importerId: batch.createdBy, reviewerId: ctx.actor.id });
  if (batch.dispositions.some(row => !["closed", "not_applicable", "materialized"].includes(row.state)))
    fail("pending_import_disposition_coverage_incomplete");
  const reviewer = await ctx.tx.user.findUnique({ where: { id: ctx.actor.id } });
  if (!reviewer?.active) fail("pending_destination_reviewer_inactive");
  await requireCapability(ctx.tx, reviewer, "imports.review");
  const sourceReviewers = new Set([batch.snapshot.createdBy, batch.snapshot.reviewedBy,
    ...plan.materializedSettlements.map(row => row.orderMappingReviewerId),
    ...plan.materializedDeliveries.flatMap(row => [row.orderMappingReviewerId, row.resolutionReviewerId])]
    .filter((value): value is string => Boolean(value)));
  if (sourceReviewers.has(ctx.actor.id)) fail("pending_destination_reviewer_not_independent");
  await materializeReviewedPendingDeliveries(ctx, plan);
  const nextVersion = object.version + 1;
  const authoritativeReviewedAt = new Date(ctx.now.getTime());
  await ctx.tx.appSheetPendingImportBatch.update({ where: { id: batch.id }, data: {
    status: "reviewed", reviewedBy: ctx.actor.id, reviewedAt: authoritativeReviewedAt,
    reviewedObjectVersion: nextVersion, reviewEvidence: destinationReview as unknown as Prisma.InputJsonValue,
  } });
  await ctx.tx.appSheetLegacySettlement.updateMany({ where: { batchId: batch.id, status: "staged" }, data: {
    status: "reviewed", reviewedBy: ctx.actor.id, reviewedAt: authoritativeReviewedAt,
  } });
  await audit(ctx, "appsheet.pending_import_destination_reviewed", { captureId: batch.captureId, manifestHash: batch.manifestHash,
    sourceSpecHash: batch.sourceSpecHash, projectionHash: batch.projectionHash, dispositionHash: batch.dispositionHash, destinationHash: batch.destinationHash,
    destinationVersion: batch.destinationVersion, reviewedObjectVersion: nextVersion, reviewerId: ctx.actor.id,
    pendingDeliveryAssignmentCount: plan.materializedDeliveries.length,
    effects: { stock: false, cashLedger: false, payments: false, dispatches: false, deliveryConfirmations: false,
      messages: false, documents: false, numbering: "not-generated" } });
  return { batchId: batch.id, status: "reviewed", destinationVersion: nextVersion };
}

export async function previewAppSheetPendingImportDestinationReview(tx: Tx, batchId: string): Promise<{
  batchId: string;
  status: "staged";
  expectedVersion: number;
  captureId: string;
  manifestHash: string;
  dataHash: string;
  projectionHash: string;
  dispositionHash: string;
  destinationHash: string;
  dispositionCount: number;
  legacySettlementCount: number;
  pendingDeliveryAssignmentCount: number;
}> {
  const batch = await tx.appSheetPendingImportBatch.findUnique({ where: { id: batchId }, include: {
    dispositions: true, settlements: true, snapshot: { select: { sourceSystem: true, status: true } },
  } });
  if (!batch || batch.snapshot.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM)
    throw new OperationError(404, "APPSHEET_PENDING_IMPORT_NOT_FOUND", "No se encontró este lote pendiente de AppSheet.");
  if (batch.snapshot.status !== "reviewed") fail("reviewed_history_snapshot_required");
  if (batch.status !== "staged" || !batch.stageReview) fail("pending_import_plan_review_missing_or_already_reviewed");
  const object = await tx.operationObject.findUnique({ where: { id: batch.id }, select: { kind: true, version: true } });
  if (!object || object.kind !== "legacyImport" || batch.destinationVersion !== 1)
    fail("pending_destination_version_conflict");
  const plan = await prepareAppSheetPendingImportPlan(tx, { snapshotId: batch.snapshotId, binding: {
    target: batch.target as AppSheetPendingImportBinding["target"], destinationIdentity: batch.destinationIdentity,
    commitSha: batch.commitSha, backupManifestHash: batch.backupManifestHash, backupSnapshotAt: batch.backupSnapshotAt,
  } });
  assertStoredPlanMatches(batch, plan);
  requireUnambiguousPendingDeliveryOrders(plan);
  assertAppSheetPendingImportReview({ review: batch.stageReview, reviewKind: "independent-pending-import-plan",
    expected: expectedReviewBinding(plan), importerId: batch.createdBy });
  return {
    batchId: batch.id,
    status: "staged",
    expectedVersion: object.version,
    captureId: plan.captureId,
    manifestHash: plan.manifestHash,
    dataHash: plan.dataHash,
    projectionHash: plan.projectionHash,
    dispositionHash: plan.dispositionHash,
    destinationHash: plan.destinationHash,
    dispositionCount: plan.dispositions.length,
    legacySettlementCount: plan.materializedSettlements.length,
    pendingDeliveryAssignmentCount: plan.materializedDeliveries.length,
  };
}

const destinationReviewCommandSchema = z.strictObject({ review: appSheetPendingImportReviewSchema });
registerCommand("AppSheetPendingImportDestinationReviewed", {
  kind: "legacyImport", capability: "imports.review", administrative: true, internal: false, transactionTimeoutMs: 60_000,
  schema: destinationReviewCommandSchema,
  execute: reviewAppSheetPendingImport,
});

export async function requireReviewedAppSheetPendingImport(tx: Tx, captureId: string) {
  const batches = await tx.appSheetPendingImportBatch.findMany({ where: { captureId, status: "reviewed" }, include: {
    dispositions: true, settlements: true, snapshot: { select: { id: true, status: true, createdBy: true, reviewedBy: true } },
  } });
  if (batches.length !== 1) fail("pending_import_independent_review_missing");
  const batch = batches[0]!;
  let currentProductionIdentity: string | null = null;
  try {
    if (process.env.DATABASE_URL) currentProductionIdentity = appSheetDatabaseDestinationIdentity("production", new URL(process.env.DATABASE_URL));
  } catch { currentProductionIdentity = null; }
  if (batch.target !== "production" || !currentProductionIdentity || batch.destinationIdentity !== currentProductionIdentity)
    fail("pending_import_production_destination_changed");
  if (batch.snapshot.status !== "reviewed" || !batch.reviewedBy || !batch.reviewedObjectVersion || batch.createdBy === batch.reviewedBy ||
      batch.snapshot.createdBy === batch.reviewedBy || batch.snapshot.reviewedBy === batch.reviewedBy)
    fail("pending_import_independent_review_missing");
  const object = await tx.operationObject.findUnique({ where: { id: batch.id }, select: { version: true, kind: true } });
  if (!object || object.kind !== "legacyImport" || object.version !== batch.reviewedObjectVersion || batch.destinationVersion !== 1 ||
      batch.dispositionCount !== batch.sourceRecordCount * 4 || batch.dispositions.length !== batch.dispositionCount ||
      batch.dispositions.some(row => !["closed", "not_applicable", "materialized"].includes(row.state)))
    fail("pending_import_disposition_coverage_incomplete");
  const review = assertAppSheetPendingImportReview({ review: batch.reviewEvidence, reviewKind: "independent-pending-import-destination",
    expected: {
      captureId: batch.captureId, manifestHash: batch.manifestHash, dataHash: batch.dataHash,
      mappingHash: batch.mappingHash, sourceSpecHash: batch.sourceSpecHash, sourceCoverageHash: batch.sourceCoverageHash, dispositionHash: batch.dispositionHash,
      destinationHash: batch.destinationHash, destinationVersion: batch.destinationVersion, projectionHash: batch.projectionHash,
      target: batch.target as AppSheetPendingImportBinding["target"], destinationIdentity: batch.destinationIdentity,
      commitSha: batch.commitSha, backupManifestHash: batch.backupManifestHash, backupSnapshotAt: batch.backupSnapshotAt.toISOString(),
    }, importerId: batch.createdBy, reviewerId: batch.reviewedBy });
  const binding: AppSheetPendingImportBinding = { target: batch.target as AppSheetPendingImportBinding["target"],
    destinationIdentity: batch.destinationIdentity, commitSha: batch.commitSha, backupManifestHash: batch.backupManifestHash,
    backupSnapshotAt: batch.backupSnapshotAt };
  const plan = await prepareAppSheetPendingImportPlan(tx, { snapshotId: batch.snapshotId, binding });
  assertStoredPlanMatches(batch, plan);
  await assertPendingDeliveryDestinations(tx, plan);
  const stageReview = assertAppSheetPendingImportReview({ review: batch.stageReview, reviewKind: "independent-pending-import-plan",
    expected: expectedReviewBinding(plan), importerId: batch.createdBy });
  if (stageReview.reviewer === batch.snapshot.createdBy ||
      stageReview.reviewer === batch.snapshot.reviewedBy || batch.snapshot.createdBy === review.reviewer ||
      batch.snapshot.reviewedBy === review.reviewer || plan.materializedSettlements.some(row => row.orderMappingReviewerId === review.reviewer) ||
      plan.materializedDeliveries.some(row => [row.orderMappingReviewerId, row.resolutionReviewerId].includes(review.reviewer)))
    fail("pending_import_reviewer_not_independent");
  const settlementById = new Map(batch.settlements.map(item => [item.id, item]));
  for (const disposition of plan.dispositions) {
    const stored = batch.dispositions.find(row => row.id === dispositionIdFor(batch.id, disposition.sourceRecordId, disposition.dimension));
    if (!stored || stored.state !== disposition.state || stored.destinationHash !== disposition.destinationHash) fail("pending_import_disposition_mismatch");
    if (disposition.state !== "materialized") continue;
    if (!disposition.destinationId) fail("pending_import_destination_type_invalid");
    if (disposition.dimension === "receivable" && disposition.destinationType === "legacy_settlement") {
      const settlement = settlementById.get(disposition.destinationId);
      if (!settlement || settlement.status !== "reviewed" || settlement.destinationVersion !== 1 ||
          settlement.sourceRecordHash !== disposition.sourceRecordHash || settlement.mappingHash !== disposition.mappingHash ||
          settlement.reconciliationHash !== disposition.reconciliationHash || settlement.destinationHash !== disposition.destinationHash)
        fail("pending_import_destination_binding_changed");
      const order = await tx.operationOrder.findUnique({ where: { id: settlement.operationOrderId }, select: {
        id: true, memberId: true, channel: true, currency: true, quoteVersion: true, quote: true, address: true,
        subtotalMinor: true, discountMinor: true, deliveryMinor: true, deliveryDiscountMinor: true, surchargeMinor: true,
        totalMinor: true, sourceSystem: true, sourceId: true, legacySaleId: true,
        lines: { orderBy: { id: "asc" }, select: { id: true, skuId: true, unit: true, requested: true, unitPrice: true,
          referenceMinor: true, discountMinor: true, revenueMinor: true, policyId: true, policyVersion: true, packId: true, packCount: true } },
      } });
      const orderObject = await tx.operationObject.findUnique({ where: { id: settlement.operationOrderId }, select: { kind: true } });
      const commercialBasisHash = order && appSheetPendingOrderCommercialBasisHash(order);
      const financialBasisHash = order && commercialBasisHash && appSheetLegacyFinancialBasisHash({ orderId: order.id, memberId: order.memberId,
        currency: order.currency, totalMinor: order.totalMinor, commercialBasisHash, captureId: settlement.captureId,
        sourceRecordId: settlement.sourceRecordId, sourceRecordHash: settlement.sourceRecordHash,
        sourceKeyHash: settlement.sourceKeyHash, reconciliationHash: settlement.reconciliationHash,
        mappingHash: settlement.mappingHash, mappingReviewerId: settlement.orderMappingReviewerId,
        mappingEvidenceHash: settlement.orderMappingEvidenceHash, mappedOrderVersion: settlement.operationOrderVersion,
        mappedOrderHash: settlement.operationOrderHash });
      if (!order || !orderObject || orderObject.kind !== "order" || order.memberId !== settlement.operationOrderMemberId ||
          order.currency !== settlement.currency || order.totalMinor !== settlement.dueMinor ||
          financialBasisHash !== settlement.financialBasisHash)
        fail("pending_import_destination_financial_basis_changed");
      continue;
    }
    if (disposition.dimension !== "delivery" || disposition.destinationType !== "delivery_assignment" ||
        disposition.destinationId !== deliveryAssignmentIdFor(dispositionIdFor(batch.id, disposition.sourceRecordId, disposition.dimension)) ||
        !plan.materializedDeliveries.some(delivery => delivery.sourceRecordId === disposition.sourceRecordId &&
          delivery.destinationId === disposition.destinationId && delivery.destinationHash === disposition.destinationHash))
      fail("pending_import_destination_type_invalid");
  }
  const sourceUsers = [...new Set([batch.createdBy, batch.snapshot.createdBy, batch.snapshot.reviewedBy, stageReview.reviewer,
    ...plan.materializedSettlements.map(row => row.orderMappingReviewerId),
    ...plan.materializedDeliveries.flatMap(row => [row.orderMappingReviewerId, row.resolutionReviewerId]), review.reviewer]
    .filter((id): id is string => Boolean(id)))];
  const activeUsers = await tx.user.findMany({ where: { id: { in: sourceUsers } } });
  if (activeUsers.length !== sourceUsers.length || activeUsers.some(user => !user.active)) fail("pending_import_reviewer_inactive");
  const importerUser = activeUsers.find(user => user.id === batch.createdBy);
  if (!importerUser) fail("pending_import_reviewer_inactive");
  await requireCapability(tx, importerUser, "imports.write");
  const reviewerIds = [...new Set([stageReview.reviewer, review.reviewer,
    ...plan.materializedSettlements.map(row => row.orderMappingReviewerId),
    ...plan.materializedDeliveries.flatMap(row => [row.orderMappingReviewerId, row.resolutionReviewerId])])];
  for (const reviewerId of reviewerIds) {
    const reviewerUser = activeUsers.find(user => user.id === reviewerId);
    if (!reviewerUser) fail("pending_import_reviewer_inactive");
    await requireCapability(tx, reviewerUser, "imports.review");
  }
  return { batchId: batch.id, captureId: batch.captureId, manifestHash: batch.manifestHash, dataHash: batch.dataHash,
    mappingHash: batch.mappingHash, sourceSpecHash: batch.sourceSpecHash, sourceCoverageHash: batch.sourceCoverageHash, dispositionHash: batch.dispositionHash,
    destinationHash: batch.destinationHash, destinationVersion: batch.destinationVersion,
    dispositions: batch.dispositionCount, legacySettlements: batch.settlements.length,
    pendingDeliveryAssignments: plan.materializedDeliveries.length };
}

/** Return previously reviewed AppSheet receipts without folding them into Bombo's receipt ledger. */
export async function reviewedAppSheetLegacyPaidForOrder(tx: Tx, order: {
  id: string; memberId: string; currency: string; totalMinor: bigint; verifiedMinor: bigint; refundedMinor: bigint; commercialState: string;
}): Promise<bigint> {
  const settlement = await tx.appSheetLegacySettlement.findUnique({ where: { operationOrderId: order.id } });
  if (!settlement) return 0n;
  const batch = await tx.appSheetPendingImportBatch.findUnique({ where: { id: settlement.batchId }, select: {
    id: true, snapshotId: true, captureId: true, manifestHash: true, dataHash: true, mappingHash: true, sourceSpecHash: true,
    sourceCoverageHash: true, dispositionHash: true, destinationHash: true, destinationVersion: true,
    projectionHash: true, target: true, destinationIdentity: true, commitSha: true, backupManifestHash: true,
    backupSnapshotAt: true, createdBy: true, status: true, reviewedBy: true, reviewedAt: true,
    reviewedObjectVersion: true, reviewEvidence: true, stageReview: true,
  } });
  if (!batch || batch.status !== "reviewed" || !batch.reviewedBy || !batch.reviewedAt ||
      settlement.status !== "reviewed" || settlement.reviewedBy !== batch.reviewedBy ||
      !settlement.reviewedAt || settlement.reviewedAt.getTime() !== batch.reviewedAt.getTime() ||
      settlement.destinationVersion !== 1 || batch.destinationVersion !== 1 || !batch.reviewedObjectVersion)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_UNREVIEWED", "El cobro histórico necesita revisión independiente antes de afectar el saldo pendiente.");
  const authority = await tx.operationAuthority.findUnique({ where: { id: "operations" },
    select: { mode: true, cutoverProfile: true, captureManifestId: true } });
  if (authority?.mode === "active" && authority.cutoverProfile === "appsheet-replacement" &&
      authority.captureManifestId !== settlement.captureId)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID", "El cobro histórico no corresponde a la captura activa de reemplazo.");
  const [batchObject, disposition, capture] = await Promise.all([
    tx.operationObject.findUnique({ where: { id: batch.id }, select: { kind: true, version: true } }),
    tx.appSheetPendingImportDisposition.findUnique({ where: { id: settlement.dispositionId }, select: {
      batchId: true, sourceRecordHash: true, reconciliationHash: true, mappingHash: true, dimension: true,
      state: true, destinationType: true, destinationId: true, destinationHash: true, destinationVersion: true,
    } }),
    tx.appSheetCaptureManifest.findUnique({ where: { captureId: settlement.captureId }, select: {
      captureId: true, sourceSystem: true, manifestHash: true, dataHash: true, stability: true,
    } }),
  ]);
  if (!capture || capture.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || capture.captureId !== batch.captureId ||
      capture.manifestHash !== batch.manifestHash || capture.dataHash !== batch.dataHash || asObject(capture.stability)?.stable !== true)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID", "La captura estable del cobro histórico ya no coincide con la revisión aprobada.");
  if (!batchObject || batchObject.kind !== "legacyImport" || batchObject.version !== batch.reviewedObjectVersion ||
      !disposition || disposition.batchId !== batch.id || disposition.dimension !== "receivable" ||
      disposition.state !== "materialized" || disposition.destinationType !== "legacy_settlement" ||
      disposition.destinationId !== settlement.id || disposition.destinationVersion !== 1 ||
      disposition.sourceRecordHash !== settlement.sourceRecordHash || disposition.reconciliationHash !== settlement.reconciliationHash ||
      disposition.mappingHash !== settlement.mappingHash || disposition.destinationHash !== settlement.destinationHash)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_UNREVIEWED", "La cobertura revisada del cobro histórico cambió.");
  const review = assertAppSheetPendingImportReview({ review: batch.reviewEvidence,
    reviewKind: "independent-pending-import-destination", importerId: batch.createdBy, reviewerId: batch.reviewedBy,
    expected: { captureId: batch.captureId, manifestHash: batch.manifestHash, dataHash: batch.dataHash,
      mappingHash: batch.mappingHash, sourceSpecHash: batch.sourceSpecHash, sourceCoverageHash: batch.sourceCoverageHash, dispositionHash: batch.dispositionHash,
      destinationHash: batch.destinationHash, destinationVersion: batch.destinationVersion,
      projectionHash: batch.projectionHash, target: batch.target as AppSheetPendingImportBinding["target"],
      destinationIdentity: batch.destinationIdentity, commitSha: batch.commitSha, backupManifestHash: batch.backupManifestHash,
      backupSnapshotAt: batch.backupSnapshotAt.toISOString() } });
  const stageReview = assertAppSheetPendingImportReview({ review: batch.stageReview,
    reviewKind: "independent-pending-import-plan", importerId: batch.createdBy,
    expected: { captureId: batch.captureId, manifestHash: batch.manifestHash, dataHash: batch.dataHash,
      mappingHash: batch.mappingHash, sourceSpecHash: batch.sourceSpecHash, sourceCoverageHash: batch.sourceCoverageHash, dispositionHash: batch.dispositionHash,
      destinationHash: batch.destinationHash, destinationVersion: batch.destinationVersion,
      projectionHash: batch.projectionHash, target: batch.target as AppSheetPendingImportBinding["target"],
      destinationIdentity: batch.destinationIdentity, commitSha: batch.commitSha, backupManifestHash: batch.backupManifestHash,
      backupSnapshotAt: batch.backupSnapshotAt.toISOString() } });
  if (batch.target !== "production" && batch.target !== "isolated-test")
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID", "El destino del cobro histórico no conserva una identidad válida.");
  const historyProof = await requireBoundAppSheetHistoryStage(tx, batch.snapshotId, {
    target: batch.target, destinationIdentity: batch.destinationIdentity, requireReviewed: true,
  });
  const { snapshot } = historyProof;
  if (historyProof.capture.captureId !== batch.captureId || historyProof.capture.manifestHash !== batch.manifestHash ||
      historyProof.capture.dataHash !== batch.dataHash)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID", "La revisión de historia pertenece a otra captura.");
  const requiredUserIds = [...new Set([batch.createdBy, review.reviewer, stageReview.reviewer, settlement.orderMappingReviewerId,
    ...(snapshot?.createdBy ? [snapshot.createdBy] : []), ...(snapshot?.reviewedBy ? [snapshot.reviewedBy] : [])])];
  const reviewUsers = await tx.user.findMany({ where: { id: { in: requiredUserIds } } });
  if (!snapshot || snapshot.status !== "reviewed" || reviewUsers.length !== requiredUserIds.length ||
      reviewUsers.some(user => !user.active) || [batch.createdBy, snapshot.createdBy, snapshot.reviewedBy,
        settlement.orderMappingReviewerId].includes(review.reviewer))
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_REVIEW_INVALID", "La revisión del cobro histórico perdió vigencia o independencia.");
  const destinationReviewer = reviewUsers.find(user => user.id === review.reviewer);
  if (!destinationReviewer) throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_REVIEW_INVALID", "No se pudo comprobar la persona revisora del cobro histórico.");
  const requiredReviewers = [...new Set([review.reviewer, stageReview.reviewer, settlement.orderMappingReviewerId])];
  for (const reviewerId of requiredReviewers) {
    const reviewer = reviewUsers.find(user => user.id === reviewerId);
    if (!reviewer) throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_REVIEW_INVALID", "No se pudo comprobar una persona revisora del cobro histórico.");
    await requireCapability(tx, reviewer, "imports.review");
  }
  const importer = reviewUsers.find(user => user.id === batch.createdBy);
  if (!importer) throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_REVIEW_INVALID", "No se pudo comprobar quién preparó el lote histórico.");
  await requireCapability(tx, importer, "imports.write");
  const source = await tx.legacySourceRecord.findUnique({ where: { id: settlement.sourceRecordId }, select: {
    snapshotId: true, sourceTable: true, sourceKey: true, contentHash: true, normalized: true, resolution: true,
  } });
  const identity = source?.sourceKey ? await tx.legacyIdentity.findUnique({ where: {
    sourceSystem_sourceTable_sourceKey_destinationType: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      sourceTable: "C_Facturacion", sourceKey: source.sourceKey, destinationType: "order" },
  } }) : null;
  const resolution = asObject(source?.resolution);
  if (!source || source.snapshotId !== batch.snapshotId || source.sourceTable !== "C_Facturacion" || source.contentHash !== settlement.sourceRecordHash ||
      !identity || identity.destinationId !== order.id || identity.approvedBy !== settlement.orderMappingReviewerId ||
      !resolution || resolution.status !== "mapped-to-existing-order" || resolution.destinationId !== order.id ||
      resolution.approvedBy !== settlement.orderMappingReviewerId || resolution.sourceRecordHash !== settlement.sourceRecordHash ||
      resolution.reconciliationHash !== settlement.reconciliationHash || resolution.mappingHash !== settlement.mappingHash ||
      resolution.operationOrderVersion !== settlement.operationOrderVersion || resolution.operationOrderHash !== settlement.operationOrderHash ||
      !validHash(resolution.evidenceHash) || typeof resolution.evidence !== "string" || sha256(resolution.evidence) !== resolution.evidenceHash ||
      sha256(resolution.evidence) !== settlement.orderMappingEvidenceHash)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID", "El recibo histórico ya no coincide con su fuente o vínculo revisado.");
  const reconciliation = appSheetPendingReconciliationSchema.safeParse(asObject(source.normalized)?.pendingReconciliation);
  if (!reconciliation.success || sha256Canonical(reconciliation.data, sha256) !== settlement.reconciliationHash ||
      reconciliation.data.capture.captureId !== settlement.captureId || reconciliation.data.mappingHash !== settlement.mappingHash ||
      reconciliation.data.capture.manifestHash !== batch.manifestHash || reconciliation.data.capture.mode !== "stable" ||
      reconciliation.data.capture.provisional !== false ||
      sha256Canonical(["appsheet-pending-key-v1", source.sourceTable, source.sourceKey], sha256) !== settlement.sourceKeyHash)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID", "El recibo histórico no conserva la captura, clave o conciliación aprobadas.");
  let amounts: ReturnType<typeof validatedLegacySettlement>;
  try { amounts = validatedLegacySettlement(reconciliation.data, sha256); }
  catch { throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID", "Los importes y referencias de pago históricos requieren conciliación."); }
  const liveOrder = await tx.operationOrder.findUnique({ where: { id: order.id }, select: {
    id: true, memberId: true, channel: true, currency: true, quoteVersion: true, quote: true, address: true,
    subtotalMinor: true, discountMinor: true, deliveryMinor: true, deliveryDiscountMinor: true, surchargeMinor: true,
    totalMinor: true, sourceSystem: true, sourceId: true, legacySaleId: true,
    lines: { orderBy: { id: "asc" }, select: { id: true, skuId: true, unit: true, requested: true, unitPrice: true,
      referenceMinor: true, discountMinor: true, revenueMinor: true, policyId: true, policyVersion: true, packId: true, packCount: true } },
  } });
  const commercialBasisHash = liveOrder && appSheetPendingOrderCommercialBasisHash(liveOrder);
  if (!liveOrder || !commercialBasisHash || liveOrder.memberId !== order.memberId || liveOrder.currency !== order.currency ||
      liveOrder.totalMinor !== order.totalMinor)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_TARGET_CHANGED", "La cotización o el pedido cambiaron respecto de la revisión histórica.");
  const financialBasisHash = appSheetLegacyFinancialBasisHash({ orderId: liveOrder.id, memberId: liveOrder.memberId,
    currency: liveOrder.currency, totalMinor: liveOrder.totalMinor, commercialBasisHash, captureId: settlement.captureId,
    sourceRecordId: settlement.sourceRecordId, sourceRecordHash: settlement.sourceRecordHash,
    sourceKeyHash: settlement.sourceKeyHash, reconciliationHash: settlement.reconciliationHash,
    mappingHash: settlement.mappingHash, mappingReviewerId: settlement.orderMappingReviewerId,
    mappingEvidenceHash: settlement.orderMappingEvidenceHash, mappedOrderVersion: settlement.operationOrderVersion,
    mappedOrderHash: settlement.operationOrderHash });
  const expectedDestinationHash = sha256Canonical({ kind: "legacy-settlement", captureId: settlement.captureId,
    manifestHash: batch.manifestHash, sourceRecordId: settlement.sourceRecordId, sourceRecordHash: settlement.sourceRecordHash,
    reconciliationHash: settlement.reconciliationHash, mappingHash: settlement.mappingHash,
    operationOrderId: order.id, operationOrderMemberId: settlement.operationOrderMemberId, financialBasisHash,
    operationOrderVersion: settlement.operationOrderVersion, operationOrderHash: settlement.operationOrderHash,
    orderMappingReviewerId: settlement.orderMappingReviewerId, orderMappingEvidenceHash: settlement.orderMappingEvidenceHash,
    operationOrderCurrency: liveOrder.currency, operationOrderTotalMinor: liveOrder.totalMinor.toString(),
    dueMinor: amounts.dueMinor.toString(), legacyPaidMinor: amounts.legacyPaidMinor.toString(),
    remainingMinor: amounts.remainingMinor.toString(), paymentRowsHash: reconciliation.data.dimensions.receivable.settlement!.paymentRowsHash,
    paymentReferences: amounts.paymentReferences }, sha256);
  if (amounts.currency !== settlement.currency || amounts.dueMinor !== settlement.dueMinor ||
      amounts.legacyPaidMinor !== settlement.legacyPaidMinor || amounts.remainingMinor !== settlement.remainingMinor ||
      amounts.dueMinor !== liveOrder.totalMinor || amounts.currency !== liveOrder.currency ||
      liveOrder.memberId !== settlement.operationOrderMemberId || financialBasisHash !== settlement.financialBasisHash ||
      expectedDestinationHash !== settlement.destinationHash || expectedDestinationHash !== disposition.destinationHash)
    throw new OperationError(423, "APPSHEET_LEGACY_SETTLEMENT_TARGET_CHANGED", "La deuda del pedido difiere del saldo histórico revisado.");
  return settlement.legacyPaidMinor;
}
