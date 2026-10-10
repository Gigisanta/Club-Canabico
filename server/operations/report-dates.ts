export const OPERATIONS_REPORT_TIME_ZONE = "America/Argentina/Buenos_Aires";

const DAY_MS = 86_400_000;
const civilDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATIONS_REPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function parseCivilDateEpoch(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError("date must use YYYY-MM-DD");
  const [year, month, day] = match.slice(1).map(Number);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year!, month! - 1, day!);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month! - 1 || parsed.getUTCDate() !== day) {
    throw new TypeError("date must be a valid civil date");
  }
  return parsed.getTime();
}

export function addCivilDays(value: string, days: number): string {
  return new Date(parseCivilDateEpoch(value) + days * DAY_MS).toISOString().slice(0, 10);
}

export function reportCivilDateAt(time: Date): string {
  const parts = civilDateFormatter.formatToParts(time);
  const part = (type: string) => parts.find(candidate => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Resolves the first instant of a Buenos Aires civil date, including historical offset changes. */
export function reportCivilDateStartUtc(civilDate: string): Date {
  const target = parseCivilDateEpoch(civilDate);
  let low = target - 36 * 60 * 60 * 1000;
  let high = target + 36 * 60 * 60 * 1000;
  if (reportCivilDateAt(new Date(low)) >= civilDate || reportCivilDateAt(new Date(high)) < civilDate) {
    throw new RangeError("civil date is outside the supported timezone boundary");
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (reportCivilDateAt(new Date(middle)) < civilDate) low = middle + 1;
    else high = middle;
  }
  if (reportCivilDateAt(new Date(low)) !== civilDate) {
    throw new RangeError("civil date does not exist in the report timezone");
  }
  return new Date(low);
}

/** Inclusive civil range represented as a half-open instant range for SQL timestamp/date columns. */
export function reportPeriodDateBounds(range: { from?: string; to?: string }): Record<string, Date> {
  const filter: Record<string, Date> = {};
  if (range.from) filter.gte = reportCivilDateStartUtc(range.from);
  if (range.to) filter.lt = reportCivilDateStartUtc(addCivilDays(range.to, 1));
  return filter;
}
