import test from "node:test";
import assert from "node:assert/strict";
import { visitCadence } from "../shared/customer-insights.js";

test("customer cadence uses distinct purchase days and a robust recent interval", () => {
  const result = visitCadence([
    "2026-09-24", "2026-09-24", "2026-09-17", "2026-09-10", "2026-08-01",
  ]);
  assert.equal(result.typicalIntervalDays, 7);
  assert.equal(result.nextExpectedDate, "2026-10-01");
});

test("customer cadence waits for four distinct purchase days", () => {
  assert.deepEqual(visitCadence(["2026-09-24", "2026-09-20", "2026-09-10"]), {
    typicalIntervalDays: null, nextExpectedDate: null,
  });
});
