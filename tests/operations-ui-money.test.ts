import test from "node:test";
import assert from "node:assert/strict";
import { formatMinor } from "../src/operations-ui/money.js";

test("financial display preserves exact cents above the JavaScript safe integer", () => {
  assert.equal(formatMinor("9007199254740993", "USD"), "USD 90.071.992.547.409,93");
  assert.equal(formatMinor("-9007199254740993", "ARS"), "−ARS 90.071.992.547.409,93");
});
test("a missing or unsupported currency cannot turn a known minor amount into ARS", () => {
  for (const currency of [undefined, null, "", "EUR"]) {
    assert.equal(formatMinor("12345", currency), "12345 unidades mínimas · moneda desconocida");
  }
});
