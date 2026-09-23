import test from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  priceSale,
  businessDate,
  nextDate,
  allocateRevenue,
} from "../shared/domain.js";
import { csvCell } from "../server/reports.js";
test("discounts are applied once; points are earned on the net paid amount", () => {
  assert.deepEqual(priceSale(10000000, 160000000, 100, 25, defaults), {
    discount: 750000,
    total: 9250000,
    pointsEarned: 9,
    pointsUsed: 25,
  });
});
test('line allocations reconcile cents without negative final lines',()=>{
  assert.deepEqual(allocateRevenue([1,1,1,1],2),[1,1,0,0]);
  for(let total=0;total<=50;total++){const allocated=allocateRevenue(Array(50).fill(1),total);assert.equal(allocated.reduce((n,v)=>n+v,0),total);assert(allocated.every(n=>n>=0&&n<=1));}
  assert.deepEqual(allocateRevenue([999999999,1],999999999),[999999998,1]);
});
test("rejects overspending points and redeeming more than the sale", () => {
  assert.throws(() => priceSale(1000, 0, 5, 6, defaults));
  assert.throws(() => priceSale(1000, 0, 500, 101, defaults));
  assert.throws(() => priceSale(1000, 0, 500, 1.5, defaults));
});
test("business day respects timezone at midnight", () => {
  assert.equal(
    businessDate(
      { ...defaults, timezone: "America/Argentina/Buenos_Aires" },
      new Date("2026-09-23T01:00:00Z"),
    ),
    "2026-09-22",
  );
});
test("monthly recurrence clamps to last day instead of skipping February", () => {
  assert.equal(nextDate("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(nextDate("2028-01-31", "monthly"), "2028-02-29");
  assert.equal(nextDate("2026-12-29", "weekly"), "2027-01-05");
});
test("CSV neutralizes formulas and quotes user-provided text", () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell('Ana, "Club"'), '"Ana, ""Club"""');
});
