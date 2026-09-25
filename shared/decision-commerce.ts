export type CommerceDate = string;
export type Milliunits = number;
export type Cents = bigint;

export interface InventoryLotInput {
  productId: string;
  lotId: string;
  locationId: string | null;
  supplierId: string;
  quantityMilliunits: Milliunits;
  expiresOn: CommerceDate | null;
}

export interface DailyDemandObservation {
  productId: string;
  date: CommerceDate;
  soldMilliunits: Milliunits;
  availability: "available" | "stockout" | "unknown";
  onHandSnapshotMilliunits: Milliunits | null;
}

export interface HistoricalUnitCost {
  productId: string;
  supplierId: string;
  observedOn: CommerceDate;
  unitCostCentsPerUnit: Cents;
}

export interface ReplacementQuote {
  quoteId: string;
  productId: string;
  supplierId: string;
  quotedOn: CommerceDate;
  validUntil: CommerceDate | null;
  unitCostCentsPerUnit: Cents;
}

export interface PendingInbound {
  inboundId: string;
  productId: string;
  supplierId: string;
  locationId: string | null;
  quantityMilliunits: Milliunits;
  arrivalDate: CommerceDate;
}

export interface ReplenishmentRule {
  productId: string;
  supplierId: string;
  leadTimeDays: number | null;
  minimumOrderQuantityMilliunits: Milliunits;
  reviewPeriodDays: number;
}

export type FulfillmentStockMapping =
  | {
      status: "known";
      sharedLocationIds: string[];
      localLocationIds: string[];
      deliveryLocationIds: string[];
    }
  | { status: "unknown"; reason?: string };

export interface CashPosition {
  availableCents: Cents | null;
  floorCents: Cents | null;
}

export interface CommerceDecisionInput {
  asOfDate: CommerceDate;
  inventoryLots: InventoryLotInput[];
  demandHistory: DailyDemandObservation[];
  historicalUnitCosts: HistoricalUnitCost[];
  replacementQuotes: ReplacementQuote[];
  pendingInbound: PendingInbound[];
  replenishmentRules: ReplenishmentRule[];
  fulfillmentMapping: FulfillmentStockMapping;
  cashPosition: CashPosition;
  expiryWarningDays: number;
}

export type ExpiryStatus = "unknown" | "expired" | "due_soon" | "not_due";

export interface InventoryLotPosition extends InventoryLotInput {
  daysUntilExpiry: number | null;
  expiryStatus: ExpiryStatus;
}

export interface ProductLocationSupplierInventory {
  productId: string;
  locationId: string | null;
  supplierId: string;
  lotCount: number;
  quantityMilliunits: Milliunits;
}

export interface ProductSupplierInventory {
  productId: string;
  supplierId: string;
  lotCount: number;
  quantityMilliunits: Milliunits;
  locationIds: Array<string | null>;
}

export interface ProductInventorySummary {
  productId: string;
  lotCount: number;
  quantityMilliunits: Milliunits;
  unassignedLocationMilliunits: Milliunits;
  expiredMilliunits: Milliunits;
  expiringSoonMilliunits: Milliunits;
}

export interface CostEvidence {
  productId: string;
  supplierId: string;
  latestHistoricalCost: {
    observedOn: CommerceDate;
    unitCostCentsPerUnit: Cents;
  } | null;
  replacementQuotes: Array<ReplacementQuote & { usableOnAsOfDate: boolean }>;
  usableReplacementQuote: ReplacementQuote | null;
}

export interface ProductDemandSummary {
  productId: string;
  availableDemandDays: number;
  censoredStockoutDays: number;
  unknownAvailabilityDays: number;
  observedSalesMilliunits: Milliunits;
  averageDailyDemandMilliunits: Milliunits | null;
  sharedOnHandMilliunits: Milliunits | null;
  coverDays: number | null;
  turnoverBasisPoints: number | null;
  stockoutProbabilityBasisPoints: number | null;
  stockoutProbabilityMethod: "empirical_non_overlapping_lead_time_windows" | null;
  stockoutProbabilitySampleWindows: number;
}

export type ReorderBlockReason =
  | "shared_stock_mapping_unknown"
  | "unassigned_inventory_location"
  | "unassigned_inbound_location"
  | "overdue_inbound_uncertain"
  | "demand_unknown"
  | "no_observed_demand"
  | "lead_time_unknown"
  | "replacement_quote_unavailable"
  | "cash_position_unknown"
  | "cash_floor_protected"
  | "order_date_out_of_range";

export interface ReorderCandidate {
  productId: string;
  supplierId: string;
  status: "ready" | "cash_limited" | "blocked";
  reason: ReorderBlockReason | null;
  orderDate: CommerceDate | null;
  desiredQuantityMilliunits: Milliunits | null;
  quantityMilliunits: Milliunits | null;
  replacementUnitCostCentsPerUnit: Cents | null;
  cashImpactCents: Cents | null;
  fundingShortfallCents: Cents | null;
  projectedPositionAtOrderMilliunits: Milliunits | null;
  projectedPositionAtReceiptMilliunits: Milliunits | null;
}

export interface ProductReorderDecision {
  productId: string;
  combinedLocalDelivery: ReorderCandidate | null;
  combinedUnavailableReason: "shared_stock_mapping_unknown" | null;
}

export interface CommerceDecisionResult {
  asOfDate: CommerceDate;
  inventoryByLotLocationSupplier: InventoryLotPosition[];
  inventoryByProductLocationSupplier: ProductLocationSupplierInventory[];
  inventoryByProductSupplier: ProductSupplierInventory[];
  inventoryByProduct: ProductInventorySummary[];
  costEvidence: CostEvidence[];
  demandByProduct: ProductDemandSummary[];
  reorderDecisions: ProductReorderDecision[];
  cashAvailableAboveFloorCents: Cents | null;
}

const MILLIUNITS_PER_UNIT = 1_000n;
const BASIS_POINTS = 10_000n;

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${field} must be a non-empty string`);
}

function requireDate(value: CommerceDate, field: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`${field} must be an ISO date (YYYY-MM-DD)`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > monthDays[month - 1])
    throw new Error(`${field} is not a calendar date`);
}

function requireMilliunits(value: Milliunits, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative safe integer in milliunits`);
}

function requireDays(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${field} must be a non-negative whole number of days`);
}

function requireCents(value: Cents, field: string): void {
  if (typeof value !== "bigint" || value < 0n)
    throw new Error(`${field} must be a non-negative bigint in cents`);
}

function dateToDay(value: CommerceDate): number {
  const [year, month, day] = value.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function dayToDate(day: number): CommerceDate | null {
  if (!Number.isSafeInteger(day)) return null;
  const date = new Date(day * 86_400_000);
  if (!Number.isFinite(date.getTime())) return null;
  const result = date.toISOString().slice(0, 10);
  return result.startsWith("0") ? null : result;
}

function addDays(date: CommerceDate, days: number): CommerceDate | null {
  return dayToDate(dateToDay(date) + days);
}

function dayDifference(later: CommerceDate, earlier: CommerceDate): number {
  return dateToDay(later) - dateToDay(earlier);
}

function safeSum(values: number[], field: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) throw new Error(`${field} exceeds safe integer range`);
  }
  return total;
}

function toSafeInteger(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${field} exceeds safe integer range`);
  return Number(value);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n)
    throw new Error("ceilDiv requires a non-negative numerator and positive denominator");
  return (numerator + denominator - 1n) / denominator;
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n)
    throw new Error("roundHalfUp requires a non-negative numerator and positive denominator");
  return (numerator + denominator / 2n) / denominator;
}

function costForMilliunits(unitCostCentsPerUnit: Cents, quantityMilliunits: Milliunits): Cents {
  return ceilDiv(unitCostCentsPerUnit * BigInt(quantityMilliunits), MILLIUNITS_PER_UNIT);
}

function validateCommerceInput(input: CommerceDecisionInput): void {
  requireDate(input.asOfDate, "asOfDate");
  requireDays(input.expiryWarningDays, "expiryWarningDays");
  const lotKeys = new Set<string>();
  for (const lot of input.inventoryLots) {
    requireText(lot.productId, "inventoryLots.productId");
    requireText(lot.lotId, "inventoryLots.lotId");
    if (lot.locationId !== null) requireText(lot.locationId, "inventoryLots.locationId");
    requireText(lot.supplierId, "inventoryLots.supplierId");
    requireMilliunits(lot.quantityMilliunits, "inventoryLots.quantityMilliunits");
    if (lot.expiresOn !== null) requireDate(lot.expiresOn, "inventoryLots.expiresOn");
    const key = JSON.stringify([lot.productId, lot.lotId, lot.locationId, lot.supplierId]);
    if (lotKeys.has(key)) throw new Error("inventory lot/location/supplier rows must be unique");
    lotKeys.add(key);
  }
  const demandKeys = new Set<string>();
  for (const observation of input.demandHistory) {
    requireText(observation.productId, "demandHistory.productId");
    requireDate(observation.date, "demandHistory.date");
    requireMilliunits(observation.soldMilliunits, "demandHistory.soldMilliunits");
    if (observation.onHandSnapshotMilliunits !== null)
      requireMilliunits(observation.onHandSnapshotMilliunits, "demandHistory.onHandSnapshotMilliunits");
    if (!["available", "stockout", "unknown"].includes(observation.availability))
      throw new Error("demandHistory.availability is invalid");
    const key = JSON.stringify([observation.productId, observation.date]);
    if (demandKeys.has(key)) throw new Error("demand history must have one row per product and date");
    demandKeys.add(key);
  }
  const historicalKeys = new Set<string>();
  for (const cost of input.historicalUnitCosts) {
    requireText(cost.productId, "historicalUnitCosts.productId");
    requireText(cost.supplierId, "historicalUnitCosts.supplierId");
    requireDate(cost.observedOn, "historicalUnitCosts.observedOn");
    requireCents(cost.unitCostCentsPerUnit, "historicalUnitCosts.unitCostCentsPerUnit");
    const key = JSON.stringify([cost.productId, cost.supplierId, cost.observedOn]);
    if (historicalKeys.has(key)) throw new Error("historical costs must be unique per product, supplier, and date");
    historicalKeys.add(key);
  }
  const quoteIds = new Set<string>();
  for (const quote of input.replacementQuotes) {
    requireText(quote.quoteId, "replacementQuotes.quoteId");
    requireText(quote.productId, "replacementQuotes.productId");
    requireText(quote.supplierId, "replacementQuotes.supplierId");
    requireDate(quote.quotedOn, "replacementQuotes.quotedOn");
    if (quote.validUntil !== null) requireDate(quote.validUntil, "replacementQuotes.validUntil");
    if (quote.validUntil !== null && quote.validUntil < quote.quotedOn)
      throw new Error("replacement quote cannot expire before it was quoted");
    requireCents(quote.unitCostCentsPerUnit, "replacementQuotes.unitCostCentsPerUnit");
    if (quoteIds.has(quote.quoteId)) throw new Error("replacement quote ids must be unique");
    quoteIds.add(quote.quoteId);
  }
  const inboundIds = new Set<string>();
  for (const inbound of input.pendingInbound) {
    requireText(inbound.inboundId, "pendingInbound.inboundId");
    requireText(inbound.productId, "pendingInbound.productId");
    requireText(inbound.supplierId, "pendingInbound.supplierId");
    if (inbound.locationId !== null) requireText(inbound.locationId, "pendingInbound.locationId");
    requireMilliunits(inbound.quantityMilliunits, "pendingInbound.quantityMilliunits");
    requireDate(inbound.arrivalDate, "pendingInbound.arrivalDate");
    if (inboundIds.has(inbound.inboundId)) throw new Error("pending inbound ids must be unique");
    inboundIds.add(inbound.inboundId);
  }
  const ruleProducts = new Set<string>();
  for (const rule of input.replenishmentRules) {
    requireText(rule.productId, "replenishmentRules.productId");
    requireText(rule.supplierId, "replenishmentRules.supplierId");
    if (rule.leadTimeDays !== null) requireDays(rule.leadTimeDays, "replenishmentRules.leadTimeDays");
    requireMilliunits(rule.minimumOrderQuantityMilliunits, "replenishmentRules.minimumOrderQuantityMilliunits");
    requireDays(rule.reviewPeriodDays, "replenishmentRules.reviewPeriodDays");
    if (ruleProducts.has(rule.productId)) throw new Error("there must be one replenishment rule per product");
    ruleProducts.add(rule.productId);
  }
  if (input.fulfillmentMapping.status === "known") {
    const shared = new Set(input.fulfillmentMapping.sharedLocationIds);
    if (shared.size !== input.fulfillmentMapping.sharedLocationIds.length)
      throw new Error("sharedLocationIds must be unique");
    for (const [field, ids] of [
      ["localLocationIds", input.fulfillmentMapping.localLocationIds],
      ["deliveryLocationIds", input.fulfillmentMapping.deliveryLocationIds],
    ] as const) {
      if (new Set(ids).size !== ids.length) throw new Error(`${field} must be unique`);
      for (const id of ids) {
        requireText(id, field);
        if (!shared.has(id)) throw new Error(`${field} entries must be part of sharedLocationIds`);
      }
    }
  }
  if (input.cashPosition.availableCents !== null)
    requireCents(input.cashPosition.availableCents, "cashPosition.availableCents");
  if (input.cashPosition.floorCents !== null)
    requireCents(input.cashPosition.floorCents, "cashPosition.floorCents");
  if ((input.cashPosition.availableCents === null) !== (input.cashPosition.floorCents === null))
    throw new Error("cash available and cash floor must both be known or both be unknown");
}

function mappingLocationSet(mapping: FulfillmentStockMapping): Set<string> | null {
  return mapping.status === "known" ? new Set(mapping.sharedLocationIds) : null;
}

function buildInventory(input: CommerceDecisionInput): {
  lots: InventoryLotPosition[];
  byProductLocationSupplier: ProductLocationSupplierInventory[];
  byProductSupplier: ProductSupplierInventory[];
  byProduct: ProductInventorySummary[];
} {
  const warningEndDate = addDays(input.asOfDate, input.expiryWarningDays);
  const warningEndDay = warningEndDate === null ? Number.MAX_SAFE_INTEGER : dateToDay(warningEndDate);
  const lots: InventoryLotPosition[] = input.inventoryLots.map((lot) => {
    const daysUntilExpiry = lot.expiresOn === null ? null : dayDifference(lot.expiresOn, input.asOfDate);
    const expiryStatus: ExpiryStatus =
      lot.expiresOn === null
        ? "unknown"
        : daysUntilExpiry! < 0
          ? "expired"
          : dateToDay(lot.expiresOn) <= warningEndDay
            ? "due_soon"
            : "not_due";
    return { ...lot, daysUntilExpiry, expiryStatus };
  }).sort((a, b) =>
    a.productId.localeCompare(b.productId) ||
    (a.locationId ?? "").localeCompare(b.locationId ?? "") ||
    a.supplierId.localeCompare(b.supplierId) ||
    a.lotId.localeCompare(b.lotId),
  );

  const grouped = new Map<string, ProductLocationSupplierInventory>();
  const supplierGrouped = new Map<string, ProductSupplierInventory>();
  const productGrouped = new Map<string, ProductInventorySummary>();
  for (const lot of lots) {
    const locationKey = JSON.stringify([lot.productId, lot.locationId, lot.supplierId]);
    const locationTotal = grouped.get(locationKey) ?? {
      productId: lot.productId,
      locationId: lot.locationId,
      supplierId: lot.supplierId,
      lotCount: 0,
      quantityMilliunits: 0,
    };
    locationTotal.lotCount++;
    locationTotal.quantityMilliunits = safeSum(
      [locationTotal.quantityMilliunits, lot.quantityMilliunits],
      "product/location/supplier inventory",
    );
    grouped.set(locationKey, locationTotal);

    const supplierKey = JSON.stringify([lot.productId, lot.supplierId]);
    const supplierTotal = supplierGrouped.get(supplierKey) ?? {
      productId: lot.productId,
      supplierId: lot.supplierId,
      lotCount: 0,
      quantityMilliunits: 0,
      locationIds: [],
    };
    supplierTotal.lotCount++;
    supplierTotal.quantityMilliunits = safeSum(
      [supplierTotal.quantityMilliunits, lot.quantityMilliunits],
      "product/supplier inventory",
    );
    if (!supplierTotal.locationIds.includes(lot.locationId)) supplierTotal.locationIds.push(lot.locationId);
    supplierGrouped.set(supplierKey, supplierTotal);

    const productTotal = productGrouped.get(lot.productId) ?? {
      productId: lot.productId,
      lotCount: 0,
      quantityMilliunits: 0,
      unassignedLocationMilliunits: 0,
      expiredMilliunits: 0,
      expiringSoonMilliunits: 0,
    };
    productTotal.lotCount++;
    productTotal.quantityMilliunits = safeSum(
      [productTotal.quantityMilliunits, lot.quantityMilliunits],
      "product inventory",
    );
    if (lot.locationId === null)
      productTotal.unassignedLocationMilliunits = safeSum(
        [productTotal.unassignedLocationMilliunits, lot.quantityMilliunits],
        "unassigned inventory",
      );
    if (lot.expiryStatus === "expired")
      productTotal.expiredMilliunits = safeSum(
        [productTotal.expiredMilliunits, lot.quantityMilliunits],
        "expired inventory",
      );
    if (lot.expiryStatus === "due_soon")
      productTotal.expiringSoonMilliunits = safeSum(
        [productTotal.expiringSoonMilliunits, lot.quantityMilliunits],
        "expiring inventory",
      );
    productGrouped.set(lot.productId, productTotal);
  }
  for (const item of supplierGrouped.values()) item.locationIds.sort((a, b) => (a ?? "").localeCompare(b ?? ""));
  return {
    lots,
    byProductLocationSupplier: [...grouped.values()].sort((a, b) =>
      a.productId.localeCompare(b.productId) ||
      (a.locationId ?? "").localeCompare(b.locationId ?? "") ||
      a.supplierId.localeCompare(b.supplierId),
    ),
    byProductSupplier: [...supplierGrouped.values()].sort((a, b) =>
      a.productId.localeCompare(b.productId) || a.supplierId.localeCompare(b.supplierId),
    ),
    byProduct: [...productGrouped.values()].sort((a, b) => a.productId.localeCompare(b.productId)),
  };
}

function buildCostEvidence(input: CommerceDecisionInput): CostEvidence[] {
  const grouped = new Map<string, { productId: string; supplierId: string; historical: HistoricalUnitCost[]; quotes: ReplacementQuote[] }>();
  const getGroup = (productId: string, supplierId: string) => {
    const key = JSON.stringify([productId, supplierId]);
    let group = grouped.get(key);
    if (!group) {
      group = { productId, supplierId, historical: [], quotes: [] };
      grouped.set(key, group);
    }
    return group;
  };
  for (const cost of input.historicalUnitCosts) {
    if (cost.observedOn <= input.asOfDate) getGroup(cost.productId, cost.supplierId).historical.push(cost);
  }
  for (const quote of input.replacementQuotes) {
    if (quote.quotedOn <= input.asOfDate) getGroup(quote.productId, quote.supplierId).quotes.push(quote);
  }
  return [...grouped.values()].map((group) => {
    group.historical.sort((a, b) => b.observedOn.localeCompare(a.observedOn));
    group.quotes.sort((a, b) => b.quotedOn.localeCompare(a.quotedOn) || a.quoteId.localeCompare(b.quoteId));
    const replacementQuotes = group.quotes.map((quote) => ({
      ...quote,
      usableOnAsOfDate: quote.validUntil === null || quote.validUntil >= input.asOfDate,
    }));
    const usable = replacementQuotes.find((quote) => quote.usableOnAsOfDate);
    return {
      productId: group.productId,
      supplierId: group.supplierId,
      latestHistoricalCost: group.historical[0]
        ? {
            observedOn: group.historical[0].observedOn,
            unitCostCentsPerUnit: group.historical[0].unitCostCentsPerUnit,
          }
        : null,
      replacementQuotes,
      usableReplacementQuote: usable
        ? {
            quoteId: usable.quoteId,
            productId: usable.productId,
            supplierId: usable.supplierId,
            quotedOn: usable.quotedOn,
            validUntil: usable.validUntil,
            unitCostCentsPerUnit: usable.unitCostCentsPerUnit,
          }
        : null,
    };
  }).sort((a, b) => a.productId.localeCompare(b.productId) || a.supplierId.localeCompare(b.supplierId));
}

function summarizeDemand(
  input: CommerceDecisionInput,
  inventory: InventoryLotPosition[],
  rulesByProduct: Map<string, ReplenishmentRule>,
): ProductDemandSummary[] {
  const historyByProduct = new Map<string, DailyDemandObservation[]>();
  for (const observation of input.demandHistory) {
    if (observation.date > input.asOfDate) continue;
    const rows = historyByProduct.get(observation.productId) ?? [];
    rows.push(observation);
    historyByProduct.set(observation.productId, rows);
  }
  const locationSet = mappingLocationSet(input.fulfillmentMapping);
  const productIds = new Set<string>([
    ...historyByProduct.keys(),
    ...inventory.map((lot) => lot.productId),
    ...rulesByProduct.keys(),
  ]);
  for (const inbound of input.pendingInbound) productIds.add(inbound.productId);

  return [...productIds].sort().map((productId) => {
    const rows = (historyByProduct.get(productId) ?? []).sort((a, b) => a.date.localeCompare(b.date));
    const availableRows = rows.filter((row) => row.availability === "available");
    const stockoutRows = rows.filter((row) => row.availability === "stockout");
    const unknownRows = rows.filter((row) => row.availability === "unknown");
    const missingObservationDays = rows.length < 2
      ? 0
      : Math.max(0, dayDifference(rows[rows.length - 1].date, rows[0].date) + 1 - rows.length);
    const unknownAvailabilityDays = unknownRows.length + missingObservationDays;
    const observedSalesMilliunits = safeSum(
      availableRows.map((row) => row.soldMilliunits),
      "observed available demand",
    );
    const averageDailyDemandMilliunits = availableRows.length === 0
      ? null
      : toSafeInteger(ceilDiv(BigInt(observedSalesMilliunits), BigInt(availableRows.length)), "average daily demand");

    const productLots = inventory.filter((lot) => lot.productId === productId);
    const hasUnassignedStock = productLots.some((lot) => lot.locationId === null && lot.quantityMilliunits > 0);
    const sharedOnHandMilliunits = locationSet === null || hasUnassignedStock
      ? null
      : safeSum(
          productLots
            .filter((lot) => lot.locationId !== null && locationSet.has(lot.locationId))
            .map((lot) => lot.quantityMilliunits),
          "shared on-hand inventory",
        );
    const coverDays = sharedOnHandMilliunits === null || averageDailyDemandMilliunits === null || averageDailyDemandMilliunits === 0
      ? null
      : Math.floor(sharedOnHandMilliunits / averageDailyDemandMilliunits);

    const snapshotRows = availableRows.filter((row) => row.onHandSnapshotMilliunits !== null);
    const snapshotTotal = safeSum(snapshotRows.map((row) => row.onHandSnapshotMilliunits!), "inventory snapshots");
    const snapshotSalesMilliunits = safeSum(snapshotRows.map((row) => row.soldMilliunits), "snapshot-day sales");
    const turnoverBasisPoints = snapshotRows.length === 0 || snapshotTotal === 0
      ? null
      : toSafeInteger(
          (BigInt(snapshotSalesMilliunits) * BigInt(snapshotRows.length) * BASIS_POINTS) / BigInt(snapshotTotal),
          "turnover basis points",
        );

    const rule = rulesByProduct.get(productId);
    const mappedPending = locationSet === null
      ? []
      : input.pendingInbound.filter((item) =>
          item.productId === productId && item.locationId !== null && locationSet.has(item.locationId),
        );
    const leadTimeSupply = sharedOnHandMilliunits === null || rule?.leadTimeDays == null
      ? null
      : safeSum(
          [
            sharedOnHandMilliunits,
            ...mappedPending
              .filter((item) =>
                item.arrivalDate >= input.asOfDate &&
                dayDifference(item.arrivalDate, input.asOfDate) <= rule.leadTimeDays!,
              )
              .map((item) => item.quantityMilliunits),
          ],
          "lead-time supply",
        );
    const probability = locationSet === null || sharedOnHandMilliunits === null || rule?.leadTimeDays == null ||
      unknownAvailabilityDays > 0 || leadTimeSupply === null
      ? { basisPoints: null, windows: 0 }
      : historicalStockoutRate(rows, rule.leadTimeDays, leadTimeSupply);
    return {
      productId,
      availableDemandDays: availableRows.length,
      censoredStockoutDays: stockoutRows.length,
      unknownAvailabilityDays,
      observedSalesMilliunits,
      averageDailyDemandMilliunits,
      sharedOnHandMilliunits,
      coverDays,
      turnoverBasisPoints,
      stockoutProbabilityBasisPoints: probability.basisPoints,
      stockoutProbabilityMethod: probability.basisPoints === null
        ? null
        : "empirical_non_overlapping_lead_time_windows",
      stockoutProbabilitySampleWindows: probability.windows,
    };
  });
}

function historicalStockoutRate(
  rows: DailyDemandObservation[],
  leadTimeDays: number,
  availableSupplyMilliunits: Milliunits,
): { basisPoints: number | null; windows: number } {
  if (leadTimeDays < 1) return { basisPoints: null, windows: 0 };
  const knownRows = rows.filter((row) => row.availability !== "unknown").sort((a, b) => a.date.localeCompare(b.date));
  const contiguousSegments: DailyDemandObservation[][] = [];
  let segment: DailyDemandObservation[] = [];
  for (const row of knownRows) {
    if (segment.length > 0 && dayDifference(row.date, segment[segment.length - 1].date) !== 1) {
      contiguousSegments.push(segment);
      segment = [];
    }
    segment.push(row);
  }
  if (segment.length > 0) contiguousSegments.push(segment);

  let windows = 0;
  let stockoutWindows = 0;
  for (const days of contiguousSegments) {
    for (let start = 0; start + leadTimeDays <= days.length; start += leadTimeDays) {
      const sample = days.slice(start, start + leadTimeDays);
      const knownStockout = sample.some((row) => row.availability === "stockout");
      const demand = safeSum(
        sample.filter((row) => row.availability === "available").map((row) => row.soldMilliunits),
        "historical lead-time demand",
      );
      windows++;
      if (knownStockout || demand > availableSupplyMilliunits) stockoutWindows++;
    }
  }
  return windows === 0
    ? { basisPoints: null, windows: 0 }
    : {
        basisPoints: toSafeInteger(
          (BigInt(stockoutWindows) * BASIS_POINTS) / BigInt(windows),
          "stockout probability basis points",
        ),
        windows,
      };
}

interface ReorderJob {
  productId: string;
  supplierId: string;
  orderDate: CommerceDate;
  desiredQuantityMilliunits: Milliunits;
  unitCostCentsPerUnit: Cents;
  minimumOrderQuantityMilliunits: Milliunits;
  projectedPositionAtOrderMilliunits: Milliunits;
  projectedPositionAtReceiptMilliunits: Milliunits;
}

function projectedPosition(
  onHandMilliunits: number,
  dailyDemandMilliunits: number,
  daysFromAsOf: number,
  inbound: PendingInbound[],
  asOfDate: CommerceDate,
): bigint {
  const received = inbound
    .filter((item) => item.arrivalDate >= asOfDate && dayDifference(item.arrivalDate, asOfDate) <= daysFromAsOf)
    .map((item) => BigInt(item.quantityMilliunits));
  return BigInt(onHandMilliunits) - BigInt(dailyDemandMilliunits) * BigInt(daysFromAsOf) +
    received.reduce((sum, amount) => sum + amount, 0n);
}

function findOrderDay(
  onHandMilliunits: number,
  dailyDemandMilliunits: number,
  leadTimeDays: number,
  inbound: PendingInbound[],
  asOfDate: CommerceDate,
): number {
  const events = new Map<number, bigint>();
  for (const item of inbound) {
    if (item.arrivalDate < asOfDate) continue;
    const offset = dayDifference(item.arrivalDate, asOfDate);
    events.set(offset, (events.get(offset) ?? 0n) + BigInt(item.quantityMilliunits));
  }
  const eventDays = [...events.keys()].filter((day) => day > 0).sort((a, b) => a - b);
  let currentDay = 0;
  let position = BigInt(onHandMilliunits) + (events.get(0) ?? 0n);
  const reorderPoint = BigInt(dailyDemandMilliunits) * BigInt(leadTimeDays);
  const intervals = [...eventDays, Number.MAX_SAFE_INTEGER];
  for (const nextEventDay of intervals) {
    if (position <= reorderPoint) return currentDay;
    const daysUntilThreshold = toSafeInteger(
      ceilDiv(position - reorderPoint, BigInt(dailyDemandMilliunits)),
      "days until reorder point",
    );
    const crossingDay = currentDay + daysUntilThreshold;
    if (crossingDay < nextEventDay) return crossingDay;
    if (nextEventDay === Number.MAX_SAFE_INTEGER) return crossingDay;
    position -= BigInt(dailyDemandMilliunits) * BigInt(nextEventDay - currentDay);
    position += events.get(nextEventDay) ?? 0n;
    currentDay = nextEventDay;
  }
  return currentDay;
}

function blockedCandidate(
  rule: ReplenishmentRule,
  reason: ReorderBlockReason,
): ReorderCandidate {
  return {
    productId: rule.productId,
    supplierId: rule.supplierId,
    status: "blocked",
    reason,
    orderDate: null,
    desiredQuantityMilliunits: null,
    quantityMilliunits: null,
    replacementUnitCostCentsPerUnit: null,
    cashImpactCents: null,
    fundingShortfallCents: null,
    projectedPositionAtOrderMilliunits: null,
    projectedPositionAtReceiptMilliunits: null,
  };
}

function buildReorderDecisions(
  input: CommerceDecisionInput,
  inventory: InventoryLotPosition[],
  demand: ProductDemandSummary[],
  costs: CostEvidence[],
): ProductReorderDecision[] {
  const locationSet = mappingLocationSet(input.fulfillmentMapping);
  const demandByProduct = new Map(demand.map((summary) => [summary.productId, summary]));
  const costsByKey = new Map(costs.map((row) => [JSON.stringify([row.productId, row.supplierId]), row]));
  const inboundByProduct = new Map<string, PendingInbound[]>();
  for (const item of input.pendingInbound) {
    const rows = inboundByProduct.get(item.productId) ?? [];
    rows.push(item);
    inboundByProduct.set(item.productId, rows);
  }
  const jobs: ReorderJob[] = [];
  const initial: Array<{ productId: string; candidate: ReorderCandidate }> = [];
  const rules = [...input.replenishmentRules].sort((a, b) => a.productId.localeCompare(b.productId));
  for (const rule of rules) {
    if (locationSet === null) {
      initial.push({ productId: rule.productId, candidate: blockedCandidate(rule, "shared_stock_mapping_unknown") });
      continue;
    }
    const productLots = inventory.filter((lot) => lot.productId === rule.productId);
    if (productLots.some((lot) => lot.locationId === null && lot.quantityMilliunits > 0)) {
      initial.push({ productId: rule.productId, candidate: blockedCandidate(rule, "unassigned_inventory_location") });
      continue;
    }
    const productInbound = (inboundByProduct.get(rule.productId) ?? []).filter((item) =>
      item.quantityMilliunits > 0 && (item.locationId === null || locationSet.has(item.locationId)),
    );
    if (productInbound.some((item) => item.locationId === null)) {
      initial.push({ productId: rule.productId, candidate: blockedCandidate(rule, "unassigned_inbound_location") });
      continue;
    }
    if (productInbound.some((item) => item.arrivalDate < input.asOfDate)) {
      initial.push({ productId: rule.productId, candidate: blockedCandidate(rule, "overdue_inbound_uncertain") });
      continue;
    }
    const summary = demandByProduct.get(rule.productId);
    if (!summary || summary.averageDailyDemandMilliunits === null) {
      initial.push({ productId: rule.productId, candidate: blockedCandidate(rule, "demand_unknown") });
      continue;
    }
    if (summary.averageDailyDemandMilliunits === 0) {
      initial.push({ productId: rule.productId, candidate: blockedCandidate(rule, "no_observed_demand") });
      continue;
    }
    if (rule.leadTimeDays === null) {
      initial.push({ productId: rule.productId, candidate: blockedCandidate(rule, "lead_time_unknown") });
      continue;
    }
    const onHand = safeSum(
      productLots
        .filter((lot) => lot.locationId !== null && locationSet.has(lot.locationId))
        .map((lot) => lot.quantityMilliunits),
      "shared on-hand inventory",
    );
    const mappedInbound = productInbound.filter((item) => item.locationId !== null && locationSet.has(item.locationId));
    const orderOffset = findOrderDay(
      onHand,
      summary.averageDailyDemandMilliunits,
      rule.leadTimeDays,
      mappedInbound,
      input.asOfDate,
    );
    const orderDate = addDays(input.asOfDate, orderOffset);
    if (orderDate === null) {
      initial.push({ productId: rule.productId, candidate: blockedCandidate(rule, "order_date_out_of_range") });
      continue;
    }
    const receiptOffset = orderOffset + rule.leadTimeDays;
    const positionAtOrder = projectedPosition(
      onHand,
      summary.averageDailyDemandMilliunits,
      orderOffset,
      mappedInbound,
      input.asOfDate,
    );
    const positionAtReceipt = projectedPosition(
      onHand,
      summary.averageDailyDemandMilliunits,
      receiptOffset,
      mappedInbound,
      input.asOfDate,
    );
    const targetAfterReceipt = BigInt(summary.averageDailyDemandMilliunits) * BigInt(rule.reviewPeriodDays);
    const rawShortfall = targetAfterReceipt - positionAtReceipt;
    const minimum = BigInt(rule.minimumOrderQuantityMilliunits);
    const atLeastOneMilliunit = minimum > 0n ? minimum : 1n;
    const desired = rawShortfall > atLeastOneMilliunit ? rawShortfall : atLeastOneMilliunit;
    const desiredQuantityMilliunits = toSafeInteger(desired, "desired reorder quantity");
    const historicalCost = costsByKey.get(JSON.stringify([rule.productId, rule.supplierId]));
    const quote = historicalCost?.usableReplacementQuote ?? null;
    if (quote === null) {
      initial.push({
        productId: rule.productId,
        candidate: {
          ...blockedCandidate(rule, "replacement_quote_unavailable"),
          orderDate,
          desiredQuantityMilliunits,
          projectedPositionAtOrderMilliunits: toSafeInteger(positionAtOrder > 0n ? positionAtOrder : 0n, "position at order"),
          projectedPositionAtReceiptMilliunits: toSafeInteger(positionAtReceipt > 0n ? positionAtReceipt : 0n, "position at receipt"),
        },
      });
      continue;
    }
    jobs.push({
      productId: rule.productId,
      supplierId: rule.supplierId,
      orderDate,
      desiredQuantityMilliunits,
      unitCostCentsPerUnit: quote.unitCostCentsPerUnit,
      minimumOrderQuantityMilliunits: rule.minimumOrderQuantityMilliunits,
      projectedPositionAtOrderMilliunits: toSafeInteger(positionAtOrder > 0n ? positionAtOrder : 0n, "position at order"),
      projectedPositionAtReceiptMilliunits: toSafeInteger(positionAtReceipt > 0n ? positionAtReceipt : 0n, "position at receipt"),
    });
  }

  const cashKnown = input.cashPosition.availableCents !== null && input.cashPosition.floorCents !== null;
  const cashBudget = cashKnown
    ? (input.cashPosition.availableCents! > input.cashPosition.floorCents!
        ? input.cashPosition.availableCents! - input.cashPosition.floorCents!
        : 0n)
    : null;
  let remainingCash = cashBudget;
  jobs.sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.productId.localeCompare(b.productId));
  const allocated = new Map<string, ReorderCandidate>();
  for (const job of jobs) {
    const rule = input.replenishmentRules.find((item) => item.productId === job.productId)!;
    if (remainingCash === null) {
      allocated.set(job.productId, {
        ...blockedCandidate(rule, "cash_position_unknown"),
        orderDate: job.orderDate,
        desiredQuantityMilliunits: job.desiredQuantityMilliunits,
        replacementUnitCostCentsPerUnit: job.unitCostCentsPerUnit,
        projectedPositionAtOrderMilliunits: job.projectedPositionAtOrderMilliunits,
        projectedPositionAtReceiptMilliunits: job.projectedPositionAtReceiptMilliunits,
      });
      continue;
    }
    const minimum = BigInt(job.minimumOrderQuantityMilliunits);
    const minimumQuantity = minimum > 0n ? minimum : 1n;
    const minimumCost = costForMilliunits(job.unitCostCentsPerUnit, toSafeInteger(minimumQuantity, "minimum order quantity"));
    if (remainingCash < minimumCost) {
      allocated.set(job.productId, {
        ...blockedCandidate(rule, "cash_floor_protected"),
        orderDate: job.orderDate,
        desiredQuantityMilliunits: job.desiredQuantityMilliunits,
        replacementUnitCostCentsPerUnit: job.unitCostCentsPerUnit,
        fundingShortfallCents: minimumCost - remainingCash,
        projectedPositionAtOrderMilliunits: job.projectedPositionAtOrderMilliunits,
        projectedPositionAtReceiptMilliunits: job.projectedPositionAtReceiptMilliunits,
      });
      continue;
    }
    const affordable = job.unitCostCentsPerUnit === 0n
      ? BigInt(job.desiredQuantityMilliunits)
      : (remainingCash * MILLIUNITS_PER_UNIT) / job.unitCostCentsPerUnit;
    const planned = BigInt(job.desiredQuantityMilliunits) < affordable
      ? BigInt(job.desiredQuantityMilliunits)
      : affordable;
    if (planned < minimumQuantity) {
      allocated.set(job.productId, {
        ...blockedCandidate(rule, "cash_floor_protected"),
        orderDate: job.orderDate,
        desiredQuantityMilliunits: job.desiredQuantityMilliunits,
        replacementUnitCostCentsPerUnit: job.unitCostCentsPerUnit,
        fundingShortfallCents: minimumCost - remainingCash,
        projectedPositionAtOrderMilliunits: job.projectedPositionAtOrderMilliunits,
        projectedPositionAtReceiptMilliunits: job.projectedPositionAtReceiptMilliunits,
      });
      continue;
    }
    const quantityMilliunits = toSafeInteger(planned, "planned reorder quantity");
    const cashImpactCents = costForMilliunits(job.unitCostCentsPerUnit, quantityMilliunits);
    remainingCash -= cashImpactCents;
    const isLimited = planned < BigInt(job.desiredQuantityMilliunits);
    allocated.set(job.productId, {
      productId: job.productId,
      supplierId: job.supplierId,
      status: isLimited ? "cash_limited" : "ready",
      reason: null,
      orderDate: job.orderDate,
      desiredQuantityMilliunits: job.desiredQuantityMilliunits,
      quantityMilliunits,
      replacementUnitCostCentsPerUnit: job.unitCostCentsPerUnit,
      cashImpactCents,
      fundingShortfallCents: isLimited
        ? costForMilliunits(job.unitCostCentsPerUnit, job.desiredQuantityMilliunits) - cashImpactCents
        : 0n,
      projectedPositionAtOrderMilliunits: job.projectedPositionAtOrderMilliunits,
      projectedPositionAtReceiptMilliunits: job.projectedPositionAtReceiptMilliunits,
    });
  }
  for (const row of initial) allocated.set(row.productId, row.candidate);
  return rules.map((rule) => input.fulfillmentMapping.status === "unknown"
    ? {
        productId: rule.productId,
        combinedLocalDelivery: null,
        combinedUnavailableReason: "shared_stock_mapping_unknown",
      }
    : {
        productId: rule.productId,
        combinedLocalDelivery: allocated.get(rule.productId) ?? blockedCandidate(rule, "demand_unknown"),
        combinedUnavailableReason: null,
      });
}

/** Pure snapshot calculation. Stockout days are censored out of the demand-rate denominator. */
export function calculateCommerceDecisions(input: CommerceDecisionInput): CommerceDecisionResult {
  validateCommerceInput(input);
  const inventory = buildInventory(input);
  const costs = buildCostEvidence(input);
  const rulesByProduct = new Map(input.replenishmentRules.map((rule) => [rule.productId, rule]));
  const demand = summarizeDemand(input, inventory.lots, rulesByProduct);
  const reorderDecisions = buildReorderDecisions(input, inventory.lots, demand, costs);
  const cashAvailableAboveFloorCents = input.cashPosition.availableCents === null || input.cashPosition.floorCents === null
    ? null
    : input.cashPosition.availableCents > input.cashPosition.floorCents
      ? input.cashPosition.availableCents - input.cashPosition.floorCents
      : 0n;
  return {
    asOfDate: input.asOfDate,
    inventoryByLotLocationSupplier: inventory.lots,
    inventoryByProductLocationSupplier: inventory.byProductLocationSupplier,
    inventoryByProductSupplier: inventory.byProductSupplier,
    inventoryByProduct: inventory.byProduct,
    costEvidence: costs,
    demandByProduct: demand,
    reorderDecisions,
    cashAvailableAboveFloorCents,
  };
}

export interface PromotionProduct {
  productId: string;
  unitPriceCents: Cents;
  variableCostCentsPerUnit: Cents;
}

export type LineDiscount =
  | { kind: "percent_bps"; value: number }
  | { kind: "fixed_cents"; value: Cents };

export interface PromotionLine {
  productId: string;
  quantityMilliunits: Milliunits;
  discount: LineDiscount;
}

export interface PromotionFreebie {
  productId: string;
  quantityMilliunits: Milliunits;
}

export interface PromotionScenario {
  name: string;
  lines: PromotionLine[];
  shippingChargedCents: Cents;
  shippingCostCents: Cents;
  freebies: PromotionFreebie[];
  campaignCostCents: Cents;
}

export interface PromotionSimulationInput {
  products: PromotionProduct[];
  promoted: PromotionScenario;
  reference?: PromotionScenario;
}

export interface PromotionLineResult {
  productId: string;
  quantityMilliunits: Milliunits;
  grossRevenueCents: Cents;
  discountCents: Cents;
  netRevenueCents: Cents;
  variableCostCents: Cents;
  contributionCents: Cents;
}

export interface PromotionScenarioResult {
  name: string;
  lines: PromotionLineResult[];
  merchandiseGrossCents: Cents;
  lineDiscountCents: Cents;
  merchandiseNetCents: Cents;
  variableCostCents: Cents;
  shippingChargedCents: Cents;
  shippingCostCents: Cents;
  freebieCostCents: Cents;
  campaignCostCents: Cents;
  contributionCents: Cents;
}

export interface PromotionSimulationResult {
  promoted: PromotionScenarioResult;
  reference: PromotionScenarioResult | null;
  comparisonInterpretation: "descriptive_only";
  contributionDifferenceCents: Cents | null;
  incrementalOrdersToBreakEvenPerReferenceOrder: number | null;
  breakEvenStatus: "not_compared" | "no_increment_needed" | "incremental_volume_required" | "unreachable_nonpositive_contribution";
}

function simulateScenario(
  catalog: Map<string, PromotionProduct>,
  scenario: PromotionScenario,
): PromotionScenarioResult {
  requireText(scenario.name, "scenario.name");
  requireCents(scenario.shippingChargedCents, "scenario.shippingChargedCents");
  requireCents(scenario.shippingCostCents, "scenario.shippingCostCents");
  requireCents(scenario.campaignCostCents, "scenario.campaignCostCents");
  const lines: PromotionLineResult[] = scenario.lines.map((line) => {
    const product = catalog.get(line.productId);
    if (!product) throw new Error(`unknown promotion product: ${line.productId}`);
    requireMilliunits(line.quantityMilliunits, "promotion line quantityMilliunits");
    if (line.quantityMilliunits === 0) throw new Error("promotion line quantity must be positive");
    const grossRevenueCents = roundHalfUp(
      product.unitPriceCents * BigInt(line.quantityMilliunits),
      MILLIUNITS_PER_UNIT,
    );
    let discountCents: Cents;
    if (line.discount.kind === "percent_bps") {
      if (!Number.isSafeInteger(line.discount.value) || line.discount.value < 0 || line.discount.value > 10_000)
        throw new Error("line discount percent must be an integer from 0 to 10000 basis points");
      discountCents = roundHalfUp(grossRevenueCents * BigInt(line.discount.value), BASIS_POINTS);
    } else {
      requireCents(line.discount.value, "line discount fixed cents");
      discountCents = line.discount.value;
    }
    if (discountCents > grossRevenueCents) throw new Error("line discount cannot exceed line gross revenue");
    const netRevenueCents = grossRevenueCents - discountCents;
    const variableCostCents = costForMilliunits(product.variableCostCentsPerUnit, line.quantityMilliunits);
    return {
      productId: line.productId,
      quantityMilliunits: line.quantityMilliunits,
      grossRevenueCents,
      discountCents,
      netRevenueCents,
      variableCostCents,
      contributionCents: netRevenueCents - variableCostCents,
    };
  });
  let freebieCostCents = 0n;
  for (const freebie of scenario.freebies) {
    const product = catalog.get(freebie.productId);
    if (!product) throw new Error(`unknown freebie product: ${freebie.productId}`);
    requireMilliunits(freebie.quantityMilliunits, "freebie quantityMilliunits");
    if (freebie.quantityMilliunits === 0) throw new Error("freebie quantity must be positive");
    freebieCostCents += costForMilliunits(product.variableCostCentsPerUnit, freebie.quantityMilliunits);
  }
  const merchandiseGrossCents = lines.reduce((sum, line) => sum + line.grossRevenueCents, 0n);
  const lineDiscountCents = lines.reduce((sum, line) => sum + line.discountCents, 0n);
  const merchandiseNetCents = merchandiseGrossCents - lineDiscountCents;
  const variableCostCents = lines.reduce((sum, line) => sum + line.variableCostCents, 0n);
  const contributionCents = merchandiseNetCents + scenario.shippingChargedCents - variableCostCents -
    scenario.shippingCostCents - freebieCostCents - scenario.campaignCostCents;
  return {
    name: scenario.name,
    lines,
    merchandiseGrossCents,
    lineDiscountCents,
    merchandiseNetCents,
    variableCostCents,
    shippingChargedCents: scenario.shippingChargedCents,
    shippingCostCents: scenario.shippingCostCents,
    freebieCostCents,
    campaignCostCents: scenario.campaignCostCents,
    contributionCents,
  };
}

/** Descriptive unit-economics comparison; it does not attribute observed sales changes to a promotion. */
export function simulatePromotion(input: PromotionSimulationInput): PromotionSimulationResult {
  const catalog = new Map<string, PromotionProduct>();
  for (const product of input.products) {
    requireText(product.productId, "products.productId");
    requireCents(product.unitPriceCents, "products.unitPriceCents");
    requireCents(product.variableCostCentsPerUnit, "products.variableCostCentsPerUnit");
    if (catalog.has(product.productId)) throw new Error("promotion product ids must be unique");
    catalog.set(product.productId, product);
  }
  const promoted = simulateScenario(catalog, input.promoted);
  const reference = input.reference ? simulateScenario(catalog, input.reference) : null;
  if (reference === null) {
    return {
      promoted,
      reference: null,
      comparisonInterpretation: "descriptive_only",
      contributionDifferenceCents: null,
      incrementalOrdersToBreakEvenPerReferenceOrder: null,
      breakEvenStatus: "not_compared",
    };
  }
  const difference = promoted.contributionCents - reference.contributionCents;
  if (difference >= 0n) {
    return {
      promoted,
      reference,
      comparisonInterpretation: "descriptive_only",
      contributionDifferenceCents: difference,
      incrementalOrdersToBreakEvenPerReferenceOrder: 0,
      breakEvenStatus: "no_increment_needed",
    };
  }
  if (promoted.contributionCents <= 0n) {
    return {
      promoted,
      reference,
      comparisonInterpretation: "descriptive_only",
      contributionDifferenceCents: difference,
      incrementalOrdersToBreakEvenPerReferenceOrder: null,
      breakEvenStatus: "unreachable_nonpositive_contribution",
    };
  }
  return {
    promoted,
    reference,
    comparisonInterpretation: "descriptive_only",
    contributionDifferenceCents: difference,
    incrementalOrdersToBreakEvenPerReferenceOrder: toSafeInteger(
      ceilDiv(-difference, promoted.contributionCents),
      "incremental break-even order count",
    ),
    breakEvenStatus: "incremental_volume_required",
  };
}

export interface MemberCommerceRecord {
  memberId: string;
  lastPurchaseDate: CommerceDate | null;
  purchaseCount: number;
  spendCents: Cents;
}

export interface MemberSegmentationThresholds {
  recentDays: number;
  coolingDays: number;
  mediumFrequencyPurchases: number;
  highFrequencyPurchases: number;
  mediumSpendCents: Cents;
  highSpendCents: Cents;
}

export interface MemberSegmentedRecord extends MemberCommerceRecord {
  daysSinceLastPurchase: number | null;
  recencyBand: "recent" | "cooling" | "lapsed" | "never" | "unknown";
  frequencyBand: "none" | "low" | "medium" | "high";
  spendBand: "low" | "medium" | "high";
  reviewLists: Array<"recent_high_spend" | "frequent_core" | "lapsed_high_spend" | "new_or_low_history">;
}

export interface MemberSegmentationResult {
  asOfDate: CommerceDate;
  usage: "human_review_only_no_messages_no_permit_data";
  members: MemberSegmentedRecord[];
  reviewLists: {
    recentHighSpend: string[];
    frequentCore: string[];
    lapsedHighSpend: string[];
    newOrLowHistory: string[];
  };
}

/** Produces review queues from recency, frequency, and spend only; it does not send messages. */
export function segmentMembers(
  asOfDate: CommerceDate,
  members: MemberCommerceRecord[],
  thresholds: MemberSegmentationThresholds,
): MemberSegmentationResult {
  requireDate(asOfDate, "asOfDate");
  requireDays(thresholds.recentDays, "thresholds.recentDays");
  requireDays(thresholds.coolingDays, "thresholds.coolingDays");
  if (thresholds.coolingDays < thresholds.recentDays)
    throw new Error("coolingDays must be greater than or equal to recentDays");
  if (!Number.isSafeInteger(thresholds.mediumFrequencyPurchases) || thresholds.mediumFrequencyPurchases < 1 ||
      !Number.isSafeInteger(thresholds.highFrequencyPurchases) ||
      thresholds.highFrequencyPurchases < thresholds.mediumFrequencyPurchases)
    throw new Error("frequency thresholds must be positive whole numbers in ascending order");
  requireCents(thresholds.mediumSpendCents, "thresholds.mediumSpendCents");
  requireCents(thresholds.highSpendCents, "thresholds.highSpendCents");
  if (thresholds.highSpendCents < thresholds.mediumSpendCents)
    throw new Error("highSpendCents must be greater than or equal to mediumSpendCents");
  const ids = new Set<string>();
  const segmented = members.map((member): MemberSegmentedRecord => {
    requireText(member.memberId, "members.memberId");
    if (ids.has(member.memberId)) throw new Error("member ids must be unique");
    ids.add(member.memberId);
    if (!Number.isSafeInteger(member.purchaseCount) || member.purchaseCount < 0)
      throw new Error("purchaseCount must be a non-negative safe integer");
    requireCents(member.spendCents, "members.spendCents");
    if (member.lastPurchaseDate !== null) {
      requireDate(member.lastPurchaseDate, "members.lastPurchaseDate");
      if (member.lastPurchaseDate > asOfDate) throw new Error("lastPurchaseDate cannot be after asOfDate");
    }
    let daysSinceLastPurchase: number | null = null;
    let recencyBand: MemberSegmentedRecord["recencyBand"];
    if (member.lastPurchaseDate === null) {
      recencyBand = member.purchaseCount === 0 ? "never" : "unknown";
    } else {
      daysSinceLastPurchase = dayDifference(asOfDate, member.lastPurchaseDate);
      recencyBand = daysSinceLastPurchase <= thresholds.recentDays
        ? "recent"
        : daysSinceLastPurchase <= thresholds.coolingDays
          ? "cooling"
          : "lapsed";
    }
    const frequencyBand: MemberSegmentedRecord["frequencyBand"] = member.purchaseCount === 0
      ? "none"
      : member.purchaseCount >= thresholds.highFrequencyPurchases
        ? "high"
        : member.purchaseCount >= thresholds.mediumFrequencyPurchases
          ? "medium"
          : "low";
    const spendBand: MemberSegmentedRecord["spendBand"] = member.spendCents >= thresholds.highSpendCents
      ? "high"
      : member.spendCents >= thresholds.mediumSpendCents
        ? "medium"
        : "low";
    const reviewLists: MemberSegmentedRecord["reviewLists"] = [];
    if (recencyBand === "recent" && spendBand === "high") reviewLists.push("recent_high_spend");
    if (frequencyBand === "high") reviewLists.push("frequent_core");
    if (recencyBand === "lapsed" && spendBand === "high") reviewLists.push("lapsed_high_spend");
    if (member.purchaseCount <= 1) reviewLists.push("new_or_low_history");
    return { ...member, daysSinceLastPurchase, recencyBand, frequencyBand, spendBand, reviewLists };
  }).sort((a, b) => a.memberId.localeCompare(b.memberId));

  const spendDescending = (a: MemberSegmentedRecord, b: MemberSegmentedRecord) =>
    a.spendCents === b.spendCents ? a.memberId.localeCompare(b.memberId) : a.spendCents > b.spendCents ? -1 : 1;
  const byRecencyThenSpend = (a: MemberSegmentedRecord, b: MemberSegmentedRecord) =>
    (a.daysSinceLastPurchase ?? Number.MAX_SAFE_INTEGER) - (b.daysSinceLastPurchase ?? Number.MAX_SAFE_INTEGER) ||
    spendDescending(a, b);
  return {
    asOfDate,
    usage: "human_review_only_no_messages_no_permit_data",
    members: segmented,
    reviewLists: {
      recentHighSpend: segmented.filter((member) => member.reviewLists.includes("recent_high_spend")).sort(byRecencyThenSpend).map((member) => member.memberId),
      frequentCore: segmented.filter((member) => member.reviewLists.includes("frequent_core")).sort(spendDescending).map((member) => member.memberId),
      lapsedHighSpend: segmented.filter((member) => member.reviewLists.includes("lapsed_high_spend")).sort(spendDescending).map((member) => member.memberId),
      newOrLowHistory: segmented.filter((member) => member.reviewLists.includes("new_or_low_history")).sort(byRecencyThenSpend).map((member) => member.memberId),
    },
  };
}
