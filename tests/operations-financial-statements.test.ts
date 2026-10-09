import assert from "node:assert/strict";
import test from "node:test";
import { parseFinancialStatementParams } from "../server/operations/report-definitions.js";
import {
  buildFinancialStatementsFromSources,
  type FinancialReportSources,
} from "../server/operations/financial-report.js";

type MoneyBucket = { currency: "ARS" | "USD"; minor: string };
type ProductMetricsFixture = {
  lineBasisRevenueByCurrency: MoneyBucket[] | null;
  lineBasisGrossContributionBeforeFixedCostsByCurrency: MoneyBucket[] | null;
  productSourceRowsComplete: boolean;
  deliveredLineCount: number;
  pendingAppSheetInvoices: { count: number };
  allocationCoverage: {
    soldLineCount: number;
    linesWithSoldLotAllocation: number;
    missingAllocationLineCount: number;
    allocationExceptionCount: number;
    revenueExceptionLineCount: number;
  };
  approvedAccruedOperatingCostsByCurrency: MoneyBucket[] | null;
  recognizedDeliveryAndSurchargeByCurrency: MoneyBucket[];
  managementCoverage: {
    sourcePeriodCompletenessAttested: boolean;
    sourcePeriodAttestation: { period?: string; state?: string } | null;
    arithmeticCompleteForObservedRecords: boolean;
    unresolvedChargeOrderCount: number;
    pendingAppSheetInvoiceCount: number;
    pendingCostCount: number | null;
    classifiedCostCount: number | null;
    costQueryComplete: boolean | null;
    costClassificationCoverage: {
      state: "complete" | "partial";
      classifiedRows: number;
      unresolvedRows: number;
      variableRows: number;
      fixedRows: number;
      actualFixedOperatingCostsByCurrency: MoneyBucket[];
    } | null;
    reason: string | null;
  };
  fixedCosts: { amountByCurrency: MoneyBucket[] | null; reason: string | null };
};

type CashFlowFixture = FinancialReportSources["cashFlow"];

const from = "2026-09-01";
const to = "2026-09-30";
const cutoffDate = "2026-10-08";
const arsUsdBuckets = (ars: string, usd: string): MoneyBucket[] => [
  { currency: "ARS", minor: ars },
  { currency: "USD", minor: usd },
];

const productMetrics: ProductMetricsFixture = {
  lineBasisRevenueByCurrency: arsUsdBuckets("10000", "90000"),
  lineBasisGrossContributionBeforeFixedCostsByCurrency: arsUsdBuckets("4000", "75000"),
  productSourceRowsComplete: true,
  deliveredLineCount: 1,
  pendingAppSheetInvoices: { count: 0 },
  allocationCoverage: {
    soldLineCount: 1,
    linesWithSoldLotAllocation: 1,
    missingAllocationLineCount: 0,
    allocationExceptionCount: 0,
    revenueExceptionLineCount: 0,
  },
  // ARS 700 + 2,500 actual accrued fixed cost; USD 500 + 2,000.
  approvedAccruedOperatingCostsByCurrency: arsUsdBuckets("3200", "2500"),
  recognizedDeliveryAndSurchargeByCurrency: arsUsdBuckets("500", "1000"),
  managementCoverage: {
    sourcePeriodCompletenessAttested: true,
    sourcePeriodAttestation: { period: "2026-09", state: "attested" },
    arithmeticCompleteForObservedRecords: true,
    unresolvedChargeOrderCount: 0,
    pendingAppSheetInvoiceCount: 0,
    pendingCostCount: 0,
    classifiedCostCount: 4,
    costQueryComplete: true,
    costClassificationCoverage: {
      state: "complete",
      classifiedRows: 4,
      unresolvedRows: 0,
      variableRows: 2,
      fixedRows: 2,
      actualFixedOperatingCostsByCurrency: arsUsdBuckets("2500", "2000"),
    },
    reason: null,
  },
  // The approved schedule is deliberately unlike actual accrued expenses.
  fixedCosts: { amountByCurrency: arsUsdBuckets("999999", "888888"), reason: null },
};

const cashFlow: CashFlowFixture = {
  accounts: [{
    accountId: "fixture-ars",
    currency: "ARS",
    verified: true,
    openingApproved: true,
    openingMinor: "10000",
    openingEventCount: 1,
    openingDate: "2026-08-31",
    openingEventMinor: "10000",
    openingCurrencyMismatchCount: 0,
    prePeriodBalanceMinor: "10000",
    prePeriodCurrencyMismatchCount: 0,
    reconciliation: {
      date: to,
      countedMinor: "15800",
      calculatedMinor: "15800",
      differenceMinor: "0",
    },
  }],
  eventKinds: [
    { kind: "collection", currency: "ARS", eventCount: 1, legCount: 1, inMinor: "10000", outMinor: "0", currencyMismatchCount: 0 },
    { kind: "purchase", currency: "ARS", eventCount: 1, legCount: 1, inMinor: "0", outMinor: "2000", currencyMismatchCount: 0 },
    { kind: "asset_purchase", currency: "ARS", eventCount: 1, legCount: 1, inMinor: "0", outMinor: "1000", currencyMismatchCount: 0 },
    { kind: "operating_expense", currency: "ARS", eventCount: 1, legCount: 1, inMinor: "0", outMinor: "700", currencyMismatchCount: 0 },
    { kind: "owner_withdrawal", currency: "ARS", eventCount: 1, legCount: 1, inMinor: "0", outMinor: "500", currencyMismatchCount: 0 },
  ],
  range: { from, to },
  custodyExcluded: true,
  currenciesCombined: false,
};

const emptyCashFlow: CashFlowFixture = {
  ...cashFlow,
  accounts: [],
  eventKinds: [],
};

function emptyProduct(attested: boolean): ProductMetricsFixture {
  return {
    ...productMetrics,
    lineBasisRevenueByCurrency: [],
    lineBasisGrossContributionBeforeFixedCostsByCurrency: [],
    approvedAccruedOperatingCostsByCurrency: [],
    recognizedDeliveryAndSurchargeByCurrency: [],
    deliveredLineCount: 0,
    allocationCoverage: { soldLineCount: 0, linesWithSoldLotAllocation: 0, missingAllocationLineCount: 0, allocationExceptionCount: 0, revenueExceptionLineCount: 0 },
    managementCoverage: {
      ...productMetrics.managementCoverage,
      sourcePeriodCompletenessAttested: attested,
      sourcePeriodAttestation: attested ? { period: "2026-09", state: "attested" } : null,
      pendingCostCount: 0,
      classifiedCostCount: 0,
      costClassificationCoverage: {
        state: "complete",
        classifiedRows: 0,
        unresolvedRows: 0,
        variableRows: 0,
        fixedRows: 0,
        actualFixedOperatingCostsByCurrency: [],
      },
    },
  };
}

function sources(options: {
  product?: Partial<ProductMetricsFixture>;
  cashFlow?: CashFlowFixture;
  historicalDeliverySales?: number;
  historicalExpenseRows?: number;
  compatibilityExpenseRows?: number;
} = {}): FinancialReportSources {
  const metrics: ProductMetricsFixture = {
    ...productMetrics,
    ...options.product,
    allocationCoverage: { ...productMetrics.allocationCoverage, ...options.product?.allocationCoverage },
    managementCoverage: { ...productMetrics.managementCoverage, ...options.product?.managementCoverage },
    pendingAppSheetInvoices: { ...productMetrics.pendingAppSheetInvoices, ...options.product?.pendingAppSheetInvoices },
    fixedCosts: { ...productMetrics.fixedCosts, ...options.product?.fixedCosts },
  };
  const fixture = {
    sales: { metrics: { historicalDelivery: { saleCount: options.historicalDeliverySales ?? 0 } } },
    product: { metrics },
    expenses: { metrics: { counts: {
      historicalExpenseRows: options.historicalExpenseRows ?? 0,
      compatibilityExpenseRows: options.compatibilityExpenseRows ?? 0,
    } } },
    cashLedger: { metrics: {} },
    cashFlow: options.cashFlow ?? cashFlow,
    obligations: { metrics: {
      horizon: { from: "2026-09-28", through: "2026-12-27", weeks: 13 as const },
      sourceCoverage: "complete" as const,
      weekly: [],
      payableSummaryComplete: true,
      payableRowsComplete: true,
      visiblePayableRows: 0,
    } },
  };
  // Envelopes carry many unrelated report metrics; this fixture supplies the
  // exact source fields consumed by the production projection above.
  return fixture as unknown as FinancialReportSources;
}

const period = { from, to, cutoffDate, currency: "ARS" as const };

test("closed, attested statement hand-calculates delivery income and keeps currencies and financing separate", () => {
  const ars = buildFinancialStatementsFromSources(sources(), period);
  assert.equal(ars.currency, "ARS");
  assert.equal(ars.incomeStatement.sourcePeriodAttested, true);
  assert.equal(ars.incomeStatement.state, "complete");
  assert.equal(ars.incomeStatement.scenarioBaseComplete, true);
  assert.deepEqual({
    sales: ars.incomeStatement.netSales.amountMinor,
    costOfGoodsSold: ars.incomeStatement.costOfGoodsSold.amountMinor,
    grossProfit: ars.incomeStatement.grossProfit.amountMinor,
    actualOperatingExpenses: ars.incomeStatement.operatingExpenses.amountMinor,
    recognizedDeliveryFees: ars.incomeStatement.otherOperatingIncome.amountMinor,
    result: ars.incomeStatement.operatingResult.amountMinor,
  }, {
    sales: "10000",
    costOfGoodsSold: "6000",
    grossProfit: "4000",
    actualOperatingExpenses: "3200",
    recognizedDeliveryFees: "500",
    result: "1300", // 10,000 - 6,000 - (700 variable + 2,500 fixed) + 500
  });

  assert.equal(ars.cashFlow.state, "complete");
  assert.equal(ars.cashFlow.paymentsMinor, "3700"); // 2,000 purchase + 1,000 asset + 700 cash expense
  assert.equal(ars.cashFlow.financingOutMinor, "500");
  assert.equal(ars.cashFlow.netMovementMinor, "5800");
  assert.equal(ars.cashFlow.closingBalanceMinor, "15800");

  const usd = buildFinancialStatementsFromSources(sources(), { ...period, currency: "USD" });
  assert.equal(usd.incomeStatement.netSales.amountMinor, "90000");
  assert.equal(usd.incomeStatement.costOfGoodsSold.amountMinor, "15000");
  assert.equal(usd.incomeStatement.operatingExpenses.amountMinor, "2500");
  assert.equal(usd.incomeStatement.otherOperatingIncome.amountMinor, "1000");
  assert.equal(usd.incomeStatement.operatingResult.amountMinor, "73500");
});

test("empty, zero, and attested-zero source buckets remain distinct", () => {
  const emptyUnattested = sources({
    product: emptyProduct(false),
    cashFlow: emptyCashFlow,
  });
  const unknown = buildFinancialStatementsFromSources(emptyUnattested, period);
  assert.equal(unknown.incomeStatement.state, "unknown");
  assert.equal(unknown.incomeStatement.netSales.observedMinor, null);
  assert.equal(unknown.incomeStatement.operatingResult.observedMinor, null);
  assert.equal(unknown.incomeStatement.operatingResult.amountMinor, null);
  assert.equal(unknown.incomeStatement.scenarioBaseComplete, false);

  const explicitZero = sources({
    product: {
      ...emptyProduct(false),
      lineBasisRevenueByCurrency: [{ currency: "ARS", minor: "0" }],
      lineBasisGrossContributionBeforeFixedCostsByCurrency: [{ currency: "ARS", minor: "0" }],
      approvedAccruedOperatingCostsByCurrency: [{ currency: "ARS", minor: "0" }],
      recognizedDeliveryAndSurchargeByCurrency: [{ currency: "ARS", minor: "0" }],
      deliveredLineCount: 1,
      allocationCoverage: { soldLineCount: 1, linesWithSoldLotAllocation: 1, missingAllocationLineCount: 0, allocationExceptionCount: 0, revenueExceptionLineCount: 0 },
      managementCoverage: {
        ...emptyProduct(false).managementCoverage,
        classifiedCostCount: 1,
        costClassificationCoverage: {
          state: "complete",
          classifiedRows: 1,
          unresolvedRows: 0,
          variableRows: 0,
          fixedRows: 1,
          actualFixedOperatingCostsByCurrency: [{ currency: "ARS", minor: "0" }],
        },
      },
    },
    cashFlow: emptyCashFlow,
  });
  const observedZero = buildFinancialStatementsFromSources(explicitZero, period);
  assert.equal(observedZero.incomeStatement.netSales.observedMinor, "0");
  assert.equal(observedZero.incomeStatement.netSales.amountMinor, null);
  assert.equal(observedZero.incomeStatement.operatingResult.observedMinor, "0");
  assert.equal(observedZero.incomeStatement.operatingResult.amountMinor, null);

  const attestedEmpty = sources({
    product: emptyProduct(true),
    cashFlow: emptyCashFlow,
  });
  const certifiedZero = buildFinancialStatementsFromSources(attestedEmpty, period);
  assert.equal(certifiedZero.incomeStatement.state, "complete");
  assert.equal(certifiedZero.incomeStatement.operatingResult.amountMinor, "0");
  assert.equal(certifiedZero.incomeStatement.scenarioBaseComplete, true);
});

test("missing cost coverage and future dates cannot produce a final result", () => {
  const unresolvedCosts = sources({
    product: {
      managementCoverage: {
        pendingCostCount: 1,
        costClassificationCoverage: {
          state: "partial",
          classifiedRows: 3,
          unresolvedRows: 1,
          variableRows: 2,
          fixedRows: 1,
          actualFixedOperatingCostsByCurrency: [{ currency: "ARS", minor: "2500" }],
        },
      },
    },
  });
  const partial = buildFinancialStatementsFromSources(unresolvedCosts, period);
  assert.equal(partial.incomeStatement.operatingExpenses.observedMinor, "3200");
  assert.equal(partial.incomeStatement.operatingExpenses.amountMinor, null);
  assert.equal(partial.incomeStatement.operatingResult.observedMinor, "1300");
  assert.equal(partial.incomeStatement.operatingResult.amountMinor, null);
  assert.equal(partial.incomeStatement.scenarioBaseComplete, false);

  const missingCosts = sources({
    product: {
      approvedAccruedOperatingCostsByCurrency: null,
      managementCoverage: {
        pendingCostCount: null,
        costQueryComplete: null,
        costClassificationCoverage: null,
      },
    },
  });
  const uncovered = buildFinancialStatementsFromSources(missingCosts, period);
  assert.equal(uncovered.incomeStatement.operatingExpenses.observedMinor, null);
  assert.equal(uncovered.incomeStatement.operatingResult.amountMinor, null);
  assert.equal(uncovered.incomeStatement.scenarioBaseComplete, false);

  const future = buildFinancialStatementsFromSources(sources(), {
    from: "2026-10-01",
    to: "2026-10-31",
    cutoffDate: "2026-10-08",
    currency: "ARS",
  });
  assert.equal(future.incomeStatement.operatingResult.amountMinor, null);
  assert.equal(future.incomeStatement.scenarioBaseComplete, false);
  assert.throws(
    () => parseFinancialStatementParams({ from: "2026-10-01", to: "2026-10-09", currency: "ARS" }, "2026-10-08"),
    /no puede terminar en una fecha futura/,
  );
});

test("cash balances remain explicit when a ledger kind or opening date is unknown", () => {
  const unknownKindCash: CashFlowFixture = {
    ...cashFlow,
    accounts: cashFlow.accounts.map(account => ({
      ...account,
      reconciliation: { date: to, countedMinor: "16000", calculatedMinor: "16000", differenceMinor: "0" },
    })),
    eventKinds: [
      ...cashFlow.eventKinds,
      { kind: "unclassified_fixture_kind", currency: "ARS", eventCount: 1, legCount: 1, inMinor: "200", outMinor: "0", currencyMismatchCount: 0 },
    ],
  };
  const withUnknownKind = buildFinancialStatementsFromSources(sources({ cashFlow: unknownKindCash }), period);
  assert.equal(withUnknownKind.cashFlow.state, "partial");
  assert.equal(withUnknownKind.cashFlow.openingBalanceMinor, "10000");
  assert.equal(withUnknownKind.cashFlow.closingBalanceMinor, "16000");
  assert.equal(withUnknownKind.cashFlow.netMovementMinor, null);

  const noOpeningDate: CashFlowFixture = {
    ...cashFlow,
    accounts: cashFlow.accounts.map(account => ({ ...account, openingDate: null })),
  };
  const withoutOpening = buildFinancialStatementsFromSources(sources({ cashFlow: noOpeningDate }), period);
  assert.equal(withoutOpening.cashFlow.state, "partial");
  assert.equal(withoutOpening.cashFlow.openingBalanceMinor, null);
  assert.equal(withoutOpening.cashFlow.closingBalanceMinor, "15800");
  assert.equal(withoutOpening.cashFlow.netMovementMinor, null);
  assert.equal(withoutOpening.incomeStatement.operatingResult.amountMinor, "1300");
});
