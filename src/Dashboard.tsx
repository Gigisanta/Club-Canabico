import { useMemo, useState } from "react";
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
  WarningCircle,
  Clock,
  ArrowRight,
  TrendUp,
} from "@phosphor-icons/react";
import {
  useClub,
  offsetDate,
  daysBetween,
  number,
  shortDate,
  download,
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
export function Dashboard({ onSale }: { onSale: () => void }) {
  const { state, money, owner, setOwner, canSell, user } = useClub();
  const navigate = useNavigate();
  const [range, setRange] = useState("month");
  const [tab, setTab] = useState("revenue");
  const [ranking, setRanking] = useState("volume");
  const [inactiveDays, setInactiveDays] = useState(state.settings.inactiveDays);
  const start =
    range === "today"
      ? state.today
      : range === "week"
        ? offsetDate(state.today, -6)
        : `${state.today.slice(0, 7)}-01`;
  const length = daysBetween(state.today, start) + 1;
  const prevStart = offsetDate(start, -length);
  const sales = state.sales.filter(
    (s) => s.date >= start && s.date <= state.today,
  );
  const previous = state.sales.filter(
    (s) => s.date >= prevStart && s.date < start,
  );
  const total = sales.reduce((n, s) => n + s.total, 0);
  const before = previous.reduce((n, s) => n + s.total, 0);
  const cost = sales.reduce((n, s) => n + s.cost, 0);
  const expenses = state.expenses
    .filter((e) => e.date >= start && e.date <= state.today)
    .reduce((n, e) => n + e.amount, 0);
  const stock = state.products.reduce(
    (n, p) => n + (p.stock * p.cost) / 1000,
    0,
  );
  const low = state.products.filter((p) => p.stock <= p.minimum);
  const active = new Set(sales.map((s) => s.customerId));
  const returning = [...active].filter(
    (id) => sales.filter((s) => s.customerId === id).length > 1,
  ).length;
  const chart = useMemo(
    () =>
      Array.from({ length }, (_, i) => {
        const date = offsetDate(start, i);
        const old = offsetDate(date, -length);
        return {
          date,
          label: shortDate(date),
          revenue:
            state.sales
              .filter((s) => s.date === date)
              .reduce((n, s) => n + s.total, 0) / 100,
          previous:
            state.sales
              .filter((s) => s.date === old)
              .reduce((n, s) => n + s.total, 0) / 100,
          expenses:
            state.expenses
              .filter((e) => e.date === date)
              .reduce((n, e) => n + e.amount, 0) / 100,
        };
      }),
    [state, start, length],
  );
  const owners = state.users
    .filter(
      (u) =>
        state.products.some((p) => p.ownerId === u.id) ||
        sales.some((s) => s.items.some((i) => i.ownerId === u.id)),
    )
    .map((u) => {
      const items = sales
        .flatMap((s) => s.items)
        .filter((i) => i.ownerId === u.id);
      const products = state.products.filter((p) => p.ownerId === u.id);
      return {
        ...u,
        value:
          user.role === "cashier"
            ? products.length
            : products.reduce((n, p) => n + (p.stock * p.cost) / 1000, 0),
        revenue: items.reduce((n, i) => n + i.revenue, 0),
        cost: items.reduce((n, i) => n + i.cost, 0),
        lots: products.length,
      };
    });
  const top = state.customers
    .map((c) => {
      const history = sales.filter((s) => s.customerId === c.id);
      return {
        ...c,
        amount: history.reduce((n, s) => n + s.total, 0),
        count: history.length,
      };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) =>
      ranking === "volume" ? b.amount - a.amount : b.count - a.count,
    )
    .slice(0, 10);
  const inactive = state.customers.filter(
    (c) =>
      daysBetween(state.today, c.lastPurchase || c.createdAt) >= inactiveDays,
  );
  const expiring = state.products.filter(
    (p) =>
      p.expires && daysBetween(p.expires, state.today) <= 30 && p.stock > 0,
  );
  const change = before ? ((total - before) / before) * 100 : null;
  const financial = user.role !== "cashier";
  return (
    <>
      <PageHeader
        eyebrow="TU CLUB, DE UN VISTAZO"
        title={`Todo en orden, ${user.name.split(" ")[0]}.`}
        description="Una visión clara de lo que pasa y de lo que viene."
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
        <div className="view-tabs">
          <button className="active">Visión general</button>
          {financial && (
            <button
              onClick={() =>
                navigate(financial ? "/responsables" : "/inventario")
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
          value={number(active.size)}
          icon={<UsersThree size={20} />}
          detail={`De ${state.customers.length} socios registrados`}
        />
        <Metric
          title={financial ? "Margen bruto" : "Ticket promedio"}
          value={
            financial
              ? `${total ? (((total - cost) / total) * 100).toFixed(1) : "0"}%`
              : money(sales.length ? total / sales.length : 0)
          }
          icon={<Coins size={20} />}
          detail={
            financial
              ? `${money(total - cost)} de beneficio bruto`
              : `${sales.length} ventas registradas`
          }
        />
      </div>
      <div className="dashboard-charts">
        <Panel
          title="Así se mueve tu club"
          sub="Evolución de ingresos en el período"
          className="revenue-panel"
          action={
            <div className="segmented">
              <button
                className={tab === "revenue" ? "active" : ""}
                onClick={() => setTab("revenue")}
              >
                Ingresos
              </button>
              {financial && (
                <button
                  className={tab === "expenses" ? "active" : ""}
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
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.17} />
                    <stop offset="95%" stopColor="#a78bfa" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 5"
                  vertical={false}
                  stroke="#2d2937"
                />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                  tick={{ fontSize: 10, fill: "#aaa5b7" }}
                  dy={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10, fill: "#aaa5b7" }}
                  tickFormatter={(v) =>
                    `${v >= 1000 ? `${number(v / 1000)}k` : v}`
                  }
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid #393144",
                    background: "#211d2a",
                    color: "#f1edf8",
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
                    stroke="#665a80"
                    strokeWidth={1.5}
                    strokeDasharray="5 5"
                    isAnimationActive={false}
                  />
                )}
                <Area
                  type="monotone"
                  dataKey={tab}
                  stroke="#a78bfa"
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
              <strong>{money(sales.length ? total / sales.length : 0)}</strong>
            </span>
            <span>
              Ventas realizadas <strong>{sales.length}</strong>
            </span>
            <span>
              Tasa de recompra{" "}
              <strong>
                {active.size ? Math.round((returning / active.size) * 100) : 0}%
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
              onClick={() => navigate("/responsables")}
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
                      fill={["#a78bfa", "#7757b5", "#d3b7f0", "#5b4383"][i % 4]}
                    />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: "#211d2a", borderColor: "#393144", color: "#f1edf8" }} itemStyle={{ color: "#f1edf8" }} formatter={(v) => money(Number(v))} />
              </PieChart>
            </ResponsiveContainer>
            <div className="donut-center">
              <small>Stock total</small>
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
                      background: ["#a78bfa", "#7757b5", "#d3b7f0", "#5b4383"][
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
            onClick={() => navigate("/responsables")}
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
            <ActionLink onClick={() => navigate("/socios")}>
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
                                "/socios?q=" + encodeURIComponent(c.name),
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
        <div className="attention-column">
          <Panel
            title={
              <>
                <span className="attention-title">
                  <WarningCircle size={19} />
                  Necesitan tu atención
                </span>
              </>
            }
            action={
              <span className="count-pill">{low.length + expiring.length}</span>
            }
          >
            <div className="attention-list">
              {low.slice(0, 3).map((p) => (
                <button
                  key={p.id}
                  onClick={() =>
                    navigate("/inventario?q=" + encodeURIComponent(p.name))
                  }
                >
                  <span className="alert-symbol">
                    <Package size={19} />
                  </span>
                  <span>
                    <strong>{p.name}</strong>
                    <small>
                      {number(p.stock / 1000)} {p.unit} disponibles · Mín.{" "}
                      {p.minimum / 1000} {p.unit}
                    </small>
                  </span>
                  <Badge tone="amber">Stock bajo</Badge>
                </button>
              ))}
              {expiring.slice(0, 1).map((p) => (
                <button
                  key={p.id}
                  onClick={() =>
                    navigate("/inventario?q=" + encodeURIComponent(p.name))
                  }
                >
                  <span className="alert-symbol neutral">
                    <Clock size={19} />
                  </span>
                  <span>
                    <strong>{p.name}</strong>
                    <small>Vencimiento: {shortDate(p.expires!)}</small>
                  </span>
                  <ArrowRight size={16} />
                </button>
              ))}
              {!low.length && !expiring.length && (
                <Empty title="Tu inventario está al día" />
              )}
            </div>
          </Panel>
          <section className="retention-card">
            <div className="retention-head">
              <span>
                <UsersThree size={19} /> Volvamos a conectar
              </span>
              <select
                aria-label="Días de inactividad"
                value={inactiveDays}
                onChange={(e) => setInactiveDays(Number(e.target.value))}
              >
                {[
                  30,
                  60,
                  90,
                  ...(![30, 60, 90].includes(inactiveDays)
                    ? [inactiveDays]
                    : []),
                ].map((d) => (
                  <option key={d} value={d}>
                    {d} días
                  </option>
                ))}
              </select>
            </div>
            <strong>
              {inactive.length} <span>socios inactivos</span>
            </strong>
            <p>
              Hace más de {inactiveDays} días que no visitan el club.
              <br />
              Un buen momento para volver a acercarse.
            </p>
            <button
              onClick={() =>
                navigate(`/socios?segment=inactive&days=${inactiveDays}`)
              }
            >
              Ver socios inactivos <ArrowRight size={16} />
            </button>
          </section>
        </div>
      </div>
      {financial && (
        <div className="dashboard-charts lower">
          <Panel
            title="El aporte de cada responsable"
            sub="Ventas y rentabilidad del período"
            action={
              <ActionLink onClick={() => navigate("/responsables")}>
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
                {money(
                  state.expenses
                    .filter(
                      (e) =>
                        e.date.startsWith(state.today.slice(0, 7)) &&
                        e.date <= state.today,
                    )
                    .reduce((n, e) => n + e.amount, 0),
                )}
              </strong>
              <span>de {money(state.settings.budget)}</span>
            </div>
            <div className="budget-track">
              <i
                style={{
                  width: `${Math.min(100, (state.expenses.filter((e) => e.date.startsWith(state.today.slice(0, 7)) && e.date <= state.today).reduce((n, e) => n + e.amount, 0) / (state.settings.budget || 1)) * 100)}%`,
                }}
              />
            </div>
            <p className="muted small">
              Los gastos incluyen costos fijos y variables registrados.
            </p>
            <ActionLink onClick={() => navigate("/gastos")}>
              Revisar gastos
            </ActionLink>
          </Panel>
        </div>
      )}
    </>
  );
}
