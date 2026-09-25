import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateCommerceDecisions,
  segmentMembers,
  simulatePromotion,
  type CommerceDecisionInput,
  type MemberSegmentationThresholds,
  type PromotionScenario,
} from "../shared/decision-commerce.js";

const asOfDate = "2026-09-25";

function commerceInput(overrides: Partial<CommerceDecisionInput> = {}): CommerceDecisionInput {
  return {
    asOfDate,
    inventoryLots: [
      {
        productId: "flower-a",
        lotId: "lot-fresh",
        locationId: "shared-room",
        supplierId: "supplier-a",
        quantityMilliunits: 50_000,
        expiresOn: "2026-09-30",
      },
      {
        productId: "flower-a",
        lotId: "lot-old",
        locationId: "backroom",
        supplierId: "supplier-b",
        quantityMilliunits: 5_000,
        expiresOn: "2026-09-24",
      },
    ],
    demandHistory: [
      { productId: "flower-a", date: "2026-09-20", soldMilliunits: 10_000, availability: "available", onHandSnapshotMilliunits: 50_000 },
      { productId: "flower-a", date: "2026-09-21", soldMilliunits: 10_000, availability: "available", onHandSnapshotMilliunits: 40_000 },
      { productId: "flower-a", date: "2026-09-22", soldMilliunits: 999_000, availability: "stockout", onHandSnapshotMilliunits: 30_000 },
      { productId: "flower-a", date: "2026-09-23", soldMilliunits: 10_000, availability: "available", onHandSnapshotMilliunits: 20_000 },
      { productId: "flower-a", date: "2026-09-24", soldMilliunits: 10_000, availability: "available", onHandSnapshotMilliunits: 10_000 },
    ],
    historicalUnitCosts: [
      { productId: "flower-a", supplierId: "supplier-a", observedOn: "2026-08-30", unitCostCentsPerUnit: 800n },
    ],
    replacementQuotes: [
      {
        quoteId: "quote-sep",
        productId: "flower-a",
        supplierId: "supplier-a",
        quotedOn: "2026-09-20",
        validUntil: "2026-10-01",
        unitCostCentsPerUnit: 1_000n,
      },
    ],
    pendingInbound: [
      {
        inboundId: "po-27",
        productId: "flower-a",
        supplierId: "supplier-a",
        locationId: "shared-room",
        quantityMilliunits: 10_000,
        arrivalDate: "2026-09-27",
      },
    ],
    replenishmentRules: [
      {
        productId: "flower-a",
        supplierId: "supplier-a",
        leadTimeDays: 2,
        minimumOrderQuantityMilliunits: 20_000,
        reviewPeriodDays: 3,
      },
    ],
    fulfillmentMapping: {
      status: "known",
      sharedLocationIds: ["shared-room"],
      localLocationIds: ["shared-room"],
      deliveryLocationIds: ["shared-room"],
    },
    cashPosition: { availableCents: 100_000n, floorCents: 80_000n },
    expiryWarningDays: 7,
    ...overrides,
  };
}

test("aggregates lot/location/supplier stock and keeps historical cost separate from its dated replacement quote", () => {
  const result = calculateCommerceDecisions(commerceInput());

  assert.deepEqual(result.inventoryByProductLocationSupplier, [
    { productId: "flower-a", locationId: "backroom", supplierId: "supplier-b", lotCount: 1, quantityMilliunits: 5_000 },
    { productId: "flower-a", locationId: "shared-room", supplierId: "supplier-a", lotCount: 1, quantityMilliunits: 50_000 },
  ]);
  assert.equal(result.inventoryByProduct[0].quantityMilliunits, 55_000);
  assert.equal(result.inventoryByProduct[0].expiredMilliunits, 5_000);
  assert.equal(result.inventoryByProduct[0].expiringSoonMilliunits, 50_000);
  assert.deepEqual(result.costEvidence[0].latestHistoricalCost, {
    observedOn: "2026-08-30",
    unitCostCentsPerUnit: 800n,
  });
  assert.equal(result.costEvidence[0].usableReplacementQuote?.quotedOn, "2026-09-20");
  assert.equal(result.costEvidence[0].usableReplacementQuote?.unitCostCentsPerUnit, 1_000n);
});

test("censors stockout sales, computes cover/turnover, and plans a cash-limited reorder with inbound and MOQ", () => {
  const result = calculateCommerceDecisions(commerceInput());
  const demand = result.demandByProduct[0];
  const reorder = result.reorderDecisions[0].combinedLocalDelivery;

  assert.equal(demand.availableDemandDays, 4);
  assert.equal(demand.censoredStockoutDays, 1);
  assert.equal(demand.observedSalesMilliunits, 40_000);
  assert.equal(demand.averageDailyDemandMilliunits, 10_000);
  assert.equal(demand.sharedOnHandMilliunits, 50_000);
  assert.equal(demand.coverDays, 5);
  assert.equal(demand.turnoverBasisPoints, 13_333);
  assert.equal(demand.stockoutProbabilityBasisPoints, 5_000);
  assert.equal(demand.stockoutProbabilityMethod, "empirical_non_overlapping_lead_time_windows");
  assert.equal(demand.stockoutProbabilitySampleWindows, 2);

  assert.equal(reorder?.status, "cash_limited");
  assert.equal(reorder?.orderDate, "2026-09-29");
  assert.equal(reorder?.desiredQuantityMilliunits, 30_000);
  assert.equal(reorder?.quantityMilliunits, 20_000);
  assert.equal(reorder?.replacementUnitCostCentsPerUnit, 1_000n);
  assert.equal(reorder?.cashImpactCents, 20_000n);
  assert.equal(reorder?.fundingShortfallCents, 10_000n);
  assert.equal(result.cashAvailableAboveFloorCents, 20_000n);
});

test("does not combine local/delivery inventory or emit a numeric stockout probability when mapping is unknown", () => {
  const result = calculateCommerceDecisions(commerceInput({
    fulfillmentMapping: { status: "unknown", reason: "delivery stock source not reconciled" },
  }));
  const demand = result.demandByProduct[0];

  assert.equal(result.reorderDecisions[0].combinedLocalDelivery, null);
  assert.equal(result.reorderDecisions[0].combinedUnavailableReason, "shared_stock_mapping_unknown");
  assert.equal(demand.sharedOnHandMilliunits, null);
  assert.equal(demand.coverDays, null);
  assert.equal(demand.stockoutProbabilityBasisPoints, null);
  assert.equal(demand.stockoutProbabilityMethod, null);
  assert.equal(demand.stockoutProbabilitySampleWindows, 0);
});

test("availability or lead-time uncertainty suppresses stockout probability", () => {
  const withUnknownAvailability = commerceInput({
    demandHistory: [
      ...commerceInput().demandHistory,
      { productId: "flower-a", date: "2026-09-25", soldMilliunits: 0, availability: "unknown", onHandSnapshotMilliunits: null },
    ],
  });
  const unknownAvailabilityResult = calculateCommerceDecisions(withUnknownAvailability);
  assert.equal(unknownAvailabilityResult.demandByProduct[0].stockoutProbabilityBasisPoints, null);
  assert.equal(unknownAvailabilityResult.demandByProduct[0].unknownAvailabilityDays, 1);

  const missingDayResult = calculateCommerceDecisions(commerceInput({
    demandHistory: commerceInput().demandHistory.filter((row) => row.date !== "2026-09-22"),
  }));
  assert.equal(missingDayResult.demandByProduct[0].stockoutProbabilityBasisPoints, null);
  assert.equal(missingDayResult.demandByProduct[0].unknownAvailabilityDays, 1);

  const unknownLeadTimeResult = calculateCommerceDecisions(commerceInput({
    replenishmentRules: [{
      productId: "flower-a",
      supplierId: "supplier-a",
      leadTimeDays: null,
      minimumOrderQuantityMilliunits: 20_000,
      reviewPeriodDays: 3,
    }],
  }));
  assert.equal(unknownLeadTimeResult.demandByProduct[0].stockoutProbabilityBasisPoints, null);
  assert.equal(unknownLeadTimeResult.reorderDecisions[0].combinedLocalDelivery?.reason, "lead_time_unknown");
});

test("stock arriving after lead time cannot lower lead-time stockout frequency", () => {
  const result = calculateCommerceDecisions(commerceInput({
    inventoryLots: [{
      productId: "flower-a",
      lotId: "low-stock",
      locationId: "shared-room",
      supplierId: "supplier-a",
      quantityMilliunits: 15_000,
      expiresOn: null,
    }],
    demandHistory: [
      { productId: "flower-a", date: "2026-09-20", soldMilliunits: 10_000, availability: "available", onHandSnapshotMilliunits: 15_000 },
      { productId: "flower-a", date: "2026-09-21", soldMilliunits: 10_000, availability: "available", onHandSnapshotMilliunits: 15_000 },
      { productId: "flower-a", date: "2026-09-22", soldMilliunits: 10_000, availability: "available", onHandSnapshotMilliunits: 15_000 },
      { productId: "flower-a", date: "2026-09-23", soldMilliunits: 10_000, availability: "available", onHandSnapshotMilliunits: 15_000 },
    ],
    pendingInbound: [{
      inboundId: "late-po",
      productId: "flower-a",
      supplierId: "supplier-a",
      locationId: "shared-room",
      quantityMilliunits: 100_000,
      arrivalDate: "2026-09-30",
    }],
  }));
  assert.equal(result.demandByProduct[0].stockoutProbabilityBasisPoints, 10_000);
  assert.equal(result.demandByProduct[0].stockoutProbabilitySampleWindows, 2);
});

test("blocks combined reorder when physical stock or inbound has no assigned location", () => {
  const unassignedStock = calculateCommerceDecisions(commerceInput({
    inventoryLots: [
      ...commerceInput().inventoryLots,
      { productId: "flower-a", lotId: "lot-unassigned", locationId: null, supplierId: "supplier-a", quantityMilliunits: 1_000, expiresOn: null },
    ],
  }));
  assert.equal(unassignedStock.reorderDecisions[0].combinedLocalDelivery?.reason, "unassigned_inventory_location");
  assert.equal(unassignedStock.demandByProduct[0].stockoutProbabilityBasisPoints, null);

  const unassignedInbound = calculateCommerceDecisions(commerceInput({
    pendingInbound: [
      { inboundId: "po-unknown", productId: "flower-a", supplierId: "supplier-a", locationId: null, quantityMilliunits: 5_000, arrivalDate: "2026-09-27" },
    ],
  }));
  assert.equal(unassignedInbound.reorderDecisions[0].combinedLocalDelivery?.reason, "unassigned_inbound_location");
});

test("historical cost is never substituted for an expired replacement quote", () => {
  const result = calculateCommerceDecisions(commerceInput({
    replacementQuotes: [{
      quoteId: "quote-expired",
      productId: "flower-a",
      supplierId: "supplier-a",
      quotedOn: "2026-09-01",
      validUntil: "2026-09-24",
      unitCostCentsPerUnit: 700n,
    }],
  }));
  assert.equal(result.costEvidence[0].latestHistoricalCost?.unitCostCentsPerUnit, 800n);
  assert.equal(result.costEvidence[0].usableReplacementQuote, null);
  assert.equal(result.reorderDecisions[0].combinedLocalDelivery?.reason, "replacement_quote_unavailable");
});

test("keeps the reorder date visible without cash data and handles a zero-cost replacement quote", () => {
  const noCashPosition = calculateCommerceDecisions(commerceInput({
    cashPosition: { availableCents: null, floorCents: null },
  })).reorderDecisions[0].combinedLocalDelivery;
  assert.equal(noCashPosition?.status, "blocked");
  assert.equal(noCashPosition?.reason, "cash_position_unknown");
  assert.equal(noCashPosition?.orderDate, "2026-09-29");
  assert.equal(noCashPosition?.desiredQuantityMilliunits, 30_000);
  assert.equal(noCashPosition?.cashImpactCents, null);

  const freeQuote = calculateCommerceDecisions(commerceInput({
    replacementQuotes: [{
      quoteId: "quote-free",
      productId: "flower-a",
      supplierId: "supplier-a",
      quotedOn: "2026-09-20",
      validUntil: "2026-10-01",
      unitCostCentsPerUnit: 0n,
    }],
    cashPosition: { availableCents: 0n, floorCents: 0n },
  })).reorderDecisions[0].combinedLocalDelivery;
  assert.equal(freeQuote?.status, "ready");
  assert.equal(freeQuote?.quantityMilliunits, 30_000);
  assert.equal(freeQuote?.cashImpactCents, 0n);
});

test("decision calculation is idempotent and leaves normalized input untouched", () => {
  const input = commerceInput();
  const before = structuredClone(input);
  const first = calculateCommerceDecisions(input);
  const second = calculateCommerceDecisions(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});

const productCatalog = [
  { productId: "flower", unitPriceCents: 2_000n, variableCostCentsPerUnit: 800n },
  { productId: "edible", unitPriceCents: 1_000n, variableCostCentsPerUnit: 600n },
  { productId: "freebie", unitPriceCents: 300n, variableCostCentsPerUnit: 200n },
];

test("promotion simulator handles mixed products, line discounts, shipping and freebies", () => {
  const promoted: PromotionScenario = {
    name: "bundle",
    lines: [
      { productId: "flower", quantityMilliunits: 1_000, discount: { kind: "percent_bps", value: 2_500 } },
      { productId: "edible", quantityMilliunits: 2_000, discount: { kind: "fixed_cents", value: 300n } },
    ],
    shippingChargedCents: 500n,
    shippingCostCents: 800n,
    freebies: [{ productId: "freebie", quantityMilliunits: 1_000 }],
    campaignCostCents: 100n,
  };
  const reference: PromotionScenario = {
    name: "regular basket",
    lines: [
      { productId: "flower", quantityMilliunits: 1_000, discount: { kind: "percent_bps", value: 0 } },
      { productId: "edible", quantityMilliunits: 2_000, discount: { kind: "fixed_cents", value: 0n } },
    ],
    shippingChargedCents: 500n,
    shippingCostCents: 800n,
    freebies: [],
    campaignCostCents: 0n,
  };
  const result = simulatePromotion({ products: productCatalog, promoted, reference });

  assert.equal(result.promoted.merchandiseGrossCents, 4_000n);
  assert.equal(result.promoted.lineDiscountCents, 800n);
  assert.equal(result.promoted.merchandiseNetCents, 3_200n);
  assert.equal(result.promoted.variableCostCents, 2_000n);
  assert.equal(result.promoted.freebieCostCents, 200n);
  assert.equal(result.promoted.contributionCents, 600n);
  assert.equal(result.reference?.contributionCents, 1_700n);
  assert.equal(result.contributionDifferenceCents, -1_100n);
  assert.equal(result.incrementalOrdersToBreakEvenPerReferenceOrder, 2);
  assert.equal(result.breakEvenStatus, "incremental_volume_required");
  assert.equal(result.comparisonInterpretation, "descriptive_only");
});

test("promotion with nonpositive contribution cannot recover its lost margin through volume", () => {
  const result = simulatePromotion({
    products: [{ productId: "loss", unitPriceCents: 1_000n, variableCostCentsPerUnit: 1_500n }],
    promoted: {
      name: "loss leader",
      lines: [{ productId: "loss", quantityMilliunits: 1_000, discount: { kind: "percent_bps", value: 0 } }],
      shippingChargedCents: 0n,
      shippingCostCents: 0n,
      freebies: [],
      campaignCostCents: 0n,
    },
    reference: {
      name: "reference",
      lines: [{ productId: "loss", quantityMilliunits: 1_000, discount: { kind: "percent_bps", value: 0 } }],
      shippingChargedCents: 1_000n,
      shippingCostCents: 0n,
      freebies: [],
      campaignCostCents: 0n,
    },
  });
  assert.equal(result.promoted.contributionCents, -500n);
  assert.equal(result.incrementalOrdersToBreakEvenPerReferenceOrder, null);
  assert.equal(result.breakEvenStatus, "unreachable_nonpositive_contribution");
});

test("member RFM output is limited to human-review lists and excludes permit fields", () => {
  const thresholds: MemberSegmentationThresholds = {
    recentDays: 30,
    coolingDays: 90,
    mediumFrequencyPurchases: 3,
    highFrequencyPurchases: 10,
    mediumSpendCents: 10_000n,
    highSpendCents: 30_000n,
  };
  const importedMemberWithPermit = {
    memberId: "recent-high",
    lastPurchaseDate: "2026-09-20",
    purchaseCount: 10,
    spendCents: 50_000n,
    permitStatus: "verified",
  };
  const result = segmentMembers(asOfDate, [
    importedMemberWithPermit,
    { memberId: "lapsed-high", lastPurchaseDate: "2026-06-01", purchaseCount: 5, spendCents: 40_000n },
    { memberId: "new", lastPurchaseDate: "2026-09-23", purchaseCount: 1, spendCents: 1_000n },
    { memberId: "missing-date", lastPurchaseDate: null, purchaseCount: 4, spendCents: 15_000n },
  ], thresholds);

  assert.deepEqual(result.reviewLists.recentHighSpend, ["recent-high"]);
  assert.deepEqual(result.reviewLists.frequentCore, ["recent-high"]);
  assert.deepEqual(result.reviewLists.lapsedHighSpend, ["lapsed-high"]);
  assert.deepEqual(result.reviewLists.newOrLowHistory, ["new"]);
  assert.equal(result.members.find((member) => member.memberId === "missing-date")?.recencyBand, "unknown");
  assert.equal("permitStatus" in result.members[0], false);
  assert.equal(result.usage, "human_review_only_no_messages_no_permit_data");
});

test("rejects fractional milliunits and a fulfillment channel outside the declared shared pool", () => {
  assert.throws(() => calculateCommerceDecisions(commerceInput({
    inventoryLots: [{
      productId: "flower-a",
      lotId: "fraction",
      locationId: "shared-room",
      supplierId: "supplier-a",
      quantityMilliunits: 1.5,
      expiresOn: null,
    }],
  })), /safe integer in milliunits/);

  assert.throws(() => calculateCommerceDecisions(commerceInput({
    fulfillmentMapping: {
      status: "known",
      sharedLocationIds: ["shared-room"],
      localLocationIds: ["another-room"],
      deliveryLocationIds: [],
    },
  })), /part of sharedLocationIds/);

  assert.throws(() => calculateCommerceDecisions(commerceInput({
    cashPosition: { availableCents: 10_000n, floorCents: null },
  })), /both be known or both be unknown/);
});
