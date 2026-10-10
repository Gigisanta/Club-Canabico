import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import "../server/operations/finance.js";
import { appSheetLegacyFinancialBasisHash, appSheetPendingOrderCommercialBasisHash } from "../server/operations/appsheet-pending-import.js";
import { commandSpecs, OperationError, type CommandContext, type Tx } from "../server/operations/core.js";
import { APPSHEET_PENDING_MAPPING_ID, APPSHEET_PENDING_SCHEMA_VERSION } from "../shared/operations/appsheet-pending.js";
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

function reviewedSettlementFixture(order = commercialOrder()) {
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
  const commercialBasisHash = appSheetPendingOrderCommercialBasisHash(order);
  assert.ok(commercialBasisHash);
  const financialBasisHash = appSheetLegacyFinancialBasisHash({ orderId: order.id, memberId: order.memberId,
    currency: order.currency, totalMinor: order.totalMinor, commercialBasisHash, captureId,
    sourceRecordId, sourceRecordHash, sourceKeyHash, reconciliationHash, mappingHash,
    mappingReviewerId, mappingEvidenceHash, mappedOrderVersion: operationOrderVersion, mappedOrderHash: operationOrderHash });
  const destinationHash = canonicalHash({ kind: "legacy-settlement", captureId, manifestHash,
    sourceRecordId, sourceRecordHash, reconciliationHash, mappingHash,
    operationOrderId: order.id, operationOrderMemberId: order.memberId, financialBasisHash,
    operationOrderVersion, operationOrderHash, orderMappingReviewerId: mappingReviewerId,
    orderMappingEvidenceHash: mappingEvidenceHash, operationOrderCurrency: order.currency,
    operationOrderTotalMinor: order.totalMinor.toString(), dueMinor: "10000", legacyPaidMinor: "4000",
    remainingMinor: "6000", paymentRowsHash, paymentReferences: [] });
  const settlementId = "legacy-settlement-1", dispositionId = "disposition-1";
  const reviewedAt = new Date("2026-10-08T12:00:00.000Z");
  const reviewBinding = {
    captureId, manifestHash, dataHash, mappingHash, sourceSpecHash: hash("source-spec"),
    sourceCoverageHash: hash("source-coverage"), dispositionHash: hash("disposition-hash"),
    destinationHash: hash("batch-destination"), destinationVersion: 1, projectionHash: hash("projection"),
    target: "isolated-test", destinationIdentity: `appsheet-db-v1:${hash("destination-identity")}`,
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
  const source = { sourceTable: "C_Facturacion", sourceKey, contentHash: sourceRecordHash,
    normalized: { pendingReconciliation: reconciliation }, resolution };
  const snapshot = { status: "reviewed", createdBy: "snapshot-creator", reviewedBy: "snapshot-reviewer" };
  const users = ["importer", "destination-reviewer", "stage-reviewer", mappingReviewerId,
    snapshot.createdBy, snapshot.reviewedBy].map(id => ({ id, active: true, role: "owner", authorizationEpoch: 1 }));
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
    operationAccess: { findUnique: async () => null },
    appSheetLegacySettlement: { findUnique: async () => settlement },
    appSheetPendingImportBatch: { findUnique: async () => batch },
    appSheetPendingImportDisposition: { findUnique: async () => disposition },
    operationObject: {
      findUnique: async () => ({ kind: "legacyImport", version: 1 }),
      update: async () => { writes.push("object.update"); },
      create: async () => { writes.push("object.create"); },
    },
    legacyImportSnapshot: { findUnique: async () => snapshot },
    legacySourceRecord: { findUnique: async () => source },
    legacyIdentity: { findUnique: async () => ({ destinationId: order.id, approvedBy: mappingReviewerId }) },
    user: {
      findMany: async () => users,
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
  return { tx, writes, order, settlement, orderState, orderUpdates, collectionReports };
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
  const result = await spec.execute(commandContext(fixture.tx, "CollectionVerified"));
  assert.equal(result.result.appliedMinor, 6_000n);
  assert.equal(result.result.excessMinor, 2_000n);
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
  const first = await spec.execute(commandContext(fixture.tx, "CollectionVerified", { appliedMinor: "4000" }));
  const second = await spec.execute(commandContext(fixture.tx, "CollectionVerified", { targetId: "collection-2", appliedMinor: "3000" }));
  const third = await spec.execute(commandContext(fixture.tx, "CollectionVerified", { targetId: "collection-3", appliedMinor: "2000" }));

  assert.deepEqual([first.result.appliedMinor, second.result.appliedMinor, third.result.appliedMinor], [4_000n, 2_000n, 0n]);
  assert.deepEqual([first.result.excessMinor, second.result.excessMinor, third.result.excessMinor], [4_000n, 1_000n, 2_000n]);
  assert.equal(fixture.orderState.verifiedMinor, 6_000n, "Bombo receipts cannot apply beyond the 6,000 left after legacy paid");
  assert.equal(fixture.orderState.financialState, "paid");
  assert.deepEqual(["collection-1", "collection-2", "collection-3"].map(id => fixture.collectionReports.get(id)?.status),
    ["verified", "verified", "verified"], "real cash receipt reports remain independently recorded");
});

test("MemberCreditApplied uses a reviewed legacy settlement when calculating the remaining order debt", async () => {
  const fixture = reviewedSettlementFixture();
  const spec = commandSpecs.get("MemberCreditApplied");
  assert.ok(spec);
  const result = await spec.execute(commandContext(fixture.tx, "MemberCreditApplied"));

  assert.equal(result.result.appliedMinor, 5_000n);
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
    await assert.rejects(spec.execute(commandContext(fixture.tx, command)), error => error instanceof OperationError &&
      error.code === "APPSHEET_LEGACY_SETTLEMENT_TARGET_CHANGED");
    assert.deepEqual(fixture.writes, [], `${command} must reject before ledger, credit, receipt, or order writes`);
  }
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
