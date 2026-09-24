import { Prisma, type User } from "@prisma/client";
import { db, getSettings } from "./db.js";
import { businessDate } from "../shared/domain.js";
import { visitCadence, type CustomerInsights } from "../shared/customer-insights.js";
import { ownerScope } from "./state.js";
import { HttpError } from "./validation.js";

export async function customerInsights(user: User, id: string, requested?: string): Promise<CustomerInsights> {
  const ownerId = ownerScope(user, requested);
  const visible = await db.customer.findFirst({
    where: { id, ...(user.role === "responsible" ? { sales: { some: { items: { some: { ownerId: user.id } } } } } : {}) },
    select: { id: true },
  });
  if (!visible) throw new HttpError(404, "Socio no encontrado");
  const today = businessDate(await getSettings());
  const saleScope = ownerId
    ? Prisma.sql`JOIN "SaleItem" i ON i."saleId" = s.id AND i."ownerId" = ${ownerId}`
    : Prisma.empty;
  const [totals, recentDates, favorite] = await Promise.all([
    ownerId ? db.$queryRaw<Array<{ purchases: bigint; spent: bigint; lastPurchase: string | null }>>`
      WITH scoped AS (
        SELECT s.id, s.date, SUM(i.revenue)::bigint AS total
        FROM "Sale" s ${saleScope}
        WHERE s."customerId" = ${id} AND s.date <= ${today}
        GROUP BY s.id, s.date
      )
      SELECT COUNT(*)::bigint AS purchases, COALESCE(SUM(total), 0)::bigint AS spent,
        MAX(date) AS "lastPurchase" FROM scoped`
      : db.$queryRaw<Array<{ purchases: bigint; spent: bigint; lastPurchase: string | null }>>`
      SELECT COUNT(*)::bigint AS purchases, COALESCE(SUM(total), 0)::bigint AS spent,
        MAX(date) AS "lastPurchase" FROM "Sale" WHERE "customerId" = ${id} AND date <= ${today}`,
    db.$queryRaw<Array<{ date: string }>>`
      SELECT DISTINCT s.date FROM "Sale" s ${saleScope}
      WHERE s."customerId" = ${id} AND s.date <= ${today}
      ORDER BY s.date DESC LIMIT 9`,
    db.$queryRaw<Array<{ name: string; purchases: bigint }>>`
      SELECT i.name, COUNT(DISTINCT s.id)::bigint AS purchases
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE s."customerId" = ${id} AND s.date <= ${today}
        ${ownerId ? Prisma.sql`AND i."ownerId" = ${ownerId}` : Prisma.empty}
      GROUP BY i.name ORDER BY purchases DESC, MAX(s.date) DESC, i.name ASC LIMIT 1`,
  ]);
  const purchases = Number(totals[0]?.purchases || 0);
  return {
    purchases,
    averageTicket: purchases ? Math.round(Number(totals[0].spent) / purchases) : 0,
    lastPurchase: totals[0]?.lastPurchase || null,
    favoriteProduct: favorite[0] ? { name: favorite[0].name, purchases: Number(favorite[0].purchases) } : null,
    ...visitCadence(recentDates.map((row) => row.date)),
  };
}
