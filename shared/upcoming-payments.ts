import { recurringOccurrences } from "./break-even.js";

/** A recurring expense rule; `nextDate` is its first date not yet registered in Gastos. */
export interface UpcomingRule {
  id: string;
  name: string;
  category: string;
  amount: number;
  recurrence: string;
  nextDate: string;
}
/** An expense registered with a date after today. */
export interface UpcomingExpense {
  id: string;
  name: string;
  category: string;
  amount: number;
  date: string;
}
/** A planned cash movement of the base scenario (Finanzas) or an active base obligation (Preparar caja); payments are negative. */
export interface UpcomingPlan {
  id: string;
  description: string;
  category: string;
  amount: number;
  date: string;
}
export type UpcomingSource = "recurring" | "expense" | "plan" | "obligation";
export interface UpcomingPayment {
  key: string;
  date: string;
  label: string;
  category: string;
  /** Positive amount that leaves, in cents. */
  amount: number;
  source: UpcomingSource;
  /** A recurring date already past that nobody registered in Gastos. */
  overdue: boolean;
}
export interface UpcomingPaymentsResult {
  today: string;
  weekEnd: string;
  until: string;
  items: UpcomingPayment[];
  weekTotal: number;
  weekCount: number;
  total: number;
  overdueTotal: number;
  overdueCount: number;
}

/** What `GET /api/finance/upcoming-payments` returns. */
export interface UpcomingPaymentsReport extends UpcomingPaymentsResult {
  /** Cash plus bank as recorded up to today; null while the ledger has no movements. */
  balance: number | null;
}

/** Days ahead shown, today included, and the first stretch that Inicio adds up. */
export const UPCOMING_DAYS = 30;
export const UPCOMING_WEEK = 7;

const shift = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** Last day of the week and of the 30 days, both counted from today. */
export function upcomingWindow(today: string) {
  return { weekEnd: shift(today, UPCOMING_WEEK - 1), until: shift(today, UPCOMING_DAYS - 1) };
}

export function upcomingPayments(input: { today: string; rules: UpcomingRule[]; expenses: UpcomingExpense[];
  plans: UpcomingPlan[]; obligations: UpcomingPlan[] }): UpcomingPaymentsResult {
  const { today } = input;
  const { weekEnd, until } = upcomingWindow(today);
  const items: UpcomingPayment[] = [];
  for (const rule of input.rules) {
    if (rule.amount <= 0) continue;
    // Every pending date from the rule's next one: the ones before today are overdue, not gone.
    for (const date of recurringOccurrences(rule.nextDate, rule.recurrence, rule.nextDate, until))
      items.push({ key: `recurring:${rule.id}:${date}`, date, label: rule.name, category: rule.category,
        amount: rule.amount, source: "recurring", overdue: date < today });
  }
  for (const expense of input.expenses)
    if (expense.amount > 0 && expense.date > today && expense.date <= until)
      items.push({ key: `expense:${expense.id}`, date: expense.date, label: expense.name, category: expense.category,
        amount: expense.amount, source: "expense", overdue: false });
  for (const [source, list] of [["plan", input.plans], ["obligation", input.obligations]] as const)
    for (const plan of list)
      if (plan.amount < 0 && plan.date >= today && plan.date <= until)
        items.push({ key: `${source}:${plan.id}`, date: plan.date, label: plan.description, category: plan.category,
          amount: -plan.amount, source, overdue: false });
  items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount || a.label.localeCompare(b.label));
  const sum = (list: UpcomingPayment[]) => list.reduce((total, item) => total + item.amount, 0);
  const overdue = items.filter((item) => item.overdue);
  const ahead = items.filter((item) => !item.overdue);
  const week = ahead.filter((item) => item.date <= weekEnd);
  return { today, weekEnd, until, items, weekTotal: sum(week), weekCount: week.length, total: sum(ahead),
    overdueTotal: sum(overdue), overdueCount: overdue.length };
}
