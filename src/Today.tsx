import { Link } from "react-router-dom";
import { ArrowRight, Package, Plus, Receipt, ShoppingBag } from "@phosphor-icons/react";
import { useClub, useResource } from "./lib";
import { Empty, PageHeader } from "./ui";
import { BreakEvenCard } from "./BreakEven";
import { UpcomingPaymentsCard } from "./UpcomingPayments";
import type { BreakEvenResult } from "../shared/break-even";
import type { UpcomingPaymentsReport } from "../shared/upcoming-payments";
import "./today.css";

type TodayMetrics = { active: number; permitsToReview: number };

export default function Today({ onSale }: { onSale: () => void }) {
  const { state, money, owner, canSell, isManager, user } = useClub();
  const dashboard = useResource<TodayMetrics>(`/dashboard?${new URLSearchParams({ range: "today", ...(owner ? { owner } : {}) })}`);
  const firstName = user.name.split(" ")[0];
  // The goal and the break-even are club-wide: hide them when the figures are scoped to one responsible's lots.
  const breakEven = useResource<BreakEvenResult>(isManager && !owner ? "/finance/break-even" : null);
  const upcoming = useResource<UpcomingPaymentsReport>(isManager && !owner ? "/finance/upcoming-payments" : null);
  const goal = user.role === "responsible" || owner ? 0 : state.settings.dailySalesGoal;
  const goalPercent = goal > 0 ? Math.floor(state.salesTodayTotal / goal * 100) : 0;
  const lowStock = state.lowStockCount;
  const closed = state.closures.some((closure) => closure.date === state.today);
  const permits = isManager ? dashboard.data?.permitsToReview || 0 : 0;
  const short = state.categoryAlerts;
  const tasks = [
    ...(short.length ? [{
      title: short.length === 1 ? `Pocas variedades en ${short[0].name}` : `Pocas variedades en ${short.length} categorías`,
      description: `${short.slice(0, 3).map((c) => `${c.name}: ${c.varieties} de ${c.minVarieties}`).join(" · ")}${short.length > 3 ? " · …" : ""}. Reponé o sumá variedades distintas.`,
      path: short.length === 1 ? `/app/inventario?category=${encodeURIComponent(short[0].id)}` : "/app/inventario",
      action: "Ver variedades",
    }] : []),
    ...(lowStock ? [{ title: `${lowStock} ${lowStock === 1 ? "lote necesita" : "lotes necesitan"} atención`, description: "Revisá cantidades y mínimos antes de reponer.", path: "/app/inventario?filter=low", action: "Ver stock bajo" }] : []),
    ...(permits ? [{ title: `${permits} ${permits === 1 ? "permiso de socio" : "permisos de socios"} para revisar`, description: "Verificá el estado y la fecha en cada ficha.", path: "/app/socios?segment=permits", action: "Ver socios" }] : []),
    ...(isManager && (state.demo || state.settings.sampleData) ? [{ title: "Validar datos antes de decidir", description: "Las cifras de demostración son ejemplos; revisá fuentes y límites.", path: "/app/decisiones", action: "Abrir decisiones" }] : []),
  ].slice(0, 3);
  return <div className="today-page">
    <PageHeader
      eyebrow="Inicio"
      title="Resumen de hoy"
      description={`Hola, ${firstName}. Esto es lo que conviene revisar hoy en tu club.`}
      actions={canSell && !closed ? <button className="button primary" onClick={onSale}><Plus size={18} />Registrar venta</button> : <Link className="button primary" to={closed ? "/app/ventas" : "/app/inventario"}>{closed ? "Ver ventas y cierre" : "Revisar inventario"} <ArrowRight size={17} /></Link>}
    />
    <div className="today-layout">
      <div className="today-main">
      <section className="today-tasks" aria-labelledby="today-tasks-title">
        <div className="today-section-heading"><div><h2 id="today-tasks-title">Qué atender primero</h2></div><span>{tasks.length} {tasks.length === 1 ? "pendiente" : "pendientes"}</span></div>
        {tasks.length ? <ul>{tasks.map((task) => <li key={task.path}><div><strong>{task.title}</strong><p>{task.description}</p></div><Link to={task.path}>{task.action} <ArrowRight size={16} aria-hidden="true" /></Link></li>)}</ul> : <Empty title="Sin alertas por ahora" description="Tu operación de hoy no tiene pendientes destacados." />}
        {dashboard.error && <p className="today-source-warning" role="status">No se pudieron actualizar los indicadores de socios: {dashboard.error}</p>}
      </section>
      {isManager && !owner && breakEven.data && <BreakEvenCard data={breakEven.data} money={money} />}
      {isManager && !owner && upcoming.data && <UpcomingPaymentsCard data={upcoming.data} money={money} />}
      </div>
      <div className="today-figures" role="group" aria-label="Cifras de hoy">
        <div><Receipt size={20} aria-hidden="true" /><span>Ventas de hoy</span><strong>{money(state.salesTodayTotal)}</strong>
          {goal > 0 ? <>
            <small>Meta {money(goal)} · {goalPercent}&nbsp;%{goalPercent >= 100 ? " · cumplida" : ""}</small>
            <div className="today-goal-track" role="progressbar" aria-label="Meta diaria de ventas" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, goalPercent)} aria-valuetext={`${goalPercent} % de la meta diaria`}><i style={{ width: `${Math.min(100, goalPercent)}%` }} /></div>
          </> : <small>Operaciones registradas en la app</small>}
        </div>
        <div><ShoppingBag size={20} aria-hidden="true" /><span>Ventas registradas</span><strong>{state.salesTodayCount}</strong><small>Durante el día de hoy</small></div>
        <div><Package size={20} aria-hidden="true" /><span>Stock bajo</span><strong>{lowStock}</strong><small>{lowStock ? "Lotes por revisar" : "Sin alertas actuales"}</small></div>
      </div>
    </div>
    <p className="today-source-note">Datos registrados en la app al {new Date(`${state.today}T12:00:00`).toLocaleDateString("es-AR", { day: "numeric", month: "long" })}. {state.demo || state.settings.sampleData ? "Modo prueba: cifras de ejemplo." : "Consultá las fuentes y límites de cada análisis antes de tomar decisiones."}</p>
  </div>;
}
