import { isAppSheetInvoiceTotalPending } from "../../shared/operations/appsheet.js";

/** Never expose the legacy SQL compatibility amount as a defined invoice total. */
export function projectInvoiceAmount<T extends { quote: unknown; totalMinor: unknown }>(order: T) {
  if (!isAppSheetInvoiceTotalPending(order.quote)) return order;
  const quote = order.quote as { capturedBaseMinor?: unknown; capturedProductMinor?: unknown };
  return {
    ...order,
    subtotalMinor: null,
    totalMinor: null,
    capturedProductMinor: quote.capturedProductMinor ?? null,
    capturedBaseMinor: quote.capturedBaseMinor ?? null,
    subtotalCalculationState: "pending_definition",
    totalCalculationState: "pending_definition",
  };
}
