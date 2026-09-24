import { ArrowRight, ChartLineUp, UsersThree } from "@phosphor-icons/react";
import type { DashboardOutlook } from "../shared/outlook";

export type DashboardDecision = {
  title: string;
  detail: string;
  action: string;
  path: string;
};

export function DashboardSignals({ outlook, money, decisions, onNavigate }: {
  outlook: DashboardOutlook;
  money: (cents: number) => string;
  decisions: DashboardDecision[];
  onNavigate: (path: string) => void;
}) {
  const trend = outlook.previous14 > 0
    ? Math.round((outlook.recent14 / outlook.previous14 - 1) * 100)
    : null;
  return (
    <div className="dashboard-signals">
      <section className="outlook-panel" aria-labelledby="outlook-title">
        <div className="outlook-head">
          <div>
            <span className="signal-eyebrow">PROYECCIÓN ORIENTATIVA</span>
            <h2 id="outlook-title">Lo que sugiere el ritmo reciente</h2>
          </div>
          <span className="outlook-period">Actualizado con ventas registradas</span>
        </div>
        <div className="outlook-grid">
          <div className="outlook-lead">
            <span className="outlook-icon"><ChartLineUp size={20} /></span>
            <p>Ventas estimadas · próximos 7 días</p>
            <strong>{outlook.revenue7 === null ? "—" : money(outlook.revenue7)}</strong>
            <small>{outlook.revenue7 === null
              ? "Se necesitan 14 días de historial y al menos 4 días con ventas recientes."
              : trend === null ? "Sin período previo comparable." : `Ritmo de los últimos 14 días: ${trend > 0 ? "+" : ""}${trend}% frente a los 14 anteriores.`}</small>
          </div>
          <div className="outlook-buyers">
            <span className="outlook-icon"><UsersThree size={20} /></span>
            <p>Compradores estimados · próximos 30 días</p>
            <strong>{outlook.buyers30 === null ? "—" : outlook.buyers30}</strong>
            <small>{outlook.buyers30 === null ? "Aún falta historial para estimar compradores." : `Cerca de ${outlook.repeatBuyers30} con compras previas · ${outlook.firstBuyers30} con primera compra.`}</small>
          </div>
        </div>
        <div className="outlook-month">
          <span>Cierre estimado de ventas del mes</span>
          <strong>{outlook.monthEndRevenue === null ? "Aún sin base suficiente" : money(outlook.monthEndRevenue)}</strong>
        </div>
        <p className="outlook-method">Estimaciones por ritmo: ventas de 14 días ÷ 2; compradores de 28 días × 30/28; cierre mensual al ritmo diario actual. Requieren historial suficiente. No incluyen estacionalidad ni equivalen a caja proyectada. Muestra reciente: {outlook.saleDays28} días con ventas en 28 días.</p>
      </section>
      <section className="decision-panel" aria-labelledby="decisions-title">
        <div className="decision-head">
          <span className="signal-eyebrow">PARA DECIDIR</span>
          <h2 id="decisions-title">Qué revisar esta semana</h2>
          <p>Señales concretas del club, ordenadas por urgencia.</p>
        </div>
        {decisions.length ? <ol className="decision-list">
          {decisions.map((decision, index) => <li key={decision.title}>
            <span className="decision-index">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <strong>{decision.title}</strong>
              <p>{decision.detail}</p>
              <button type="button" onClick={() => onNavigate(decision.path)}>{decision.action} <ArrowRight size={14} /></button>
            </div>
          </li>)}
        </ol> : <p className="decision-empty">No hay desvíos destacados con los datos disponibles. Revisá la evolución y mantené el seguimiento semanal.</p>}
      </section>
    </div>
  );
}
