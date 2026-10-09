import assert from "node:assert/strict";
import test from "node:test";
import {
  APPSHEET_INVOICE_RULE_VERSION,
  APPSHEET_INVOICE_RULE_VERSION_V1,
  APPSHEET_INVOICE_SOURCE_EXPRESSIONS,
  APPSHEET_TRANSFER_ROUNDING_POLICY,
  businessYearAt,
  calculateAppSheetInvoiceFinancials,
  formatAppSheetInvoiceNumber,
  formatAppSheetInvoiceNumberForYear,
} from "../shared/operations/appsheet-invoice-rules.js";

test("invoice formula catalog preserves source initial/reset timing and the Form Saved recalculation", () => {
  assert.equal(APPSHEET_INVOICE_RULE_VERSION_V1, "appsheet-invoice-rules/v1");
  assert.equal(APPSHEET_INVOICE_RULE_VERSION, "appsheet-invoice-rules/v2");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.invoiceNumberResetOnEdit, "No");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.hiddenIdResetOnEdit, "No");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.subtotalResetOnEdit, "=ISBLANK([_THISROW_BEFORE].[N_factura])");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.transferResetOnEdit, "Yes");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.transferTotalResetOnEdit, "Yes");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.invoiceTotalResetOnEdit, "Yes");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.recalculationAction, "Recalcular_Factura");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.recalculationAssignments.length, 6);
  assert.match(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.invoiceNumberInitialValue, /RIGHT\(/);
  assert.deepEqual(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.motoTransfer, {
    column: "Transferencia_moto",
    type: "Price",
    formulaProperty: "Initial value",
    expression: `=IF(\n  IN([Forma_pago_Moto], {"Transferencia", "Mercado Pago"}),\n  ([Tarifa_Moto_Cliente] * 0.05),\n  0\n)`,
    resetOnEdit: "Yes",
    editableIf: "=FALSE",
    virtualColumn: false,
    editableInitialValue: true,
  });
  assert.deepEqual(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.motoClientSubtotal, {
    column: "Subtotal_Cliente_Moto",
    type: "Price",
    formulaProperty: "Initial value",
    expression: "=[Tarifa_Moto_Cliente]+[Transferencia_moto]",
    resetOnEdit: "Yes",
    editableIf: "=FALSE",
    virtualColumn: false,
    editableInitialValue: true,
  });
});

test("new-operation transfer calculation uses exact 5 percent with explicit half-up minor-unit rounding", () => {
  const transfer = calculateAppSheetInvoiceFinancials({ subtotalMinor: 110n, clientTariffMinor: 700n, paymentMethod: "transfer", currency: "ARS" });
  assert.equal(transfer.transferMinor, 6n, "a 5.5-minor-unit tie rounds half up");
  assert.equal(transfer.transferTotalMinor, 116n);
  assert.equal(transfer.totalMinor, 816n);
  assert.equal(transfer.transferCalculation.exactMinorNumerator, "110");
  assert.equal(transfer.transferCalculation.exactMinorDenominator, "20");
  assert.equal(transfer.transferCalculation.subcentRemainderNumerator, "10");
  assert.equal(transfer.transferCalculation.roundingPolicy, APPSHEET_TRANSFER_ROUNDING_POLICY);
  assert.equal(transfer.transferCalculation.applied, true);

  const mercadoPago = calculateAppSheetInvoiceFinancials({ subtotalMinor: 101n, clientTariffMinor: 0n, paymentMethod: "mercado_pago", currency: "USD" });
  assert.equal(mercadoPago.transferMinor, 5n);
  assert.equal(mercadoPago.transferCalculation.subcentRemainderNumerator, "1");
  assert.equal(mercadoPago.transferCalculation.currency, "USD");

  const cash = calculateAppSheetInvoiceFinancials({ subtotalMinor: 110n, clientTariffMinor: 0n, paymentMethod: "cash", currency: "ARS" });
  assert.equal(cash.transferMinor, 0n);
  assert.equal(cash.transferCalculation.applied, false);
  assert.equal(cash.motoTransferMinor, null);
  assert.equal(cash.motoClientSubtotalMinor, null);
  assert.throws(() => calculateAppSheetInvoiceFinancials({ subtotalMinor: -1n, clientTariffMinor: 0n, paymentMethod: "transfer", currency: "ARS" }), RangeError);
});

test("Moto and product transfer methods calculate independently and Moto is added once", () => {
  const bothTransfer = calculateAppSheetInvoiceFinancials({
    subtotalMinor: 10_000n,
    clientTariffMinor: 1_000n,
    paymentMethod: "transfer",
    currency: "ARS",
    moto: { paymentMethod: "transfer" },
  });
  assert.equal(bothTransfer.transferMinor, 500n);
  assert.equal(bothTransfer.transferTotalMinor, 10_500n);
  assert.equal(bothTransfer.motoTransferMinor, 50n);
  assert.equal(bothTransfer.motoClientSubtotalMinor, 1_050n);
  assert.equal(bothTransfer.totalMinor, 11_550n);
  assert.equal(bothTransfer.motoTransferCalculation?.formula, APPSHEET_INVOICE_SOURCE_EXPRESSIONS.motoTransfer.expression);
  assert.equal(bothTransfer.motoTransferCalculation?.roundingPolicy, APPSHEET_TRANSFER_ROUNDING_POLICY);

  const productOnlyTransfer = calculateAppSheetInvoiceFinancials({
    subtotalMinor: 10_000n,
    clientTariffMinor: 1_000n,
    paymentMethod: "transfer",
    currency: "ARS",
    moto: { paymentMethod: "cash" },
  });
  assert.equal(productOnlyTransfer.transferMinor, 500n);
  assert.equal(productOnlyTransfer.motoTransferMinor, 0n);
  assert.equal(productOnlyTransfer.motoClientSubtotalMinor, 1_000n);
  assert.equal(productOnlyTransfer.totalMinor, 11_500n);

  const motoOnlyTransfer = calculateAppSheetInvoiceFinancials({
    subtotalMinor: 10_000n,
    clientTariffMinor: 1_000n,
    paymentMethod: "cash",
    currency: "ARS",
    moto: { paymentMethod: "mercado_pago" },
  });
  assert.equal(motoOnlyTransfer.transferMinor, 0n);
  assert.equal(motoOnlyTransfer.motoTransferMinor, 50n);
  assert.equal(motoOnlyTransfer.motoClientSubtotalMinor, 1_050n);
  assert.equal(motoOnlyTransfer.totalMinor, 11_050n);

  const motoTie = calculateAppSheetInvoiceFinancials({
    subtotalMinor: 0n,
    clientTariffMinor: 110n,
    paymentMethod: "cash",
    currency: "ARS",
    moto: { paymentMethod: "transfer" },
  });
  assert.equal(motoTie.motoTransferMinor, 6n);
  assert.equal(motoTie.motoClientSubtotalMinor, 116n);
  assert.equal(motoTie.motoTransferCalculation?.subcentRemainderNumerator, "10");
  assert.equal(motoTie.totalMinor, 116n);
});

test("v1 stays reproducible for historical Moto quotes while v2 leaves cash Moto unchanged", () => {
  const oldSnapshot = calculateAppSheetInvoiceFinancials({
    subtotalMinor: 10_000n,
    clientTariffMinor: 1_000n,
    paymentMethod: "transfer",
    currency: "ARS",
    moto: { paymentMethod: "transfer" },
  }, { ruleVersion: APPSHEET_INVOICE_RULE_VERSION_V1 });
  assert.equal(oldSnapshot.transferMinor, 500n);
  assert.equal(oldSnapshot.motoTransferMinor, null);
  assert.equal(oldSnapshot.motoClientSubtotalMinor, null);
  assert.equal(oldSnapshot.totalMinor, 11_500n, "historical v1 is reproduced without silently rewriting its saved total");

  const cashMoto = calculateAppSheetInvoiceFinancials({
    subtotalMinor: 10_000n,
    clientTariffMinor: 1_000n,
    paymentMethod: "cash",
    currency: "ARS",
    moto: { paymentMethod: "cash" },
  });
  assert.equal(cashMoto.motoTransferMinor, 0n);
  assert.equal(cashMoto.motoClientSubtotalMinor, 1_000n);
  assert.equal(cashMoto.totalMinor, 11_000n);
});

test("invoice numbers match AppSheet through 9999 and avoid truncating future IDs", () => {
  assert.equal(formatAppSheetInvoiceNumberForYear(2026, 1n), "2026|FA0001");
  assert.equal(formatAppSheetInvoiceNumberForYear(2026, 9999n), "2026|FA09999");
  assert.equal(formatAppSheetInvoiceNumberForYear(2026, 10_000n), "2026|FA010000");
  assert.equal(formatAppSheetInvoiceNumberForYear(2026, 123_456n), "2026|FA0123456");
  assert.throws(() => formatAppSheetInvoiceNumberForYear(2026, 0n), RangeError);
  assert.throws(() => formatAppSheetInvoiceNumberForYear(10_000, 1n), RangeError);
});

test("invoice numbering year follows Buenos Aires creation time, not the UTC date or invoiceDate", () => {
  const beforeLocalMidnight = new Date("2026-01-01T02:30:00.000Z");
  const afterLocalMidnight = new Date("2026-01-01T03:30:00.000Z");
  assert.equal(businessYearAt(beforeLocalMidnight), 2025);
  assert.equal(businessYearAt(afterLocalMidnight), 2026);
  assert.equal(formatAppSheetInvoiceNumber(beforeLocalMidnight, 1n), "2025|FA0001");
  assert.throws(() => businessYearAt(new Date(Number.NaN)), RangeError);
});
