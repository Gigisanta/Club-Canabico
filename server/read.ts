import { Prisma, type User } from "@prisma/client";
import { z } from "zod";
import { db, getSettings } from "./db.js";
import { ownerScope } from "./state.js";
import { customerDirectoryPage } from "./customer-directory.js";
import { businessDate, tier } from "../shared/domain.js";
import { HttpError } from "./validation.js";

const pageSize = 50;
const pageQuery = z.object({
  q: z.string().trim().max(120).default(""),
  cursor: z.string().max(500).optional(),
});
function decodeCursor(cursor?: string): { id: string; createdAt?: string; name?: string; spent?: number } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value.id !== "string" || !value.id || value.id.length > 100 ||
        (value.name !== undefined && (typeof value.name !== "string" || value.name.length > 250)) ||
        (value.spent !== undefined && (typeof value.spent !== "number" || !Number.isSafeInteger(value.spent))) ||
        (value.createdAt !== undefined && (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))))) throw new Error();
    return value;
  } catch { throw new HttpError(400, "Cursor inválido"); }
}
const encodeCursor = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export async function customerPage(user: User, requested: string | undefined, raw: unknown) {
  const v = pageQuery.extend({
    segment: z.enum(["all", "top", "inactive", "risk", "permits"]).default("all"),
    days: z.coerce.number().int().min(1).max(3650).default(60),
  }).parse(raw);
  if (v.segment === "permits" && !["owner", "admin"].includes(user.role)) throw new HttpError(403, "Segmento restringido");
  const cursor = decodeCursor(v.cursor);
  if (cursor && (v.segment === "top" ? cursor.spent === undefined : !cursor.name))
    throw new HttpError(400, "Cursor inválido");
  const page = await customerDirectoryPage(user, requested, { ...v, cursor });
  return { items: page.items, total: page.total, nextCursor: page.next ? encodeCursor(page.next) : null, summary: page.summary };
}

export async function productPage(user: User, requested: string | undefined, raw: unknown) {
  const v = pageQuery.extend({
    filter: z.enum(["all", "low", "expired"]).default("all"),
    type: z.string().trim().max(80).default("all"),
    supplier: z.string().trim().max(100).default("all"),
  }).parse(raw);
  const cursor = decodeCursor(v.cursor);
  if (cursor && !cursor.name) throw new HttpError(400, "Cursor inválido");
  const ownerId = ownerScope(user, requested);
  const today = businessDate(await getSettings());
  const clauses: Prisma.Sql[] = [];
  if (ownerId) clauses.push(Prisma.sql`p."ownerId" = ${ownerId}`);
  if (v.q) clauses.push(Prisma.sql`(p.name ILIKE ${`%${v.q}%`} OR p.strain ILIKE ${`%${v.q}%`} OR p.lot ILIKE ${`%${v.q}%`} OR u.name ILIKE ${`%${v.q}%`})`);
  if (v.type !== "all") clauses.push(Prisma.sql`p.type = ${v.type}`);
  if (v.supplier === "unassigned") clauses.push(Prisma.sql`p."supplierId" IS NULL`);
  else if (v.supplier !== "all") clauses.push(Prisma.sql`p."supplierId" = ${v.supplier}`);
  if (v.filter === "low") clauses.push(Prisma.sql`p.stock <= p.minimum`);
  if (v.filter === "expired") clauses.push(Prisma.sql`p.expires <= ${today}`);
  const filters = clauses.length ? Prisma.sql`WHERE ${Prisma.join(clauses, " AND ")}` : Prisma.empty;
  const cursorFilter = cursor ? Prisma.sql`AND (p.name, p.id) > (${cursor.name}, ${cursor.id})` : Prisma.empty;
  const pageFilters = clauses.length ? Prisma.sql`${filters} ${cursorFilter}` : cursor ? Prisma.sql`WHERE (p.name, p.id) > (${cursor.name}, ${cursor.id})` : Prisma.empty;
  const [rows, countRows, summaryRows] = await Promise.all([
    db.$queryRaw<Array<{ id: string; name: string; strain: string; type: string; unit: string; lot: string; supplier: string; supplierId: string | null; sourceSystem: string | null; sourceId: string | null; stock: number; minimum: number; cost: number; price: number; location: string; locationId: string | null; ownerId: string; expires: string | null; createdAt: Date }>>`
      SELECT p.id, p.name, p.strain, p.type, p.unit, p.lot, COALESCE(s.name, p.supplier) AS supplier,
             p."supplierId", p."sourceSystem", p."sourceId", p.stock, p.minimum, p.cost, p.price,
             p.location, p."locationId", p."ownerId", p.expires, p."createdAt"
      FROM "Product" p JOIN "User" u ON u.id = p."ownerId"
      LEFT JOIN "Supplier" s ON s.id = p."supplierId" ${pageFilters}
      ORDER BY p.name ASC, p.id ASC LIMIT ${pageSize + 1}`,
    db.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint AS count FROM "Product" p JOIN "User" u ON u.id = p."ownerId" ${filters}`,
    ownerId
      ? db.$queryRaw<Array<{ total: bigint; low: bigint; value: bigint }>>`SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE stock <= minimum)::bigint AS low, COALESCE(SUM(ROUND(stock::numeric * cost / 1000)), 0)::bigint AS value FROM "Product" WHERE "ownerId" = ${ownerId}`
      : db.$queryRaw<Array<{ total: bigint; low: bigint; value: bigint }>>`SELECT COUNT(*)::bigint AS total, COUNT(*) FILTER (WHERE stock <= minimum)::bigint AS low, COALESCE(SUM(ROUND(stock::numeric * cost / 1000)), 0)::bigint AS value FROM "Product"`,
  ]);
  const hasNext = rows.length > pageSize;
  const items = rows.slice(0, pageSize).map((p) => ({ ...p, cost: user.role === "cashier" ? 0 : p.cost }));
  return { items, total: Number(countRows[0]?.count || 0),
    nextCursor: hasNext ? encodeCursor({ id: items.at(-1)!.id, name: items.at(-1)!.name }) : null,
    summary: { total: Number(summaryRows[0]?.total || 0), low: Number(summaryRows[0]?.low || 0), value: user.role === "cashier" ? 0 : Number(summaryRows[0]?.value || 0) } };
}

export async function checkoutCustomers(user: User, raw: unknown) {
  const q = z.string().trim().max(120).parse(raw || "");
  const ownerId = ownerScope(user);
  const customers = await db.customer.findMany({
    where: {
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
      ...(ownerId ? { sales: { some: { items: { some: { ownerId } } } } } : {}),
    },
    orderBy: [{ name: "asc" }, { id: "asc" }], take: 20,
    select: { id: true, name: true, points: true },
  });
  const settings = await getSettings();
  const totals = customers.length ? await db.sale.groupBy({
    by: ["customerId"], where: { customerId: { in: customers.map((c) => c.id) } }, _sum: { total: true },
  }) : [];
  const map = new Map(totals.map((x) => [x.customerId, x._sum.total || 0]));
  return { items: customers.map((c) => ({ ...c, points: user.role === "responsible" ? 0 : c.points,
    tier: tier(map.get(c.id) || 0, settings) })) };
}

export async function checkoutProducts(user: User, requested?: string) {
  const ownerId = ownerScope(user, requested);
  const today = businessDate(await getSettings());
  return { items: await db.product.findMany({
    where: { stock: { gt: 0 }, ...(ownerId ? { ownerId } : {}), OR: [{ expires: null }, { expires: { gte: today } }] },
    orderBy: [{ name: "asc" }, { lot: "asc" }],
    select: { id: true, name: true, lot: true, price: true, stock: true, unit: true, ownerId: true, expires: true },
  }) };
}

export async function globalSearch(user: User, requested: string | undefined, raw: unknown) {
  const q = z.string().trim().min(1).max(120).parse(raw);
  const ownerId = ownerScope(user, requested);
  const [products, customers] = await Promise.all([
    db.product.findMany({ where: { ...(ownerId ? { ownerId } : {}), OR: [
      { name: { contains: q, mode: "insensitive" } }, { lot: { contains: q, mode: "insensitive" } },
    ] }, orderBy: { name: "asc" }, take: 6, select: { name: true, lot: true } }),
    db.customer.findMany({ where: { name: { contains: q, mode: "insensitive" },
      ...(user.role === "responsible" ? { sales: { some: { items: { some: { ownerId: user.id } } } } } : {}),
    }, orderBy: { name: "asc" }, take: 6, select: { name: true } }),
  ]);
  return { items: [
    ...products.map((p) => ({ name: p.name, type: p.lot, path: "/inventario" })),
    ...customers.map((c) => ({ name: c.name, type: "Socio", path: "/socios" })),
  ] };
}

export async function salesPage(user: User, requested: string | undefined, raw: unknown) {
  const v = pageQuery.extend({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(raw);
  const cursor = decodeCursor(v.cursor);
  if (cursor && !cursor.createdAt) throw new HttpError(400, "Cursor inválido");
  const ownerId = ownerScope(user, requested);
  const where: Prisma.SaleWhereInput = {
    ...(ownerId ? { items: { some: { ownerId } } } : {}),
    ...(v.date ? { date: v.date } : {}),
    ...(v.q ? { OR: [{ id: { contains: v.q, mode: "insensitive" } }, { customer: { name: { contains: v.q, mode: "insensitive" } } }] } : {}),
  };
  const pageWhere: Prisma.SaleWhereInput = cursor ? { AND: [where, { OR: [
    { createdAt: { lt: new Date(cursor.createdAt!) } },
    { createdAt: new Date(cursor.createdAt!), id: { lt: cursor.id } },
  ] }] } : where;
  const [sales, total] = await Promise.all([
    db.sale.findMany({ where: pageWhere, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: pageSize + 1,
      include: { customer: { select: { name: true } }, items: ownerId ? { where: { ownerId } } : true },
    }),
    db.sale.count({ where }),
  ]);
  const hasNext = sales.length > pageSize;
  const items = sales.slice(0, pageSize).map((s) => {
    const { customer, ...sale } = s;
    const scoped = ownerId ? {
      ...sale,
      total: sale.items.reduce((n, i) => n + i.revenue, 0),
      cost: sale.items.reduce((n, i) => n + i.cost, 0),
      subtotal: sale.items.reduce((n, i) => n + Math.round(i.quantity * i.price / 1000), 0),
      discount: sale.items.reduce((n, i) => n + Math.round(i.quantity * i.price / 1000) - i.revenue, 0),
      pointsEarned: 0, pointsUsed: 0,
    } : sale;
    return { ...scoped, customerName: customer.name,
      cost: user.role === "cashier" ? 0 : scoped.cost,
      items: scoped.items.map((i) => ({ ...i, cost: user.role === "cashier" ? 0 : i.cost })) };
  });
  return { items, total, nextCursor: hasNext ? encodeCursor({ id: items.at(-1)!.id, createdAt: items.at(-1)!.createdAt }) : null,
    summary: { pageCount: items.length } };
}

export async function customerHistory(user: User, id: string, raw: unknown) {
  const v = pageQuery.pick({ cursor: true }).extend({ owner: z.string().max(100).optional() }).parse(raw);
  const cursor = decodeCursor(v.cursor);
  if (cursor && !cursor.createdAt) throw new HttpError(400, "Cursor inválido");
  const ownerId = ownerScope(user, v.owner);
  const customer = await db.customer.findFirst({ where: { id, ...(user.role === "responsible" ? { sales: { some: { items: { some: { ownerId: user.id } } } } } : {}) }, select: { id: true } });
  if (!customer) throw new HttpError(404, "Socio no encontrado");
  const where: Prisma.SaleWhereInput = { customerId: id, ...(ownerId ? { items: { some: { ownerId } } } : {}) };
  const rows = await db.sale.findMany({
    where: cursor ? { AND: [where, { OR: [{ createdAt: { lt: new Date(cursor.createdAt!) } }, { createdAt: new Date(cursor.createdAt!), id: { lt: cursor.id } }] }] } : where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: pageSize + 1,
    include: { items: ownerId ? { where: { ownerId } } : true },
  });
  const hasNext = rows.length > pageSize;
  const items = rows.slice(0, pageSize).map((s) => ({ ...s,
    total: ownerId ? s.items.reduce((n, i) => n + i.revenue, 0) : s.total,
    cost: user.role === "cashier" ? 0 : ownerId ? s.items.reduce((n, i) => n + i.cost, 0) : s.cost,
    subtotal: ownerId ? s.items.reduce((n, i) => n + Math.round(i.quantity * i.price / 1000), 0) : s.subtotal,
    discount: ownerId ? s.items.reduce((n, i) => n + Math.round(i.quantity * i.price / 1000) - i.revenue, 0) : s.discount,
    pointsEarned: ownerId ? 0 : s.pointsEarned,
    pointsUsed: ownerId ? 0 : s.pointsUsed,
    items: s.items.map((i) => ({ ...i, cost: user.role === "cashier" ? 0 : i.cost })),
  }));
  return { items, total: await db.sale.count({ where }), nextCursor: hasNext ? encodeCursor({ id: items.at(-1)!.id, createdAt: items.at(-1)!.createdAt }) : null,
    summary: { customerId: id } };
}

export async function cashEntryPage(user: User, raw: unknown) {
  if (user.role !== "owner" && user.role !== "admin") throw new HttpError(403, "Acceso restringido");
  const v = pageQuery.pick({ cursor: true }).parse(raw);
  const cursor = decodeCursor(v.cursor);
  if (cursor && (!cursor.createdAt || !cursor.name)) throw new HttpError(400, "Cursor inválido");
  const where: Prisma.CashEntryWhereInput = cursor ? { OR: [
    { date: { lt: cursor.name } },
    { date: cursor.name, createdAt: { lt: new Date(cursor.createdAt!) } },
    { date: cursor.name, createdAt: new Date(cursor.createdAt!), id: { lt: cursor.id } },
  ] } : {};
  const [rows, total] = await Promise.all([
    db.cashEntry.findMany({ where, orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }], take: pageSize + 1,
      select: { id: true, date: true, account: true, category: true, amount: true, description: true,
        sourceSystem: true, sourceId: true, saleId: true, userId: true, createdAt: true } }),
    db.cashEntry.count(),
  ]);
  const items = rows.slice(0, pageSize);
  const last = items.at(-1);
  return { items, total, nextCursor: rows.length > pageSize && last ? encodeCursor({ id: last.id, name: last.date, createdAt: last.createdAt }) : null,
    summary: { pageCount: items.length } };
}

export async function expensePage(user: User, requested: string | undefined, raw: unknown) {
  const v = pageQuery.extend({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    kind: z.enum(["all", "fixed", "variable"]).default("all"),
  }).parse(raw);
  if (user.role === "cashier") return { items: [], total: 0, nextCursor: null, summary: { total: 0 } };
  const cursor = decodeCursor(v.cursor);
  if (cursor && !cursor.name) throw new HttpError(400, "Cursor inválido");
  const ownerId = ownerScope(user, requested);
  const base: Prisma.ExpenseWhereInput = { date: { startsWith: v.month }, ...(ownerId ? { ownerId } : {}) };
  const filtered: Prisma.ExpenseWhereInput = { ...base,
    ...(v.q ? { name: { contains: v.q, mode: "insensitive" } } : {}),
    ...(v.kind !== "all" ? { kind: v.kind } : {}),
  };
  const where: Prisma.ExpenseWhereInput = cursor ? { AND: [filtered, { OR: [
    { date: { lt: cursor.name } }, { date: cursor.name, id: { lt: cursor.id } },
  ] }] } : filtered;
  const [rows, total, summary] = await Promise.all([
    db.expense.findMany({ where, orderBy: [{ date: "desc" }, { id: "desc" }], take: pageSize + 1,
      select: { id: true, name: true, amount: true, category: true, kind: true, ownerId: true,
        date: true, recurrence: true, ruleId: true } }),
    db.expense.count({ where: filtered }),
    db.expense.aggregate({ where: base, _sum: { amount: true } }),
  ]);
  const items = rows.slice(0, pageSize);
  const last = items.at(-1);
  return { items, total, nextCursor: rows.length > pageSize && last ? encodeCursor({ id: last.id, name: last.date }) : null,
    summary: { total: summary._sum.amount || 0 } };
}

export async function movementPage(user: User, requested: string | undefined, raw: unknown) {
  const v = pageQuery.pick({ cursor: true }).parse(raw);
  const cursor = decodeCursor(v.cursor);
  if (cursor && !cursor.createdAt) throw new HttpError(400, "Cursor inválido");
  const ownerId = ownerScope(user, requested);
  const base: Prisma.MovementWhereInput = ownerId ? { OR: [{ fromOwner: ownerId }, { toOwner: ownerId }] } : {};
  const where: Prisma.MovementWhereInput = cursor ? { AND: [base, { OR: [
    { createdAt: { lt: new Date(cursor.createdAt!) } },
    { createdAt: new Date(cursor.createdAt!), id: { lt: cursor.id } },
  ] }] } : base;
  const [rows, total] = await Promise.all([
    db.movement.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 101,
      select: { id: true, productId: true, type: true, quantity: true, beforeStock: true, afterStock: true,
        fromOwner: true, toOwner: true, userId: true, note: true, createdAt: true,
        product: { select: { name: true } } } }),
    db.movement.count({ where: base }),
  ]);
  const items = rows.slice(0, 100);
  const last = items.at(-1);
  return { items, total, nextCursor: rows.length > 100 && last ? encodeCursor({ id: last.id, createdAt: last.createdAt }) : null,
    summary: { pageCount: items.length } };
}
