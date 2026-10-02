import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateThirteenWeekScenarioCash,
  aggregateThirteenWeekObligations,
  allocatedCostSold,
  remainingClubCustody,
  assessCoverage,
  calculateContribution,
  calendarWeeks,
  segmentLegacyCustomer,
  sumMoneyByCurrency,
  sumFixedCostsForMonths,
  subtractFixedCostsByCurrency,
} from "../shared/operations/metrics.js";

test("contribution arithmetic preserves minor units beyond JavaScript's safe integer range", () => {
  const result = calculateContribution({
    currency: "ARS",
    netRevenueMinor: "9007199254740993",
    costOfGoodsMinor: "11",
    variableCostsMinor: "2",
  });

  assert.deepEqual(result, {
    currency: "ARS",
    netRevenueMinor: "9007199254740993",
    costOfGoodsMinor: "11",
    variableCostsMinor: "2",
    contributionMinor: "9007199254740980",
  });
});

test("coverage distinguishes missing evidence, an incomplete denominator, and an unattested 100 percent", () => {
  assert.deepEqual(assessCoverage({ knownCount: 12, expectedCount: null }), {
    knownCount: 12,
    expectedCount: null,
    percent: null,
    state: "unknown",
    reason: "missing-expected-total",
  });
  assert.equal(assessCoverage({ knownCount: 2, expectedCount: 3 }).percent, "66.67");
  assert.equal(assessCoverage({ knownCount: 3, expectedCount: 3 }).state, "unverified");
  assert.equal(assessCoverage({ knownCount: 3, expectedCount: 3, attestedComplete: true }).state, "complete");
  assert.equal(assessCoverage({ knownCount: 0, expectedCount: 0 }).state, "not-applicable");
});

test("money totals stay separated by currency and omit currencies with no observed rows", () => {
  assert.deepEqual(sumMoneyByCurrency([
    { currency: "USD", minor: "250" },
    { currency: "ARS", minor: "250" },
    { currency: "ARS", minor: "50" },
  ]), [
    { currency: "ARS", minor: "300" },
    { currency: "USD", minor: "250" },
  ]);
  assert.deepEqual(sumMoneyByCurrency([]), []);
});

test("approved fixed costs recur from their accrual month and preserve the configured currency", () => {
  assert.deepEqual(sumFixedCostsForMonths({
    currency: "ARS",
    fromPeriod: "2026-09",
    throughPeriod: "2026-11",
    items: [
      { amountMinor: "100", accrualPeriod: "2026-08", recurring: true },
      { amountMinor: "50", accrualPeriod: "2026-09", recurring: false },
      { amountMinor: "20", accrualPeriod: "2026-10", recurring: true },
    ],
  }), { currency: "ARS", minor: "390" });

  assert.throws(() => sumFixedCostsForMonths({
    currency: "USD",
    fromPeriod: "2026-10",
    throughPeriod: "2026-09",
    items: [],
  }), /throughPeriod/);
  assert.throws(() => sumFixedCostsForMonths({
    currency: "USD",
    fromPeriod: "2026-09",
    throughPeriod: "2026-09",
    items: [{ amountMinor: "-1", accrualPeriod: "2026-09", recurring: false }],
  }), /cannot be negative/);
});

test("contribution after fixed costs requires an approved amount for each currency and never converts", () => {
  assert.deepEqual(subtractFixedCostsByCurrency([
    { currency: "ARS", minor: "1000" },
    { currency: "USD", minor: "900" },
  ], [
    { currency: "USD", minor: "200" },
    { currency: "ARS", minor: "300" },
  ]), [
    { currency: "ARS", minor: "700" },
    { currency: "USD", minor: "700" },
  ]);
  assert.equal(subtractFixedCostsByCurrency([{ currency: "ARS", minor: "1000" }], null), null);
  assert.equal(subtractFixedCostsByCurrency([{ currency: "USD", minor: "1000" }], [{ currency: "ARS", minor: "100" }]), null);
  assert.equal(subtractFixedCostsByCurrency([], [{ currency: "ARS", minor: "100" }]), null);
});

test("allocated COGS subtracts only returned delivered quantity and carries the lot currency", () => {
  assert.deepEqual(allocatedCostSold({
    currency: "USD",
    costMinor: "100700",
    actualQuantity: "10.07",
    deliveredQuantity: "10.07",
    returnedDeliveredQuantity: "0.07",
  }), { currency: "USD", minor: "100000" });
  assert.deepEqual(allocatedCostSold({
    currency: "ARS",
    costMinor: "100700",
    actualQuantity: "10.07",
    deliveredQuantity: "10.07",
    returnedDeliveredQuantity: "0",
  }), { currency: "ARS", minor: "100700" });
  assert.equal(allocatedCostSold({
    currency: "ARS",
    costMinor: "100",
    actualQuantity: "10",
    deliveredQuantity: "10",
    returnedDeliveredQuantity: "11",
  }), null);
});

test("physical club custody excludes delivered and undelivered-returned quantities by exact allocation", () => {
  assert.equal(remainingClubCustody({
    actualQuantity: "10.125",
    deliveredQuantity: "4.025",
    returnedQuantity: "2.015",
    returnedDeliveredQuantity: "1.005",
  }), "5.090000000000");
  assert.equal(remainingClubCustody({
    actualQuantity: "3",
    deliveredQuantity: "1",
    returnedQuantity: "2",
    returnedDeliveredQuantity: "3",
  }), null);
  assert.equal(remainingClubCustody({
    actualQuantity: "3",
    deliveredQuantity: "2",
    returnedQuantity: "2",
    returnedDeliveredQuantity: "1",
  }), "0.000000000000");
  assert.equal(remainingClubCustody({
    actualQuantity: "3",
    deliveredQuantity: "2",
    returnedQuantity: "2",
    returnedDeliveredQuantity: "0",
  }), null);
});

test("calendar weeks use Monday-to-Sunday buckets across a year boundary", () => {
  assert.deepEqual(calendarWeeks("2026-12-31", "2027-01-04"), [
    {
      week: 1,
      weekStart: "2026-12-28",
      weekEnd: "2027-01-03",
      includedFrom: "2026-12-31",
      includedThrough: "2027-01-03",
    },
    {
      week: 2,
      weekStart: "2027-01-04",
      weekEnd: "2027-01-10",
      includedFrom: "2027-01-04",
      includedThrough: "2027-01-04",
    },
  ]);
});

test("thirteen-week obligations deduplicate IDs, subtract paid amounts, and keep currencies and verification separate", () => {
  const rent = {
    id: "payable-1",
    dueDate: "2026-09-28",
    currency: "ARS" as const,
    amountMinor: "100",
    paidMinor: "20",
    verified: true,
  };
  const result = aggregateThirteenWeekObligations("2026-09-28", [
    rent,
    { ...rent },
    { id: "payable-2", dueDate: "2026-10-04", currency: "USD", amountMinor: "1000", paidMinor: "0", verified: false },
    { id: "payable-3", dueDate: "2026-10-05", currency: "ARS", amountMinor: "40", paidMinor: "10", verified: true },
    { id: "payable-settled", dueDate: "2026-09-29", currency: "ARS", amountMinor: "9", paidMinor: "9", verified: true },
    { id: "outside", dueDate: "2026-12-28", currency: "ARS", amountMinor: "500", paidMinor: "0", verified: true },
  ], "partial");

  assert.equal(result.weeks.length, 13);
  assert.equal(result.weeks[0].weekStart, "2026-09-28");
  assert.equal(result.weeks[12].weekEnd, "2026-12-27");
  assert.equal(result.duplicateRowsIgnored, 1);
  assert.equal(result.sourceCoverage, "partial");
  assert.equal(result.weeks[0].obligationCount, 2);
  assert.equal(result.weeks[0].verifiedCount, 1);
  assert.equal(result.weeks[0].unverifiedCount, 1);
  assert.deepEqual(result.weeks[0].outstandingByCurrency, [
    { currency: "ARS", minor: "80" },
    { currency: "USD", minor: "1000" },
  ]);
  assert.deepEqual(result.weeks[0].verifiedOutstandingByCurrency, [{ currency: "ARS", minor: "80" }]);
  assert.deepEqual(result.weeks[1].outstandingByCurrency, [{ currency: "ARS", minor: "30" }]);
  assert.equal(result.weeks[1].weekStart, "2026-10-05");
});

test("thirteen-week aggregation rejects conflicting duplicate IDs and non-Monday anchors", () => {
  const obligation = { id: "payable-1", dueDate: "2026-09-28", currency: "ARS" as const, amountMinor: "100", paidMinor: "0", verified: true };
  assert.throws(() => aggregateThirteenWeekObligations("2026-09-28", [
    obligation,
    { ...obligation, amountMinor: "101" },
  ], "complete"), /Conflicting duplicate obligation ID/);
  assert.throws(() => aggregateThirteenWeekObligations("2026-09-29", [], "complete"), /must be a Monday/);
});

test("approved cash scenarios project exact weekly flows and suppress duplicated payable commitments", () => {
  const projected = aggregateThirteenWeekScenarioCash("2026-09-28", "ARS", [
    { id: "income-1", date: "2026-09-28", kind: "income", amountMinor: "100" },
    { id: "payment-1", date: "2026-10-01", kind: "payment", amountMinor: "50", commitmentId: "new-payable" },
    { id: "payment-1-replay", date: "2026-10-01", kind: "payment", amountMinor: "50", commitmentId: "new-payable" },
    { id: "existing-payable", date: "2026-10-02", kind: "payment", amountMinor: "70", commitmentId: "payable-1" },
    { id: "conflict-a", date: "2026-10-03", kind: "purchase", amountMinor: "20", commitmentId: "conflicted" },
    { id: "conflict-b", date: "2026-10-03", kind: "purchase", amountMinor: "21", commitmentId: "conflicted" },
    { id: "outside", date: "2026-12-28", kind: "purchase", amountMinor: "15" },
    { id: "invalid", date: "2026-10-02", kind: "funding", amountMinor: "-5" },
  ], new Set(["payable-1"]));

  assert.equal(projected.currency, "ARS");
  assert.equal(projected.inputItemCount, 8);
  assert.equal(projected.includedItemCount, 2);
  assert.equal(projected.outsideHorizonCount, 1);
  assert.equal(projected.duplicateCommitmentCount, 1);
  assert.equal(projected.conflictingCommitmentCount, 2);
  assert.equal(projected.matchedExistingObligationCount, 1);
  assert.equal(projected.unmatchedCommitmentCount, 1);
  assert.equal(projected.invalidItemCount, 1);
  assert.deepEqual(projected.weeks[0], {
    week: 1,
    weekStart: "2026-09-28",
    weekEnd: "2026-10-04",
    itemCount: 2,
    inflowMinor: "100",
    outflowMinor: "50",
    netFlowMinor: "50",
    byKind: [
      { kind: "income", itemCount: 1, amountMinor: "100" },
      { kind: "payment", itemCount: 1, amountMinor: "50" },
    ],
  });
  assert.equal(projected.weeks.length, 13);
  assert.deepEqual(projected.weeks[12], {
    week: 13,
    weekStart: "2026-12-21",
    weekEnd: "2026-12-27",
    itemCount: 0,
    inflowMinor: "0",
    outflowMinor: "0",
    netFlowMinor: "0",
    byKind: [],
  });
});

test("legacy segmentation requires complete profile coverage before applying priority thresholds", () => {
  const base = {
    purchaseCount: 7,
    daysSinceLastPurchase: 104,
    spendARSMinor: "175000000",
    distinctPurchaseMonths: 6,
    maxGrams: "20.000",
  };

  assert.deepEqual(segmentLegacyCustomer(base), {
    segment: "high-spend",
    matchedRule: "ars-spend>=175000000-minor",
    decisionScope: "analysis-only",
    loyaltyApproval: "not-evaluated",
  });
  assert.equal(segmentLegacyCustomer({ ...base, daysSinceLastPurchase: 105 }).segment, "recency-priority");
  assert.equal(segmentLegacyCustomer({ ...base, spendARSMinor: null }).segment, "insufficient-data");
  assert.equal(segmentLegacyCustomer({ ...base, distinctPurchaseMonths: null }).segment, "insufficient-data");
  assert.equal(segmentLegacyCustomer({ ...base, maxGrams: null }).segment, "insufficient-data");
  assert.equal(segmentLegacyCustomer({ ...base, daysSinceLastPurchase: null }).segment, "insufficient-data");
  assert.equal(segmentLegacyCustomer({ ...base, spendARSMinor: "174999999", distinctPurchaseMonths: 5 }).segment, "occasional");
  assert.equal(segmentLegacyCustomer({ ...base, spendARSMinor: "0", distinctPurchaseMonths: 5, maxGrams: "20.0001" }).segment, "large-purchase");
  assert.equal(segmentLegacyCustomer({ ...base, spendARSMinor: "0", distinctPurchaseMonths: 5, maxGrams: "20" }).segment, "occasional");
  assert.equal(segmentLegacyCustomer({ ...base, purchaseCount: 0, daysSinceLastPurchase: null }).segment, "no-purchase-history");
  assert.equal(segmentLegacyCustomer({ ...base, purchaseCount: 0, spendARSMinor: null, distinctPurchaseMonths: null, maxGrams: null, daysSinceLastPurchase: null }).segment, "no-purchase-history");
  assert.equal(segmentLegacyCustomer(base).loyaltyApproval, "not-evaluated");
});
