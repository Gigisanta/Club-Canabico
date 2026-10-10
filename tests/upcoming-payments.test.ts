import test from "node:test";
import assert from "node:assert/strict";
import { upcomingPayments } from "../shared/upcoming-payments.js";

// Today is 30/09: the week runs to 06/10 and the 30 days to 29/10. Amounts in cents, expected values worked out by hand.
const input = {
  today: "2026-09-30",
  rules: [
    { id: "rent", name: "Alquiler", category: "Alquiler", amount: 100_000, recurrence: "monthly", nextDate: "2026-09-15" },
    { id: "cleaning", name: "Limpieza", category: "Servicios", amount: 5_000, recurrence: "weekly", nextDate: "2026-10-02" },
    { id: "insurance", name: "Seguro", category: "Seguros", amount: 30_000, recurrence: "monthly", nextDate: "2026-11-05" },
    { id: "internet", name: "Internet", category: "Servicios", amount: 8_000, recurrence: "monthly", nextDate: "2026-09-30" },
  ],
  expenses: [
    { id: "bags", name: "Bolsas", category: "Insumos", amount: 4_000, date: "2026-09-30" },
    { id: "power", name: "Luz", category: "Servicios", amount: 12_000, date: "2026-10-01" },
    { id: "taxes", name: "Impuestos", category: "Impuestos", amount: 50_000, date: "2026-10-30" },
  ],
  plans: [
    { id: "wages", description: "Sueldo", category: "operating_expense", amount: -60_000, date: "2026-09-30" },
    { id: "supplier", description: "Pago a proveedor", category: "stock_purchase", amount: -200_000, date: "2026-10-06" },
    { id: "delivery", description: "Cobro delivery", category: "delivery_receipt", amount: 50_000, date: "2026-10-03" },
    { id: "old", description: "Pago viejo", category: "operating_expense", amount: -9_000, date: "2026-09-29" },
    { id: "fee", description: "Cuota", category: "operating_expense", amount: -7_000, date: "2026-10-29" },
  ],
  obligations: [
    { id: "lot", description: "Lote interior premium", category: "stock_purchase", amount: -500_000, date: "2026-10-20" },
  ],
};

test("upcoming payments list pending recurring dates, future expenses, planned payments and obligations for the next 30 days", () => {
  const result = upcomingPayments(input);
  assert.deepEqual(result.items.map(({ date, label, amount, source, overdue }) => [date, label, amount, source, overdue]), [
    // A rule nobody registered since the 15th keeps that date, marked overdue, and still brings its next one.
    ["2026-09-15", "Alquiler", 100_000, "recurring", true],
    ["2026-09-30", "Sueldo", 60_000, "plan", false],
    // Due today is not overdue yet.
    ["2026-09-30", "Internet", 8_000, "recurring", false],
    ["2026-10-01", "Luz", 12_000, "expense", false],
    ["2026-10-02", "Limpieza", 5_000, "recurring", false],
    ["2026-10-06", "Pago a proveedor", 200_000, "plan", false],
    ["2026-10-09", "Limpieza", 5_000, "recurring", false],
    ["2026-10-15", "Alquiler", 100_000, "recurring", false],
    ["2026-10-16", "Limpieza", 5_000, "recurring", false],
    ["2026-10-20", "Lote interior premium", 500_000, "obligation", false],
    ["2026-10-23", "Limpieza", 5_000, "recurring", false],
    ["2026-10-29", "Cuota", 7_000, "plan", false],
  ]);
});

test("the week adds today through the sixth day after it and keeps overdue dates apart", () => {
  const result = upcomingPayments(input);
  assert.deepEqual([result.weekEnd, result.until], ["2026-10-06", "2026-10-29"]);
  // 60.000 + 8.000 + 12.000 + 5.000 + 200.000.
  assert.deepEqual([result.weekTotal, result.weekCount], [285_000, 5]);
  // The week plus 5.000 + 100.000 + 5.000 + 500.000 + 5.000 + 7.000.
  assert.equal(result.total, 907_000);
  assert.deepEqual([result.overdueTotal, result.overdueCount], [100_000, 1]);
});
