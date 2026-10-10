import { z } from "zod";

/** Payment labels carried forward from the AppSheet invoice form. `card` remains a separate legacy value. */
export const appsheetPaymentMethod = z.enum(["cash", "transfer", "mercado_pago", "card"]);
export type AppSheetPaymentMethod = z.infer<typeof appsheetPaymentMethod>;

const amountMinor = z.string()
  .regex(/^(0|[1-9]\d{0,18})$/)
  .refine(value => BigInt(value) <= 9223372036854775807n, "Importe fuera de BigInt PostgreSQL");
const requiredText = (max: number) => z.string().trim().min(1).max(max);

export const appsheetAddress = z.strictObject({
  address: z.string().trim().max(500).optional(),
  addressLine1: z.string().trim().max(500).optional(),
  addressLine2: z.string().trim().max(500).optional(),
  street: z.string().trim().max(500).optional(),
  streetNumber: z.string().trim().max(500).optional(),
  number: z.string().trim().max(500).optional(),
  floor: z.string().trim().max(500).optional(),
  unit: z.string().trim().max(500).optional(),
  apartment: z.string().trim().max(500).optional(),
  city: z.string().trim().max(500).optional(),
  province: z.string().trim().max(500).optional(),
  postalCode: z.string().trim().max(500).optional(),
  country: z.string().trim().max(500).optional(),
  zone: z.string().trim().max(500).optional(),
  reference: z.string().trim().max(500).optional(),
  latitude: z.union([
    z.number().min(-90).max(90),
    z.string().regex(/^-?\d{1,2}(\.\d{1,12})?$/).refine(value => Math.abs(Number(value)) <= 90),
  ]).optional(),
  longitude: z.union([
    z.number().min(-180).max(180),
    z.string().regex(/^-?\d{1,3}(\.\d{1,12})?$/).refine(value => Math.abs(Number(value)) <= 180),
  ]).optional(),
});

export const appsheetInvoiceLine = z.strictObject({
  id: z.string().min(1).max(100),
  skuId: z.string().min(1).max(100),
  date: z.iso.date(),
  scale: z.string().trim().max(80),
  quantity: z.string().regex(/^(0|[1-9]\d{0,25})(\.\d{1,3})?$/),
  /** Explicit AppSheet `Valor total`; never recompute this from quantity and a unit price. */
  totalMinor: amountMinor.refine(value => BigInt(value) > 0n, "El total explícito de la línea debe ser positivo"),
  /** Optional explicit `Precio por gramo`; informational and independent from `totalMinor`. */
  pricePerGramMinor: amountMinor.optional(),
  /** Selected C_Mercaderia source key; the server resolves it to one reviewed internal lot. */
  sourceLotId: z.string().trim().min(1).max(150).optional(),
  /** Selected Bombo inventory lot created by a GoodsReceived receipt. */
  stockLotId: z.string().trim().min(1).max(150).optional(),
}).superRefine((line, ctx) => {
  if (line.sourceLotId && line.stockLotId) {
    ctx.addIssue({ code: "custom", path: ["stockLotId"], message: "Elegí un lote histórico AppSheet o un lote recibido por Bombo, no ambos." });
  }
});

export const appsheetMoto = z.strictObject({
  deliveryDate: z.iso.date(),
  paymentMethod: appsheetPaymentMethod,
  serviceType: requiredText(120),
  destination: z.string().trim().max(1000),
  clientTariffMinor: amountMinor,
  adminTariffMinor: amountMinor,
  totalTariffMinor: amountMinor,
  notes: z.string().max(2000).default(""),
});

/** One atomic invoice save. `preorder` stores this same immutable payload without confirming it. */
export const appsheetInvoiceInput = z.strictObject({
  memberId: z.string().min(1).max(100),
  invoiceNumber: z.string().trim().max(120).optional(),
  invoiceDate: z.iso.date(),
  currency: z.enum(["ARS", "USD"]),
  address: appsheetAddress.default({}),
  note: z.string().max(2000).default(""),
  productPaymentMethod: appsheetPaymentMethod,
  lines: z.array(appsheetInvoiceLine).max(200),
  moto: appsheetMoto.optional(),
  preorder: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (!value.preorder && value.lines.length === 0) {
    ctx.addIssue({ code: "custom", path: ["lines"], message: "Una factura confirmada requiere al menos un producto" });
  }
  const ids = new Set<string>();
  for (const [index, line] of value.lines.entries()) {
    if (ids.has(line.id)) ctx.addIssue({ code: "custom", path: ["lines", index, "id"], message: "Cada renglón requiere una identidad distinta" });
    ids.add(line.id);
  }
});

export type AppSheetInvoiceLine = z.infer<typeof appsheetInvoiceLine>;
export type AppSheetMoto = z.infer<typeof appsheetMoto>;
export type AppSheetInvoiceInput = z.infer<typeof appsheetInvoiceInput>;

/** Unknown total formulas must stay blocked from financial application until explicitly defined. */
export function isAppSheetInvoiceTotalPending(quote: unknown): boolean {
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return false;
  const snapshot = quote as { source?: unknown; totalCalculationState?: unknown };
  return snapshot.source === "appsheet-invoice"
    && snapshot.totalCalculationState !== "defined"
    && snapshot.totalCalculationState !== "staff_confirmed";
}
