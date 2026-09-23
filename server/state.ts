import type { User, Prisma } from "@prisma/client";
import { db, getSettings } from "./db.js";
import { businessDate, tier } from "../shared/domain.js";
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
export async function getState(user: User, requested?: string) {
  const ownerId = ownerScope(user, requested);
  const settings = await getSettings();
  const restricted = user.role === "cashier";
  const salesWhere: Prisma.SaleWhereInput = ownerId
    ? { items: { some: { ownerId } } }
    : {};
  const [users, products, sales, customers, expenses, movements, closures] =
    await Promise.all([
      db.user.findMany({
        select: publicUser,
        where: user.role === "responsible" ? { id: user.id } : undefined,
        orderBy: { name: "asc" },
      }),
      db.product.findMany({
        where: ownerId ? { ownerId } : undefined,
        orderBy: { name: "asc" },
      }),
      db.sale.findMany({
        where: salesWhere,
        include: { items: ownerId ? { where: { ownerId } } : true },
        orderBy: { createdAt: "desc" },
      }),
      db.customer.findMany({
        where:
          user.role === "responsible"
            ? { sales: { some: { items: { some: { ownerId: user.id } } } } }
            : undefined,
        orderBy: { name: "asc" },
      }),
      restricted
        ? Promise.resolve([])
        : db.expense.findMany({
            where: ownerId ? { ownerId } : undefined,
            orderBy: { date: "desc" },
          }),
      db.movement.findMany({
        where: ownerId
          ? { OR: [{ fromOwner: ownerId }, { toOwner: ownerId }] }
          : undefined,
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      ownerId || user.role === "viewer"
        ? Promise.resolve([])
        : db.closure.findMany({ orderBy: { date: "desc" }, take: 90 }),
    ]);
  const lifetime = await db.sale.groupBy({
    by: ["customerId"],
    where: { customerId: { in: customers.map((c) => c.id) } },
    _sum: { total: true },
  });
  const lifetimeTotals = new Map(
    lifetime.map((s) => [s.customerId, s._sum.total || 0]),
  );
  const scopedSales = sales.map((s) => {
    const items = s.items.map((i) => ({ ...i, cost: restricted ? 0 : i.cost }));
    const total = ownerId ? items.reduce((n, i) => n + i.revenue, 0) : s.total;
    const cost = restricted
      ? 0
      : ownerId
        ? items.reduce((n, i) => n + i.cost, 0)
        : s.cost;
    return {
      ...s,
      items,
      total,
      cost,
      subtotal: ownerId
        ? items.reduce(
            (n, i) => n + Math.round((i.quantity * i.price) / 1000),
            0,
          )
        : s.subtotal,
      discount: ownerId
        ? items.reduce(
            (n, i) => n + Math.round((i.quantity * i.price) / 1000) - i.revenue,
            0,
          )
        : s.discount,
      pointsEarned: ownerId ? 0 : s.pointsEarned,
      pointsUsed: ownerId ? 0 : s.pointsUsed,
    };
  });
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      color: user.color,
    },
    users,
    products: products.map((p) => ({ ...p, cost: restricted ? 0 : p.cost })),
    sales: scopedSales,
    customers: customers.map((c) => {
      const history = scopedSales.filter((s) => s.customerId === c.id);
      const totalSpent = history.reduce((n, s) => n + s.total, 0);
      return {
        ...c,
        notes: user.role === "responsible" ? "" : c.notes,
        points: user.role === "responsible" ? 0 : c.points,
        totalSpent,
        purchases: history.length,
        lastPurchase: history[0]?.date || null,
        tier: tier(lifetimeTotals.get(c.id) || 0, settings),
      };
    }),
    expenses,
    movements,
    closures,
    settings,
    today: businessDate(settings),
    demo: process.env.DEMO_MODE === "true",
  };
}
