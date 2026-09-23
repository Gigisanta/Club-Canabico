import { z } from "zod";
const text = z.string().trim().min(1).max(180);
const money = z.number().int().min(0).max(1_000_000_000);
export const date = z.iso.date();
export const productSchema = z.object({
  name: text,
  strain: text,
  type: z.enum(["Flor", "Extracto", "Aceite", "Accesorio"]),
  unit: z.enum(["g", "ud"]),
  lot: text,
  stock: z.number().int().min(0).max(100_000_000),
  minimum: z.number().int().min(0).max(100_000_000),
  cost: money,
  price: money,
  location: text,
  ownerId: text,
  expires: date.nullable().default(null),
});
export const customerSchema = z.object({
  name: text,
  email: z.union([z.email(), z.literal("")]),
  phone: z.string().max(40),
  notes: z.string().max(5000).default(""),
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
