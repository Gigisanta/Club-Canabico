import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Wallet, Package, ChartBar, ArrowRight } from "@phosphor-icons/react";
import { useClub, send, offsetDate, shortDate, number } from "./lib";
import { PageHeader, Panel, Modal, Form, Field, Metric, Empty } from "./ui";

const categories: Record<string, string> = {
  opening_balance: "Saldo inicial",
  sale: "Ingreso local",
  operating_expense: "Gasto operativo",
  stock_purchase: "Compra de stock",
  local_investment: "Inversión en local",
  capital_contribution: "Aporte de capital",
  owner_draw: "Retiro personal",
  delivery_receipt: "Cobro delivery (AppSheet)",
  other_income: "Otro ingreso",
  other_outflow: "Otro egreso",
  adjustment: "Ajuste documentado",
};
const scenarios = ["base", "cautious", "growth"] as const;
const scenarioNames = { base: "Base", cautious: "Prudente", growth: "Crecimiento" };

export default function Finance() {
  const { state, money, reload } = useClub();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"entry" | "plan" | null>(null);
  const [entryKey, setEntryKey] = useState(() => crypto.randomUUID());
  const [scenario, setScenario] = useState<(typeof scenarios)[number]>("base");
  const [view, setView] = useState<"overview" | "forecast" | "activity">("overview");
  const today = state.today;
  const cash = state.financeBalance;
  const stock = state.products.reduce((n, p) => n + Math.round(p.stock * p.cost / 1000), 0);
  const withoutSupplier = state.products.filter((p) => !p.supplier).length;
  const currentPlans = state.cashPlans.filter((p) => p.scenario === scenario);
  const month = today.slice(0, 7);
  const monthSales = state.sales.filter((s) => s.date.startsWith(month));
  const revenue = monthSales.reduce((n, s) => n + s.total, 0);
  const cogs = monthSales.reduce((n, s) => n + s.cost, 0);
  const expenses = state.expenses.filter((e) => e.date.startsWith(month)).reduce((n, e) => n + e.amount, 0);
  let running = cash;
  const weeks = Array.from({ length: 13 }, (_, i) => {
    const from = offsetDate(today, i * 7 + 1);
    const to = offsetDate(today, (i + 1) * 7);
    const plans = state.cashPlans.filter((p) => p.scenario === scenario && p.date >= from && p.date <= to);
    const change = plans.reduce((n, p) => n + p.amount, 0);
    running += change;
    return { from, to, change, balance: running, count: plans.length };
  });
  const annual = Array.from({ length: 12 }, (_, i) => {
    const period = `2027-${String(i + 1).padStart(2, "0")}`;
    const plans = state.cashPlans.filter((p) => p.scenario === scenario && p.date.startsWith(period));
    return { period, income: plans.filter((p) => p.amount > 0).reduce((n, p) => n + p.amount, 0), outflow: plans.filter((p) => p.amount < 0).reduce((n, p) => n - p.amount, 0) };
  });
  async function save(fd: FormData) {
    const values = Object.fromEntries(fd);
    const raw = Math.round(Number(fd.get("amount")) * 100);
    if (!Number.isSafeInteger(raw) || raw === 0) throw new Error("Importe inválido");
    await send(mode === "entry" ? "/cash-entries" : "/cash-plans", {
      ...values,
      amount: raw,
      ...(mode === "entry" ? { sourceSystem: "local", sourceId: entryKey } : {}),
    });
    toast.success(mode === "entry" ? "Movimiento registrado" : "Proyección registrada");
    setMode(null);
    await reload();
  }
  return <>
    <PageHeader eyebrow="BASE FINANCIERA · EN CONCILIACIÓN" title="Caja y planificación" description="Seguí el dinero real, el capital en stock y los compromisos que vienen. Validá cada cifra contra AppSheet, Sheets y comprobantes." actions={<>
      <button className="button" onClick={() => setMode("plan")}>Agregar proyección</button>
      <button className="button primary" onClick={() => { setEntryKey(crypto.randomUUID()); setMode("entry"); }}>Registrar movimiento</button>
    </>} />
    <div className="metrics-grid three">
      <Metric title="Saldo registrado" value={money(cash)} icon={<Wallet />} detail="Caja y banco · falta conciliar saldo inicial" />
      <Metric title="Stock a costo" value={money(stock)} icon={<Package />} detail={`${state.products.length} lotes con costo cargado`} />
      <Metric title="Resultado local preliminar" value={money(revenue - cogs - expenses)} icon={<ChartBar />} detail="Ventas en app − costo vendido − gastos" />
    </div>
    <div className="finance-nav" role="group" aria-label="Vistas de caja y planificación">
      <button className={view === "overview" ? "active" : ""} aria-pressed={view === "overview"} onClick={() => setView("overview")}>Panorama</button>
      <button className={view === "forecast" ? "active" : ""} aria-pressed={view === "forecast"} onClick={() => setView("forecast")}>Proyección</button>
      <button className={view === "activity" ? "active" : ""} aria-pressed={view === "activity"} onClick={() => setView("activity")}>Movimientos reales</button>
    </div>
    {view === "overview" && <div className="finance-section">
      <div className="finance-callout">
        <span className="finance-callout-index">01 / CONCILIACIÓN</span>
        <div><strong>{withoutSupplier ? `${withoutSupplier} ${withoutSupplier === 1 ? "lote sin proveedor" : "lotes sin proveedor"}` : "Proveedores cargados"}</strong><p>El valor a costo es preliminar hasta cotejar proveedor, factura y conteo físico de cada lote.</p></div>
        <button onClick={() => navigate("/inventario")}>Revisar inventario <ArrowRight size={16} /></button>
      </div>
    <Panel title="Capital en inventario" sub="Valuación por lote y proveedor · cantidad actual por costo unitario cargado.">
      <div className="table-scroll"><table><thead><tr><th>Lote</th><th>Proveedor</th><th>Producto</th><th className="numeric">Cantidad</th><th className="numeric">Costo unitario</th><th className="numeric">Valor a costo</th></tr></thead><tbody>{state.products.map((p) => <tr key={p.id}><td className="table-code">{p.lot}</td><td>{p.supplier || <span className="missing-value">Sin proveedor</span>}</td><td className="table-name">{p.name}</td><td className="numeric">{number(p.stock / 1000)} {p.unit}</td><td className="numeric">{money(p.cost)}</td><td className="numeric amount">{money(Math.round(p.stock * p.cost / 1000))}</td></tr>)}</tbody></table></div>
      {!state.products.length && <Empty title="Todavía no hay lotes" description="Cargá lotes para ver el capital en stock." />}
    </Panel>
    </div>}
    {view === "forecast" && <div className="finance-section">
    <div className="forecast-bar">
      <div><span>ESCENARIO ACTIVO</span><select aria-label="Escenario de planificación" value={scenario} onChange={(e) => setScenario(e.target.value as typeof scenario)}>{scenarios.map((s) => <option key={s} value={s}>{scenarioNames[s]}</option>)}</select></div>
      <div><span>HOY · REGISTRADO</span><strong>{money(cash)}</strong></div>
      <ArrowRight size={19} aria-hidden="true" />
      <div><span>EN 13 SEMANAS · PROYECTADO</span><strong>{money(weeks.at(-1)?.balance || 0)}</strong></div>
    </div>
    {!currentPlans.length && <div className="forecast-empty"><div><strong>Este escenario todavía no tiene partidas.</strong><p>Agregá cobros, pagos y compromisos para que la proyección sirva para decidir.</p></div><button className="button" onClick={() => setMode("plan")}>Agregar primera partida <ArrowRight size={16} /></button></div>}
    <Panel title="Flujo de caja proyectado · 13 semanas" sub="Saldo real registrado más cobros y pagos planificados. Cargá todos los compromisos antes de usarlo para decidir.">
      <div className="table-scroll"><table><thead><tr><th>Semana</th><th className="numeric">Movimiento previsto</th><th className="numeric">Saldo proyectado</th><th className="numeric">Partidas</th></tr></thead><tbody>{weeks.map((w, i) => <tr key={w.from}><td className="table-name"><span className="week-index">{String(i + 1).padStart(2, "0")}</span>{shortDate(w.from)} – {shortDate(w.to)}</td><td className="numeric">{money(w.change)}</td><td className="numeric amount">{money(w.balance)}</td><td className="numeric">{w.count}</td></tr>)}</tbody></table></div>
    </Panel>
    <Panel title="Plan mensual 2027" sub="Ingresos y egresos previstos del escenario elegido; el costo de personal debe cargarse como partida explícita.">
      <div className="table-scroll"><table><thead><tr><th>Mes</th><th className="numeric">Ingresos</th><th className="numeric">Egresos</th><th className="numeric">Neto</th></tr></thead><tbody>{annual.map((m) => <tr key={m.period}><td className="table-name">{new Date(`${m.period}-01T12:00:00`).toLocaleDateString("es-AR", { month: "long", year: "numeric" })}</td><td className="numeric">{money(m.income)}</td><td className="numeric">{money(m.outflow)}</td><td className="numeric amount">{money(m.income - m.outflow)}</td></tr>)}</tbody><tfoot><tr><th>Total 2027</th><th className="numeric">{money(annual.reduce((n, m) => n + m.income, 0))}</th><th className="numeric">{money(annual.reduce((n, m) => n + m.outflow, 0))}</th><th className="numeric">{money(annual.reduce((n, m) => n + m.income - m.outflow, 0))}</th></tr></tfoot></table></div>
    </Panel>
    <Panel title="Partidas planificadas" sub="Detalle del escenario elegido. Conservá los supuestos y acuerdos de cada revisión mensual.">
      <div className="table-scroll"><table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Categoría</th><th>Detalle</th><th className="numeric">Importe</th></tr></thead><tbody>{currentPlans.map((p) => <tr key={p.id}><td>{shortDate(p.date)}</td><td>{p.account === "cash" ? "Efectivo" : "Banco"}</td><td>{categories[p.category] || p.category}</td><td className="table-name">{p.description}</td><td className="numeric amount">{money(p.amount)}</td></tr>)}</tbody></table></div>
      {!currentPlans.length && <Empty title="Sin partidas para este escenario" description="La lista se completará al agregar compromisos." />}
    </Panel>
    </div>}
    {view === "activity" && <div className="finance-section">
    <div className="finance-callout activity"><span className="finance-callout-index">03 / REGISTRO</span><div><strong>Movimientos reales</strong><p>Las ventas locales entran automáticamente. Un gasto cargado en Gastos se refleja en caja cuando registrás su pago acá.</p></div><button onClick={() => { setEntryKey(crypto.randomUUID()); setMode("entry"); }}>Nuevo movimiento <ArrowRight size={16} /></button></div>
    <Panel title="Movimientos reales" sub="Últimos 2.000 movimientos. Las ventas locales se registran automáticamente. Los gastos cargados en el módulo Gastos no descuentan caja hasta registrar su pago aquí.">
      <div className="table-scroll"><table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Categoría</th><th>Detalle</th><th>Origen</th><th className="numeric">Importe</th></tr></thead><tbody>{state.cashEntries.map((e) => <tr key={e.id}><td>{shortDate(e.date)}</td><td>{e.account === "cash" ? "Efectivo" : "Banco"}</td><td>{categories[e.category] || e.category}</td><td className="table-name">{e.description}</td><td><span className="source-id" title={e.sourceSystem && e.sourceId ? `${e.sourceSystem} · ${e.sourceId}` : "App local"}>{e.sourceSystem && e.sourceId ? `${e.sourceSystem} · ${e.sourceId}` : "App local"}</span></td><td className="numeric amount">{money(e.amount)}</td></tr>)}</tbody></table></div>
      {!state.cashEntries.length && <Empty title="Todavía no hay movimientos" description="Registrá un saldo inicial conciliado o el primer movimiento real." />}
    </Panel>
    </div>}
    <Modal title={mode === "entry" ? "Registrar movimiento real" : "Agregar partida proyectada"} open={mode !== null} onClose={() => setMode(null)}>
      <Form onCancel={() => setMode(null)} onSubmit={save}>
        <div className="form-grid"><Field label="Fecha"><input name="date" type="date" defaultValue={mode === "entry" ? today : offsetDate(today, 7)} required /></Field><Field label="Cuenta"><select name="account"><option value="cash">Efectivo</option><option value="bank">Banco</option></select></Field></div>
        {mode === "plan" && <Field label="Escenario"><select name="scenario" defaultValue={scenario}>{scenarios.map((s) => <option key={s} value={s}>{scenarioNames[s]}</option>)}</select></Field>}
        <Field label="Categoría"><select name="category">{Object.entries(categories).filter(([k]) => k !== "sale").map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select></Field>
        <Field label="Importe en ARS (negativo si sale dinero)"><input name="amount" type="number" step="0.01" required /></Field>
        <Field label="Detalle / comprobante de referencia"><input name="description" maxLength={180} required /></Field>
      </Form>
    </Modal>
  </>;
}
