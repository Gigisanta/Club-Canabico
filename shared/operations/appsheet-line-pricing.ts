import type { AppSheetCatalogueData, AppSheetCatalogueMoney } from "./appsheet-catalogue.js";

/** AppSheet's exact scale-to-catalogue-field mapping from Precio_gramo_línea. */
export const appSheetExactTariffFields = {
  Precio_5_Gramos: { field: "price5Grams", label: "Precio_5_Gramos", kind: "price" },
  Precio_10_Gramos: { field: "price10Grams", label: "Precio_10_Gramos", kind: "price" },
  Precio_15_Gramos: { field: "price15Grams", label: "Precio_15_Gramos", kind: "price" },
  Precio_20_Gramos: { field: "price20Grams", label: "Precio_20_Gramos", kind: "price" },
  Precio_25_Gramos: { field: "price25Grams", label: "Precio_25_Gramos", kind: "price" },
  Precio_30_Gramos: { field: "price30Grams", label: "Precio_30_Gramos", kind: "price" },
  "Pack Premium": { field: "promoA", label: "Promo_A · Pack Premium", kind: "promotion" },
  "Pack Amigos": { field: "promoB", label: "Promo_B · Pack Amigos", kind: "promotion" },
  Promo_C: { field: "promoC", label: "Promo_C", kind: "promotion" },
} as const satisfies Record<string, {
  field: keyof AppSheetCatalogueData;
  label: string;
  kind: "price" | "promotion";
}>;

export type AppSheetExactTariffScale = keyof typeof appSheetExactTariffFields;
export type AppSheetExactTariffField = (typeof appSheetExactTariffFields)[AppSheetExactTariffScale]["field"];

type ExactMinor = { numerator: string; denominator: string };
type ProposalPhase = { phase: "initial-value-proposal"; scale: string };

export type AppSheetLineSubtotalProposal =
  | { status: "defined"; quantityGrams: string; subtotalMinorExact: ExactMinor; subtotalMinor: string }
  | { status: "pending"; reason: "invalid_quantity" | "needsRoundEvidence" | "subtotal_overflow"; quantityGrams: string; subtotalMinorExact?: ExactMinor };

export type AppSheetLinePricingProposal =
  | (ProposalPhase & {
    status: "defined";
    sourceField: AppSheetExactTariffField;
    unitPriceMinor: string;
    currency: AppSheetCatalogueMoney["currency"];
    subtotal: AppSheetLineSubtotalProposal;
  })
  | (ProposalPhase & {
    status: "pending";
    reason: "unknown_scale" | "missing_price" | "invalid_price" | "currency_mismatch";
    sourceField?: AppSheetExactTariffField;
    unitPriceMinor?: string;
    currency?: AppSheetCatalogueMoney["currency"];
  });

const MAX_MINOR = 9223372036854775807n;

/**
 * Proposes AppSheet's current Initial Value from the exact tariff field. AppSheet
 * reevaluates an Initial Value until the user supplies one, so this function is
 * intentionally stateless and can be called as the new line changes.
 */
export function proposeAppSheetLinePricingInitialValue(input: {
  catalogue: AppSheetCatalogueData;
  scale: string;
  quantityGrams: string;
  expectedCurrency?: AppSheetCatalogueMoney["currency"];
}): AppSheetLinePricingProposal {
  const base: ProposalPhase = { phase: "initial-value-proposal", scale: input.scale };
  if (!Object.prototype.hasOwnProperty.call(appSheetExactTariffFields, input.scale)) {
    return { ...base, status: "pending", reason: "unknown_scale" };
  }

  const sourceField = appSheetExactTariffFields[input.scale as AppSheetExactTariffScale].field;
  const selected = input.catalogue[sourceField] as AppSheetCatalogueMoney | null | undefined;
  if (selected == null) return { ...base, status: "pending", reason: "missing_price", sourceField };

  if (typeof selected.amountMinor !== "string" || !/^(0|[1-9]\d{0,18})$/.test(selected.amountMinor)) {
    return { ...base, status: "pending", reason: "invalid_price", sourceField };
  }
  const unitPriceMinor = BigInt(selected.amountMinor);
  if (unitPriceMinor > MAX_MINOR || (selected.currency !== "ARS" && selected.currency !== "USD")) {
    return { ...base, status: "pending", reason: "invalid_price", sourceField };
  }
  if (input.expectedCurrency && input.expectedCurrency !== selected.currency) {
    return {
      ...base,
      status: "pending",
      reason: "currency_mismatch",
      sourceField,
      unitPriceMinor: selected.amountMinor,
      currency: selected.currency,
    };
  }

  return {
    ...base,
    status: "defined",
    sourceField,
    unitPriceMinor: selected.amountMinor,
    currency: selected.currency,
    subtotal: proposeAppSheetLineSubtotal({ unitPriceMinor: selected.amountMinor, quantityGrams: input.quantityGrams }),
  };
}

/** Proposes the independently editable line total, with no fractional-cent rounding. */
export function proposeAppSheetLineSubtotal(input: { unitPriceMinor: string; quantityGrams: string }): AppSheetLineSubtotalProposal {
  if (!/^(0|[1-9]\d{0,18})$/.test(input.unitPriceMinor)) {
    return { status: "pending", reason: "subtotal_overflow", quantityGrams: input.quantityGrams };
  }
  const unitPriceMinor = BigInt(input.unitPriceMinor);
  if (unitPriceMinor > MAX_MINOR) return { status: "pending", reason: "subtotal_overflow", quantityGrams: input.quantityGrams };
  const quantity = parseDecimal(input.quantityGrams);
  if (!quantity) return { status: "pending", reason: "invalid_quantity", quantityGrams: input.quantityGrams };

  const subtotal = reduce({ numerator: unitPriceMinor * quantity.numerator, denominator: quantity.denominator });
  const subtotalMinorExact = { numerator: subtotal.numerator.toString(), denominator: subtotal.denominator.toString() };
  if (subtotal.denominator !== 1n) return { status: "pending", reason: "needsRoundEvidence", quantityGrams: input.quantityGrams, subtotalMinorExact };
  if (subtotal.numerator > MAX_MINOR) return { status: "pending", reason: "subtotal_overflow", quantityGrams: input.quantityGrams, subtotalMinorExact };
  return { status: "defined", quantityGrams: input.quantityGrams, subtotalMinorExact, subtotalMinor: subtotal.numerator.toString() };
}

function parseDecimal(value: string): { numerator: bigint; denominator: bigint } | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,18})(?:\.(\d{1,18}))?$/.exec(value);
  if (!match) return null;
  const fraction = match[2] ?? "";
  const numerator = BigInt(`${match[1]}${fraction}`);
  return reduce({ numerator, denominator: 10n ** BigInt(fraction.length) });
}

function reduce(value: { numerator: bigint; denominator: bigint }) {
  const divisor = gcd(value.numerator, value.denominator);
  return { numerator: value.numerator / divisor, denominator: value.denominator / divisor };
}

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right];
  return left || 1n;
}
