import { Prisma, type User } from "@prisma/client";
import { db, getSettings } from "./db.js";
import { businessDate } from "../shared/domain.js";
export type ViewName = "dashboard" | "inventory" | "customers" | "sales" | "expenses" | "finance" | "responsibles" | "reports" | "settings";
export const publicUser = {
  id: true,
  name: true,
  email: true,
  role: true,
  color: true,
} as const;
export function ownerScope(user: User, requested?: string): string | undefined {
  return user.role === "responsible" ? user.id : requested || undefined;
}
export async function getState(user: User, requested: string | undefined, view: ViewName, requestedMonth?: string) {
  const ownerId = ownerScope(user, requested);
  const settings = await getSettings();
  const restricted = user.role === "cashier";
  const today = businessDate(settings);
  const monthStart = `${today.slice(0, 7)}-01`;
  const expenseMonth = requestedMonth || today.slice(0, 7);
  const needsProducts = ["dashboard", "finance", "responsibles"].includes(view);
  const [users, products, closures, cashPlans] =
    await Promise.all([
      db.user.findMany({
        select: publicUser,
        where: user.role === "responsible" ? { id: user.id } : undefined,
        orderBy: { name: "asc" },
      }),
      needsProducts ? db.product.findMany({
        where: ownerId ? { ownerId } : undefined,
        orderBy: { name: "asc" },
        include: { supplierRef: { select: { name: true } } },
      }) : Promise.resolve([]),
      ownerId || user.role === "viewer" || view !== "sales"
        ? Promise.resolve([])
        : db.closure.findMany({ orderBy: { date: "desc" }, take: 90 }),
      view === "finance" && (user.role === "owner" || user.role === "admin")
        ? db.cashPlan.findMany({ orderBy: { date: "asc" } })
        : Promise.resolve([]),
    ]);
  const previousClosure = ownerId || user.role === "viewer" || view !== "sales" ? null : await db.closure.findFirst({
    where: { date: { lt: today } },
    orderBy: { date: "desc" },
  });
  const financeBalance = view === "finance" && ["owner", "admin"].includes(user.role) ?
    ((await db.cashEntry.aggregate({ where: { date: { lte: today } }, _sum: { amount: true } }))._sum.amount || 0) : 0;
  const cashExpected = ownerId || user.role === "viewer" || view !== "sales" ? 0 :
    (previousClosure?.counted || 0) + ((await db.cashEntry.aggregate({
      where: { account: "cash", date: { gt: previousClosure?.date || "0000-00-00", lte: today } },
      _sum: { amount: true },
    }))._sum.amount || 0);
  const todaySales = view === "sales" ? ownerId
    ? await db.$queryRaw<Array<{ total: bigint; count: bigint }>>`
        SELECT COALESCE(SUM(i.revenue), 0)::bigint AS total, COUNT(DISTINCT s.id)::bigint AS count
        FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
        WHERE i."ownerId" = ${ownerId} AND s.date = ${today}`
    : await db.$queryRaw<Array<{ total: bigint; count: bigint }>>`
        SELECT COALESCE(SUM(total), 0)::bigint AS total, COUNT(*)::bigint AS count FROM "Sale" WHERE date = ${today}`
    : [];
  const periodStart = view === "expenses" ? `${expenseMonth}-01` : monthStart;
  const periodEnd = view === "expenses" ? (() => {
    const next = new Date(`${periodStart}T12:00:00Z`);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next.toISOString().slice(0, 10);
  })() : (() => {
    const next = new Date(`${today}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString().slice(0, 10);
  })();
  const needsPeriod = ["expenses", "finance", "responsibles"].includes(view);
  const periodRows = !needsPeriod ? [] : ownerId
    ? await db.$queryRaw<Array<{ revenue: bigint; cost: bigint }>>`
        SELECT COALESCE(SUM(i.revenue), 0)::bigint AS revenue, COALESCE(SUM(i.cost), 0)::bigint AS cost
        FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
        WHERE i."ownerId" = ${ownerId} AND s.date >= ${periodStart} AND s.date < ${periodEnd}`
    : await db.$queryRaw<Array<{ revenue: bigint; cost: bigint }>>`
        SELECT COALESCE(SUM(total), 0)::bigint AS revenue, COALESCE(SUM(cost), 0)::bigint AS cost
        FROM "Sale" WHERE date >= ${periodStart} AND date < ${periodEnd}`;
  const periodExpense = view === "finance" && !restricted ? (await db.expense.aggregate({
    where: { ...(ownerId ? { ownerId } : {}), date: { gte: monthStart, lte: today } }, _sum: { amount: true },
  }))._sum.amount || 0 : 0;
  const responsibleRows = view === "responsibles" ? await db.$queryRaw<Array<{
    ownerId: string; productId: string; name: string; revenue: bigint; cost: bigint;
  }>>`SELECT i."ownerId", i."productId", MIN(i.name) AS name,
      SUM(i.revenue)::bigint AS revenue, SUM(i.cost)::bigint AS cost
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE s.date >= ${monthStart} AND s.date <= ${today}
        ${ownerId ? Prisma.sql`AND i."ownerId" = ${ownerId}` : Prisma.empty}
      GROUP BY i."ownerId", i."productId"` : [];
  const lowRows = ownerId
    ? await db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Product" WHERE "ownerId" = ${ownerId} AND stock <= minimum`
    : await db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Product" WHERE stock <= minimum`;
  const lowStockAlerts = ownerId
    ? await db.$queryRaw<Array<{ id: string; name: string; stock: number; minimum: number; unit: string }>>`SELECT id, name, stock, minimum, unit FROM "Product" WHERE "ownerId" = ${ownerId} AND stock <= minimum ORDER BY name LIMIT 20`
    : await db.$queryRaw<Array<{ id: string; name: string; stock: number; minimum: number; unit: string }>>`SELECT id, name, stock, minimum, unit FROM "Product" WHERE stock <= minimum ORDER BY name LIMIT 20`;
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      color: user.color,
    },
    users,
    products: products.map(({ supplierRef, ...p }) => ({ ...p, supplier: supplierRef?.name || p.supplier, cost: restricted ? 0 : p.cost })),
    closures,
    cashPlans,
    financeBalance,
    periodRevenue: Number(periodRows[0]?.revenue || 0),
    periodCost: restricted ? 0 : Number(periodRows[0]?.cost || 0),
    periodExpense,
    responsibleRows: responsibleRows.map((row) => ({ ...row, revenue: Number(row.revenue), cost: Number(row.cost) })),
    cashExpected,
    salesTodayTotal: Number(todaySales[0]?.total || 0),
    salesTodayCount: Number(todaySales[0]?.count || 0),
    lowStockCount: Number(lowRows[0]?.count || 0),
    lowStockAlerts,
    operationsEnabled: process.env.DEMO_MODE === "true" || process.env.CLUB_OPERATIONS_APPROVED === "true",
    settings,
    today,
    demo: process.env.DEMO_MODE === "true",
  };
}
