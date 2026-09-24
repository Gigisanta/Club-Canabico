export interface CustomerInsights {
  purchases: number;
  averageTicket: number;
  lastPurchase: string | null;
  favoriteProduct: { name: string; purchases: number } | null;
  typicalIntervalDays: number | null;
  nextExpectedDate: string | null;
}

export function visitCadence(recentDates: string[]): { typicalIntervalDays: number | null; nextExpectedDate: string | null } {
  const dates = [...new Set(recentDates)].sort().reverse().slice(0, 9);
  if (dates.length < 4) return { typicalIntervalDays: null, nextExpectedDate: null };
  const gaps = dates.slice(0, -1).map((date, index) =>
    Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${dates[index + 1]}T12:00:00Z`)) / 86400000),
  ).sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  const typicalIntervalDays = Math.round(gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2);
  if (typicalIntervalDays < 1) return { typicalIntervalDays: null, nextExpectedDate: null };
  const next = new Date(`${dates[0]}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + typicalIntervalDays);
  return { typicalIntervalDays, nextExpectedDate: next.toISOString().slice(0, 10) };
}
