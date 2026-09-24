import { Prisma, type User } from "@prisma/client";
import { z } from "zod";
import { db, getSettings } from "./db.js";
import { businessDate, tier } from "../shared/domain.js";
import { ownerScope } from "./state.js";

const offset = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

export async function dashboardMetrics(user: User, requested: string | undefined, raw: unknown) {
  const { range, inactiveDays } = z.object({
    range: z.enum(["today", "week", "month"]).default("month"),
    inactiveDays: z.coerce.number().int().min(1).max(3650).default(60),
  }).parse(raw);
  const settings = await getSettings();
  const today = businessDate(settings);
  const start = range === "today" ? today : range === "week" ? offset(today, -6) : `${today.slice(0, 7)}-01`;
  const length = Math.floor((Date.parse(today) - Date.parse(start)) / 86400000) + 1;
  const previousStart = offset(start, -length);
  const ownerId = ownerScope(user, requested);
  const restricted = user.role === "cashier";
  type Day = { date: string; total: bigint; cost: bigint; count: bigint };
  type CustomerRow = { customerId: string; amount: bigint; count: bigint };
  const [daily, customerRows, expenseRows, ownerRows, customerSummary] = await Promise.all([
    ownerId
      ? db.$queryRaw<Day[]>`SELECT s.date, SUM(i.revenue)::bigint AS total, SUM(i.cost)::bigint AS cost,
          COUNT(DISTINCT s.id)::bigint AS count FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
          WHERE i."ownerId" = ${ownerId} AND s.date >= ${previousStart} AND s.date <= ${today} GROUP BY s.date`
      : db.$queryRaw<Day[]>`SELECT date, SUM(total)::bigint AS total, SUM(cost)::bigint AS cost,
          COUNT(*)::bigint AS count FROM "Sale" WHERE date >= ${previousStart} AND date <= ${today} GROUP BY date`,
    ownerId
      ? db.$queryRaw<CustomerRow[]>`SELECT s."customerId", SUM(i.revenue)::bigint AS amount,
          COUNT(DISTINCT s.id)::bigint AS count FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
          WHERE i."ownerId" = ${ownerId} AND s.date >= ${start} AND s.date <= ${today} GROUP BY s."customerId"`
      : db.$queryRaw<CustomerRow[]>`SELECT "customerId", SUM(total)::bigint AS amount,
          COUNT(*)::bigint AS count FROM "Sale" WHERE date >= ${start} AND date <= ${today} GROUP BY "customerId"`,
    restricted ? Promise.resolve([]) : db.expense.groupBy({
      by: ["date"], where: { ...(ownerId ? { ownerId } : {}), date: { gte: previousStart, lte: today } },
      _sum: { amount: true },
    }),
    db.$queryRaw<Array<{ ownerId: string; revenue: bigint; cost: bigint }>>`
      SELECT i."ownerId", SUM(i.revenue)::bigint AS revenue, SUM(i.cost)::bigint AS cost
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE s.date >= ${start} AND s.date <= ${today}
        ${ownerId ? Prisma.sql`AND i."ownerId" = ${ownerId}` : Prisma.empty}
      GROUP BY i."ownerId"`,
    db.$queryRaw<Array<{ total: bigint; inactive: bigint }>>`
      SELECT COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE COALESCE(last_sale.date, to_char(c."createdAt", 'YYYY-MM-DD')) <= ${offset(today, -inactiveDays)})::bigint AS inactive
      FROM "Customer" c LEFT JOIN (
        SELECT s."customerId", MAX(s.date) AS date FROM "Sale" s
        ${ownerId ? Prisma.sql`JOIN "SaleItem" i ON i."saleId" = s.id AND i."ownerId" = ${ownerId}` : Prisma.empty}
        GROUP BY s."customerId"
      ) last_sale ON last_sale."customerId" = c.id
      ${user.role === "responsible" ? Prisma.sql`WHERE last_sale.date IS NOT NULL` : Prisma.empty}`,
  ]);
  const days = new Map(daily.map((row) => [row.date, row]));
  const expensesByDay = new Map(expenseRows.map((row) => [row.date, row._sum.amount || 0]));
  const inRange = daily.filter((row) => row.date >= start);
  const before = daily.filter((row) => row.date < start).reduce((sum, row) => sum + Number(row.total), 0);
  const total = inRange.reduce((sum, row) => sum + Number(row.total), 0);
  const count = inRange.reduce((sum, row) => sum + Number(row.count), 0);
  const cost = restricted ? 0 : inRange.reduce((sum, row) => sum + Number(row.cost), 0);
  const expenses = expenseRows.filter((row) => row.date >= start).reduce((sum, row) => sum + (row._sum.amount || 0), 0);
  const monthlyExpenses = restricted ? 0 : (await db.expense.aggregate({
    where: { ...(ownerId ? { ownerId } : {}), date: { gte: `${today.slice(0, 7)}-01`, lte: today } },
    _sum: { amount: true },
  }))._sum.amount || 0;
  const sortedVolume = [...customerRows].sort((a, b) => Number(b.amount - a.amount) || a.customerId.localeCompare(b.customerId));
  const sortedFrequency = [...customerRows].sort((a, b) => Number(b.count - a.count) || a.customerId.localeCompare(b.customerId));
  const ids = [...new Set([...sortedVolume.slice(0, 10), ...sortedFrequency.slice(0, 10)].map((row) => row.customerId))];
  const [names, lifetime] = ids.length ? await Promise.all([
    db.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    db.sale.groupBy({ by: ["customerId"], where: { customerId: { in: ids } }, _sum: { total: true } }),
  ]) : [[], []];
  const namesById = new Map(names.map((row) => [row.id, row.name]));
  const lifetimeById = new Map(lifetime.map((row) => [row.customerId, row._sum.total || 0]));
  const top = (rows: CustomerRow[]) => rows.slice(0, 10).map((row) => ({
    id: row.customerId, name: namesById.get(row.customerId) || "Socio", amount: Number(row.amount),
    count: Number(row.count), tier: tier(lifetimeById.get(row.customerId) || 0, settings),
  }));
  return {
    start, previousStart, length, total, before, cost, count, expenses,
    monthlyExpenses,
    active: customerRows.length, returning: customerRows.filter((row) => Number(row.count) > 1).length,
    customerTotal: Number(customerSummary[0]?.total || 0), inactive: Number(customerSummary[0]?.inactive || 0),
    chart: Array.from({ length }, (_, i) => {
      const date = offset(start, i);
      return { date, revenue: Number(days.get(date)?.total || 0) / 100,
        previous: Number(days.get(offset(date, -length))?.total || 0) / 100,
        expenses: (expensesByDay.get(date) || 0) / 100 };
    }),
    owners: ownerRows.map((row) => ({ ownerId: row.ownerId, revenue: Number(row.revenue), cost: restricted ? 0 : Number(row.cost) })),
    topVolume: top(sortedVolume), topFrequency: top(sortedFrequency),
  };
}
