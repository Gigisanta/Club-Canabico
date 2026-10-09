import { roundHalfUp } from "./exact.js";
import { businessTimeZone, type Currency } from "./contracts.js";
import type { AppSheetPaymentMethod } from "./appsheet.js";

export const APPSHEET_INVOICE_RULE_VERSION_V1 = "appsheet-invoice-rules/v1" as const;
export const APPSHEET_INVOICE_RULE_VERSION = "appsheet-invoice-rules/v2" as const;
export type AppSheetInvoiceRuleVersion = typeof APPSHEET_INVOICE_RULE_VERSION | typeof APPSHEET_INVOICE_RULE_VERSION_V1;

/** Exact expressions captured before the Moto transfer formula was implemented. */
export const APPSHEET_INVOICE_SOURCE_EXPRESSIONS_V1 = Object.freeze({
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

/** Exact AppSheet source rules, including when and where each Moto value is recalculated. */
export const APPSHEET_INVOICE_SOURCE_EXPRESSIONS = Object.freeze({
  ...APPSHEET_INVOICE_SOURCE_EXPRESSIONS_V1,
  motoTransfer: Object.freeze({
    column: "Transferencia_moto",
    type: "Price",
    formulaProperty: "Initial value",
    expression: `=IF(\n  IN([Forma_pago_Moto], {"Transferencia", "Mercado Pago"}),\n  ([Tarifa_Moto_Cliente] * 0.05),\n  0\n)`,
    resetOnEdit: "Yes",
    editableIf: "=FALSE",
    virtualColumn: false,
    editableInitialValue: true,
  }),
  motoClientSubtotal: Object.freeze({
    column: "Subtotal_Cliente_Moto",
    type: "Price",
    formulaProperty: "Initial value",
    expression: "=[Tarifa_Moto_Cliente]+[Transferencia_moto]",
    resetOnEdit: "Yes",
    editableIf: "=FALSE",
    virtualColumn: false,
    editableInitialValue: true,
  }),
});

export const APPSHEET_TRANSFER_ROUNDING_POLICY = "half_up_to_minor_unit" as const;
const TRANSFER_RATE_DENOMINATOR = 20n;

export interface AppSheetTransferCalculation {
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
}

export interface AppSheetInvoiceFinancials {
  subtotalMinor: bigint;
  transferMinor: bigint;
  transferTotalMinor: bigint;
  clientTariffMinor: bigint;
  totalMinor: bigint;
  transferCalculation: AppSheetTransferCalculation;
  motoTransferMinor: bigint | null;
  motoClientSubtotalMinor: bigint | null;
  motoTransferCalculation: AppSheetTransferCalculation | null;
}

function calculateTransfer(baseMinor: bigint, paymentMethod: AppSheetPaymentMethod, formula: string, currency: Currency) {
  const applied = paymentMethod === "transfer" || paymentMethod === "mercado_pago";
  const numerator = applied ? baseMinor : 0n;
  const denominator = applied ? TRANSFER_RATE_DENOMINATOR : 1n;
  const transferMinor = applied ? roundHalfUp(numerator, denominator) : 0n;
  return {
    transferMinor,
    calculation: {
      formula,
      applied,
      rateNumerator: applied ? "1" : "0",
      rateDenominator: applied ? "20" : "1",
      exactMinorNumerator: numerator.toString(),
      exactMinorDenominator: denominator.toString(),
      subcentRemainderNumerator: applied ? (numerator % denominator).toString() : "0",
      roundedMinor: transferMinor.toString(),
      roundingPolicy: APPSHEET_TRANSFER_ROUNDING_POLICY,
      currency,
    } satisfies AppSheetTransferCalculation,
  };
}

/**
 * AppSheet stores Transferencia values as Initial Values, then Recalcular_Factura
 * recomputes the product fee on products and the Moto fee on its own tariff.
 * v1 remains available only to reproduce already-saved snapshots; new operations
 * use v2, with half-up rounding to a currency minor unit and independent methods.
 */
export function calculateAppSheetInvoiceFinancials(input: {
  subtotalMinor: bigint;
  clientTariffMinor: bigint;
  paymentMethod: AppSheetPaymentMethod;
  currency: Currency;
  moto?: { paymentMethod: AppSheetPaymentMethod };
}, options: { ruleVersion?: AppSheetInvoiceRuleVersion } = {}): AppSheetInvoiceFinancials {
  const { subtotalMinor, clientTariffMinor, paymentMethod, currency } = input;
  const ruleVersion = options.ruleVersion ?? APPSHEET_INVOICE_RULE_VERSION;
  if (subtotalMinor < 0n || clientTariffMinor < 0n) throw new RangeError("AppSheet invoice amounts cannot be negative");

  const product = calculateTransfer(subtotalMinor, paymentMethod, APPSHEET_INVOICE_SOURCE_EXPRESSIONS_V1.transferInitialValue, currency);
  const transferTotalMinor = subtotalMinor + product.transferMinor;
  const moto = ruleVersion === APPSHEET_INVOICE_RULE_VERSION && input.moto
    ? calculateTransfer(clientTariffMinor, input.moto.paymentMethod, APPSHEET_INVOICE_SOURCE_EXPRESSIONS.motoTransfer.expression, currency)
    : null;
  const motoTransferMinor = moto?.transferMinor ?? null;
  const motoClientSubtotalMinor = moto ? clientTariffMinor + moto.transferMinor : null;
  const totalMinor = transferTotalMinor + (motoClientSubtotalMinor ?? clientTariffMinor);

  return {
    subtotalMinor,
    transferMinor: product.transferMinor,
    transferTotalMinor,
    clientTariffMinor,
    totalMinor,
    transferCalculation: product.calculation,
    motoTransferMinor,
    motoClientSubtotalMinor,
    motoTransferCalculation: moto?.calculation ?? null,
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
