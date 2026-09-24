export type PurchasePulse = {
  firstSaleDate: string | null;
  buyers28: number;
  repeatBuyers28: number;
  buyersPrevious28: number;
  repeatBuyersPrevious28: number;
};

export type DailyRevenue = { date: string; total: number };

const daysAgo = (date: string, days: number) => {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};

export function calculateOutlook(today: string, daily: DailyRevenue[], pulse: PurchasePulse) {
  const start14 = daysAgo(today, 13);
  const start28 = daysAgo(today, 27);
  const startPrevious28 = daysAgo(today, 55);
  const recent14 = daily.filter((row) => row.date >= start14 && row.date <= today)
    .reduce((sum, row) => sum + row.total, 0);
  const previous14 = daily.filter((row) => row.date >= start28 && row.date < start14)
    .reduce((sum, row) => sum + row.total, 0);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthTotal = daily.filter((row) => row.date >= monthStart && row.date <= today)
    .reduce((sum, row) => sum + row.total, 0);
  const saleDays28 = daily.filter((row) => row.date >= start28 && row.date <= today && row.total > 0).length;
  const saleDaysMonth = daily.filter((row) => row.date >= monthStart && row.date <= today && row.total > 0).length;
  const elapsedMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const hasRevenueHistory = pulse.firstSaleDate !== null && pulse.firstSaleDate <= start14 && saleDays28 >= 4;
  const hasBuyerHistory = pulse.firstSaleDate !== null && pulse.firstSaleDate <= startPrevious28 && saleDays28 >= 8;

  const buyers30 = hasBuyerHistory ? Math.round(pulse.buyers28 * 30 / 28) : null;
  const repeatBuyers30 = hasBuyerHistory ? Math.round(pulse.repeatBuyers28 * 30 / 28) : null;
  return {
    revenue7: hasRevenueHistory ? Math.round(recent14 / 2) : null,
    monthEndRevenue: hasRevenueHistory && elapsedMonth >= 7 && saleDaysMonth >= 4
      ? Math.round(monthTotal * daysInMonth / elapsedMonth) : null,
    buyers30,
    repeatBuyers30,
    firstBuyers30: buyers30 === null || repeatBuyers30 === null ? null : buyers30 - repeatBuyers30,
    recent14,
    previous14,
    buyers28: pulse.buyers28,
    repeatBuyers28: pulse.repeatBuyers28,
    buyersPrevious28: pulse.buyersPrevious28,
    repeatBuyersPrevious28: pulse.repeatBuyersPrevious28,
    saleDays28,
  };
}

export type DashboardOutlook = ReturnType<typeof calculateOutlook>;
