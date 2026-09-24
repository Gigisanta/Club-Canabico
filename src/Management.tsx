import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Plus,
  Wallet,
  ArrowsClockwise,
  ArrowRight,
  DownloadSimple,
  FileCsv,
  FileXls,
  FilePdf,
  ChartBar,
  Plant,
  TrendUp,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  useClub,
  send,
  number,
  shortDate,
  download,
  useResource,
  type Expense,
} from "./lib";
import type { Page } from "../shared/types";
import {
  PageHeader,
  Panel,
  Search,
  Badge,
  Avatar,
  Modal,
  Form,
  Field,
  Empty,
  Metric,
} from "./ui";
export function Expenses() {
  const { state, money, canManage, isManager, user, owner, reload } = useClub();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(params.get("q") || "");
  const [kind, setKind] = useState(params.get("kind") || "all");
  const [month, setMonth] = useState(params.get("month") || state.today.slice(0, 7));
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(query), 250); return () => clearTimeout(timer); }, [query]);
  useEffect(() => {
    setQuery(params.get("q") || "");
    setKind(params.get("kind") || "all");
    setMonth(params.get("month") || state.today.slice(0, 7));
  }, [params, state.today]);
  const updateParam = (key: string, value: string, defaultValue = "") => {
    const next = new URLSearchParams(params);
    if (value && value !== defaultValue) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  useEffect(() => { setCursor(null); setPrevious([]); }, [debouncedQuery, kind, month, owner]);
  const expenseData = useResource<Page<Expense, { total: number }>>(
    `/list/expenses?${new URLSearchParams({ month, kind, q: debouncedQuery, ...(owner ? { owner } : {}), ...(cursor ? { cursor } : {}) })}`,
  );
  const list = expenseData.data?.items || [];
  const total = expenseData.data?.summary.total || 0;
  const income = state.periodRevenue;
  return (
    <>
      <PageHeader
        eyebrow="CUIDÁ LOS RECURSOS DEL CLUB"
        title="Gastos registrados"
        description="Costos fijos, variables y compromisos recurrentes. Los pagos reales se registran en Caja y planificación."
        actions={
          <>
            {isManager && (
              <button
                className="button"
                onClick={() =>
                  void send<{ count: number }>("/expenses/recurring", {})
                    .then(async (r) => {
                      toast.success(`${r.count} vencimientos procesados`);
                      await Promise.all([reload(), expenseData.reload()]);
                    })
                    .catch((e) => toast.error(e.message))
                }
              >
                <ArrowsClockwise />
                Procesar recurrencias
              </button>
            )}
            {canManage && (
              <button className="button primary" onClick={() => setOpen(true)}>
                <Plus />
                Registrar gasto
              </button>
            )}
          </>
        }
      />
      <div className="metrics-grid three">
        <Metric
          title="Ingresos del mes"
          value={money(income)}
          icon={<TrendUp />}
          detail={month}
        />
        <Metric
          title="Gastos del mes"
          value={money(total)}
          icon={<Wallet />}
          detail={`${state.settings.budget ? Math.round((total / state.settings.budget) * 100) : 0}% del presupuesto mensual`}
        />
        <Metric
          title="Ventas menos gastos registrados"
          value={money(income - total)}
          icon={<ChartBar />}
          detail="Indicador preliminar: no descuenta costo vendido ni separa movimientos de caja"
        />
      </div>
      <Panel title="Registro de gastos">
        <div className="table-toolbar">
          <Search
            value={query}
            onChange={(value) => { setQuery(value); updateParam("q", value); }}
            placeholder="Buscar gasto…"
          />
          <div className="filter-group">
            <input
              type="month"
              aria-label="Mes de gastos"
              value={month}
              onChange={(e) => { setMonth(e.target.value); updateParam("month", e.target.value, state.today.slice(0, 7)); }}
            />
            <select
              aria-label="Tipo de gasto"
              value={kind}
              onChange={(e) => { setKind(e.target.value); updateParam("kind", e.target.value, "all"); }}
            >
              <option value="all">Todos los gastos</option>
              <option value="fixed">Fijos</option>
              <option value="variable">Variables</option>
            </select>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Concepto</th>
                <th>Categoría</th>
                <th>Tipo</th>
                <th>Responsable</th>
                <th>Fecha</th>
                <th className="numeric">Importe</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.id}>
                  <td>
                    <strong>{e.name}</strong>
                    <small className="cell-small">
                      {e.recurrence === "monthly"
                        ? "Recurrente mensual"
                        : e.recurrence === "weekly"
                          ? "Recurrente semanal"
                          : "Pago único"}
                    </small>
                  </td>
                  <td>{e.category}</td>
                  <td>
                    <Badge tone={e.kind === "fixed" ? "gray" : "green"}>
                      {e.kind === "fixed" ? "Fijo" : "Variable"}
                    </Badge>
                  </td>
                  <td>
                    {state.users.find((u) => u.id === e.ownerId)?.name ||
                      "Club · general"}
                  </td>
                  <td>{shortDate(e.date)}</td>
                  <td className="numeric amount">{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {expenseData.loading && <p role="status" className="table-note">Buscando gastos…</p>}
          {!expenseData.loading && !list.length && <Empty title="Sin gastos en este período" />}
        </div>
        {expenseData.error && <p role="alert">{expenseData.error}</p>}
        {(previous.length > 0 || expenseData.data?.nextCursor) && <div className="table-pagination">
          <button className="button" disabled={!previous.length} onClick={() => { setCursor(previous.at(-1) || null); setPrevious((rows) => rows.slice(0, -1)); }}>Anterior</button>
          <span>Página {previous.length + 1} · {expenseData.data?.total || 0} gastos</span>
          <button className="button" disabled={!expenseData.data?.nextCursor} onClick={() => { setPrevious((rows) => [...rows, cursor]); setCursor(expenseData.data!.nextCursor); }}>Siguiente</button>
        </div>}
      </Panel>
      <Modal
        title="Registrar gasto"
        description="Los gastos recurrentes se generan con «Procesar recurrencias» cuando llega su fecha."
        open={open}
        onClose={() => setOpen(false)}
      >
        <Form
          onCancel={() => setOpen(false)}
          onSubmit={async (fd) => {
            await send("/expenses", {
              ...Object.fromEntries(fd),
              amount: Math.round(Number(fd.get("amount")) * 100),
              ownerId: fd.get("ownerId") || null,
            });
            toast.success("Gasto registrado");
            setOpen(false);
            await Promise.all([reload(), expenseData.reload()]);
          }}
        >
          <Field label="Concepto">
            <input name="name" required placeholder="Ej. Alquiler del local" />
          </Field>
          <div className="form-grid">
            <Field label="Importe">
              <input
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                required
              />
            </Field>
            <Field label="Fecha de pago">
              <input
                name="date"
                type="date"
                defaultValue={state.today}
                required
              />
            </Field>
            <Field label="Categoría">
              <select name="category">
                {[
                  "Alquiler",
                  "Servicios",
                  "Personal",
                  "Insumos",
                  "Transporte",
                  "Mantenimiento",
                  "Otros",
                ].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </Field>
            <Field label="Tipo">
              <select name="kind">
                <option value="variable">Variable</option>
                <option value="fixed">Fijo</option>
              </select>
            </Field>
            <Field label="Recurrencia">
              <select name="recurrence">
                <option value="none">No se repite</option>
                <option value="monthly">Mensual</option>
                <option value="weekly">Semanal</option>
              </select>
            </Field>
            <Field label="Asignar a">
              <select
                name="ownerId"
                defaultValue={user.role === "responsible" ? user.id : ""}
              >
                {user.role !== "responsible" && (
                  <option value="">Club · general</option>
                )}
                {state.users
                  .filter((u) =>
                    ["owner", "admin", "responsible"].includes(u.role),
                  )
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
        </Form>
      </Modal>
    </>
  );
}
export function Responsibles() {
  const { state, money, setOwner } = useClub();
  const navigate = useNavigate();
  const [sort, setSort] = useState("revenue");
  const owners = state.users
    .filter(
      (u) =>
        u.role === "responsible" ||
        state.products.some((p) => p.ownerId === u.id),
    )
    .map((u) => {
      const products = state.products.filter((p) => p.ownerId === u.id);
      const items = state.responsibleRows.filter((row) => row.ownerId === u.id);
      const revenue = items.reduce((n, i) => n + i.revenue, 0);
      const cost = items.reduce((n, i) => n + i.cost, 0);
      const stockCost = products.reduce(
        (n, p) => n + (p.stock * p.cost) / 1000,
        0,
      );
      return {
        ...u,
        products,
        revenue,
        cost,
        stockCost,
        rotation: stockCost ? cost / stockCost : 0,
      };
    })
    .sort((a, b) =>
      sort === "revenue" ? b.revenue - a.revenue : b.rotation - a.rotation,
    );
  return (
    <>
      <PageHeader
        eyebrow="CADA RESPONSABLE, SU APORTE"
        title="Responsables de reprogram"
        description="Asignación clara, historial intacto y una visión compartida del club."
        actions={
          <select
            aria-label="Orden de responsables"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="revenue">Ordenar por ventas</option>
            <option value="rotation">Ordenar por rotación</option>
          </select>
        }
      />
      <div className="owner-cards">
        {owners.map((o, i) => (
          <section className="owner-card" key={o.id}>
            <div className="owner-card-top">
              <Avatar name={o.name} color={o.color} size={52} />
              <span className="rank-badge">#{i + 1} del mes</span>
            </div>
            <h2>{o.name}</h2>
            <p>Responsable de reprogram</p>
            <div className="owner-card-numbers">
              <div>
                <span>Ventas del mes</span>
                <strong>{money(o.revenue)}</strong>
              </div>
              <div>
                <span>Margen bruto</span>
                <strong>
                  {o.revenue
                    ? (((o.revenue - o.cost) / o.revenue) * 100).toFixed(1)
                    : 0}
                  %
                </strong>
              </div>
            </div>
            <div className="owner-card-info">
              <span>
                Lotes asignados <strong>{o.products.length}</strong>
              </span>
              <span>
                Stock valorizado <strong>{money(o.stockCost)}</strong>
              </span>
              <span>
                Rotación a costo <strong>{o.rotation.toFixed(2)}×</strong>
              </span>
              <span>
                Alertas de stock{" "}
                <strong>
                  {o.products.filter((p) => p.stock <= p.minimum).length}
                </strong>
              </span>
            </div>
            <button
              className="button full-width"
              onClick={() => {
                setOwner(o.id);
                navigate("/inventario");
              }}
            >
              Ver inventario <ArrowRight />
            </button>
          </section>
        ))}
      </div>
      <Panel
        title="Rentabilidad por producto"
        sub="Período: mes actual. La responsabilidad de cada venta se conserva aunque el lote se traspase."
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th>Responsable de la venta</th>
                <th className="numeric">Ingresos</th>
                <th className="numeric">Costo</th>
                <th className="numeric">Margen bruto</th>
              </tr>
            </thead>
            <tbody>
              {owners.flatMap((o) => {
                const items = state.responsibleRows.filter((row) => row.ownerId === o.id);
                return items.map((row) => {
                  const income = row.revenue;
                  const cost = row.cost;
                  return (
                    <tr key={`${o.id}-${row.productId}`}>
                      <td>
                        <strong>{row.name}</strong>
                      </td>
                      <td>{o.name}</td>
                      <td className="numeric">{money(income)}</td>
                      <td className="numeric">{money(cost)}</td>
                      <td className="numeric amount">{money(income - cost)}</td>
                    </tr>
                  );
                });
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      <p className="muted small">
        Rotación = costo de productos vendidos en el mes / valor del stock
        actual a costo. No utiliza stock promedio histórico.
      </p>
    </>
  );
}
export function Reports() {
  const { state, owner, setOwner } = useClub();
  const [from, setFrom] = useState(state.today.slice(0, 7) + "-01");
  const [to, setTo] = useState(state.today);
  return (
    <>
      <PageHeader
        eyebrow="DE LOS DATOS A LAS DECISIONES"
        title="Reportes y liquidaciones"
        description="Exportá la información del club para analizarla, compartirla o archivarla."
      />
      <Panel
        title="Prepará tu reporte"
        sub="Los archivos respetan el responsable seleccionado y los permisos de tu cuenta."
      >
        <div className="report-filters">
          <Field label="Desde">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="Hasta">
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Field label="Responsable">
            <select
              value={state.user.role === "responsible" ? state.user.id : owner}
              onChange={(e) => setOwner(e.target.value)}
              disabled={state.user.role === "responsible"}
            >
              <option value="">Todos los responsables</option>
              {state.users
                .filter((u) =>
                  ["owner", "admin", "responsible"].includes(u.role),
                )
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      </Panel>
      <div className="export-cards">
        {[
          {
            format: "xlsx",
            title: "Reporte de ventas",
            description:
              "Una planilla Excel con el detalle de ventas, costos, márgenes y responsables.",
            icon: FileXls,
          },
          {
            format: "pdf",
            title: "Liquidación por responsable",
            description:
              "Un documento PDF con ingresos, costos y margen bruto de cada responsable.",
            icon: FilePdf,
          },
          {
            format: "csv",
            title: "Datos para análisis",
            description:
              "Archivo CSV compatible con Google Sheets, Excel y herramientas de análisis.",
            icon: FileCsv,
          },
        ].map(({ format, title, description, icon: Icon }) => (
          <section key={format} className="export-card">
            <span className="export-icon">
              <Icon size={34} weight="duotone" />
            </span>
            <h2>{title}</h2>
            <p>{description}</p>
            <button
              className="button"
              disabled={!from || !to || from > to}
              onClick={() =>
                download(
                  `/api/reports/${format}?from=${from}&to=${to}${owner ? "&owner=" + encodeURIComponent(owner) : ""}`,
                )
              }
            >
              <DownloadSimple />
              Descargar {format.toUpperCase()}
            </button>
          </section>
        ))}
      </div>
      {from > to && (
        <p className="form-error">
          La fecha inicial no puede superar la final.
        </p>
      )}
    </>
  );
}
