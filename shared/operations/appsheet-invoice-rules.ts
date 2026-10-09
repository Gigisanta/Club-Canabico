import { roundHalfUp } from "./exact.js";
import { businessTimeZone, type Currency } from "./contracts.js";

export const APPSHEET_INVOICE_RULE_VERSION = "appsheet-invoice-rules/v1" as const;

/** Exact source expressions captured from C_Facturacion_Schema and its Form Saved action. */
export const APPSHEET_INVOICE_SOURCE_EXPRESSIONS = Object.freeze({
  invoiceNumberInitialValue: `=CONCATENATE(\n  YEAR(TODAY()),\n  "|FA0",\n  RIGHT(\n    "00" & ("" & [Id_Oculto]),\n    4\n  )\n)`,
  invoiceNumberResetOnEdit: "No",
  hiddenIdAppFormula: "=MAX(SELECT(C_Facturacion[Id_Oculto], TRUE)) + 1",
  hiddenIdResetOnEdit: "No",
  subtotalInitialValue: "=SUM([Related C_Detalle_Facts][Valor_Total])",
  subtotalResetOnEdit: "=ISBLANK([_THISROW_BEFORE].[N_factura])",
  transferInitialValue: `=IF(\n  IN([Forma_pago], {"Transferencia", "Mercado Pago"}),\n  ([Subtotal_Venta] * 0.05),\n  0\n)`,
  transferResetOnEdit: "Yes",
  transferTotalInitialValue: "=[Subtotal_Venta]+[Transferencia]",
  transferTotalResetOnEdit: "Yes",
  invoiceTotalInitialValue: "=[Subtotal_Venta] + [Tarifa_Moto_Cliente] + [Transferencia]",
  invoiceTotalResetOnEdit: "Yes",
  recalculationAction: "Recalcular_Factura",
  recalculationAssignments: Object.freeze([
    "Cantidad_Gr = SUM([Related C_Detalle_Facts][Cantidad_Gr])",
    "Subtotal_Venta = SUM([Related C_Detalle_Facts][Valor_Total])",
    "Tarifa_Moto_Cliente = SUM([Related C_Motos By N_Factura][Subtotal_Cliente_Moto])",
    "Transferencia = IF(IN([Forma_pago], {\"Transferencia\", \"Mercado Pago\"}), ([Subtotal_Venta] * 0.05), 0)",
    "Total_venta_Transferencia = [Subtotal_Venta] + [Transferencia]",
    "Total_Facturado = [Tarifa_Moto_Cliente] + [Total_venta_Transferencia]",
  ]),
});

export const APPSHEET_TRANSFER_ROUNDING_POLICY = "half_up_to_minor_unit" as const;
const TRANSFER_RATE_DENOMINATOR = 20n;

export interface AppSheetInvoiceFinancials {
  subtotalMinor: bigint;
  transferMinor: bigint;
  transferTotalMinor: bigint;
  clientTariffMinor: bigint;
  totalMinor: bigint;
  transferCalculation: {
    formula: string;
    applied: boolean;
    rateNumerator: "1" | "0";
    rateDenominator: "20" | "1";
    exactMinorNumerator: string;
    exactMinorDenominator: string;
    subcentRemainderNumerator: string;
    roundedMinor: string;
    roundingPolicy: typeof APPSHEET_TRANSFER_ROUNDING_POLICY;
    currency: Currency;
  };
}

/**
 * AppSheet stores Transferencia as an Initial Value, then its Form Saved
 * Recalcular_Factura action recomputes it from the product subtotal and method.
 * Bombo explicitly rounds the exact 5% rational amount to its minor unit with
 * half-up rounding; source values and this policy stay separately traceable.
 */
export function calculateAppSheetInvoiceFinancials(input: {
  subtotalMinor: bigint;
  clientTariffMinor: bigint;
  paymentMethod: "cash" | "transfer" | "mercado_pago" | "card";
  currency: Currency;
}): AppSheetInvoiceFinancials {
  const { subtotalMinor, clientTariffMinor, paymentMethod, currency } = input;
  if (subtotalMinor < 0n || clientTariffMinor < 0n) throw new RangeError("AppSheet invoice amounts cannot be negative");
  const applied = paymentMethod === "transfer" || paymentMethod === "mercado_pago";
  const numerator = applied ? subtotalMinor : 0n;
  const denominator = applied ? TRANSFER_RATE_DENOMINATOR : 1n;
  const transferMinor = applied ? roundHalfUp(numerator, denominator) : 0n;
  const transferTotalMinor = subtotalMinor + transferMinor;
  const totalMinor = transferTotalMinor + clientTariffMinor;
  const subcentRemainder = applied ? numerator % denominator : 0n;
  return {
    subtotalMinor,
    transferMinor,
    transferTotalMinor,
    clientTariffMinor,
    totalMinor,
    transferCalculation: {
      formula: APPSHEET_INVOICE_SOURCE_EXPRESSIONS.transferInitialValue,
      applied,
      rateNumerator: applied ? "1" : "0",
      rateDenominator: applied ? "20" : "1",
      exactMinorNumerator: numerator.toString(),
      exactMinorDenominator: denominator.toString(),
      subcentRemainderNumerator: subcentRemainder.toString(),
      roundedMinor: transferMinor.toString(),
      roundingPolicy: APPSHEET_TRANSFER_ROUNDING_POLICY,
      currency,
    },
  };
}

/**
 * Reproduces ('00' + id).slice(-4) for the source range through 9999 and keeps
 * the complete numeric ID afterward. This deliberately avoids source truncation.
 */
export function formatAppSheetInvoiceNumberForYear(year: number, id: bigint): string {
  if (!Number.isInteger(year) || year < 1 || year > 9999) throw new RangeError("Invoice year is invalid");
  if (id < 1n) throw new RangeError("Invoice sequence IDs must be positive");
  const digits = id.toString();
  const suffix = id <= 9999n ? (`00${digits}`).slice(-4) : digits;
  return `${year}|FA0${suffix}`;
}

export function businessYearAt(now: Date): number {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invoice creation time is invalid");
  const year = new Intl.DateTimeFormat("en", { timeZone: businessTimeZone, year: "numeric" }).format(now);
  const parsed = Number(year);
  if (!Number.isInteger(parsed)) throw new RangeError("Invoice year could not be resolved in the business timezone");
  return parsed;
}

export function formatAppSheetInvoiceNumber(now: Date, id: bigint): string {
  return formatAppSheetInvoiceNumberForYear(businessYearAt(now), id);
}
