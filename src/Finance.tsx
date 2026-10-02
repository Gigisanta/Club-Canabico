import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { ArrowRight, CheckCircle, ChartBar, Clock, Info, Wallet, WarningCircle } from "@phosphor-icons/react";
import { useClub, send, offsetDate, shortDate, number, useResource } from "./lib";
import type { CashEntry, CashLedgerSummary, Page } from "../shared/types";
import { PageHeader, Panel, Modal, Form, Field, Empty, Search } from "./ui";
import { BreakEvenSection } from "./BreakEven";
import { UpcomingPaymentsSection } from "./UpcomingPayments";
import { cashCategories as categories } from "./cash-categories";
import type { BreakEvenResult } from "../shared/break-even";
import type { UpcomingPaymentsReport } from "../shared/upcoming-payments";
import "./panorama.css";
import "./finance.css";

const scenarios = ["base", "cautious", "growth"] as const;
const scenarioNames = { base: "Base", cautious: "Prudente", growth: "Crecimiento" };
const incomeCategories = ["opening_balance", "capital_contribution", "delivery_receipt", "other_income", "adjustment"];
const outflowCategories = ["operating_expense", "stock_purchase", "local_investment", "owner_draw", "other_outflow", "adjustment"];
type View = "overview" | "activity" | "forecast";
type Account = "all" | "cash" | "bank";
const accountNames: Record<Account, string> = { all: "Todas", cash: "Efectivo", bank: "Banco" };
type CheckState = "recorded" | "review" | "pending" | "empty";
const checkLabels: Record<CheckState, string> = { recorded: "Registrado", review: "A revisar", pending: "Sin conciliar", empty: "Sin registros" };
const checkIcons = { recorded: CheckCircle, review: WarningCircle, pending: Clock, empty: Info };
function StateTag({ state }: { state: CheckState }) {
  const Icon = checkIcons[state];
  return <span className={`fin-tag is-${state}`}><Icon size={15} weight="fill" aria-hidden="true" />{checkLabels[state]}</span>;
}

export default function Finance() {
  const { state, money, reload } = useClub();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"entry" | "plan" | null>(null);
  const [direction, setDirection] = useState<"income" | "outflow">("outflow");
  const [category, setCategory] = useState("operating_expense");
  const [entryKey, setEntryKey] = useState(() => crypto.randomUUID());
  const [scenario, setScenario] = useState<(typeof scenarios)[number]>("base");
  const [params, setParams] = useSearchParams();
  const requestedView = params.get("view");
  const view: View = requestedView === "activity" || requestedView === "forecast" ? requestedView : "overview";
  const requestedAccount = params.get("account");
  const account: Account = requestedAccount === "cash" || requestedAccount === "bank" ? requestedAccount : "all";
  function setView(next: View, nextAccount: Account = "all") {
    const query = new URLSearchParams(params);
    if (next === "overview") query.delete("view");
    else query.set("view", next);
    if (next === "activity" && nextAccount !== "all") query.set("account", nextAccount);
    else query.delete("account");
    setParams(query, { replace: true });
  }
  const stockDetail = useRef<HTMLDetailsElement>(null);
  const [cashCursor, setCashCursor] = useState<string | null>(null);
  const [cashPrevious, setCashPrevious] = useState<(string | null)[]>([]);
  const [flow, setFlow] = useState<"all" | "in" | "out">("all");
  const [ledgerCategory, setLedgerCategory] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [ledgerQuery, setLedgerQuery] = useState("");
  const [debouncedLedgerQuery, setDebouncedLedgerQuery] = useState("");
  useEffect(() => { const timer = window.setTimeout(() => setDebouncedLedgerQuery(ledgerQuery.trim()), 250); return () => clearTimeout(timer); }, [ledgerQuery]);
  useEffect(() => { setCashCursor(null); setCashPrevious([]); }, [account, flow, ledgerCategory, fromDate, toDate, debouncedLedgerQuery]);
  const ledgerFilters = new URLSearchParams({ account, direction: flow, category: ledgerCategory, q: debouncedLedgerQuery,
    ...(fromDate ? { from: fromDate } : {}), ...(toDate ? { to: toDate } : {}), ...(cashCursor ? { cursor: cashCursor } : {}) });
  const cashPage = useResource<Page<CashEntry, CashLedgerSummary>>(view === "activity" ? `/list/cash-entries?${ledgerFilters}` : null);
  const breakEven = useResource<BreakEvenResult>(view === "overview" ? "/finance/break-even" : null);
  const upcoming = useResource<UpcomingPaymentsReport>(view === "overview" ? "/finance/upcoming-payments" : null);
  // Inicio links to #proximos-pagos: scroll there once the section has its content.
  const location = useLocation();
  const upcomingLoaded = Boolean(upcoming.data);
  useEffect(() => {
    if (upcomingLoaded && location.hash === "#proximos-pagos") document.getElementById("proximos-pagos")?.scrollIntoView({ block: "start" });
  }, [upcomingLoaded, location.hash]);
  // Account balances do not depend on the filters; keep the last ones while a new page loads.
  const [ledgerSummary, setLedgerSummary] = useState<CashLedgerSummary | null>(null);
  useEffect(() => { if (cashPage.data) setLedgerSummary(cashPage.data.summary); }, [cashPage.data]);
  const filtered = flow !== "all" || ledgerCategory !== "all" || Boolean(fromDate || toDate || debouncedLedgerQuery);
  function clearLedgerFilters() {
    setFlow("all");
    setLedgerCategory("all");
    setFromDate("");
    setToDate("");
    setLedgerQuery("");
  }

  const today = state.today;
  const month = new Date(`${today.slice(0, 7)}-01T12:00:00`).toLocaleDateString("es-AR", { month: "long", year: "numeric" });
  const cashMovement = state.financeBalance;
  const stock = state.products.reduce((sum, product) => sum + Math.round(product.stock * product.cost / 1000), 0);
  const withoutSupplier = state.products.filter((product) => !product.supplier).length;
  const withoutCost = state.products.filter((product) => product.stock > 0 && product.cost === 0).length;
  const currentPlans = state.cashPlans.filter((plan) => plan.scenario === scenario);
  const revenue = state.periodRevenue;
  const cogs = state.periodCost;
  const expenses = state.periodExpense;
  const result = revenue - cogs - expenses;
  const hasLocalFigures = revenue !== 0 || cogs !== 0 || expenses !== 0;
  const scale = Math.max(revenue, cogs, expenses, 1);
  const untilToday = `1–${shortDate(today)}`;
  // Sources behind the result. Bombo can tell whether records exist locally; it cannot tell whether they are complete or reconciled.
  const sources: { key: string; label: string; state: CheckState; value: string; detail: string }[] = [
    { key: "sales", label: "Ventas locales", state: revenue > 0 ? "recorded" : "empty", value: revenue > 0 ? money(revenue) : "—", detail: revenue > 0 ? `Neto registrado en Bombo, ${untilToday}. Falta contrastar con comprobantes.` : "No hay ventas locales registradas en el período. Puede ser correcto si no hubo operaciones." },
    { key: "expenses", label: "Gastos", state: expenses > 0 ? "recorded" : "empty", value: expenses > 0 ? money(expenses) : "—", detail: expenses > 0 ? `Cargados en Gastos, ${untilToday}. Podrían faltar registros.` : "No hay gastos cargados en el período. Puede ser correcto si no hubo gastos." },
    { key: "cost", label: "Costo vendido", state: withoutCost ? "review" : "pending", value: cogs ? money(cogs) : "—", detail: withoutCost ? `${withoutCost} ${withoutCost === 1 ? "lote actual con stock y costo cero" : "lotes actuales con stock y costo cero"}. Revisá facturas y ventas anteriores.` : "Costo histórico guardado en cada venta. Requiere cotejo con facturas." },
    { key: "cash", label: "Movimiento de caja y banco", state: "pending", value: cashMovement ? money(cashMovement) : "—", detail: "Movimiento neto registrado, no saldo disponible. Falta una apertura conciliada." },
  ];

  const weeks = Array.from({ length: 13 }, (_, index) => {
    const from = offsetDate(today, index * 7 + 1);
    const to = offsetDate(today, (index + 1) * 7);
    const plans = currentPlans.filter((plan) => plan.date >= from && plan.date <= to);
    return { from, to, change: plans.reduce((sum, plan) => sum + plan.amount, 0), count: plans.length };
  });
  const horizonCount = weeks.reduce((sum, week) => sum + week.count, 0);
  const horizonChange = weeks.reduce((sum, week) => sum + week.change, 0);
  const minChange = Math.min(0, ...weeks.map((week) => week.change));
  const maxChange = Math.max(0, ...weeks.map((week) => week.change));
  const maxAbsChange = Math.max(1, ...weeks.map((week) => Math.abs(week.change)));
  const annual = Array.from({ length: 12 }, (_, index) => {
    const period = `2027-${String(index + 1).padStart(2, "0")}`;
    const plans = currentPlans.filter((plan) => plan.date.startsWith(period));
    return {
      period,
      count: plans.length,
      income: plans.filter((plan) => plan.amount > 0).reduce((sum, plan) => sum + plan.amount, 0),
      outflow: plans.filter((plan) => plan.amount < 0).reduce((sum, plan) => sum - plan.amount, 0),
    };
  });
  const annualCount = annual.reduce((sum, period) => sum + period.count, 0);

  async function save(form: FormData) {
    const values = Object.fromEntries(form);
    const enteredAmount = Math.round(Number(form.get("amount")) * 100);
    if (!Number.isSafeInteger(enteredAmount) || enteredAmount <= 0) throw new Error("Ingresá un importe mayor a cero");
    const amount = direction === "outflow" ? -enteredAmount : enteredAmount;
    await send(mode === "entry" ? "/cash-entries" : "/cash-plans", {
      ...values,
      amount,
      ...(mode === "entry" ? { sourceSystem: "local", sourceId: entryKey } : {}),
    });
    toast.success(mode === "entry" ? "Movimiento registrado" : "Proyección registrada");
    setMode(null);
    await reload();
    if (mode === "entry") {
      setCashCursor(null);
      setCashPrevious([]);
      if (view === "activity") await cashPage.reload();
      else setView("activity");
    } else if (view === "overview") {
      await upcoming.reload();
    } else {
      setView("forecast");
    }
  }

  function openEntry() {
    setEntryKey(crypto.randomUUID());
    setDirection("outflow");
    setCategory("operating_expense");
    setMode("entry");
  }

  function openPlan() {
    setDirection("outflow");
    setCategory("operating_expense");
    setMode("plan");
  }

  // Próximos pagos lists the base scenario only.
  function schedulePayment() {
    setScenario("base");
    openPlan();
  }

  function changeDirection(nextDirection: "income" | "outflow") {
    setDirection(nextDirection);
    setCategory(nextDirection === "income" ? "other_income" : "operating_expense");
  }

  function openStockDetail() {
    stockDetail.current?.setAttribute("open", "");
    stockDetail.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  }

  return <div className="panorama-finance">
    <PageHeader
      eyebrow="Finanzas · operación local"
      title="Finanzas"
      description="Resultado del mes y próximos pasos."
      actions={<button className="button primary" onClick={openEntry}>Registrar movimiento</button>}
    />
    <div className="finance-nav" role="group" aria-label="Vistas de finanzas">
      <button type="button" className={view === "overview" ? "active" : ""} aria-pressed={view === "overview"} onClick={() => setView("overview")}>Resumen</button>
      <button type="button" className={view === "activity" ? "active" : ""} aria-pressed={view === "activity"} onClick={() => setView("activity")}>Caja</button>
      <button type="button" className={view === "forecast" ? "active" : ""} aria-pressed={view === "forecast"} onClick={() => setView("forecast")}>Planificación</button>
    </div>

    {view === "overview" && <div className="finance-section">
      <div className="finance-topline">
      <section className="finance-result" aria-labelledby="finance-result-title">
        <div className="finance-result-top">
          <div>
            <p className="finance-result-period">{month} · {untilToday}</p>
            <h2 id="finance-result-title">Resultado local</h2>
          </div>
          <span className="finance-result-badges">{(state.demo || state.settings.sampleData) && <span className="finance-result-status is-demo"><Info size={15} weight="fill" aria-hidden="true" />Datos de demostración</span>}<span className="finance-result-status"><Clock size={15} weight="fill" aria-hidden="true" />{hasLocalFigures ? "Preliminar · sin conciliar" : "Sin registros"}</span></span>
        </div>
        <strong className="finance-result-value">{hasLocalFigures ? money(result) : "Sin datos"}</strong>
        {!hasLocalFigures && <p className="finance-empty-hint">Cargá ventas y gastos del local para calcular el resultado.</p>}
        <dl className="finance-equation">
          <div><dt>Ventas locales netas</dt><dd>{hasLocalFigures ? money(revenue) : "—"}</dd><span className="finance-mini-track" aria-hidden="true"><i style={{ width: `${Math.max(0, revenue / scale * 100)}%` }} /></span></div>
          <div><dt>Costo vendido</dt><dd>{hasLocalFigures ? `− ${money(cogs)}` : "—"}</dd><span className="finance-mini-track" aria-hidden="true"><i style={{ width: `${Math.max(0, cogs / scale * 100)}%` }} /></span></div>
          <div><dt>Gastos registrados</dt><dd>{hasLocalFigures ? `− ${money(expenses)}` : "—"}</dd><span className="finance-mini-track" aria-hidden="true"><i style={{ width: `${Math.max(0, expenses / scale * 100)}%` }} /></span></div>
        </dl>
        <details className="finance-method"><summary>Cómo se calcula</summary><p>Ventas locales netas menos costo histórico vendido y gastos registrados, del 1 al {shortDate(today)}. Delivery/AppSheet queda fuera. El resultado requiere conciliación con comprobantes.</p></details>
        <button className="finance-text-action" type="button" onClick={() => navigate("/app/decisiones/comercial")}>Analizar márgenes y precios <ArrowRight size={16} aria-hidden="true" /></button>
      </section>

        <section className="finance-priorities" aria-labelledby="finance-priorities-title">
          <h2 id="finance-priorities-title">Próximos pasos</h2>
          <p className="finance-lead">Lo necesario para confiar en las cifras.</p>
          <ol>
            <li><div><strong>Caja y banco</strong><p>Registrar y conciliar saldos de apertura.</p><button type="button" onClick={() => navigate("/app/preparar?view=cash")}>Preparar saldos <ArrowRight size={15} aria-hidden="true" /></button></div></li>
            <li><div><strong>Valor del stock</strong><p>{withoutCost ? `${withoutCost} ${withoutCost === 1 ? "lote sin costo" : "lotes sin costo"}` : withoutSupplier ? `${withoutSupplier} ${withoutSupplier === 1 ? "lote sin proveedor" : "lotes sin proveedor"}` : "Cotejar con conteo y facturas"}</p><button type="button" onClick={() => navigate("/app/inventario")}>Revisar lotes <ArrowRight size={15} aria-hidden="true" /></button></div></li>
            <li><div><strong>Historial externo</strong><p>Importar y conciliar AppSheet por separado.</p><button type="button" onClick={() => navigate("/app/importar")}>Ir a importaciones <ArrowRight size={15} aria-hidden="true" /></button></div></li>
          </ol>
        </section>
      </div>

      <BreakEvenSection data={breakEven.data} loading={breakEven.loading} error={breakEven.error} onRetry={() => void breakEven.reload()} money={money} demo={state.demo || Boolean(state.settings.sampleData)} />
      <UpcomingPaymentsSection data={upcoming.data} loading={upcoming.loading} error={upcoming.error} onRetry={() => void upcoming.reload()} onSchedule={schedulePayment} money={money} demo={state.demo || Boolean(state.settings.sampleData)} />

        <section className="finance-sources" aria-labelledby="finance-sources-title">
          <h2 id="finance-sources-title">Estado de los datos</h2>
          <p className="finance-lead">Registro visible; cobertura pendiente de verificar.</p>
          <ul>
            {sources.map((check) => <li key={check.key}><div><strong>{check.label}</strong><span className="finance-source-value">{check.value}</span><details className="finance-source-note"><summary>Fuente y límite</summary><p>{check.detail}</p></details></div><StateTag state={check.state} /></li>)}
            <li><div><strong>Inventario a costo</strong><span className="finance-source-value">{state.products.length ? money(stock) : "—"}</span><button type="button" onClick={openStockDetail}>Ver {state.products.length} {state.products.length === 1 ? "lote" : "lotes"} <ArrowRight size={15} aria-hidden="true" /></button><details className="finance-source-note"><summary>Fuente y límite</summary><p>Valor de stock actual por costo cargado. Requiere facturas y conteo físico; queda fuera del resultado.</p></details></div><StateTag state={withoutCost ? "review" : "pending"} /></li>
          </ul>
          <button type="button" className="finance-text-action" onClick={() => setView("activity")}><Wallet size={16} aria-hidden="true" /> Ver movimientos de caja</button>
        </section>
      <details className="finance-detail" id="finance-stock-detail" ref={stockDetail}>
        <summary><span><ChartBar size={18} aria-hidden="true" /> Valuación por lote</span><span>Mostrar tabla <ArrowRight size={16} aria-hidden="true" /></span></summary>
        <Panel title="Capital en inventario" sub="Cantidad actual por costo unitario cargado. Los lotes con costo cero requieren revisión.">
          <div className="table-scroll"><table><thead><tr><th scope="col">Lote</th><th scope="col">Proveedor</th><th scope="col">Producto</th><th scope="col" className="numeric">Cantidad</th><th scope="col" className="numeric">Costo unitario</th><th scope="col" className="numeric">Valor a costo</th></tr></thead><tbody>{state.products.map((product) => <tr key={product.id}><td className="table-code">{product.lot}</td><td>{product.supplier || <span className="missing-value">Sin proveedor</span>}</td><td className="table-name">{product.name}</td><td className="numeric">{number(product.stock / 1000)} {product.unit}</td><td className="numeric">{product.cost ? money(product.cost) : <span className="missing-value">Revisar</span>}</td><td className="numeric amount">{product.cost ? money(Math.round(product.stock * product.cost / 1000)) : <span className="missing-value">Pendiente</span>}</td></tr>)}</tbody></table></div>
          {!state.products.length && <Empty title="Todavía no hay lotes" description="Cargá lotes para ver el capital en stock." />}
        </Panel>
      </details>
    </div>}

    {view === "activity" && <div className="finance-section">
      <div className="finance-activity-lead"><div><span className="finance-status-label">Movimientos reales</span><h2>Un registro de entradas y salidas</h2><p>Las ventas locales entran automáticamente. Un gasto cargado en Gastos afecta la caja cuando registrás su pago acá.</p></div><button className="button primary" type="button" onClick={openEntry}>Nuevo movimiento</button></div>
      <div className="cash-accounts" role="group" aria-label="Cuenta">
        {(["all", "cash", "bank"] as const).map((key) => {
          const balance = !ledgerSummary ? null : key === "cash" ? ledgerSummary.cashBalance : key === "bank" ? ledgerSummary.bankBalance : ledgerSummary.cashBalance + ledgerSummary.bankBalance;
          const count = !ledgerSummary ? null : key === "cash" ? ledgerSummary.cashCount : key === "bank" ? ledgerSummary.bankCount : ledgerSummary.cashCount + ledgerSummary.bankCount;
          // Without records the balance is unknown, not zero.
          return <button key={key} type="button" className={account === key ? "active" : ""} aria-pressed={account === key} onClick={() => setView("activity", key)}>
            <span>{accountNames[key]}</span>
            <strong>{balance === null || !count ? "—" : money(balance)}</strong>
            <small>{count === null ? "Cargando…" : !count ? "Sin movimientos registrados" : `${key === "all" ? "caja y banco" : "saldo según registros"} · ${count} ${count === 1 ? "movimiento" : "movimientos"}`}</small>
          </button>;
        })}
      </div>
      <p className="cash-accounts-note"><Clock size={15} weight="fill" aria-hidden="true" /> Sin conciliar. El saldo suma los movimientos registrados, incluido el saldo inicial si se cargó; no reemplaza el arqueo ni el extracto.</p>
      <Panel title="Historial de caja y banco" sub="Cada movimiento conserva fecha, cuenta, categoría y origen. «Saldo de la cuenta» es el saldo de esa cuenta justo después del movimiento.">
        <div className="table-toolbar cash-ledger-toolbar">
          <Search value={ledgerQuery} onChange={setLedgerQuery} placeholder="Buscar en el detalle…" />
          <div className="filter-group">
            <select aria-label="Tipo de movimiento" value={flow} onChange={(event) => setFlow(event.target.value as typeof flow)}>
              <option value="all">Entradas y salidas</option>
              <option value="in">Solo entradas</option>
              <option value="out">Solo salidas</option>
            </select>
            <select aria-label="Categoría de caja" value={ledgerCategory} onChange={(event) => setLedgerCategory(event.target.value)}>
              <option value="all">Todas las categorías</option>
              {Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <label className="cash-ledger-date"><span>Desde</span><input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} /></label>
            <label className="cash-ledger-date"><span>Hasta</span><input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} /></label>
            {filtered && <button className="button" type="button" onClick={clearLedgerFilters}>Quitar filtros</button>}
          </div>
        </div>
        {cashPage.data && cashPage.data.total > 0 && <p className="cash-ledger-totals" aria-live="polite">
          <span>Entradas <strong>{money(cashPage.data.summary.inflow)}</strong></span>
          <span>Salidas <strong>{money(cashPage.data.summary.outflow)}</strong></span>
          <span>Neto <strong>{money(cashPage.data.summary.net)}</strong></span>
          <span>{cashPage.data.total} {cashPage.data.total === 1 ? "movimiento" : "movimientos"}{account !== "all" ? ` de ${accountNames[account].toLowerCase()}` : ""}{filtered ? " con estos filtros" : ""}</span>
        </p>}
        {cashPage.loading && <p role="status" className="muted finance-load">Cargando movimientos…</p>}
        {cashPage.error && <div className="panorama-inline-error" role="alert"><p>{cashPage.error}</p><button className="button" onClick={() => void cashPage.reload()}>Reintentar carga</button></div>}
        <div className="table-scroll"><table><thead><tr><th scope="col">Fecha</th><th scope="col">Cuenta</th><th scope="col">Categoría</th><th scope="col">Detalle</th><th scope="col">Origen</th><th scope="col" className="numeric">Importe</th><th scope="col" className="numeric">Saldo de la cuenta</th></tr></thead><tbody>{cashPage.data?.items.map((entry) => <tr key={entry.id}><td>{shortDate(entry.date)}</td><td>{entry.account === "cash" ? "Efectivo" : "Banco"}</td><td>{categories[entry.category] || entry.category}</td><td className="table-name">{entry.description}</td><td><span className="source-id" title={entry.sourceSystem && entry.sourceId ? `${entry.sourceSystem} · ${entry.sourceId}` : "App local"}>{entry.sourceSystem && entry.sourceId ? `${entry.sourceSystem} · ${entry.sourceId}` : "App local"}</span></td><td className="numeric amount">{money(entry.amount)}</td><td className="numeric cash-balance-after">{entry.balanceAfter === undefined ? "—" : money(entry.balanceAfter)}</td></tr>)}</tbody></table></div>
        {cashPage.data && !cashPage.data.items.length && (filtered || account !== "all"
          ? <Empty title="Sin movimientos con estos filtros" description="Probá otra cuenta, categoría o rango de fechas." />
          : <Empty title="Todavía no hay movimientos" description="Registrá el primer movimiento real con su fuente." />)}
        {cashPage.data && <div className="list-pagination"><span>Página {cashPrevious.length + 1} · {cashPage.data.total} movimientos</span><div><button className="button" disabled={!cashPrevious.length} onClick={() => { setCashCursor(cashPrevious.at(-1) || null); setCashPrevious((rows) => rows.slice(0, -1)); }}>Anterior</button><button className="button" disabled={!cashPage.data.nextCursor} onClick={() => { setCashPrevious((rows) => [...rows, cashCursor]); setCashCursor(cashPage.data!.nextCursor); }}>Siguiente</button></div></div>}
      </Panel>
    </div>}

    {view === "forecast" && <div className="finance-section">
      <div className="finance-plan-head"><div><span className="finance-status-label">Próximas 13 semanas</span><h2>Planificar sin confundirlo con caja real</h2><p>Elegí un escenario y cargá sus cobros, pagos y compromisos. Cada escenario tiene sus propias partidas.</p></div><button className="button primary" type="button" onClick={openPlan}>Agregar proyección</button></div>
      <div className="finance-plan-summary"><label>Escenario<select aria-label="Escenario de planificación" value={scenario} onChange={(event) => setScenario(event.target.value as typeof scenario)}>{scenarios.map((item) => <option key={item} value={item}>{scenarioNames[item]}</option>)}</select></label><div><span>Movimiento neto previsto</span><strong>{horizonCount ? money(horizonChange) : "Sin partidas"}</strong><small>{horizonCount ? `${horizonCount} ${horizonCount === 1 ? "partida" : "partidas"} en 13 semanas · no es saldo final` : "No se interpreta como $0 confirmado"}</small></div><div><span>Saldo de cierre</span><strong>Pendiente</strong><small>Requiere apertura y obligaciones conciliadas</small></div></div>
      <div className="finance-missing-opening" role="note"><div><strong>Para proyectar un saldo confiable falta una apertura conciliada.</strong><p>Estos movimientos son supuestos de trabajo. El análisis de caja exige saldos, fuentes y cobertura completos antes de mostrar un cierre.</p></div><button type="button" onClick={() => navigate("/app/preparar?view=cash")}>Preparar datos de caja <ArrowRight size={16} /></button></div>
      {!horizonCount ? <div className="forecast-empty"><div><strong>No hay partidas en las próximas 13 semanas.</strong><p>Agregá cobros y pagos con fecha para ver el movimiento previsto del escenario.</p></div><button className="button" type="button" onClick={openPlan}>Agregar primera partida <ArrowRight size={16} /></button></div> : <Panel title="Movimiento previsto por semana" sub="Verde: ingreso neto; naranja: egreso neto. Son cambios planificados, no saldos de caja.">
        <figure className="forecast-visual"><figcaption><span>Próximas 13 semanas</span><strong>{money(horizonChange)} en total</strong></figcaption><div className="forecast-bars" role="img" aria-label={`Movimientos netos previstos entre ${money(minChange)} y ${money(maxChange)} durante las próximas 13 semanas; no representa saldo de caja`}>{weeks.map((week, index) => { const height = week.change === 0 ? 5 : Math.max(8, (Math.abs(week.change) / maxAbsChange) * 91); return <div className="forecast-bar-cell" key={week.from}><i className={week.change < 0 ? "is-negative" : ""} style={{ height: `${height}%` }} title={`${shortDate(week.from)}: movimiento neto previsto ${money(week.change)}`} /><small>{String(index + 1).padStart(2, "0")}</small></div>; })}</div><div className="forecast-scale"><span>{money(minChange)}</span><span>{money(maxChange)}</span></div></figure>
        <details className="finance-inner-detail"><summary>Ver detalle de las 13 semanas</summary><div className="table-scroll"><table><thead><tr><th scope="col">Semana</th><th scope="col" className="numeric">Movimiento neto previsto</th><th scope="col">Saldo al cierre</th><th scope="col" className="numeric">Partidas</th></tr></thead><tbody>{weeks.map((week, index) => <tr key={week.from}><td className="table-name"><span className="week-index">{String(index + 1).padStart(2, "0")}</span>{shortDate(week.from)} – {shortDate(week.to)}</td><td className="numeric">{week.count ? money(week.change) : "Sin partidas"}</td><td><span className="missing-value" title="Falta una apertura conciliada">Pendiente</span></td><td className="numeric">{week.count}</td></tr>)}</tbody></table></div></details>
      </Panel>}
      <details className="finance-detail"><summary><span><ChartBar size={18} /> Plan mensual 2027</span><span>{annualCount ? `${annualCount} partidas` : "Sin partidas"} <ArrowRight size={16} /></span></summary><Panel title="Plan mensual 2027" sub="Ingresos y egresos previstos del escenario elegido. El costo de personal debe cargarse como partida explícita.">{annualCount ? <div className="table-scroll"><table><thead><tr><th scope="col">Mes</th><th scope="col" className="numeric">Ingresos</th><th scope="col" className="numeric">Egresos</th><th scope="col" className="numeric">Flujo neto</th></tr></thead><tbody>{annual.filter((period) => period.count).map((period) => <tr key={period.period}><td className="table-name">{new Date(`${period.period}-01T12:00:00`).toLocaleDateString("es-AR", { month: "long", year: "numeric" })}</td><td className="numeric">{money(period.income)}</td><td className="numeric">{money(period.outflow)}</td><td className="numeric amount">{money(period.income - period.outflow)}</td></tr>)}</tbody><tfoot><tr><th scope="row">Total planificado</th><th className="numeric">{money(annual.reduce((sum, period) => sum + period.income, 0))}</th><th className="numeric">{money(annual.reduce((sum, period) => sum + period.outflow, 0))}</th><th className="numeric">{money(annual.reduce((sum, period) => sum + period.income - period.outflow, 0))}</th></tr></tfoot></table></div> : <Empty title="Sin plan mensual para este escenario" description="Cuando cargues partidas de 2027 aparecerán acá." />}</Panel></details>
      <details className="finance-detail"><summary><span><Wallet size={18} /> Partidas del escenario</span><span>{currentPlans.length} registradas <ArrowRight size={16} /></span></summary><Panel title="Partidas planificadas" sub="Detalle y supuestos del escenario elegido.">{currentPlans.length ? <div className="table-scroll"><table><thead><tr><th scope="col">Fecha</th><th scope="col">Cuenta</th><th scope="col">Categoría</th><th scope="col">Detalle</th><th scope="col" className="numeric">Importe</th></tr></thead><tbody>{currentPlans.map((plan) => <tr key={plan.id}><td>{shortDate(plan.date)}</td><td>{plan.account === "cash" ? "Efectivo" : "Banco"}</td><td>{categories[plan.category] || plan.category}</td><td className="table-name">{plan.description}</td><td className="numeric amount">{money(plan.amount)}</td></tr>)}</tbody></table></div> : <Empty title="Sin partidas para este escenario" description="Agregá la primera partida para empezar el plan." />}</Panel></details>
      <button className="finance-text-action" type="button" onClick={() => navigate("/app/decisiones/caja")}>Abrir análisis de caja <ArrowRight size={16} /></button>
    </div>}

    <Modal title={mode === "entry" ? "Registrar movimiento real" : view === "overview" ? "Agendar un pago" : "Agregar partida proyectada"}
      description={mode === "plan" && view === "overview" ? "Queda como pago previsto en Planificación y aparece en Próximos pagos si es del escenario Base." : "Indicá la cuenta, la categoría y una referencia que permita revisar el importe."}
      open={mode !== null} onClose={() => setMode(null)}>
      <Form onCancel={() => setMode(null)} onSubmit={save}>
        <div className="form-grid"><Field label="Fecha"><input name="date" type="date" defaultValue={mode === "entry" ? today : offsetDate(today, 7)} required /></Field><Field label="Cuenta"><select name="account"><option value="cash">Efectivo</option><option value="bank">Banco</option></select></Field></div>
        {mode === "plan" && <Field label="Escenario"><select name="scenario" defaultValue={scenario}>{scenarios.map((item) => <option key={item} value={item}>{scenarioNames[item]}</option>)}</select></Field>}
        <div className="form-grid"><Field label={mode === "entry" ? "Movimiento" : "Tipo de partida"}><select value={direction} onChange={(event) => changeDirection(event.target.value as "income" | "outflow")}><option value="outflow">{mode === "entry" ? "Salida" : "Pago previsto"}</option><option value="income">{mode === "entry" ? "Entrada" : "Cobro previsto"}</option></select></Field><Field label="Categoría"><select name="category" value={category} onChange={(event) => setCategory(event.target.value)}>{(direction === "income" ? incomeCategories : outflowCategories).filter((key) => mode === "entry" || key !== "opening_balance").map((key) => <option key={key} value={key}>{categories[key]}</option>)}</select></Field></div>
        <Field label="Importe en ARS" hint={`Escribí el importe positivo. Se registrará como ${direction === "income" ? "ingreso" : "egreso"}.`}><input name="amount" type="number" min="0.01" step="0.01" required /></Field>
        <Field label="Detalle / comprobante de referencia"><input name="description" maxLength={180} required /></Field>
      </Form>
    </Modal>
  </div>;
}
