import { z } from "zod";
const text = z.string().trim().min(1).max(180);
const money = z.number().int().min(0).max(1_000_000_000);
export const date = z.iso.date();
export const productSchema = z.object({
  name: text,
  strain: z.string().trim().max(180).default(""),
  type: z.enum(["Flor", "Extracto", "Aceite", "Accesorio"]),
  unit: z.enum(["g", "ud"]),
  lot: text,
  supplier: z.string().trim().max(180).default(""),
  supplierId: z.string().trim().min(1).max(100).nullable().default(null),
  sourceSystem: z.string().trim().min(1).max(80).nullable().default(null),
  sourceId: z.string().trim().min(1).max(180).nullable().default(null),
  stock: z.number().int().min(0).max(100_000_000),
  minimum: z.number().int().min(0).max(100_000_000),
  cost: money,
  price: money,
  location: text,
  locationId: z.string().trim().min(1).max(100).nullable().default(null),
  ownerId: text,
  expires: date.nullable().default(null),
});
export const supplierSchema = z.object({
  name: text,
  contactName: z.string().trim().max(180).default(""),
  phone: z.string().trim().max(40).default(""),
  email: z.union([z.email(), z.literal("")]).default(""),
  notes: z.string().trim().max(2000).default(""),
  isDefault: z.boolean().default(false),
});
export const locationSchema = z.object({
  name: text,
  isDefault: z.boolean().default(false),
});
export const customerSchema = z.object({
  name: text,
  email: z.union([z.email(), z.literal("")]),
  phone: z.string().max(40),
  notes: z.string().max(5000).default(""),
  sourceSystem: z.string().trim().min(1).max(80).nullable().default(null),
  sourceId: z.string().trim().min(1).max(180).nullable().default(null),
});
export const permitSchema = z.object({
  status: z.enum(["unverified", "pending", "verified", "expired"]),
  validUntil: date.nullable(),
});
export const cashEntrySchema = z.object({
  date,
  account: z.enum(["cash", "bank"]),
  category: z.enum(["opening_balance", "operating_expense", "stock_purchase", "local_investment", "capital_contribution", "owner_draw", "delivery_receipt", "other_income", "other_outflow", "adjustment"]),
  amount: z.number().int().min(-1_000_000_000).max(1_000_000_000).refine((n) => n !== 0),
  description: text,
  sourceSystem: z.string().trim().min(1).max(80),
  sourceId: z.string().trim().min(1).max(180),
});
export const cashPlanSchema = cashEntrySchema.pick({ date: true, account: true, category: true, amount: true, description: true }).extend({
  scenario: z.enum(["base", "cautious", "growth"]),
});
export const saleSchema = z
  .object({
    customerId: text,
    payment: z.enum(["cash", "card", "transfer"]),
    points: z.number().int().min(0).max(1000000).default(0),
    requestId: z.string().uuid(),
    items: z
      .array(
        z.object({
          productId: text,
          quantity: z.number().int().positive().max(100000000),
        }),
      )
      .min(1)
      .max(50),
  })
  .refine(
    (v) => new Set(v.items.map((i) => i.productId)).size === v.items.length,
    "No se permiten productos repetidos",
  );
export const expenseSchema = z.object({
  name: text,
  amount: money.refine((v) => v > 0),
  category: text,
  kind: z.enum(["fixed", "variable"]),
  ownerId: text.nullable().default(null),
  date,
  recurrence: z.enum(["none", "weekly", "monthly"]),
});
export const settingsSchema = z
  .object({
    clubName: text,
    currency: z.enum(["EUR", "ARS", "USD"]),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("es", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Zona horaria inválida"),
    pointsEvery: money.refine((v) => v > 0),
    pointValue: money.refine((v) => v > 0),
    silverAt: money,
    goldAt: money,
    silverDiscount: z.number().min(0).max(50),
    goldDiscount: z.number().min(0).max(50),
    inactiveDays: z.number().int().min(7).max(365),
    budget: money,
  })
  .refine((v) => v.goldAt > v.silverAt, "El umbral Oro debe superar Plata");
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
