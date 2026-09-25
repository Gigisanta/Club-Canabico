import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  ArrowDown,
  ArrowUpRight,
  CalendarBlank,
  CaretDown,
  ChartLineUp,
  Coins,
  DownloadSimple,
  Package,
  Plus,
  UsersThree,
  ArrowRight,
} from "@phosphor-icons/react";
import {
  useClub,
  daysBetween,
  number,
  shortDate,
  download,
  useResource,
} from "./lib";
import {
  Panel,
  Metric,
  PageHeader,
  Avatar,
  Badge,
  ActionLink,
  Empty,
} from "./ui";
import { DashboardSignals, type DashboardDecision } from "./DashboardSignals";
import type { DashboardOutlook } from "../shared/outlook";
import "./dashboard.css";
import "./panorama.css";
interface DashboardMetrics {
  start: string;
  length: number;
  total: number;
  before: number;
  cost: number;
  count: number;
  expenses: number;
  monthlyExpenses: number;
  active: number;
  returning: number;
  customerTotal: number;
  inactive: number;
  permitsToReview: number;
  chart: { date: string; revenue: number; previous: number; expenses: number }[];
  owners: { ownerId: string; revenue: number; cost: number }[];
  topVolume: { id: string; name: string; tier: string; amount: number; count: number }[];
  topFrequency: { id: string; name: string; tier: string; amount: number; count: number }[];
  outlook: DashboardOutlook;
}
export function Dashboard({ onSale }: { onSale: () => void }) {
  const { state, money, owner, setOwner, canSell, user } = useClub();
  const navigate = useNavigate();
  const [range, setRange] = useState("month");
  const [tab, setTab] = useState("revenue");
  const [ranking, setRanking] = useState("volume");
  const [inactiveDays, setInactiveDays] = useState(state.settings.inactiveDays);
  const metrics = useResource<DashboardMetrics>(
    `/dashboard?${new URLSearchParams({ range, inactiveDays: String(inactiveDays), ...(owner ? { owner } : {}) })}`,
  );
  useEffect(() => {
    const refresh = () => void metrics.reload();
    window.addEventListener("bombo:sale-changed", refresh);
    return () => window.removeEventListener("bombo:sale-changed", refresh);
  }, [metrics.reload]);
  const data = metrics.data;
  const stock = state.products.reduce(
    (n, p) => n + (p.stock * p.cost) / 1000,
    0,
  );
  const low = state.products.filter((p) => p.stock <= p.minimum);
  if (!data) return (
    <div className="panorama-dashboard">
      {metrics.error ? (
        <section className="panorama-load-state is-error" role="alert" aria-live="assertive">
          <span className="signal-eyebrow">PANORAMA NO DISPONIBLE</span>
          <h1>No pudimos cargar los indicadores</h1>
          <p>{metrics.error}</p>
          <button className="button primary" onClick={() => void metrics.reload()}>Reintentar</button>
        </section>
      ) : (
        <div className="page-loading" role="status" aria-live="polite">Calculando panorama del club…</div>
      )}
    </div>
  );
  const { start, total, before, cost, count, expenses, active, returning, inactive, customerTotal, monthlyExpenses, permitsToReview } = data;
  const chart = data.chart.map((row) => ({ ...row, label: shortDate(row.date) }));
  const owners = state.users
    .filter(
      (u) =>
        state.products.some((p) => p.ownerId === u.id) ||
        data.owners.some((row) => row.ownerId === u.id),
    )
    .map((u) => {
      const ownerSales = data.owners.find((row) => row.ownerId === u.id);
      const products = state.products.filter((p) => p.ownerId === u.id);
      return {
        ...u,
        value:
          user.role === "cashier"
            ? products.length
            : products.reduce((n, p) => n + (p.stock * p.cost) / 1000, 0),
        revenue: ownerSales?.revenue || 0,
        cost: ownerSales?.cost || 0,
        lots: products.length,
      };
    });
  const top = ranking === "volume" ? data.topVolume : data.topFrequency;
  const expiring = state.products.filter(
    (p) =>
      p.expires && daysBetween(p.expires, state.today) <= 30 && p.stock > 0,
  );
  const change = before ? ((total - before) / before) * 100 : null;
  const financial = user.role !== "cashier";
  const outlook = data.outlook;
  const repeatShare = outlook.buyers28 ? outlook.repeatBuyers28 / outlook.buyers28 : null;
  const previousRepeatShare = outlook.buyersPrevious28 ? outlook.repeatBuyersPrevious28 / outlook.buyersPrevious28 : null;
  const firstBuyers = outlook.buyers28 - outlook.repeatBuyers28;
  const previousFirstBuyers = outlook.buyersPrevious28 - outlook.repeatBuyersPrevious28;
  const decisions: DashboardDecision[] = [];
  if (["owner", "admin"].includes(user.role) && permitsToReview > 0) decisions.push({
    title: `Revisar ${permitsToReview} ${permitsToReview === 1 ? "permiso" : "permisos"} de socios`,
    detail: "Hay verificaciones pendientes, vencidas o próximas a vencer en 14 días.",
    action: "Ver pendientes", path: "/app/socios?segment=permits",
  });
  if (low.length) decisions.push({
    title: `Reponer ${low.length} ${low.length === 1 ? "lote" : "lotes"} con stock bajo`,
    detail: `Empezá por ${low[0].name}. ${low.length > 1 ? `Hay ${low.length - 1} ${low.length === 2 ? "lote más" : "lotes más"} debajo del mínimo.` : "Revisá cantidad disponible y próxima compra."}`,
    action: "Revisar inventario", path: "/app/inventario?filter=low",
  });
  if (outlook.revenue7 !== null && outlook.previous14 > 0 && outlook.recent14 < outlook.previous14 * 0.85) decisions.push({
    title: "Investigar la baja en ventas",
    detail: `Los últimos 14 días suman ${money(outlook.recent14)}, frente a ${money(outlook.previous14)} en los 14 anteriores.`,
    action: "Ver ventas", path: "/app/ventas",
  });
  if (previousRepeatShare !== null && repeatShare !== null && outlook.buyers28 >= 8 &&
    repeatShare < previousRepeatShare - 0.05) decisions.push({
    title: "Revisar la recompra",
    detail: `La proporción de compradores recurrentes bajó de ${Math.round(previousRepeatShare * 100)}% a ${Math.round(repeatShare * 100)}% entre períodos de 28 días.`,
    action: "Ver socios", path: "/app/socios",
  });
  if (previousFirstBuyers >= 5 && firstBuyers < previousFirstBuyers * 0.8) decisions.push({
    title: "Revisar las primeras compras",
    detail: `${firstBuyers} socios compraron por primera vez en 28 días, frente a ${previousFirstBuyers} en los 28 anteriores.`,
    action: "Ver socios", path: "/app/socios",
  });
  if (inactive > 0) decisions.push({
    title: `Revisar ${inactive} ${inactive === 1 ? "socio inactivo" : "socios inactivos"}`,
    detail: `No registran compras hace al menos ${inactiveDays} días. Verificá sus fichas antes de definir una acción.`,
    action: "Ver segmento", path: `/app/socios?segment=inactive&days=${inactiveDays}`,
  });
  if (financial && state.settings.budget > 0 && monthlyExpenses > state.settings.budget * 0.85) decisions.push({
    title: "Revisar el presupuesto de gastos",
    detail: `Los gastos registrados del mes ya alcanzan ${Math.round(monthlyExpenses / state.settings.budget * 100)}% del presupuesto.`,
    action: "Ver gastos", path: "/app/gastos",
  });
  if (expiring.length) decisions.push({
    title: `Revisar ${expiring.length} ${expiring.length === 1 ? "lote próximo" : "lotes próximos"} a vencer`,
    detail: `Hay stock con vencimiento dentro de 30 días; empezá por ${expiring[0].name}.`,
    action: "Ver inventario", path: `/app/inventario?q=${encodeURIComponent(expiring[0].name)}`,
  });
  return (
    <div className="panorama-dashboard">
      <PageHeader
        eyebrow="PANORAMA DEL CLUB"
        title={`Hola, ${user.name.split(" ")[0]}.`}
        description={low.length ? `${low.length} ${low.length === 1 ? "lote necesita" : "lotes necesitan"} atención. El resto de la operación, de un vistazo.` : "Acá tenés lo importante de la operación para decidir qué sigue."}
        actions={
          <>
            {financial && (
              <button
                className="button"
                onClick={() =>
                  download(
                    `/api/reports/xlsx?from=${start}&to=${state.today}${owner ? "&owner=" + owner : ""}`,
                  )
                }
              >
                <DownloadSimple size={17} />
                Exportar
              </button>
            )}
            {canSell && (
              <button className="button primary" onClick={onSale}>
                <Plus size={18} />
                Nueva venta
              </button>
            )}
          </>
        }
      />
      <div className="dashboard-toolbar">
        <div className="dashboard-view-actions" role="group" aria-label="Vistas del club">
          <span className="current-view" aria-current="page">Visión general</span>
          {financial && (
            <button
              type="button"
              onClick={() =>
                navigate(financial ? "/app/responsables" : "/app/inventario")
              }
            >
              Por responsable <ArrowUpRight size={13} />
            </button>
          )}
        </div>
        <div className="filter-group">
          <div className="select-wrap">
            <UsersThree size={16} />
            <select
              aria-label="Filtrar por responsable"
              value={user.role === "responsible" ? user.id : owner}
              onChange={(e) => setOwner(e.target.value)}
              disabled={user.role === "responsible"}
            >
              <option value="">Todos los responsables</option>
              {state.users
                .filter((u) =>
                  ["responsible", "owner", "admin"].includes(u.role),
                )
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </div>
          <div className="select-wrap">
            <CalendarBlank size={16} />
            <select
              aria-label="Período del dashboard"
              value={range}
              onChange={(e) => setRange(e.target.value)}
            >
              <option value="today">Hoy</option>
              <option value="week">Últimos 7 días</option>
              <option value="month">Este mes</option>
            </select>
          </div>
        </div>
      </div>
      <div className="dashboard-section-title">
        <h2>Estado del período</h2>
        <p>Resultados registrados hasta hoy. Las estimaciones aparecen debajo.</p>
      </div>
      <div className="metrics-grid">
        <Metric
          title="Ventas del período"
          value={money(total)}
          icon={<ChartLineUp size={20} />}
          change={change}
          spark={chart.map((c) => c.revenue).slice(-13)}
        />
        <Metric
          title={financial ? "Stock valorizado" : "Lotes disponibles"}
          value={financial ? money(stock) : number(state.products.length)}
          icon={<Package size={20} />}
          detail={`${state.products.length} lotes · ${low.length} con stock bajo`}
        />
        <Metric
          title="Socios activos"
          value={number(active)}
          icon={<UsersThree size={20} />}
          detail={`De ${customerTotal} socios registrados`}
        />
        <Metric
          title={financial ? "Margen bruto" : "Ticket promedio"}
          value={
            financial
              ? `${total ? (((total - cost) / total) * 100).toFixed(1) : "0"}%`
              : money(count ? total / count : 0)
          }
          icon={<Coins size={20} />}
          detail={
            financial
              ? `${money(total - cost)} de beneficio bruto`
              : `${count} ventas registradas`
          }
        />
      </div>
      <DashboardSignals outlook={outlook} money={money} decisions={decisions.slice(0, 3)} onNavigate={navigate} />
      <div className="dashboard-section-title dashboard-section-title-lower">
        <h2>Evolución y composición</h2>
        <p>Explorá las ventas, el inventario y el comportamiento de los socios.</p>
      </div>
      <div className="dashboard-charts">
        <Panel
          title="Así se mueve tu club"
          sub="Evolución de ingresos en el período"
          className="revenue-panel"
          action={
            <div className="segmented" role="group" aria-label="Indicador del gráfico">
              <button
                className={tab === "revenue" ? "active" : ""}
                type="button"
                aria-pressed={tab === "revenue"}
                onClick={() => setTab("revenue")}
              >
                Ingresos
              </button>
              {financial && (
                <button
                  className={tab === "expenses" ? "active" : ""}
                  type="button"
                  aria-pressed={tab === "expenses"}
                  onClick={() => setTab("expenses")}
                >
                  Gastos
                </button>
              )}
            </div>
          }
        >
          <div className="chart-summary">
            <strong>{money(tab === "revenue" ? total : expenses)}</strong>
            <span className="chart-legend">
              <i />
              {tab === "revenue" ? "Período actual" : "Gastos registrados"}
              {tab === "revenue" && (
                <>
                  <i className="previous" />
                  Período anterior
                </>
              )}
            </span>
          </div>
          <div className="main-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chart}
                margin={{ left: -12, right: 12, top: 16, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="incomeFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6e772f" stopOpacity={0.24} />
                    <stop offset="95%" stopColor="#6e772f" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 5"
                  vertical={false}
                  stroke="#e1dbc7"
                />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                  tick={{ fontSize: 10, fill: "#686b57" }}
                  dy={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: "#686b57" }}
                  tickFormatter={(v) =>
                    `${v >= 1000 ? `${number(v / 1000)}k` : v}`
                  }
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid #d9d1bb",
                    background: "#fffaf0",
                    color: "#3e402e",
                    fontSize: 12,
                  }}
                  formatter={(v, name) => [
                    money(Number(v) * 100),
                    name === "previous"
                      ? "Período anterior"
                      : tab === "revenue"
                        ? "Ingresos"
                        : "Gastos",
                  ]}
                />
                {tab === "revenue" && (
                  <Area
                    type="monotone"
                    dataKey="previous"
                    fill="transparent"
                    stroke="#c4bca8"
                    strokeWidth={1.5}
                    strokeDasharray="5 5"
                    isAnimationActive={false}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey={tab}
                  stroke="#6e772f"
                  strokeWidth={2.5}
                  fill="url(#incomeFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="chart-foot">
            <span>
              Ticket promedio{" "}
              <strong>{money(count ? total / count : 0)}</strong>
            </span>
            <span>
              Ventas realizadas <strong>{count}</strong>
            </span>
            <span>
              Compraron 2+ veces{" "}
              <strong>
                {active ? Math.round((returning / active) * 100) : 0}%
              </strong>
            </span>
          </div>
        </Panel>
        <Panel
          title={financial ? "Stock por responsable" : "Lotes por responsable"}
          sub={
            financial
              ? "Valor a precio de costo"
              : "Distribución de lotes disponibles"
          }
          action={
            <button
              className="icon-button"
              aria-label="Ver responsables"
              onClick={() => navigate("/app/responsables")}
            >
              <ArrowUpRight size={20} />
            </button>
          }
        >
          <div className="donut-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={owners.map((o) => ({ name: o.name, value: o.value }))}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={70}
                  outerRadius={88}
                  paddingAngle={4}
                  cornerRadius={4}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {owners.map((o, i) => (
                    <Cell
                      key={o.id}
                      fill={["#3e402e", "#6e772f", "#ff7b1c", "#b4aaff"][i % 4]}
                    />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: "#fffaf0", borderColor: "#d9d1bb", color: "#3e402e" }} itemStyle={{ color: "#3e402e" }} formatter={(v) => financial ? money(Number(v)) : `${number(Number(v))} lotes`} />
              </PieChart>
            </ResponsiveContainer>
            <div className="donut-center">
              <small>{financial ? "Stock a costo" : "Lotes en stock"}</small>
              <strong>
                {financial ? money(stock) : `${state.products.length} lotes`}
              </strong>
              <span>{owners.length} responsables</span>
            </div>
          </div>
          <div className="donut-legend">
            {owners.map((o, i) => (
              <div key={o.id}>
                <span>
                  <i
                    style={{
                      background: ["#3e402e", "#6e772f", "#ff7b1c", "#b4aaff"][
                        i % 4
                      ],
                    }}
                  />
                  {o.name.split(" ")[0]} {o.name.split(" ")[1]?.[0]}.
                </span>
                <strong>
                  {(financial ? stock : state.products.length)
                    ? Math.round(
                        (o.value /
                          (financial ? stock : state.products.length)) *
                          100,
                      )
                    : 0}
                  %
                </strong>
                <small>{financial ? money(o.value) : `${o.value} lotes`}</small>
              </div>
            ))}
          </div>
          <button
            className="panel-bottom-link"
            onClick={() => navigate("/app/responsables")}
          >
            Ver distribución de inventario <ArrowRight size={15} />
          </button>
        </Panel>
      </div>
      <div className="dashboard-bottom">
        <Panel
          title="Los que más eligen tu club"
          sub="Top 10 socios en el período seleccionado"
          action={
            <ActionLink onClick={() => navigate("/app/socios")}>
              Ver socios
            </ActionLink>
          }
        >
          <div className="table-toolbar compact">
            <div className="text-tabs">
              <button
                className={ranking === "volume" ? "active" : ""}
                onClick={() => setRanking("volume")}
              >
                Por volumen
              </button>
              <button
                className={ranking === "frequency" ? "active" : ""}
                onClick={() => setRanking("frequency")}
              >
                Por frecuencia
              </button>
            </div>
            <span className="muted small">
              {range === "month"
                ? "Este mes"
                : range === "week"
                  ? "Últimos 7 días"
                  : "Hoy"}
            </span>
          </div>
          <div className="table-scroll top-table">
            <table>
              <thead>
                <tr>
                  <th className="rank-col">#</th>
                  <th>Socio</th>
                  <th>Nivel</th>
                  <th className="numeric">Compras</th>
                  <th className="numeric">
                    Total <ArrowDown size={12} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {top.map((c, i) => (
                  <tr key={c.id}>
                    <td className="rank-col">
                      {String(i + 1).padStart(2, "0")}
                    </td>
                    <td>
                      <div className="person-cell">
                        <Avatar
                          name={c.name}
                          color={
                            ["#799b87", "#aa8e72", "#879cb5", "#ac90a5"][i % 4]
                          }
                        />
                        <div>
                          <button
                            className="text-button"
                            onClick={() =>
                              navigate(
                                "/app/socios?q=" + encodeURIComponent(c.name),
                              )
                            }
                          >
                            {c.name}
                          </button>
                          <small>Socio · {c.id.slice(-4).toUpperCase()}</small>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge
                        tone={
                          c.tier === "Oro"
                            ? "gold"
                            : c.tier === "Plata"
                              ? "gray"
                              : "bronze"
                        }
                      >
                        {c.tier}
                      </Badge>
                    </td>
                    <td className="numeric">{c.count}</td>
                    <td className="numeric amount">{money(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!top.length && <Empty title="Sin ventas en este período" />}
          </div>
        </Panel>
        <Panel title="Cómo compran los socios" sub="Compradores únicos en los últimos 28 días; comparación con los 28 anteriores." className="customer-pulse-panel">
          <div className="customer-pulse-total">
            <strong>{number(outlook.buyers28)}</strong>
            <span>socios con compras recientes</span>
            <small>Antes: {number(outlook.buyersPrevious28)}</small>
          </div>
          <div className="customer-pulse-rows">
            <div><span>Primera compra</span><strong>{number(firstBuyers)}</strong><small>Antes: {number(previousFirstBuyers)}</small></div>
            <div><span>Ya habían comprado</span><strong>{number(outlook.repeatBuyers28)}</strong><small>Antes: {number(outlook.repeatBuyersPrevious28)}</small></div>
          </div>
          <div className="customer-pulse-share">
            <span>Participación de compradores recurrentes</span>
            <strong>{repeatShare === null ? "—" : `${Math.round(repeatShare * 100)}%`}</strong>
            <small>{previousRepeatShare === null ? "Sin comparación previa" : `Antes: ${Math.round(previousRepeatShare * 100)}%`}</small>
          </div>
          <div className="customer-inactive">
            <div>
              <span>Sin actividad en</span>
              <select aria-label="Días de inactividad" value={inactiveDays} onChange={(e) => setInactiveDays(Number(e.target.value))}>
                {[30, 60, 90, ...(![30, 60, 90].includes(inactiveDays) ? [inactiveDays] : [])].map((days) => <option key={days} value={days}>{days} días</option>)}
              </select>
            </div>
            <strong>{number(inactive)} socios</strong>
            <button onClick={() => navigate(`/app/socios?segment=inactive&days=${inactiveDays}`)}>Revisar fichas <ArrowRight size={15} /></button>
          </div>
        </Panel>
      </div>
      {financial && (
        <div className="dashboard-charts lower">
          <Panel
            title="El aporte de cada responsable"
            sub="Ventas y rentabilidad del período"
            action={
              <ActionLink onClick={() => navigate("/app/responsables")}>
                Comparar
              </ActionLink>
            }
          >
            <div className="owner-ranking">
              {[...owners]
                .sort((a, b) => b.revenue - a.revenue)
                .map((o, i) => (
                  <div className="owner-rank" key={o.id}>
                    <span className="rank-number">{i + 1}</span>
                    <Avatar name={o.name} color={o.color} />
                    <div className="owner-rank-name">
                      <strong>{o.name}</strong>
                      <small>{o.lots} lotes asignados</small>
                    </div>
                    <div className="owner-bar">
                      <i
                        style={{
                          width: `${total ? (o.revenue / total) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <div className="owner-rank-value">
                      <strong>{money(o.revenue)}</strong>
                      <small>
                        {o.revenue
                          ? Math.round(((o.revenue - o.cost) / o.revenue) * 100)
                          : 0}
                        % margen
                      </small>
                    </div>
                  </div>
                ))}
            </div>
          </Panel>
          <Panel title="Gastos bajo control" sub="Presupuesto mensual">
            <div className="budget-value">
              <strong>
                {money(monthlyExpenses)}
              </strong>
              <span>de {money(state.settings.budget)}</span>
            </div>
            <div className="budget-track">
              <i
                style={{
                  width: `${Math.min(100, (monthlyExpenses / (state.settings.budget || 1)) * 100)}%`,
                }}
              />
            </div>
            <p className="muted small">
              Los gastos incluyen costos fijos y variables registrados.
            </p>
            <ActionLink onClick={() => navigate("/app/gastos")}>
              Revisar gastos
            </ActionLink>
          </Panel>
        </div>
      )}
    </div>
  );
}
