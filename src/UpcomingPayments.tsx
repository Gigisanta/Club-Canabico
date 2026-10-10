import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CalendarBlank, CalendarPlus, Info, WarningCircle } from "@phosphor-icons/react";
import { shortDate } from "./lib";
import { cashCategories } from "./cash-categories";
import type { UpcomingPayment, UpcomingPaymentsReport, UpcomingSource } from "../shared/upcoming-payments";
import "./upcoming.css";

const sourceNames: Record<UpcomingSource, string> = {
  recurring: "Gasto recurrente",
  expense: "Gasto cargado",
  plan: "Pago previsto",
  obligation: "Obligación registrada",
};
/** "Later" items shown before the list asks to expand. */
const LATER_SHOWN = 6;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
function relative(date: string, today: string) {
  const days = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (days === 0) return "hoy";
  if (days === 1) return "mañana";
  return days < 0 ? `hace ${plural(-days, "día", "días")}` : `en ${days} días`;
}
function groups(data: UpcomingPaymentsReport) {
  const overdue = data.items.filter((item) => item.overdue);
  const week = data.items.filter((item) => !item.overdue && item.date <= data.weekEnd);
  const later = data.items.filter((item) => !item.overdue && item.date > data.weekEnd);
  return { overdue, week, later };
}

function Payment({ item, today, money }: { item: UpcomingPayment; today: string; money: (n: number) => string }) {
  const category = cashCategories[item.category] || item.category;
  return <li className={item.overdue ? "is-overdue" : ""}>
    <span className="upcoming-date"><strong>{shortDate(item.date)}</strong><small>{relative(item.date, today)}</small></span>
    <div><strong>{item.label}</strong><small>{item.overdue ? <><WarningCircle size={14} weight="fill" aria-hidden="true" />Vencido sin registrar · </> : null}{sourceNames[item.source]}{category ? ` · ${category}` : ""}</small></div>
    <span className="upcoming-amount">{money(item.amount)}</span>
  </li>;
}

export function UpcomingPaymentsSection({ data, loading, error, onRetry, onSchedule, money, demo }: {
  data: UpcomingPaymentsReport | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  onSchedule: () => void;
  money: (n: number) => string;
  demo: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const list = data && groups(data);
  const sections: [string, UpcomingPayment[]][] = list ? [["Vencidos sin registrar", list.overdue], ["Esta semana", list.week],
    ["Más adelante", expanded ? list.later : list.later.slice(0, LATER_SHOWN)]] : [];
  return <section className="upcoming" id="proximos-pagos" aria-labelledby="upcoming-title">
    <div className="upcoming-top">
      <div>
        {data && <p className="upcoming-period">Hoy y los próximos 29 días · hasta el {shortDate(data.until)}</p>}
        <h2 id="upcoming-title">Próximos pagos</h2>
      </div>
      <span className="upcoming-badges">
        {demo && <span className="upcoming-status is-demo"><Info size={15} weight="fill" aria-hidden="true" />Datos de demostración</span>}
        <span className="upcoming-status"><CalendarBlank size={15} weight="fill" aria-hidden="true" />Según lo cargado</span>
      </span>
    </div>
    {loading && !data && <p role="status" className="muted">Buscando pagos próximos…</p>}
    {error && <div className="panorama-inline-error" role="alert"><p>{error}</p><button className="button" onClick={onRetry}>Reintentar carga</button></div>}
    {data && list && <>
      {data.items.length ? <>
        <p className="upcoming-headline">
          <strong>{data.weekCount ? money(data.weekTotal) : "Sin pagos"}</strong>
          <span>esta semana{data.weekCount ? ` · ${plural(data.weekCount, "pago", "pagos")}` : ""} hasta el {shortDate(data.weekEnd)}</span>
        </p>
        <p className="upcoming-facts">
          <span><strong>{money(data.total)}</strong> en los 30 días · {plural(data.items.length - data.overdueCount, "pago", "pagos")}</span>
          {data.balance !== null && <span>Saldo según registros <strong>{money(data.balance)}</strong> · caja y banco, sin conciliar</span>}
        </p>
      </> : <div className="upcoming-empty">
        <strong>No hay pagos cargados para los próximos 30 días.</strong>
        <p>Aparecen acá los gastos mensuales o semanales, los gastos cargados con fecha futura y los pagos previstos, como una compra a pagar el mes que viene.</p>
      </div>}
      {list.overdue.length > 0 && <div className="upcoming-overdue" role="note">
        <WarningCircle size={20} weight="fill" aria-hidden="true" />
        <p><strong>{plural(list.overdue.length, "vencimiento", "vencimientos")} sin registrar · {money(data.overdueTotal)}</strong>
          Son fechas de gastos recurrentes que ya pasaron. Tocá «Procesar recurrencias» en Gastos para cargarlos; no se suman al total.</p>
        <Link to="/app/gastos">Ir a Gastos <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>}
      {sections.map(([title, items]) => items.length > 0 && <div className="upcoming-group" key={title}>
        <h3>{title}</h3>
        <ul className="upcoming-list">{items.map((item) => <Payment key={item.key} item={item} today={data.today} money={money} />)}</ul>
      </div>)}
      {list.later.length > LATER_SHOWN && <button type="button" className="upcoming-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "Mostrar menos" : `Ver ${plural(list.later.length - LATER_SHOWN, "pago más", "pagos más")}`}
      </button>}
      <div className="upcoming-actions">
        <button type="button" className="button" onClick={onSchedule}><CalendarPlus size={18} aria-hidden="true" />Agendar un pago</button>
        <Link to="/app/gastos">Cargar un gasto mensual <ArrowRight size={16} aria-hidden="true" /></Link>
      </div>
      <details className="upcoming-method"><summary>Cómo se calcula</summary><p>
        Suma lo que vence desde hoy hasta el {shortDate(data.until)}: las próximas fechas de los gastos mensuales y semanales, los gastos cargados con fecha futura,
        los pagos previstos del escenario Base en Planificación y las obligaciones activas del escenario base en Preparar → Caja.
        Son registros separados: un pago cargado en los dos lugares aparece dos veces, cada uno con su origen.
        La app no sabe si un gasto ya se pagó; lo pagado se registra en Caja. Delivery (AppSheet) queda fuera.
      </p></details>
    </>}
  </section>;
}

/** Compact card for Inicio: the week's total and its first payments. */
export function UpcomingPaymentsCard({ data, money }: { data: UpcomingPaymentsReport; money: (n: number) => string }) {
  const { overdue, week, later } = groups(data);
  const next = later[0];
  return <section className="upcoming-card" aria-labelledby="upcoming-card-title">
    <div className="upcoming-card-head"><h2 id="upcoming-card-title">Pagos de los próximos 7 días</h2><span className="upcoming-status"><CalendarBlank size={14} weight="fill" aria-hidden="true" />Según lo cargado</span></div>
    {week.length ? <>
      <p><strong>{money(data.weekTotal)}</strong> · {plural(week.length, "pago", "pagos")} hasta el {shortDate(data.weekEnd)}</p>
      <ul className="upcoming-list">{week.slice(0, 3).map((item) => <Payment key={item.key} item={item} today={data.today} money={money} />)}</ul>
      {week.length > 3 && <p>Y {plural(week.length - 3, "pago más", "pagos más")} esta semana.</p>}
    </> : <p>{next ? `Sin pagos esta semana. El próximo: ${next.label}, ${shortDate(next.date)}, ${money(next.amount)}.`
      : "Sin pagos cargados para los próximos 30 días. Cargá gastos mensuales o agendá pagos previstos para verlos acá."}</p>}
    {overdue.length > 0 && <p className="upcoming-card-overdue"><WarningCircle size={16} weight="fill" aria-hidden="true" />
      {plural(overdue.length, "vencimiento", "vencimientos")} sin registrar en Gastos · {money(data.overdueTotal)}</p>}
    <Link to="/app/finanzas#proximos-pagos">Ver próximos pagos <ArrowRight size={16} aria-hidden="true" /></Link>
  </section>;
}
