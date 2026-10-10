import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle, Circle, Clock, Info } from "@phosphor-icons/react";
import { shortDate } from "./lib";
import { PACE_FROM_DAY, type BreakEvenResult } from "../shared/break-even";
import "./breakeven.css";

const monthName = (month: string) => new Date(`${month}-01T12:00:00`).toLocaleDateString("es-AR", { month: "long" });

/** Headline and need, shared by the full and compact variants. */
function summary(data: BreakEvenResult, money: (n: number) => string) {
  const covered = data.fixedTotal > 0 && data.remaining === 0;
  const need = covered ? `Desde acá, lo que sumes es ganancia del mes: ${money(data.surplus)} por encima de los fijos.`
    : data.salesPerDay !== null && data.salesNeeded !== null
      ? `Te faltan ${money(data.remaining)} de margen: ≈ ${money(data.salesNeeded)} en ventas, ≈ ${money(data.salesPerDay)} por día en los ${data.daysLeft} ${data.daysLeft === 1 ? "día que queda" : "días que quedan"}.`
      : data.gaps.includes("margin")
        ? `Te faltan ${money(data.remaining)} de margen. Sin un margen positivo no se puede estimar cuánto vender: revisá costos y precios.`
        : `Te faltan ${money(data.remaining)} de margen. Falta un dato para estimar cuánto vender: no hay ventas locales este mes ni en los últimos 30 días.`;
  return { covered, need };
}

function Track({ data, label }: { data: BreakEvenResult; label: string }) {
  const percent = data.coveredPercent ?? 0;
  return <div className="breakeven-track" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
    aria-valuetext={data.remaining === 0 ? "Gastos fijos cubiertos" : `Cubierto el ${percent} % de los gastos fijos`}>
    <i style={{ width: `${percent}%` }} />
    {data.milestones.slice(0, -1).map((milestone) => <b key={milestone.label} aria-hidden="true" style={{ left: `${Math.min(100, milestone.cumulative / data.fixedTotal * 100)}%` }} />)}
  </div>;
}

export function BreakEvenSection({ data, loading, error, onRetry, money, demo }: {
  data: BreakEvenResult | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  money: (n: number) => string;
  demo: boolean;
}) {
  const title = data ? `Gastos fijos de ${monthName(data.month)}` : "Gastos fijos del mes";
  return <section className="breakeven" aria-labelledby="breakeven-title">
    <div className="breakeven-top">
      <div>
        {data && <p className="breakeven-period">Día {data.daysElapsed} de {data.daysInMonth} · solo local</p>}
        <h2 id="breakeven-title">{title}</h2>
      </div>
      <span className="breakeven-badges">
        {demo && <span className="breakeven-status is-demo"><Info size={15} weight="fill" aria-hidden="true" />Datos de demostración</span>}
        <span className="breakeven-status"><Clock size={15} weight="fill" aria-hidden="true" />Preliminar · sin conciliar</span>
      </span>
    </div>
    {loading && !data && <p role="status" className="muted">Calculando el equilibrio…</p>}
    {error && <div className="panorama-inline-error" role="alert"><p>{error}</p><button className="button" onClick={onRetry}>Reintentar carga</button></div>}
    {data && data.fixedTotal === 0 && <div className="breakeven-empty">
      <strong>Todavía no hay gastos fijos cargados para {monthName(data.month)}.</strong>
      <p>Cargá alquiler, sueldos y servicios en Gastos con tipo «Fijo». Si se repiten, elegí «Mensual» y la barra los toma todos los meses.</p>
      <Link to="/app/gastos">Cargar gastos fijos <ArrowRight size={16} aria-hidden="true" /></Link>
    </div>}
    {data && data.fixedTotal > 0 && (() => {
      const { covered, need } = summary(data, money);
      return <>
        <p className="breakeven-headline">
          <strong>{covered ? "Gastos fijos cubiertos" : `Cubriste el ${data.coveredPercent} %`}</strong>
          <span>{data.contribution < 0 ? `Margen negativo de ${money(-data.contribution)}` : `${money(data.contribution)} de margen`} sobre {money(data.fixedTotal)} de fijos</span>
        </p>
        <Track data={data} label={title} />
        <p className="breakeven-need">{need}</p>
        {data.projection.status === "on_track" && data.projection.date && <p className="breakeven-pace">A este ritmo los cubrís el {shortDate(data.projection.date)}.</p>}
        {data.projection.status === "short" && data.projection.shortfall !== null && <p className="breakeven-pace is-short">A este ritmo terminarías el mes con {money(data.projection.shortfall)} sin cubrir.</p>}
        {data.projection.status === "early" && <p className="breakeven-pace">El ritmo del mes se proyecta desde el día {PACE_FROM_DAY}: con menos días, una sola venta grande lo mueve demasiado.</p>}
        {data.projection.status === "unknown" && <p className="breakeven-pace">Todavía no hay ventas locales este mes para medir el ritmo.</p>}
        <ol className="breakeven-milestones">
          {data.milestones.map((milestone) => <li key={milestone.label} className={milestone.covered ? "is-covered" : ""}>
            {milestone.covered ? <CheckCircle size={20} weight="fill" aria-hidden="true" /> : <Circle size={20} aria-hidden="true" />}
            <div><strong>{milestone.label}</strong><small>{money(milestone.amount)} · vence {shortDate(milestone.dueDate)}</small></div>
            <span>{milestone.covered ? "Cubierto" : `Faltan ${money(milestone.missing)}`}</span>
          </li>)}
        </ol>
      </>;
    })()}
    {data && <details className="breakeven-method"><summary>Cómo se calcula</summary><p>
      Margen = ventas locales netas − costo vendido − gastos variables, del 1 al {shortDate(`${data.month}-${String(data.daysElapsed).padStart(2, "0")}`)}.
      Gastos fijos = todos los gastos con tipo «Fijo» y fecha en {monthName(data.month)}, incluidos los que vencen más adelante y las recurrencias pendientes.
      {data.marginSource === "trailing" ? " Como todavía no hay ventas este mes, el margen para estimar ventas sale de los últimos 30 días."
        : data.marginSource === "month" ? " Las ventas necesarias usan el margen de este mes." : " Sin ventas este mes ni en los últimos 30 días no hay margen para estimar ventas."}
      {" "}No incluye delivery (AppSheet). El resultado local resta solo los gastos hasta hoy; esta barra mira todos los fijos del mes.
    </p></details>}
  </section>;
}

/** Compact card for Inicio: one line of progress and the daily need. */
export function BreakEvenCard({ data, money }: { data: BreakEvenResult; money: (n: number) => string }) {
  const title = `Gastos fijos de ${monthName(data.month)}`;
  if (!data.fixedTotal) return <section className="breakeven-card" aria-labelledby="breakeven-card-title">
    <div><h2 id="breakeven-card-title">{title}</h2><p>Sin gastos fijos cargados: la barra de equilibrio necesita alquiler, sueldos y servicios.</p></div>
    <Link to="/app/gastos">Cargar gastos fijos <ArrowRight size={16} aria-hidden="true" /></Link>
  </section>;
  const { covered } = summary(data, money);
  return <section className="breakeven-card" aria-labelledby="breakeven-card-title">
    <div>
      <div className="breakeven-card-head"><h2 id="breakeven-card-title">{title}</h2><span className="breakeven-status"><Clock size={14} weight="fill" aria-hidden="true" />Preliminar · sin conciliar</span></div>
      <p><strong>{covered ? "Cubiertos" : `${data.coveredPercent} % cubierto`}</strong>
        {covered ? " · desde acá es ganancia del mes" : data.salesPerDay !== null ? ` · faltan ≈ ${money(data.salesPerDay)} por día en ventas` : ` · faltan ${money(data.remaining)} de margen`}</p>
    </div>
    <Track data={data} label={title} />
    <Link to="/app/finanzas?view=summary">Ver equilibrio <ArrowRight size={16} aria-hidden="true" /></Link>
  </section>;
}
