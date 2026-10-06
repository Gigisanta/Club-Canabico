import { z } from "zod";

/** AppSheet's editable catalogue amount, kept exact and separate from approved pricing. */
export const appSheetCatalogueMoneySchema = z.strictObject({
  amountMinor: z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(value => BigInt(value) <= 9223372036854775807n, "Importe fuera de BigInt PostgreSQL"),
  currency: z.enum(["ARS", "USD"]),
});

const nullableText = z.string().max(500).nullable();
const nullableMoney = appSheetCatalogueMoneySchema.nullable();

/**
 * Strict partial patch for the fields observed in D Catalogo Mercaderia Form.
 * Null means the operator explicitly cleared a known value; omitted means keep it.
 */
export const appSheetCataloguePatchSchema = z.strictObject({
  catalogId: z.string().max(100).nullable().optional(),
  availability: z.enum(["NO", "Sí"]).nullable().optional(),
  segment: z.enum(["Premium", "Estandar"]).nullable().optional(),
  description: nullableText.optional(),
  price5Grams: nullableMoney.optional(),
  price10To15Grams: nullableMoney.optional(),
  price15To20Grams: nullableMoney.optional(),
  price20To25Grams: nullableMoney.optional(),
  price25To30Grams: nullableMoney.optional(),
  priceOver30Grams: nullableMoney.optional(),
  promoA: nullableMoney.optional(),
  promoB: nullableMoney.optional(),
  promoC: nullableMoney.optional(),
  clientTariff: nullableMoney.optional(),
  administrationTariff: nullableMoney.optional(),
  totalTariff: nullableMoney.optional(),
}).refine(value => Object.keys(value).length > 0, "Indicá al menos un campo para guardar");

/** Known AppSheet fields exposed to the UI; unknown stored keys are not disclosed. */
export const appSheetCatalogueStoredSchema = z.object({
  catalogId: z.string().max(100).nullable().optional(),
  availability: z.enum(["NO", "Sí"]).nullable().optional(),
  segment: z.enum(["Premium", "Estandar"]).nullable().optional(),
  description: nullableText.optional(),
  price5Grams: nullableMoney.optional(),
  price10To15Grams: nullableMoney.optional(),
  price15To20Grams: nullableMoney.optional(),
  price20To25Grams: nullableMoney.optional(),
  price25To30Grams: nullableMoney.optional(),
  priceOver30Grams: nullableMoney.optional(),
  promoA: nullableMoney.optional(),
  promoB: nullableMoney.optional(),
  promoC: nullableMoney.optional(),
  clientTariff: nullableMoney.optional(),
  administrationTariff: nullableMoney.optional(),
  totalTariff: nullableMoney.optional(),
}).passthrough();

export type AppSheetCataloguePatch = z.infer<typeof appSheetCataloguePatchSchema>;
export type AppSheetCatalogueData = z.infer<typeof appSheetCatalogueStoredSchema>;
export type AppSheetCatalogueMoney = z.infer<typeof appSheetCatalogueMoneySchema>;
