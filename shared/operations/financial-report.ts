export const financialReportCurrencies = ["ARS", "USD"] as const;
export type FinancialReportCurrency = (typeof financialReportCurrencies)[number];

export type FinancialReportState = "complete" | "partial" | "unknown";
export type FinancialCoverageState = "complete" | "partial" | "unverified" | "unknown" | "excluded";

export interface FinancialReportCoverage {
  section: "incomeStatement" | "cashFlow" | "obligations13Weeks";
  source: string;
  state: FinancialCoverageState;
  knownCount: number | null;
  expectedCount: number | null;
  queryComplete: boolean | null;
  reason: string | null;
}

export interface FinancialStatementAmount {
  /** Certified amount for this line, withheld when its source is incomplete. */
  amountMinor: string | null;
  /** Exact observed subtotal, which may be partial and is never promoted to a total. */
  observedMinor: string | null;
  state: FinancialReportState;
  reason: string | null;
}

export interface FinancialStatementsReport {
  report: "operations-financial-statements";
  period: { from: string; to: string; cutoffDate: string; timeZone: "America/Argentina/Buenos_Aires" };
  currency: FinancialReportCurrency;
  methods: {
    incomeStatement: string;
    cashFlow: string;
    obligations13Weeks: string;
  };
  incomeStatement: {
    state: FinancialReportState;
    sourcePeriodAttested: boolean;
    netSales: FinancialStatementAmount;
    costOfGoodsSold: FinancialStatementAmount;
    grossProfit: FinancialStatementAmount;
    operatingExpenses: FinancialStatementAmount;
    otherOperatingIncome: FinancialStatementAmount;
    operatingResult: FinancialStatementAmount;
    scenarioBaseComplete: boolean;
    scenarioBaseReason: string | null;
    reasons: string[];
  };
  cashFlow: {
    state: FinancialReportState;
    openingBalanceMinor: string | null;
    openingDate: string | null;
    openingConfirmed: boolean;
    collectionsMinor: string | null;
    paymentsMinor: string | null;
    transferInMinor: string | null;
    transferOutMinor: string | null;
    financingInMinor: string | null;
    financingOutMinor: string | null;
    fxInMinor: string | null;
    fxOutMinor: string | null;
    unclassifiedInMinor: string | null;
    unclassifiedOutMinor: string | null;
    netMovementMinor: string | null;
    closingBalanceMinor: string | null;
    closingConfirmed: boolean;
    reasons: string[];
  };
  obligations13Weeks: {
    state: FinancialReportState;
    horizon: { from: string; through: string; weeks: 13 };
    weeks: Array<{
      weekStart: string;
      weekEnd: string;
      verifiedObligationsMinor: string | null;
      unverifiedObligationsMinor: string | null;
      verifiedCount: number;
      unverifiedCount: number;
    }> | null;
    inflowsForecasted: false;
    openingBalanceMinor: null;
    closingBalanceMinor: null;
    reasons: string[];
  };
  coverage: FinancialReportCoverage[];
}

export interface FinancialStatementComponentInput {
  observedMinor: string | null;
  complete: boolean;
  reason: string | null;
}

export interface FinancialStatementsBuildInput {
  from: string;
  to: string;
  cutoffDate: string;
  currency: FinancialReportCurrency;
  periodComplete: boolean;
  periodReason: string | null;
  sourcePeriodAttested: boolean;
  income: {
    netSales: FinancialStatementComponentInput;
    costOfGoodsSold: FinancialStatementComponentInput;
    operatingExpenses: FinancialStatementComponentInput;
    otherOperatingIncome: FinancialStatementComponentInput;
  };
  cashFlow: FinancialStatementsReport["cashFlow"];
  obligations13Weeks: FinancialStatementsReport["obligations13Weeks"];
  coverage: FinancialReportCoverage[];
}

function validMinor(value: string | null): value is string {
  return value !== null && /^-?(0|[1-9]\d*)$/.test(value);
}

function amount(
  observedMinor: string | null,
  complete: boolean,
  reason: string | null,
): FinancialStatementAmount {
  const valid = validMinor(observedMinor);
  const certified = complete && valid;
  return {
    amountMinor: certified ? observedMinor : null,
    observedMinor: valid ? observedMinor : null,
    state: certified ? "complete" : valid ? "partial" : "unknown",
    reason: certified ? null : reason ?? (valid ? "source-coverage-incomplete" : "amount-not-observed"),
  };
}

/** Builds a conservative statement using exact integer minor-unit arithmetic. */
export function buildFinancialStatementsReport(input: FinancialStatementsBuildInput): FinancialStatementsReport {
  const fullPeriod = input.periodComplete && input.sourcePeriodAttested;
  const line = (component: FinancialStatementComponentInput) => amount(
    component.observedMinor,
    fullPeriod && component.complete,
    component.reason ?? input.periodReason,
  );
  const netSales = line(input.income.netSales);
  const costOfGoodsSold = line(input.income.costOfGoodsSold);
  const operatingExpenses = line(input.income.operatingExpenses);
  const otherOperatingIncome = line(input.income.otherOperatingIncome);
  const grossObserved = validMinor(netSales.observedMinor) && validMinor(costOfGoodsSold.observedMinor)
    ? (BigInt(netSales.observedMinor) - BigInt(costOfGoodsSold.observedMinor)).toString()
    : null;
  const grossComplete = netSales.amountMinor !== null && costOfGoodsSold.amountMinor !== null;
  const grossProfit = amount(
    grossObserved,
    grossComplete,
    netSales.reason ?? costOfGoodsSold.reason ?? "revenue-or-cost-of-goods-sold-incomplete",
  );
  const resultObserved = [netSales.observedMinor, costOfGoodsSold.observedMinor, operatingExpenses.observedMinor, otherOperatingIncome.observedMinor]
    .every(validMinor)
    ? (BigInt(netSales.observedMinor!) - BigInt(costOfGoodsSold.observedMinor!) - BigInt(operatingExpenses.observedMinor!) + BigInt(otherOperatingIncome.observedMinor!)).toString()
    : null;
  const resultComplete = [netSales.amountMinor, costOfGoodsSold.amountMinor, operatingExpenses.amountMinor, otherOperatingIncome.amountMinor]
    .every(value => value !== null);
  const operatingResult = amount(
    resultObserved,
    resultComplete,
    input.periodReason ?? input.income.netSales.reason ?? input.income.costOfGoodsSold.reason
      ?? input.income.operatingExpenses.reason ?? input.income.otherOperatingIncome.reason
      ?? "required-income-statement-source-incomplete",
  );
  const reasons = [...new Set([
    ...[netSales, costOfGoodsSold, grossProfit, operatingExpenses, otherOperatingIncome, operatingResult]
      .map(value => value.reason).filter((value): value is string => value !== null),
  ])];
  const incomeState: FinancialReportState = operatingResult.state === "complete"
    ? "complete"
    : [netSales, costOfGoodsSold, grossProfit, operatingExpenses, otherOperatingIncome].some(value => value.observedMinor !== null)
      ? "partial"
      : "unknown";
  const scenarioBaseComplete = incomeState === "complete";
  const sourceReason = reasons[0] ?? null;
  return {
    report: "operations-financial-statements",
    period: { from: input.from, to: input.to, cutoffDate: input.cutoffDate, timeZone: "America/Argentina/Buenos_Aires" },
    currency: input.currency,
    methods: {
      incomeStatement: "delivered-net-product-lines; actual-lot-cost; verified-variable-and-fixed-operating-payables-by-accrual-month; recognized-delivery-and-surcharge; exact-minor-units",
      cashFlow: "club-ledger-events-by-kind; inactive-historical-accounts-included; custody-excluded; no-currency-conversion; unknown-openings-and-closes-withheld",
      obligations13Weeks: "verified-and-unverified-open-payables-by-due-week; no-revenue-forecast; no-closing-balance",
    },
    incomeStatement: {
      state: incomeState,
      sourcePeriodAttested: input.sourcePeriodAttested,
      netSales,
      costOfGoodsSold,
      grossProfit,
      operatingExpenses,
      otherOperatingIncome,
      operatingResult,
      scenarioBaseComplete,
      scenarioBaseReason: scenarioBaseComplete ? null : sourceReason ?? "financial-source-coverage-incomplete",
      reasons,
    },
    cashFlow: input.cashFlow,
    obligations13Weeks: input.obligations13Weeks,
    coverage: input.coverage,
  };
}
