import { nextDate } from "./domain.js";

/** A fixed commitment that falls inside the month, already materialized or still pending from a recurring rule. */
export interface FixedCost {
  category: string;
  amount: number;
  date: string;
}
export interface BreakEvenInput {
  /** Business date, YYYY-MM-DD. */
  today: string;
  /** Local net sales, cost of goods sold and variable expenses from the 1st up to today, in cents. */
  revenue: number;
  cost: number;
  variable: number;
  /** Every fixed cost dated inside the month, including the ones due after today. */
  fixedCosts: FixedCost[];
  /** Last 30 days, used for the margin ratio when the month has no sales yet. */
  trailingRevenue: number;
  trailingCost: number;
  trailingVariable: number;
}
export interface BreakEvenMilestone {
  label: string;
  amount: number;
  dueDate: string;
  cumulative: number;
  covered: boolean;
  missing: number;
}
export type BreakEvenGap = "fixed_costs" | "sales" | "margin";
export interface BreakEvenResult {
  month: string;
  monthStart: string;
  monthEnd: string;
  daysInMonth: number;
  /** Days from the 1st to today, both included. */
  daysElapsed: number;
  /** Days from today to the end of the month, both included. */
  daysLeft: number;
  revenue: number;
  cost: number;
  variable: number;
  /** Revenue minus cost of goods sold and variable expenses. It can be negative. */
  contribution: number;
  fixedTotal: number;
  /** Null when there are no fixed costs to cover. */
  coveredPercent: number | null;
  remaining: number;
  surplus: number;
  marginRatio: number | null;
  marginSource: "month" | "trailing" | null;
  /** Sales still needed at the current margin; null when the margin is unknown or not positive. */
  salesNeeded: number | null;
  salesPerDay: number | null;
  projection: {
    /** "early" before day {@link PACE_FROM_DAY}: a few days of sales make the pace swing too much to project. */
    status: "covered" | "early" | "on_track" | "short" | "unknown";
    /** Day the fixed costs would be covered at the current pace. */
    date: string | null;
    /** Uncovered amount at month end at the current pace. */
    shortfall: number | null;
  };
  milestones: BreakEvenMilestone[];
  gaps: BreakEvenGap[];
}

/** First day of the month whose pace is projected to month end. */
export const PACE_FROM_DAY = 7;

const day = (value: string) => new Date(`${value}T12:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);
/** Ceiling of a / b for integer amounts, a ≥ 0 and b > 0. BigInt keeps the product of two amounts exact. */
const ceilDiv = (a: bigint, b: bigint) => Number((a + b - 1n) / b);

export function monthBounds(today: string) {
  const start = `${today.slice(0, 7)}-01`;
  const end = day(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return { start, end: iso(end), days: end.getUTCDate() };
}

/** Dates a weekly or monthly rule still has to produce between `from` and `to`, starting at its next pending date. */
export function recurringOccurrences(next: string, recurrence: string, from: string, to: string): string[] {
  if (recurrence !== "weekly" && recurrence !== "monthly") return [];
  const dates: string[] = [];
  let due = next;
  for (let guard = 0; due <= to && guard < 1000; guard++) {
    if (due >= from) dates.push(due);
    due = nextDate(due, recurrence);
  }
  return dates;
}

export function computeBreakEven(input: BreakEvenInput): BreakEvenResult {
  const { start, end, days } = monthBounds(input.today);
  const daysElapsed = Number(input.today.slice(8, 10));
  const daysLeft = days - daysElapsed + 1;
  const contribution = input.revenue - input.cost - input.variable;
  const inMonth = input.fixedCosts.filter((item) => item.date >= start && item.date <= end && item.amount > 0);
  const fixedTotal = inMonth.reduce((sum, item) => sum + item.amount, 0);
  const remaining = Math.max(0, fixedTotal - contribution);
  const surplus = Math.max(0, contribution - fixedTotal);
  const trailingContribution = input.trailingRevenue - input.trailingCost - input.trailingVariable;
  const marginSource = input.revenue > 0 ? "month" : input.trailingRevenue > 0 ? "trailing" : null;
  const base = marginSource === "month" ? { revenue: input.revenue, contribution }
    : marginSource === "trailing" ? { revenue: input.trailingRevenue, contribution: trailingContribution } : null;
  const marginRatio = base ? base.contribution / base.revenue : null;
  // remaining ÷ (contribution ÷ revenue) in integers: a float ratio can add a cent to an exact result.
  const salesNeeded = remaining === 0 ? 0 : base && base.contribution > 0
    ? ceilDiv(BigInt(remaining) * BigInt(base.revenue), BigInt(base.contribution)) : null;
  const salesPerDay = salesNeeded === null ? null : ceilDiv(BigInt(salesNeeded), BigInt(daysLeft));

  const groups = new Map<string, { label: string; amount: number; dueDate: string }>();
  for (const item of inMonth) {
    const label = item.category.trim() || "Sin categoría";
    const group = groups.get(label.toLowerCase());
    if (group) {
      group.amount += item.amount;
      if (item.date < group.dueDate) group.dueDate = item.date;
    } else groups.set(label.toLowerCase(), { label, amount: item.amount, dueDate: item.date });
  }
  let cumulative = 0;
  const milestones = [...groups.values()]
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.amount - b.amount || a.label.localeCompare(b.label))
    .map((group) => {
      cumulative += group.amount;
      return { ...group, cumulative, covered: contribution >= cumulative, missing: Math.max(0, cumulative - contribution) };
    });

  let projection: BreakEvenResult["projection"] = { status: "unknown", date: null, shortfall: null };
  if (fixedTotal > 0 && contribution >= fixedTotal) projection = { status: "covered", date: null, shortfall: null };
  else if (fixedTotal > 0 && daysElapsed < PACE_FROM_DAY) projection = { status: "early", date: null, shortfall: null };
  else if (fixedTotal > 0 && input.revenue > 0) {
    // At the month's pace (contribution ÷ days elapsed), kept in integers so a boundary day does not move.
    const needed = BigInt(fixedTotal) * BigInt(daysElapsed);
    // A negative margin keeps losing at its pace, so the month-end gap grows beyond the fixed total.
    const projected = BigInt(contribution) * BigInt(days);
    if (contribution > 0 && projected >= needed) {
      const coverDay = day(start);
      coverDay.setUTCDate(ceilDiv(needed, BigInt(contribution)));
      projection = { status: "on_track", date: iso(coverDay), shortfall: null };
    } else projection = { status: "short", date: null, shortfall: ceilDiv(needed - projected, BigInt(daysElapsed)) };
  }

  const gaps: BreakEvenGap[] = [];
  if (!fixedTotal) gaps.push("fixed_costs");
  if (!input.revenue) gaps.push("sales");
  if (remaining > 0 && marginRatio !== null && marginRatio <= 0) gaps.push("margin");
  return {
    month: input.today.slice(0, 7), monthStart: start, monthEnd: end, daysInMonth: days, daysElapsed, daysLeft,
    revenue: input.revenue, cost: input.cost, variable: input.variable, contribution, fixedTotal,
    coveredPercent: fixedTotal ? Math.min(100, Math.floor(Math.max(0, contribution) * 100 / fixedTotal)) : null,
    remaining, surplus, marginRatio, marginSource, salesNeeded, salesPerDay, projection, milestones, gaps,
  };
}
