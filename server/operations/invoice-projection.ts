import { isAppSheetInvoiceTotalPending } from "../../shared/operations/appsheet.js";

/** Never expose the legacy SQL compatibility amount as a defined invoice total. */
export function projectInvoiceAmount<T extends { quote: unknown; totalMinor: unknown }>(order: T) {
  if (!order.quote || typeof order.quote !== "object" || Array.isArray(order.quote)) return order;
  const quote = order.quote as {
    source?: unknown;
    totalCalculationState?: unknown;
    totalCalculationSource?: unknown;
    financialResolution?: unknown;
    capturedBaseMinor?: unknown;
    capturedProductMinor?: unknown;
  };
  if (quote.source !== "appsheet-invoice") return order;
  const pending = isAppSheetInvoiceTotalPending(order.quote);
  const knownState = quote.totalCalculationState === "defined" || quote.totalCalculationState === "staff_confirmed";
  return {
    ...order,
    subtotalMinor: null,
    totalMinor: pending ? null : order.totalMinor,
    capturedProductMinor: quote.capturedProductMinor ?? null,
    capturedBaseMinor: quote.capturedBaseMinor ?? null,
    subtotalCalculationState: "pending_definition",
    totalCalculationState: knownState ? quote.totalCalculationState : "pending_definition",
    totalCalculationSource: knownState ? quote.totalCalculationSource ?? null : null,
    financialResolution: knownState && quote.financialResolution && typeof quote.financialResolution === "object"
      ? quote.financialResolution
      : null,
  };
}
