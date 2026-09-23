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
  const [users, products, sales, customers, expenses, movements, closures, cashEntries, cashPlans] =
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
      user.role === "owner" || user.role === "admin"
        ? db.cashEntry.findMany({ orderBy: [{ date: "desc" }, { createdAt: "desc" }], take: 2000 })
        : Promise.resolve([]),
      user.role === "owner" || user.role === "admin"
        ? db.cashPlan.findMany({ orderBy: { date: "asc" } })
        : Promise.resolve([]),
    ]);
  const lifetime = await db.sale.groupBy({
    by: ["customerId"],
    where: { customerId: { in: customers.map((c) => c.id) } },
    _sum: { total: true },
  });
  const lifetimeTotals = new Map(
    lifetime.map((s) => [s.customerId, s._sum.total || 0]),
  );
  const previousClosure = ownerId || user.role === "viewer" ? null : await db.closure.findFirst({
    where: { date: { lt: businessDate(settings) } },
    orderBy: { date: "desc" },
  });
  const financeBalance = ["owner", "admin"].includes(user.role) ?
    ((await db.cashEntry.aggregate({ where: { date: { lte: businessDate(settings) } }, _sum: { amount: true } }))._sum.amount || 0) : 0;
  const cashExpected = ownerId || user.role === "viewer" ? 0 :
    (previousClosure?.counted || 0) + ((await db.cashEntry.aggregate({
      where: { account: "cash", date: { gt: previousClosure?.date || "0000-00-00", lte: businessDate(settings) } },
      _sum: { amount: true },
    }))._sum.amount || 0);
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
        notes: ["owner", "admin", "cashier"].includes(user.role) ? c.notes : "",
        email: ["owner", "admin", "cashier"].includes(user.role) ? c.email : "",
        phone: ["owner", "admin", "cashier"].includes(user.role) ? c.phone : "",
        permitStatus: ["owner", "admin", "cashier"].includes(user.role) ? c.permitStatus : "unverified",
        permitValidUntil: ["owner", "admin", "cashier"].includes(user.role) ? c.permitValidUntil : null,
        permitCheckedAt: ["owner", "admin"].includes(user.role) ? c.permitCheckedAt : null,
        sourceSystem: ["owner", "admin"].includes(user.role) ? c.sourceSystem : null,
        sourceId: ["owner", "admin"].includes(user.role) ? c.sourceId : null,
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
    cashEntries,
    cashPlans,
    financeBalance,
    cashExpected,
    operationsEnabled: process.env.DEMO_MODE === "true" || process.env.CLUB_OPERATIONS_APPROVED === "true",
    settings,
    today: businessDate(settings),
    demo: process.env.DEMO_MODE === "true",
  };
}
