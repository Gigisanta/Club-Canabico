import { useState } from "react";
import { toast } from "sonner";
import { Wallet, Package, ChartBar } from "@phosphor-icons/react";
import { useClub, send, offsetDate, shortDate, number } from "./lib";
import { PageHeader, Panel, Modal, Form, Field, Metric } from "./ui";

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
  const [mode, setMode] = useState<"entry" | "plan" | null>(null);
  const [entryKey, setEntryKey] = useState(() => crypto.randomUUID());
  const [scenario, setScenario] = useState<(typeof scenarios)[number]>("base");
  const today = state.today;
  const cash = state.financeBalance;
  const stock = state.products.reduce((n, p) => n + Math.round(p.stock * p.cost / 1000), 0);
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
    <PageHeader eyebrow="BASE FINANCIERA" title="Caja y planificación" description="Movimientos reales y escenarios cargados por el equipo. Las cifras quedan pendientes de conciliación con AppSheet, Sheets y comprobantes." actions={<>
      <button className="button" onClick={() => setMode("plan")}>Agregar proyección</button>
      <button className="button primary" onClick={() => { setEntryKey(crypto.randomUUID()); setMode("entry"); }}>Registrar movimiento</button>
    </>} />
    <div className="metrics-grid three">
      <Metric title="Saldo registrado" value={money(cash)} icon={<Wallet />} detail="Caja y banco · requiere saldo inicial conciliado" />
      <Metric title="Stock a costo" value={money(stock)} icon={<Package />} detail="Lotes actuales · costo cargado" />
      <Metric title="Resultado local preliminar" value={money(revenue - cogs - expenses)} icon={<ChartBar />} detail="Solo ventas en app − costo vendido − gastos registrados · sin validar" />
    </div>
    <Panel title="Valuación por lote y proveedor" sub="Cantidad actual por costo unitario cargado. Conciliá proveedor, factura y conteo físico antes de usar el total como capital confirmado.">
      <div className="table-scroll"><table><thead><tr><th>Lote</th><th>Proveedor</th><th>Producto</th><th className="numeric">Cantidad</th><th className="numeric">Costo unitario</th><th className="numeric">Valor a costo</th></tr></thead><tbody>{state.products.map((p) => <tr key={p.id}><td>{p.lot}</td><td>{p.supplier || "Sin proveedor"}</td><td>{p.name}</td><td className="numeric">{number(p.stock / 1000)} {p.unit}</td><td className="numeric">{money(p.cost)}</td><td className="numeric amount">{money(Math.round(p.stock * p.cost / 1000))}</td></tr>)}</tbody></table></div>
    </Panel>
    <Panel title="Flujo de caja proyectado · 13 semanas" sub="Saldo real registrado más cobros y pagos planificados. Cargá todos los compromisos antes de usarlo para decidir.">
      <label>Escenario <select value={scenario} onChange={(e) => setScenario(e.target.value as typeof scenario)}>{scenarios.map((s) => <option key={s} value={s}>{scenarioNames[s]}</option>)}</select></label>
      <div className="table-scroll"><table><thead><tr><th>Semana</th><th className="numeric">Movimiento previsto</th><th className="numeric">Saldo proyectado</th><th className="numeric">Partidas</th></tr></thead><tbody>{weeks.map((w) => <tr key={w.from}><td>{shortDate(w.from)} – {shortDate(w.to)}</td><td className="numeric">{money(w.change)}</td><td className="numeric amount">{money(w.balance)}</td><td className="numeric">{w.count}</td></tr>)}</tbody></table></div>
    </Panel>
    <Panel title="Plan mensual 2027" sub="Ingresos y egresos previstos del escenario elegido; el costo de personal debe cargarse como partida explícita.">
      <div className="table-scroll"><table><thead><tr><th>Mes</th><th className="numeric">Ingresos</th><th className="numeric">Egresos</th><th className="numeric">Neto</th></tr></thead><tbody>{annual.map((m) => <tr key={m.period}><td>{m.period}</td><td className="numeric">{money(m.income)}</td><td className="numeric">{money(m.outflow)}</td><td className="numeric amount">{money(m.income - m.outflow)}</td></tr>)}</tbody></table></div>
    </Panel>
    <Panel title="Partidas planificadas" sub="Detalle del escenario elegido. Conservá los supuestos y acuerdos de cada revisión mensual.">
      <div className="table-scroll"><table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Categoría</th><th>Detalle</th><th className="numeric">Importe</th></tr></thead><tbody>{state.cashPlans.filter((p) => p.scenario === scenario).map((p) => <tr key={p.id}><td>{shortDate(p.date)}</td><td>{p.account === "cash" ? "Efectivo" : "Banco"}</td><td>{categories[p.category] || p.category}</td><td>{p.description}</td><td className="numeric amount">{money(p.amount)}</td></tr>)}</tbody></table></div>
    </Panel>
    <Panel title="Movimientos reales" sub="Últimos 2.000 movimientos. Las ventas locales se registran automáticamente. Los gastos cargados en el módulo Gastos no descuentan caja hasta registrar su pago aquí.">
      <div className="table-scroll"><table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Categoría</th><th>Detalle</th><th>Origen</th><th className="numeric">Importe</th></tr></thead><tbody>{state.cashEntries.map((e) => <tr key={e.id}><td>{shortDate(e.date)}</td><td>{e.account === "cash" ? "Efectivo" : "Banco"}</td><td>{categories[e.category] || e.category}</td><td>{e.description}</td><td>{e.sourceSystem && e.sourceId ? `${e.sourceSystem} · ${e.sourceId}` : "App local"}</td><td className="numeric amount">{money(e.amount)}</td></tr>)}</tbody></table></div>
    </Panel>
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
