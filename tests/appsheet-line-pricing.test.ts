import test from "node:test";
import assert from "node:assert/strict";
import type { AppSheetCatalogueData } from "../shared/operations/appsheet-catalogue.js";
import { proposeAppSheetLinePricingInitialValue, proposeAppSheetLineSubtotal } from "../shared/operations/appsheet-line-pricing.js";

test("exact tariff scale selects its own field instead of a neighbouring tier or legacy interval", () => {
  const catalogue: AppSheetCatalogueData = {
    price10Grams: { amountMinor: "1000", currency: "ARS" },
    price15Grams: { amountMinor: "1500", currency: "ARS" },
    price10To15Grams: { amountMinor: "9999", currency: "USD" },
  };

  const proposal = proposeAppSheetLinePricingInitialValue({
    catalogue,
    scale: "Precio_10_Gramos",
    quantityGrams: "1",
    expectedCurrency: "ARS",
  });

  assert.equal(proposal.status, "defined");
  if (proposal.status !== "defined") return;
  assert.equal(proposal.sourceField, "price10Grams");
  assert.equal(proposal.unitPriceMinor, "1000");
  assert.deepEqual(proposal.subtotal, { status: "defined", quantityGrams: "1", subtotalMinorExact: { numerator: "1000", denominator: "1" }, subtotalMinor: "1000" });
  assert.equal(proposal.phase, "initial-value-proposal");
});

test("missing exact tariff stays pending even when a legacy interval is populated", () => {
  const proposal = proposeAppSheetLinePricingInitialValue({
    catalogue: { price10To15Grams: { amountMinor: "900", currency: "ARS" } },
    scale: "Precio_10_Gramos",
    quantityGrams: "1",
  });

  assert.deepEqual(proposal, {
    phase: "initial-value-proposal",
    scale: "Precio_10_Gramos",
    status: "pending",
    reason: "missing_price",
    sourceField: "price10Grams",
  });
});

test("AppSheet promotion scales select only their documented promo field", () => {
  const cases = [
    ["Pack Premium", "promoA"],
    ["Pack Amigos", "promoB"],
    ["Promo_C", "promoC"],
  ] as const;

  for (const [scale, sourceField] of cases) {
    const proposal = proposeAppSheetLinePricingInitialValue({
      catalogue: { promoA: { amountMinor: "101", currency: "ARS" }, promoB: { amountMinor: "202", currency: "ARS" }, promoC: { amountMinor: "303", currency: "ARS" } },
      scale,
      quantityGrams: "1",
    });
    assert.equal(proposal.status, "defined", scale);
    if (proposal.status !== "defined") continue;
    assert.equal(proposal.sourceField, sourceField, scale);
    assert.equal(proposal.subtotal.status, "defined", scale);
    if (proposal.subtotal.status === "defined") assert.equal(proposal.subtotal.subtotalMinor, sourceField === "promoA" ? "101" : sourceField === "promoB" ? "202" : "303", scale);
  }
});

test("unknown scales and currency mismatches remain pending", () => {
  const catalogue: AppSheetCatalogueData = { price10Grams: { amountMinor: "100", currency: "USD" } };
  const unknown = proposeAppSheetLinePricingInitialValue({ catalogue, scale: "Precio_12_Gramos", quantityGrams: "1" });
  assert.equal(unknown.status, "pending");
  if (unknown.status === "pending") assert.equal(unknown.reason, "unknown_scale");

  const mismatch = proposeAppSheetLinePricingInitialValue({
    catalogue,
    scale: "Precio_10_Gramos",
    quantityGrams: "1",
    expectedCurrency: "ARS",
  });
  assert.equal(mismatch.status, "pending");
  if (mismatch.status === "pending") {
    assert.equal(mismatch.reason, "currency_mismatch");
    assert.equal(mismatch.currency, "USD");
  }
});

test("known unit price stays available when the independently proposed subtotal needs rounding evidence", () => {
  const catalogue: AppSheetCatalogueData = { price5Grams: { amountMinor: "10000", currency: "ARS" } };
  const exact = proposeAppSheetLinePricingInitialValue({ catalogue, scale: "Precio_5_Gramos", quantityGrams: "1.250" });
  assert.equal(exact.status, "defined");
  if (exact.status === "defined") {
    assert.equal(exact.unitPriceMinor, "10000");
    assert.deepEqual(exact.subtotal, { status: "defined", quantityGrams: "1.250", subtotalMinorExact: { numerator: "12500", denominator: "1" }, subtotalMinor: "12500" });
  }

  const fractional = proposeAppSheetLinePricingInitialValue({
    catalogue: { price5Grams: { amountMinor: "101", currency: "ARS" } },
    scale: "Precio_5_Gramos",
    quantityGrams: "0.3",
  });
  assert.equal(fractional.status, "defined");
  if (fractional.status === "defined") {
    assert.equal(fractional.unitPriceMinor, "101");
    assert.deepEqual(fractional.subtotal, { status: "pending", reason: "needsRoundEvidence", quantityGrams: "0.3", subtotalMinorExact: { numerator: "303", denominator: "10" } });
  }
});

test("manual and invalid quantity subtotal proposals stay pending without suppressing a known catalog unit price", () => {
  const fractional = proposeAppSheetLinePricingInitialValue({
    catalogue: { price5Grams: { amountMinor: "101", currency: "ARS" } },
    scale: "Precio_5_Gramos",
    quantityGrams: "not-a-number",
  });
  assert.equal(fractional.status, "defined");
  if (fractional.status === "defined") {
    assert.equal(fractional.unitPriceMinor, "101");
    assert.deepEqual(fractional.subtotal, { status: "pending", reason: "invalid_quantity", quantityGrams: "not-a-number" });
  }
  assert.deepEqual(proposeAppSheetLineSubtotal({ unitPriceMinor: "985", quantityGrams: "1.2" }), {
    status: "defined", quantityGrams: "1.2", subtotalMinorExact: { numerator: "1182", denominator: "1" }, subtotalMinor: "1182",
  });
});
