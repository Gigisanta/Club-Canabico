import { Router } from "express";
import { db, getSettings } from "./db.js";
import { businessDate } from "../shared/domain.js";
import { computeBreakEven, monthBounds, recurringOccurrences, type FixedCost } from "../shared/break-even.js";
import { HttpError } from "./validation.js";

export const breakEven = Router();

function offset(value: string, days: number) {
  const target = new Date(`${value}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + days);
  return target.toISOString().slice(0, 10);
}

/** Local break-even for the current month. Delivery (AppSheet) sales never count. */
export async function breakEvenReport(today: string) {
  const { start, end } = monthBounds(today);
  const trailingStart = offset(today, -29);
  const [sales, trailingSales, expenses, trailingVariable, rules] = await Promise.all([
    db.$queryRaw<Array<{ revenue: bigint; cost: bigint }>>`
      SELECT COALESCE(SUM(total), 0)::bigint AS revenue, COALESCE(SUM(cost), 0)::bigint AS cost
      FROM "Sale" WHERE channel = 'local' AND date >= ${start} AND date <= ${today}`,
    db.$queryRaw<Array<{ revenue: bigint; cost: bigint }>>`
      SELECT COALESCE(SUM(total), 0)::bigint AS revenue, COALESCE(SUM(cost), 0)::bigint AS cost
      FROM "Sale" WHERE channel = 'local' AND date >= ${trailingStart} AND date <= ${today}`,
    db.$queryRaw<Array<{ category: string; amount: number; date: string; kind: string }>>`
      SELECT category, amount, date, kind FROM "Expense" WHERE date >= ${start} AND date <= ${end}`,
    db.$queryRaw<Array<{ amount: bigint }>>`
      SELECT COALESCE(SUM(amount), 0)::bigint AS amount FROM "Expense"
      WHERE kind = 'variable' AND date >= ${trailingStart} AND date <= ${today}`,
    // A rule has no kind of its own: like the recurring processor, it takes the kind of its first expense.
    db.$queryRaw<Array<{ category: string; amount: number; recurrence: string; nextDate: string; kind: string }>>`
      SELECT r.category, r.amount, r.recurrence, r."nextDate", COALESCE(first.kind, 'fixed') AS kind
      FROM "RecurringRule" r
      LEFT JOIN LATERAL (
        SELECT e.kind FROM "Expense" e WHERE e."ruleId" = r.id ORDER BY e.date ASC, e.id ASC LIMIT 1
      ) first ON true
      WHERE r.recurrence IN ('weekly', 'monthly') AND r."nextDate" <= ${end}`,
  ]);
  const fixedCosts: FixedCost[] = expenses
    .filter((expense) => expense.kind === "fixed")
    .map(({ category, amount, date }) => ({ category, amount, date }));
  for (const rule of rules.filter((item) => item.kind === "fixed"))
    for (const date of recurringOccurrences(rule.nextDate, rule.recurrence, start, end))
      fixedCosts.push({ category: rule.category, amount: rule.amount, date });
  return computeBreakEven({
    today,
    revenue: Number(sales[0]?.revenue || 0),
    cost: Number(sales[0]?.cost || 0),
    variable: expenses.filter((expense) => expense.kind === "variable" && expense.date <= today)
      .reduce((sum, expense) => sum + expense.amount, 0),
    fixedCosts,
    trailingRevenue: Number(trailingSales[0]?.revenue || 0),
    trailingCost: Number(trailingSales[0]?.cost || 0),
    trailingVariable: Number(trailingVariable[0]?.amount || 0),
  });
}

breakEven.get("/finance/break-even", async (req, res) => {
  if (req.user.role !== "owner" && req.user.role !== "admin") throw new HttpError(403, "No tenés acceso a finanzas");
  await db.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "finance", action: "break_even" } });
  res.json(await breakEvenReport(businessDate(await getSettings())));
});
