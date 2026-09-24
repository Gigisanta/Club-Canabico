import { ClockCounterClockwise, Sparkle } from "@phosphor-icons/react";
import type { CustomerInsights } from "../shared/customer-insights";
import { daysBetween, shortDate } from "./lib";
import "./customer-insights.css";

export function CustomerInsightsPanel({ insights, today, money, compact = false }: {
  insights: CustomerInsights;
  today: string;
  money: (cents: number) => string;
  compact?: boolean;
}) {
  const daysLate = insights.nextExpectedDate ? daysBetween(today, insights.nextExpectedDate) : null;
  return <section className={`customer-insights ${compact ? "compact" : ""}`} aria-label="Lectura automática del socio">
    <div className="customer-insights-head">
      <span><Sparkle size={17} /> LECTURA AUTOMÁTICA</span>
      <small>Basada en compras registradas</small>
    </div>
    {insights.purchases === 0 ? <p className="customer-insights-empty">Todavía no hay compras para detectar preferencias o un ritmo habitual.</p> : <>
      <div className="customer-insights-grid">
        <div><span>Última compra</span><strong>{insights.lastPurchase ? shortDate(insights.lastPurchase) : "—"}</strong></div>
        <div><span>Ticket promedio</span><strong>{money(insights.averageTicket)}</strong></div>
        <div><span>Más elegido</span><strong>{insights.favoriteProduct?.name || "—"}</strong></div>
        <div><span>Ritmo reciente</span><strong>{insights.typicalIntervalDays ? `Cada ${insights.typicalIntervalDays} ${insights.typicalIntervalDays === 1 ? "día" : "días"}` : "Aún sin patrón"}</strong></div>
      </div>
      {insights.nextExpectedDate && <div className="customer-insights-next">
        <ClockCounterClockwise size={17} />
        <span>{daysLate !== null && daysLate > 0
          ? `Fecha orientativa: ${shortDate(insights.nextExpectedDate)}. Pasaron ${daysLate} ${daysLate === 1 ? "día" : "días"}.`
          : `Próximo regreso orientativo: ${shortDate(insights.nextExpectedDate)}.`}</span>
      </div>}
      {!compact && <p className="customer-insights-method">El ritmo usa la mediana de hasta 8 intervalos entre días con compras. Se muestra con al menos 4 días distintos; es una referencia para preparar la atención, no una cita confirmada.</p>}
    </>}
  </section>;
}
