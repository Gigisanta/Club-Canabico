import test from "node:test";
import assert from "node:assert/strict";
import { calculateOutlook } from "../shared/outlook.js";

const dateAgo = (days: number) => {
  const value = new Date("2026-09-24T12:00:00Z");
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};

test("outlook keeps observations separate from seven-day and month-end projections", () => {
  const daily = Array.from({ length: 28 }, (_, index) => ({
    date: dateAgo(27 - index),
    total: index < 14 ? 2000 : 1000,
  }));
  const outlook = calculateOutlook("2026-09-24", daily, {
    firstSaleDate: "2026-07-01",
    buyers28: 28,
    repeatBuyers28: 14,
    buyersPrevious28: 20,
    repeatBuyersPrevious28: 12,
  });
  assert.equal(outlook.recent14, 14000);
  assert.equal(outlook.previous14, 28000);
  assert.equal(outlook.revenue7, 7000);
  assert.equal(outlook.monthEndRevenue, 42500);
  assert.equal(outlook.buyers30, 30);
  assert.equal(outlook.repeatBuyers30, 15);
  assert.equal(outlook.firstBuyers30, 15);
  assert.equal(outlook.saleDays28, 28);
});

test("outlook withholds projections when purchase history is short or sparse", () => {
  const pulse = { firstSaleDate: "2026-09-15", buyers28: 3, repeatBuyers28: 0,
    buyersPrevious28: 0, repeatBuyersPrevious28: 0 };
  const sparse = calculateOutlook("2026-09-24", [{ date: "2026-09-24", total: 1000 }], pulse);
  assert.equal(sparse.recent14, 1000);
  assert.equal(sparse.revenue7, null);
  assert.equal(sparse.monthEndRevenue, null);
  assert.equal(sparse.buyers30, null);
  assert.equal(sparse.repeatBuyers30, null);
  assert.equal(sparse.firstBuyers30, null);
});

test("rounded buyer groups still add up to the estimated total", () => {
  const daily = Array.from({ length: 28 }, (_, index) => ({ date: dateAgo(index), total: 1000 }));
  const outlook = calculateOutlook("2026-09-24", daily, {
    firstSaleDate: "2026-07-01", buyers28: 13, repeatBuyers28: 7,
    buyersPrevious28: 10, repeatBuyersPrevious28: 5,
  });
  assert.equal(outlook.buyers30, 14);
  assert.equal(outlook.repeatBuyers30, 8);
  assert.equal(outlook.firstBuyers30, 6);
  assert.equal(outlook.repeatBuyers30 + outlook.firstBuyers30, outlook.buyers30);
});
