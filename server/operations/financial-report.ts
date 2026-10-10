import type { FinancialCoverageState, FinancialReportCoverage, FinancialReportCurrency, FinancialStatementsBuildInput } from "../../shared/operations/financial-report.js";
import { buildFinancialStatementsReport } from "../../shared/operations/financial-report.js";
import { queryFinancialReportSources, type ReportScope } from "./report-queries.js";

export type FinancialReportSources = Awaited<ReturnType<typeof queryFinancialReportSources>>;
type MoneyBucket = { currency: string | null; minor: string };

function moneyFor(rows: readonly MoneyBucket[] | null | undefined, currency: FinancialReportCurrency): string | null {
  if (rows == null) return null;
  const row = rows.find(candidate => candidate.currency === currency);
  return row?.minor ?? "0";
}

function pnlMoneyFor(
  rows: readonly MoneyBucket[] | null | undefined,
  currency: FinancialReportCurrency,
  absentBucketAttested: boolean,
): string | null {
  if (rows == null) return null;
  if (rows.some(candidate => candidate.currency === null)) return null;
  const row = rows.find(candidate => candidate.currency === currency);
  return row?.minor ?? (absentBucketAttested ? "0" : null);
}

function validMinor(value: string | null): value is string {
  return value !== null && /^-?(0|[1-9]\d*)$/.test(value);
}

function subtractMinor(left: string | null, right: string | null): string | null {
  return validMinor(left) && validMinor(right) ? (BigInt(left) - BigInt(right)).toString() : null;
}

function reportCoverage(
  section: FinancialReportCoverage["section"],
  source: string,
  state: FinancialCoverageState,
  knownCount: number | null,
  expectedCount: number | null,
  queryComplete: boolean | null,
  reason: string | null,
): FinancialReportCoverage {
  return { section, source, state, knownCount, expectedCount, queryComplete, reason };
}

function cashFlowFor(sources: FinancialReportSources, currency: FinancialReportCurrency, from: string, to: string) {
  const selectedAccounts = sources.cashFlow.accounts.filter(account => account.currency === currency);
  const selectedKinds = sources.cashFlow.eventKinds.filter(row => row.currency === currency);
  const openingAccountsComplete = selectedAccounts.length > 0 && selectedAccounts.every(account =>
    account.verified
    && account.openingApproved
    && account.openingEventCount === 1
    && account.openingDate !== null
    && account.openingDate < from
    && account.openingEventMinor === account.openingMinor
    && account.openingCurrencyMismatchCount === 0
    && account.prePeriodCurrencyMismatchCount === 0,
  );
  const closingAccountsComplete = selectedAccounts.length > 0 && selectedAccounts.every(account =>
    account.verified
    && account.openingApproved
    && account.reconciliation?.date === to
    && account.reconciliation.differenceMinor === "0"
    && account.reconciliation.countedMinor === account.reconciliation.calculatedMinor,
  );
  const eventCurrencyComplete = selectedKinds.every(row => row.currencyMismatchCount === 0);
  const eventTotals = new Map(selectedKinds.map(row => [row.kind, row]));
  const amountFor = (kind: string, direction: "inMinor" | "outMinor") => eventTotals.get(kind)?.[direction] ?? "0";
  const sumKinds = (kinds: readonly string[], direction: "inMinor" | "outMinor") =>
    kinds.reduce((sum, kind) => sum + BigInt(amountFor(kind, direction)), 0n).toString();

  const collections = sumKinds(["collection"], "inMinor");
  const payments = sumKinds(["collection_reversal", "purchase", "courier_fee", "operating_expense", "credit_refund", "asset_purchase"], "outMinor");
  const transferIn = sumKinds(["transfer", "rendition"], "inMinor");
  const transferOut = sumKinds(["transfer", "rendition"], "outMinor");
  const financingIn = sumKinds(["owner_contribution"], "inMinor");
  const financingOut = sumKinds(["owner_withdrawal"], "outMinor");
  const fxIn = sumKinds(["fx"], "inMinor");
  const fxOut = sumKinds(["fx"], "outMinor");
  const knownKinds = new Set([
    "collection", "collection_reversal", "purchase", "courier_fee", "operating_expense", "credit_refund", "asset_purchase",
    "transfer", "rendition", "owner_contribution", "owner_withdrawal", "fx",
  ]);
  const unclassifiedRows = selectedKinds.filter(row => !knownKinds.has(row.kind));
  const eventKindsComplete = eventCurrencyComplete && unclassifiedRows.length === 0;
  const unclassifiedIn = unclassifiedRows.reduce((sum, row) => sum + BigInt(row.inMinor), 0n).toString();
  const unclassifiedOut = unclassifiedRows.reduce((sum, row) => sum + BigInt(row.outMinor), 0n).toString();
  const netMovement = selectedKinds.reduce((sum, row) => sum + BigInt(row.inMinor) - BigInt(row.outMinor), 0n).toString();
  const opening = openingAccountsComplete
    ? selectedAccounts.reduce((sum, account) => sum + BigInt(account.prePeriodBalanceMinor), 0n).toString()
    : null;
  const closing = closingAccountsComplete
    ? selectedAccounts.reduce((sum, account) => sum + BigInt(account.reconciliation!.countedMinor), 0n).toString()
    : null;
  const movementReconciles = opening !== null && closing !== null && BigInt(opening) + BigInt(netMovement) === BigInt(closing);
  const fullyReconciled = openingAccountsComplete && closingAccountsComplete && eventKindsComplete && movementReconciles;
  const reasons = [...new Set([
    ...(selectedAccounts.length ? [] : ["no-verified-club-account-for-currency"]),
    ...(!openingAccountsComplete ? ["opening-not-approved-before-period-or-ledger-inconsistent"] : []),
    ...(!closingAccountsComplete ? ["no-zero-variance-reconciliation-on-period-end"] : []),
    ...(!eventCurrencyComplete ? ["ledger-leg-currency-mismatch"] : []),
    ...(selectedKinds.some(row => !knownKinds.has(row.kind)) ? ["unclassified-ledger-event-kind"] : []),
    ...(opening !== null && closing !== null && !movementReconciles ? ["opening-plus-net-movement-does-not-match-closing"] : []),
  ])];
  const categoryAmount = (value: string) => fullyReconciled ? value : null;
  return {
    value: {
      state: fullyReconciled ? "complete" as const : selectedKinds.length || selectedAccounts.length ? "partial" as const : "unknown" as const,
      openingBalanceMinor: opening,
      openingDate: openingAccountsComplete ? from : null,
      openingConfirmed: openingAccountsComplete,
      collectionsMinor: categoryAmount(collections),
      paymentsMinor: categoryAmount(payments),
      transferInMinor: categoryAmount(transferIn),
      transferOutMinor: categoryAmount(transferOut),
      financingInMinor: categoryAmount(financingIn),
      financingOutMinor: categoryAmount(financingOut),
      fxInMinor: categoryAmount(fxIn),
      fxOutMinor: categoryAmount(fxOut),
      unclassifiedInMinor: categoryAmount(unclassifiedIn),
      unclassifiedOutMinor: categoryAmount(unclassifiedOut),
      netMovementMinor: fullyReconciled ? netMovement : null,
      closingBalanceMinor: closing,
      closingConfirmed: closingAccountsComplete,
      reasons,
    },
    coverage: [
      reportCoverage("cashFlow", "club-ledger", eventKindsComplete ? "complete" : "partial", sources.cashFlow.eventKinds.reduce((sum, row) => sum + row.eventCount, 0), null, true, !eventCurrencyComplete ? "ledger-leg-currency-mismatch" : unclassifiedRows.length ? "unclassified-ledger-event-kind" : null),
      reportCoverage("cashFlow", "reconciled-opening", openingAccountsComplete ? "complete" : selectedAccounts.length ? "partial" : "unknown", openingAccountsComplete ? selectedAccounts.length : null, selectedAccounts.length || null, openingAccountsComplete, openingAccountsComplete ? null : "opening-not-approved-before-period-or-ledger-inconsistent"),
      reportCoverage("cashFlow", "reconciled-closing", closingAccountsComplete ? "complete" : selectedAccounts.length ? "partial" : "unknown", closingAccountsComplete ? selectedAccounts.length : null, selectedAccounts.length || null, closingAccountsComplete, closingAccountsComplete ? null : "no-zero-variance-reconciliation-on-period-end"),
    ],
  };
}

function obligationsFor(sources: FinancialReportSources, currency: FinancialReportCurrency) {
  const metrics = sources.obligations.metrics as {
    horizon: { from: string; through: string; weeks: 13 };
    sourceCoverage: "complete" | "partial" | "unknown";
    weekly: null | Array<{
      weekStart: string;
      weekEnd: string;
      verifiedCount: number;
      unverifiedCount: number;
      verifiedOutstandingByCurrency: MoneyBucket[];
      outstandingByCurrency: MoneyBucket[];
    }>;
    payableSummaryComplete: boolean;
    payableRowsComplete: boolean;
    visiblePayableRows: number;
  };
  const complete = metrics.sourceCoverage === "complete" && metrics.payableSummaryComplete && metrics.payableRowsComplete && metrics.weekly !== null;
  const hasObservedObligations = (metrics.weekly ?? []).some(week => week.verifiedCount > 0 || week.unverifiedCount > 0);
  const weeks = metrics.weekly?.map(week => {
    const verified = moneyFor(week.verifiedOutstandingByCurrency, currency);
    const total = moneyFor(week.outstandingByCurrency, currency);
    const unverified = subtractMinor(total, verified);
    return {
      weekStart: week.weekStart,
      weekEnd: week.weekEnd,
      verifiedObligationsMinor: complete || verified !== "0" ? verified : null,
      unverifiedObligationsMinor: complete || unverified !== "0" ? unverified : null,
      verifiedCount: week.verifiedCount,
      unverifiedCount: week.unverifiedCount,
    };
  }) ?? null;
  const coverageState: FinancialCoverageState = complete ? "complete" : hasObservedObligations ? "partial" : metrics.sourceCoverage === "unknown" ? "unknown" : "unverified";
  return {
    value: {
      state: complete ? "complete" as const : hasObservedObligations ? "partial" as const : "unknown" as const,
      horizon: metrics.horizon,
      weeks: complete || hasObservedObligations ? weeks : null,
      inflowsForecasted: false as const,
      openingBalanceMinor: null as null,
      closingBalanceMinor: null as null,
      reasons: complete ? [] : [metrics.sourceCoverage === "unknown" ? "no-approved-payable-period-attestation" : "payable-population-or-period-attestation-incomplete"],
    },
    coverage: [reportCoverage(
      "obligations13Weeks", "verified-obligations", coverageState,
      metrics.visiblePayableRows, metrics.payableRowsComplete ? metrics.visiblePayableRows : null,
      metrics.payableSummaryComplete && metrics.payableRowsComplete,
      complete ? null : metrics.sourceCoverage === "unknown" ? "no-approved-payable-period-attestation" : "payable-population-or-period-attestation-incomplete",
    )],
  };
}

/** Convert the canonical report inputs into the public statement without combining currencies or guessing missing periods. */
export async function queryFinancialStatementsReport(
  input: { from: string; to: string; cutoffDate: string; currency: FinancialReportCurrency },
  scope: ReportScope = {},
): Promise<ReturnType<typeof buildFinancialStatementsReport>> {
  const sources = await queryFinancialReportSources({ from: input.from, to: input.to }, scope);
  return buildFinancialStatementsFromSources(sources, input);
}

function isClosedFullCalendarMonth(from: string, to: string, cutoffDate: string): boolean {
  if (!from.endsWith("-01") || from.slice(0, 7) !== to.slice(0, 7) || to >= cutoffDate) return false;
  const [year, month] = to.slice(0, 7).split("-").map(Number);
  const finalDay = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return Number(to.slice(8, 10)) === finalDay;
}

/** Pure production projection used after the same-snapshot reader and by focused contract tests. */
export function buildFinancialStatementsFromSources(
  sources: FinancialReportSources,
  input: { from: string; to: string; cutoffDate: string; currency: FinancialReportCurrency },
): ReturnType<typeof buildFinancialStatementsReport> {
  const sales = sources.sales.metrics as {
    historicalDelivery: { saleCount: number };
  };
  const product = sources.product.metrics as {
    lineBasisRevenueByCurrency: MoneyBucket[] | null;
    lineBasisGrossContributionBeforeFixedCostsByCurrency: MoneyBucket[] | null;
    productSourceRowsComplete: boolean;
    deliveredLineCount: number;
    pendingAppSheetInvoices: { count: number };
    allocationCoverage: { soldLineCount: number; linesWithSoldLotAllocation: number; missingAllocationLineCount: number; allocationExceptionCount: number; revenueExceptionLineCount: number };
    approvedAccruedOperatingCostsByCurrency: MoneyBucket[] | null;
    recognizedDeliveryAndSurchargeByCurrency: MoneyBucket[];
    managementCoverage: { sourcePeriodCompletenessAttested: boolean; sourcePeriodAttestation: { period?: string; state?: string } | null; arithmeticCompleteForObservedRecords: boolean; unresolvedChargeOrderCount: number; pendingAppSheetInvoiceCount: number; pendingCostCount: number | null; classifiedCostCount: number | null; costQueryComplete: boolean | null; costClassificationCoverage?: { state: "complete" | "partial"; classifiedRows: number; unresolvedRows: number; variableRows: number; fixedRows: number; actualFixedOperatingCostsByCurrency: MoneyBucket[] } | null; reason: string | null };
    fixedCosts: { amountByCurrency: MoneyBucket[] | null; reason: string | null };
  };
  const expenses = sources.expenses.metrics as { counts: { historicalExpenseRows: number; compatibilityExpenseRows: number } };
  const attestation = product.managementCoverage.sourcePeriodAttestation;
  const sourcePeriodAttested = product.managementCoverage.sourcePeriodCompletenessAttested === true
    && attestation?.state === "attested"
    && attestation.period === input.from.slice(0, 7)
    && input.to.slice(0, 7) === input.from.slice(0, 7)
    && isClosedFullCalendarMonth(input.from, input.to, input.cutoffDate);
  const periodComplete = isClosedFullCalendarMonth(input.from, input.to, input.cutoffDate);
  const periodReason = periodComplete ? null : "period-is-not-a-closed-calendar-month-before-cutoff";
  const netSalesObserved = pnlMoneyFor(product.lineBasisRevenueByCurrency, input.currency, sourcePeriodAttested);
  const grossProfitObserved = pnlMoneyFor(product.lineBasisGrossContributionBeforeFixedCostsByCurrency, input.currency, sourcePeriodAttested);
  const costOfGoodsSoldObserved = subtractMinor(netSalesObserved, grossProfitObserved);
  const operatingExpenseObserved = periodComplete
    ? pnlMoneyFor(product.approvedAccruedOperatingCostsByCurrency, input.currency, sourcePeriodAttested)
    : null;
  const otherIncomeObserved = pnlMoneyFor(product.recognizedDeliveryAndSurchargeByCurrency, input.currency, sourcePeriodAttested);
  const productsComplete = product.productSourceRowsComplete
    && product.lineBasisRevenueByCurrency !== null
    && product.lineBasisGrossContributionBeforeFixedCostsByCurrency !== null
    && product.pendingAppSheetInvoices.count === 0
    && sales.historicalDelivery.saleCount === 0
    && product.allocationCoverage.missingAllocationLineCount === 0
    && product.allocationCoverage.allocationExceptionCount === 0
    && product.allocationCoverage.revenueExceptionLineCount === 0;
  const otherIncomeComplete = product.managementCoverage.unresolvedChargeOrderCount === 0
    && product.managementCoverage.pendingAppSheetInvoiceCount === 0;
  const historicalExpenseCount = expenses.counts.historicalExpenseRows + expenses.counts.compatibilityExpenseRows;
  const operatingExpenseComplete = product.managementCoverage.pendingCostCount === 0
    && product.managementCoverage.costQueryComplete === true
    && product.managementCoverage.costClassificationCoverage?.state === "complete"
    && historicalExpenseCount === 0;
  const cashFlow = cashFlowFor(sources, input.currency, input.from, input.to);
  const obligations = obligationsFor(sources, input.currency);
  const incomeInput: FinancialStatementsBuildInput = {
    from: input.from,
    to: input.to,
    cutoffDate: input.cutoffDate,
    currency: input.currency,
    periodComplete,
    periodReason: periodReason ?? (sourcePeriodAttested ? null : "source-period-completeness-not-attested"),
    sourcePeriodAttested,
    income: {
      netSales: { observedMinor: netSalesObserved, complete: productsComplete, reason: productsComplete ? null : "delivered-product-or-historical-sales-coverage-incomplete" },
      costOfGoodsSold: { observedMinor: costOfGoodsSoldObserved, complete: productsComplete && costOfGoodsSoldObserved !== null, reason: productsComplete ? "allocated-lot-cost-coverage-incomplete" : "delivered-product-or-lot-cost-coverage-incomplete" },
      operatingExpenses: { observedMinor: operatingExpenseObserved, complete: operatingExpenseComplete, reason: operatingExpenseComplete ? null : !periodComplete ? "month-accrual-not-allocatable-to-partial-range" : historicalExpenseCount ? "historical-expense-currency-or-coverage-not-certified" : product.managementCoverage.pendingCostCount ? "unverified-or-unclassified-operating-obligations" : "actual-operating-expense-coverage-incomplete" },
      otherOperatingIncome: { observedMinor: otherIncomeObserved, complete: otherIncomeComplete, reason: otherIncomeComplete ? null : product.managementCoverage.reason ?? "delivery-and-surcharge-coverage-incomplete" },
    },
    cashFlow: cashFlow.value,
    obligations13Weeks: obligations.value,
    coverage: [],
  };
  const lineBasisCoverage: FinancialReportCoverage[] = [
    reportCoverage("incomeStatement", "delivered-products", product.productSourceRowsComplete ? "unverified" : "partial", product.deliveredLineCount, product.productSourceRowsComplete ? product.deliveredLineCount : null, product.productSourceRowsComplete, product.productSourceRowsComplete ? "source-period-attestation-required" : "product-source-row-limit-or-query-incomplete"),
    reportCoverage("incomeStatement", "allocated-lot-costs", product.lineBasisGrossContributionBeforeFixedCostsByCurrency !== null ? "unverified" : "partial", product.allocationCoverage.linesWithSoldLotAllocation, product.allocationCoverage.soldLineCount, product.lineBasisGrossContributionBeforeFixedCostsByCurrency !== null, product.lineBasisGrossContributionBeforeFixedCostsByCurrency !== null ? "source-period-attestation-required" : "lot-allocation-or-currency-coverage-incomplete"),
    reportCoverage("incomeStatement", "delivery-surcharges", otherIncomeComplete ? "unverified" : "partial", null, null, otherIncomeComplete, product.managementCoverage.reason),
    reportCoverage("incomeStatement", "approved-variable-and-fixed-operating-obligations", operatingExpenseComplete ? sourcePeriodAttested ? "complete" : "unverified" : product.managementCoverage.pendingCostCount ? "partial" : "unverified", product.managementCoverage.classifiedCostCount, product.managementCoverage.pendingCostCount === 0 && product.managementCoverage.classifiedCostCount !== null ? product.managementCoverage.classifiedCostCount : null, product.managementCoverage.costQueryComplete === true && product.managementCoverage.pendingCostCount === 0, operatingExpenseComplete ? null : product.managementCoverage.pendingCostCount ? "unverified-or-unclassified-costs" : historicalExpenseCount ? "historical-expense-currency-or-coverage-not-certified" : "source-period-attestation-required"),
    reportCoverage("incomeStatement", "approved-fixed-cost-schedule", "excluded", null, null, null, "schedule-is-not-an-actual-expense"),
    reportCoverage("incomeStatement", "historical-delivery-sales", sales.historicalDelivery.saleCount === 0 ? "unverified" : "partial", sales.historicalDelivery.saleCount, sales.historicalDelivery.saleCount, true, sales.historicalDelivery.saleCount === 0 ? "source-period-attestation-required" : "historical-sales-currency-unknown"),
    reportCoverage("incomeStatement", "historical-and-compatibility-expenses", historicalExpenseCount === 0 && sourcePeriodAttested ? "complete" : historicalExpenseCount === 0 ? "unverified" : "partial", historicalExpenseCount, historicalExpenseCount, historicalExpenseCount === 0, historicalExpenseCount === 0 ? (sourcePeriodAttested ? null : "source-period-attestation-required") : "historical-expense-currency-or-coverage-not-certified"),
    ...(sourcePeriodAttested ? [] : [reportCoverage("incomeStatement", "source-period-attestation", "unverified", null, null, false, "source-period-completeness-not-attested")]),
  ];
  incomeInput.cashFlow = cashFlow.value;
  incomeInput.obligations13Weeks = obligations.value;
  incomeInput.coverage = [...lineBasisCoverage, ...cashFlow.coverage, ...obligations.coverage];
  return buildFinancialStatementsReport(incomeInput);
}
