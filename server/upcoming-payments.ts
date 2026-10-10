import { Router } from "express";
import { db, getSettings } from "./db.js";
import { businessDate } from "../shared/domain.js";
import { upcomingPayments, upcomingWindow, type UpcomingPaymentsReport } from "../shared/upcoming-payments.js";
import { HttpError } from "./validation.js";

export const upcoming = Router();

/** Money due in the next 30 days: recurring dates not yet registered, expenses dated ahead, the base plan's payments
 * (Finanzas → Planificación) and the active base obligations (Preparar → Caja). The two plans are separate records,
 * so the same payment loaded in both shows twice, each with its source. */
export async function upcomingReport(today: string): Promise<UpcomingPaymentsReport> {
  const { until } = upcomingWindow(today);
  const [rules, expenses, plans, obligations, ledger] = await Promise.all([
    // Overdue rules stay in: their past dates are payments nobody registered yet.
    db.recurringRule.findMany({
      where: { recurrence: { in: ["weekly", "monthly"] }, nextDate: { lte: until } },
      select: { id: true, name: true, category: true, amount: true, recurrence: true, nextDate: true },
    }),
    db.expense.findMany({
      where: { date: { gt: today, lte: until } },
      select: { id: true, name: true, category: true, amount: true, date: true },
    }),
    db.cashPlan.findMany({
      where: { scenario: "base", date: { gte: today, lte: until }, amount: { lt: 0 } },
      select: { id: true, description: true, category: true, amount: true, date: true },
    }),
    db.$queryRaw<Array<{ id: string; description: string; category: string; amount: bigint; date: string }>>`
      SELECT id, "sourceReference" AS description, category, "amountCents" AS amount, to_char(date, 'YYYY-MM-DD') AS date
      FROM "DecisionCashPlanEvent"
      WHERE scenario = 'base' AND status = 'active' AND "amountCents" < 0 AND date >= ${today}::date AND date <= ${until}::date`,
    db.cashEntry.aggregate({ where: { date: { lte: today } }, _sum: { amount: true }, _count: true }),
  ]);
  return {
    ...upcomingPayments({ today, rules, expenses, plans,
      obligations: obligations.map((row) => ({ ...row, amount: Number(row.amount) })) }),
    balance: ledger._count ? ledger._sum.amount || 0 : null,
  };
}

upcoming.get("/finance/upcoming-payments", async (req, res) => {
  if (req.user.role !== "owner" && req.user.role !== "admin") throw new HttpError(403, "No tenés acceso a finanzas");
  await db.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "finance", action: "upcoming_payments" } });
  res.json(await upcomingReport(businessDate(await getSettings())));
});
