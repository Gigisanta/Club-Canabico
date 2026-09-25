import { Link } from "react-router-dom";
import { ArrowRight, Package, Plus, Receipt, ShoppingBag } from "@phosphor-icons/react";
import { useClub, useResource } from "./lib";
import { Empty, PageHeader } from "./ui";
import "./today.css";

type TodayMetrics = { active: number; permitsToReview: number };

export default function Today({ onSale }: { onSale: () => void }) {
  const { state, money, owner, canSell, isManager, user } = useClub();
  const dashboard = useResource<TodayMetrics>(`/dashboard?${new URLSearchParams({ range: "today", ...(owner ? { owner } : {}) })}`);
  const firstName = user.name.split(" ")[0];
  const lowStock = state.lowStockCount;
  const closed = state.closures.some((closure) => closure.date === state.today);
  const permits = isManager ? dashboard.data?.permitsToReview || 0 : 0;
  const tasks = [
    ...(lowStock ? [{ title: `${lowStock} ${lowStock === 1 ? "lote necesita" : "lotes necesitan"} atención`, description: "Revisá cantidades y mínimos antes de reponer.", path: "/app/inventario?filter=low", action: "Ver stock bajo" }] : []),
    ...(permits ? [{ title: `${permits} ${permits === 1 ? "permiso de socio" : "permisos de socios"} para revisar`, description: "Verificá el estado y la fecha en cada ficha.", path: "/app/socios?segment=permits", action: "Ver socios" }] : []),
    ...(isManager && state.demo ? [{ title: "Validar datos antes de decidir", description: "Las cifras de demostración son ejemplos; revisá fuentes y límites.", path: "/app/decisiones", action: "Abrir decisiones" }] : []),
  ].slice(0, 3);
  return <div className="today-page">
    <PageHeader
      eyebrow="INICIO · OPERACIÓN"
      title="Resumen de hoy"
      description={`Hola, ${firstName}. Esto es lo que conviene revisar hoy en tu club.`}
      actions={canSell && !closed ? <button className="button primary" onClick={onSale}><Plus size={18} />Registrar venta</button> : <Link className="button primary" to={closed ? "/app/ventas" : "/app/inventario"}>{closed ? "Ver ventas y cierre" : "Revisar inventario"} <ArrowRight size={17} /></Link>}
    />
    <div className="today-figures" aria-label="Cifras de hoy">
      <div><Receipt size={20} aria-hidden="true" /><span>Ventas de hoy</span><strong>{money(state.salesTodayTotal)}</strong><small>Operaciones registradas en la app</small></div>
      <div><ShoppingBag size={20} aria-hidden="true" /><span>Ventas registradas</span><strong>{state.salesTodayCount}</strong><small>Durante el día de hoy</small></div>
      <div><Package size={20} aria-hidden="true" /><span>Stock bajo</span><strong>{lowStock}</strong><small>{lowStock ? "Lotes por revisar" : "Sin alertas actuales"}</small></div>
    </div>
    <section className="today-tasks" aria-labelledby="today-tasks-title">
      <div className="today-section-heading"><div><span className="eyebrow">SIGUIENTE PASO</span><h2 id="today-tasks-title">Pendientes para atender</h2></div><span>{tasks.length} {tasks.length === 1 ? "pendiente" : "pendientes"}</span></div>
      {tasks.length ? <ul>{tasks.map((task) => <li key={task.path}><div><strong>{task.title}</strong><p>{task.description}</p></div><Link to={task.path}>{task.action} <ArrowRight size={16} /></Link></li>)}</ul> : <Empty title="Sin alertas por ahora" description="Tu operación de hoy no tiene pendientes destacados." />}
      {dashboard.error && <p className="today-source-warning" role="status">No se pudieron actualizar los indicadores de socios: {dashboard.error}</p>}
    </section>
    <nav className="today-next" aria-label="Explorar información del club">
      <Link to="/app/panorama">Ver panorama y gráficos <ArrowRight size={16} /></Link>
      {isManager && <Link to="/app/decisiones">Centro de decisiones <ArrowRight size={16} /></Link>}
    </nav>
    <p className="today-source-note">Datos registrados en la app al {new Date(`${state.today}T12:00:00`).toLocaleDateString("es-AR", { day: "numeric", month: "long" })}. {state.demo ? "Club de demostración: cifras de ejemplo." : "Consultá las fuentes y límites de cada análisis antes de tomar decisiones."}</p>
  </div>;
}
