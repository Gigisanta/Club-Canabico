import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateManagementPnl,
  compareNominalUsingOfficialCpi,
  forecastLongRangeScenarios,
  forecastSevenDayAggregate,
  forecastThirteenWeekCash,
  type ManagementPnlInput,
  type MonthlyScenarioInput,
  type PlannedCashEvent,
  type PlanningScenario,
  type SourceCoverage,
} from "../shared/decision-finance.js";

const completePnlCoverage: ManagementPnlInput["sourceCoverage"] = {
  netSales: "complete",
  historicalCogs: "complete",
  accruedOperatingExpenses: "complete",
  inventoryAcquisitions: "complete",
  cashEntries: "complete",
};

function blankPnl(period: ManagementPnlInput["period"]): ManagementPnlInput {
  return {
    period,
    netSales: [],
    historicalCogs: [],
    accruedOperatingExpenses: [],
    inventoryAcquisitions: [],
    cashEntries: [],
    sourceCoverage: { ...completePnlCoverage },
  };
}

test("management P&L uses net sales, historical COGS and accruals in bigint centavos", () => {
  const input = blankPnl({ from: "2026-08-01", through: "2026-08-31" });
  input.netSales = [
    { date: "2026-08-31", amountCents: 1_234_567_890n }, // ARS 12,345,678.90
    { date: "2026-09-01", amountCents: 9_000n },
  ];
  input.historicalCogs = [{ date: "2026-08-31", amountCents: 123_456_789n }];
  input.accruedOperatingExpenses = [{ date: "2026-08-31", amountCents: 23_456_789n }];
  input.inventoryAcquisitions = [{ date: "2026-08-31", amountCents: 40_000_000n, inventoryReference: "stock-lot-1" }];
  input.cashEntries = [
    { date: "2026-08-01", category: "opening_balance", amountCents: 2_000_000n },
    { date: "2026-08-31", category: "capital_contribution", amountCents: 100_000n },
    { date: "2026-08-31", category: "owner_draw", amountCents: -20_000n },
    { date: "2026-08-31", category: "local_investment", amountCents: -30_000n },
    { date: "2026-08-31", category: "stock_purchase", amountCents: -10_000n },
  ];

  const result = calculateManagementPnl(input);
  assert.equal(result.netSalesCents, 1_234_567_890n);
  assert.equal(result.historicalCogsCents, 123_456_789n);
  assert.equal(result.accruedOperatingExpensesCents, 23_456_789n);
  assert.equal(result.operatingResultCents, 1_087_654_312n);
  assert.equal(result.inventoryAcquisitionsCents, 40_000_000n);
  assert.equal(result.cashByCategory.opening_balance, 2_000_000n);
  assert.equal(result.cashByCategory.capital_contribution, 100_000n);
  assert.equal(result.cashByCategory.owner_draw, -20_000n);
  assert.equal(result.cashByCategory.local_investment, -30_000n);
  assert.equal(result.cashByCategory.stock_purchase, -10_000n);
  assert.equal(result.includedRows.netSales, 1);
  assert.equal(result.metadata.kind, "calculated");
});

test("late expense and inventory payments affect cash on payment date, not accrued P&L", () => {
  const august = blankPnl({ from: "2026-08-01", through: "2026-08-31" });
  august.netSales = [{ date: "2026-08-20", amountCents: 100_000n }];
  august.accruedOperatingExpenses = [{ date: "2026-08-31", amountCents: 25_000n }];
  august.inventoryAcquisitions = [{ date: "2026-08-31", amountCents: 60_000n }];
  august.cashEntries = [
    { date: "2026-09-03", category: "operating_expense", amountCents: -25_000n },
    { date: "2026-09-04", category: "stock_purchase", amountCents: -60_000n },
  ];
  const augustResult = calculateManagementPnl(august);
  assert.equal(augustResult.operatingResultCents, 75_000n);
  assert.equal(augustResult.inventoryAcquisitionsCents, 60_000n);
  assert.equal(augustResult.cashByCategory.operating_expense, undefined);
  assert.equal(augustResult.cashByCategory.stock_purchase, undefined);

  const september = blankPnl({ from: "2026-09-01", through: "2026-09-30" });
  september.cashEntries = august.cashEntries;
  const septemberResult = calculateManagementPnl(september);
  assert.equal(septemberResult.operatingResultCents, 0n);
  assert.equal(septemberResult.cashByCategory.operating_expense, -25_000n);
  assert.equal(septemberResult.cashByCategory.stock_purchase, -60_000n);
});

test("incomplete P&L source reports observed arithmetic but withholds complete result", () => {
  const input = blankPnl({ from: "2026-08-01", through: "2026-08-31" });
  input.netSales = [{ date: "2026-08-10", amountCents: 500_000n }];
  input.historicalCogs = [{ date: "2026-08-10", amountCents: 100_000n }];
  input.accruedOperatingExpenses = [{ date: "2026-08-10", amountCents: 50_000n }];
  input.sourceCoverage.historicalCogs = "partial";
  const result = calculateManagementPnl(input);
  assert.equal(result.operatingResultCents, null);
  assert.equal(result.observedOperatingResultCents, 350_000n);
  assert.throws(() => calculateManagementPnl({
    ...input,
    cashEntries: [{ date: "2026-08-10", category: "stock_purchase", amountCents: 1n }],
  }), /negative payment/);
});

test("13-week scenario rolls signed categorized flows from a reconciled opening balance", () => {
  const result = forecastThirteenWeekCash({
    asOfDate: "2026-09-30",
    scenario: "base",
    sourceCoverage: "complete",
    openingBalance: { kind: "reconciled", amountCents: 2_000_000n, asOfDate: "2026-09-30", reconciliationId: "bank-close-2026-09" },
    events: [
      { date: "2026-10-01", category: "sale", amountCents: 100_000n },
      { date: "2026-10-04", category: "stock_purchase", amountCents: -20_000n },
      { date: "2026-10-05", category: "local_investment", amountCents: -10_000n },
      { date: "2026-10-06", category: "capital_contribution", amountCents: 50_000n },
      { date: "2026-10-07", category: "owner_draw", amountCents: -5_000n },
      { date: "2026-10-08", category: "operating_expense", amountCents: -25_000n },
    ],
  });
  assert.equal(result.available, true);
  assert.equal(result.weeks.length, 13);
  assert.equal(result.weeks[0].observedCashChangeCents, 115_000n);
  assert.equal(result.weeks[0].closingCashBalanceCents, 2_115_000n);
  assert.equal(result.weeks[0].cashByCategory.stock_purchase, -20_000n);
  assert.equal(result.weeks[0].cashByCategory.local_investment, -10_000n);
  assert.equal(result.weeks[0].cashByCategory.capital_contribution, 50_000n);
  assert.equal(result.weeks[0].cashByCategory.owner_draw, -5_000n);
  assert.equal(result.weeks[1].closingCashBalanceCents, 2_090_000n);
  assert.equal(result.weeks[12].week, 13);
  assert.equal(result.metadata.openingBalance?.kind, "reconciled");
});

test("missing or incomplete reconciliation never yields a 13-week cash balance", () => {
  const base = {
    asOfDate: "2026-09-30",
    scenario: "low" as const,
    sourceCoverage: "complete" as const,
    events: [{ date: "2026-10-01", category: "sale" as const, amountCents: 50_000n }],
  };
  const missing = forecastThirteenWeekCash({ ...base, openingBalance: null });
  assert.equal(missing.available, false);
  assert.deepEqual(missing.unavailableReasons, ["missing-reconciled-opening-balance"]);
  assert.equal(missing.weeks[0].plannedCashChangeCents, 50_000n);
  assert.equal(missing.weeks[0].closingCashBalanceCents, null);

  const partial = forecastThirteenWeekCash({
    ...base,
    sourceCoverage: "partial",
    openingBalance: { kind: "reconciled", amountCents: 500_000n, asOfDate: base.asOfDate, reconciliationId: "close-1" },
  });
  assert.equal(partial.available, false);
  assert.equal(partial.weeks[0].observedCashChangeCents, 50_000n);
  assert.equal(partial.weeks[0].plannedCashChangeCents, null);
  assert.equal(partial.weeks[0].closingCashBalanceCents, null);
  assert.throws(() => forecastThirteenWeekCash({
    ...base,
    openingBalance: { kind: "reconciled", amountCents: 500_000n, asOfDate: "2026-09-29", reconciliationId: "wrong-cutoff" },
  }), /must match/);
});

function monthlyAssumptions(): MonthlyScenarioInput[] {
  const rows: MonthlyScenarioInput[] = [];
  const scenarios: PlanningScenario[] = ["low", "base", "high"];
  const months = ["2026-12", ...Array.from({ length: 12 }, (_, index) => `2027-${String(index + 1).padStart(2, "0")}`)];
  for (const month of months) {
    for (const scenario of scenarios) {
      const amountCents = scenario === "low" ? 100_000n : scenario === "base" ? 200_000n : 300_000n;
      const events: PlannedCashEvent[] = [{
        date: `${month}-15`,
        category: "sale" as const,
        amountCents,
      }];
      if (month === "2026-12" && scenario === "base") {
        events.push(
          { date: `${month}-20`, category: "stock_purchase" as const, amountCents: -20_000n },
          { date: `${month}-21`, category: "local_investment" as const, amountCents: -10_000n },
          { date: `${month}-22`, category: "capital_contribution" as const, amountCents: 50_000n },
          { date: `${month}-23`, category: "owner_draw" as const, amountCents: -5_000n },
        );
      }
      rows.push({ month, scenario, sourceCoverage: "complete", events });
    }
  }
  return rows;
}

test("December 2026 and all 2027 low/base/high scenarios include an explicit hiring what-if", () => {
  const result = forecastLongRangeScenarios({
    asOfDate: "2026-11-30",
    openingBalance: { kind: "reconciled", amountCents: 1_000_000n, asOfDate: "2026-11-30", reconciliationId: "nov-close" },
    assumptions: monthlyAssumptions(),
    hiringWhatIf: {
      startMonth: "2027-01",
      endMonth: null,
      headcount: 2,
      monthlyEmployerCostPerEmployeeCents: 50_000n,
    },
  });
  assert.equal(result.periods.length, 13);
  assert.equal(result.periods[0].month, "2026-12");
  assert.equal(result.periods[0].byScenario.low.cashChangeCents, 100_000n);
  assert.equal(result.periods[0].byScenario.base.cashChangeCents, 215_000n);
  assert.equal(result.periods[0].byScenario.base.cashByCategory.stock_purchase, -20_000n);
  assert.equal(result.periods[0].byScenario.base.cashByCategory.local_investment, -10_000n);
  assert.equal(result.periods[0].byScenario.base.cashByCategory.capital_contribution, 50_000n);
  assert.equal(result.periods[0].byScenario.base.cashByCategory.owner_draw, -5_000n);
  assert.equal(result.periods[0].byScenario.base.closingCashBalanceCents, 1_215_000n);
  assert.equal(result.periods[0].byScenario.base.hiringAdjustmentCents, 0n);
  assert.equal(result.periods[1].month, "2027-01");
  assert.equal(result.periods[1].byScenario.base.cashChangeCents, 200_000n);
  assert.equal(result.periods[1].byScenario.base.hiringAdjustmentCents, -100_000n);
  assert.equal(result.periods[1].byScenario.base.cashChangeWithHiringCents, 100_000n);
  assert.equal(result.periods[1].byScenario.base.closingCashBalanceCents, 1_415_000n);
  assert.equal(result.periods[1].byScenario.base.closingCashBalanceWithHiringCents, 1_315_000n);
  assert.equal(result.periods[12].month, "2027-12");
  assert.equal(result.periods[12].byScenario.high.cashChangeCents, 300_000n);
});

test("missing monthly assumption withholds its amount and every later rolled balance", () => {
  const assumptions = monthlyAssumptions().filter((row) => !(row.month === "2027-02" && row.scenario === "base"));
  const result = forecastLongRangeScenarios({
    asOfDate: "2026-11-30",
    openingBalance: { kind: "reconciled", amountCents: 1_000_000n, asOfDate: "2026-11-30", reconciliationId: "nov-close" },
    assumptions,
    hiringWhatIf: null,
  });
  const february = result.periods[2].byScenario.base;
  assert.equal(february.sourceCoverage, "missing");
  assert.equal(february.cashChangeCents, null);
  assert.equal(february.closingCashBalanceCents, null);
  assert.equal(february.cashChangeWithHiringCents, null);
  assert.equal(result.periods[3].byScenario.base.cashChangeCents, 200_000n);
  assert.equal(result.periods[3].byScenario.base.closingCashBalanceCents, null);
});

test("official CPI comparison preserves supplied series version and withholds missing points", () => {
  const officialIndex = {
    publisher: "INDEC",
    seriesName: "IPC nivel general nacional",
    version: "release-2027-03-01",
    publishedAt: "2027-03-01",
    points: [
      { month: "2026-12", indexValue: 100n },
      { month: "2027-01", indexValue: 125n },
    ],
  };
  const available = compareNominalUsingOfficialCpi({
    earlierMonth: "2026-12",
    laterMonth: "2027-01",
    earlierNominalCents: 100_000n,
    laterNominalCents: 130_000n,
    officialIndex,
  });
  assert.equal(available.status, "available");
  assert.equal(available.nominalChangeCents, 30_000n);
  assert.equal(available.earlierAdjustedToLaterCents, 125_000n);
  assert.equal(available.cpiAdjustedChangeCents, 5_000n);
  assert.equal(available.metadata.officialIndex.version, "release-2027-03-01");
  assert.equal(available.metadata.kind, "calculated");

  const missing = compareNominalUsingOfficialCpi({
    earlierMonth: "2026-12",
    laterMonth: "2027-02",
    earlierNominalCents: 100_000n,
    laterNominalCents: 140_000n,
    officialIndex,
  });
  assert.equal(missing.status, "missing-index-point");
  assert.deepEqual(missing.missingMonths, ["2027-02"]);
  assert.equal(missing.earlierAdjustedToLaterCents, null);
  assert.equal(missing.cpiAdjustedChangeCents, null);
});

function dailySeries(length: number, amountAt: (index: number) => bigint = () => 100n) {
  const start = new Date("2026-01-01T00:00:00.000Z");
  return Array.from({ length }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), netSalesCents: amountAt(index) };
  });
}

test("rolling-origin 7-day backtest has hand-calculated MAE and signed bias", () => {
  const daily = dailySeries(49, (index) => index < 28 ? 100n : index < 35 ? 120n : index < 42 ? 80n : 100n);
  const result = forecastSevenDayAggregate({ dailySales: daily, sourceCoverage: "complete" });
  assert.equal(result.outOfSample.forecastOrigins, 3);
  assert.equal(result.outOfSample.maeCents, 105n); // (140 + 175 + 0) / 3
  assert.equal(result.outOfSample.biasCents, -12n); // round((-35) / 3) centavos
  assert.equal(result.outOfSample.intervalCoverage, null);
  assert.equal(result.forecast.pointCents, 700n);
});

test("rolling-origin forecast measures held-out 80% interval coverage only after adequate history", () => {
  const result = forecastSevenDayAggregate({ dailySales: dailySeries(133), sourceCoverage: "complete" });
  assert.equal(result.forecast.pointCents, 700n);
  assert.deepEqual(result.forecast.interval80, { lowerCents: 700n, upperCents: 700n, calibrationOrigins: 15 });
  assert.deepEqual(result.outOfSample.intervalCoverage, {
    coveredOrigins: 5,
    scoredOrigins: 5,
    observedCoverageBasisPoints: 10_000,
  });
  assert.equal(result.outOfSample.intervalTargetPercent, 80);
  assert.equal(result.outOfSample.maeCents, 0n);
  assert.equal(result.outOfSample.biasCents, 0n);
});

test("sparse, incomplete, or gapped sales history does not invent a forecast or coverage", () => {
  const sparse = forecastSevenDayAggregate({ dailySales: dailySeries(7), sourceCoverage: "complete" });
  assert.equal(sparse.forecast.unavailableReason, "insufficient-history");
  assert.equal(sparse.forecast.pointCents, null);
  assert.equal(sparse.outOfSample.maeCents, null);
  assert.equal(sparse.outOfSample.intervalTargetPercent, null);
  assert.equal(sparse.outOfSample.intervalCoverage, null);

  const incomplete = forecastSevenDayAggregate({ dailySales: dailySeries(40), sourceCoverage: "partial" });
  assert.equal(incomplete.forecast.unavailableReason, "incomplete-source");
  assert.equal(incomplete.forecast.pointCents, null);
  assert.equal(incomplete.outOfSample.intervalCoverage, null);

  const gap = dailySeries(40).filter((_, index) => index !== 20);
  const discontinuous = forecastSevenDayAggregate({ dailySales: gap, sourceCoverage: "complete" });
  assert.equal(discontinuous.forecast.unavailableReason, "date-gap");
  assert.equal(discontinuous.forecast.pointCents, null);
});
