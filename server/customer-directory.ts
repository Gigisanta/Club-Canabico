import { Prisma, type User } from "@prisma/client";
import { db, getSettings } from "./db.js";
import { businessDate, tier } from "../shared/domain.js";
import { ownerScope } from "./state.js";

export interface CustomerFilters {
  q: string;
  segment: "all" | "top" | "inactive" | "risk" | "permits";
  days: number;
  cursor: { id: string; name?: string; spent?: number } | null;
}

export async function customerDirectoryPage(user: User, requested: string | undefined, filters: CustomerFilters) {
  const ownerId = ownerScope(user, requested);
  const settings = await getSettings();
  const today = businessDate(settings);
  const deadline = new Date(`${today}T12:00:00Z`);
  deadline.setUTCDate(deadline.getUTCDate() + 14);
  const permitDeadline = deadline.toISOString().slice(0, 10);
  const history = ownerId ? Prisma.sql`
    scoped AS (
      SELECT s."customerId", SUM(i.revenue)::bigint AS total,
        COUNT(DISTINCT s.id)::bigint AS purchases
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE i."ownerId" = ${ownerId}
      GROUP BY s."customerId"
    ), scoped_latest AS (
      SELECT DISTINCT ON (s."customerId") s."customerId", s.date
      FROM "Sale" s JOIN "SaleItem" i ON i."saleId" = s.id
      WHERE i."ownerId" = ${ownerId}
      ORDER BY s."customerId", s."createdAt" DESC, s.id DESC
    ),` : Prisma.empty;
  const historyJoin = ownerId
    ? Prisma.sql`LEFT JOIN scoped h ON h."customerId" = c.id`
    : Prisma.sql`LEFT JOIN lifetime h ON h."customerId" = c.id`;
  const latestJoin = ownerId
    ? Prisma.sql`LEFT JOIN scoped_latest hl ON hl."customerId" = c.id`
    : Prisma.sql`LEFT JOIN latest hl ON hl."customerId" = c.id`;
  const visible = user.role === "responsible" ? Prisma.sql`WHERE h.purchases > 0` : Prisma.empty;
  const directory = Prisma.sql`
    WITH lifetime AS (
      SELECT "customerId", SUM(total)::bigint AS total,
        COUNT(*)::bigint AS purchases
      FROM "Sale" GROUP BY "customerId"
    ), latest AS (
      SELECT DISTINCT ON ("customerId") "customerId", date
      FROM "Sale" ORDER BY "customerId", "createdAt" DESC, id DESC
    ), ${history}
    directory AS MATERIALIZED (
      SELECT c.*, COALESCE(h.total, 0)::bigint AS "totalSpent",
        COALESCE(h.purchases, 0)::bigint AS purchases,
        hl.date AS "lastPurchase", COALESCE(l.total, 0)::bigint AS "lifetimeSpent",
        (${today}::date - COALESCE(hl.date::date,
          (c."createdAt" AT TIME ZONE 'UTC')::date))::int AS "inactiveDays"
      FROM "Customer" c
      LEFT JOIN lifetime l ON l."customerId" = c.id
      ${historyJoin}
      ${latestJoin}
      ${visible}
    )`;
  const threshold = Math.floor(filters.days / 2);
  const searchable = ["owner", "admin", "cashier"].includes(user.role)
    ? Prisma.sql`LOWER(d.name || ' ' || d.email)`
    : Prisma.sql`LOWER(d.name || ' ')`;
  const searched = filters.q
    ? Prisma.sql`POSITION(LOWER(${filters.q}) IN ${searchable}) > 0`
    : Prisma.sql`TRUE`;
  const segment = filters.segment === "top" ? Prisma.sql`d.purchases > 0`
    : filters.segment === "inactive" ? Prisma.sql`d."inactiveDays" >= ${filters.days}`
    : filters.segment === "risk" ? Prisma.sql`d."inactiveDays" >= ${threshold} AND d."inactiveDays" < ${filters.days}`
    : filters.segment === "permits" ? Prisma.sql`(d."permitStatus" IN ('pending', 'expired') OR
      (d."permitStatus" = 'verified' AND d."permitValidUntil" <= ${permitDeadline}))`
    : Prisma.sql`TRUE`;
  const selected = Prisma.sql`${searched} AND ${segment}`;
  const cursor = filters.cursor;
  const cursorFilter = !cursor ? Prisma.empty : filters.segment === "top"
    ? Prisma.sql`AND (f."totalSpent" < ${cursor.spent!} OR (f."totalSpent" = ${cursor.spent!} AND f.id > ${cursor.id}))`
    : Prisma.sql`AND (f.name, f.id) > (${cursor.name!}, ${cursor.id})`;
  const order = filters.segment === "top"
    ? Prisma.sql`f."totalSpent" DESC, f.id ASC`
    : Prisma.sql`f.name ASC, f.id ASC`;
  type Row = {
    id: string; name: string; email: string; phone: string; notes: string; points: number;
    permitStatus: string; permitValidUntil: string | null; permitCheckedAt: Date | null;
    sourceSystem: string | null; sourceId: string | null; createdAt: Date;
    totalSpent: bigint; purchases: bigint; lastPurchase: string | null;
    lifetimeSpent: bigint; inactiveDays: number;
  };
  const [summaryRows, rows] = await Promise.all([
    db.$queryRaw<Array<{ total: bigint; gold: bigint; inactive: bigint; filtered: bigint }>>`
      ${directory}
      SELECT COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE d."lifetimeSpent" >= ${settings.goldAt})::bigint AS gold,
        COUNT(*) FILTER (WHERE d."inactiveDays" >= ${filters.days})::bigint AS inactive,
        COUNT(*) FILTER (WHERE ${selected})::bigint AS filtered
      FROM directory d`,
    db.$queryRaw<Row[]>`
      ${directory}, filtered AS MATERIALIZED (
        SELECT d.* FROM directory d WHERE ${selected}
      )
      SELECT f.* FROM filtered f WHERE TRUE ${cursorFilter}
      ORDER BY ${order} LIMIT 51`,
  ]);
  const items = rows.slice(0, 50).map((row) => {
    const { lifetimeSpent, inactiveDays, ...customer } = row;
    const canContact = ["owner", "admin", "cashier"].includes(user.role);
    const canVerify = ["owner", "admin"].includes(user.role);
    return {
      ...customer,
      totalSpent: Number(customer.totalSpent), purchases: Number(customer.purchases),
      tier: tier(Number(lifetimeSpent), settings),
      notes: canContact ? customer.notes : "",
      email: canContact ? customer.email : "",
      phone: canContact ? customer.phone : "",
      permitStatus: canContact ? customer.permitStatus : "unverified",
      permitValidUntil: canContact ? customer.permitValidUntil : null,
      permitCheckedAt: canVerify ? customer.permitCheckedAt : null,
      sourceSystem: canVerify ? customer.sourceSystem : null,
      sourceId: canVerify ? customer.sourceId : null,
      points: user.role === "responsible" ? 0 : customer.points,
    };
  });
  const last = rows[49];
  return {
    items,
    total: Number(summaryRows[0]?.filtered || 0),
    next: rows.length > 50 && last
      ? filters.segment === "top" ? { id: last.id, spent: Number(last.totalSpent) }
        : { id: last.id, name: last.name }
      : null,
    summary: {
      total: Number(summaryRows[0]?.total || 0),
      gold: Number(summaryRows[0]?.gold || 0),
      inactive: Number(summaryRows[0]?.inactive || 0),
    },
  };
}
