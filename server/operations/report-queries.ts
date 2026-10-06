import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "@prisma/client";
import { db as primaryDb } from "../db.js";
import type { Tx } from "./core.js";

// All counts, amounts and attestation fingerprints share one database snapshot.
// Context is local to this asynchronous report, never shared across requests.
const reportSnapshot = new AsyncLocalStorage<Tx>();
function reportDb(): Tx {
  const tx = reportSnapshot.getStore();
  if (!tx) throw new Error("A report requires its read transaction");
  return tx;
}
import {
  aggregateThirteenWeekScenarioCash,
  aggregateThirteenWeekObligations,
  allocatedCostSold,
  remainingClubCustody,
  segmentLegacyCustomer,
  subtractFixedCostsByCurrency,
  sumFixedCostsForMonths,
  sumMoneyByCurrency,
  type CurrencyTotal,
  type ScenarioCashItem,
  type ScenarioCashKind,
  type LegacyCustomerSegment,
  type FixedCostItem,
} from "../../shared/operations/metrics.js";
import type { Currency } from "../../shared/operations/contracts.js";
import { formatDecimal, parseDecimal, roundHalfUp } from "../../shared/operations/exact.js";
import { OperationError } from "./core.js";
import type { ReportAreaId } from "./report-definitions.js";
import { getManagementPeriodCoverageStatus } from "./period-coverage.js";
import { stockFactScopeWhere } from "./stock-scope.js";

export interface ReportDateRange {
  from?: string;
  to?: string;
}

export interface ReportScope {
  accountIds?: string[];
  memberIds?: string[];
  locationIds?: string[];
  custodianIds?: string[];
}

export function customerSegmentationQueryContract(range: ReportDateRange, scope: ReportScope) {
  const asOfDate = range.to ?? civilDateAt(new Date());
  parseCivilDate(asOfDate);
  return {
    asOfDate,
    where: {
      commercialState: "confirmed",
      fulfillmentState: { not: "cancelled" },
      confirmedAt: { not: null, lt: reportCivilDateStartUtc(addDays(asOfDate, 1)) },
      ...(scope.memberIds !== undefined ? { memberId: { in: scope.memberIds } } : {}),
    },
  };
}

const REPORT_ROW_LIMIT = 10_000;
const REPORT_DETAIL_ROW_LIMIT = 500;
// Full-population totals are computed independently. FX diagnostic rows contain
// multiple ledger legs and must fit the serverless response budget.
const FX_DETAIL_ROW_LIMIT = REPORT_DETAIL_ROW_LIMIT;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const TIME_ZONE = "America/Argentina/Buenos_Aires";
const CIVIL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type MoneyBucket = { currency: string | null; minor: string };
type Coverage = {
  source: string;
  knownCount: number | null;
  expectedCount: number | null;
  queryComplete: boolean | null;
  state: "unknown" | "partial" | "unverified" | "excluded";
  reason: string;
};

type FixedCostCurrency = "ARS" | "USD";
type FixedCostConfiguration = {
  id: string;
  name: string;
  version: number;
  currency: FixedCostCurrency;
  items: FixedCostItem[];
  validFrom: string;
  validUntil: string | null;
};
type FixedCostReport = {
  state: "approved" | "partial" | "unknown";
  period: { from: string; through: string } | null;
  monthlyScheduleByCurrency: MoneyBucket[] | null;
  amountByCurrency: MoneyBucket[] | null;
  byCurrency: Array<{
    currency: FixedCostCurrency;
    version: number;
    monthlyScheduleMinor: string;
    amountMinor: string | null;
    periodCoverage: "complete" | "unknown";
    reason: string | null;
  }>;
  reason: string | null;
};

const reportScopeKeys: Record<ReportAreaId, readonly (keyof ReportScope)[]> = {
  "sales-revenue": ["memberIds"],
  "product-contribution": ["memberIds"],
  "operating-expenses": [],
  purchases: [],
  inventory: ["locationIds", "custodianIds"],
  "cash-ledger": ["accountIds"],
  "delivery-collections": [],
  "fx-reconciliation": ["accountIds"],
  "customer-segmentation": ["memberIds"],
  "commercial-scenarios": [],
  "obligations-13-weeks": [],
};

export function supportsReportScope(area: ReportAreaId, scope: ReportScope): boolean {
  return (Object.keys(scope) as (keyof ReportScope)[]).every(key => scope[key] === undefined || reportScopeKeys[area].includes(key));
}

export function validateReportScope(scope: ReportScope): void {
  if (Object.keys(scope).some(key => !["accountIds", "memberIds", "locationIds", "custodianIds"].includes(key))) {
    throw new OperationError(403, "REPORT_SCOPE_INVALID", "El alcance configurado para este reporte no es válido");
  }
  for (const key of ["accountIds", "memberIds", "locationIds", "custodianIds"] as const) {
    const value = scope[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(id => typeof id !== "string" || !id))) {
      throw new OperationError(403, "REPORT_SCOPE_INVALID", "El alcance configurado para este reporte no es válido");
    }
  }
}

export function assertReportScope(area: ReportAreaId, scope: ReportScope): void {
  validateReportScope(scope);
  if (!supportsReportScope(area, scope)) {
    throw new OperationError(403, "REPORT_SCOPE_UNSUPPORTED", "Este reporte no puede aplicar todos los alcances asignados a sus fuentes");
  }
}

function addDays(civilDate: string, days: number): string {
  const epoch = parseCivilDate(civilDate) + days * DAY_MS;
  return new Date(epoch).toISOString().slice(0, 10);
}

function parseCivilDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError("date must use YYYY-MM-DD");
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year!, month! - 1, day!);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
    throw new TypeError("date must be a valid civil date");
  }
  return parsed.getTime();
}

function civilDateAt(time: Date): string {
  const parts = CIVIL_DATE_FORMATTER.formatToParts(time);
  const part = (type: string) => parts.find(candidate => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Resolves the first instant of a Buenos Aires civil date, including historical offset changes. */
export function reportCivilDateStartUtc(civilDate: string): Date {
  const target = parseCivilDate(civilDate);
  let low = target - 36 * 60 * 60 * 1000;
  let high = target + 36 * 60 * 60 * 1000;
  if (civilDateAt(new Date(low)) >= civilDate || civilDateAt(new Date(high)) < civilDate) {
    throw new RangeError("civil date is outside the supported timezone boundary");
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (civilDateAt(new Date(middle)) < civilDate) low = middle + 1;
    else high = middle;
  }
  if (civilDateAt(new Date(low)) !== civilDate) {
    throw new RangeError("civil date does not exist in the report timezone");
  }
  return new Date(low);
}

/** Shared exclusive-boundary builder for every date-scoped report source. */
export function reportPeriodDateBounds(range: ReportDateRange): Record<string, Date> {
  const filter: Record<string, Date> = {};
  if (range.from) filter.gte = reportCivilDateStartUtc(range.from);
  if (range.to) filter.lt = reportCivilDateStartUtc(addDays(range.to, 1));
  return filter;
}

/** Encodes already-civil SQL DATE values as UTC-midnight dates, without turning them into instants. */
function civilDateValueBounds(range: ReportDateRange): Record<string, Date> {
  const filter: Record<string, Date> = {};
  if (range.from) {
    reportCivilDateStartUtc(range.from);
    filter.gte = new Date(`${range.from}T00:00:00.000Z`);
  }
  if (range.to) {
    const afterTo = addDays(range.to, 1);
    reportCivilDateStartUtc(afterTo);
    filter.lt = new Date(`${afterTo}T00:00:00.000Z`);
  }
  return filter;
}

function mondayAtOrBefore(civilDate: string): string {
  const epoch = parseCivilDate(civilDate);
  const weekday = new Date(epoch).getUTCDay();
  return new Date(epoch - ((weekday + 6) % 7) * DAY_MS).toISOString().slice(0, 10);
}

function timestampFilter(range: ReportDateRange): Record<string, Date> {
  return reportPeriodDateBounds(range);
}

function dateOnlyFilter(range: ReportDateRange): Record<string, Date> {
  return civilDateValueBounds(range);
}

function stockFactEndpointScopePredicate(fromColumn: Prisma.Sql, toColumn: Prisma.Sql, allowedIds: string[] | undefined): Prisma.Sql | undefined {
  if (allowedIds === undefined) return undefined;
  if (allowedIds.length === 0) return Prisma.sql`FALSE`;
  const fromAllowed = Prisma.sql`${fromColumn} IN (${Prisma.join(allowedIds)})`;
  const toAllowed = Prisma.sql`${toColumn} IN (${Prisma.join(allowedIds)})`;
  return Prisma.sql`((${fromColumn} IS NULL OR ${fromAllowed}) AND (${toColumn} IS NULL OR ${toAllowed}) AND (${fromAllowed} OR ${toAllowed}))`;
}

function rawSqlUtcTimestamp(boundary: Date): Prisma.Sql {
  // Raw Prisma Date parameters are timestamptz. Convert the instant to a UTC
  // wall-clock value before comparing with TIMESTAMP/DATE columns, whose values
  // carry no zone; this keeps the predicate independent of the PG session zone.
  return Prisma.sql`(${boundary} AT TIME ZONE 'UTC')`;
}

function stringDateFilter(range: ReportDateRange): Record<string, string> {
  const filter: Record<string, string> = {};
  if (range.from) filter.gte = range.from;
  if (range.to) filter.lte = range.to;
  return filter;
}

function moneyTotals(): Map<string, bigint> {
  return new Map();
}

export function summarizeMemberCreditBalances(rows: readonly {
  treatment: string;
  currency: string;
  amountMinor: bigint;
  resolvedMinor: bigint;
}[]) {
  const spendable = moneyTotals();
  const refundDue = moneyTotals();
  let spendableOpenCount = 0;
  let refundDueOpenCount = 0;
  let reversedCount = 0;
  let unclassifiedCount = 0;
  let invalidCount = 0;

  for (const row of rows) {
    if (row.treatment === "reversed") {
      reversedCount += 1;
      continue;
    }
    if (row.treatment !== "member_credit" && row.treatment !== "refund_due") {
      unclassifiedCount += 1;
      continue;
    }
    if (!isCurrency(row.currency) || row.amountMinor < 0n || row.resolvedMinor < 0n || row.resolvedMinor > row.amountMinor) {
      invalidCount += 1;
      continue;
    }
    const outstanding = row.amountMinor - row.resolvedMinor;
    if (outstanding <= 0n) continue;
    if (row.treatment === "member_credit") {
      addMoney(spendable, row.currency, outstanding);
      spendableOpenCount += 1;
    } else {
      addMoney(refundDue, row.currency, outstanding);
      refundDueOpenCount += 1;
    }
  }

  return {
    spendableMemberCreditOpenByCurrency: asMoneyBuckets(spendable),
    refundDueOpenByCurrency: asMoneyBuckets(refundDue),
    spendableOpenCount,
    refundDueOpenCount,
    reversedCount,
    unclassifiedCount,
    invalidCount,
  };
}

export function summarizeStockFactMovements(rows: readonly { kind: string; quantity: string; unit: string }[]) {
  const grouped = new Map<string, { kind: string; meaning: string; unit: string; eventCount: number; quantity: bigint }>();
  let invalidCount = 0;
  for (const row of rows) {
    const unit = row.unit.trim();
    if (!unit) {
      invalidCount += 1;
      continue;
    }
    const quantity = parseDecimal(row.quantity, 12);
    const isTransfer = row.kind === "transfer" || row.kind === "transfer_internal";
    if ((row.kind === "waste" && quantity <= 0n) || (row.kind === "count_adjustment" && quantity === 0n) || (isTransfer && quantity <= 0n)) {
      invalidCount += 1;
      continue;
    }
    const meaning = row.kind === "waste"
      ? "positive-waste-quantity"
      : row.kind === "count_adjustment"
        ? "signed-count-difference"
        : isTransfer
          ? "internal-transfer-flow-not-club-wide-loss"
          : "recorded-quantity-semantics-unclassified";
    const key = JSON.stringify([row.kind, meaning, unit]);
    const prior = grouped.get(key);
    if (prior) {
      prior.quantity += quantity;
      prior.eventCount += 1;
    } else {
      grouped.set(key, { kind: row.kind, meaning, unit, eventCount: 1, quantity });
    }
  }
  const byKindAndUnit = [...grouped.values()]
    .sort((a, b) => JSON.stringify([a.kind, a.unit]).localeCompare(JSON.stringify([b.kind, b.unit])))
    .map(row => ({ kind: row.kind, meaning: row.meaning, unit: row.unit, eventCount: row.eventCount, recordedQuantity: formatQuantity(row.quantity) }));
  return { byKindAndUnit, invalidCount };
}

function addMoney(totals: Map<string, bigint>, currency: string | null, amount: bigint): void {
  const key = currency ?? "\u0000unknown-currency";
  totals.set(key, (totals.get(key) ?? 0n) + amount);
}

function asMoneyBuckets(totals: Map<string, bigint>): MoneyBucket[] {
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, minor]) => ({ currency: currency === "\u0000unknown-currency" ? null : currency, minor: minor.toString() }));
}

function isCurrency(value: string | null): value is Currency {
  return value === "ARS" || value === "USD";
}

function toCurrencyTotals(rows: readonly MoneyBucket[] | null): CurrencyTotal[] | null {
  if (!rows || rows.length === 0) return null;
  const result: CurrencyTotal[] = [];
  for (const row of rows) {
    if (!isCurrency(row.currency)) return null;
    result.push({ currency: row.currency, minor: row.minor });
  }
  return result;
}

function decimalText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object" && "toString" in value) return String(value);
  throw new TypeError("Expected a plain decimal value from the database");
}

function prorateMinor(amount: bigint, numerator: unknown, denominator: unknown): bigint | null {
  const top = parseDecimal(decimalText(numerator), 12);
  const bottom = parseDecimal(decimalText(denominator), 12);
  if (bottom <= 0n || top < 0n || top > bottom) return null;
  return roundHalfUp(amount * top, bottom);
}

function stockValueMinor(unitCost: unknown, quantity: unknown): bigint {
  const cost = parseDecimal(decimalText(unitCost), 12);
  const units = parseDecimal(decimalText(quantity), 12);
  return roundHalfUp(cost * units * 100n, 10n ** 24n);
}

function coverage(source: string, knownCount: number, expectedCount: number): Coverage {
  const queryComplete = knownCount >= expectedCount;
  if (expectedCount === 0) {
    return { source, knownCount, expectedCount, queryComplete: true, state: "unknown", reason: "no-observations-do-not-prove-a-zero-period" };
  }
  if (!queryComplete) {
    return { source, knownCount, expectedCount, queryComplete: false, state: "partial", reason: "row-limit-reached" };
  }
  return { source, knownCount, expectedCount, queryComplete: true, state: "unverified", reason: "source-period-completeness-has-no-attestation" };
}

function excludedCoverage(source: string, reason: string): Coverage {
  return { source, knownCount: null, expectedCount: null, queryComplete: null, state: "excluded", reason };
}

function partialCoverage(source: string, knownCount: number, expectedCount: number, reason: string): Coverage {
  return { source, knownCount, expectedCount, queryComplete: false, state: "partial", reason };
}

function parseFixedCostConfiguration(value: unknown): Pick<FixedCostConfiguration, "currency" | "items"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const definition = value as Record<string, unknown>;
  if (definition.currency !== "ARS" && definition.currency !== "USD") return null;
  if (!Array.isArray(definition.items)) return null;
  const items: FixedCostItem[] = [];
  for (const raw of definition.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.category !== "string" || !item.category.trim() ||
        typeof item.amountMinor !== "string" || !/^(0|[1-9]\d{0,18})$/.test(item.amountMinor) ||
        typeof item.accrualPeriod !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(item.accrualPeriod) ||
        typeof item.recurring !== "boolean") return null;
    if (BigInt(item.amountMinor) > 9_223_372_036_854_775_807n) return null;
    items.push({ amountMinor: item.amountMinor, accrualPeriod: item.accrualPeriod, recurring: item.recurring });
  }
  return { currency: definition.currency, items };
}

async function approvedFixedCosts(range: ReportDateRange, scope: ReportScope = {}): Promise<FixedCostReport> {
  const asOf = range.to ?? civilDateAt(new Date());
  const month = asOf.slice(0, 7);
  const unavailable = (state: FixedCostReport["state"], reason: string): FixedCostReport => ({
    state,
    period: range.from && range.to ? { from: range.from, through: range.to } : null,
    monthlyScheduleByCurrency: null,
    amountByCurrency: null,
    byCurrency: [],
    reason,
  });

  // The config endpoint uses the same finance scope policy. A member-scoped viewer must not
  // infer whole-club overhead from a report restricted to selected members.
  if (scope.accountIds !== undefined || scope.memberIds !== undefined || scope.locationIds !== undefined) {
    return unavailable("unknown", "financial-configuration-requires-unscoped-finance-access");
  }

  const rows = await reportDb().operationalConfiguration.findMany({
    where: {
      kind: "fixed_costs",
      state: "approved",
      approvedBy: { not: null },
      approvedAt: { not: null },
      validFrom: { lte: asOf },
      OR: [{ validUntil: null }, { validUntil: { gte: asOf } }],
    },
    orderBy: [{ name: "asc" }, { version: "desc" }, { id: "asc" }],
    select: { id: true, name: true, version: true, definition: true, validFrom: true, validUntil: true, approvedAt: true },
  });
  const latestByName = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.approvedAt && civilDateAt(row.approvedAt) <= asOf && !latestByName.has(row.name)) latestByName.set(row.name, row);
  }
  if (!latestByName.size) return unavailable("unknown", "no-current-approved-fixed-cost-configuration");

  const parsed: FixedCostConfiguration[] = [];
  let invalidCount = 0;
  for (const row of latestByName.values()) {
    const definition = parseFixedCostConfiguration(row.definition);
    if (!definition) {
      invalidCount += 1;
      continue;
    }
    parsed.push({ id: row.id, name: row.name, version: row.version, ...definition, validFrom: row.validFrom, validUntil: row.validUntil });
  }
  const byCurrency = new Map<FixedCostCurrency, FixedCostConfiguration[]>();
  for (const configuration of parsed) {
    const group = byCurrency.get(configuration.currency) ?? [];
    group.push(configuration);
    byCurrency.set(configuration.currency, group);
  }

  const fullMonthRange = Boolean(range.from && range.to && isWholeMonthRange(range.from, range.to));
  const currencyRows: FixedCostReport["byCurrency"] = [];
  let ambiguousCount = 0;
  let periodGapCount = 0;
  for (const [currency, configurations] of byCurrency) {
    if (configurations.length !== 1) {
      ambiguousCount += 1;
      continue;
    }
    const configuration = configurations[0]!;
    const monthlyScheduleMinor = sumFixedCostsForMonths({ currency, items: configuration.items, fromPeriod: month, throughPeriod: month }).minor;
    const coversPeriod = fullMonthRange && range.from! >= configuration.validFrom &&
      (configuration.validUntil === null || range.to! <= configuration.validUntil);
    let amountMinor: string | null = null;
    if (coversPeriod) {
      amountMinor = sumFixedCostsForMonths({
        currency,
        items: configuration.items,
        fromPeriod: range.from!.slice(0, 7),
        throughPeriod: range.to!.slice(0, 7),
      }).minor;
    } else {
      periodGapCount += 1;
    }
    currencyRows.push({
      currency,
      version: configuration.version,
      monthlyScheduleMinor,
      amountMinor,
      periodCoverage: amountMinor === null ? "unknown" : "complete",
      reason: amountMinor === null ? "approved-schedule-does-not-cover-whole-accrual-period" : null,
    });
  }
  currencyRows.sort((a, b) => a.currency.localeCompare(b.currency));
  const partial = invalidCount > 0 || ambiguousCount > 0 || periodGapCount > 0;
  const state: FixedCostReport["state"] = partial ? "partial" : currencyRows.length ? "approved" : "unknown";
  const reason = invalidCount ? "invalid-approved-fixed-cost-definition" : ambiguousCount ? "multiple-current-configurations-for-currency" : periodGapCount ? "selected-range-is-not-fully-covered-by-approved-monthly-schedule" : state === "unknown" ? "no-usable-approved-fixed-cost-configuration" : null;
  const completePeriod = fullMonthRange && state === "approved" && currencyRows.length > 0 && currencyRows.every(row => row.amountMinor !== null);
  return {
    state,
    period: range.from && range.to ? { from: range.from, through: range.to } : null,
    monthlyScheduleByCurrency: currencyRows.length ? currencyRows.map(row => ({ currency: row.currency, minor: row.monthlyScheduleMinor })) : null,
    amountByCurrency: completePeriod ? currencyRows.map(row => ({ currency: row.currency, minor: row.amountMinor! })) : null,
    byCurrency: currencyRows,
    reason,
  };
}

function isWholeMonthRange(from: string, through: string): boolean {
  const fromPeriod = from.slice(0, 7);
  const throughPeriod = through.slice(0, 7);
  return from === `${fromPeriod}-01` && through === addDays(`${addDays(`${throughPeriod}-01`, 32).slice(0, 7)}-01`, -1);
}

function fixedCostCoverage(report: FixedCostReport): Coverage {
  if (report.state === "unknown") return { source: "approved-fixed-cost-configuration", knownCount: 0, expectedCount: null, queryComplete: null, state: "unknown", reason: report.reason ?? "fixed-cost-coverage-unknown" };
  if (report.state === "partial" || report.amountByCurrency === null) return { source: "approved-fixed-cost-configuration", knownCount: report.byCurrency.length, expectedCount: null, queryComplete: false, state: "partial", reason: report.reason ?? "selected-range-is-not-fully-covered-by-approved-monthly-schedule" };
  return { source: "approved-fixed-cost-configuration", knownCount: report.byCurrency.length, expectedCount: report.byCurrency.length, queryComplete: true, state: "unverified", reason: "approved-schedule-does-not-attest-actual-expense-completeness" };
}

function countsBy<T>(rows: readonly T[], keyOf: (row: T) => string): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => ({ key, count }));
}

function queryEnvelope<T extends Record<string, unknown>>(area: ReportAreaId, range: ReportDateRange, metrics: T, coverageRows: Coverage[]) {
  return {
    area,
    range: { from: range.from ?? null, to: range.to ?? null, timeZone: TIME_ZONE, inclusive: true },
    metrics,
    coverage: coverageRows,
    evidenceState: coverageRows.every(row => row.state === "unknown" || row.state === "excluded") ? "unknown" : coverageRows.some(row => row.state === "partial") ? "partial" : "unverified",
    currenciesCombined: false,
  };
}

async function salesRevenue(range: ReportDateRange, scope: ReportScope) {
  const dateRange = dateOnlyFilter(range);
  const orderPredicates: Prisma.Sql[] = [
    Prisma.sql`o."commercialState" = 'confirmed'`,
    Prisma.sql`o."fulfillmentState" <> 'cancelled'`,
    Prisma.sql`o."confirmedAt" IS NOT NULL`,
    Prisma.sql`NOT (COALESCE(o."quote"->>'source', '') = 'appsheet-invoice' AND COALESCE(o."quote"->>'totalCalculationState', '') <> 'defined')`,
  ];
  const timeRange = timestampFilter(range);
  if (timeRange.gte) orderPredicates.push(Prisma.sql`o."confirmedAt" >= ${rawSqlUtcTimestamp(timeRange.gte)}`);
  if (timeRange.lt) orderPredicates.push(Prisma.sql`o."confirmedAt" < ${rawSqlUtcTimestamp(timeRange.lt)}`);
  if (scope.memberIds !== undefined) {
    orderPredicates.push(scope.memberIds.length
      ? Prisma.sql`o."memberId" IN (${Prisma.join(scope.memberIds)})`
      : Prisma.sql`FALSE`);
  }
  const pendingInvoiceCaptures = await pendingAppSheetInvoiceCaptures(range, scope);
  const historyPredicates: Prisma.Sql[] = [];
  if (dateRange.gte) historyPredicates.push(Prisma.sql`s."saleDate" >= ${rawSqlUtcTimestamp(dateRange.gte)}`);
  if (dateRange.lt) historyPredicates.push(Prisma.sql`s."saleDate" < ${rawSqlUtcTimestamp(dateRange.lt)}`);
  type SalesAggregate = {
    channel: string;
    currency: string;
    orderCount: bigint;
    netProductRevenueMinor: string;
    orderTotalMinor: string;
    returnAllocationCount: bigint;
    invalidReturnAllocationCount: bigint;
    invalidLineCount: bigint;
  };
  type HistoricalSalesAggregate = { saleCount: bigint; saleTotalCents: string; lineTotalCents: string };
  const [groups, historyRows] = await Promise.all([
    reportDb().$queryRaw<SalesAggregate[]>(Prisma.sql`
      WITH selected_orders AS (
        SELECT o."id", o."channel", o."currency", o."totalMinor"
        FROM "OperationOrder" AS o
        WHERE ${Prisma.join(orderPredicates, " AND ")}
      ), return_allocations AS (
        SELECT a."lineId",
          (a."actualQuantity" <= 0 OR a."returnedDeliveredQuantity" < 0 OR a."returnedDeliveredQuantity" > a."actualQuantity") AS invalid,
          CASE WHEN a."actualQuantity" > 0 AND a."returnedDeliveredQuantity" >= 0 AND a."returnedDeliveredQuantity" <= a."actualQuantity"
            THEN trunc(a."requestedQuantity"::numeric * a."returnedDeliveredQuantity"::numeric * 1000000000000::numeric / a."actualQuantity"::numeric)
            ELSE NULL
          END AS returned_billed_scaled
        FROM "PreparationAllocation" AS a
        JOIN selected_orders AS o ON o."id" = a."orderId"
        WHERE a."returnedDeliveredQuantity" > 0
      ), returns_by_line AS (
        SELECT "lineId", SUM(COALESCE(returned_billed_scaled, 0)) AS returned_billed_scaled
        FROM return_allocations
        GROUP BY "lineId"
      ), line_values AS (
        SELECT l."id", l."orderId", l."revenueMinor", l."requested", l."cancelled",
          l."requested" - l."cancelled" - COALESCE(r.returned_billed_scaled / 1000000000000::numeric, 0) AS retained_quantity
        FROM "OperationOrderLine" AS l
        JOIN selected_orders AS o ON o."id" = l."orderId"
        LEFT JOIN returns_by_line AS r ON r."lineId" = l."id"
      ), order_groups AS (
        SELECT "channel", "currency", COUNT(*)::bigint AS order_count,
          COALESCE(SUM("totalMinor"), 0)::text AS order_total_minor
        FROM selected_orders
        GROUP BY "channel", "currency"
      ), line_groups AS (
        SELECT o."channel", o."currency",
          COALESCE(SUM(CASE WHEN l."requested" > 0 AND l.retained_quantity >= 0
            THEN ROUND(l."revenueMinor"::numeric * l.retained_quantity / l."requested"::numeric)
            ELSE 0::numeric
          END), 0)::text AS net_product_revenue_minor
        FROM line_values AS l
        JOIN selected_orders AS o ON o."id" = l."orderId"
        GROUP BY o."channel", o."currency"
      ), return_summary AS (
        SELECT COUNT(*)::bigint AS allocation_count,
          COUNT(*) FILTER (WHERE invalid)::bigint AS invalid_allocation_count,
          (SELECT COUNT(*)::bigint FROM line_values WHERE "requested" <= 0 OR retained_quantity < 0) AS invalid_line_count
        FROM return_allocations
      )
      SELECT o."channel", o."currency", o.order_count AS "orderCount",
        COALESCE(l.net_product_revenue_minor, '0') AS "netProductRevenueMinor",
        o.order_total_minor AS "orderTotalMinor",
        r.allocation_count AS "returnAllocationCount",
        r.invalid_allocation_count AS "invalidReturnAllocationCount",
        r.invalid_line_count AS "invalidLineCount"
      FROM order_groups AS o
      LEFT JOIN line_groups AS l ON l."channel" = o."channel" AND l."currency" = o."currency"
      CROSS JOIN return_summary AS r
    `),
    scope.memberIds === undefined
      ? reportDb().$queryRaw<HistoricalSalesAggregate[]>(Prisma.sql`
          WITH selected_sales AS (
            SELECT s."id", s."totalCents"
            FROM "HistoricalDeliverySale" AS s
            ${historyPredicates.length ? Prisma.sql`WHERE ${Prisma.join(historyPredicates, " AND ")}` : Prisma.empty}
          )
          SELECT COUNT(*)::bigint AS "saleCount",
            COALESCE(SUM("totalCents"), 0)::text AS "saleTotalCents",
            COALESCE((SELECT SUM(l."lineTotalCents") FROM "HistoricalDeliverySaleLine" AS l JOIN selected_sales AS s ON s."id" = l."saleId"), 0)::text AS "lineTotalCents"
          FROM selected_sales
        `)
      : Promise.resolve([{ saleCount: 0n, saleTotalCents: "0", lineTotalCents: "0" }]),
  ]);
  const history = historyRows[0] ?? { saleCount: 0n, saleTotalCents: "0", lineTotalCents: "0" };
  const orderCount = groups.reduce((sum, row) => sum + Number(row.orderCount), 0);
  const returnCoverage = {
    knownCount: Number(groups[0]?.returnAllocationCount ?? 0n),
    expectedCount: Number(groups[0]?.returnAllocationCount ?? 0n),
    invalidCount: Number(groups[0]?.invalidReturnAllocationCount ?? 0n) + Number(groups[0]?.invalidLineCount ?? 0n),
  };
  const byChannel = new Map<string, { orderCount: number; netProductRevenue: Map<string, bigint>; orderTotal: Map<string, bigint> }>();
  const operationalRevenue = moneyTotals();
  const operationalTotals = moneyTotals();
  for (const row of groups) {
    const channel = byChannel.get(row.channel) ?? { orderCount: 0, netProductRevenue: moneyTotals(), orderTotal: moneyTotals() };
    channel.orderCount += Number(row.orderCount);
    const revenue = BigInt(row.netProductRevenueMinor);
    const orderTotal = BigInt(row.orderTotalMinor);
    addMoney(channel.netProductRevenue, row.currency, revenue);
    addMoney(channel.orderTotal, row.currency, orderTotal);
    byChannel.set(row.channel, channel);
    addMoney(operationalRevenue, row.currency, revenue);
    addMoney(operationalTotals, row.currency, orderTotal);
  }
  const historicTotals = moneyTotals();
  const historicLineTotals = moneyTotals();
  addMoney(historicTotals, null, BigInt(history.saleTotalCents));
  addMoney(historicLineTotals, null, BigInt(history.lineTotalCents));
  return queryEnvelope("sales-revenue", range, {
    revenueBasis: "retained-confirmed-quote; cancelled-demand-and-customer-returns-excluded; not-cash-received-or-delivered-revenue",
    originalOrderTotalBasis: "frozen-original-quote; cancellation-and-refunds-remain-separate-facts",
    revenueQuantityCoverage: { queryComplete: returnCoverage.knownCount === returnCoverage.expectedCount, invalidCount: returnCoverage.invalidCount },
    connectedSources: ["operation-orders-by-channel", "historical-delivery-sales"],
    operationalChannels: [...byChannel.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([channel, values]) => ({
      channel,
      orderCount: values.orderCount,
      netProductRevenueByCurrency: asMoneyBuckets(values.netProductRevenue),
      orderTotalByCurrency: asMoneyBuckets(values.orderTotal),
    })),
    operational: {
      confirmedOrderCount: orderCount,
      netProductRevenueByCurrency: asMoneyBuckets(operationalRevenue),
      orderTotalByCurrency: asMoneyBuckets(operationalTotals),
    },
    pendingAppSheetInvoices: pendingAppSheetInvoiceProjection(pendingInvoiceCaptures),
    historicalDelivery: scope.memberIds === undefined ? {
      state: "observed-unlinked-historical-source",
      saleCount: Number(history.saleCount),
      saleTotalByCurrency: asMoneyBuckets(historicTotals),
      lineTotalByCurrency: asMoneyBuckets(historicLineTotals),
      currencyStatus: "unknown-in-source-schema",
      createsOperationalOrders: false,
    } : {
      state: "excluded-by-member-scope",
      saleCount: null,
      saleTotalByCurrency: null,
      lineTotalByCurrency: null,
      reason: "historical-delivery-sales-have-no-member-link",
      createsOperationalOrders: false,
    },
  }, [coverage("operation-orders", orderCount, orderCount), ...(hasPendingAppSheetInvoices(pendingInvoiceCaptures) ? [pendingInvoiceCaptureCoverage(pendingInvoiceCaptures)] : []), returnCoverage.invalidCount ? partialCoverage("customer-return-allocations", returnCoverage.knownCount, returnCoverage.expectedCount, "invalid-billed-return-ratio") : coverage("customer-return-allocations", returnCoverage.knownCount, returnCoverage.expectedCount), ...(scope.memberIds === undefined ? [coverage("historical-delivery-sales", Number(history.saleCount), Number(history.saleCount))] : [excludedCoverage("historical-delivery-sales", "historical-delivery-sales-have-no-member-link")])]);
}

type PendingAppSheetInvoiceCaptureRow = {
  currency: string;
  invoiceCount: bigint;
  invalidCapturedBaseCount: bigint;
  capturedBaseMinor: string;
  capturedProductMinor: string;
  capturedProductLineCount: bigint;
  capturedClientTariffMinor: string;
};

/** Pending AppSheet captures remain visible for reconciliation, never as invoice totals or revenue. */
async function pendingAppSheetInvoiceCaptures(range: ReportDateRange, scope: ReportScope): Promise<PendingAppSheetInvoiceCaptureRow[]> {
  const predicates: Prisma.Sql[] = [
    Prisma.sql`o."commercialState" = 'confirmed'`,
    Prisma.sql`o."fulfillmentState" <> 'cancelled'`,
    Prisma.sql`o."confirmedAt" IS NOT NULL`,
    Prisma.sql`COALESCE(o."quote"->>'source', '') = 'appsheet-invoice' AND COALESCE(o."quote"->>'totalCalculationState', '') <> 'defined'`,
  ];
  const timeRange = timestampFilter(range);
  if (timeRange.gte) predicates.push(Prisma.sql`o."confirmedAt" >= ${rawSqlUtcTimestamp(timeRange.gte)}`);
  if (timeRange.lt) predicates.push(Prisma.sql`o."confirmedAt" < ${rawSqlUtcTimestamp(timeRange.lt)}`);
  if (scope.memberIds !== undefined) predicates.push(scope.memberIds.length
    ? Prisma.sql`o."memberId" IN (${Prisma.join(scope.memberIds)})`
    : Prisma.sql`FALSE`);
  return reportDb().$queryRaw<PendingAppSheetInvoiceCaptureRow[]>(Prisma.sql`
    WITH pending_orders AS (
      SELECT o."id", o."currency", o."quote", o."deliveryMinor"
      FROM "OperationOrder" AS o
      WHERE ${Prisma.join(predicates, " AND ")}
    ), explicit_products AS (
      SELECT l."orderId", COUNT(*)::bigint AS line_count, COALESCE(SUM(l."revenueMinor"), 0)::numeric AS captured_minor
      FROM "OperationOrderLine" AS l
      JOIN pending_orders AS o ON o."id" = l."orderId"
      GROUP BY l."orderId"
    )
    SELECT o."currency", COUNT(*)::bigint AS "invoiceCount",
      COUNT(*) FILTER (WHERE COALESCE(o."quote"->>'capturedBaseMinor', '') !~ '^(0|[1-9][0-9]*)$')::bigint AS "invalidCapturedBaseCount",
      COALESCE(SUM(CASE WHEN COALESCE(o."quote"->>'capturedBaseMinor', '') ~ '^(0|[1-9][0-9]*)$'
        THEN (o."quote"->>'capturedBaseMinor')::numeric ELSE 0::numeric END), 0)::text AS "capturedBaseMinor",
      COALESCE(SUM(p.captured_minor), 0)::text AS "capturedProductMinor",
      COALESCE(SUM(p.line_count), 0)::bigint AS "capturedProductLineCount",
      COALESCE(SUM(o."deliveryMinor"), 0)::text AS "capturedClientTariffMinor"
    FROM pending_orders AS o
    LEFT JOIN explicit_products AS p ON p."orderId" = o."id"
    GROUP BY o."currency"
    ORDER BY o."currency"
  `);
}

function pendingAppSheetInvoiceProjection(rows: PendingAppSheetInvoiceCaptureRow[]) {
  const capturedBase = moneyTotals();
  const capturedProducts = moneyTotals();
  const capturedClientTariffs = moneyTotals();
  let invoiceCount = 0;
  let invalidCapturedBaseCount = 0;
  let productLineCount = 0;
  for (const row of rows) {
    invoiceCount += Number(row.invoiceCount);
    invalidCapturedBaseCount += Number(row.invalidCapturedBaseCount);
    productLineCount += Number(row.capturedProductLineCount);
    addMoney(capturedBase, row.currency, BigInt(row.capturedBaseMinor));
    addMoney(capturedProducts, row.currency, BigInt(row.capturedProductMinor));
    addMoney(capturedClientTariffs, row.currency, BigInt(row.capturedClientTariffMinor));
  }
  return {
    count: invoiceCount,
    capturedBaseMinorByCurrency: asMoneyBuckets(capturedBase),
    capturedProductLineMinorByCurrency: asMoneyBuckets(capturedProducts),
    capturedProductLineCount: productLineCount,
    capturedClientTariffMinorByCurrency: asMoneyBuckets(capturedClientTariffs),
    totalMinorByCurrency: null,
    totalCalculationState: "pending_definition",
    recognizedAsSalesRevenue: false,
    amountBasis: "captured-components-not-a-calculated-invoice-total",
  };
}

function pendingInvoiceCaptureCoverage(rows: PendingAppSheetInvoiceCaptureRow[]): Coverage {
  const total = rows.reduce((sum, row) => sum + Number(row.invoiceCount), 0);
  const invalid = rows.reduce((sum, row) => sum + Number(row.invalidCapturedBaseCount), 0);
  return invalid ? partialCoverage("pending-appsheet-invoice-captures", total - invalid, total, "captured-base-is-invalid-or-missing")
    : coverage("pending-appsheet-invoice-captures", total, total);
}

function hasPendingAppSheetInvoices(rows: PendingAppSheetInvoiceCaptureRow[]): boolean {
  return rows.some(row => row.invoiceCount > 0n);
}

async function productContribution(range: ReportDateRange, scope: ReportScope) {
  const productPredicates: Prisma.Sql[] = [
    Prisma.sql`o."commercialState" = 'confirmed'`,
    Prisma.sql`o."confirmedAt" IS NOT NULL`,
    Prisma.sql`l."delivered" > 0`,
    Prisma.sql`NOT (COALESCE(o."quote"->>'source', '') = 'appsheet-invoice' AND COALESCE(o."quote"->>'totalCalculationState', '') <> 'defined')`,
  ];
  const timeRange = timestampFilter(range);
  if (timeRange.gte) productPredicates.push(Prisma.sql`o."confirmedAt" >= ${rawSqlUtcTimestamp(timeRange.gte)}`);
  if (timeRange.lt) productPredicates.push(Prisma.sql`o."confirmedAt" < ${rawSqlUtcTimestamp(timeRange.lt)}`);
  if (scope.memberIds !== undefined) productPredicates.push(scope.memberIds.length
    ? Prisma.sql`o."memberId" IN (${Prisma.join(scope.memberIds)})`
    : Prisma.sql`FALSE`);
  type ProductLineRow = { id: string; orderId: string; skuId: string; unit: string; requested: string; delivered: string; revenueMinor: bigint; channel: string; currency: string };
  const [lineCountRows, productLineRows, pendingInvoiceCaptures] = await Promise.all([
    reportDb().$queryRaw<Array<{ rowCount: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "rowCount"
      FROM "OperationOrderLine" AS l JOIN "OperationOrder" AS o ON o."id" = l."orderId"
      WHERE ${Prisma.join(productPredicates, " AND ")}
    `),
    reportDb().$queryRaw<ProductLineRow[]>(Prisma.sql`
      SELECT l."id", l."orderId", l."skuId", l."unit", l."requested"::text AS "requested",
        l."delivered"::text AS "delivered", l."revenueMinor", o."channel", o."currency"
      FROM "OperationOrderLine" AS l JOIN "OperationOrder" AS o ON o."id" = l."orderId"
      WHERE ${Prisma.join(productPredicates, " AND ")}
      ORDER BY l."orderId" ASC, l."id" ASC LIMIT ${REPORT_ROW_LIMIT}
    `),
    pendingAppSheetInvoiceCaptures(range, scope),
  ]);
  const lineCount = Number(lineCountRows[0]?.rowCount ?? 0n);
  const lines = productLineRows.map(({ channel, currency, ...line }) => ({ ...line, order: { channel, currency } }));
  const orderIds = [...new Set(lines.map(line => line.orderId))];
  const lineInputs = new Map(lines.map(line => [line.id, {
    currency: line.order.currency,
    channel: line.order.channel,
    revenueMinor: line.revenueMinor,
    unit: line.unit,
    requested: decimalText(line.requested),
    delivered: decimalText(line.delivered),
  }]));
  const soldLines = new Map<string, { currency: string; channel: string; revenue: bigint; unit: string; soldQuantity: string }>();
  const revenueByCurrency = moneyTotals();
  let revenueRows = 0;
  let soldCandidateCount = 0;
  let revenueExceptionLineCount = 0;
  const allocations = orderIds.length ? await reportDb().preparationAllocation.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true, orderId: true, lineId: true, lotId: true, requestedQuantity: true, actualQuantity: true, deliveredQuantity: true, returnedDeliveredQuantity: true, costMinor: true },
    orderBy: [{ orderId: "asc" }, { id: "asc" }],
    take: REPORT_ROW_LIMIT,
  }) : [];
  const allocationCount = orderIds.length ? await reportDb().preparationAllocation.count({ where: { orderId: { in: orderIds } } }) : 0;
  const lotIds = [...new Set(allocations.map(allocation => allocation.lotId))];
  const lots = lotIds.length ? await reportDb().inventoryLot.findMany({ where: { id: { in: lotIds } }, select: { id: true, costCurrency: true } }) : [];
  const currencyByLot = new Map(lots.map(lot => [lot.id, lot.costCurrency]));
  const allocatedDeliveredByLine = new Map<string, bigint>();
  const returnedDeliveredByLine = new Map<string, bigint>();
  const invalidAllocationLines = new Set<string>();
  let allocationExceptionCount = 0;
  for (const allocation of allocations) {
    if (!lineInputs.has(allocation.lineId)) continue;
    const delivered = parseDecimal(decimalText(allocation.deliveredQuantity), 12);
    const returnedDelivered = parseDecimal(decimalText(allocation.returnedDeliveredQuantity), 12);
    const actual = parseDecimal(decimalText(allocation.actualQuantity), 12);
    const requested = parseDecimal(decimalText(allocation.requestedQuantity), 12);
    if (actual <= 0n || requested <= 0n || delivered < 0n || delivered > actual || returnedDelivered < 0n || returnedDelivered > delivered) {
      invalidAllocationLines.add(allocation.lineId);
      allocationExceptionCount += 1;
      continue;
    }
    allocatedDeliveredByLine.set(allocation.lineId, (allocatedDeliveredByLine.get(allocation.lineId) ?? 0n) + delivered);
    // Returns retain the frozen billed/physical ratio of their particular preparation.
    returnedDeliveredByLine.set(allocation.lineId, (returnedDeliveredByLine.get(allocation.lineId) ?? 0n) + requested * returnedDelivered / actual);
  }
  for (const [lineId, line] of lineInputs) {
    const delivered = parseDecimal(line.delivered, 12);
    const allocatedDelivered = allocatedDeliveredByLine.get(lineId) ?? 0n;
    const requested = parseDecimal(line.requested, 12);
    const returnedBilled = returnedDeliveredByLine.get(lineId) ?? 0n;
    if (invalidAllocationLines.has(lineId) || allocatedDelivered <= 0n || delivered > requested || returnedBilled > delivered) {
      revenueExceptionLineCount += 1;
      continue;
    }
    const sold = delivered - returnedBilled;
    if (sold <= 0n) continue;
    soldCandidateCount += 1;
    const revenue = prorateMinor(line.revenueMinor, formatDecimal(sold, 12), line.requested);
    if (revenue === null) {
      revenueExceptionLineCount += 1;
      continue;
    }
    addMoney(revenueByCurrency, line.currency, revenue);
    soldLines.set(lineId, { currency: line.currency, channel: line.channel, revenue, unit: line.unit, soldQuantity: formatDecimal(sold, 12) });
    revenueRows += 1;
  }
  const costByCurrency = moneyTotals();
  const matchedCostByCurrency = moneyTotals();
  const allocatedByLine = new Set<string>();
  for (const allocation of allocations) {
    const line = soldLines.get(allocation.lineId);
    if (!line) continue;
    const costCurrency = currencyByLot.get(allocation.lotId);
    if (costCurrency !== "ARS" && costCurrency !== "USD") {
      allocationExceptionCount += 1;
      continue;
    }
    const cost = allocatedCostSold({
      currency: costCurrency,
      costMinor: allocation.costMinor.toString(),
      actualQuantity: decimalText(allocation.actualQuantity),
      deliveredQuantity: decimalText(allocation.deliveredQuantity),
      returnedDeliveredQuantity: decimalText(allocation.returnedDeliveredQuantity),
    });
    if (!cost) {
      allocationExceptionCount += 1;
      continue;
    }
    allocatedByLine.add(allocation.lineId);
    const costMinor = BigInt(cost.minor);
    addMoney(costByCurrency, cost.currency, costMinor);
    if (cost.currency === line.currency) addMoney(matchedCostByCurrency, cost.currency, costMinor);
    else allocationExceptionCount += 1;
  }
  const missingAllocationLineCount = [...soldLines.keys()].filter(id => !allocatedByLine.has(id)).length + revenueExceptionLineCount;
  const revenueAmounts = new Map(asMoneyBuckets(revenueByCurrency).map(row => [row.currency ?? "\u0000unknown-currency", BigInt(row.minor)]));
  const productPopulationComplete = lineCount === lines.length && allocationCount === allocations.length;
  const grossMarginByCurrency: MoneyBucket[] | null = !productPopulationComplete || missingAllocationLineCount || allocationExceptionCount
    ? null
    : [...revenueAmounts.entries()].map(([currency, revenue]) => ({ currency: currency === "\u0000unknown-currency" ? null : currency, minor: (revenue - (matchedCostByCurrency.get(currency) ?? 0n)).toString() }));
  const fixedCosts = await approvedFixedCosts(range, scope);
  const management = await managementContribution(range, scope, grossMarginByCurrency, pendingInvoiceCaptures);
  const contributionAfterFixedCostsByCurrency = subtractFixedCostsByCurrency(
    toCurrencyTotals(management.managementContributionBeforeFixedCostsByCurrency),
    toCurrencyTotals(fixedCosts.amountByCurrency),
  );
  return queryEnvelope("product-contribution", range, {
    deliveredLineCount: lineCount,
    linesWithRevenueObserved: revenueRows,
    revenueByCurrency: productPopulationComplete ? asMoneyBuckets(revenueByCurrency) : null,
    actualAllocatedCostSoldByCurrency: productPopulationComplete ? asMoneyBuckets(costByCurrency) : null,
    productSourceRowsComplete: productPopulationComplete,
    grossContributionBeforeFixedCostsByCurrency: grossMarginByCurrency,
    pendingAppSheetInvoices: pendingAppSheetInvoiceProjection(pendingInvoiceCaptures),
    ...management,
    fixedCosts,
    contributionAfterFixedCostsByCurrency,
    allocationCoverage: {
      soldLineCount: soldCandidateCount,
      linesWithSoldLotAllocation: allocatedByLine.size,
      missingAllocationLineCount,
      allocationExceptionCount,
      revenueExceptionLineCount,
      method: "billed-delivery-revenue; customer-returns-at-frozen-preparation-ratio; actual-delivered-net-lot-cost",
      quotedReplacementCostUsed: false,
    },
  }, [coverage("delivered-operation-order-lines", lines.length, lineCount), coverage("preparation-allocations", allocations.length, allocationCount), ...(hasPendingAppSheetInvoices(pendingInvoiceCaptures) ? [pendingInvoiceCaptureCoverage(pendingInvoiceCaptures), excludedCoverage("pending-appsheet-captured-product-lines", "captured-product-lines-are-exposed-separately-until-invoice-total-is-defined")] : []), fixedCostCoverage(fixedCosts)]);
}

/** Management contribution adds frozen charges and accrued, verified variable obligations.
 * Cash payments and renditions never recognize these costs a second time.
 */
async function managementContribution(range: ReportDateRange, scope: ReportScope, productMargin: MoneyBucket[] | null, pendingInvoiceCaptures: PendingAppSheetInvoiceCaptureRow[]) {
  type ChargeAggregate = { currency: string; recognizedMinor: string; unresolvedCount: bigint };
  const chargePredicates: Prisma.Sql[] = [
    Prisma.sql`o."commercialState" = 'confirmed'`,
    Prisma.sql`o."confirmedAt" IS NOT NULL`,
    Prisma.sql`EXISTS (SELECT 1 FROM "OperationOrderLine" AS l WHERE l."orderId" = o."id" AND l."delivered" > 0)`,
    Prisma.sql`NOT (COALESCE(o."quote"->>'source', '') = 'appsheet-invoice' AND COALESCE(o."quote"->>'totalCalculationState', '') <> 'defined')`,
  ];
  const chargeRange = timestampFilter(range);
  if (chargeRange.gte) chargePredicates.push(Prisma.sql`o."confirmedAt" >= ${rawSqlUtcTimestamp(chargeRange.gte)}`);
  if (chargeRange.lt) chargePredicates.push(Prisma.sql`o."confirmedAt" < ${rawSqlUtcTimestamp(chargeRange.lt)}`);
  if (scope.memberIds !== undefined) chargePredicates.push(scope.memberIds.length
    ? Prisma.sql`o."memberId" IN (${Prisma.join(scope.memberIds)})`
    : Prisma.sql`FALSE`);
  const chargeGroups = await reportDb().$queryRaw<ChargeAggregate[]>(Prisma.sql`
    SELECT o."currency", COUNT(*) FILTER (WHERE
        o."deliveryMinor" - o."deliveryDiscountMinor" - o."refundedDeliveryMinor" + o."surchargeMinor" - o."refundedSurchargeMinor" < 0
        OR (o."deliveryMinor" - o."deliveryDiscountMinor" - o."refundedDeliveryMinor" + o."surchargeMinor" - o."refundedSurchargeMinor" > 0 AND o."fulfillmentState" <> 'delivered')) AS "unresolvedCount",
      COALESCE(SUM(CASE WHEN
        o."deliveryMinor" - o."deliveryDiscountMinor" - o."refundedDeliveryMinor" + o."surchargeMinor" - o."refundedSurchargeMinor" >= 0
        AND (o."deliveryMinor" - o."deliveryDiscountMinor" - o."refundedDeliveryMinor" + o."surchargeMinor" - o."refundedSurchargeMinor" = 0 OR o."fulfillmentState" = 'delivered')
        THEN o."deliveryMinor" - o."deliveryDiscountMinor" - o."refundedDeliveryMinor" + o."surchargeMinor" - o."refundedSurchargeMinor"
        ELSE 0 END), 0)::text AS "recognizedMinor"
    FROM "OperationOrder" AS o
    WHERE ${Prisma.join(chargePredicates, " AND ")}
    GROUP BY o."currency"
    ORDER BY o."currency"
  `);
  const charges = moneyTotals();
  const pendingDeliveryTariffs = moneyTotals();
  let unresolvedChargeOrderCount = 0;
  let pendingInvoiceCount = 0;
  for (const pending of pendingInvoiceCaptures) {
    pendingInvoiceCount += Number(pending.invoiceCount);
    addMoney(pendingDeliveryTariffs, pending.currency, BigInt(pending.capturedClientTariffMinor));
  }
  for (const charge of chargeGroups) {
    unresolvedChargeOrderCount += Number(charge.unresolvedCount);
    addMoney(charges, charge.currency, BigInt(charge.recognizedMinor));
  }
  // A member-scoped report cannot subtract or disclose the club's general obligations.
  type CostAggregate = { kind: string; currency: string; verified: boolean; accrualPeriod: string | null; costTreatment: string | null; rowCount: bigint; amountMinor: string };
  const costGroups = scope.memberIds === undefined ? await reportDb().$queryRaw<CostAggregate[]>(Prisma.sql`
    SELECT p."kind", p."currency", p."verified", p."accrualPeriod", p."evidence"->>'costTreatment' AS "costTreatment",
      COUNT(*) AS "rowCount", COALESCE(SUM(p."amountMinor"), 0)::text AS "amountMinor"
    FROM "OperationPayable" AS p
    WHERE p."kind" IN ('courier_fee', 'operating_expense')
    GROUP BY p."kind", p."currency", p."verified", p."accrualPeriod", p."evidence"->>'costTreatment'
    ORDER BY p."kind", p."currency", p."verified", p."accrualPeriod", p."evidence"->>'costTreatment'
  `) : [];
  const variableCosts = moneyTotals();
  let pendingCostCount = 0;
  let classifiedCostCount = 0;
  for (const cost of costGroups) {
    const rowCount = Number(cost.rowCount);
    if (cost.kind === "operating_expense" && cost.costTreatment === "fixed" && cost.verified) continue;
    if (cost.accrualPeriod && ((range.from && cost.accrualPeriod < range.from.slice(0, 7)) || (range.to && cost.accrualPeriod > range.to.slice(0, 7)))) continue;
    if (!cost.verified || !cost.accrualPeriod || (cost.kind !== "courier_fee" && cost.costTreatment !== "variable")) {
      pendingCostCount += rowCount;
      continue;
    }
    addMoney(variableCosts, cost.currency, BigInt(cost.amountMinor));
    classifiedCostCount += rowCount;
  }
  const ready = productMargin !== null && scope.memberIds === undefined && !unresolvedChargeOrderCount && !pendingCostCount;
  const singlePeriod = range.from && range.to && range.from.slice(0,7) === range.to.slice(0,7) ? range.from.slice(0,7) : null;
  const attestation = singlePeriod ? await getManagementPeriodCoverageStatus(reportDb(),{period:singlePeriod,scope}) : null;
  const totals = moneyTotals();
  if (ready) {
    for (const row of productMargin) addMoney(totals, row.currency, BigInt(row.minor));
    for (const row of asMoneyBuckets(charges)) addMoney(totals, row.currency, BigInt(row.minor));
    for (const row of asMoneyBuckets(variableCosts)) addMoney(totals, row.currency, -BigInt(row.minor));
  }
  return {
    recognizedDeliveryAndSurchargeByCurrency: asMoneyBuckets(charges),
    pendingAppSheetDeliveryTariffByCurrency: asMoneyBuckets(pendingDeliveryTariffs),
    pendingAppSheetDeliveryTariffRecognized: false,
    approvedAccruedVariableCostsByCurrency: scope.memberIds === undefined ? asMoneyBuckets(variableCosts) : null,
    managementContributionBeforeFixedCostsByCurrency: ready ? asMoneyBuckets(totals) : null,
    managementCoverage: {
      state: ready ? attestation?.sourcePeriodCompletenessAttested ? "attested" : "unverified" : "partial",
      arithmeticCompleteForObservedRecords: ready,
      sourcePeriodCompletenessAttested: attestation?.sourcePeriodCompletenessAttested === true,
      sourcePeriodAttestation: attestation,
      unresolvedChargeOrderCount,
      pendingAppSheetInvoiceCount: pendingInvoiceCount,
      pendingAppSheetDeliveryTariffRecognized: false,
      pendingCostCount: scope.memberIds === undefined ? pendingCostCount : null,
      classifiedCostCount: scope.memberIds === undefined ? classifiedCostCount : null,
      costQueryComplete: scope.memberIds === undefined ? true : null,
      costRecognition: "verified-variable-obligations-by-explicit-accrual-month; payments-not-added",
      chargeRecognition: "frozen-net-charges-on-completed-fulfillment; partial-positive-charges-require-review",
      reason: scope.memberIds !== undefined ? "general-costs-withheld-by-member-scope" : ready ? attestation?.sourcePeriodCompletenessAttested ? null : "source-period-completeness-not-attested" : "cost-allocation-or-charge-coverage-pending",
    },
  };
}

async function operatingExpenses(range: ReportDateRange, scope: ReportScope) {
  const legacyPredicates: Prisma.Sql[] = [];
  if (range.from) legacyPredicates.push(Prisma.sql`h."expenseDate" >= ${range.from}::date`);
  if (range.to) legacyPredicates.push(Prisma.sql`h."expenseDate" < ${addDays(range.to, 1)}::date`);
  const expensePredicates: Prisma.Sql[] = [];
  if (range.from) expensePredicates.push(Prisma.sql`e."date" >= ${range.from}`);
  if (range.to) expensePredicates.push(Prisma.sql`e."date" <= ${range.to}`);
  const paymentPredicates: Prisma.Sql[] = [Prisma.sql`o."kind" = 'operating_expense'`];
  if (range.from) paymentPredicates.push(Prisma.sql`p."date" >= ${range.from}`);
  if (range.to) paymentPredicates.push(Prisma.sql`p."date" <= ${range.to}`);
  type SingleMoneyAggregate = { rowCount: bigint; minor: string };
  type PayableAggregate = { currency: string; verified: boolean; rowCount: bigint; accruedMinor: string; openMinor: string };
  type PaymentAggregate = { currency: string; rowCount: bigint; appliedMinor: string };
  const [legacyRows, compatibilityRows, payableGroups, paymentGroups] = await Promise.all([
    reportDb().$queryRaw<SingleMoneyAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS "rowCount", COALESCE(SUM(h."amountCents"), 0)::text AS "minor"
      FROM "HistoricalExpense" AS h
      ${legacyPredicates.length ? Prisma.sql`WHERE ${Prisma.join(legacyPredicates, " AND ")}` : Prisma.empty}
    `),
    reportDb().$queryRaw<SingleMoneyAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS "rowCount", COALESCE(SUM(e."amount"), 0)::text AS "minor"
      FROM "Expense" AS e
      ${expensePredicates.length ? Prisma.sql`WHERE ${Prisma.join(expensePredicates, " AND ")}` : Prisma.empty}
    `),
    reportDb().$queryRaw<PayableAggregate[]>(Prisma.sql`
      SELECT p."currency", p."verified", COUNT(*) AS "rowCount",
        COALESCE(SUM(p."amountMinor"), 0)::text AS "accruedMinor",
        COALESCE(SUM(GREATEST(p."amountMinor" - p."paidMinor", 0)), 0)::text AS "openMinor"
      FROM "OperationPayable" AS p
      WHERE p."kind" = 'operating_expense'
      GROUP BY p."currency", p."verified"
      ORDER BY p."currency", p."verified"
    `),
    reportDb().$queryRaw<PaymentAggregate[]>(Prisma.sql`
      SELECT o."currency", COUNT(*) AS "rowCount",
        COALESCE(SUM(p."appliedMinor"), 0)::text AS "appliedMinor"
      FROM "PayablePayment" AS p
      JOIN "OperationPayable" AS o ON o."id" = p."payableId"
      WHERE ${Prisma.join(paymentPredicates, " AND ")}
      GROUP BY o."currency"
      ORDER BY o."currency"
    `),
  ]);
  const legacyCount = Number(legacyRows[0]?.rowCount ?? 0n);
  const oldAppCount = Number(compatibilityRows[0]?.rowCount ?? 0n);
  const payableCount = payableGroups.reduce((sum, row) => sum + Number(row.rowCount), 0);
  const paymentCount = paymentGroups.reduce((sum, row) => sum + Number(row.rowCount), 0);
  const historicalExpense = moneyTotals();
  addMoney(historicalExpense, null, BigInt(legacyRows[0]?.minor ?? "0"));
  const compatibilityExpense = moneyTotals();
  addMoney(compatibilityExpense, null, BigInt(compatibilityRows[0]?.minor ?? "0"));
  const accruedVerified = moneyTotals();
  const accruedPending = moneyTotals();
  const openVerified = moneyTotals();
  const openPending = moneyTotals();
  for (const payable of payableGroups) {
    addMoney(payable.verified ? accruedVerified : accruedPending, payable.currency, BigInt(payable.accruedMinor));
    addMoney(payable.verified ? openVerified : openPending, payable.currency, BigInt(payable.openMinor));
  }
  const paid = moneyTotals();
  for (const payment of paymentGroups) addMoney(paid, payment.currency, BigInt(payment.appliedMinor));
  const fixedCosts = await approvedFixedCosts(range, scope);
  return queryEnvelope("operating-expenses", range, {
    historicalExpenseByCurrency: asMoneyBuckets(historicalExpense),
    compatibilityExpenseByCurrency: asMoneyBuckets(compatibilityExpense),
    currencyStatusForHistoricalSources: "unknown-in-source-schema",
    verifiedPayableAccrualByCurrency: asMoneyBuckets(accruedVerified),
    unverifiedPayableAccrualByCurrency: asMoneyBuckets(accruedPending),
    paidPayableByObligationCurrency: asMoneyBuckets(paid),
    openVerifiedOperatingPayablesByCurrency: asMoneyBuckets(openVerified),
    openUnverifiedOperatingPayablesByCurrency: asMoneyBuckets(openPending),
    fixedCosts,
    counts: { historicalExpenseRows: legacyCount, compatibilityExpenseRows: oldAppCount, operatingPayables: payableCount, payablePayments: paymentCount },
  }, [coverage("historical-expenses", legacyCount, legacyCount), coverage("compatibility-expenses", oldAppCount, oldAppCount), coverage("operating-payables", payableCount, payableCount), coverage("payable-payments", paymentCount, paymentCount), fixedCostCoverage(fixedCosts)]);
}

async function purchases(range: ReportDateRange) {
  const orderPredicates: Prisma.Sql[] = [];
  if (range.from) orderPredicates.push(Prisma.sql`p."agreementDate" >= ${range.from}`);
  if (range.to) orderPredicates.push(Prisma.sql`p."agreementDate" <= ${range.to}`);
  const receiptPredicates: Prisma.Sql[] = [];
  if (range.from) receiptPredicates.push(Prisma.sql`r."receivedDate" >= ${range.from}`);
  if (range.to) receiptPredicates.push(Prisma.sql`r."receivedDate" <= ${range.to}`);
  const historicalPredicates: Prisma.Sql[] = [];
  if (range.from) historicalPredicates.push(Prisma.sql`h."receivedDate" >= ${range.from}::date`);
  if (range.to) historicalPredicates.push(Prisma.sql`h."receivedDate" < ${addDays(range.to, 1)}::date`);
  type PurchaseOrderAggregate = { currency: string; status: string; rowCount: bigint; totalMinor: string };
  type ReceiptAggregate = { rowCount: bigint; linkedOrderCount: bigint };
  type HistoricalPurchaseAggregate = { rowCount: bigint; totalCents: string };
  type PurchasePayableAggregate = { currency: string; verified: boolean; rowCount: bigint; openMinor: string };
  const [orders, receipts, historical, payables, lotCount] = await Promise.all([
    reportDb().$queryRaw<PurchaseOrderAggregate[]>(Prisma.sql`
      SELECT p."currency", p."status", COUNT(*) AS "rowCount",
        COALESCE(SUM(p."totalMinor"), 0)::text AS "totalMinor"
      FROM "PurchaseOrder" AS p
      ${orderPredicates.length ? Prisma.sql`WHERE ${Prisma.join(orderPredicates, " AND ")}` : Prisma.empty}
      GROUP BY p."currency", p."status"
      ORDER BY p."currency", p."status"
    `),
    reportDb().$queryRaw<ReceiptAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS "rowCount", COUNT(DISTINCT r."purchaseId") AS "linkedOrderCount"
      FROM "GoodsReceipt" AS r
      ${receiptPredicates.length ? Prisma.sql`WHERE ${Prisma.join(receiptPredicates, " AND ")}` : Prisma.empty}
    `),
    reportDb().$queryRaw<HistoricalPurchaseAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS "rowCount", COALESCE(SUM(h."totalCents"), 0)::text AS "totalCents"
      FROM "HistoricalPurchaseReceipt" AS h
      ${historicalPredicates.length ? Prisma.sql`WHERE ${Prisma.join(historicalPredicates, " AND ")}` : Prisma.empty}
    `),
    reportDb().$queryRaw<PurchasePayableAggregate[]>(Prisma.sql`
      SELECT p."currency", p."verified", COUNT(*) AS "rowCount",
        COALESCE(SUM(GREATEST(p."amountMinor" - p."paidMinor", 0)), 0)::text AS "openMinor"
      FROM "OperationPayable" AS p
      WHERE p."purchaseId" IS NOT NULL
      GROUP BY p."currency", p."verified"
      ORDER BY p."currency", p."verified"
    `),
    reportDb().inventoryLot.count({ where: { receiptId: { not: null } } }),
  ]);
  const orderCount = orders.reduce((sum, row) => sum + Number(row.rowCount), 0);
  const receiptCount = Number(receipts[0]?.rowCount ?? 0n);
  const historyCount = Number(historical[0]?.rowCount ?? 0n);
  const payableCount = payables.reduce((sum, row) => sum + Number(row.rowCount), 0);
  const orderTotals = moneyTotals();
  const totalsByStatus = new Map<string, number>();
  for (const order of orders) {
    addMoney(orderTotals, order.currency, BigInt(order.totalMinor));
    totalsByStatus.set(order.status, (totalsByStatus.get(order.status) ?? 0) + Number(order.rowCount));
  }
  const historicalTotals = moneyTotals();
  addMoney(historicalTotals, null, BigInt(historical[0]?.totalCents ?? "0"));
  const outstandingVerified = moneyTotals();
  const outstandingPending = moneyTotals();
  for (const payable of payables) {
    addMoney(payable.verified ? outstandingVerified : outstandingPending, payable.currency, BigInt(payable.openMinor));
  }
  return queryEnvelope("purchases", range, {
    purchaseOrders: { count: orderCount, totalsByCurrency: asMoneyBuckets(orderTotals), countsByObservedStatus: [...totalsByStatus].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => ({ status, count })) },
    receipts: { count: receiptCount, linkedOrderCount: Number(receipts[0]?.linkedOrderCount ?? 0n), receiptCreatedLots: lotCount },
    verifiedOpenPurchasePayablesByCurrency: asMoneyBuckets(outstandingVerified),
    pendingOpenPurchasePayablesByCurrency: asMoneyBuckets(outstandingPending),
    historicalPurchaseReceiptCount: historyCount,
    historicalPurchaseTotalByCurrency: asMoneyBuckets(historicalTotals),
    historicalCurrencyStatus: "unknown-in-source-schema",
    receiptQuantities: { value: null, state: "receipt-items-json-have-no-published-typed-quantity-contract" },
  }, [coverage("purchase-orders", orderCount, orderCount), coverage("goods-receipts", receiptCount, receiptCount), coverage("historical-purchase-receipts", historyCount, historyCount), coverage("purchase-payables", payableCount, payableCount)]);
}

async function inventory(range: ReportDateRange, scope: ReportScope) {
  const legacyDateRange = dateOnlyFilter(range);
  const stockFactDateRange = timestampFilter(range);
  const balanceWhere: Prisma.StockBalanceWhereInput = {
    ...(scope.locationIds !== undefined ? { locationId: { in: scope.locationIds } } : {}),
    ...(scope.custodianIds !== undefined ? { custodianId: { in: scope.custodianIds } } : {}),
  };
  const historicalWhere = Object.keys(legacyDateRange).length ? { observedDate: legacyDateRange } : {};
  const stockoutWhere = Object.keys(legacyDateRange).length ? { stockoutDate: legacyDateRange } : {};
  const stockFactWhere = {
    ...(Object.keys(stockFactDateRange).length ? { occurredAt: stockFactDateRange } : {}),
    ...stockFactScopeWhere(scope),
  };
  const balanceScopePredicates: Prisma.Sql[] = [];
  if (scope.locationIds !== undefined) balanceScopePredicates.push(scope.locationIds.length
    ? Prisma.sql`b."locationId" IN (${Prisma.join(scope.locationIds)})`
    : Prisma.sql`FALSE`);
  if (scope.custodianIds !== undefined) balanceScopePredicates.push(scope.custodianIds.length
    ? Prisma.sql`b."custodianId" IN (${Prisma.join(scope.custodianIds)})`
    : Prisma.sql`FALSE`);
  const balanceScopePredicate = balanceScopePredicates.length
    ? Prisma.sql`WHERE ${Prisma.join(balanceScopePredicates, " AND ")}`
    : Prisma.empty;
  const stockFactPredicates: Prisma.Sql[] = [];
  if (stockFactDateRange.gte) stockFactPredicates.push(Prisma.sql`f."occurredAt" >= ${rawSqlUtcTimestamp(stockFactDateRange.gte)}`);
  if (stockFactDateRange.lt) stockFactPredicates.push(Prisma.sql`f."occurredAt" < ${rawSqlUtcTimestamp(stockFactDateRange.lt)}`);
  const locationFactScope = stockFactEndpointScopePredicate(Prisma.sql`f."fromLocationId"`, Prisma.sql`f."toLocationId"`, scope.locationIds);
  const custodianFactScope = stockFactEndpointScopePredicate(Prisma.sql`f."fromCustodianId"`, Prisma.sql`f."toCustodianId"`, scope.custodianIds);
  if (locationFactScope) stockFactPredicates.push(locationFactScope);
  if (custodianFactScope) stockFactPredicates.push(custodianFactScope);
  const observationPredicates: Prisma.Sql[] = [];
  if (range.from) observationPredicates.push(Prisma.sql`h."observedDate" >= ${range.from}::date`);
  if (range.to) observationPredicates.push(Prisma.sql`h."observedDate" < ${addDays(range.to, 1)}::date`);
  const invalidBalanceSql = Prisma.sql`BTRIM(b."unit") = '' OR b."quantity" < 0 OR b."reserved" < 0 OR b."reserved" > b."quantity"`;
  const invalidStockFactSql = Prisma.sql`BTRIM(f."unit") = '' OR (f."kind" = 'waste' AND f."quantity" <= 0) OR (f."kind" = 'count_adjustment' AND f."quantity" = 0) OR (f."kind" IN ('transfer', 'transfer_internal') AND f."quantity" <= 0)`;
  type BalanceUnitAggregate = { unit: string; rowCount: bigint; validCount: bigint; invalidCount: bigint; onHand: string; reserved: string; available: string };
  type BalanceLotAggregate = { lotCount: bigint };
  type ValuationAggregate = { currency: string; balanceCount: bigint; amountMinor: string };
  type ObservationAggregate = { unit: string; rowCount: bigint; quantityMilliunits: string };
  type StockMovementAggregate = { kind: string; unit: string; rowCount: bigint; validCount: bigint; invalidCount: bigint; quantity: string };
  const [balanceCount, balances, balanceGroups, lotGroups, valuationGroups, observationCount, observationGroups, stockoutCount, stockFactCount, stockFacts, stockMovementGroups] = await Promise.all([
    reportDb().stockBalance.count({ where: balanceWhere }),
    reportDb().stockBalance.findMany({
      where: balanceWhere,
      select: { id: true, lotId: true, locationId: true, custodianId: true, quantity: true, reserved: true, unit: true, lot: { select: { label: true, skuId: true, unit: true, unitCost: true, costCurrency: true, sku: { select: { unit: true } } } } },
      orderBy: [{ lotId: "asc" }, { id: "asc" }],
      take: REPORT_DETAIL_ROW_LIMIT,
    }),
    reportDb().$queryRaw<BalanceUnitAggregate[]>(Prisma.sql`
      SELECT BTRIM(b."unit") AS "unit", COUNT(*) AS "rowCount",
        COUNT(*) FILTER (WHERE NOT (${invalidBalanceSql})) AS "validCount",
        COUNT(*) FILTER (WHERE ${invalidBalanceSql}) AS "invalidCount",
        COALESCE(SUM(b."quantity") FILTER (WHERE NOT (${invalidBalanceSql})), 0)::text AS "onHand",
        COALESCE(SUM(b."reserved") FILTER (WHERE NOT (${invalidBalanceSql})), 0)::text AS "reserved",
        COALESCE(SUM(b."quantity" - b."reserved") FILTER (WHERE NOT (${invalidBalanceSql})), 0)::text AS "available"
      FROM "StockBalance" AS b
      ${balanceScopePredicate}
      GROUP BY BTRIM(b."unit")
      ORDER BY BTRIM(b."unit")
    `),
    reportDb().$queryRaw<BalanceLotAggregate[]>(Prisma.sql`
      SELECT COUNT(DISTINCT b."lotId") AS "lotCount"
      FROM "StockBalance" AS b
      ${balanceScopePredicate}
    `),
    reportDb().$queryRaw<ValuationAggregate[]>(Prisma.sql`
      SELECT l."costCurrency" AS "currency",
        COUNT(*) FILTER (WHERE l."costCurrency" <> '' AND NOT (${invalidBalanceSql})) AS "balanceCount",
        COALESCE(SUM(ROUND(l."unitCost" * b."quantity" * 100)) FILTER (WHERE l."costCurrency" <> '' AND NOT (${invalidBalanceSql})), 0)::text AS "amountMinor"
      FROM "StockBalance" AS b
      JOIN "InventoryLot" AS l ON l."id" = b."lotId"
      ${balanceScopePredicate}
      GROUP BY l."costCurrency"
      ORDER BY l."costCurrency"
    `),
    reportDb().historicalStockObservation.count({ where: historicalWhere }),
    scope.locationIds === undefined ? reportDb().$queryRaw<ObservationAggregate[]>(Prisma.sql`
      SELECT h."quantityUnit" AS "unit", COUNT(*) AS "rowCount", COALESCE(SUM(h."quantityMilliunits"), 0)::text AS "quantityMilliunits"
      FROM "HistoricalStockObservation" AS h
      ${observationPredicates.length ? Prisma.sql`WHERE ${Prisma.join(observationPredicates, " AND ")}` : Prisma.empty}
      GROUP BY h."quantityUnit"
      ORDER BY h."quantityUnit"
    `) : Promise.resolve([]),
    reportDb().historicalStockout.count({ where: stockoutWhere }),
    reportDb().stockFact.count({ where: stockFactWhere }),
    reportDb().stockFact.findMany({ where: stockFactWhere, select: { id: true, lotId: true, kind: true, quantity: true, unit: true, fromLocationId: true, toLocationId: true, fromCustodianId: true, toCustodianId: true, occurredAt: true }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: REPORT_DETAIL_ROW_LIMIT }),
    reportDb().$queryRaw<StockMovementAggregate[]>(Prisma.sql`
      SELECT f."kind", BTRIM(f."unit") AS "unit", COUNT(*) AS "rowCount",
        COUNT(*) FILTER (WHERE NOT (${invalidStockFactSql})) AS "validCount",
        COUNT(*) FILTER (WHERE ${invalidStockFactSql}) AS "invalidCount",
        COALESCE(SUM(f."quantity") FILTER (WHERE NOT (${invalidStockFactSql})), 0)::text AS "quantity"
      FROM "StockFact" AS f
      ${stockFactPredicates.length ? Prisma.sql`WHERE ${Prisma.join(stockFactPredicates, " AND ")}` : Prisma.empty}
      GROUP BY f."kind", BTRIM(f."unit")
      ORDER BY f."kind", BTRIM(f."unit")
    `),
  ]);
  if (scope.locationIds !== undefined && (observationCount > 0 || stockoutCount > 0)) {
    throw new OperationError(403, "REPORT_SCOPE_UNSUPPORTED", "El histórico de inventario no tiene un cruce verificado con las ubicaciones operativas asignadas");
  }
  const allocationBalancePredicates: Prisma.Sql[] = [];
  if (scope.locationIds !== undefined) allocationBalancePredicates.push(scope.locationIds.length
    ? Prisma.sql`b."locationId" IN (${Prisma.join(scope.locationIds)})`
    : Prisma.sql`FALSE`);
  if (scope.custodianIds !== undefined) allocationBalancePredicates.push(scope.custodianIds.length
    ? Prisma.sql`b."custodianId" IN (${Prisma.join(scope.custodianIds)})`
    : Prisma.sql`FALSE`);
  const allocationBalancePredicate = allocationBalancePredicates.length
    ? Prisma.sql`AND ${Prisma.join(allocationBalancePredicates, " AND ")}`
    : Prisma.empty;
  type CountAggregate = { rowCount: bigint };
  type VisibleAllocation = {
    id: string; orderId: string; lineId: string; lotId: string; balanceId: string;
    actualQuantity: unknown; deliveredQuantity: unknown; returnedQuantity: unknown; returnedDeliveredQuantity: unknown; state: string;
  };
  const [reservationRows, allocationRows, allocations] = await Promise.all([
    reportDb().$queryRaw<CountAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS "rowCount"
      FROM "StockReservation" AS r
      JOIN "StockBalance" AS b ON b."id" = r."balanceId"
      WHERE r."status" = 'active' ${allocationBalancePredicate}
    `),
    reportDb().$queryRaw<CountAggregate[]>(Prisma.sql`
      SELECT COUNT(*) AS "rowCount"
      FROM "PreparationAllocation" AS a
      JOIN "StockBalance" AS b ON b."id" = a."balanceId"
      WHERE a."state" IN ('prepared', 'partially_prepared', 'dispatched', 'partially_returned', 'delivered') ${allocationBalancePredicate}
    `),
    reportDb().$queryRaw<VisibleAllocation[]>(Prisma.sql`
      SELECT a."id", a."orderId", a."lineId", a."lotId", a."balanceId", a."actualQuantity", a."deliveredQuantity", a."returnedQuantity", a."returnedDeliveredQuantity", a."state"
      FROM "PreparationAllocation" AS a
      JOIN "StockBalance" AS b ON b."id" = a."balanceId"
      WHERE a."state" IN ('prepared', 'partially_prepared', 'dispatched', 'partially_returned', 'delivered') ${allocationBalancePredicate}
      ORDER BY a."orderId" ASC, a."lineId" ASC, a."lotId" ASC, a."id" ASC
      LIMIT ${REPORT_DETAIL_ROW_LIMIT}
    `),
  ]);
  const reservationCount = Number(reservationRows[0]?.rowCount ?? 0n);
  const allocationCount = Number(allocationRows[0]?.rowCount ?? 0n);
  const orderIds = [...new Set(allocations.map(allocation => allocation.orderId))];
  const [deliveryAssignmentCount, deliveryAssignments] = orderIds.length ? await Promise.all([
    reportDb().deliveryAssignment.count({ where: { orderId: { in: orderIds }, dispatchedAt: { not: null } } }),
    reportDb().deliveryAssignment.findMany({
      where: { orderId: { in: orderIds }, dispatchedAt: { not: null } },
      select: { id: true, orderId: true, driverId: true, dispatchedAt: true },
      orderBy: [{ orderId: "asc" }, { dispatchedAt: "desc" }, { id: "desc" }],
      take: REPORT_DETAIL_ROW_LIMIT,
    }),
  ]) : [0, [] as Array<{ id: string; orderId: string; driverId: string | null; dispatchedAt: Date | null }>];
  const assignmentByOrder = new Map<string, (typeof deliveryAssignments)[number]>();
  for (const assignment of deliveryAssignments) if (!assignmentByOrder.has(assignment.orderId)) assignmentByOrder.set(assignment.orderId, assignment);
  const allocationBalanceIds = [...new Set(allocations.map(allocation => allocation.balanceId))];
  const allocationBalances = allocationBalanceIds.length
    ? await reportDb().stockBalance.findMany({
        where: { id: { in: allocationBalanceIds } },
        select: { id: true, lotId: true, locationId: true, custodianId: true, unit: true, lot: { select: { label: true, skuId: true, unit: true, unitCost: true, costCurrency: true, sku: { select: { unit: true } } } } },
      })
    : [];
  const balanceById = new Map([...balances, ...allocationBalances].map(balance => [balance.id, balance]));
  const onHandByUnit = new Map(balanceGroups.filter(row => row.validCount > 0n).map(row => [row.unit, parseDecimal(row.onHand, 12)]));
  const reservedByUnit = new Map(balanceGroups.filter(row => row.validCount > 0n).map(row => [row.unit, parseDecimal(row.reserved, 12)]));
  const availableByUnit = new Map(balanceGroups.filter(row => row.validCount > 0n).map(row => [row.unit, parseDecimal(row.available, 12)]));
  const preparationCustodyByUnit = new Map<string, bigint>();
  const deliveryCustodyByUnit = new Map<string, bigint>();
  const stockValue = moneyTotals();
  const knownCostBalanceCount = new Map<string, number>();
  let balanceExceptionCount = balanceGroups.reduce((sum, row) => sum + Number(row.invalidCount), 0);
  for (const row of valuationGroups) {
    addMoney(stockValue, row.currency, BigInt(row.amountMinor));
    if (row.balanceCount > 0n) knownCostBalanceCount.set(row.currency, Number(row.balanceCount));
  }
  const availableBalanceRows = [] as Array<{
    lotId: string; lotLabel: string; skuId: string; locationId: string; custodianId: string;
    unit: string; balanceQuantity: string; reservedQuantity: string; availableQuantity: string;
  }>;
  for (const balance of balances) {
    const unit = balance.unit.trim();
    availableBalanceRows.push({
      lotId: balance.lotId,
      lotLabel: balance.lot.label,
      skuId: balance.lot.skuId,
      locationId: balance.locationId,
      custodianId: balance.custodianId,
      unit: unit || "unknown",
      balanceQuantity: decimalText(balance.quantity),
      reservedQuantity: decimalText(balance.reserved),
      availableQuantity: formatQuantity(parseDecimal(decimalText(balance.quantity), 12) - parseDecimal(decimalText(balance.reserved), 12)),
    });
  }
  type CustodyAggregate = {
    lotId: string; lotLabel: string; skuId: string; sourceLocationId: string; locationBasis: "source-stock-balance";
    custodianId: string | null; custodianBasis: "stock-balance-custodian" | "delivery-assignment-driver" | "unresolved-dispatch-custodian";
    stage: "preparation" | "delivery"; unit: string; quantity: bigint; allocationCount: number;
  };
  const custodyByGroup = new Map<string, CustodyAggregate>();
  let custodyKnownAllocationCount = 0;
  let custodyExceptionCount = 0;
  for (const allocation of allocations) {
    const balance = balanceById.get(allocation.balanceId);
    if (!balance || balance.lotId !== allocation.lotId) {
      custodyExceptionCount += 1;
      continue;
    }
    if (!balance.unit.trim()) {
      custodyExceptionCount += 1;
      continue;
    }
    const quantityText = remainingClubCustody({
      actualQuantity: decimalText(allocation.actualQuantity),
      deliveredQuantity: decimalText(allocation.deliveredQuantity),
      returnedQuantity: decimalText(allocation.returnedQuantity),
      returnedDeliveredQuantity: decimalText(allocation.returnedDeliveredQuantity),
    });
    if (quantityText === null) {
      custodyExceptionCount += 1;
      continue;
    }
    custodyKnownAllocationCount += 1;
    const quantity = parseDecimal(quantityText, 12);
    if (quantity === 0n) continue;
    const assignment = assignmentByOrder.get(allocation.orderId);
    const dispatched = assignment?.dispatchedAt !== null && assignment?.dispatchedAt !== undefined
      || ["dispatched", "partially_returned", "delivered"].includes(allocation.state);
    const stage = dispatched ? "delivery" : "preparation";
    const custodianId = dispatched ? assignment?.driverId ?? null : balance.custodianId;
    const custodianBasis = dispatched
      ? custodianId === null ? "unresolved-dispatch-custodian" as const : "delivery-assignment-driver" as const
      : "stock-balance-custodian" as const;
    if (dispatched && custodianId === null) custodyExceptionCount += 1;
    const unit = balance.unit.trim();
    const key = JSON.stringify([allocation.lotId, balance.locationId, custodianId, custodianBasis, stage, unit]);
    const prior = custodyByGroup.get(key);
    if (prior) {
      prior.quantity += quantity;
      prior.allocationCount += 1;
    } else {
      custodyByGroup.set(key, {
        lotId: allocation.lotId,
        lotLabel: balance.lot.label,
        skuId: balance.lot.skuId,
        sourceLocationId: balance.locationId,
        locationBasis: "source-stock-balance",
        custodianId,
        custodianBasis,
        stage,
        unit,
        quantity,
        allocationCount: 1,
      });
    }
    const stageTotals = stage === "delivery" ? deliveryCustodyByUnit : preparationCustodyByUnit;
    stageTotals.set(unit, (stageTotals.get(unit) ?? 0n) + quantity);
  }
  const custodyRows = [...custodyByGroup.values()]
    .sort((a, b) => JSON.stringify([a.lotId, a.sourceLocationId, a.custodianId, a.stage, a.unit]).localeCompare(JSON.stringify([b.lotId, b.sourceLocationId, b.custodianId, b.stage, b.unit])))
    .map(row => ({ ...row, quantity: formatQuantity(row.quantity) }));
  const custodyQueryComplete = allocations.length === allocationCount && deliveryAssignments.length === deliveryAssignmentCount;
  const custodyMetricsCalculated = custodyQueryComplete && custodyExceptionCount === 0;
  const custodyState = custodyExceptionCount > 0 || !custodyQueryComplete ? "partial" : allocationCount === 0 ? "unknown" : "unverified";
  const physicalClubStockByUnit = new Map(onHandByUnit);
  if (custodyMetricsCalculated) {
    for (const custodyByUnit of [preparationCustodyByUnit, deliveryCustodyByUnit]) {
      for (const [unit, quantity] of custodyByUnit) physicalClubStockByUnit.set(unit, (physicalClubStockByUnit.get(unit) ?? 0n) + quantity);
    }
  }
  const balanceCoverage = balanceExceptionCount > 0
    ? partialCoverage("current-stock-balance-aggregates", Math.max(0, balanceCount - balanceExceptionCount), balanceCount, "invalid-balance-values-or-missing-unit")
    : coverage("current-stock-balance-aggregates", balanceCount, balanceCount);
  const balanceRowsCoverage = coverage("visible-current-stock-balance-rows", balances.length, balanceCount);
  const custodyCoverage = !custodyQueryComplete
    ? partialCoverage("preparation-delivery-custody", custodyKnownAllocationCount, allocationCount, "visible-allocation-or-dispatch-limit-reached")
    : custodyExceptionCount > 0
      ? partialCoverage("preparation-delivery-custody", custodyKnownAllocationCount, allocationCount, "invalid-allocation-or-unresolved-dispatch-custodian")
      : coverage("preparation-delivery-custody", custodyKnownAllocationCount, allocationCount);
  const stockMovementInvalidCount = stockMovementGroups.reduce((sum, row) => sum + Number(row.invalidCount), 0);
  const stockMovementSummary = {
    invalidCount: stockMovementInvalidCount,
    byKindAndUnit: stockMovementGroups.filter(row => row.validCount > 0n).map(row => ({
      kind: row.kind,
      meaning: row.kind === "waste" ? "positive-waste-quantity"
        : row.kind === "count_adjustment" ? "signed-count-difference"
          : row.kind === "transfer" || row.kind === "transfer_internal" ? "internal-transfer-flow-not-club-wide-loss"
            : "other-recorded-stock-fact",
      unit: row.unit,
      eventCount: Number(row.validCount),
      recordedQuantity: formatQuantity(parseDecimal(row.quantity, 12)),
    })),
  };
  const stockMovementCoverage = stockMovementSummary.invalidCount > 0
    ? partialCoverage("dated-stock-fact-aggregates", Math.max(0, stockFactCount - stockMovementSummary.invalidCount), stockFactCount, "invalid-stock-fact-unit-or-kind-specific-quantity")
    : coverage("dated-stock-fact-aggregates", stockFactCount, stockFactCount);
  const stockFactRowsCoverage = coverage("visible-dated-stock-fact-rows", stockFacts.length, stockFactCount);
  const allowedLocations = scope.locationIds === undefined ? null : new Set(scope.locationIds);
  const allowedCustodians = scope.custodianIds === undefined ? null : new Set(scope.custodianIds);
  const stockMovementEvents = stockFacts.map(fact => {
    const fromLocationInsideScope = fact.fromLocationId === null || allowedLocations === null || allowedLocations.has(fact.fromLocationId);
    const toLocationInsideScope = fact.toLocationId === null || allowedLocations === null || allowedLocations.has(fact.toLocationId);
    const fromCustodianInsideScope = fact.fromCustodianId === null || allowedCustodians === null || allowedCustodians.has(fact.fromCustodianId);
    const toCustodianInsideScope = fact.toCustodianId === null || allowedCustodians === null || allowedCustodians.has(fact.toCustodianId);
    return {
      lotId: fact.lotId,
      kind: fact.kind,
      quantity: decimalText(fact.quantity),
      unit: fact.unit,
      fromLocationId: fromLocationInsideScope ? fact.fromLocationId : null,
      toLocationId: toLocationInsideScope ? fact.toLocationId : null,
      fromCustodianId: fromCustodianInsideScope ? fact.fromCustodianId : null,
      toCustodianId: toCustodianInsideScope ? fact.toCustodianId : null,
      outsideScopeEndpoint: !fromLocationInsideScope || !toLocationInsideScope || !fromCustodianInsideScope || !toCustodianInsideScope,
      occurredAt: fact.occurredAt.toISOString(),
    };
  });
  const historicalQuantity = new Map(observationGroups.map(observation => [observation.unit, BigInt(observation.quantityMilliunits)]));
  const decimalMap = (map: Map<string, bigint>) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([unit, scaled]) => ({ unit, quantity: formatQuantity(scaled) }));
  return queryEnvelope("inventory", range, {
    current: {
      balanceRows: balanceCount,
      visibleBalanceRows: balances.length,
      balanceRowsState: balances.length === balanceCount ? "complete" : "partial-visible-row-limit",
      lotCount: Number(lotGroups[0]?.lotCount ?? 0n),
      activeReservationCount: reservationCount,
      availableBalancesByLotLocationCustodian: availableBalanceRows,
      balanceOnHandByUnit: decimalMap(onHandByUnit),
      reservedByUnit: decimalMap(reservedByUnit),
      availableByUnit: decimalMap(availableByUnit),
      preparationDeliveryCustodyByLotLocationCustodian: custodyRows,
      preparationCustodyByUnit: custodyMetricsCalculated ? decimalMap(preparationCustodyByUnit) : null,
      deliveryCustodyByUnit: custodyMetricsCalculated ? decimalMap(deliveryCustodyByUnit) : null,
      physicalClubStockByUnit: custodyMetricsCalculated ? decimalMap(physicalClubStockByUnit) : null,
      custodySummaryState: custodyMetricsCalculated ? "calculated-from-complete-source" : "not-calculated-source-incomplete-or-invalid",
      visibleCustodyRows: custodyRows.length,
      custodyRowsState: custodyQueryComplete ? "complete" : "partial-visible-row-limit",
      physicalCustodyFormula: "actualQuantity - deliveredQuantity - (returnedQuantity - returnedDeliveredQuantity)",
      custodyLocationBasis: "source StockBalance.locationId; current route location is not modeled",
      custodyState,
      custodyAllocationCount: allocationCount,
      custodyKnownAllocationCount: custodyQueryComplete ? custodyKnownAllocationCount : null,
      custodyExceptionCount: custodyQueryComplete ? custodyExceptionCount : null,
      balanceExceptionCount,
      stockValuationByCostCurrencyMinor: asMoneyBuckets(stockValue),
      valuationBalancesByCurrency: [...knownCostBalanceCount].sort(([a], [b]) => a.localeCompare(b)).map(([currency, count]) => ({ currency, count })),
      stockMovementEvents,
      stockMovementEventRowsVisible: stockFacts.length,
      stockMovementEventRowsState: stockFacts.length === stockFactCount ? "complete" : "partial-visible-row-limit",
      stockMovementEventsByKindAndUnit: stockMovementSummary.byKindAndUnit,
      stockMovementEventCount: stockFactCount,
      stockMovementExceptionCount: stockMovementSummary.invalidCount,
      stockMovementSemantics: {
        waste: "positive physical loss; not a count adjustment",
        count_adjustment: "signed difference between recorded and counted balance",
        transfer: "internal flow between locations/custodians; not a club-wide loss",
        transfer_internal: "internal flow between locations/custodians; not a club-wide loss",
        other: "raw kind and quantity are preserved without inferred semantics",
      },
    },
    historicalObservations: {
      observationCount,
      quantityMilliunitsByUnit: [...historicalQuantity].sort(([a], [b]) => a.localeCompare(b)).map(([unit, quantityMilliunits]) => ({ unit, quantityMilliunits: quantityMilliunits.toString() })),
      stockoutCount: stockoutCount,
      currency: "not-applicable",
    },
    channelsCombined: false,
  }, [
    balanceCoverage,
    balanceRowsCoverage,
    custodyCoverage,
    stockMovementCoverage,
    stockFactRowsCoverage,
    ...(scope.locationIds === undefined ? [coverage("historical-stock-observations", observationCount, observationCount)] : [excludedCoverage("historical-stock-observations", "historical-history-empty-for-scoped-period")]),
  ]);
}

function formatQuantity(scaled: bigint): string {
  const negative = scaled < 0n;
  const absolute = negative ? -scaled : scaled;
  const scale = 10n ** 12n;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(12, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

async function cashLedger(range: ReportDateRange, scope: ReportScope) {
  const eventRange = timestampFilter(range);
  const legacyRange = dateOnlyFilter(range);
  const accountWhere = { active: true, ...(scope.accountIds !== undefined ? { id: { in: scope.accountIds } } : {}) };
  const accountIdsWhere = scope.accountIds !== undefined ? { in: scope.accountIds } : undefined;
  const legWhere = { ...(accountIdsWhere ? { accountId: accountIdsWhere } : {}), ...(Object.keys(eventRange).length ? { event: { occurredAt: eventRange } } : {}) };
  const reconciliationWhere = { ...(accountIdsWhere ? { accountId: accountIdsWhere } : {}), ...(range.to ? { date: { lte: range.to } } : {}) };
  const eventJoinPredicates: Prisma.Sql[] = [];
  if (eventRange.gte) eventJoinPredicates.push(Prisma.sql`e."occurredAt" >= ${rawSqlUtcTimestamp(eventRange.gte)}`);
  if (eventRange.lt) eventJoinPredicates.push(Prisma.sql`e."occurredAt" < ${rawSqlUtcTimestamp(eventRange.lt)}`);
  const movementScopePredicate = scope.accountIds === undefined
    ? Prisma.empty
    : scope.accountIds.length
      ? Prisma.sql`AND a."id" IN (${Prisma.join(scope.accountIds)})`
      : Prisma.sql`AND FALSE`;
  type AccountMovement = {
    accountId: string;
    kind: string;
    currency: string;
    verified: boolean;
    openingApproved: boolean;
    periodNetMinor: string;
    legCount: bigint;
    currencyMismatchCount: bigint;
  };
  const [accountCount, accounts, legCount, movements, reconciliationCount, historicalAggregate] = await Promise.all([
    reportDb().operationAccount.count({ where: accountWhere }),
    reportDb().operationAccount.findMany({ where: accountWhere, select: { id: true, currency: true, kind: true, verified: true, openingApprovedBy: true }, orderBy: [{ currency: "asc" }, { kind: "asc" }, { id: "asc" }], take: REPORT_ROW_LIMIT }),
    reportDb().ledgerLeg.count({ where: legWhere }),
    reportDb().$queryRaw<AccountMovement[]>(Prisma.sql`
      SELECT a."id" AS "accountId", a."kind", a."currency", a."verified",
        (a."openingApprovedBy" IS NOT NULL) AS "openingApproved",
        COALESCE(SUM(l."amountMinor") FILTER (WHERE e."id" IS NOT NULL AND l."currency" = a."currency"), 0)::text AS "periodNetMinor",
        COUNT(l."id") FILTER (WHERE e."id" IS NOT NULL) AS "legCount",
        COUNT(l."id") FILTER (WHERE e."id" IS NOT NULL AND l."currency" <> a."currency") AS "currencyMismatchCount"
      FROM "OperationAccount" AS a
      LEFT JOIN "LedgerLeg" AS l ON l."accountId" = a."id"
      LEFT JOIN "LedgerEvent" AS e ON e."id" = l."eventId"
        ${eventJoinPredicates.length ? Prisma.sql`AND ${Prisma.join(eventJoinPredicates, " AND ")}` : Prisma.empty}
      WHERE a."active" = TRUE ${movementScopePredicate}
      GROUP BY a."id", a."kind", a."currency", a."verified", a."openingApprovedBy"
      ORDER BY a."id" ASC
    `),
    reportDb().accountReconciliation.count({ where: reconciliationWhere }),
    scope.accountIds === undefined
      ? reportDb().historicalCashMovement.aggregate({
          where: Object.keys(legacyRange).length ? { movementDate: legacyRange } : {},
          _count: { _all: true },
          _sum: { amountCents: true },
        })
      : Promise.resolve({ _count: { _all: 0 }, _sum: { amountCents: null } }),
  ]);
  const movementByAccount = new Map(movements.map(row => [row.accountId, row]));
  const visibleAccountIds = accounts.map(account => account.id);
  const reconciliationPredicates: Prisma.Sql[] = [];
  if (visibleAccountIds.length) reconciliationPredicates.push(Prisma.sql`"accountId" IN (${Prisma.join(visibleAccountIds)})`);
  else reconciliationPredicates.push(Prisma.sql`FALSE`);
  if (range.to) reconciliationPredicates.push(Prisma.sql`"date" <= ${range.to}`);
  type LatestReconciliation = { accountId: string; date: string; countedMinor: bigint };
  const reconciliations = visibleAccountIds.length
    ? await reportDb().$queryRaw<LatestReconciliation[]>(Prisma.sql`
        SELECT DISTINCT ON ("accountId") "accountId", "date", "countedMinor"
        FROM "AccountReconciliation"
        WHERE ${Prisma.join(reconciliationPredicates, " AND ")}
        ORDER BY "accountId" ASC, "date" DESC, "createdAt" DESC, "id" DESC
      `)
    : [];
  const latestReconciliation = new Map(reconciliations.map(row => [row.accountId, { date: row.date, countedMinor: row.countedMinor }]));
  let clubCurrencyMismatchCount = 0;
  let custodyCurrencyMismatchCount = 0;
  const clubBalances = moneyTotals();
  const custodyBalances = moneyTotals();
  for (const movement of movements) {
    if (!movement.verified || !movement.openingApproved) continue;
    const mismatchCount = Number(movement.currencyMismatchCount);
    if (movement.kind === "custody") custodyCurrencyMismatchCount += mismatchCount;
    else clubCurrencyMismatchCount += mismatchCount;
    if (mismatchCount) continue;
    addMoney(movement.kind === "custody" ? custodyBalances : clubBalances, movement.currency, BigInt(movement.periodNetMinor));
  }
  const accountRows = accounts.map(account => {
    const reconciliation = latestReconciliation.get(account.id);
    const trustworthy = account.verified && account.openingApprovedBy !== null;
    const movement = movementByAccount.get(account.id);
    const movementValid = movement !== undefined && Number(movement.currencyMismatchCount) === 0;
    return {
      accountId: account.id,
      currency: account.currency,
      kind: account.kind,
      verified: account.verified,
      openingApproved: account.openingApprovedBy !== null,
      periodNetMovementMinor: trustworthy && movementValid ? (movement?.periodNetMinor ?? "0") : null,
      periodMovementState: !trustworthy ? "not-calculated-account-not-verified" : !movementValid ? "not-calculated-currency-mismatch" : "calculated-from-complete-ledger-aggregate",
      latestCountedBalanceMinor: trustworthy && reconciliation ? reconciliation.countedMinor.toString() : null,
      reconciledThrough: trustworthy ? reconciliation?.date ?? null : null,
      custodyIsClubSpendable: account.kind !== "custody",
    };
  });
  const historicalUnknownCurrency = moneyTotals();
  if (historicalAggregate._sum.amountCents !== null) addMoney(historicalUnknownCurrency, null, historicalAggregate._sum.amountCents);
  const historicalCount = historicalAggregate._count._all;
  return queryEnvelope("cash-ledger", range, {
    accounts: accountRows,
    clubAccountPeriodNetMovementByCurrency: clubCurrencyMismatchCount ? null : asMoneyBuckets(clubBalances),
    custodyAccountPeriodNetMovementByCurrency: custodyCurrencyMismatchCount ? null : asMoneyBuckets(custodyBalances),
    movementAggregationState: {
      club: clubCurrencyMismatchCount ? "not-calculated-ledger-leg-currency-does-not-match-account" : "calculated-from-complete-sql-aggregation",
      custody: custodyCurrencyMismatchCount ? "not-calculated-ledger-leg-currency-does-not-match-account" : "calculated-from-complete-sql-aggregation",
      clubCurrencyMismatchCount,
      custodyCurrencyMismatchCount,
    },
    historicalMovementByCurrency: scope.accountIds === undefined ? asMoneyBuckets(historicalUnknownCurrency) : null,
    historicalMovementCount: scope.accountIds === undefined ? historicalCount : null,
    historicalMovementState: scope.accountIds === undefined ? "unlinked-source-account-currency-unknown" : "excluded-by-account-scope",
    historicalCurrencyStatus: "unknown-in-source-schema",
    ledgerLegRows: legCount,
    movementSemantics: "signed-net-movement-in-selected-period; not-a-reconciled-current-balance",
    currenciesCombined: false,
  }, [coverage("active-accounts", accounts.length, accountCount), coverage("dated-ledger-legs", legCount, legCount), coverage("account-reconciliations", reconciliationCount, reconciliationCount), ...(scope.accountIds === undefined ? [coverage("historical-cash-movements", historicalCount, historicalCount)] : [excludedCoverage("historical-cash-movements", "historical-cash-movements-have-no-account-currency-crosswalk")])]);
}

async function deliveryCollections(range: ReportDateRange) {
  const timestampRange = timestampFilter(range);
  const collectionPredicates: Prisma.Sql[] = [];
  if (timestampRange.gte) collectionPredicates.push(Prisma.sql`c."verifiedAt" >= ${rawSqlUtcTimestamp(timestampRange.gte)}`);
  if (timestampRange.lt) collectionPredicates.push(Prisma.sql`c."verifiedAt" < ${rawSqlUtcTimestamp(timestampRange.lt)}`);
  const renditionPredicates: Prisma.Sql[] = [];
  if (timestampRange.gte) renditionPredicates.push(Prisma.sql`r."acceptedAt" >= ${rawSqlUtcTimestamp(timestampRange.gte)}`);
  if (timestampRange.lt) renditionPredicates.push(Prisma.sql`r."acceptedAt" < ${rawSqlUtcTimestamp(timestampRange.lt)}`);
  type CountByStatus = { status: string; rowCount: bigint };
  type CollectionAggregate = {
    currency: string; status: string; rowCount: bigint; reportedMinor: string;
    appliedMinor: string; excessMinor: string; custodyCount: bigint;
  };
  type RenditionAggregate = { currency: string; rowCount: bigint; grossMinor: string; deliveredMinor: string; feeMinor: string };
  type CreditAggregate = {
    treatment: string; currency: string; rowCount: bigint; reversedCount: bigint; unclassifiedCount: bigint; invalidCount: bigint;
    spendableOpenCount: bigint; spendableOpenMinor: string; refundDueOpenCount: bigint; refundDueOpenMinor: string;
  };
  const [deliveryGroups, collectionGroups, renditionGroups, creditGroups] = await Promise.all([
    reportDb().deliveryAssignment.groupBy({ by: ["status"], _count: { _all: true }, orderBy: { status: "asc" } }),
    reportDb().$queryRaw<CollectionAggregate[]>(Prisma.sql`
      SELECT c."currency", c."status", COUNT(*) AS "rowCount",
        COALESCE(SUM(c."amountMinor"), 0)::text AS "reportedMinor",
        COALESCE(SUM(CASE WHEN c."status" = 'verified' THEN c."appliedMinor" ELSE 0 END), 0)::text AS "appliedMinor",
        COALESCE(SUM(CASE WHEN c."status" = 'verified' THEN c."excessMinor" ELSE 0 END), 0)::text AS "excessMinor",
        COUNT(*) FILTER (WHERE c."custodianId" IS NOT NULL) AS "custodyCount"
      FROM "CollectionReport" AS c
      ${collectionPredicates.length ? Prisma.sql`WHERE ${Prisma.join(collectionPredicates, " AND ")}` : Prisma.empty}
      GROUP BY c."currency", c."status"
      ORDER BY c."currency", c."status"
    `),
    reportDb().$queryRaw<RenditionAggregate[]>(Prisma.sql`
      SELECT r."currency", COUNT(*) AS "rowCount",
        COALESCE(SUM(r."grossMinor"), 0)::text AS "grossMinor",
        COALESCE(SUM(r."deliveredMinor"), 0)::text AS "deliveredMinor",
        COALESCE(SUM(r."feeMinor"), 0)::text AS "feeMinor"
      FROM "Rendition" AS r
      ${renditionPredicates.length ? Prisma.sql`WHERE ${Prisma.join(renditionPredicates, " AND ")}` : Prisma.empty}
      GROUP BY r."currency"
      ORDER BY r."currency"
    `),
    reportDb().$queryRaw<CreditAggregate[]>(Prisma.sql`
      SELECT c."treatment", c."currency", COUNT(*) AS "rowCount",
        COUNT(*) FILTER (WHERE c."treatment" = 'reversed') AS "reversedCount",
        COUNT(*) FILTER (WHERE c."treatment" NOT IN ('reversed', 'member_credit', 'refund_due')) AS "unclassifiedCount",
        COUNT(*) FILTER (WHERE c."treatment" IN ('member_credit', 'refund_due') AND
          (c."currency" NOT IN ('ARS', 'USD') OR c."amountMinor" < 0 OR c."resolvedMinor" < 0 OR c."resolvedMinor" > c."amountMinor")) AS "invalidCount",
        COUNT(*) FILTER (WHERE c."treatment" = 'member_credit' AND c."currency" IN ('ARS', 'USD') AND
          c."amountMinor" >= 0 AND c."resolvedMinor" >= 0 AND c."resolvedMinor" <= c."amountMinor" AND c."amountMinor" > c."resolvedMinor") AS "spendableOpenCount",
        COALESCE(SUM(c."amountMinor" - c."resolvedMinor") FILTER (WHERE c."treatment" = 'member_credit' AND c."currency" IN ('ARS', 'USD') AND
          c."amountMinor" >= 0 AND c."resolvedMinor" >= 0 AND c."resolvedMinor" <= c."amountMinor" AND c."amountMinor" > c."resolvedMinor"), 0)::text AS "spendableOpenMinor",
        COUNT(*) FILTER (WHERE c."treatment" = 'refund_due' AND c."currency" IN ('ARS', 'USD') AND
          c."amountMinor" >= 0 AND c."resolvedMinor" >= 0 AND c."resolvedMinor" <= c."amountMinor" AND c."amountMinor" > c."resolvedMinor") AS "refundDueOpenCount",
        COALESCE(SUM(c."amountMinor" - c."resolvedMinor") FILTER (WHERE c."treatment" = 'refund_due' AND c."currency" IN ('ARS', 'USD') AND
          c."amountMinor" >= 0 AND c."resolvedMinor" >= 0 AND c."resolvedMinor" <= c."amountMinor" AND c."amountMinor" > c."resolvedMinor"), 0)::text AS "refundDueOpenMinor"
      FROM "MemberCredit" AS c
      GROUP BY c."treatment", c."currency"
      ORDER BY c."treatment", c."currency"
    `),
  ]);
  const deliveryCount = deliveryGroups.reduce((sum, row) => sum + row._count._all, 0);
  const collectionCount = collectionGroups.reduce((sum, row) => sum + Number(row.rowCount), 0);
  const renditionCount = renditionGroups.reduce((sum, row) => sum + Number(row.rowCount), 0);
  const memberCreditCount = creditGroups.reduce((sum, row) => sum + Number(row.rowCount), 0);
  const reported = moneyTotals();
  const verifiedApplied = moneyTotals();
  const excess = moneyTotals();
  const renditionGross = moneyTotals();
  const renditionDelivered = moneyTotals();
  const renditionFee = moneyTotals();
  let collectionCustodyCount = 0;
  const collectionStatusCounts = new Map<string, number>();
  for (const row of collectionGroups) {
    addMoney(reported, row.currency, BigInt(row.reportedMinor));
    addMoney(verifiedApplied, row.currency, BigInt(row.appliedMinor));
    addMoney(excess, row.currency, BigInt(row.excessMinor));
    collectionCustodyCount += Number(row.custodyCount);
    collectionStatusCounts.set(row.status, (collectionStatusCounts.get(row.status) ?? 0) + Number(row.rowCount));
  }
  for (const row of renditionGroups) {
    addMoney(renditionGross, row.currency, BigInt(row.grossMinor));
    addMoney(renditionDelivered, row.currency, BigInt(row.deliveredMinor));
    addMoney(renditionFee, row.currency, BigInt(row.feeMinor));
  }
  const spendableOpen = moneyTotals();
  const refundDueOpen = moneyTotals();
  let spendableOpenCount = 0;
  let refundDueOpenCount = 0;
  let reversedCount = 0;
  let unclassifiedCount = 0;
  let invalidCount = 0;
  for (const row of creditGroups) {
    addMoney(spendableOpen, row.currency, BigInt(row.spendableOpenMinor));
    addMoney(refundDueOpen, row.currency, BigInt(row.refundDueOpenMinor));
    spendableOpenCount += Number(row.spendableOpenCount);
    refundDueOpenCount += Number(row.refundDueOpenCount);
    reversedCount += Number(row.reversedCount);
    unclassifiedCount += Number(row.unclassifiedCount);
    invalidCount += Number(row.invalidCount);
  }
  const openCreditBalances = {
    spendableMemberCreditOpenByCurrency: asMoneyBuckets(spendableOpen),
    refundDueOpenByCurrency: asMoneyBuckets(refundDueOpen),
    spendableOpenCount,
    refundDueOpenCount,
    reversedCount,
    unclassifiedCount,
    invalidCount,
  };
  const recognizedCreditRows = memberCreditCount - unclassifiedCount - invalidCount;
  const creditCoverage = openCreditBalances.unclassifiedCount + openCreditBalances.invalidCount > 0
    ? partialCoverage("member-credit-current-balances", recognizedCreditRows, memberCreditCount, "unclassified-treatment-or-invalid-credit-balance")
    : coverage("member-credit-current-balances", memberCreditCount, memberCreditCount);
  return queryEnvelope("delivery-collections", range, {
    deliveryLifecycleCounts: deliveryGroups.map(row => ({ key: row.status, count: row._count._all })),
    deliveryCount,
    collectionReportCount: collectionCount,
    collectionStatusCounts: [...collectionStatusCounts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => ({ key, count })),
    reportedCollectionByCurrency: asMoneyBuckets(reported),
    verifiedAppliedCollectionByCurrency: asMoneyBuckets(verifiedApplied),
    verifiedExcessByCurrency: asMoneyBuckets(excess),
    collectionReportsWithCustodyIdentity: collectionCustodyCount,
    acceptedRenditionCount: renditionCount,
    renditionGrossByCurrency: asMoneyBuckets(renditionGross),
    renditionDeliveredByCurrency: asMoneyBuckets(renditionDelivered),
    renditionFeeByCurrency: asMoneyBuckets(renditionFee),
    ...openCreditBalances,
    creditBalanceBasis: "current-unsettled-credit-records; independent-of-selected-date-range",
    historicalDeliveryFactsRemainSeparate: true,
  }, [coverage("delivery-assignments", deliveryCount, deliveryCount), coverage("collection-reports", collectionCount, collectionCount), coverage("accepted-renditions", renditionCount, renditionCount), creditCoverage]);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type FxLedgerEventRow = {
  id: string;
  occurredAt: Date;
  metadata: unknown;
  legs: Array<{ accountId: string; currency: string; amountMinor: bigint }>;
};

/** Keeps each signed ledger leg and event-level recorded FX metadata separate; it never nets currencies. */
export function summarizeFxLedgerEvents(events: readonly FxLedgerEventRow[], accountScoped = false) {
  return events.map(event => {
    const metadata = record(event.metadata);
    const rate = typeof metadata.rate === "string" ? metadata.rate : null;
    let validRate = false;
    if (rate) {
      try { validRate = parseDecimal(rate, 12) > 0n; } catch { validRate = false; }
    }
    const difference = typeof metadata.differenceMinor === "string" && /^-?(0|[1-9]\d*)$/.test(metadata.differenceMinor)
      ? metadata.differenceMinor : null;
    const commission = typeof metadata.commissionMinor === "string" && /^(0|[1-9]\d*)$/.test(metadata.commissionMinor)
      ? metadata.commissionMinor : null;
    const expectedLegCount = commission === null ? null : BigInt(commission) > 0n ? 3 : 2;
    const currencies = new Set(event.legs.map(leg => leg.currency));
    const legsValid = event.legs.every(leg => leg.accountId.length > 0 && leg.currency.length > 0 && leg.amountMinor !== 0n);
    const metadataValid = validRate && difference !== null && commission !== null;
    const complete = !accountScoped && metadataValid && legsValid && expectedLegCount === event.legs.length && currencies.size >= 2;
    const state = complete ? "unverified" as const : "partial" as const;
    const reason = complete ? "recorded-event-metadata-and-all-expected-legs-observed"
      : accountScoped ? "account-scope-withholds-unrelated-ledger-legs"
        : !metadataValid ? "fx-event-metadata-missing-or-invalid"
          : !legsValid || expectedLegCount !== event.legs.length || currencies.size < 2 ? "fx-event-legs-incomplete-or-inconsistent"
            : "fx-event-incomplete";
    return {
      eventId: event.id,
      occurredAt: event.occurredAt.toISOString(),
      recordedRate: !accountScoped && validRate ? rate : null,
      difference: !accountScoped && difference !== null ? { currency: "ARS", minor: difference } : null,
      commission: !accountScoped && commission !== null ? { minor: commission, currency: null, currencyState: "not-recorded-with-event-metadata" } : null,
      evidencePresent: metadata.evidence !== null && typeof metadata.evidence === "object",
      legs: event.legs.map(leg => ({
        accountId: leg.accountId,
        currency: leg.currency,
        signedMinor: leg.amountMinor.toString(),
        direction: leg.amountMinor < 0n ? "debit" as const : "credit" as const,
      })),
      coverage: { observedLegCount: event.legs.length, expectedLegCount, state, reason },
    };
  });
}

async function fxReconciliation(range: ReportDateRange, scope: ReportScope) {
  const timeRange = timestampFilter(range);
  const accountIdsWhere = scope.accountIds !== undefined ? { in: scope.accountIds } : undefined;
  const where = {
    kind: "fx",
    ...(Object.keys(timeRange).length ? { occurredAt: timeRange } : {}),
    ...(accountIdsWhere ? { legs: { some: { accountId: accountIdsWhere } } } : {}),
  };
  const summaryPredicates: Prisma.Sql[] = [Prisma.sql`e."kind" = 'fx'`];
  if (timeRange.gte) summaryPredicates.push(Prisma.sql`e."occurredAt" >= ${rawSqlUtcTimestamp(timeRange.gte)}`);
  if (timeRange.lt) summaryPredicates.push(Prisma.sql`e."occurredAt" < ${rawSqlUtcTimestamp(timeRange.lt)}`);
  const [eventCount, events, summaryRows] = await Promise.all([
    reportDb().ledgerEvent.count({ where }),
    reportDb().ledgerEvent.findMany({ where, select: { id: true, occurredAt: true, metadata: true, legs: { where: accountIdsWhere ? { accountId: accountIdsWhere } : {}, select: { accountId: true, currency: true, amountMinor: true } } }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take: FX_DETAIL_ROW_LIMIT }),
    scope.accountIds === undefined ? reportDb().$queryRaw<Array<{ eventCount: bigint; completeCount: bigint }>>(Prisma.sql`
      WITH event_legs AS (
        SELECT e."id", e."metadata",
          COUNT(l."id")::bigint AS observed_leg_count,
          COUNT(DISTINCT l."currency")::bigint AS currency_count,
          COALESCE(BOOL_AND(l."accountId" <> '' AND l."currency" <> '' AND l."amountMinor" <> 0), TRUE) AS legs_valid
        FROM "LedgerEvent" AS e
        LEFT JOIN "LedgerLeg" AS l ON l."eventId" = e."id"
        WHERE ${Prisma.join(summaryPredicates, " AND ")}
        GROUP BY e."id"
      ), event_metadata AS (
        SELECT e."id",
          COALESCE(CASE WHEN jsonb_typeof(e."metadata"->'rate') = 'string' THEN
            CASE WHEN e."metadata"->>'rate' ~ '^[+-]?[0-9]+([.][0-9]+)?$'
              AND length(regexp_replace(split_part(regexp_replace(e."metadata"->>'rate', '^[+-]', ''), '.', 1), '^0+', '')) <= 26
              AND (length(split_part(regexp_replace(e."metadata"->>'rate', '^[+-]', ''), '.', 2)) <= 12
                OR substring(split_part(regexp_replace(e."metadata"->>'rate', '^[+-]', ''), '.', 2) FROM 13) !~ '[1-9]')
              AND e."metadata"->>'rate' !~ '^-' AND e."metadata"->>'rate' ~ '[1-9]'
              THEN TRUE ELSE FALSE END
            ELSE FALSE END, FALSE) AS rate_valid,
          COALESCE(jsonb_typeof(e."metadata"->'differenceMinor') = 'string'
            AND e."metadata"->>'differenceMinor' ~ '^-?(0|[1-9][0-9]*)$', FALSE) AS difference_valid,
          COALESCE(jsonb_typeof(e."metadata"->'commissionMinor') = 'string'
            AND e."metadata"->>'commissionMinor' ~ '^(0|[1-9][0-9]*)$', FALSE) AS commission_valid,
          e."metadata"->>'commissionMinor' AS commission_text,
          e.observed_leg_count,
          e.currency_count,
          e.legs_valid
        FROM event_legs AS e
      )
      SELECT COUNT(*)::bigint AS "eventCount",
        COUNT(*) FILTER (WHERE structurally_complete)::bigint AS "completeCount"
      FROM (
        SELECT m."id",
          m.rate_valid AND m.difference_valid AND m.commission_valid
            AND m.legs_valid
            AND m.observed_leg_count = CASE WHEN m.commission_valid THEN CASE WHEN m.commission_text = '0' THEN 2 ELSE 3 END ELSE NULL END
            AND m.currency_count >= 2 AS structurally_complete
        FROM event_metadata AS m
      ) AS event_completeness
    `) : Promise.resolve([]),
  ]);
  const fxEvents = summarizeFxLedgerEvents(events, scope.accountIds !== undefined);
  const summaryRow = summaryRows[0];
  const conversionEventSummaryComplete = scope.accountIds === undefined && summaryRow !== undefined && Number(summaryRow.eventCount) === eventCount;
  const completeCount = conversionEventSummaryComplete ? Number(summaryRow.completeCount) : null;
  const incompleteCount = completeCount === null ? null : eventCount - completeCount;
  const eventRowsComplete = events.length === eventCount;
  return queryEnvelope("fx-reconciliation", range, {
    conversionEventCount: eventCount,
    visibleConversionEventRows: events.length,
    conversionEventDetailLimit: FX_DETAIL_ROW_LIMIT,
    conversionEventRowsComplete: eventRowsComplete,
    conversionEventSummaryComplete,
    validatedPairedConversionCount: completeCount,
    invalidOrIncompleteFxEventCount: incompleteCount,
    accountScopedEventsNotPaired: scope.accountIds !== undefined ? eventCount : null,
    fxEvents,
    source: scope.accountIds === undefined ? "LedgerEvent(kind=fx) with unaggregated signed LedgerLegs and recorded ForeignExchangeRecorded metadata" : "authorized LedgerLeg observations; paired event details are withheld by account scope",
  }, [coverage("fx-ledger-events", events.length, eventCount), {
    source: "fx-events-with-complete-recorded-legs-and-metadata",
    knownCount: conversionEventSummaryComplete ? completeCount : null,
    expectedCount: conversionEventSummaryComplete ? eventCount : null,
    queryComplete: conversionEventSummaryComplete,
    state: !conversionEventSummaryComplete || (incompleteCount !== null && incompleteCount > 0) ? "partial" : "unverified",
    reason: scope.accountIds !== undefined ? "account-scoped-cross-currency-legs-are-intentionally-withheld"
      : !conversionEventSummaryComplete ? "full-population-fx-summary-not-computed"
        : incompleteCount === 0 ? "all-events-were-summarized-and-have-the-expected-legs; source-period-completeness-is-not-attested"
          : "one-or-more-fx-events-have-incomplete-legs-or-metadata",
  }]);
}

async function customerSegmentation(range: ReportDateRange, scope: ReportScope) {
  const dateRange = dateOnlyFilter(range);
  const memberWhere = scope.memberIds !== undefined ? { id: { in: scope.memberIds } } : {};
  const segmentationQuery = customerSegmentationQueryContract(range, scope);
  const { asOfDate: throughDate } = segmentationQuery;
  const memberScopePredicate = scope.memberIds === undefined ? Prisma.sql`TRUE`
    : scope.memberIds.length ? Prisma.sql`m."id" IN (${Prisma.join(scope.memberIds)})` : Prisma.sql`FALSE`;
  const orderPopulationPredicates: Prisma.Sql[] = [
    Prisma.sql`o."commercialState" = 'confirmed'`,
    Prisma.sql`o."fulfillmentState" <> 'cancelled'`,
    Prisma.sql`o."confirmedAt" IS NOT NULL`,
    Prisma.sql`o."confirmedAt" < ${rawSqlUtcTimestamp(reportCivilDateStartUtc(addDays(throughDate, 1)))}`,
  ];
  if (scope.memberIds !== undefined) {
    orderPopulationPredicates.push(scope.memberIds.length
      ? Prisma.sql`o."memberId" IN (${Prisma.join(scope.memberIds)})`
      : Prisma.sql`FALSE`);
  }
  const orderPredicates = [
    ...orderPopulationPredicates,
    Prisma.sql`NOT (COALESCE(o."quote"->>'source', '') = 'appsheet-invoice' AND COALESCE(o."quote"->>'totalCalculationState', '') <> 'defined')`,
  ];
  const pendingOrderPredicates = [
    ...orderPopulationPredicates,
    Prisma.sql`COALESCE(o."quote"->>'source', '') = 'appsheet-invoice' AND COALESCE(o."quote"->>'totalCalculationState', '') <> 'defined'`,
  ];
  const [memberCount, members, orderCountRows, orders, summaryRows, unlinkedHistoryCount] = await Promise.all([
    reportDb().operationMember.count({ where: memberWhere }),
    reportDb().operationMember.findMany({ where: memberWhere, select: { id: true }, orderBy: { id: "asc" }, take: REPORT_ROW_LIMIT }),
    reportDb().$queryRaw<Array<{ orderCount: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "orderCount"
      FROM "OperationOrder" AS o
      WHERE ${Prisma.join(orderPredicates, " AND ")}
    `),
    reportDb().$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT o."id"
      FROM "OperationOrder" AS o
      WHERE ${Prisma.join(orderPredicates, " AND ")}
      ORDER BY o."confirmedAt" ASC, o."id" ASC
      LIMIT ${REPORT_ROW_LIMIT}
    `),
    reportDb().$queryRaw<Array<{
      segment: LegacyCustomerSegment;
      memberCount: bigint;
      sourceMemberCount: bigint;
      sourceOrderCount: bigint;
      pendingInvoiceMemberCount: bigint;
      pendingInvoiceOrderCount: bigint;
      returnAllocationCount: bigint;
      invalidReturnAllocationCount: bigint;
      invalidReturnLineCount: bigint;
    }>>(Prisma.sql`
      WITH selected_members AS (
        SELECT m."id"
        FROM "OperationMember" AS m
        WHERE ${memberScopePredicate}
      ), pending_orders AS (
        SELECT o."id", o."memberId"
        FROM "OperationOrder" AS o
        WHERE ${Prisma.join(pendingOrderPredicates, " AND ")}
      ), pending_members AS (
        SELECT DISTINCT o."memberId"
        FROM pending_orders AS o
        JOIN selected_members AS m ON m."id" = o."memberId"
      ), selected_orders AS (
        SELECT o."id", o."memberId", o."currency", o."confirmedAt"
        FROM "OperationOrder" AS o
        WHERE ${Prisma.join(orderPredicates, " AND ")}
      ), selected_lines AS (
        SELECT l."id", l."orderId", l."unit", l."requested", l."cancelled", l."delivered", l."revenueMinor"
        FROM "OperationOrderLine" AS l
        JOIN selected_orders AS o ON o."id" = l."orderId"
      ), return_allocations AS (
        SELECT a."orderId", a."lineId",
          (l."id" IS NULL OR a."actualQuantity" <= 0 OR a."requestedQuantity" <= 0
            OR a."returnedDeliveredQuantity" < 0 OR a."returnedDeliveredQuantity" > a."actualQuantity"
            OR a."returnedDeliveredQuantity" > a."deliveredQuantity") AS invalid,
          CASE WHEN l."id" IS NOT NULL AND a."actualQuantity" > 0 AND a."requestedQuantity" > 0
            AND a."returnedDeliveredQuantity" >= 0 AND a."returnedDeliveredQuantity" <= a."actualQuantity"
            AND a."returnedDeliveredQuantity" <= a."deliveredQuantity"
            THEN trunc(a."requestedQuantity"::numeric * a."returnedDeliveredQuantity"::numeric * 1000000000000::numeric / a."actualQuantity"::numeric)
            ELSE NULL
          END AS returned_billed_scaled
        FROM "PreparationAllocation" AS a
        JOIN selected_orders AS o ON o."id" = a."orderId"
        LEFT JOIN selected_lines AS l ON l."id" = a."lineId" AND l."orderId" = a."orderId"
        WHERE a."returnedDeliveredQuantity" <> 0
      ), returns_by_line AS (
        SELECT "orderId", "lineId", SUM(COALESCE(returned_billed_scaled, 0)) AS returned_billed_scaled
        FROM return_allocations
        GROUP BY "orderId", "lineId"
      ), line_values AS (
        SELECT l."id", l."orderId", l."unit", l."requested", l."cancelled", l."delivered", l."revenueMinor",
          COALESCE(r.returned_billed_scaled, 0) AS returned_billed_scaled,
          l."requested" - l."cancelled" - COALESCE(r.returned_billed_scaled / 1000000000000::numeric, 0) AS retained_quantity,
          (l."requested" <= 0 OR l."cancelled" < 0 OR l."cancelled" > l."requested"
            OR l."delivered" < 0 OR l."delivered" > l."requested"
            OR l."requested" - l."cancelled" - COALESCE(r.returned_billed_scaled / 1000000000000::numeric, 0) < 0
            OR COALESCE(r.returned_billed_scaled / 1000000000000::numeric, 0) > l."delivered") AS invalid_line
        FROM selected_lines AS l
        LEFT JOIN returns_by_line AS r ON r."lineId" = l."id" AND r."orderId" = l."orderId"
      ), order_measures AS (
        SELECT o."id", o."memberId", o."currency",
          (o."confirmedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS purchase_day,
          COALESCE(SUM(l.retained_quantity), 0) AS retained_demand,
          COALESCE(SUM(CASE WHEN l."requested" > 0 AND l.retained_quantity >= 0
            THEN ROUND(l."revenueMinor"::numeric * l.retained_quantity / l."requested"::numeric)
            ELSE 0::numeric END), 0) AS retained_spend_minor,
          COALESCE(BOOL_OR(l."unit" = 'g'), FALSE) AS has_gram_quantity,
          COALESCE(SUM(CASE WHEN l."unit" = 'g'
            THEN GREATEST(l."delivered" * 1000000000000::numeric - l.returned_billed_scaled, 0)
            ELSE 0::numeric END), 0) AS grams_scaled
        FROM selected_orders AS o
        LEFT JOIN line_values AS l ON l."orderId" = o."id"
        GROUP BY o."id", o."memberId", o."currency", o."confirmedAt"
      ), eligible_orders AS (
        SELECT * FROM order_measures WHERE retained_demand > 0
      ), member_profiles AS (
        SELECT "memberId",
          COUNT(*)::bigint AS purchase_count,
          MAX(purchase_day) AS last_purchase_day,
          SUM(retained_spend_minor) FILTER (WHERE "currency" = 'ARS') AS spend_ars_minor,
          COUNT(DISTINCT date_trunc('month', purchase_day))::bigint AS purchase_month_count,
          MAX(grams_scaled) FILTER (WHERE has_gram_quantity) AS max_grams_scaled
        FROM eligible_orders
        GROUP BY "memberId"
      ), classified_members AS (
        SELECT m."id",
          CASE
            WHEN pending."memberId" IS NOT NULL THEN 'insufficient-data'
            WHEN p."memberId" IS NULL THEN 'no-purchase-history'
            WHEN p.spend_ars_minor IS NULL OR p.max_grams_scaled IS NULL THEN 'insufficient-data'
            WHEN (${throughDate}::date - p.last_purchase_day) >= 105 THEN 'recency-priority'
            WHEN p.spend_ars_minor >= 175000000 THEN 'high-spend'
            WHEN p.purchase_month_count >= 6 THEN 'repeat-months'
            WHEN p.max_grams_scaled > 20000000000000 THEN 'large-purchase'
            ELSE 'occasional'
          END AS segment
        FROM selected_members AS m
        LEFT JOIN pending_members AS pending ON pending."memberId" = m."id"
        LEFT JOIN member_profiles AS p ON p."memberId" = m."id"
      ), segment_counts AS (
        SELECT segment, COUNT(*)::bigint AS member_count
        FROM classified_members
        GROUP BY segment
      ), totals AS (
        SELECT (SELECT COUNT(*)::bigint FROM selected_members) AS member_count,
          (SELECT COUNT(*)::bigint FROM selected_orders) AS order_count,
          (SELECT COUNT(*)::bigint FROM pending_members) AS pending_invoice_member_count,
          (SELECT COUNT(*)::bigint FROM pending_orders) AS pending_invoice_order_count,
          (SELECT COUNT(*)::bigint FROM return_allocations) AS return_allocation_count,
          (SELECT COUNT(*) FILTER (WHERE invalid)::bigint FROM return_allocations) AS invalid_return_allocation_count,
          (SELECT COUNT(*) FILTER (WHERE invalid_line)::bigint FROM line_values) AS invalid_return_line_count
      ), segment_names(segment) AS (
        VALUES ('no-purchase-history'), ('recency-priority'), ('high-spend'), ('repeat-months'),
          ('large-purchase'), ('occasional'), ('insufficient-data')
      )
      SELECT s.segment AS "segment", COALESCE(c.member_count, 0)::bigint AS "memberCount",
        t.member_count AS "sourceMemberCount", t.order_count AS "sourceOrderCount",
        t.pending_invoice_member_count AS "pendingInvoiceMemberCount",
        t.pending_invoice_order_count AS "pendingInvoiceOrderCount",
        t.return_allocation_count AS "returnAllocationCount",
        t.invalid_return_allocation_count AS "invalidReturnAllocationCount",
        t.invalid_return_line_count AS "invalidReturnLineCount"
      FROM segment_names AS s
      LEFT JOIN segment_counts AS c ON c.segment = s.segment
      CROSS JOIN totals AS t
      ORDER BY s.segment
    `),
    scope.memberIds === undefined ? reportDb().historicalDeliverySale.count({ where: Object.keys(dateRange).length ? { saleDate: dateRange } : {} }) : Promise.resolve(0),
  ]);
  const orderCount = Number(orderCountRows[0]?.orderCount ?? 0n);
  const summary = summaryRows[0];
  const sourceMemberCount = Number(summary?.sourceMemberCount ?? 0n);
  const sourceOrderCount = Number(summary?.sourceOrderCount ?? 0n);
  const pendingInvoiceMemberCount = Number(summary?.pendingInvoiceMemberCount ?? 0n);
  const pendingInvoiceOrderCount = Number(summary?.pendingInvoiceOrderCount ?? 0n);
  const returnAllocationCount = Number(summary?.returnAllocationCount ?? 0n);
  const invalidReturnAllocationCount = Number(summary?.invalidReturnAllocationCount ?? 0n);
  const invalidReturnLineCount = Number(summary?.invalidReturnLineCount ?? 0n);
  const sourceRowsComplete = summary !== undefined && sourceMemberCount === memberCount && sourceOrderCount === orderCount
    && invalidReturnAllocationCount === 0 && invalidReturnLineCount === 0;
  const segmentationDataComplete = sourceRowsComplete && pendingInvoiceOrderCount === 0;
  const segmentCounts = new Map<LegacyCustomerSegment, number>();
  if (sourceRowsComplete) {
    for (const row of summaryRows) {
      const count = Number(row.memberCount);
      if (count > 0) segmentCounts.set(row.segment, count);
    }
  }
  const minVisibleGroup = 5;
  const returnCoverage = invalidReturnAllocationCount > 0
    ? partialCoverage("customer-return-allocations", Math.max(0, returnAllocationCount - invalidReturnAllocationCount), returnAllocationCount, "invalid-billed-return-ratio")
    : coverage("customer-return-allocations", returnAllocationCount, returnAllocationCount);
  return queryEnvelope("customer-segmentation", range, {
    segmentCounts: sourceRowsComplete ? [...segmentCounts].sort(([a], [b]) => a.localeCompare(b)).map(([segment, count]) => ({ segment, memberCount: count < minVisibleGroup ? null : count, suppressed: count < minVisibleGroup })) : null,
    includedMemberCount: memberCount,
    visibleMemberRows: members.length,
    memberRowsComplete: members.length === memberCount,
    currentOperationOrderCount: orderCount,
    visibleOperationOrderRows: orders.length,
    operationOrderRowsComplete: orders.length === orderCount,
    pendingAppSheetInvoiceMemberCount: pendingInvoiceMemberCount,
    pendingAppSheetInvoiceOrderCount: pendingInvoiceOrderCount,
    segmentationDataComplete,
    segmentationAsOfDate: throughDate,
    memberHistoryBasis: "retained-confirmed-operation-orders-through-as-of-date; cancelled-demand-and-customer-returns-excluded; fromDate-does-not-truncate-lifetime-measures",
    spendBasis: "frozen-line-revenue-prorated-by-retained-billed-quantity; cash-refunds-do-not-subtract-the-same-cancellation-twice",
    unlinkedHistoricalDeliverySaleCount: scope.memberIds === undefined ? unlinkedHistoryCount : null,
    unlinkedHistoricalDeliveryState: scope.memberIds === undefined ? "observed-unlinked" : "excluded-by-member-scope",
    segmentationScope: "analysis-only; never implies loyalty approval, eligibility, or permission",
    spendCurrencyPolicy: "ARS only; USD is excluded and never converted",
    minimumVisibleGroup: minVisibleGroup,
    sourceRowsComplete,
    segmentationSummaryComplete: sourceRowsComplete,
    customerReturnAllocationCount: returnAllocationCount,
    invalidCustomerReturnAllocationCount: invalidReturnAllocationCount,
    invalidCustomerReturnLineCount: invalidReturnLineCount,
  }, [coverage("operation-members", members.length, memberCount), coverage("confirmed-orders-for-segmentation", orders.length, orderCount), returnCoverage, ...(pendingInvoiceOrderCount > 0 ? [partialCoverage("pending-appsheet-invoice-segmentation-inputs", 0, pendingInvoiceOrderCount, "pending-invoice-total-definition-prevents-complete-spend-classification")] : []), sourceRowsComplete
    ? coverage("customer-segmentation-full-population", memberCount, memberCount)
    : partialCoverage("customer-segmentation-full-population", 0, memberCount, "invalid-retained-order-or-return-data-or-source-count-mismatch"), ...(scope.memberIds === undefined ? [coverage("unlinked-historical-delivery-sales", 0, unlinkedHistoryCount)] : [excludedCoverage("unlinked-historical-delivery-sales", "historical-delivery-sales-have-no-member-link")])]);
}

export interface CustomerSegmentationOrderInput {
  memberId: string;
  currency: string;
  subtotalMinor: bigint;
  discountMinor: bigint;
  refundedMinor: bigint;
  confirmedAt: Date | null;
  fulfillmentState: string;
  lines: readonly { unit: string; requested: unknown; cancelled: unknown; delivered: unknown; revenueMinor: bigint; returnedBilled?: unknown }[];
}

/** Aggregates persisted order quantities into the legacy analysis-only customer segments. */
export function aggregateCustomerSegmentationProfiles(
  members: readonly { id: string }[],
  orders: readonly CustomerSegmentationOrderInput[],
  throughDate: string,
): Map<LegacyCustomerSegment, number> {
  const throughEpoch = parseCivilDate(throughDate);
  type Profile = { count: number; lastDate: string | null; spendARS: bigint; hasARS: boolean; months: Set<string>; maxGramsScaled: bigint | null };
  const profiles = new Map<string, Profile>();
  for (const order of orders) {
    if (!order.confirmedAt || order.fulfillmentState === "cancelled") continue;
    const day = civilDateAt(order.confirmedAt);
    const epoch = parseCivilDate(day);
    if (epoch > throughEpoch) continue;
    let retainedDemand = 0n;
    let retainedSpend = 0n;
    let orderGramsScaled = 0n;
    let hasGramQuantity = false;
    for (const line of order.lines) {
      const requested = parseDecimal(decimalText(line.requested), 12);
      const cancelled = parseDecimal(decimalText(line.cancelled), 12);
      const returned = parseDecimal(decimalText(line.returnedBilled ?? "0"), 12);
      const retained = requested - cancelled - returned;
      if (requested <= 0n || retained < 0n) throw new RangeError("Invalid retained segmentation quantity");
      retainedDemand += retained;
      retainedSpend += roundHalfUp(line.revenueMinor * retained, requested);
      if (line.unit === "g") {
        hasGramQuantity = true;
        const delivered = parseDecimal(decimalText(line.delivered), 12);
        orderGramsScaled += delivered > returned ? delivered - returned : 0n;
      }
    }
    if (retainedDemand <= 0n) continue;
    const profile = profiles.get(order.memberId) ?? { count: 0, lastDate: null, spendARS: 0n, hasARS: false, months: new Set<string>(), maxGramsScaled: null };
    profile.count += 1;
    if (profile.lastDate === null || day > profile.lastDate) profile.lastDate = day;
    profile.months.add(day.slice(0, 7));
    if (order.currency === "ARS") {
      profile.hasARS = true;
      profile.spendARS += retainedSpend;
    }
    if (hasGramQuantity && (profile.maxGramsScaled === null || orderGramsScaled > profile.maxGramsScaled)) {
      profile.maxGramsScaled = orderGramsScaled;
    }
    profiles.set(order.memberId, profile);
  }
  const segmentCounts = new Map<LegacyCustomerSegment, number>();
  for (const member of members) {
    const profile = profiles.get(member.id);
    if (!profile) {
      segmentCounts.set("no-purchase-history", (segmentCounts.get("no-purchase-history") ?? 0) + 1);
      continue;
    }
    const lastEpoch = profile.lastDate === null ? throughEpoch : parseCivilDate(profile.lastDate);
    const segmentation = segmentLegacyCustomer({
      purchaseCount: profile.count,
      daysSinceLastPurchase: Math.max(0, Math.floor((throughEpoch - lastEpoch) / DAY_MS)),
      spendARSMinor: profile.hasARS ? profile.spendARS.toString() : null,
      distinctPurchaseMonths: profile.months.size,
      maxGrams: profile.maxGramsScaled === null ? null : formatDecimal(profile.maxGramsScaled, 12),
    });
    segmentCounts.set(segmentation.segment, (segmentCounts.get(segmentation.segment) ?? 0) + 1);
  }
  return segmentCounts;
}

async function commercialScenarios(range: ReportDateRange, scope: ReportScope) {
  const [policyCount, approvedPolicies, packCount, approvedPacks, promotionCount, approvedPromotions, historyPromotionCount, replacementQuoteCount] = await Promise.all([
    reportDb().pricePolicy.count(),
    reportDb().pricePolicy.count({ where: { approvedAt: { not: null }, approvedBy: { not: null } } }),
    reportDb().commercialPack.count(),
    reportDb().commercialPack.count({ where: { approvedAt: { not: null }, approvedBy: { not: null } } }),
    reportDb().commercialPromotion.count(),
    reportDb().commercialPromotion.count({ where: { approvedAt: { not: null }, approvedBy: { not: null } } }),
    reportDb().historicalPromotion.count(),
    reportDb().decisionReplacementQuote.count(),
  ]);
  const fixedCosts = await approvedFixedCosts(range, scope);
  const cashProjection = await obligationsThirteenWeeks(range);
  return queryEnvelope("commercial-scenarios", range, {
    pricePolicies: { total: policyCount, approved: approvedPolicies },
    commercialPacks: { total: packCount, approved: approvedPacks },
    commercialPromotions: { total: promotionCount, approved: approvedPromotions },
    historicalPromotionCount: historyPromotionCount,
    replacementQuoteCount: replacementQuoteCount,
    fixedCosts,
    scenarioCalculations: {
      value: cashProjection.metrics.scenarioConfigurationCoverage.state === "partial" ? null : cashProjection.metrics.scenarioProjections,
      state: cashProjection.metrics.scenarioConfigurationCoverage.state === "partial"
        ? "not-calculated-approved-source-population-incomplete"
        : cashProjection.metrics.scenarioProjections.length ? "calculated-from-approved-versioned-cash-inputs" : "no-current-approved-scenario",
      horizon: cashProjection.metrics.horizon,
      coverage: cashProjection.metrics.scenarioConfigurationCoverage,
      combinationPolicy: cashProjection.metrics.scenarioCombinationPolicy,
      valuation: "cash-flow-projection-per-currency; never-booked-as-revenue-or-debt",
    },
    proposalsAreNotBookedActuals: true,
  }, [coverage("commercial-policy-records", approvedPolicies + (policyCount - approvedPolicies), policyCount), coverage("historical-promotions", historyPromotionCount, historyPromotionCount), fixedCostCoverage(fixedCosts)]);
}

const scenarioCashKinds: readonly ScenarioCashKind[] = ["income", "payment", "purchase", "funding"];

function parseScenarioCashDefinition(value: unknown): {
  currency: "ARS" | "USD";
  items: ScenarioCashItem[];
  inputItemCount: number;
  malformedItemCount: number;
} | null {
  const definition = record(value);
  if ((definition.currency !== "ARS" && definition.currency !== "USD") || definition.weeks !== 13 || !Array.isArray(definition.items)) return null;
  const items: ScenarioCashItem[] = [];
  let malformedItemCount = 0;
  for (const raw of definition.items) {
    const item = record(raw);
    if (typeof item.id !== "string" || typeof item.date !== "string" || typeof item.kind !== "string" ||
        !scenarioCashKinds.includes(item.kind as ScenarioCashKind) || typeof item.amountMinor !== "string" ||
        (item.commitmentId !== undefined && typeof item.commitmentId !== "string")) {
      malformedItemCount += 1;
      continue;
    }
    items.push({
      id: item.id,
      date: item.date,
      kind: item.kind as ScenarioCashKind,
      amountMinor: item.amountMinor,
      ...(typeof item.commitmentId === "string" ? { commitmentId: item.commitmentId } : {}),
    });
  }
  return { currency: definition.currency, items, inputItemCount: definition.items.length, malformedItemCount };
}

async function approvedCashScenarioProjections(
  asOfDate: string,
  firstWeekStart: string,
  obligations: ReturnType<typeof aggregateThirteenWeekObligations>,
) {
  const where = {
    kind: "scenarios",
    state: "approved",
    approvedBy: { not: null },
    approvedAt: { lt: new Date(`${addDays(asOfDate, 1)}T03:00:00.000Z`) },
    validFrom: { lte: asOfDate },
    OR: [{ validUntil: null }, { validUntil: { gte: asOfDate } }],
  };
  const [approvedVersionCount, rows] = await Promise.all([
    reportDb().operationalConfiguration.count({ where }),
    reportDb().operationalConfiguration.findMany({
      where,
      select: { id: true, name: true, version: true, validFrom: true, validUntil: true, approvedAt: true, definition: true },
      orderBy: [{ name: "asc" }, { version: "desc" }, { id: "asc" }],
      take: REPORT_ROW_LIMIT,
    }),
  ]);
  const latestByName = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latestByName.has(row.name)) latestByName.set(row.name, row);

  const referencedCommitmentIds = [...new Set([...latestByName.values()].flatMap(row =>
    parseScenarioCashDefinition(row.definition)?.items.flatMap(item => item.commitmentId?.trim() ? [item.commitmentId.trim()] : []) ?? []))];
  // Match only the commitments named by approved scenarios, over the complete
  // payable horizon. The visible detail page cannot establish deduplication.
  const matchedPayables = referencedCommitmentIds.length ? await reportDb().operationPayable.findMany({
    where: { id: { in: referencedCommitmentIds }, dueDate: { gte: firstWeekStart, lt: addDays(firstWeekStart, 13 * 7) } },
    select: { id: true },
  }) : [];
  const existingObligationIds = new Set(matchedPayables.map(row => row.id));
  let invalidConfigurationCount = 0;
  let malformedScenarioItemCount = 0;
  const scenarioProjections = [];
  for (const row of latestByName.values()) {
    const definition = parseScenarioCashDefinition(row.definition);
    if (!definition) {
      invalidConfigurationCount += 1;
      continue;
    }
    malformedScenarioItemCount += definition.malformedItemCount;
    const projected = aggregateThirteenWeekScenarioCash(firstWeekStart, definition.currency, definition.items, existingObligationIds);
    const weeks = projected.weeks.map((week, index) => {
      const obligationWeek = obligations.weeks[index];
      const openPayableMinor = BigInt(obligationWeek.outstandingByCurrency.find(item => item.currency === definition.currency)?.minor ?? "0");
      const verifiedOpenPayableMinor = BigInt(obligationWeek.verifiedOutstandingByCurrency.find(item => item.currency === definition.currency)?.minor ?? "0");
      return {
        ...week,
        openPayableMinor: openPayableMinor.toString(),
        verifiedOpenPayableMinor: verifiedOpenPayableMinor.toString(),
        unverifiedOpenPayableMinor: (openPayableMinor - verifiedOpenPayableMinor).toString(),
        netFlowAfterVerifiedOpenPayablesMinor: (BigInt(week.netFlowMinor) - verifiedOpenPayableMinor).toString(),
        netFlowAfterAllOpenPayablesMinor: (BigInt(week.netFlowMinor) - openPayableMinor).toString(),
      };
    });
    scenarioProjections.push({
      configurationId: row.id,
      name: row.name,
      version: row.version,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      currency: definition.currency,
      state: definition.malformedItemCount + projected.invalidItemCount > 0 ? "partial" : "unverified",
      inputItemCount: definition.inputItemCount,
      includedItemCount: projected.includedItemCount,
      outsideHorizonCount: projected.outsideHorizonCount,
      duplicateCommitmentCount: projected.duplicateCommitmentCount,
      conflictingCommitmentCount: projected.conflictingCommitmentCount,
      matchedExistingObligationCount: projected.matchedExistingObligationCount,
      unmatchedCommitmentCount: projected.unmatchedCommitmentCount,
      invalidItemCount: definition.malformedItemCount + projected.invalidItemCount,
      openingBalanceMinor: null,
      closingBalanceMinor: null,
      balanceState: "not-calculated-opening-and-continuous-cash-coverage-unverified",
      weeks,
    });
  }

  const truncated = approvedVersionCount > rows.length;
  const state = truncated || invalidConfigurationCount > 0 || malformedScenarioItemCount > 0
    ? "partial" as const
    : scenarioProjections.length > 0 ? "unverified" as const : "unknown" as const;
  const reason = truncated ? "approved-scenario-configuration-limit-reached"
    : invalidConfigurationCount > 0 || malformedScenarioItemCount > 0 ? "invalid-approved-scenario-configuration"
      : scenarioProjections.length > 0 ? "approved-scenario-inputs-do-not-attest-source-completeness"
        : "no-current-approved-scenario-configuration";
  return {
    scenarioProjections: truncated ? [] : scenarioProjections,
    scenarioConfigurationCoverage: {
      source: "current-approved-versioned-operational-configurations",
      state,
      approvedVersionCount,
      loadedApprovedVersionCount: rows.length,
      selectedScenarioCount: truncated ? null : latestByName.size,
      validScenarioCount: truncated ? null : scenarioProjections.length,
      invalidConfigurationCount: truncated ? null : invalidConfigurationCount,
      malformedScenarioItemCount: truncated ? null : malformedScenarioItemCount,
      reason,
    },
    scenarioCombinationPolicy: "each-approved-scenario-is-an-alternative; no-scenario-balances-are-added-together",
  };
}

async function obligationsThirteenWeeks(range: ReportDateRange) {
  const referenceDate = range.to ?? civilDateAt(new Date());
  const firstWeekStart = mondayAtOrBefore(referenceDate);
  const afterLastWeek = addDays(firstWeekStart, 13 * 7);
  const lastWeekEnd = addDays(afterLastWeek, -1);
  const where = { dueDate: { gte: firstWeekStart, lt: afterLastWeek } };
  const beforeHorizon = { lt: new Date(`${firstWeekStart}T03:00:00.000Z`) };
  const payableHorizonCtes = Prisma.sql`
    WITH horizon AS (
      SELECT p."id", p."dueDate", p."currency", p."amountMinor", p."paidMinor", p."verified",
        CASE WHEN p."dueDate" ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          THEN to_date(p."dueDate", 'YYYY-MM-DD')::date ELSE NULL END AS due_day
      FROM "OperationPayable" AS p
      WHERE p."dueDate" >= ${firstWeekStart} AND p."dueDate" < ${afterLastWeek}
    ), dated AS (
      SELECT *, due_day IS NOT NULL AND to_char(due_day, 'YYYY-MM-DD') = "dueDate" AS valid_due_date
      FROM horizon
    ), validated AS (
      SELECT *, valid_due_date AND "currency" IN ('ARS', 'USD') AND "amountMinor" >= 0
        AND "paidMinor" >= 0 AND "paidMinor" <= "amountMinor" AS valid
      FROM dated
    )
  `;
  const [payableCount, payables, payableSummaryRows, payableWeekGroups, activeAccountCount, accounts, legGroups, attestation] = await Promise.all([
    reportDb().operationPayable.count({ where }),
    reportDb().operationPayable.findMany({ where, select: { id: true, beneficiaryId: true, kind: true, currency: true, amountMinor: true, paidMinor: true, dueDate: true, verified: true, sourceSystem: true, sourceId: true }, orderBy: [{ dueDate: "asc" }, { beneficiaryId: "asc" }, { id: "asc" }], take: REPORT_DETAIL_ROW_LIMIT }),
    reportDb().$queryRaw<Array<{ selectedCount: bigint; validCount: bigint; invalidDateCount: bigint; invalidCurrencyCount: bigint; invalidAmountCount: bigint }>>(Prisma.sql`
      ${payableHorizonCtes}
      SELECT COUNT(*)::bigint AS "selectedCount",
        COUNT(*) FILTER (WHERE valid)::bigint AS "validCount",
        COUNT(*) FILTER (WHERE NOT valid_due_date)::bigint AS "invalidDateCount",
        COUNT(*) FILTER (WHERE valid_due_date AND "currency" NOT IN ('ARS', 'USD'))::bigint AS "invalidCurrencyCount",
        COUNT(*) FILTER (WHERE valid_due_date AND ("amountMinor" < 0 OR "paidMinor" < 0 OR "paidMinor" > "amountMinor"))::bigint AS "invalidAmountCount"
      FROM validated
    `),
    reportDb().$queryRaw<Array<{ weekStart: string; currency: string; obligationCount: bigint; verifiedCount: bigint; outstandingMinor: string; verifiedOutstandingMinor: string }>>(Prisma.sql`
      ${payableHorizonCtes}
      SELECT to_char(date_trunc('week', due_day)::date, 'YYYY-MM-DD') AS "weekStart",
        "currency" AS "currency", COUNT(*)::bigint AS "obligationCount",
        COUNT(*) FILTER (WHERE "verified")::bigint AS "verifiedCount",
        SUM("amountMinor" - "paidMinor")::text AS "outstandingMinor",
        COALESCE(SUM("amountMinor" - "paidMinor") FILTER (WHERE "verified"), 0)::text AS "verifiedOutstandingMinor"
      FROM validated
      WHERE valid AND "amountMinor" > "paidMinor"
      GROUP BY date_trunc('week', due_day)::date, "currency"
      ORDER BY date_trunc('week', due_day)::date, "currency"
    `),
    reportDb().operationAccount.count({ where: { active: true } }),
    reportDb().operationAccount.findMany({ where: { active: true }, select: { id: true, kind: true, currency: true, custodianId: true, verified: true, openingApprovedBy: true }, orderBy: [{ kind: "asc" }, { currency: "asc" }, { id: "asc" }], take: REPORT_ROW_LIMIT }),
    reportDb().ledgerLeg.groupBy({ by: ["accountId", "currency"], where: { event: { occurredAt: beforeHorizon } }, _sum: { amountMinor: true } }),
    reportDb().decisionInputAttestation.findFirst({ where: { domain: "payables", scenario: null, complete: true, fromDate: { lte: new Date(`${firstWeekStart}T00:00:00.000Z`) }, throughDate: { gte: new Date(`${lastWeekEnd}T00:00:00.000Z`) } }, select: { id: true, sourceReference: true, fromDate: true, throughDate: true, confirmedAt: true }, orderBy: { confirmedAt: "desc" } }),
  ]);
  const payableRowsComplete = payables.length === payableCount;
  const payableSummary = payableSummaryRows[0];
  const payableSummaryComplete = payableSummary !== undefined
    && Number(payableSummary.selectedCount) === payableCount
    && Number(payableSummary.validCount) === payableCount;
  const payableInvalidDateCount = Number(payableSummary?.invalidDateCount ?? 0n);
  const payableInvalidCurrencyCount = Number(payableSummary?.invalidCurrencyCount ?? 0n);
  const payableInvalidAmountCount = Number(payableSummary?.invalidAmountCount ?? 0n);
  const accountRowsComplete = accounts.length === activeAccountCount;
  const reconciliationIds = accounts.map(account => account.id);
  const reconciliations = reconciliationIds.length ? await reportDb().$queryRaw<Array<{ accountId: string; date: string; countedMinor: bigint }>>(Prisma.sql`
    SELECT DISTINCT ON (r."accountId") r."accountId", r."date", r."countedMinor"
    FROM "AccountReconciliation" AS r
    WHERE r."date" <= ${firstWeekStart}
      AND r."accountId" IN (${Prisma.join(reconciliationIds)})
    ORDER BY r."accountId" ASC, r."date" DESC, r."createdAt" DESC, r."id" DESC
  `) : [];
  const sourceCoverage = attestation && payableSummaryComplete ? "complete" as const : payableCount ? "partial" as const : "unknown" as const;
  const aggregate = aggregateThirteenWeekObligations(firstWeekStart, [], sourceCoverage);
  const weeklyGroupsByStart = new Map<string, typeof payableWeekGroups>();
  for (const row of payableWeekGroups) {
    const group = weeklyGroupsByStart.get(row.weekStart) ?? [];
    group.push(row);
    weeklyGroupsByStart.set(row.weekStart, group);
  }
  const weeklySummary = aggregate.weeks.map(week => {
    const groups = weeklyGroupsByStart.get(week.weekStart) ?? [];
    const count = groups.reduce((sum, row) => sum + Number(row.obligationCount), 0);
    const verifiedCount = groups.reduce((sum, row) => sum + Number(row.verifiedCount), 0);
    return {
      ...week,
      obligationCount: count,
      verifiedCount,
      unverifiedCount: count - verifiedCount,
      outstandingByCurrency: groups.filter(row => row.outstandingMinor !== "0").map(row => ({ currency: row.currency as "ARS" | "USD", minor: row.outstandingMinor })),
      verifiedOutstandingByCurrency: groups.filter(row => row.verifiedOutstandingMinor !== "0").map(row => ({ currency: row.currency as "ARS" | "USD", minor: row.verifiedOutstandingMinor })),
    };
  });
  const cashScenarios = payableSummaryComplete ? await approvedCashScenarioProjections(referenceDate, firstWeekStart, { ...aggregate, weeks: weeklySummary }) : {
    scenarioProjections: [],
    scenarioConfigurationCoverage: {
      source: "current-approved-versioned-operational-configurations",
      state: "partial" as const,
      approvedVersionCount: null,
      loadedApprovedVersionCount: 0,
      selectedScenarioCount: null,
      validScenarioCount: null,
      invalidConfigurationCount: null,
      malformedScenarioItemCount: null,
      reason: "invalid-or-incomplete-payable-population; scenario-cash-values-not-calculated",
    },
    scenarioCombinationPolicy: "each-approved-scenario-is-an-alternative; no-scenario-balances-are-added-together",
  };
  const balances = new Map<string, bigint>();
  for (const group of legGroups) balances.set(`${group.accountId}\u0000${group.currency}`, group._sum.amountMinor ?? 0n);
  const latestReconciliation = new Map<string, { date: string; countedMinor: bigint }>();
  for (const row of reconciliations) if (!latestReconciliation.has(row.accountId)) latestReconciliation.set(row.accountId, { date: row.date, countedMinor: row.countedMinor });
  const custodyAccounts = accounts.filter(account => account.kind === "custody").map(account => {
    const reconciliation = latestReconciliation.get(account.id);
    const valid = account.verified && account.openingApprovedBy !== null;
    return {
      accountId: account.id,
      custodianId: account.custodianId,
      currency: account.currency,
      verified: account.verified,
      openingApproved: account.openingApprovedBy !== null,
      observedPreHorizonLedgerMinor: valid ? (balances.get(`${account.id}\u0000${account.currency}`) ?? 0n).toString() : null,
      countedBalanceMinor: valid && reconciliation ? reconciliation.countedMinor.toString() : null,
      reconciledThrough: valid ? reconciliation?.date ?? null : null,
      excludedFromClubSpendableCash: true,
    };
  });
  const clubAccounts = accounts.filter(account => account.kind !== "custody").map(account => {
    const reconciliation = latestReconciliation.get(account.id);
    const valid = account.verified && account.openingApprovedBy !== null;
    return {
      accountId: account.id,
      currency: account.currency,
      kind: account.kind,
      verified: account.verified,
      openingApproved: account.openingApprovedBy !== null,
      observedPreHorizonLedgerMinor: valid ? (balances.get(`${account.id}\u0000${account.currency}`) ?? 0n).toString() : null,
      countedBalanceMinor: valid && reconciliation ? reconciliation.countedMinor.toString() : null,
      reconciledThrough: valid ? reconciliation?.date ?? null : null,
    };
  });
  const pending = payables.filter(row => !row.verified && row.amountMinor > row.paidMinor).map(row => ({
    payableId: row.id,
    beneficiaryId: row.beneficiaryId,
    sourceIdentity: row.sourceSystem && row.sourceId ? { sourceSystem: row.sourceSystem, sourceId: row.sourceId } : null,
    dueDate: row.dueDate,
    kind: row.kind,
    currency: row.currency,
    amountMinor: row.amountMinor.toString(),
    paidMinor: row.paidMinor.toString(),
    outstandingMinor: (row.amountMinor - row.paidMinor).toString(),
    verified: false,
  }));
  const verified = payables.filter(row => row.verified && row.amountMinor > row.paidMinor).map(row => ({
    payableId: row.id,
    beneficiaryId: row.beneficiaryId,
    sourceIdentity: row.sourceSystem && row.sourceId ? { sourceSystem: row.sourceSystem, sourceId: row.sourceId } : null,
    dueDate: row.dueDate,
    kind: row.kind,
    currency: row.currency,
    amountMinor: row.amountMinor.toString(),
    paidMinor: row.paidMinor.toString(),
    outstandingMinor: (row.amountMinor - row.paidMinor).toString(),
    verified: true,
  }));
  return queryEnvelope("obligations-13-weeks", range, {
    horizon: { from: firstWeekStart, through: lastWeekEnd, weeks: 13 },
    sourceCoverage: aggregate.sourceCoverage,
    attestation: attestation ? { present: true, sourceReference: attestation.sourceReference, fromDate: civilDateAt(attestation.fromDate), throughDate: civilDateAt(attestation.throughDate), confirmedAt: attestation.confirmedAt.toISOString() } : { present: false },
    weekly: payableSummaryComplete ? weeklySummary : null,
    payableSummaryComplete,
    invalidPayableDateCount: payableInvalidDateCount,
    invalidPayableCurrencyCount: payableInvalidCurrencyCount,
    invalidPayableAmountCount: payableInvalidAmountCount,
    payableRowsComplete,
    visiblePayableRows: payables.length,
    payableDetailLimit: REPORT_DETAIL_ROW_LIMIT,
    activeAccountRowsComplete: accountRowsComplete,
    visibleActiveAccountRows: accounts.length,
    ...cashScenarios,
    cashPathState: "not-certified-incomplete-receipts-and-account-ledger-attestation",
    verifiedObligationsByIdentity: verified,
    pendingObligationsByIdentity: pending,
    clubAccounts,
    custodyAccounts,
    currenciesCombined: false,
  }, [payableSummaryComplete
    ? coverage("13-week-payables", payableCount, payableCount)
    : partialCoverage("13-week-payables", Number(payableSummary?.validCount ?? 0n), payableCount, "invalid-payable-source-data-or-summary-count-mismatch"),
  coverage("visible-13-week-payable-details", payables.length, payableCount), coverage("club-and-custody-accounts", accounts.length, activeAccountCount)]);
}

export async function queryOperationsReport(area: ReportAreaId, range: ReportDateRange = {}, scope: ReportScope = {}) {
  assertReportScope(area, scope);
  return primaryDb.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return reportSnapshot.run(tx, () => querySnapshot(area, range, scope));
  }, { isolationLevel: "RepeatableRead", timeout: 30000 });
}
async function querySnapshot(area: ReportAreaId, range: ReportDateRange, scope: ReportScope) {
  switch (area) {
    case "sales-revenue": return salesRevenue(range, scope);
    case "product-contribution": return productContribution(range, scope);
    case "operating-expenses": return operatingExpenses(range, scope);
    case "purchases": return purchases(range);
    case "inventory": return inventory(range, scope);
    case "cash-ledger": return cashLedger(range, scope);
    case "delivery-collections": return deliveryCollections(range);
    case "fx-reconciliation": return fxReconciliation(range, scope);
    case "customer-segmentation": return customerSegmentation(range, scope);
    case "commercial-scenarios": return commercialScenarios(range, scope);
    case "obligations-13-weeks": return obligationsThirteenWeeks(range);
  }
}

export const reportQueryLimits = { rowsPerSource: REPORT_ROW_LIMIT, detailRowsPerSource: REPORT_DETAIL_ROW_LIMIT } as const;

export function reportTodayCivilDate(now = new Date()): string {
  return civilDateAt(now);
}

export function reportMoneyTotal(values: readonly { currency: "ARS" | "USD"; minor: string }[]) {
  return sumMoneyByCurrency(values);
}
