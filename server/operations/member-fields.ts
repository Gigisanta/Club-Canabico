import { z } from "zod";
import { OperationError } from "./core.js";

// Commercial forms have a closed vocabulary. Clinical records and credentials
// use separate, restricted commands; arbitrary nested preferences are rejected.
const text = z.string().trim().max(500);
const address = z.strictObject({
  address: text.optional(), addressLine1: text.optional(), addressLine2: text.optional(),
  street: text.optional(), streetNumber: text.optional(), number: text.optional(),
  floor: text.optional(), unit: text.optional(), apartment: text.optional(),
  city: text.optional(), province: text.optional(), postalCode: text.optional(),
  country: text.optional(), zone: text.optional(), reference: text.optional(),
  latitude: z.union([z.number().min(-90).max(90), z.string().regex(/^-?\d{1,2}(\.\d{1,12})?$/).refine(v=>Math.abs(Number(v))<=90)]).optional(),
  longitude: z.union([z.number().min(-180).max(180), z.string().regex(/^-?\d{1,3}(\.\d{1,12})?$/).refine(v=>Math.abs(Number(v))<=180)]).optional(),
});
const preferences = z.strictObject({
  preferredCategories: z.array(z.string().min(1).max(100)).max(100).optional(),
  preferredSkus: z.array(z.string().min(1).max(100)).max(100).optional(),
  preferredChannel: z.enum(["local", "delivery"]).optional(),
  contactPreference: z.enum(["phone", "email", "whatsapp", "manual"]).optional(),
  preferredPaymentMethod: z.enum(["cash", "transfer", "card"]).optional(),
  deliveryWindow: z.strictObject({ from: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), to: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) }).optional(),
  locale: z.literal("es-AR").optional(),
});
function commercialSchema(schema: z.ZodType<Record<string, unknown>>) {
  return z.record(z.string(), z.unknown()).transform(value => {
    const result = schema.safeParse(value);
    if (!result.success) throw new OperationError(422, "COMMERCIAL_FIELDS_RESTRICTED", "Usá los campos comerciales definidos. Los datos clínicos y las credenciales requieren su canal autorizado.");
    return result.data;
  });
}
export const commercialAddress = commercialSchema(address);
export const commercialPreferences = commercialSchema(preferences);
