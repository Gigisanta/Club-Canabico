import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import "../server/operations/finance.js";
import { appSheetLegacyFinancialBasisHash, appSheetPendingOrderCommercialBasisHash, AppSheetPendingImportStageError,
  prepareAppSheetPendingImportPlan } from "../server/operations/appsheet-pending-import.js";
import { appSheetLegacyFinancialSummariesForOrders, projectAppSheetLegacyFinancialSummary } from "../server/operations/appsheet-legacy-financial-projection.js";
import { commandSpecs, OperationError, type CommandContext, type Tx } from "../server/operations/core.js";
import { assertManifest, type DeliveryManifestV1 } from "../src/offline/contracts.js";
import { APPSHEET_PENDING_MAPPING_ID, APPSHEET_PENDING_SCHEMA_VERSION, pendingMappingFingerprintPayload } from "../shared/operations/appsheet-pending.js";
import { APPSHEET_HISTORY_IMPORTER_VERSION } from "../shared/operations/appsheet-history.js";
import { appSheetDatabaseDestinationIdentity } from "../server/operations/appsheet-database-target.js";
import { legacyPayloadHash } from "../server/operations/legacy-upload-contract.js";
import { APP_SHEET_HISTORY_REVIEW_TEST_DATABASE_URL, createAppSheetHistoryReviewFixture,
  withAppSheetHistoryReviewTestEnvironment } from "./support/appsheet-history-review-fixture.js";
import { appSheetDeliveryInvoiceReferenceMatches, appSheetLegacyAdjustedFinancialState, appSheetLegacyAdjustedOutstanding,
  appSheetPendingDeliveryCardinalityAmbiguities, appSheetPendingDeliveryInvoiceCardinalityAmbiguities,
  sha256Canonical } from "../shared/operations/appsheet-pending-import.js";

test("C_Moto invoice reference binds to N_factura even when invoice Id_Factura differs", () => {
  const invoiceSourceKey = "invoice-row-id-7";
  const invoiceNumber = "F-2026-007";
  const motoInvoiceReference = "F-2026-007";
  assert.notEqual(invoiceSourceKey, invoiceNumber);
  assert.equal(appSheetDeliveryInvoiceReferenceMatches(motoInvoiceReference, invoiceNumber), true);
  assert.equal(appSheetDeliveryInvoiceReferenceMatches(motoInvoiceReference, "F-2026-008"), false);
  assert.equal(appSheetDeliveryInvoiceReferenceMatches(null, invoiceNumber), false);
});

test("all C_Moto rows resolving to the same order are individually marked ambiguous", () => {
  const ambiguous = appSheetPendingDeliveryCardinalityAmbiguities([
    { sourceRecordId: "moto-1", operationOrderId: "order-1" },
    { sourceRecordId: "moto-2", operationOrderId: "order-1" },
    { sourceRecordId: "moto-3", operationOrderId: "order-2" },
  ]);
  assert.deepEqual([...ambiguous].sort(), ["moto-1", "moto-2"]);
  assert.deepEqual([...appSheetPendingDeliveryCardinalityAmbiguities([
    { sourceRecordId: "moto-only", operationOrderId: "order-only" },
  ])], []);
});

test("pending C_Moto rows linked to an invoice with multiple related C_Moto rows are blocked", () => {
  const ambiguous = appSheetPendingDeliveryInvoiceCardinalityAmbiguities([
    { sourceRecordId: "moto-pending-1", invoiceSourceRecordId: "invoice-1", confirmedPending: true },
    { sourceRecordId: "moto-pending-2", invoiceSourceRecordId: "invoice-1", confirmedPending: true },
    { sourceRecordId: "moto-closed", invoiceSourceRecordId: "invoice-2", confirmedPending: false },
    { sourceRecordId: "moto-pending-only", invoiceSourceRecordId: "invoice-2", confirmedPending: true },
    { sourceRecordId: "moto-unlinked", invoiceSourceRecordId: null, confirmedPending: true },
  ]);
  assert.deepEqual([...ambiguous].sort(), ["moto-pending-1", "moto-pending-2", "moto-pending-only"]);
  assert.deepEqual([...appSheetPendingDeliveryInvoiceCardinalityAmbiguities([
    { sourceRecordId: "moto-single", invoiceSourceRecordId: "invoice-single", confirmedPending: true },
  ])], []);
});

const commercialOrder = () => ({
  id: "order-1", memberId: "member-1", channel: "delivery", currency: "ARS", quoteVersion: 1,
  commercialState: "confirmed", financialState: "unpaid", verifiedMinor: 0n, refundedMinor: 0n,
  quote: { currency: "ARS", invoiceNumber: "F-1", totalMinor: "10000",
    appSheetFormula: { ruleVersion: "appsheet-invoice-calculation/2", results: { Total_Facturado: "10000" } },
    lines: [{ id: "line-1", skuId: "sku-a", explicitTotalMinor: "10000" }] },
  address: { street: "Calle 1" }, subtotalMinor: 10_000n, discountMinor: 0n, deliveryMinor: 0n,
  deliveryDiscountMinor: 0n, surchargeMinor: 0n, totalMinor: 10_000n, sourceSystem: null, sourceId: null, legacySaleId: null,
  lines: [{ id: "line-1", skuId: "sku-a", unit: "g", requested: "100.000", unitPrice: "1.000000000000",
    referenceMinor: 10_000n, discountMinor: 0n, revenueMinor: 10_000n, policyId: null, policyVersion: null, packId: null, packCount: null }],
});

test("legacy commercial basis binds same-gross quote revisions and AppSheet metadata", () => {
  const current = commercialOrder();
  const currentHash = appSheetPendingOrderCommercialBasisHash(current);
  assert.match(currentHash ?? "", /^[a-f0-9]{64}$/);
  const revised = commercialOrder();
  revised.quoteVersion = 2;
  revised.quote = { ...revised.quote, lines: [{ id: "line-1", skuId: "sku-b", explicitTotalMinor: "10000" }] };
  revised.lines[0]!.skuId = "sku-b";
  assert.notEqual(appSheetPendingOrderCommercialBasisHash(revised), currentHash,
    "a same-total SKU substitution must invalidate the reviewed financial basis");

  const changedAppSheetMetadata = commercialOrder();
  changedAppSheetMetadata.quote = { ...changedAppSheetMetadata.quote,
    appSheetFormula: { ruleVersion: "appsheet-invoice-calculation/2", results: { Total_Facturado: "9999" } } };
  assert.notEqual(appSheetPendingOrderCommercialBasisHash(changedAppSheetMetadata), currentHash,
    "AppSheet formula metadata remains part of the sealed quote snapshot");

  const afterReceipt = { ...current, verifiedMinor: 4_000n, refundedMinor: 0n, financialState: "partially_paid", version: 4 };
  assert.equal(appSheetPendingOrderCommercialBasisHash(afterReceipt), currentHash,
    "legitimate receipt counters and aggregate version do not alter the commercial basis");
});

function reviewedSettlementFixture(order = commercialOrder(), capturedOrder = commercialOrder()) {
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const canonicalHash = (value: unknown) => sha256Canonical(value, hash);
  const captureId = "capture-1", manifestHash = hash("capture-manifest"), dataHash = hash("capture-data");
  const mappingHash = hash("mapping"), sourceRecordId = "source-record-1", sourceRecordHash = hash("source-record");
  const sourceKey = "invoice-key", sourceKeyHash = canonicalHash(["appsheet-pending-key-v1", "C_Facturacion", sourceKey]);
  const paymentRowsHash = canonicalHash([]);
  const reconciliation = {
    schemaVersion: APPSHEET_PENDING_SCHEMA_VERSION, mappingId: APPSHEET_PENDING_MAPPING_ID, mappingHash,
    source: { sourceTable: "C_Facturacion", sourceRow: 2, sourceKeyHash, sourceEvidenceHash: hash("source-evidence") },
    capture: { captureId, manifestHash, mode: "stable", provisional: false },
    dimensions: {
      preSale: { status: "not_applicable", reasonCodes: [], evidenceFields: [], relationships: [] },
      receivable: { status: "confirmed_pending", reasonCodes: [], evidenceFields: [], relationships: [],
        settlement: { currency: "ARS", dueMinorUnits: "10000", paidMinorUnits: "4000", remainingMinorUnits: "6000", paymentRowsHash } },
      unpaidPurchase: { status: "not_applicable", reasonCodes: [], evidenceFields: [], relationships: [] },
      delivery: { status: "not_applicable", reasonCodes: [], evidenceFields: [], relationships: [] },
    },
  };
  const reconciliationHash = canonicalHash(reconciliation);
  const mappingReviewerId = "mapping-reviewer", mappingEvidence = "reviewed exact invoice mapping";
  const mappingEvidenceHash = hash(mappingEvidence), operationOrderVersion = 1, operationOrderHash = hash("mapped order version");
  const commercialBasisHash = appSheetPendingOrderCommercialBasisHash(capturedOrder);
  assert.ok(commercialBasisHash);
  const financialBasisHash = appSheetLegacyFinancialBasisHash({ orderId: capturedOrder.id, memberId: capturedOrder.memberId,
    currency: capturedOrder.currency, totalMinor: capturedOrder.totalMinor, commercialBasisHash, captureId,
    sourceRecordId, sourceRecordHash, sourceKeyHash, reconciliationHash, mappingHash,
    mappingReviewerId, mappingEvidenceHash, mappedOrderVersion: operationOrderVersion, mappedOrderHash: operationOrderHash });
  const destinationHash = canonicalHash({ kind: "legacy-settlement", captureId, manifestHash,
    sourceRecordId, sourceRecordHash, reconciliationHash, mappingHash,
    operationOrderId: capturedOrder.id, operationOrderMemberId: capturedOrder.memberId, financialBasisHash,
    operationOrderVersion, operationOrderHash, orderMappingReviewerId: mappingReviewerId,
    orderMappingEvidenceHash: mappingEvidenceHash, operationOrderCurrency: capturedOrder.currency,
    operationOrderTotalMinor: capturedOrder.totalMinor.toString(), dueMinor: "10000", legacyPaidMinor: "4000",
    remainingMinor: "6000", paymentRowsHash, paymentReferences: [] });
  const settlementId = "legacy-settlement-1", dispositionId = "disposition-1";
  const reviewedAt = new Date("2026-10-10T00:00:00.000Z");
  const destinationIdentity = appSheetDatabaseDestinationIdentity("isolated-test", new URL(APP_SHEET_HISTORY_REVIEW_TEST_DATABASE_URL));
  const reviewBinding = {
    captureId, manifestHash, dataHash, mappingHash, sourceSpecHash: hash("source-spec"),
    sourceCoverageHash: hash("source-coverage"), dispositionHash: hash("disposition-hash"),
    destinationHash: hash("batch-destination"), destinationVersion: 1, projectionHash: hash("projection"),
    target: "isolated-test", destinationIdentity,
    commitSha: "a".repeat(40), backupManifestHash: hash("backup"), backupSnapshotAt: "2026-10-08T10:00:00.000Z",
  };
  const review = (reviewKind: string, reviewer: string) => ({ schemaVersion: "appsheet-pending-import-review/v1",
    reviewKind, ...reviewBinding, importer: "importer", reviewer, approved: true,
    reviewedAt: reviewedAt.toISOString(), findings: [] });
  const batch = { id: "batch-1", snapshotId: "snapshot-1", captureId, manifestHash, dataHash, mappingHash,
    sourceSpecHash: reviewBinding.sourceSpecHash, sourceCoverageHash: reviewBinding.sourceCoverageHash,
    dispositionHash: reviewBinding.dispositionHash, destinationHash: reviewBinding.destinationHash,
    destinationVersion: 1, projectionHash: reviewBinding.projectionHash, target: reviewBinding.target,
    destinationIdentity: reviewBinding.destinationIdentity, commitSha: reviewBinding.commitSha,
    backupManifestHash: reviewBinding.backupManifestHash, backupSnapshotAt: new Date(reviewBinding.backupSnapshotAt),
    createdBy: "importer", status: "reviewed", reviewedBy: "destination-reviewer", reviewedAt,
    reviewedObjectVersion: 1, reviewEvidence: review("independent-pending-import-destination", "destination-reviewer"),
    stageReview: review("independent-pending-import-plan", "stage-reviewer") };
  const history = createAppSheetHistoryReviewFixture({ snapshotId: batch.snapshotId, captureId, manifestHash, dataHash,
    projectionHash: reviewBinding.projectionHash, destinationIdentity, snapshotCreatedBy: "snapshot-creator",
    stageActorUserId: "history-stage-actor", technicalReviewer: "history-technical-reviewer",
    sourceReviewer: "snapshot-reviewer", reviewedAt });
  const settlement = { id: settlementId, batchId: batch.id, dispositionId, sourceRecordId, sourceRecordHash,
    reconciliationHash, mappingHash, captureId, sourceKeyHash, operationOrderId: order.id,
    operationOrderMemberId: order.memberId, financialBasisHash, operationOrderVersion, operationOrderHash,
    orderMappingReviewerId: mappingReviewerId, orderMappingEvidenceHash: mappingEvidenceHash,
    currency: "ARS", dueMinor: 10_000n, legacyPaidMinor: 4_000n, remainingMinor: 6_000n,
    paymentRowsHash, paymentReferences: [], destinationHash, destinationVersion: 1,
    status: "reviewed", reviewedBy: batch.reviewedBy, reviewedAt, createdBy: "importer" };
  const disposition = { batchId: batch.id, sourceRecordHash, reconciliationHash, mappingHash, dimension: "receivable",
    state: "materialized", destinationType: "legacy_settlement", destinationId: settlementId, destinationHash, destinationVersion: 1 };
  const resolution = { status: "mapped-to-existing-order", destinationType: "order", destinationId: order.id,
    approvedBy: mappingReviewerId, evidence: mappingEvidence, evidenceHash: mappingEvidenceHash,
    sourceRecordHash, reconciliationHash, mappingHash, operationOrderVersion, operationOrderHash };
  const source = { snapshotId: batch.snapshotId, sourceTable: "C_Facturacion", sourceKey, contentHash: sourceRecordHash,
    normalized: { pendingReconciliation: reconciliation }, resolution };
  const snapshot = history.snapshot;
  const capture = history.capture;
  const users = ["importer", "destination-reviewer", "stage-reviewer", mappingReviewerId,
    snapshot.createdBy, snapshot.reviewedBy, "history-stage-actor", "history-technical-reviewer"]
    .map(id => ({ id, active: true, role: "owner", authorizationEpoch: 1 }));
  const writes: string[] = [];
  const orderState = { verifiedMinor: order.verifiedMinor, financialState: order.financialState };
  const orderUpdates: Array<{ verifiedMinor: bigint; financialState: string }> = [];
  const collectionReports = new Map([
    ["collection-1", { id: "collection-1", orderId: order.id, status: "reported", currency: "ARS", amountMinor: 8_000n, method: "transfer", custodianId: null }],
    ["collection-2", { id: "collection-2", orderId: order.id, status: "reported", currency: "ARS", amountMinor: 3_000n, method: "transfer", custodianId: null }],
    ["collection-3", { id: "collection-3", orderId: order.id, status: "reported", currency: "ARS", amountMinor: 2_000n, method: "transfer", custodianId: null }],
  ]);
  const account = { id: "account-1", currency: "ARS", kind: "bank", custodianId: null,
    active: true, verified: true, openingApprovedBy: "opening-reviewer" };
  const tx = {
    collectionReport: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => collectionReports.get(where.id),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        writes.push("collection.update");
        const current = collectionReports.get(where.id);
        if (!current) throw new Error("fixture_collection_missing");
        const updated = { ...current, ...data };
        collectionReports.set(where.id, updated as typeof current);
        return updated;
      },
    },
    operationOrder: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.includes(order.id) ? [{ ...order, ...orderState }] : [],
      findUniqueOrThrow: async () => ({ ...order, ...orderState }),
      findUnique: async () => ({ ...order, ...orderState }),
      update: async ({ data }: { data: { verifiedMinor: bigint; financialState: string } }) => {
        writes.push("order.update"); orderUpdates.push(data); Object.assign(orderState, data); return data;
      },
    },
    operationAccount: {
      findUniqueOrThrow: async () => account,
      findUnique: async () => account,
    },
    operationAuthority: { findUnique: async () => null },
    operationAccess: { findUnique: async () => null },
    appSheetLegacySettlement: {
      findUnique: async () => settlement,
      findMany: async ({ where }: { where: { operationOrderId: { in: string[] } } }) =>
        where.operationOrderId.in.includes(order.id) ? [{ operationOrderId: order.id }] : [],
    },
    appSheetCaptureManifest: history.tx.appSheetCaptureManifest,
    appSheetPendingImportBatch: { findUnique: async () => batch },
    appSheetPendingImportDisposition: { findUnique: async () => disposition },
    operationObject: {
      findUnique: async () => ({ kind: "legacyImport", version: 1 }),
      update: async () => { writes.push("object.update"); },
      create: async () => { writes.push("object.create"); },
    },
    legacyImportSnapshot: history.tx.legacyImportSnapshot,
    legacySourceRecord: { ...history.tx.legacySourceRecord, findUnique: async () => source },
    legacyHistoricalFact: history.tx.legacyHistoricalFact,
    legacyException: history.tx.legacyException,
    operationAudit: history.tx.operationAudit,
    legacyIdentity: { findUnique: async () => ({ destinationId: order.id, approvedBy: mappingReviewerId }) },
    user: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        users.filter(user => where.id.in.includes(user.id)),
      findUnique: async ({ where }: { where: { id: string } }) => users.find(user => user.id === where.id) ?? null,
    },
    ledgerEvent: { create: async ({ data }: { data: { metadata: { appliedMinor: string } } }) => {
      writes.push("ledger.create"); return { id: "ledger-1", ...data };
    } },
    memberCredit: {
      create: async ({ data }: { data: { amountMinor: bigint } }) => { writes.push("credit.create"); return data; },
      findUniqueOrThrow: async () => ({ id: "credit-1", treatment: "member_credit", memberId: order.memberId,
        currency: order.currency, amountMinor: 8_000n, resolvedMinor: 0n }),
      update: async () => { writes.push("credit.update"); },
    },
  } as unknown as Tx;
  return { tx, writes, order, settlement, capture, source, snapshot, history, orderState, orderUpdates, collectionReports };
}

function commandContext(tx: Tx, command: string, options: { targetId?: string; appliedMinor?: string } = {}): CommandContext {
  return { tx, actor: { id: "cashier-1" },
    envelope: { targetId: options.targetId ?? (command === "CollectionVerified" ? "collection-1" : "credit-1"), command,
      requestId: "00000000-0000-4000-8000-000000000001", expectedVersion: 1,
      occurredAt: "2026-10-10T12:00:00.000Z", schemaVersion: 1,
      data: command === "CollectionVerified" ? { accountId: "account-1", evidence: { receipt: "synthetic" },
        ...(options.appliedMinor ? { appliedMinor: options.appliedMinor } : {}), excessTreatment: "member_credit" } :
        { orderId: "order-1", amountMinor: "5000", evidence: { receipt: "synthetic" } } },
    now: new Date("2026-10-10T12:00:00.000Z"), authorityEpoch: 1 } as unknown as CommandContext;
}

test("CollectionVerified applies legacy balance only against the unchanged reviewed commercial basis", async () => {
  const fixture = reviewedSettlementFixture();
  const spec = commandSpecs.get("CollectionVerified");
  assert.ok(spec);
  const result = await withAppSheetHistoryReviewTestEnvironment(() => spec.execute(commandContext(fixture.tx, "CollectionVerified")));
  assert.equal(result.appliedMinor, 6_000n);
  assert.equal(result.excessMinor, 2_000n);
  assert.equal(fixture.writes.includes("ledger.create"), true);
  assert.equal(fixture.writes.includes("collection.update"), true);
  assert.equal(fixture.writes.includes("credit.create"), true);
  assert.equal(fixture.writes.includes("order.update"), true);
  assert.equal(fixture.orderState.verifiedMinor, 6_000n);
  assert.equal(fixture.orderState.financialState, "paid", "legacy 4,000 plus Bombo 6,000 pays the 10,000 order");
});

test("repeated CollectionVerified reports consume a reviewed legacy settlement only once", async () => {
  const fixture = reviewedSettlementFixture();
  const spec = commandSpecs.get("CollectionVerified");
  assert.ok(spec);
  const first = await withAppSheetHistoryReviewTestEnvironment(() => spec.execute(commandContext(fixture.tx, "CollectionVerified", { appliedMinor: "4000" })));
  const second = await withAppSheetHistoryReviewTestEnvironment(() => spec.execute(commandContext(fixture.tx, "CollectionVerified", { targetId: "collection-2", appliedMinor: "3000" })));
  const third = await withAppSheetHistoryReviewTestEnvironment(() => spec.execute(commandContext(fixture.tx, "CollectionVerified", { targetId: "collection-3", appliedMinor: "2000" })));

  assert.deepEqual([first.appliedMinor, second.appliedMinor, third.appliedMinor], [4_000n, 2_000n, 0n]);
  assert.deepEqual([first.excessMinor, second.excessMinor, third.excessMinor], [4_000n, 1_000n, 2_000n]);
  assert.equal(fixture.orderState.verifiedMinor, 6_000n, "Bombo receipts cannot apply beyond the 6,000 left after legacy paid");
  assert.equal(fixture.orderState.financialState, "paid");
  assert.deepEqual(["collection-1", "collection-2", "collection-3"].map(id => fixture.collectionReports.get(id)?.status),
    ["verified", "verified", "verified"], "real cash receipt reports remain independently recorded");
});

test("MemberCreditApplied uses a reviewed legacy settlement when calculating the remaining order debt", async () => {
  const fixture = reviewedSettlementFixture();
  const spec = commandSpecs.get("MemberCreditApplied");
  assert.ok(spec);
  const result = await withAppSheetHistoryReviewTestEnvironment(() => spec.execute(commandContext(fixture.tx, "MemberCreditApplied")));

  assert.equal(result.appliedMinor, 5_000n);
  assert.equal(fixture.orderState.verifiedMinor, 5_000n);
  assert.equal(fixture.orderState.financialState, "partially_paid", "legacy 4,000 plus applied credit 5,000 leaves 1,000 outstanding");
  assert.equal(fixture.writes.includes("credit.update"), true);
  assert.equal(fixture.writes.includes("order.update"), true);
  assert.equal(fixture.writes.includes("ledger.create"), false, "applying an existing credit does not create another receipt");
});

test("same-gross quote revision rejects collection and member-credit writes against old legacy approval", async () => {
  const revisedOrder = commercialOrder();
  revisedOrder.quoteVersion = 2;
  revisedOrder.quote = { ...revisedOrder.quote,
    lines: [{ id: "line-1", skuId: "sku-b", explicitTotalMinor: "10000" }] };
  revisedOrder.lines[0]!.skuId = "sku-b";

  for (const command of ["CollectionVerified", "MemberCreditApplied"]) {
    const fixture = reviewedSettlementFixture(revisedOrder);
    const spec = commandSpecs.get(command);
    assert.ok(spec);
    await assert.rejects(withAppSheetHistoryReviewTestEnvironment(() => spec.execute(commandContext(fixture.tx, command))), error => error instanceof OperationError &&
      error.code === "APPSHEET_LEGACY_SETTLEMENT_TARGET_CHANGED");
    assert.deepEqual(fixture.writes, [], `${command} must reject before ledger, credit, receipt, or order writes`);
  }
});

test("a changed capture invalidates legacy receipts before any collection or credit write", async () => {
  for (const command of ["CollectionVerified", "MemberCreditApplied"]) {
    const fixture = reviewedSettlementFixture();
    fixture.capture.dataHash = "f".repeat(64);
    const spec = commandSpecs.get(command);
    assert.ok(spec);
    await assert.rejects(withAppSheetHistoryReviewTestEnvironment(() => spec.execute(commandContext(fixture.tx, command))), error => error instanceof OperationError &&
      error.code === "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID");
    assert.deepEqual(fixture.writes, []);
  }
});

test("a legacy source row bound to another history snapshot rejects financial writes", async () => {
  const fixture = reviewedSettlementFixture();
  fixture.source.snapshotId = "different-snapshot";
  const spec = commandSpecs.get("CollectionVerified");
  assert.ok(spec);
  await assert.rejects(withAppSheetHistoryReviewTestEnvironment(() => spec.execute(commandContext(fixture.tx, "CollectionVerified"))),
    error => error instanceof OperationError && error.code === "APPSHEET_LEGACY_SETTLEMENT_SOURCE_INVALID");
  assert.deepEqual(fixture.writes, [], "snapshot mismatch must reject before ledger, receipt, credit, or order writes");
});

test("reviewed AppSheet receipts reduce collectible debt without changing Bombo receipts", () => {
  assert.equal(appSheetLegacyAdjustedOutstanding({ totalMinor: 10_000n, bomboVerifiedMinor: 2_000n, legacyPaidMinor: 3_000n }), 5_000n);
  assert.equal(appSheetLegacyAdjustedOutstanding({ totalMinor: 10_000n, bomboVerifiedMinor: 8_000n, legacyPaidMinor: 3_000n }), 0n);
  assert.equal(appSheetLegacyAdjustedOutstanding({ totalMinor: 10_000n, bomboVerifiedMinor: 0n, legacyPaidMinor: 3_000n, cancelled: true }), 0n);
  assert.throws(() => appSheetLegacyAdjustedOutstanding({ totalMinor: 10n, bomboVerifiedMinor: -1n, legacyPaidMinor: 0n }),
    error => error instanceof Error && error.message === "receivable_amount_invalid");
});

test("visible order financial state includes legacy receipts and keeps refunds tied to Bombo receipts", () => {
  assert.equal(appSheetLegacyAdjustedFinancialState({ totalMinor: 10_000n, bomboVerifiedMinor: 0n, legacyPaidMinor: 10_000n, refundedMinor: 0n }), "paid");
  assert.equal(appSheetLegacyAdjustedFinancialState({ totalMinor: 10_000n, bomboVerifiedMinor: 2_000n, legacyPaidMinor: 3_000n, refundedMinor: 0n }), "partially_paid");
  assert.equal(appSheetLegacyAdjustedFinancialState({ totalMinor: 10_000n, bomboVerifiedMinor: 4_000n, legacyPaidMinor: 6_000n, refundedMinor: 1_000n }), "partially_refunded");
  assert.equal(appSheetLegacyAdjustedFinancialState({ totalMinor: 10_000n, bomboVerifiedMinor: 4_000n, legacyPaidMinor: 0n, refundedMinor: 4_000n }), "refunded");
  assert.throws(() => appSheetLegacyAdjustedFinancialState({ totalMinor: 10n, bomboVerifiedMinor: 2n, legacyPaidMinor: 0n, refundedMinor: 3n }),
    error => error instanceof Error && error.message === "receivable_amount_invalid");
});

test("read projection uses the real reviewed-settlement guard and performs no writes", async () => {
  const fixture = reviewedSettlementFixture();
  const summaries = await withAppSheetHistoryReviewTestEnvironment(() => appSheetLegacyFinancialSummariesForOrders(fixture.tx, [fixture.order]));

  assert.equal(summaries.get(fixture.order.id)?.legacyPaidMinor, "4000");
  assert.equal(summaries.get(fixture.order.id)?.outstandingMinor, "6000");
  assert.equal(summaries.get(fixture.order.id)?.financialState, "partially_paid");
  assert.equal(fixture.orderState.verifiedMinor, 0n);
  assert.deepEqual(fixture.writes, [], "the read projection does not write a cash or order record");
});

test("read projection fails closed without a current reviewed-settlement receipt", async () => {
  const fixture = reviewedSettlementFixture();
  fixture.settlement.status = "staged";
  const summaries = await withAppSheetHistoryReviewTestEnvironment(() => appSheetLegacyFinancialSummariesForOrders(fixture.tx, [fixture.order]));
  const summary = summaries.get(fixture.order.id);

  assert.equal(summary?.legacyFinancialProjectionState, "unknown");
  assert.equal(summary?.legacyPaidMinor, null);
  assert.equal(summary?.outstandingMinor, null);
  assert.equal(summary?.financialState, null);
  assert.equal(summary?.legacyFinancialProjectionReason, "historical_payment_review_blocked");
  assert.equal(fixture.orderState.verifiedMinor, 0n);
  assert.deepEqual(fixture.writes, []);
});

test("read projection reloads current Bombo receipts inside its financial snapshot", async () => {
  const fixture = reviewedSettlementFixture();
  fixture.orderState.verifiedMinor = 2_000n;
  fixture.orderState.financialState = "partially_paid";

  const summaries = await withAppSheetHistoryReviewTestEnvironment(() => appSheetLegacyFinancialSummariesForOrders(fixture.tx, [fixture.order]));

  assert.equal(summaries.get(fixture.order.id)?.legacyPaidMinor, "4000");
  assert.equal(summaries.get(fixture.order.id)?.outstandingMinor, "4000",
    "the result must use the current 2,000 Bombo receipt, not the stale order object passed by the caller");
  assert.equal(summaries.get(fixture.order.id)?.verifiedMinor, "2000");
  assert.equal(summaries.get(fixture.order.id)?.refundedMinor, "0");
  assert.equal(summaries.get(fixture.order.id)?.financialState, "partially_paid");
  assert.deepEqual(fixture.writes, []);
});

test("read projection shows reviewed historical payment and only the remaining balance", () => {
  const order = { id: "order-1", memberId: "member-1", currency: "ARS", totalMinor: 10_000n,
    verifiedMinor: 2_000n, refundedMinor: 0n, commercialState: "confirmed", financialState: "partially_paid",
    quote: { source: "appsheet-invoice", totalCalculationState: "defined" } };
  const summary = projectAppSheetLegacyFinancialSummary(order, 4_000n);

  assert.deepEqual(summary, { financialState: "partially_paid", legacyFinancialProjectionState: "reviewed",
    verifiedMinor: "2000", refundedMinor: "0", legacyPaidMinor: "4000", outstandingMinor: "4000", legacyFinancialProjectionReason: null });
  assert.equal(order.verifiedMinor, 2_000n, "historical receipts stay outside OperationOrder.verifiedMinor");
});

test("read projection hides amounts when review, invoice total, or financial basis is unresolved", () => {
  const order = { id: "order-1", memberId: "member-1", currency: "ARS", totalMinor: 10_000n,
    verifiedMinor: 2_000n, refundedMinor: 0n, commercialState: "confirmed", financialState: "partially_paid",
    quote: { source: "appsheet-invoice", totalCalculationState: "defined" } };
  const blockedReview = projectAppSheetLegacyFinancialSummary(order, null);
  assert.equal(blockedReview.financialState, null);
  assert.equal(blockedReview.legacyFinancialProjectionState, "unknown");
  assert.equal(blockedReview.legacyPaidMinor, null);
  assert.equal(blockedReview.outstandingMinor, null);
  assert.equal(blockedReview.legacyFinancialProjectionReason, "historical_payment_review_blocked");

  const pendingInvoice = projectAppSheetLegacyFinancialSummary({ ...order,
    quote: { source: "appsheet-invoice", totalCalculationState: "pending" } }, 4_000n);
  assert.equal(pendingInvoice.outstandingMinor, null);
  assert.equal(pendingInvoice.legacyFinancialProjectionReason, "invoice_total_pending");

  const invalidRefund = projectAppSheetLegacyFinancialSummary({ ...order, refundedMinor: 3_000n }, 4_000n);
  assert.equal(invalidRefund.financialState, null);
  assert.equal(invalidRefund.legacyPaidMinor, null);
  assert.equal(invalidRefund.outstandingMinor, null);
  assert.equal(invalidRefund.legacyFinancialProjectionReason, "financial_basis_invalid");
});

function pendingProjectionPlanFixture(options: {
  missingProjectionRows?: number[];
  bindingMutation?: "sourceEvidenceHash";
  queryRecordCount?: number;
} = {}) {
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const canonicalHash = (value: unknown) => sha256Canonical(value, hash);
  const history = createAppSheetHistoryReviewFixture({ snapshotId: "pending-snapshot", captureId: "capture-1",
    manifestHash: hash("capture-manifest"), dataHash: hash("capture-data"), projectionHash: hash("history-projection"),
    destinationIdentity: appSheetDatabaseDestinationIdentity("isolated-test", new URL(APP_SHEET_HISTORY_REVIEW_TEST_DATABASE_URL)),
    snapshotCreatedBy: "snapshot-creator", stageActorUserId: "history-stage-actor",
    technicalReviewer: "history-technical-reviewer", sourceReviewer: "snapshot-reviewer" });
  const mappingHash = hash(pendingMappingFingerprintPayload());
  const sourceCount = 2;
  const records = Array.from({ length: sourceCount }, (_, index) => {
    const sourceRow = index + 2;
    const sourceTable = "C_Facturacion";
    const sourceKey = `invoice-${index + 1}`;
    const original = { columns: [{ coordinate: `A${sourceRow}`, header: "Id_Factura", value: sourceKey }] };
    const normalizedColumns = [{ coordinate: `A${sourceRow}`, header: "Id_Factura", value: sourceKey }];
    const sourceEvidenceHash = canonicalHash({ sourceTable, sourceRow, sourceKey, original, normalizedColumns });
    const reconciliation = {
      schemaVersion: APPSHEET_PENDING_SCHEMA_VERSION,
      mappingId: APPSHEET_PENDING_MAPPING_ID,
      mappingHash,
      source: { sourceTable, sourceRow, sourceKeyHash: canonicalHash(["appsheet-pending-key-v1", sourceTable, sourceKey]), sourceEvidenceHash },
      capture: { captureId: history.capture.captureId, manifestHash: history.capture.manifestHash, mode: "stable", provisional: false },
      dimensions: {
        preSale: { status: "not_applicable", reasonCodes: [], evidenceFields: [], relationships: [] },
        receivable: { status: "not_applicable", reasonCodes: [], evidenceFields: [], relationships: [] },
        unpaidPurchase: { status: "not_applicable", reasonCodes: [], evidenceFields: [], relationships: [] },
        delivery: { status: "not_applicable", reasonCodes: [], evidenceFields: [], relationships: [] },
      },
    };
    if (index === 1 && options.bindingMutation === "sourceEvidenceHash") reconciliation.source.sourceEvidenceHash = hash("wrong-source-evidence");
    const normalized = { columns: normalizedColumns,
      ...(!options.missingProjectionRows?.includes(sourceRow) ? { pendingReconciliation: reconciliation } : {}) };
    const recordProjection = {
      sourceTable, sourceKey, sourceRow, fileHash: history.snapshot.fileHash,
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, original, normalized,
      treatment: index === 0 ? "fact_candidate" : "archive_only", exceptions: [],
    };
    return {
      id: `source-record-${index + 1}`, snapshotId: history.snapshot.id, ...recordProjection,
      contentHash: legacyPayloadHash(recordProjection), resolution: null,
    };
  });
  const coverage = history.snapshot.coverage;
  const capture = history.capture;
  const metrics = history.metrics;
  metrics.recordCount = sourceCount;
  metrics.archiveOnlyRecordCount = 1;
  metrics.tableCounts.C_Facturacion = sourceCount;
  coverage.source.dataRecordCount = sourceCount;
  coverage.sheets[0].populatedSourceRows = sourceCount;
  coverage.sheets[0].sourceRecordCount = sourceCount;
  coverage.sheets[0].archiveOnlyCount = 1;
  coverage.pages[0].endRow = sourceCount + 1;
  coverage.totals.recordCount = sourceCount;
  coverage.totals.archiveOnlyRecordCount = 1;
  capture.dataRecordCount = sourceCount;
  capture.pageManifest[0].endRow = sourceCount + 1;
  capture.pageManifest[0].counts.rowsSerialized = sourceCount;
  history.stageAudit.details.recordCount = sourceCount;
  history.reviewAudit.details.counts.recordCount = sourceCount;
  const returnedRecords = options.queryRecordCount === undefined ? records : records.slice(0, options.queryRecordCount);
  history.stage.recordsHash = canonicalHash(returnedRecords.map(({ resolution: _resolution, ...record }) => record));
  const tx = {
    ...history.tx,
    legacySourceRecord: {
      count: async ({ where }: { where?: { OR?: unknown[] } }) => where?.OR ? 0 : sourceCount,
      groupBy: async () => [{ sourceTable: "C_Facturacion", _count: { _all: sourceCount } }],
      findMany: async () => returnedRecords,
    },
    operationAccess: { findUnique: async () => null },
    user: { findUnique: async () => ({ id: "snapshot-reviewer", role: "owner", active: true, authorizationEpoch: 1 }) },
  } as unknown as Tx;
  return { tx, records, history };
}

test("pending plan creates four dispositions for every fully projected persisted source row", async () => {
  const fixture = pendingProjectionPlanFixture();
  const plan = await withAppSheetHistoryReviewTestEnvironment(() => prepareAppSheetPendingImportPlan(fixture.tx, {
    snapshotId: fixture.history.snapshot.id,
  }));
  assert.equal(plan.dispositions.length, fixture.records.length * 4);
  assert.deepEqual(new Set(plan.dispositions.map(row => row.sourceRecordId)), new Set(fixture.records.map(row => row.id)));
});

test("pending plan rejects an omitted projection even when the source-record hash matches", async () => {
  const fixture = pendingProjectionPlanFixture({ missingProjectionRows: [3] });
  await assert.rejects(withAppSheetHistoryReviewTestEnvironment(() => prepareAppSheetPendingImportPlan(fixture.tx, {
    snapshotId: fixture.history.snapshot.id,
  })), error => error instanceof AppSheetPendingImportStageError && error.code === "pending_source_projection_incomplete");
});

test("pending plan binds the source evidence hash to the persisted row content", async () => {
  const fixture = pendingProjectionPlanFixture({ bindingMutation: "sourceEvidenceHash" });
  await assert.rejects(withAppSheetHistoryReviewTestEnvironment(() => prepareAppSheetPendingImportPlan(fixture.tx, {
    snapshotId: fixture.history.snapshot.id,
  })), error => error instanceof AppSheetPendingImportStageError && error.code === "pending_source_binding_mismatch");
});

test("pending plan rejects a source-query result that misses rows in the bound coverage census", async () => {
  const fixture = pendingProjectionPlanFixture({ queryRecordCount: 1 });
  await assert.rejects(withAppSheetHistoryReviewTestEnvironment(() => prepareAppSheetPendingImportPlan(fixture.tx, {
    snapshotId: fixture.history.snapshot.id,
  })), error => error instanceof AppSheetPendingImportStageError && error.code === "pending_source_projection_incomplete");
});

test("offline manifest accepts known reviewed balances and rejects amounts on an unknown projection", () => {
  const manifest: DeliveryManifestV1 = { version: 1, userId: "driver-1", deviceId: "device-1", leaseId: "lease-1",
    authorizationEpoch: 1, expiresAt: "2026-10-10T12:00:00.000Z",
    storageCertification: { persistent: true, storageCertifiedAt: "2026-10-10T11:00:00.000Z" },
    assignments: [{ id: "delivery-1", orderId: "order-1", version: 1, customerName: "Socio de prueba",
      address: "Domicilio de prueba", window: "", lines: [], documents: [], totalMinor: "10000", verifiedMinor: "2000", refundedMinor: "0",
      currency: "ARS", financialState: "partially_paid", legacyFinancialProjectionState: "reviewed",
      legacyFinancialProjectionReason: null, legacyPaidMinor: "4000", outstandingMinor: "4000" }] };
  assert.doesNotThrow(() => assertManifest(manifest));

  manifest.assignments[0]!.legacyFinancialProjectionState = "unknown";
  manifest.assignments[0]!.legacyFinancialProjectionReason = "historical_payment_review_blocked";
  manifest.assignments[0]!.financialState = null;
  manifest.assignments[0]!.legacyPaidMinor = null;
  manifest.assignments[0]!.outstandingMinor = null;
  assert.doesNotThrow(() => assertManifest(manifest));
  manifest.assignments[0]!.legacyPaidMinor = "4000";
  assert.throws(() => assertManifest(manifest), /proyección financiera desconocida/);
});


test("CollectionVerified rejects a staged legacy settlement before any financial write", async () => {
  const writes: string[] = [];
  const spec = commandSpecs.get("CollectionVerified");
  assert.ok(spec);
  const tx = {
    collectionReport: {
      findUniqueOrThrow: async () => ({ id: "collection-1", orderId: "order-1", status: "reported", currency: "ARS",
        amountMinor: 5_000n, method: "transfer", custodianId: null }),
      update: async () => { writes.push("collection.update"); },
    },
    operationOrder: {
      findUniqueOrThrow: async () => ({ id: "order-1", currency: "ARS", totalMinor: 10_000n, verifiedMinor: 0n,
        refundedMinor: 0n, commercialState: "confirmed", financialState: "unpaid", quote: {} }),
      update: async () => { writes.push("order.update"); },
    },
    operationAccount: {
      findUniqueOrThrow: async () => ({ id: "cash-1", currency: "ARS", kind: "bank", custodianId: null }),
    },
    appSheetLegacySettlement: {
      findUnique: async () => ({ id: "legacy-settlement-1", batchId: "batch-1", operationOrderId: "order-1",
        status: "staged", reviewedBy: null, reviewedAt: null, destinationVersion: 1 }),
    },
    appSheetPendingImportBatch: { findUnique: async () => null },
  } as unknown as Tx;
  const ctx = {
    tx,
    actor: { id: "cashier-1" },
    envelope: { targetId: "collection-1", command: "CollectionVerified", requestId: "00000000-0000-4000-8000-000000000001",
      expectedVersion: 1, occurredAt: "2026-10-10T12:00:00.000Z", schemaVersion: 1,
      data: { accountId: "cash-1", evidence: { receipt: "synthetic" }, excessTreatment: "member_credit" } },
    now: new Date("2026-10-10T12:00:00.000Z"), authorityEpoch: 1,
  } as unknown as CommandContext;

  await assert.rejects(spec.execute(ctx), error => error instanceof OperationError &&
    error.code === "APPSHEET_LEGACY_SETTLEMENT_UNREVIEWED");
  assert.deepEqual(writes, []);
});
