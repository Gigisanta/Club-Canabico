import type { Currency } from "./contracts.js";
import { formatDecimal, parseDecimal, roundHalfUp } from "./exact.js";

const DAY_MS = 86_400_000;
const WEEK_MS = DAY_MS * 7;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const MAX_DECIMAL_INTEGER_DIGITS = 26;
const MAX_DECIMAL_SCALE = 12;

export const LEGACY_SEGMENT_THRESHOLDS = {
  recencyPriorityDays: 105,
  spendARSMinor: "175000000",
  distinctPurchaseMonths: 6,
  maxGramsExclusive: "20",
} as const;

export type CoverageState = "complete" | "partial" | "unverified" | "unknown" | "not-applicable";

export interface CoverageResult {
  knownCount: number;
  expectedCount: number | null;
  percent: string | null;
  state: CoverageState;
  reason?: string;
}

export function assessCoverage(input: {
  knownCount: number;
  expectedCount: number | null;
  attestedComplete?: boolean;
}): CoverageResult {
  const { knownCount, expectedCount, attestedComplete = false } = input;
  requireCount(knownCount, "knownCount");
  if (expectedCount !== null) requireCount(expectedCount, "expectedCount");

  if (expectedCount === null) {
    return { knownCount, expectedCount, percent: null, state: "unknown", reason: "missing-expected-total" };
  }
  if (knownCount > expectedCount) throw new RangeError("knownCount cannot exceed expectedCount");
  if (expectedCount === 0) {
    return { knownCount, expectedCount, percent: null, state: "not-applicable", reason: "empty-denominator" };
  }

  const percentHundredths = (BigInt(knownCount) * 10_000n + BigInt(expectedCount) / 2n) / BigInt(expectedCount);
  const percent = `${percentHundredths / 100n}.${String(percentHundredths % 100n).padStart(2, "0")}`;
  if (knownCount < expectedCount) {
    return { knownCount, expectedCount, percent, state: "partial", reason: "known-count-below-expected" };
  }
  if (!attestedComplete) {
    return { knownCount, expectedCount, percent, state: "unverified", reason: "complete-coverage-not-attested" };
  }
  return { knownCount, expectedCount, percent, state: "complete" };
}

export interface ContributionInput {
  currency: Currency;
  netRevenueMinor: string;
  costOfGoodsMinor: string;
  variableCostsMinor: string;
}

export interface ContributionResult {
  currency: Currency;
  netRevenueMinor: string;
  costOfGoodsMinor: string;
  variableCostsMinor: string;
  contributionMinor: string;
}

export function calculateContribution(input: ContributionInput): ContributionResult {
  assertCurrency(input.currency);
  const revenue = parseSignedMinor(input.netRevenueMinor, "netRevenueMinor");
  const costOfGoods = parseSignedMinor(input.costOfGoodsMinor, "costOfGoodsMinor");
  const variableCosts = parseSignedMinor(input.variableCostsMinor, "variableCostsMinor");
  return {
    currency: input.currency,
    netRevenueMinor: revenue.toString(),
    costOfGoodsMinor: costOfGoods.toString(),
    variableCostsMinor: variableCosts.toString(),
    contributionMinor: (revenue - costOfGoods - variableCosts).toString(),
  };
}

export interface CurrencyTotal {
  currency: Currency;
  minor: string;
}

/** Returns one total per observed currency. An absent currency is never presented as a confirmed zero. */
export function sumMoneyByCurrency(values: readonly { currency: Currency; minor: string }[]): CurrencyTotal[] {
  const totals = new Map<Currency, bigint>();
  for (const value of values) {
    assertCurrency(value.currency);
    const amount = parseSignedMinor(value.minor, "minor");
    totals.set(value.currency, (totals.get(value.currency) ?? 0n) + amount);
  }
  return (["ARS", "USD"] as const)
    .filter(currency => totals.has(currency))
    .map(currency => ({ currency, minor: totals.get(currency)!.toString() }));
}

/** Returns contribution after approved fixed costs only when both inputs cover every contribution currency. */
export function subtractFixedCostsByCurrency(
  contribution: readonly CurrencyTotal[] | null,
  fixedCosts: readonly CurrencyTotal[] | null,
): CurrencyTotal[] | null {
  if (!contribution || !fixedCosts || contribution.length === 0) return null;
  const contributionTotals = sumMoneyByCurrency(contribution);
  const fixedTotals = new Map(sumMoneyByCurrency(fixedCosts).map(row => [row.currency, BigInt(row.minor)]));
  if (contributionTotals.some(row => !fixedTotals.has(row.currency))) return null;
  return contributionTotals.map(row => ({
    currency: row.currency,
    minor: (BigInt(row.minor) - fixedTotals.get(row.currency)!).toString(),
  }));
}

/** Cost sold from one explicit-currency lot allocation; undelivered returns never reduce COGS. */
export function allocatedCostSold(input: {
  currency: Currency;
  costMinor: string;
  actualQuantity: string;
  deliveredQuantity: string;
  returnedDeliveredQuantity: string;
}): CurrencyTotal | null {
  assertCurrency(input.currency);
  const actual = parseDecimal(input.actualQuantity, 12);
  const delivered = parseDecimal(input.deliveredQuantity, 12);
  const returnedDelivered = parseDecimal(input.returnedDeliveredQuantity, 12);
  const cost = parseSignedMinor(input.costMinor, "costMinor");
  if (actual <= 0n || delivered < 0n || returnedDelivered < 0n || returnedDelivered > delivered || delivered > actual || cost < 0n) return null;
  const sold = delivered - returnedDelivered;
  return { currency: input.currency, minor: roundHalfUp(cost * sold, actual).toString() };
}

/** Quantity still in club custody after preparation, dispatch, and physical returns. */
export function remainingClubCustody(input: {
  actualQuantity: string;
  deliveredQuantity: string;
  returnedQuantity: string;
  returnedDeliveredQuantity: string;
}): string | null {
  const actual = parseDecimal(input.actualQuantity, 12);
  const delivered = parseDecimal(input.deliveredQuantity, 12);
  const returned = parseDecimal(input.returnedQuantity, 12);
  const returnedDelivered = parseDecimal(input.returnedDeliveredQuantity, 12);
  const undeliveredReturned = returned - returnedDelivered;
  const remaining = actual - delivered - undeliveredReturned;
  if (actual < 0n || delivered < 0n || returned < 0n || returnedDelivered < 0n || delivered > actual || undeliveredReturned < 0n || undeliveredReturned > actual - delivered || remaining < 0n) {
    return null;
  }
  return formatDecimal(remaining, 12);
}

export interface FixedCostItem {
  amountMinor: string;
  accrualPeriod: string;
  recurring: boolean;
}

/** Sum approved monthly fixed-cost items over full calendar months without converting currencies. */
export function sumFixedCostsForMonths(input: {
  currency: Currency;
  items: readonly FixedCostItem[];
  fromPeriod: string;
  throughPeriod: string;
}): CurrencyTotal {
  assertCurrency(input.currency);
  const from = parseYearMonth(input.fromPeriod, "fromPeriod");
  const through = parseYearMonth(input.throughPeriod, "throughPeriod");
  if (through < from) throw new RangeError("throughPeriod must be on or after fromPeriod");

  let total = 0n;
  for (const item of input.items) {
    const start = parseYearMonth(item.accrualPeriod, "accrualPeriod");
    if (typeof item.recurring !== "boolean") throw new TypeError("recurring must be a boolean");
    const amount = parseSignedMinor(item.amountMinor, "amountMinor");
    if (amount < 0n) throw new RangeError("fixed costs cannot be negative");
    if (item.recurring) {
      const firstIncluded = Math.max(start, from);
      if (firstIncluded <= through) total += amount * BigInt(through - firstIncluded + 1);
    } else if (start >= from && start <= through) {
      total += amount;
    }
  }

  return { currency: input.currency, minor: total.toString() };
}

function parseYearMonth(value: string, field: string): number {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) throw new TypeError(`${field} must use YYYY-MM`);
  return Number(match[1]) * 12 + Number(match[2]) - 1;
}

export interface CalendarWeek {
  week: number;
  weekStart: string;
  weekEnd: string;
  includedFrom: string;
  includedThrough: string;
}

/** Builds Monday–Sunday calendar buckets clipped to the requested inclusive civil-date range. */
export function calendarWeeks(fromDate: string, throughDate: string): CalendarWeek[] {
  const from = parseCivilDate(fromDate);
  const through = parseCivilDate(throughDate);
  if (through < from) throw new RangeError("throughDate must be on or after fromDate");

  const firstMonday = mondayAtOrBefore(from);
  const lastMonday = mondayAtOrBefore(through);
  const result: CalendarWeek[] = [];
  for (let start = firstMonday, week = 1; start <= lastMonday; start += WEEK_MS, week++) {
    const end = start + WEEK_MS - DAY_MS;
    const includedFrom = Math.max(start, from);
    const includedThrough = Math.min(end, through);
    result.push({
      week,
      weekStart: formatCivilDate(start),
      weekEnd: formatCivilDate(end),
      includedFrom: formatCivilDate(includedFrom),
      includedThrough: formatCivilDate(includedThrough),
    });
  }
  return result;
}

export type ObligationSourceCoverage = "complete" | "partial" | "unknown";

export interface ObligationInput {
  id: string;
  dueDate: string;
  currency: Currency;
  amountMinor: string;
  paidMinor: string;
  verified: boolean;
}

export interface WeeklyObligations {
  week: number;
  weekStart: string;
  weekEnd: string;
  obligationCount: number;
  verifiedCount: number;
  unverifiedCount: number;
  outstandingByCurrency: CurrencyTotal[];
  verifiedOutstandingByCurrency: CurrencyTotal[];
}

export interface ThirteenWeekObligations {
  firstWeekStart: string;
  lastWeekEnd: string;
  sourceCoverage: ObligationSourceCoverage;
  duplicateRowsIgnored: number;
  weeks: WeeklyObligations[];
}

/**
 * Sums open payables by their unique IDs in thirteen complete Monday–Sunday weeks.
 * Exact duplicate imports count once; an ID reused for different obligation data is an error.
 */
export function aggregateThirteenWeekObligations(
  firstWeekStart: string,
  obligations: readonly ObligationInput[],
  sourceCoverage: ObligationSourceCoverage,
): ThirteenWeekObligations {
  const first = parseCivilDate(firstWeekStart);
  if (new Date(first).getUTCDay() !== 1) throw new RangeError("firstWeekStart must be a Monday");
  const windows = Array.from({ length: 13 }, (_, index) => {
    const start = first + index * WEEK_MS;
    return { week: index + 1, start, end: start + WEEK_MS - DAY_MS };
  });

  const unique = new Map<string, { row: ObligationInput; due: number; amount: bigint; paid: bigint }>();
  let duplicateRowsIgnored = 0;
  for (const row of obligations) {
    const id = row.id.trim();
    if (!id) throw new TypeError("obligation id is required");
    assertCurrency(row.currency);
    if (typeof row.verified !== "boolean") throw new TypeError("verified must be a boolean");
    const due = parseCivilDate(row.dueDate);
    const amount = parseSignedMinor(row.amountMinor, "amountMinor");
    const paid = parseSignedMinor(row.paidMinor, "paidMinor");
    if (amount < 0n || paid < 0n || paid > amount) throw new RangeError("obligation amounts must satisfy 0 <= paidMinor <= amountMinor");
    const prior = unique.get(id);
    if (prior) {
      if (prior.due !== due || prior.row.currency !== row.currency || prior.amount !== amount || prior.paid !== paid || prior.row.verified !== row.verified) {
        throw new Error(`Conflicting duplicate obligation ID: ${id}`);
      }
      duplicateRowsIgnored++;
      continue;
    }
    unique.set(id, { row: { ...row, id }, due, amount, paid });
  }

  const weeklyRows = windows.map(() => [] as Array<{ currency: Currency; open: string; verified: boolean }>);
  for (const { row, due, amount, paid } of unique.values()) {
    if (due < first || due >= first + 13 * WEEK_MS) continue;
    const outstanding = amount - paid;
    if (outstanding === 0n) continue;
    const index = Math.floor((due - first) / WEEK_MS);
    weeklyRows[index].push({ currency: row.currency, open: outstanding.toString(), verified: row.verified });
  }

  const weeks = windows.map((window, index): WeeklyObligations => {
    const rows = weeklyRows[index];
    const verified = rows.filter(row => row.verified);
    return {
      week: window.week,
      weekStart: formatCivilDate(window.start),
      weekEnd: formatCivilDate(window.end),
      obligationCount: rows.length,
      verifiedCount: verified.length,
      unverifiedCount: rows.length - verified.length,
      outstandingByCurrency: sumMoneyByCurrency(rows.map(row => ({ currency: row.currency, minor: row.open }))),
      verifiedOutstandingByCurrency: sumMoneyByCurrency(verified.map(row => ({ currency: row.currency, minor: row.open }))),
    };
  });

  return {
    firstWeekStart,
    lastWeekEnd: weeks[12].weekEnd,
    sourceCoverage,
    duplicateRowsIgnored,
    weeks,
  };
}

export type ScenarioCashKind = "income" | "payment" | "purchase" | "funding";
export interface ScenarioCashItem {
  id: string;
  date: string;
  kind: ScenarioCashKind;
  amountMinor: string;
  commitmentId?: string;
}
export interface ScenarioCashWeek {
  week: number;
  weekStart: string;
  weekEnd: string;
  itemCount: number;
  inflowMinor: string;
  outflowMinor: string;
  netFlowMinor: string;
  byKind: Array<{ kind: ScenarioCashKind; itemCount: number; amountMinor: string }>;
}
export interface ThirteenWeekScenarioCash {
  currency: Currency;
  firstWeekStart: string;
  lastWeekEnd: string;
  inputItemCount: number;
  includedItemCount: number;
  outsideHorizonCount: number;
  duplicateCommitmentCount: number;
  conflictingCommitmentCount: number;
  matchedExistingObligationCount: number;
  unmatchedCommitmentCount: number;
  invalidItemCount: number;
  weeks: ScenarioCashWeek[];
}

/** Projects one approved configuration in isolation; scenarios are alternatives, never added together. */
export function aggregateThirteenWeekScenarioCash(
  firstWeekStart: string,
  currency: Currency,
  items: readonly ScenarioCashItem[],
  existingObligationIds: ReadonlySet<string> = new Set(),
): ThirteenWeekScenarioCash {
  assertCurrency(currency);
  const first = parseCivilDate(firstWeekStart);
  if (new Date(first).getUTCDay() !== 1) throw new RangeError("firstWeekStart must be a Monday");
  const horizonEnd = first + 13 * WEEK_MS;
  const windows = Array.from({ length: 13 }, (_, index) => {
    const start = first + index * WEEK_MS;
    return { week: index + 1, start, end: start + WEEK_MS - DAY_MS };
  });
  const valid: Array<{ item: ScenarioCashItem; date: number; amount: bigint }> = [];
  let invalidItemCount = 0;
  for (const item of items) {
    try {
      if (!item.id.trim() || !["income", "payment", "purchase", "funding"].includes(item.kind) || !/^(0|[1-9]\d*)$/.test(item.amountMinor)) {
        invalidItemCount++;
        continue;
      }
      const amount = parseSignedMinor(item.amountMinor, "scenario.amountMinor");
      if (amount < 0n || amount > MAX_INT64) {
        invalidItemCount++;
        continue;
      }
      valid.push({ item, date: parseCivilDate(item.date), amount });
    } catch {
      invalidItemCount++;
    }
  }

  const commitmentGroups = new Map<string, typeof valid>();
  for (const row of valid) {
    const id = row.item.commitmentId?.trim();
    if (!id) continue;
    const group = commitmentGroups.get(id) ?? [];
    group.push(row);
    commitmentGroups.set(id, group);
  }
  const conflicting = new Set<string>();
  const duplicateRows = new Set<typeof valid[number]>();
  let duplicateCommitmentCount = 0;
  let conflictingCommitmentCount = 0;
  for (const [id, group] of commitmentGroups) {
    if (existingObligationIds.has(id)) continue;
    if (group.length < 2) continue;
    const signatures = new Set(group.map(row => `${row.item.date}\u0000${row.item.kind}\u0000${row.amount}`));
    if (signatures.size > 1) {
      conflicting.add(id);
      conflictingCommitmentCount += group.length;
    } else {
      for (const row of group.slice(1)) duplicateRows.add(row);
      duplicateCommitmentCount += group.length - 1;
    }
  }

  const eligible: typeof valid = [];
  let matchedExistingObligationCount = 0;
  let unmatchedCommitmentCount = 0;
  let outsideHorizonCount = 0;
  for (const row of valid) {
    const commitmentId = row.item.commitmentId?.trim();
    if (commitmentId && existingObligationIds.has(commitmentId)) {
      matchedExistingObligationCount++;
      continue;
    }
    if (commitmentId && conflicting.has(commitmentId)) continue;
    if (duplicateRows.has(row)) continue;
    if (commitmentId) unmatchedCommitmentCount++;
    if (row.date < first || row.date >= horizonEnd) {
      outsideHorizonCount++;
      continue;
    }
    eligible.push(row);
  }

  const weekly = windows.map(window => ({
    window,
    events: [] as Array<{ kind: ScenarioCashKind; amount: bigint; flow: bigint }>,
  }));
  for (const row of eligible) {
    const index = Math.floor((row.date - first) / WEEK_MS);
    const inflow = row.item.kind === "income" || row.item.kind === "funding";
    weekly[index]!.events.push({ kind: row.item.kind, amount: row.amount, flow: inflow ? row.amount : -row.amount });
  }

  const weeks = weekly.map(({ window, events }): ScenarioCashWeek => {
    const byKind = (["income", "payment", "purchase", "funding"] as const).flatMap(kind => {
      const matching = events.filter(event => event.kind === kind);
      return matching.length ? [{ kind, itemCount: matching.length, amountMinor: matching.reduce((sum, event) => sum + event.amount, 0n).toString() }] : [];
    });
    const inflowMinor = events.filter(event => event.flow > 0n).reduce((sum, event) => sum + event.flow, 0n);
    const outflowMinor = events.filter(event => event.flow < 0n).reduce((sum, event) => sum - event.flow, 0n);
    return {
      week: window.week,
      weekStart: formatCivilDate(window.start),
      weekEnd: formatCivilDate(window.end),
      itemCount: events.length,
      inflowMinor: inflowMinor.toString(),
      outflowMinor: outflowMinor.toString(),
      netFlowMinor: (inflowMinor - outflowMinor).toString(),
      byKind,
    };
  });

  return {
    currency,
    firstWeekStart,
    lastWeekEnd: weeks[12]!.weekEnd,
    inputItemCount: items.length,
    includedItemCount: eligible.length,
    outsideHorizonCount,
    duplicateCommitmentCount,
    conflictingCommitmentCount,
    matchedExistingObligationCount,
    unmatchedCommitmentCount,
    invalidItemCount,
    weeks,
  };
}

export type LegacyCustomerSegment =
  | "no-purchase-history"
  | "recency-priority"
  | "high-spend"
  | "repeat-months"
  | "large-purchase"
  | "occasional"
  | "insufficient-data";

export interface LegacyCustomerProfile {
  purchaseCount: number;
  daysSinceLastPurchase: number | null;
  spendARSMinor: string | null;
  distinctPurchaseMonths: number | null;
  maxGrams: string | null;
}

export interface LegacyCustomerSegmentation {
  segment: LegacyCustomerSegment;
  matchedRule: string;
  decisionScope: "analysis-only";
  loyaltyApproval: "not-evaluated";
}

/** Apply legacy priorities only to complete profiles; no-history is a separate observed state. */
export function segmentLegacyCustomer(profile: LegacyCustomerProfile): LegacyCustomerSegmentation {
  requireCount(profile.purchaseCount, "purchaseCount");
  if (profile.daysSinceLastPurchase !== null) {
    requireCount(profile.daysSinceLastPurchase, "daysSinceLastPurchase");
  }
  if (profile.distinctPurchaseMonths !== null) {
    requireCount(profile.distinctPurchaseMonths, "distinctPurchaseMonths");
  }
  if (profile.purchaseCount === 0) return segmentation("no-purchase-history", "zero-purchases");

  if (profile.daysSinceLastPurchase === null || profile.spendARSMinor === null || profile.distinctPurchaseMonths === null || profile.maxGrams === null) {
    return segmentation("insufficient-data", "one-or-more-segmentation-inputs-missing");
  }

  if (profile.daysSinceLastPurchase >= LEGACY_SEGMENT_THRESHOLDS.recencyPriorityDays) {
    return segmentation("recency-priority", "days-since-last-purchase>=105");
  }

  const spend = parseSignedMinor(profile.spendARSMinor, "spendARSMinor");
  if (spend >= BigInt(LEGACY_SEGMENT_THRESHOLDS.spendARSMinor)) return segmentation("high-spend", "ars-spend>=175000000-minor");
  if (profile.distinctPurchaseMonths >= LEGACY_SEGMENT_THRESHOLDS.distinctPurchaseMonths) {
    return segmentation("repeat-months", "distinct-purchase-months>=6");
  }
  if (compareExactDecimal(profile.maxGrams, LEGACY_SEGMENT_THRESHOLDS.maxGramsExclusive) > 0) {
    return segmentation("large-purchase", "max-grams>20");
  }
  return segmentation("occasional", "no-priority-threshold-met");
}

function segmentation(segment: LegacyCustomerSegment, matchedRule: string): LegacyCustomerSegmentation {
  return { segment, matchedRule, decisionScope: "analysis-only", loyaltyApproval: "not-evaluated" };
}

function compareExactDecimal(left: string, right: string): number {
  const a = parseExactDecimal(left, "maxGrams");
  const b = parseExactDecimal(right, "threshold");
  const scale = Math.max(a.scale, b.scale);
  const leftScaled = a.coefficient * 10n ** BigInt(scale - a.scale);
  const rightScaled = b.coefficient * 10n ** BigInt(scale - b.scale);
  return leftScaled < rightScaled ? -1 : leftScaled > rightScaled ? 1 : 0;
}

function parseExactDecimal(value: string, field: string): { coefficient: bigint; scale: number } {
  if (typeof value !== "string") throw new TypeError(`${field} must be an exact decimal string`);
  const match = /^(0|[1-9]\d{0,25})(?:\.(\d{1,12}))?$/.exec(value);
  if (!match) throw new TypeError(`${field} must be a non-negative decimal with up to 26 integer and 12 fractional digits`);
  const fraction = match[2] ?? "";
  return { coefficient: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function parseSignedMinor(value: string, field: string): bigint {
  if (typeof value !== "string" || !/^-?(0|[1-9]\d{0,18})$/.test(value)) {
    throw new TypeError(`${field} must be an exact signed minor-unit string`);
  }
  const amount = BigInt(value);
  if (amount < MIN_INT64 || amount > MAX_INT64) throw new RangeError(`${field} is outside the PostgreSQL BigInt range`);
  return amount;
}

function parseCivilDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError("date must use YYYY-MM-DD");
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new TypeError("date must be a valid civil date");
  }
  return date.getTime();
}

function formatCivilDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function mondayAtOrBefore(epochMs: number): number {
  const dayOfWeek = new Date(epochMs).getUTCDay();
  return epochMs - ((dayOfWeek + 6) % 7) * DAY_MS;
}

function assertCurrency(value: string): asserts value is Currency {
  if (value !== "ARS" && value !== "USD") throw new TypeError("currency must be ARS or USD");
}

function requireCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer`);
}
