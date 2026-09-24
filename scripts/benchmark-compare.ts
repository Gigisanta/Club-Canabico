import assert from "node:assert/strict";
import type { ClubState, Customer, Product } from "../shared/types.js";

const baseline = process.env.BENCH_BASELINE_URL;
const optimized = process.env.BENCH_OPTIMIZED_URL;
if (!baseline || !optimized) throw new Error("Definí BENCH_BASELINE_URL y BENCH_OPTIMIZED_URL");

async function session(base: string) {
  const response = await fetch(`${base}/api/auth/login`, { method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: "bench@example.test", password: "bench-only-password" }) });
  assert.equal(response.status, 200, "La sesión de benchmark debe estar disponible");
  return response.headers.get("set-cookie")!.split(";")[0];
}
async function get<T>(base: string, cookie: string, path: string): Promise<T> {
  const response = await fetch(`${base}/api${path}`, { headers: { cookie } });
  assert.equal(response.status, 200, path);
  return response.json() as Promise<T>;
}
async function everyPage<T extends { id: string }>(base: string, cookie: string, path: string) {
  const items: T[] = [];
  let cursor: string | null = null;
  let total = 0;
  do {
    const url: string = `${path}${cursor ? `${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page: { items: T[]; total: number; nextCursor: string | null } = await get(base, cookie, url);
    total = page.total;
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(items.length, total, `${path}: cantidad de registros`);
  assert.equal(new Set(items.map((item) => item.id)).size, total, `${path}: duplicados`);
  return items;
}

const oldCookie = await session(baseline);
const newCookie = await session(optimized);
const old = await get<ClubState & { sales: { date: string; total: number; cost: number; items: { revenue: number }[] }[];
  customers: Customer[] }>(baseline, oldCookie, "/state");
const [finance, sales, dashboard, inventory, responsible, customers, products] = await Promise.all([
  get<{ periodRevenue: number; periodCost: number; financeBalance: number }>(optimized, newCookie, "/views/finance"),
  get<{ cashExpected: number }>(optimized, newCookie, "/views/sales"),
  get<{ total: number; count: number }>(optimized, newCookie, "/dashboard?range=month"),
  get<ClubState>(optimized, newCookie, "/views/inventory"),
  get<{ responsibleRows: { revenue: number }[] }>(optimized, newCookie, "/views/responsibles"),
  everyPage<Customer>(optimized, newCookie, "/list/customers"),
  everyPage<Product>(optimized, newCookie, "/list/products"),
]);
const month = `${old.today.slice(0, 7)}-01`;
const currentSales = old.sales.filter((sale) => sale.date >= month && sale.date <= old.today);
const revenue = currentSales.reduce((sum, sale) => sum + sale.total, 0);
const cost = currentSales.reduce((sum, sale) => sum + sale.cost, 0);
assert.equal(finance.periodRevenue, revenue, "ingresos del mes");
assert.equal(finance.periodCost, cost, "costo vendido del mes");
assert.equal(dashboard.total, revenue, "ventas del panel");
assert.equal(dashboard.count, currentSales.length, "cantidad de ventas");
assert.equal(finance.financeBalance, old.financeBalance, "saldo de caja");
assert.equal(sales.cashExpected, old.cashExpected, "caja esperada");
assert.equal(inventory.lowStockCount, old.products.filter((p) => p.stock <= p.minimum).length, "alertas de stock");
assert.equal(products.length, old.products.length, "cantidad de lotes");
const oldProducts = new Map(old.products.map((p) => [p.id, p]));
for (const product of products) {
  const before = oldProducts.get(product.id);
  assert(before, product.id);
  assert.deepEqual([product.stock, product.cost, product.ownerId], [before.stock, before.cost, before.ownerId], `lote ${product.id}`);
}
const oldCustomers = new Map(old.customers.map((c) => [c.id, c]));
assert.equal(customers.length, old.customers.length, "cantidad de socios");
for (const customer of customers) {
  const before = oldCustomers.get(customer.id);
  assert(before, customer.id);
  assert.deepEqual([customer.points, customer.totalSpent, customer.purchases, customer.lastPurchase, customer.tier],
    [before.points, before.totalSpent, before.purchases, before.lastPurchase, before.tier], `socio ${customer.id}`);
}
assert.equal(responsible.responsibleRows.reduce((sum, row) => sum + row.revenue, 0),
  currentSales.flatMap((sale) => sale.items).reduce((sum, item) => sum + item.revenue, 0), "atribución por responsable");
process.stdout.write(`Conciliado: ${old.sales.length} ventas, ${customers.length} socios y ${products.length} lotes; ingresos, costos, caja, puntos y responsables coinciden.\n`);
