import type { Settings } from "./types.js";
export const defaults: Settings = {
  clubName: "Raíz Social Club",
  currency: "ARS",
  timezone: "America/Argentina/Buenos_Aires",
  pointsEvery: 1000000,
  pointValue: 10000,
  silverAt: 50000000,
  goldAt: 150000000,
  silverDiscount: 3,
  goldDiscount: 5,
  inactiveDays: 60,
  budget: 800000000,
};
export function businessDate(settings: Settings, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: settings.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function tier(spent: number, settings: Settings) {
  return spent >= settings.goldAt
    ? "Oro"
    : spent >= settings.silverAt
      ? "Plata"
      : "Bronce";
}
export function priceSale(
  subtotal: number,
  spent: number,
  points: number,
  redeem: number,
  settings: Settings,
) {
  if (!Number.isSafeInteger(redeem) || redeem < 0 || redeem > points)
    throw new Error("Puntos insuficientes o inválidos");
  const level = tier(spent, settings);
  const levelDiscount = Math.round(
    (subtotal *
      (level === "Oro"
        ? settings.goldDiscount
        : level === "Plata"
          ? settings.silverDiscount
          : 0)) /
      100,
  );
  const available = subtotal - levelDiscount;
  if (redeem * settings.pointValue > available)
    throw new Error("El canje supera el importe de la venta");
  const discount = levelDiscount + redeem * settings.pointValue;
  const total = subtotal - discount;
  return {
    discount,
    total,
    pointsEarned: Math.floor(total / settings.pointsEvery),
    pointsUsed: redeem,
  };
}
export function nextDate(date: string, recurrence: string) {
  const d = new Date(`${date}T12:00:00Z`);
  if (recurrence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(
      Math.min(
        day,
        new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
        ).getUTCDate(),
      ),
    );
  }
  return d.toISOString().slice(0, 10);
}

/** Largest-remainder allocation keeps line revenue nonnegative and reconciles every cent. */
export function allocateRevenue(amounts: number[], total: number): number[] {
  const subtotal = amounts.reduce((sum, n) => sum + n, 0);
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    total > subtotal ||
    amounts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    subtotal <= 0
  )
    throw new Error("Importes inválidos");
  const denominator = BigInt(subtotal);
  const parts = amounts.map((amount, index) => {
    const numerator = BigInt(amount) * BigInt(total);
    return {
      index,
      value: Number(numerator / denominator),
      remainder: numerator % denominator,
    };
  });
  const remaining = total - parts.reduce((sum, p) => sum + p.value, 0);
  const ranked = [...parts].sort((a, b) =>
    a.remainder === b.remainder
      ? a.index - b.index
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (let i = 0; i < remaining; i++) ranked[i].value++;
  return parts.map((p) => p.value);
}
