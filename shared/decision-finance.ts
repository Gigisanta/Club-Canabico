/**
 * Pure management-finance and forecasting functions.
 *
 * Money is always signed integer ARS centavos (`bigint`). This module performs
 * no I/O and accepts no implicit defaults: callers must declare source
 * coverage, supply CPI points, and provide a reconciled opening balance before
 * a cash balance can be projected.
 */

export const DECISION_FINANCE_REPORT_CONTRACT = {
  version: 1,
  currency: "ARS",
  moneyUnit: "signed integer centavos (bigint)",
  metadataKinds: ["calculated", "scenario", "reconciled"],
  managementPnl: "net sales - historical COGS - accrued operating expense",
  cashForecastWeeks: 13,
  longRangePeriods: ["2026-12", ...Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, "0")}`)],
  cpi: "caller-supplied official series with publisher, series, version and publication date",
  rollingForecast: {
    targetDays: 7,
    originStepDays: 7,
    trailingTrainingDays: 28,
    rounding: "nearest centavo; midpoint away from zero",
    intervalQuantiles: "empirical nearest-rank 10th/90th percentiles from prior rolling-origin residuals",
    minimumCalibrationOrigins: 10,
    minimumMetricOrigins: 3,
    minimumIntervalCoverageOrigins: 5,
    intervalTargetPercent: 80,
  },
} as const;

export type SourceCoverage = "complete" | "partial" | "unknown";
export type PlanningScenario = "low" | "base" | "high";
export type IsoDate = string;
export type IsoMonth = string;

export interface DateRange {
  from: IsoDate;
  through: IsoDate;
}

export interface DatedAmount {
  date: IsoDate;
  amountCents: bigint;
}

/** Purchase/receipt of stock is asset recognition; it is not a P&L expense. */
export interface InventoryAcquisition extends DatedAmount {
  inventoryReference?: string;
}

/** Categories follow the existing Bombo cash ledger vocabulary. */
export type CashCategory =
  | "opening_balance"
  | "sale"
  | "operating_expense"
  | "stock_purchase"
  | "local_investment"
  | "capital_contribution"
  | "owner_draw"
  | "delivery_receipt"
  | "other_income"
  | "other_outflow"
  | "adjustment";

export interface CashLedgerEntry extends DatedAmount {
  category: CashCategory;
}

export interface ManagementPnlInput {
  period: DateRange;
  netSales: DatedAmount[];
  historicalCogs: DatedAmount[];
  accruedOperatingExpenses: DatedAmount[];
  /** Optional asset purchases and cash payments are reported separately. */
  inventoryAcquisitions: InventoryAcquisition[];
  cashEntries: CashLedgerEntry[];
  sourceCoverage: {
    netSales: SourceCoverage;
    historicalCogs: SourceCoverage;
    accruedOperatingExpenses: SourceCoverage;
    inventoryAcquisitions: SourceCoverage;
    cashEntries: SourceCoverage;
  };
}

export interface CalculatedMetadata {
  kind: "calculated";
  currency: "ARS";
  sourceCoverage: Record<string, SourceCoverage>;
}

export interface ManagementPnlResult {
  period: DateRange;
  netSalesCents: bigint;
  historicalCogsCents: bigint;
  accruedOperatingExpensesCents: bigint;
  /** Null unless all three P&L source streams are declared complete. */
  operatingResultCents: bigint | null;
  /** Arithmetic over supplied rows, explicitly not a complete result. */
  observedOperatingResultCents: bigint;
  /** Informational asset additions; never subtracted in the P&L formula. */
  inventoryAcquisitionsCents: bigint;
  /** Signed cash amounts grouped by ledger category, separate from accruals. */
  cashByCategory: Partial<Record<CashCategory, bigint>>;
  includedRows: {
    netSales: number;
    historicalCogs: number;
    accruedOperatingExpenses: number;
    inventoryAcquisitions: number;
    cashEntries: number;
  };
  metadata: CalculatedMetadata;
}

export interface ReconciledOpeningBalance {
  kind: "reconciled";
  amountCents: bigint;
  asOfDate: IsoDate;
  reconciliationId: string;
}

export type PlannedCashCategory = Exclude<CashCategory, "opening_balance">;

/** A signed cash movement: receipts are positive and payments are negative. */
export interface PlannedCashEvent extends DatedAmount {
  category: PlannedCashCategory;
}

export interface ThirteenWeekCashInput {
  asOfDate: IsoDate;
  scenario: PlanningScenario;
  sourceCoverage: SourceCoverage;
  openingBalance: ReconciledOpeningBalance | null;
  events: PlannedCashEvent[];
}

export interface ScenarioMetadata {
  kind: "scenario";
  scenario: PlanningScenario;
  sourceCoverage: SourceCoverage;
  openingBalance: ReconciledOpeningBalance | null;
}

export interface ThirteenWeekCashRow {
  week: number;
  from: IsoDate;
  through: IsoDate;
  /** Sum of supplied events, even when the source is marked partial. */
  observedCashChangeCents: bigint;
  /** Complete planned change; null unless scenario input is declared complete. */
  plannedCashChangeCents: bigint | null;
  openingCashBalanceCents: bigint | null;
  closingCashBalanceCents: bigint | null;
  cashByCategory: Partial<Record<PlannedCashCategory, bigint>>;
}

export interface ThirteenWeekCashResult {
  available: boolean;
  unavailableReasons: Array<"missing-reconciled-opening-balance" | "incomplete-scenario-input">;
  weeks: ThirteenWeekCashRow[];
  metadata: ScenarioMetadata;
}

export interface MonthlyScenarioInput {
  month: IsoMonth;
  scenario: PlanningScenario;
  sourceCoverage: SourceCoverage;
  events: PlannedCashEvent[];
}

export interface HiringWhatIf {
  startMonth: IsoMonth;
  endMonth: IsoMonth | null;
  headcount: number;
  /** Employer cost per hire; no tax/load percentage is inferred. */
  monthlyEmployerCostPerEmployeeCents: bigint;
}

export interface MonthlyScenarioRow {
  scenario: PlanningScenario;
  sourceCoverage: SourceCoverage | "missing";
  /** Signed sum of provided event rows, null when the scenario row is absent. */
  observedCashChangeCents: bigint | null;
  /** Null unless this month's scenario inputs are declared complete. */
  cashChangeCents: bigint | null;
  cashByCategory: Partial<Record<PlannedCashCategory, bigint>>;
  closingCashBalanceCents: bigint | null;
  hiringAdjustmentCents: bigint | null;
  cashChangeWithHiringCents: bigint | null;
  closingCashBalanceWithHiringCents: bigint | null;
  metadata: ScenarioMetadata;
}

export interface LongRangeScenarioResult {
  periods: Array<{
    month: IsoMonth;
    byScenario: Record<PlanningScenario, MonthlyScenarioRow>;
  }>;
  metadata: {
    kind: "scenario";
    source: "explicit monthly assumptions";
    openingBalance: ReconciledOpeningBalance | null;
    hiringWhatIf: HiringWhatIf | null;
  };
}

export interface OfficialCpiPoint {
  month: IsoMonth;
  /** Positive index value; any consistent integer scale is accepted. */
  indexValue: bigint;
}

export interface SuppliedOfficialCpiSeries {
  publisher: string;
  seriesName: string;
  version: string;
  publishedAt: IsoDate;
  points: OfficialCpiPoint[];
}

export interface NominalCpiComparisonInput {
  earlierMonth: IsoMonth;
  laterMonth: IsoMonth;
  earlierNominalCents: bigint;
  laterNominalCents: bigint;
  officialIndex: SuppliedOfficialCpiSeries;
}

export interface NominalCpiComparisonResult {
  status: "available" | "missing-index-point";
  earlierMonth: IsoMonth;
  laterMonth: IsoMonth;
  earlierNominalCents: bigint;
  laterNominalCents: bigint;
  nominalChangeCents: bigint;
  /** Earlier amount restated in later-month pesos; null if an index is absent. */
  earlierAdjustedToLaterCents: bigint | null;
  /** Later nominal amount minus earlier CPI-restated amount. */
  cpiAdjustedChangeCents: bigint | null;
  missingMonths: IsoMonth[];
  metadata: CalculatedMetadata & {
    officialIndex: Pick<SuppliedOfficialCpiSeries, "publisher" | "seriesName" | "version" | "publishedAt">;
  };
}

export interface DailySalesObservation {
  date: IsoDate;
  netSalesCents: bigint;
}

export interface SevenDayAggregateForecastInput {
  dailySales: DailySalesObservation[];
  sourceCoverage: SourceCoverage;
}

export interface SevenDayAggregateForecastResult {
  forecast: {
    available: boolean;
    unavailableReason: "incomplete-source" | "insufficient-history" | "date-gap" | null;
    asOfDate: IsoDate | null;
    from: IsoDate | null;
    through: IsoDate | null;
    pointCents: bigint | null;
    interval80: { lowerCents: bigint; upperCents: bigint; calibrationOrigins: number } | null;
  };
  outOfSample: {
    forecastOrigins: number;
    maeCents: bigint | null;
    biasCents: bigint | null;
    intervalTargetPercent: 80 | null;
    intervalCoverage: {
      coveredOrigins: number;
      scoredOrigins: number;
      /** Basis points; null until at least five interval forecasts are scored. */
      observedCoverageBasisPoints: number | null;
    } | null;
  };
  metadata: CalculatedMetadata & {
    method: "previous-28-day-average-scaled-to-seven-days";
    dailyObservationCount: number;
    minimumHistoryDays: 28;
    minimumCalibrationOrigins: 10;
    minimumMetricOrigins: 3;
  };
}

const CASH_CATEGORIES: readonly CashCategory[] = [
  "opening_balance", "sale", "operating_expense", "stock_purchase", "local_investment",
  "capital_contribution", "owner_draw", "delivery_receipt", "other_income", "other_outflow", "adjustment",
];
const PLANNED_CATEGORIES: readonly PlannedCashCategory[] = CASH_CATEGORIES.filter(
  (category): category is PlannedCashCategory => category !== "opening_balance",
);
const SCENARIOS: readonly PlanningScenario[] = ["low", "base", "high"];
const LONG_RANGE_PERIODS: readonly IsoMonth[] = DECISION_FINANCE_REPORT_CONTRACT.longRangePeriods;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TypeError(`${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} is not a calendar date`);
  }
}

function assertMonth(value: string, label: string): void {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new TypeError(`${label} must be YYYY-MM`);
}

function assertBigint(value: bigint, label: string): void {
  if (typeof value !== "bigint") throw new TypeError(`${label} must be bigint centavos`);
}

function assertCoverage(value: SourceCoverage, label: string): void {
  if (value !== "complete" && value !== "partial" && value !== "unknown") {
    throw new TypeError(`${label} must declare complete, partial, or unknown coverage`);
  }
}

function dateAt(date: IsoDate, dayOffset: number): IsoDate {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + dayOffset);
  return value.toISOString().slice(0, 10);
}

function monthAt(month: IsoMonth, offset: number): IsoMonth {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function lastDateOfMonth(month: IsoMonth): IsoDate {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

function inRange(date: IsoDate, range: DateRange): boolean {
  return date >= range.from && date <= range.through;
}

function sumDated(rows: readonly DatedAmount[], period: DateRange): bigint {
  return rows.reduce((sum, row) => sum + (inRange(row.date, period) ? row.amountCents : 0n), 0n);
}

function validateDatedAmounts(rows: readonly DatedAmount[], label: string): void {
  for (const row of rows) {
    assertDate(row.date, `${label}.date`);
    assertBigint(row.amountCents, `${label}.amountCents`);
  }
}

function validateCashCategory(category: CashCategory, amount: bigint, label: string): void {
  if (!CASH_CATEGORIES.includes(category)) throw new TypeError(`${label}.category is unsupported`);
  if (amount === 0n) throw new TypeError(`${label}.amountCents cannot be zero`);
  if (["sale", "capital_contribution", "delivery_receipt", "other_income"].includes(category) && amount < 0n) {
    throw new RangeError(`${label} requires a positive receipt`);
  }
  if (["operating_expense", "stock_purchase", "local_investment", "owner_draw", "other_outflow"].includes(category) && amount > 0n) {
    throw new RangeError(`${label} requires a negative payment`);
  }
}

function validatePlannedEvent(event: PlannedCashEvent, label: string): void {
  assertDate(event.date, `${label}.date`);
  assertBigint(event.amountCents, `${label}.amountCents`);
  if (!(PLANNED_CATEGORIES as readonly string[]).includes(event.category)) {
    throw new TypeError(`${label}.category cannot be opening_balance or an unknown category`);
  }
  validateCashCategory(event.category, event.amountCents, label);
}

function sumEvents(events: readonly PlannedCashEvent[]): bigint {
  return events.reduce((sum, event) => sum + event.amountCents, 0n);
}

function groupEvents(events: readonly PlannedCashEvent[]): Partial<Record<PlannedCashCategory, bigint>> {
  const totals: Partial<Record<PlannedCashCategory, bigint>> = {};
  for (const event of events) totals[event.category] = (totals[event.category] || 0n) + event.amountCents;
  return totals;
}

function validateOpeningBalance(balance: ReconciledOpeningBalance | null, asOfDate: IsoDate): void {
  if (balance === null) return;
  if (balance.kind !== "reconciled") throw new TypeError("openingBalance must be explicitly reconciled");
  assertBigint(balance.amountCents, "openingBalance.amountCents");
  assertDate(balance.asOfDate, "openingBalance.asOfDate");
  if (balance.asOfDate !== asOfDate) throw new RangeError("opening balance and scenario asOfDate must match");
  if (!balance.reconciliationId.trim()) throw new TypeError("openingBalance.reconciliationId is required");
}

export function calculateManagementPnl(input: ManagementPnlInput): ManagementPnlResult {
  assertDate(input.period.from, "period.from");
  assertDate(input.period.through, "period.through");
  if (input.period.from > input.period.through) throw new RangeError("period.from must not follow period.through");
  for (const [key, coverage] of Object.entries(input.sourceCoverage)) assertCoverage(coverage, `sourceCoverage.${key}`);
  validateDatedAmounts(input.netSales, "netSales");
  validateDatedAmounts(input.historicalCogs, "historicalCogs");
  validateDatedAmounts(input.accruedOperatingExpenses, "accruedOperatingExpenses");
  validateDatedAmounts(input.inventoryAcquisitions, "inventoryAcquisitions");
  for (const [index, entry] of input.cashEntries.entries()) {
    assertDate(entry.date, `cashEntries[${index}].date`);
    assertBigint(entry.amountCents, `cashEntries[${index}].amountCents`);
    validateCashCategory(entry.category, entry.amountCents, `cashEntries[${index}]`);
  }
  const netSalesCents = sumDated(input.netSales, input.period);
  const historicalCogsCents = sumDated(input.historicalCogs, input.period);
  const accruedOperatingExpensesCents = sumDated(input.accruedOperatingExpenses, input.period);
  const observedOperatingResultCents = netSalesCents - historicalCogsCents - accruedOperatingExpensesCents;
  const complete = input.sourceCoverage.netSales === "complete"
    && input.sourceCoverage.historicalCogs === "complete"
    && input.sourceCoverage.accruedOperatingExpenses === "complete";
  const cashByCategory: Partial<Record<CashCategory, bigint>> = {};
  let cashEntriesInPeriod = 0;
  for (const entry of input.cashEntries) {
    if (!inRange(entry.date, input.period)) continue;
    cashEntriesInPeriod++;
    cashByCategory[entry.category] = (cashByCategory[entry.category] || 0n) + entry.amountCents;
  }
  return {
    period: { ...input.period },
    netSalesCents,
    historicalCogsCents,
    accruedOperatingExpensesCents,
    operatingResultCents: complete ? observedOperatingResultCents : null,
    observedOperatingResultCents,
    inventoryAcquisitionsCents: sumDated(input.inventoryAcquisitions, input.period),
    cashByCategory,
    includedRows: {
      netSales: input.netSales.filter((row) => inRange(row.date, input.period)).length,
      historicalCogs: input.historicalCogs.filter((row) => inRange(row.date, input.period)).length,
      accruedOperatingExpenses: input.accruedOperatingExpenses.filter((row) => inRange(row.date, input.period)).length,
      inventoryAcquisitions: input.inventoryAcquisitions.filter((row) => inRange(row.date, input.period)).length,
      cashEntries: cashEntriesInPeriod,
    },
    metadata: {
      kind: "calculated",
      currency: "ARS",
      sourceCoverage: { ...input.sourceCoverage },
    },
  };
}

export function forecastThirteenWeekCash(input: ThirteenWeekCashInput): ThirteenWeekCashResult {
  assertDate(input.asOfDate, "asOfDate");
  assertCoverage(input.sourceCoverage, "sourceCoverage");
  if (!SCENARIOS.includes(input.scenario)) throw new TypeError("scenario must be low, base, or high");
  validateOpeningBalance(input.openingBalance, input.asOfDate);
  for (const [index, event] of input.events.entries()) {
    validatePlannedEvent(event, `events[${index}]`);
    if (event.date <= input.asOfDate) throw new RangeError("cash scenario events must be after asOfDate");
  }
  const unavailableReasons: ThirteenWeekCashResult["unavailableReasons"] = [];
  if (!input.openingBalance) unavailableReasons.push("missing-reconciled-opening-balance");
  if (input.sourceCoverage !== "complete") unavailableReasons.push("incomplete-scenario-input");
  const available = unavailableReasons.length === 0;
  let runningBalance = available ? input.openingBalance!.amountCents : null;
  const weeks: ThirteenWeekCashRow[] = Array.from({ length: 13 }, (_, index) => {
    const from = dateAt(input.asOfDate, index * 7 + 1);
    const through = dateAt(from, 6);
    const events = input.events.filter((event) => event.date >= from && event.date <= through);
    const observedCashChangeCents = sumEvents(events);
    const plannedCashChangeCents = input.sourceCoverage === "complete" ? observedCashChangeCents : null;
    const openingCashBalanceCents = runningBalance;
    if (available) runningBalance = runningBalance! + plannedCashChangeCents!;
    return {
      week: index + 1,
      from,
      through,
      observedCashChangeCents,
      plannedCashChangeCents,
      openingCashBalanceCents,
      closingCashBalanceCents: runningBalance,
      cashByCategory: groupEvents(events),
    };
  });
  return {
    available,
    unavailableReasons,
    weeks,
    metadata: {
      kind: "scenario",
      scenario: input.scenario,
      sourceCoverage: input.sourceCoverage,
      openingBalance: input.openingBalance,
    },
  };
}

function validateHiringWhatIf(hiring: HiringWhatIf | null, asOfDate: IsoDate): void {
  if (hiring === null) return;
  assertMonth(hiring.startMonth, "hiringWhatIf.startMonth");
  if (hiring.endMonth !== null) {
    assertMonth(hiring.endMonth, "hiringWhatIf.endMonth");
    if (hiring.endMonth < hiring.startMonth) throw new RangeError("hiring endMonth must not precede startMonth");
  }
  if (!Number.isSafeInteger(hiring.headcount) || hiring.headcount <= 0) throw new RangeError("hiring headcount must be a positive safe integer");
  assertBigint(hiring.monthlyEmployerCostPerEmployeeCents, "hiringWhatIf.monthlyEmployerCostPerEmployeeCents");
  if (hiring.monthlyEmployerCostPerEmployeeCents < 0n) throw new RangeError("monthly employer cost cannot be negative");
  if (hiring.startMonth < asOfDate.slice(0, 7)) throw new RangeError("hiringWhatIf cannot start before asOfDate month");
}

function makeMissingMonthlyRow(
  scenario: PlanningScenario,
  openingBalance: ReconciledOpeningBalance | null,
): MonthlyScenarioRow {
  return {
    scenario,
    sourceCoverage: "missing",
    observedCashChangeCents: null,
    cashChangeCents: null,
    cashByCategory: {},
    closingCashBalanceCents: null,
    hiringAdjustmentCents: null,
    cashChangeWithHiringCents: null,
    closingCashBalanceWithHiringCents: null,
    metadata: { kind: "scenario", scenario, sourceCoverage: "unknown", openingBalance },
  };
}

/** Builds December 2026 plus every month of 2027 for low/base/high scenarios. */
export function forecastLongRangeScenarios(input: {
  asOfDate: IsoDate;
  openingBalance: ReconciledOpeningBalance | null;
  assumptions: MonthlyScenarioInput[];
  hiringWhatIf: HiringWhatIf | null;
}): LongRangeScenarioResult {
  assertDate(input.asOfDate, "asOfDate");
  validateOpeningBalance(input.openingBalance, input.asOfDate);
  validateHiringWhatIf(input.hiringWhatIf, input.asOfDate);
  const assumptions = new Map<string, MonthlyScenarioInput>();
  for (const [index, row] of input.assumptions.entries()) {
    assertMonth(row.month, `assumptions[${index}].month`);
    assertCoverage(row.sourceCoverage, `assumptions[${index}].sourceCoverage`);
    if (!SCENARIOS.includes(row.scenario)) throw new TypeError(`assumptions[${index}].scenario is invalid`);
    const key = `${row.scenario}:${row.month}`;
    if (assumptions.has(key)) throw new TypeError(`duplicate monthly assumption ${key}`);
    for (const [eventIndex, event] of row.events.entries()) {
      validatePlannedEvent(event, `assumptions[${index}].events[${eventIndex}]`);
      if (event.date.slice(0, 7) !== row.month) throw new RangeError("monthly scenario event must fall inside its month");
      if (event.date <= input.asOfDate) throw new RangeError("monthly scenario events must be after asOfDate");
    }
    assumptions.set(key, row);
  }

  const firstForecastMonth = input.asOfDate === lastDateOfMonth(input.asOfDate.slice(0, 7))
    ? monthAt(input.asOfDate.slice(0, 7), 1)
    : input.asOfDate.slice(0, 7);
  const chainMonths: IsoMonth[] = [];
  for (let month = firstForecastMonth; month <= "2027-12"; month = monthAt(month, 1)) chainMonths.push(month);
  const chainResults = new Map<string, MonthlyScenarioRow>();

  for (const scenario of SCENARIOS) {
    let closing = input.openingBalance?.amountCents ?? null;
    let closingWithHiring = input.openingBalance?.amountCents ?? null;
    for (const month of chainMonths) {
      const assumption = assumptions.get(`${scenario}:${month}`);
      if (!assumption) {
        closing = null;
        closingWithHiring = null;
        continue;
      }
      const observed = sumEvents(assumption.events);
      const completeChange = assumption.sourceCoverage === "complete" ? observed : null;
      const hireActive = input.hiringWhatIf !== null
        && month >= input.hiringWhatIf.startMonth
        && (input.hiringWhatIf.endMonth === null || month <= input.hiringWhatIf.endMonth);
      const hiringAdjustmentCents = input.hiringWhatIf === null
        ? null
        : hireActive ? -(input.hiringWhatIf.monthlyEmployerCostPerEmployeeCents * BigInt(input.hiringWhatIf.headcount)) : 0n;
      const withHiringChange = completeChange === null || hiringAdjustmentCents === null
        ? null
        : completeChange + hiringAdjustmentCents;
      if (completeChange === null || closing === null) closing = null;
      else closing += completeChange;
      if (withHiringChange === null || closingWithHiring === null) closingWithHiring = null;
      else closingWithHiring += withHiringChange;
      if ((LONG_RANGE_PERIODS as readonly string[]).includes(month)) {
        chainResults.set(`${scenario}:${month}`, {
          scenario,
          sourceCoverage: assumption.sourceCoverage,
          observedCashChangeCents: observed,
          cashChangeCents: completeChange,
          cashByCategory: groupEvents(assumption.events),
          closingCashBalanceCents: closing,
          hiringAdjustmentCents,
          cashChangeWithHiringCents: withHiringChange,
          closingCashBalanceWithHiringCents: closingWithHiring,
          metadata: {
            kind: "scenario",
            scenario,
            sourceCoverage: assumption.sourceCoverage,
            openingBalance: input.openingBalance,
          },
        });
      }
    }
  }

  return {
    periods: LONG_RANGE_PERIODS.map((month) => ({
      month,
      byScenario: {
        low: chainResults.get(`low:${month}`) || makeMissingMonthlyRow("low", input.openingBalance),
        base: chainResults.get(`base:${month}`) || makeMissingMonthlyRow("base", input.openingBalance),
        high: chainResults.get(`high:${month}`) || makeMissingMonthlyRow("high", input.openingBalance),
      },
    })),
    metadata: {
      kind: "scenario",
      source: "explicit monthly assumptions",
      openingBalance: input.openingBalance,
      hiringWhatIf: input.hiringWhatIf,
    },
  };
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("denominator must be positive");
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  return sign * (quotient + (2n * remainder >= denominator ? 1n : 0n));
}

export function compareNominalUsingOfficialCpi(input: NominalCpiComparisonInput): NominalCpiComparisonResult {
  assertMonth(input.earlierMonth, "earlierMonth");
  assertMonth(input.laterMonth, "laterMonth");
  if (input.earlierMonth > input.laterMonth) throw new RangeError("earlierMonth must not follow laterMonth");
  assertBigint(input.earlierNominalCents, "earlierNominalCents");
  assertBigint(input.laterNominalCents, "laterNominalCents");
  const series = input.officialIndex;
  if (!series.publisher.trim() || !series.seriesName.trim() || !series.version.trim()) {
    throw new TypeError("official CPI publisher, seriesName, and version are required");
  }
  assertDate(series.publishedAt, "officialIndex.publishedAt");
  const points = new Map<IsoMonth, bigint>();
  for (const [index, point] of series.points.entries()) {
    assertMonth(point.month, `officialIndex.points[${index}].month`);
    assertBigint(point.indexValue, `officialIndex.points[${index}].indexValue`);
    if (point.indexValue <= 0n) throw new RangeError("CPI index values must be positive");
    if (points.has(point.month)) throw new TypeError(`duplicate CPI month ${point.month}`);
    points.set(point.month, point.indexValue);
  }
  const missingMonths = [input.earlierMonth, input.laterMonth].filter((month) => !points.has(month));
  const earlierIndex = points.get(input.earlierMonth);
  const laterIndex = points.get(input.laterMonth);
  const earlierAdjustedToLaterCents = earlierIndex === undefined || laterIndex === undefined
    ? null
    : roundedRatio(input.earlierNominalCents * laterIndex, earlierIndex);
  return {
    status: missingMonths.length ? "missing-index-point" : "available",
    earlierMonth: input.earlierMonth,
    laterMonth: input.laterMonth,
    earlierNominalCents: input.earlierNominalCents,
    laterNominalCents: input.laterNominalCents,
    nominalChangeCents: input.laterNominalCents - input.earlierNominalCents,
    earlierAdjustedToLaterCents,
    cpiAdjustedChangeCents: earlierAdjustedToLaterCents === null
      ? null
      : input.laterNominalCents - earlierAdjustedToLaterCents,
    missingMonths,
    metadata: {
      kind: "calculated",
      currency: "ARS",
      sourceCoverage: { earlierNominal: "complete", laterNominal: "complete" },
      officialIndex: {
        publisher: series.publisher,
        seriesName: series.seriesName,
        version: series.version,
        publishedAt: series.publishedAt,
      },
    },
  };
}

interface BacktestForecast {
  pointCents: bigint;
  actualCents: bigint;
  residualCents: bigint;
  interval: { lowerCents: bigint; upperCents: bigint } | null;
}

function trailingTwentyEightDayForecast(rows: readonly DailySalesObservation[], endExclusive: number): bigint {
  const total = rows.slice(endExclusive - 28, endExclusive).reduce((sum, row) => sum + row.netSalesCents, 0n);
  return roundedRatio(total, 4n);
}

function empiricalQuantile(values: readonly bigint[], numerator: bigint, denominator: bigint): bigint {
  const ordered = [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const rank = (numerator * BigInt(ordered.length) + denominator - 1n) / denominator;
  const index = Number(rank > 0n ? rank - 1n : 0n);
  return ordered[Math.min(index, ordered.length - 1)];
}

function calibratedInterval(pointCents: bigint, priorResiduals: readonly bigint[]) {
  if (priorResiduals.length < 10) return null;
  const lowerResidual = empiricalQuantile(priorResiduals, 1n, 10n);
  const upperResidual = empiricalQuantile(priorResiduals, 9n, 10n);
  const rawLower = pointCents + lowerResidual;
  const rawUpper = pointCents + upperResidual;
  return {
    lowerCents: rawLower < 0n ? 0n : rawLower,
    upperCents: rawUpper < 0n ? 0n : rawUpper,
  };
}

function unavailableForecast(
  reason: SevenDayAggregateForecastResult["forecast"]["unavailableReason"],
  input: SevenDayAggregateForecastInput,
  count: number,
): SevenDayAggregateForecastResult {
  return {
    forecast: { available: false, unavailableReason: reason, asOfDate: null, from: null, through: null, pointCents: null, interval80: null },
    outOfSample: {
      forecastOrigins: 0,
      maeCents: null,
      biasCents: null,
      intervalTargetPercent: null,
      intervalCoverage: null,
    },
    metadata: {
      kind: "calculated",
      currency: "ARS",
      sourceCoverage: { dailySales: input.sourceCoverage },
      method: "previous-28-day-average-scaled-to-seven-days",
      dailyObservationCount: count,
      minimumHistoryDays: 28,
      minimumCalibrationOrigins: 10,
      minimumMetricOrigins: 3,
    },
  };
}

/**
 * Rolling-origin 7-day aggregate forecast. Each origin advances by seven days;
 * the point estimate scales the prior 28-day sales total by 1/4. Prediction
 * bounds use empirical 10th/90th percentiles of earlier OOS residuals only.
 */
export function forecastSevenDayAggregate(input: SevenDayAggregateForecastInput): SevenDayAggregateForecastResult {
  assertCoverage(input.sourceCoverage, "sourceCoverage");
  const rows = [...input.dailySales].sort((a, b) => a.date.localeCompare(b.date));
  for (const [index, row] of rows.entries()) {
    assertDate(row.date, `dailySales[${index}].date`);
    assertBigint(row.netSalesCents, `dailySales[${index}].netSalesCents`);
    if (row.netSalesCents < 0n) throw new RangeError("daily net sales cannot be negative");
    if (index > 0 && row.date === rows[index - 1].date) throw new TypeError(`duplicate daily sales date ${row.date}`);
  }
  if (input.sourceCoverage !== "complete") return unavailableForecast("incomplete-source", input, rows.length);
  for (let index = 1; index < rows.length; index++) {
    if (dateAt(rows[index - 1].date, 1) !== rows[index].date) return unavailableForecast("date-gap", input, rows.length);
  }
  if (rows.length < 28) return unavailableForecast("insufficient-history", input, rows.length);

  const backtests: BacktestForecast[] = [];
  const priorResiduals: bigint[] = [];
  for (let origin = 28; origin + 7 <= rows.length; origin += 7) {
    const pointCents = trailingTwentyEightDayForecast(rows, origin);
    const actualCents = rows.slice(origin, origin + 7).reduce((sum, row) => sum + row.netSalesCents, 0n);
    const interval = calibratedInterval(pointCents, priorResiduals);
    const residualCents = actualCents - pointCents;
    backtests.push({ pointCents, actualCents, residualCents, interval });
    priorResiduals.push(residualCents);
  }

  const latestPointCents = trailingTwentyEightDayForecast(rows, rows.length);
  const latestInterval = calibratedInterval(latestPointCents, priorResiduals);
  const maeCents = backtests.length >= 3
    ? roundedRatio(backtests.reduce((sum, row) => sum + (row.residualCents < 0n ? -row.residualCents : row.residualCents), 0n), BigInt(backtests.length))
    : null;
  const biasCents = backtests.length >= 3
    ? roundedRatio(backtests.reduce((sum, row) => sum + row.residualCents, 0n), BigInt(backtests.length))
    : null;
  const intervalBacktests = backtests.filter((row) => row.interval !== null);
  const coveredOrigins = intervalBacktests.filter((row) => row.actualCents >= row.interval!.lowerCents && row.actualCents <= row.interval!.upperCents).length;
  const observedCoverageBasisPoints = intervalBacktests.length >= 5
    ? Number(roundedRatio(BigInt(coveredOrigins) * 10_000n, BigInt(intervalBacktests.length)))
    : null;
  const asOfDate = rows.at(-1)!.date;
  return {
    forecast: {
      available: true,
      unavailableReason: null,
      asOfDate,
      from: dateAt(asOfDate, 1),
      through: dateAt(asOfDate, 7),
      pointCents: latestPointCents,
      interval80: latestInterval ? { ...latestInterval, calibrationOrigins: priorResiduals.length } : null,
    },
    outOfSample: {
      forecastOrigins: backtests.length,
      maeCents,
      biasCents,
      intervalTargetPercent: latestInterval ? 80 : null,
      intervalCoverage: intervalBacktests.length >= 5
        ? { coveredOrigins, scoredOrigins: intervalBacktests.length, observedCoverageBasisPoints: observedCoverageBasisPoints! }
        : null,
    },
    metadata: {
      kind: "calculated",
      currency: "ARS",
      sourceCoverage: { dailySales: input.sourceCoverage },
      method: "previous-28-day-average-scaled-to-seven-days",
      dailyObservationCount: rows.length,
      minimumHistoryDays: 28,
      minimumCalibrationOrigins: 10,
      minimumMetricOrigins: 3,
    },
  };
}
