import assert from "node:assert/strict";
import test from "node:test";
import {
  APPSHEET_INVOICE_RULE_VERSION,
  APPSHEET_INVOICE_SOURCE_EXPRESSIONS,
  APPSHEET_TRANSFER_ROUNDING_POLICY,
  businessYearAt,
  calculateAppSheetInvoiceFinancials,
  formatAppSheetInvoiceNumber,
  formatAppSheetInvoiceNumberForYear,
} from "../shared/operations/appsheet-invoice-rules.js";

test("invoice formula catalog preserves source initial/reset timing and the Form Saved recalculation", () => {
  assert.equal(APPSHEET_INVOICE_RULE_VERSION, "appsheet-invoice-rules/v1");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.invoiceNumberResetOnEdit, "No");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.hiddenIdResetOnEdit, "No");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.subtotalResetOnEdit, "=ISBLANK([_THISROW_BEFORE].[N_factura])");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.transferResetOnEdit, "Yes");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.transferTotalResetOnEdit, "Yes");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.invoiceTotalResetOnEdit, "Yes");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.recalculationAction, "Recalcular_Factura");
  assert.equal(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.recalculationAssignments.length, 6);
  assert.match(APPSHEET_INVOICE_SOURCE_EXPRESSIONS.invoiceNumberInitialValue, /RIGHT\(/);
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
  assert.throws(() => calculateAppSheetInvoiceFinancials({ subtotalMinor: -1n, clientTariffMinor: 0n, paymentMethod: "transfer", currency: "ARS" }), RangeError);
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
