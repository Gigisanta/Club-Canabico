import { Prisma, type User } from "@prisma/client";
import { z } from "zod";
import { db, getSettings } from "./db.js";
import { businessDate, tier } from "../shared/domain.js";
import { calculateOutlook } from "../shared/outlook.js";
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
  const recent28Start = offset(today, -27);
  const previous28Start = offset(today, -55);
  const historyStart = previousStart < previous28Start ? previousStart : previous28Start;
  const ownerId = ownerScope(user, requested);
  const restricted = user.role === "cashier";
  type Day = { date: string; total: bigint; cost: bigint; count: bigint };
  type CustomerRow = { customerId: string; amount: bigint; count: bigint };
  type CustomerSummary = { total: bigint; inactive: bigint; firstSaleDate: string | null; buyers28: bigint; repeatBuyers28: bigint; buyersPrevious28: bigint; repeatBuyersPrevious28: bigint };
  const [daily, customerRows, expenseRows, ownerRows, customerSummary] = await Promise.all([
    ownerId
      ? db.$queryRaw<Day[]>`SELECT s.date, SUM(i.revenue)::bigint AS total, SUM(i.cost)::bigint AS cost,
          COUNT(DISTINCT s.id)::bigint AS count FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
          WHERE i."ownerId" = ${ownerId} AND s.date >= ${historyStart} AND s.date <= ${today} GROUP BY s.date`
      : db.$queryRaw<Day[]>`SELECT date, SUM(total)::bigint AS total, SUM(cost)::bigint AS cost,
          COUNT(*)::bigint AS count FROM "Sale" WHERE date >= ${historyStart} AND date <= ${today} GROUP BY date`,
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
    db.$queryRaw<CustomerSummary[]>`
      SELECT COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE COALESCE(last_sale.date, to_char(c."createdAt", 'YYYY-MM-DD')) <= ${offset(today, -inactiveDays)})::bigint AS inactive,
        MIN(last_sale.first_date) AS "firstSaleDate",
        COUNT(*) FILTER (WHERE last_sale.bought_recent)::bigint AS "buyers28",
        COUNT(*) FILTER (WHERE last_sale.bought_recent AND last_sale.first_date < ${recent28Start})::bigint AS "repeatBuyers28",
        COUNT(*) FILTER (WHERE last_sale.bought_previous)::bigint AS "buyersPrevious28",
        COUNT(*) FILTER (WHERE last_sale.bought_previous AND last_sale.first_date < ${previous28Start})::bigint AS "repeatBuyersPrevious28"
      FROM "Customer" c LEFT JOIN (
        SELECT s."customerId", MAX(s.date) AS date, MIN(s.date) AS first_date,
          BOOL_OR(s.date >= ${recent28Start}) AS bought_recent,
          BOOL_OR(s.date >= ${previous28Start} AND s.date < ${recent28Start}) AS bought_previous
        FROM "Sale" s
        ${ownerId ? Prisma.sql`JOIN "SaleItem" i ON i."saleId" = s.id AND i."ownerId" = ${ownerId}` : Prisma.empty}
        WHERE s.date <= ${today}
        GROUP BY s."customerId"
      ) last_sale ON last_sale."customerId" = c.id
      ${user.role === "responsible" ? Prisma.sql`WHERE last_sale.date IS NOT NULL` : Prisma.empty}`,
  ]);
  const days = new Map(daily.map((row) => [row.date, row]));
  const expensesByDay = new Map(expenseRows.map((row) => [row.date, row._sum.amount || 0]));
  const inRange = daily.filter((row) => row.date >= start);
  const before = daily.filter((row) => row.date >= previousStart && row.date < start).reduce((sum, row) => sum + Number(row.total), 0);
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
  const pulse = customerSummary[0];
  const outlook = calculateOutlook(today, daily.map((row) => ({ date: row.date, total: Number(row.total) })), {
    firstSaleDate: pulse?.firstSaleDate || null,
    buyers28: Number(pulse?.buyers28 || 0),
    repeatBuyers28: Number(pulse?.repeatBuyers28 || 0),
    buyersPrevious28: Number(pulse?.buyersPrevious28 || 0),
    repeatBuyersPrevious28: Number(pulse?.repeatBuyersPrevious28 || 0),
  });
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
    outlook,
  };
}
