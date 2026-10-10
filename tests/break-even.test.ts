import test from "node:test";
import assert from "node:assert/strict";
import { computeBreakEven, recurringOccurrences, type BreakEvenInput } from "../shared/break-even.js";

// Amounts in cents. Every expected value below is worked out by hand from these inputs.
const input = (overrides: Partial<BreakEvenInput>): BreakEvenInput => ({
  today: "2026-09-10", revenue: 0, cost: 0, variable: 0, fixedCosts: [],
  trailingRevenue: 0, trailingCost: 0, trailingVariable: 0, ...overrides,
});

test("without fixed costs the bar reports missing data instead of a percentage", () => {
  const result = computeBreakEven(input({ revenue: 100000, cost: 40000, variable: 10000 }));
  assert.equal(result.coveredPercent, null);
  assert.deepEqual(result.gaps, ["fixed_costs"]);
  assert.equal(result.projection.status, "unknown");
});

test("sales still needed are an exact ceiling of the margin, not a float quotient", () => {
  // Margin 350.000 of 1.000.000 (35 %). Rent 700.000: half covered, so the missing half needs 1.000.000 more in sales.
  const result = computeBreakEven(input({
    revenue: 1_000_000, cost: 500_000, variable: 150_000,
    fixedCosts: [{ category: "Alquiler", amount: 700_000, date: "2026-09-01" }],
  }));
  assert.equal(result.coveredPercent, 50);
  assert.equal(result.remaining, 350_000);
  assert.equal(result.salesNeeded, 1_000_000);
  // Day 10 of 30: today and the 20 days after it are left; 1.000.000 / 21 = 47.619,05.
  assert.equal(result.daysLeft, 21);
  assert.equal(result.salesPerDay, 47_620);
  // 35.000 of margin a day covers 700.000 on day 20.
  assert.deepEqual(result.projection, { status: "on_track", date: "2026-09-20", shortfall: null });
});

test("without sales this month or in the last 30 days the estimate is missing data, not a margin problem", () => {
  const result = computeBreakEven(input({ fixedCosts: [{ category: "Alquiler", amount: 100_000, date: "2026-09-01" }] }));
  assert.equal(result.marginSource, null);
  assert.equal(result.remaining, 100_000);
  assert.equal(result.salesNeeded, null);
  assert.deepEqual(result.gaps, ["sales"]);
  assert.equal(result.projection.status, "unknown");
});

test("a month without sales yet estimates with the margin of the last 30 days", () => {
  const result = computeBreakEven(input({
    today: "2026-09-03",
    fixedCosts: [{ category: "Alquiler", amount: 100_000, date: "2026-09-05" }],
    trailingRevenue: 200_000, trailingCost: 100_000, trailingVariable: 20_000,
  }));
  assert.equal(result.marginSource, "trailing");
  // 40 % margin: 100.000 / 0,4 = 250.000 over 28 days = 8.928,57 a day.
  assert.equal(result.salesNeeded, 250_000);
  assert.equal(result.salesPerDay, 8_929);
  assert.equal(result.projection.status, "early");
  assert.deepEqual(result.gaps, ["sales"]);
});

test("the month's pace is projected from day 7 on, not from a few days of sales", () => {
  // 350.000 of margin against a 700.000 rent: on day 6 that pace would already promise the rent by day 12.
  const pace = (today: string) => computeBreakEven(input({
    today, revenue: 1_000_000, cost: 500_000, variable: 150_000,
    fixedCosts: [{ category: "Alquiler", amount: 700_000, date: "2026-09-01" }],
  }));
  assert.deepEqual(pace("2026-09-06").projection, { status: "early", date: null, shortfall: null });
  // Day 7: 50.000 a day covers 700.000 on day 14.
  assert.deepEqual(pace("2026-09-07").projection, { status: "on_track", date: "2026-09-14", shortfall: null });
});

test("a negative margin gives no sales estimate and projects its loss on top of the fixed costs", () => {
  const result = computeBreakEven(input({
    revenue: 100_000, cost: 90_000, variable: 30_000,
    fixedCosts: [{ category: "Personal", amount: 50_000, date: "2026-09-30" }],
  }));
  assert.equal(result.contribution, -20_000);
  assert.equal(result.coveredPercent, 0);
  assert.equal(result.remaining, 70_000);
  assert.equal(result.salesNeeded, null);
  assert.equal(result.salesPerDay, null);
  assert.deepEqual(result.gaps, ["margin"]);
  // −20.000 in 10 days is −60.000 by day 30, so 50.000 of fixed costs end 110.000 short.
  assert.deepEqual(result.projection, { status: "short", date: null, shortfall: 110_000 });
});

test("a pace that falls short reports the uncovered amount and the exact share covered", () => {
  // 29.000 of margin in 10 days projects 87.000 for September; fixed costs are 100.000.
  const result = computeBreakEven(input({
    revenue: 40_000, cost: 8_000, variable: 3_000,
    fixedCosts: [{ category: "Servicios", amount: 100_000, date: "2026-09-12" }],
  }));
  assert.equal(result.coveredPercent, 29);
  assert.deepEqual(result.projection, { status: "short", date: null, shortfall: 13_000 });
});

test("milestones group this month's fixed costs by category in due order and mark what the margin covers", () => {
  const result = computeBreakEven(input({
    today: "2026-09-20", revenue: 600_000, cost: 300_000, variable: 50_000,
    fixedCosts: [
      { category: "Personal", amount: 100_000, date: "2026-09-25" },
      { category: "alquiler", amount: 180_000, date: "2026-09-01" },
      { category: "Alquiler", amount: 20_000, date: "2026-09-15" },
      { category: "Servicios", amount: 15_000, date: "2026-09-01" },
      { category: "Personal", amount: 70_000, date: "2026-08-31" },
      { category: "Luz", amount: 5_000, date: "2026-10-01" },
    ],
  }));
  // August and October costs do not count. Margin 250.000. Same due date: the smaller one first.
  assert.deepEqual(result.milestones.map(({ label, amount, dueDate, cumulative, covered, missing }) =>
    [label, amount, dueDate, cumulative, covered, missing]), [
    ["Servicios", 15_000, "2026-09-01", 15_000, true, 0],
    ["alquiler", 200_000, "2026-09-01", 215_000, true, 0],
    ["Personal", 100_000, "2026-09-25", 315_000, false, 65_000],
  ]);
  assert.equal(result.coveredPercent, 79);
});

test("once every fixed cost is covered, the rest of the margin is surplus", () => {
  const result = computeBreakEven(input({
    today: "2026-09-20", revenue: 600_000, cost: 200_000, variable: 50_000,
    fixedCosts: [{ category: "Alquiler", amount: 300_000, date: "2026-09-01" }],
  }));
  assert.equal(result.coveredPercent, 100);
  assert.equal(result.remaining, 0);
  assert.equal(result.surplus, 50_000);
  assert.equal(result.salesNeeded, 0);
  assert.equal(result.projection.status, "covered");
});

test("pending weekly occurrences count only inside the month", () => {
  assert.deepEqual(recurringOccurrences("2026-08-27", "weekly", "2026-09-01", "2026-09-30"),
    ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"]);
  assert.deepEqual(recurringOccurrences("2026-10-05", "monthly", "2026-09-01", "2026-09-30"), []);
});
