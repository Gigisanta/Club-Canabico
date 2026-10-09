import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { apiGet, hasCapability, OperationsApiError } from "./api";
import { formatMinor } from "./money";
import type { FinancialReportCoverage as CoverageRow, FinancialReportCurrency, FinancialReportState, FinancialStatementsReport } from "../../shared/operations/financial-report";
import type { OperationsContext } from "./types";
import "./financial-statements.css";

type Currency = FinancialReportCurrency;
type ReportState = FinancialReportState;
type MinorAmount = string | null;
const reportTimeZone = "America/Argentina/Buenos_Aires";

interface ReadFailure {
  message: string;
  status: number | null;
  code?: string;
}

interface ReadResource<T> {
  path: string | null;
  version: number;
  data: T | null;
  loading: boolean;
  error: ReadFailure | null;
}

function useApiRead<T>(path: string | null) {
  const [resource, setResource] = useState<ReadResource<T>>({ path: null, version: -1, data: null, loading: false, error: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!path) {
      setResource({ path: null, version, data: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setResource({ path, version, data: null, loading: true, error: null });
    apiGet<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResource({ path, version, data, loading: false, error: null });
    }).catch(cause => {
      if (controller.signal.aborted) return;
      const failure: ReadFailure = cause instanceof OperationsApiError
        ? { message: cause.message, status: cause.status, code: cause.code }
        : { message: cause instanceof Error ? cause.message : "No se pudo cargar este informe.", status: null };
      setResource({ path, version, data: null, loading: false, error: failure });
    });
    return () => controller.abort();
  }, [path, version]);

  const current = resource.path === path && resource.version === version;
  return {
    data: current ? resource.data : null,
    loading: Boolean(path) && (!current || resource.loading),
    error: current ? resource.error : null,
    retry: () => setVersion(value => value + 1),
  };
}

function localDateParts() {
  const parts = new Intl.DateTimeFormat("en", { timeZone: reportTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const year = parts.find(part => part.type === "year")?.value ?? "0000";
  const month = parts.find(part => part.type === "month")?.value ?? "01";
  const day = parts.find(part => part.type === "day")?.value ?? "01";
  return { today: `${year}-${month}-${day}`, monthStart: `${year}-${month}-01` };
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function stateLabel(state: ReportState) {
  return state === "complete" ? "Completo" : state === "partial" ? "Parcial" : "Sin datos observados";
}

function stateClass(state: ReportState) {
  return state === "complete" ? "is-complete" : state === "partial" ? "is-partial" : "is-unavailable";
}

function coverageStateLabel(state: string) {
  if (state === "complete") return "Completa";
  if (state === "partial") return "Parcial";
  if (state === "unverified") return "Sin verificar";
  if (state === "excluded") return "Excluida";
  return "Desconocida";
}

function coverageSourceLabel(source: string) {
  const labels: Record<string, string> = {
    "delivered-products": "Productos netos entregados",
    "allocated-lot-costs": "Costo de lotes asignados",
    "delivery-surcharges": "Cargos y sobrecargos devengados",
    "approved-operating-obligations": "Obligaciones operativas aprobadas",
    "approved-fixed-costs": "Costos fijos aprobados",
    "approved-variable-and-fixed-operating-obligations": "Gastos variables y fijos devengados",
    "approved-fixed-cost-schedule": "Plan de costos fijos",
    "historical-delivery-sales": "Ventas históricas de delivery",
    "historical-and-compatibility-expenses": "Gastos históricos y del local",
    "source-period-attestation": "Revisión documental del período",
    "club-ledger": "Libro de caja y banco",
    "reconciled-opening": "Apertura conciliada",
    "reconciled-closing": "Cierre conciliado",
    "verified-obligations": "Obligaciones verificadas",
    "unverified-obligations": "Obligaciones por verificar",
  };
  return labels[source] ?? "Fuente por revisar";
}

function amountLabel(amount: MinorAmount, currency: Currency) {
  if (typeof amount !== "string" || !/^-?\d+$/.test(amount)) return "Pendiente";
  return formatMinor(amount, currency);
}

function lineAmountLabel(line: { amountMinor: string | null; observedMinor: string | null }, currency: Currency, observed = false) {
  return amountLabel(observed ? line.observedMinor : line.amountMinor, currency);
}

function methodLabel(method: string) {
  const labels: Record<string, string> = {
    "delivered-net-product-lines": "productos netos entregados",
    "actual-lot-cost": "costo real de lotes asignados",
    "approved-accrued-operating-costs": "costos operativos aprobados por devengamiento",
    "verified-variable-and-fixed-operating-payables-by-accrual-month": "gastos operativos fijos y variables verificados por mes de devengamiento",
    "recognized-delivery-and-surcharge": "entrega y recargos reconocidos",
    "exact-minor-units": "cálculo exacto en unidades menores",
    "club-ledger-events-by-kind": "movimientos del libro del club, separados por tipo",
    "inactive-historical-accounts-included": "incluye el historial de cuentas cerradas",
    "custody-excluded": "se excluyen fondos en custodia",
    "no-currency-conversion": "sin conversión entre monedas",
    "unknown-openings-and-closes-withheld": "se retienen aperturas y cierres desconocidos",
    "verified-and-unverified-open-payables-by-due-week": "obligaciones abiertas verificadas y pendientes por semana de vencimiento",
    "no-revenue-forecast": "sin pronóstico de ingresos",
    "no-closing-balance": "sin saldo de cierre",
  };
  return method.split(";").map(value => labels[value.trim()] ?? value.trim().replaceAll("-", " ")).join("; ");
}

function rowsForSection(report: FinancialStatementsReport, section: CoverageRow["section"]) {
  return report.coverage.filter(row => row.section === section);
}

function dateLabel(value: string) {
  if (!isIsoDate(value)) return "Fecha pendiente";
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString("es-AR", { timeZone: reportTimeZone, day: "numeric", month: "short", year: "numeric" });
}

const reasonLabels: Record<string, string> = {
  "period-is-not-a-closed-calendar-month-before-cutoff": "El resultado completo requiere un mes calendario cerrado anterior a la fecha de corte.",
  "month-accrual-not-allocatable-to-partial-range": "Los gastos tienen un mes de devengamiento; falta respaldo para repartirlos en este período parcial.",
  "source-period-attestation-required": "Falta revisar y aprobar la cobertura documental del período.",
  "source-period-completeness-not-attested": "La cobertura del período de origen no está conciliada documentalmente.",
  "source-coverage-incomplete": "La cobertura de la fuente está incompleta.",
  "amount-not-observed": "No hay un importe respaldado por registros para este período.",
  "revenue-or-cost-of-goods-sold-incomplete": "Falta completar las ventas o el costo histórico de lo vendido.",
  "required-income-statement-source-incomplete": "Falta completar una fuente necesaria para calcular el resultado.",
  "financial-source-coverage-incomplete": "Falta completar la cobertura de las fuentes financieras.",
  "delivered-product-or-historical-sales-coverage-incomplete": "Falta completar las entregas o revisar las ventas históricas.",
  "allocated-lot-cost-coverage-incomplete": "Falta respaldar el costo de los lotes vendidos.",
  "delivered-product-or-lot-cost-coverage-incomplete": "Falta completar las entregas y los costos de los lotes vendidos.",
  "delivery-and-surcharge-coverage-incomplete": "Falta revisar los cargos de entrega y los recargos.",
  "historical-expense-currency-or-coverage-not-certified": "Falta verificar la moneda y la cobertura de los gastos históricos.",
  "historical-sales-currency-unknown": "Las ventas históricas no tienen una moneda verificada.",
  "unverified-or-unclassified-operating-obligations": "Hay gastos operativos sin verificar o clasificar.",
  "unverified-or-unclassified-costs": "Hay costos sin verificar o clasificar.",
  "actual-operating-expense-coverage-incomplete": "Falta completar el respaldo de los gastos operativos reales.",
  "schedule-is-not-an-actual-expense": "Un costo planificado no acredita un gasto real del período.",
  "product-source-row-limit-or-query-incomplete": "La consulta no pudo abarcar todos los registros de productos.",
  "lot-allocation-or-currency-coverage-incomplete": "Falta verificar la asignación de lotes o sus monedas.",
  "cost-allocation-or-charge-coverage-pending": "Falta revisar costos asignados o cargos de las entregas.",
  "general-costs-withheld-by-member-scope": "El alcance del perfil no permite consultar los gastos generales.",
  "no-verified-club-account-for-currency": "No hay cuentas del club verificadas en esta moneda.",
  "opening-not-approved-before-period-or-ledger-inconsistent": "Falta una apertura anterior al período, aprobada y consistente con el libro.",
  "no-zero-variance-reconciliation-on-period-end": "Falta un cierre conciliado sin diferencias en la fecha final del período.",
  "ledger-leg-currency-mismatch": "Hay movimientos cuya moneda no coincide con la de su cuenta.",
  "unclassified-ledger-event-kind": "Hay movimientos de efectivo sin clasificar.",
  "opening-plus-net-movement-does-not-match-closing": "La apertura más los movimientos netos no coincide con el cierre.",
  "no-approved-payable-period-attestation": "Falta aprobar la cobertura de obligaciones del período.",
  "payable-population-or-period-attestation-incomplete": "Falta completar las obligaciones o revisar la cobertura del período.",
  "cash-opening-not-reconciled": "Falta una apertura de caja conciliada.",
  "opening-balance-not-reconciled": "Falta conciliar el saldo de apertura.",
  "incomplete-source-coverage": "La cobertura de fuentes está incompleta.",
  "unverified-obligations-exist": "Hay obligaciones informadas que todavía no están verificadas.",
  "no-current-approved-scenario": "No hay una configuración aprobada vigente.",
};

function reasonLabel(reason: string) {
  return reasonLabels[reason] ?? "Hay una verificación pendiente para esta fuente.";
}

function Reasons({ reasons }: { reasons: string[] }) {
  if (!reasons.length) return null;
  return <ul className="financial-report-reasons">{reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reasonLabel(reason)}</li>)}</ul>;
}

function Coverage({ state, reasons, rows }: { state: ReportState; reasons: string[]; rows: CoverageRow[] }) {
  return <div className="financial-report-coverage">
    <span className={`financial-report-state ${stateClass(state)}`}>{stateLabel(state)}</span>
    {(reasons.length > 0 || rows.length > 0) && <details><summary>Cobertura y pendientes</summary>
      {rows.length > 0 && <ul className="financial-report-coverage-list">{rows.map((row, index) => <li key={`${row.source}-${index}`}>
        <span><strong>{coverageSourceLabel(row.source)}</strong><small>{row.knownCount === null ? "Registros conocidos: sin dato" : `Registros conocidos: ${row.knownCount}`} · {row.expectedCount === null ? "esperados: no informados" : `esperados: ${row.expectedCount}`}{row.queryComplete === null ? "" : row.queryComplete ? " · consulta completa" : " · consulta incompleta"}</small></span>
        <span className={`financial-report-state is-${row.state}`}>{coverageStateLabel(row.state)}</span>
        {row.reason && <small className="financial-report-coverage-reason">{reasonLabel(row.reason)}</small>}
      </li>)}</ul>}
      <Reasons reasons={reasons} />
    </details>}
  </div>;
}

function MetricRows({ rows, currency }: { rows: Array<{ label: string; value: MinorAmount }>; currency: Currency }) {
  return <dl className="financial-report-metrics">{rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{amountLabel(row.value, currency)}</dd></div>)}</dl>;
}

function percentBasisPoints(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -100 || parsed > 300) return null;
  return Math.round(parsed * 100);
}

function scaleMinor(value: string, basisPoints: number) {
  const minor = BigInt(value);
  const numerator = minor * BigInt(10_000 + basisPoints);
  const divisor = 10_000n;
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  const rounded = absoluteRemainder * 2n >= divisor ? quotient + (numerator < 0n ? -1n : 1n) : quotient;
  return rounded.toString();
}

function addDays(value: string, days: number) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function periodLength(from: string, to: string) {
  const start = new Date(`${from}T00:00:00Z`).valueOf();
  const end = new Date(`${to}T00:00:00Z`).valueOf();
  return Math.round((end - start) / 86_400_000) + 1;
}

function StatementsProjection({ report }: { report: FinancialStatementsReport }) {
  const [salesChange, setSalesChange] = useState("0");
  const [costChange, setCostChange] = useState("0");
  const [expenseChange, setExpenseChange] = useState("0");
  const pnl = report.incomeStatement;
  const salesBps = percentBasisPoints(salesChange);
  const costBps = percentBasisPoints(costChange);
  const expenseBps = percentBasisPoints(expenseChange);
  const baseComplete = pnl.scenarioBaseComplete === true
    && typeof pnl.netSales.observedMinor === "string" && /^-?\d+$/.test(pnl.netSales.observedMinor)
    && typeof pnl.costOfGoodsSold.observedMinor === "string" && /^-?\d+$/.test(pnl.costOfGoodsSold.observedMinor)
    && typeof pnl.operatingExpenses.observedMinor === "string" && /^-?\d+$/.test(pnl.operatingExpenses.observedMinor)
    && typeof pnl.operatingResult.amountMinor === "string" && /^-?\d+$/.test(pnl.operatingResult.amountMinor);
  const forecast = useMemo(() => {
    if (!baseComplete || salesBps === null || costBps === null || expenseBps === null) return null;
    const baseSales = pnl.netSales.observedMinor!;
    const baseCosts = pnl.costOfGoodsSold.observedMinor!;
    const baseExpenses = pnl.operatingExpenses.observedMinor!;
    const projectedSales = scaleMinor(baseSales, salesBps);
    const projectedCosts = scaleMinor(baseCosts, costBps);
    const projectedExpenses = scaleMinor(baseExpenses, expenseBps);
    const result = BigInt(pnl.operatingResult.amountMinor!)
      + BigInt(projectedSales) - BigInt(baseSales)
      - BigInt(projectedCosts) + BigInt(baseCosts)
      - BigInt(projectedExpenses) + BigInt(baseExpenses);
    return { sales: projectedSales, costs: projectedCosts, expenses: projectedExpenses, result: result.toString() };
  }, [baseComplete, pnl, salesBps, costBps, expenseBps]);
  const projectionFrom = addDays(report.period.to, 1);
  const projectionTo = addDays(report.period.to, periodLength(report.period.from, report.period.to));

  return <section className="financial-report-card financial-result-scenario" aria-labelledby="financial-result-scenario-title">
    <div className="financial-report-card-head">
      <div><span className="financial-report-eyebrow">Supuestos editables</span><h3 id="financial-result-scenario-title">Escenario hipotético de resultados</h3></div>
      <span className="financial-report-state is-scenario">Escenario hipotético</span>
    </div>
    <p className="financial-report-copy">Toma el período observado y aplica cambios porcentuales a ventas, costo vendido y gastos. El siguiente período dura lo mismo: {dateLabel(projectionFrom)}–{dateLabel(projectionTo)}. No proyecta caja.</p>
    <div className="financial-scenario-inputs">
      <label><span>Variación de ventas (%)</span><input type="number" min="-100" max="300" step="0.1" value={salesChange} onChange={event => setSalesChange(event.target.value)} /></label>
      <label><span>Variación de costo vendido (%)</span><input type="number" min="-100" max="300" step="0.1" value={costChange} onChange={event => setCostChange(event.target.value)} /></label>
      <label><span>Variación de gastos (%)</span><input type="number" min="-100" max="300" step="0.1" value={expenseChange} onChange={event => setExpenseChange(event.target.value)} /></label>
    </div>
    {!baseComplete ? <p className="financial-report-pending" role="status">Resultado pendiente: {pnl.scenarioBaseReason ? reasonLabel(pnl.scenarioBaseReason) : "la base del período está incompleta o no tiene los subtotales necesarios."}</p>
      : forecast ? <MetricRows currency={report.currency} rows={[
        { label: "Ventas del escenario", value: forecast.sales },
        { label: "Costo vendido del escenario", value: forecast.costs },
        { label: "Gastos del escenario", value: forecast.expenses },
        { label: "Resultado operativo del escenario", value: forecast.result },
      ]} />
        : <p className="financial-report-pending" role="alert">Revisá los porcentajes: deben estar entre −100 % y 300 %.</p>}
    <p className="financial-report-method">Los otros ingresos operativos, si los hay, se mantienen como en la base. La cifra es sólo una simulación de estos supuestos.</p>
  </section>;
}

function FinancialReportScreen({ report, context }: { report: FinancialStatementsReport; context: OperationsContext }) {
  const pnl = report.incomeStatement;
  const cash = report.cashFlow;
  const obligations = report.obligations13Weeks;
  const pnlLines = [pnl.netSales, pnl.costOfGoodsSold, pnl.grossProfit, pnl.operatingExpenses, pnl.otherOperatingIncome, pnl.operatingResult];
  const noStatementAmounts = pnlLines.every(line => line.amountMinor === null && line.observedMinor === null);

  return <div className="financial-report-content">
    <section className="financial-report-card" aria-labelledby="financial-pnl-title">
      <div className="financial-report-card-head">
        <div><span className="financial-report-eyebrow">Estado de resultados · {dateLabel(report.period.from)}–{dateLabel(report.period.to)}</span><h3 id="financial-pnl-title">Resultado del período</h3></div>
        <Coverage state={pnl.state} reasons={pnl.reasons} rows={rowsForSection(report, "incomeStatement")} />
      </div>
      <p className="financial-report-method">Método: {methodLabel(report.methods.incomeStatement)} La columna observada conserva subtotales disponibles si el resultado completo sigue pendiente.</p>
      {noStatementAmounts && pnl.state === "unknown" ? <div className="financial-report-empty"><strong>Sin importes observados para este período.</strong><span>Probá otro rango o revisá la cobertura informada.</span></div> : <div className="financial-report-table-wrap">
        <table className="financial-report-table"><thead><tr><th scope="col">Concepto</th><th scope="col">Importe informado</th><th scope="col">Observado</th></tr></thead><tbody>
          <tr><th scope="row">Ventas netas</th><td>{lineAmountLabel(pnl.netSales, report.currency)}</td><td>{lineAmountLabel(pnl.netSales, report.currency, true)}</td></tr>
          <tr><th scope="row">Costo de bienes vendidos</th><td>{lineAmountLabel(pnl.costOfGoodsSold, report.currency)}</td><td>{lineAmountLabel(pnl.costOfGoodsSold, report.currency, true)}</td></tr>
          <tr><th scope="row">Resultado bruto</th><td>{lineAmountLabel(pnl.grossProfit, report.currency)}</td><td>{lineAmountLabel(pnl.grossProfit, report.currency, true)}</td></tr>
          <tr><th scope="row">Gastos operativos</th><td>{lineAmountLabel(pnl.operatingExpenses, report.currency)}</td><td>{lineAmountLabel(pnl.operatingExpenses, report.currency, true)}</td></tr>
          <tr><th scope="row">Otros ingresos operativos</th><td>{lineAmountLabel(pnl.otherOperatingIncome, report.currency)}</td><td>{lineAmountLabel(pnl.otherOperatingIncome, report.currency, true)}</td></tr>
          <tr className="financial-report-total"><th scope="row">Resultado operativo</th><td>{lineAmountLabel(pnl.operatingResult, report.currency)}</td><td>{lineAmountLabel(pnl.operatingResult, report.currency, true)}</td></tr>
        </tbody></table>
      </div>}
      <Reasons reasons={pnl.reasons} />
    </section>

    <section className="financial-report-card" aria-labelledby="financial-cash-title">
      <div className="financial-report-card-head">
        <div><span className="financial-report-eyebrow">Flujo de efectivo · {dateLabel(report.period.from)}–{dateLabel(report.period.to)}</span><h3 id="financial-cash-title">Movimientos de caja y banco</h3></div>
        <Coverage state={cash.state} reasons={cash.reasons} rows={rowsForSection(report, "cashFlow")} />
      </div>
      <p className="financial-report-method">Método: {methodLabel(report.methods.cashFlow)} {cash.openingConfirmed && cash.openingDate ? `Apertura confirmada al ${dateLabel(cash.openingDate)}.` : "La conciliación de apertura no está informada."}</p>
      <MetricRows currency={report.currency} rows={[
        { label: "Saldo de apertura", value: cash.openingConfirmed ? cash.openingBalanceMinor : null },
        { label: "Cobros", value: cash.collectionsMinor },
        { label: "Pagos", value: cash.paymentsMinor },
        { label: "Transferencias recibidas", value: cash.transferInMinor },
        { label: "Transferencias enviadas", value: cash.transferOutMinor },
        { label: "Financiación ingresada", value: cash.financingInMinor },
        { label: "Financiación pagada", value: cash.financingOutMinor },
        { label: "Ajustes por tipo de cambio recibidos", value: cash.fxInMinor },
        { label: "Ajustes por tipo de cambio enviados", value: cash.fxOutMinor },
        { label: "Entradas sin clasificar", value: cash.unclassifiedInMinor },
        { label: "Salidas sin clasificar", value: cash.unclassifiedOutMinor },
        { label: "Movimiento neto", value: cash.netMovementMinor },
        { label: "Saldo de cierre", value: cash.closingConfirmed ? cash.closingBalanceMinor : null },
      ]} />
      {(!cash.openingConfirmed || !cash.closingConfirmed) && <p className="financial-report-pending" role="note">Los saldos de apertura o cierre que no estén confirmados se muestran como pendientes.</p>}
      <Reasons reasons={cash.reasons} />
    </section>

    <section className="financial-report-card" aria-labelledby="financial-obligations-title">
      <div className="financial-report-card-head">
        <div><span className="financial-report-eyebrow">Horizonte · {dateLabel(obligations.horizon.from)}–{dateLabel(obligations.horizon.through)}</span><h3 id="financial-obligations-title">Obligaciones de las próximas 13 semanas</h3></div>
        <Coverage state={obligations.state} reasons={obligations.reasons} rows={rowsForSection(report, "obligations13Weeks")} />
      </div>
      <p className="financial-report-method">Método: {methodLabel(report.methods.obligations13Weeks)} El reporte no informa una apertura para este horizonte.</p>
      {obligations.weeks?.length ? <ol className="financial-obligation-weeks">{obligations.weeks.map((week, index) => <li key={`${week.weekStart}-${index}`}>
        <div className="financial-obligation-week-head"><strong>Semana {String(index + 1).padStart(2, "0")}</strong><span>{dateLabel(week.weekStart)}–{dateLabel(week.weekEnd)}</span></div>
        <dl><div><dt>Vencimientos verificados · {week.verifiedCount}</dt><dd>{amountLabel(week.verifiedObligationsMinor, report.currency)}</dd></div>
          <div><dt>Vencimientos pendientes de verificar · {week.unverifiedCount}</dt><dd>{amountLabel(week.unverifiedObligationsMinor, report.currency)}</dd></div></dl>
      </li>)}</ol> : <div className="financial-report-empty"><strong>Sin semanas informadas.</strong><span>El servidor no devolvió detalle para este horizonte.</span></div>}
      <Reasons reasons={obligations.reasons} />
    </section>

    {report.incomeStatement.state !== "complete" || report.cashFlow.state !== "complete" || report.obligations13Weeks.state !== "complete" || report.coverage.some(row => row.state === "partial" || row.state === "unverified" || row.state === "unknown") ? <section className="financial-report-gap" aria-label="Revisar fuentes faltantes">
      <div><strong>Hay fuentes o partes del período pendientes.</strong><p>Revisá los datos disponibles según los permisos de tu perfil; el informe conserva sus límites hasta completar la cobertura.</p></div>
      <nav className="financial-report-empty-actions" aria-label="Ir a las fuentes disponibles">
        {hasCapability(context, "finance.read") && <Link to="/app/operations?section=accounts">Cuentas y saldos</Link>}
        {(hasCapability(context, "imports.review") || hasCapability(context, "imports.write")) && <Link to="/app/operations?section=imports">Importación legado</Link>}
        {hasCapability(context, "reports.read") && <Link to="/app/operations?section=reports">Informes operativos</Link>}
      </nav>
    </section> : null}
    <StatementsProjection report={report} />
  </div>;
}

export function FinancialStatements() {
  const [searchParams, setSearchParams] = useSearchParams();
  const defaults = localDateParts();
  const from = searchParams.get("from") ?? defaults.monthStart;
  const to = searchParams.get("to") ?? defaults.today;
  const currencyParam = searchParams.get("currency");
  const currency: Currency = currencyParam === "USD" ? "USD" : "ARS";
  const [fromDraft, setFromDraft] = useState(from);
  const [toDraft, setToDraft] = useState(to);
  const [currencyDraft, setCurrencyDraft] = useState<Currency>(currency);
  const [rangeError, setRangeError] = useState("");
  const validRange = isIsoDate(from) && isIsoDate(to) && from <= to;
  const query = new URLSearchParams({ from, to, currency });
  const queryString = query.toString();
  const context = useApiRead<OperationsContext>("/api/operations/context");
  const canRead = context.data !== null && hasCapability(context.data, "finance.read") && hasCapability(context.data, "reports.read");
  const reportPath = canRead && validRange ? `/api/reports/operations/financial-statements?${queryString}` : null;
  const report = useApiRead<FinancialStatementsReport>(reportPath);

  useEffect(() => {
    setFromDraft(from);
    setToDraft(to);
    setCurrencyDraft(currency);
    setRangeError("");
  }, [from, to, currency]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isIsoDate(fromDraft) || !isIsoDate(toDraft) || fromDraft > toDraft) {
      setRangeError("Elegí un rango válido: la fecha inicial debe ser anterior o igual a la final.");
      return;
    }
    setRangeError("");
    const next = new URLSearchParams(searchParams);
    next.set("from", fromDraft);
    next.set("to", toDraft);
    next.set("currency", currencyDraft);
    setSearchParams(next);
  }

  const contextForbidden = context.error?.status === 403 || context.error?.code === "CAPABILITY_REQUIRED";
  const reportForbidden = report.error?.status === 403 || report.error?.code === "CAPABILITY_REQUIRED";
  const forbidden = contextForbidden || (context.data !== null && !canRead) || reportForbidden;
  const loading = context.loading || (canRead && validRange && report.loading);

  return <section className="financial-statements" aria-labelledby="financial-statements-title">
    <div className="financial-statements-head">
      <div><span className="financial-report-eyebrow">Informes canónicos · Operaciones</span><h2 id="financial-statements-title">Resultado, efectivo y obligaciones</h2><p>Reportes por período y moneda, con cobertura visible. Los datos pendientes permanecen pendientes.</p></div>
      <button type="button" className="financial-report-print" onClick={() => window.print()} disabled={!report.data}>Imprimir / Guardar PDF</button>
    </div>
    <form className="financial-report-filters" onSubmit={applyFilters}>
      <label><span>Desde</span><input type="date" value={fromDraft} max={toDraft || undefined} onChange={event => setFromDraft(event.target.value)} aria-invalid={Boolean(rangeError)} /></label>
      <label><span>Hasta</span><input type="date" value={toDraft} min={fromDraft || undefined} onChange={event => setToDraft(event.target.value)} aria-invalid={Boolean(rangeError)} /></label>
      <label><span>Moneda</span><select value={currencyDraft} onChange={event => setCurrencyDraft(event.target.value as Currency)}><option value="ARS">ARS</option><option value="USD">USD</option></select></label>
      <button type="submit" className="financial-report-update">Actualizar</button>
    </form>
    {rangeError && <p className="financial-report-inline-error" role="alert">{rangeError}</p>}
    {!validRange && !rangeError && <p className="financial-report-inline-error" role="alert">El período guardado en el enlace no es válido. Corregilo y actualizá.</p>}
    {context.error && !contextForbidden && <div className="financial-report-error" role="alert"><p>{context.error.message}</p><button type="button" onClick={context.retry}>Reintentar</button></div>}
    {forbidden && <div className="financial-report-blocked" role="status"><strong>Acceso financiero no disponible</strong><p>El perfil actual necesita los permisos de lectura financiera y de informes. El servidor mantiene la autorización vigente.</p></div>}
    {loading && !forbidden && <p className="financial-report-loading" role="status">Cargando informes del período…</p>}
    {report.error && !reportForbidden && <div className="financial-report-error" role="alert"><p>{report.error.message}</p><button type="button" onClick={report.retry}>Reintentar</button></div>}
    {report.data && !report.error && <>
      <p className="financial-report-period-note">Período consultado: {dateLabel(report.data.period.from)}–{dateLabel(report.data.period.to)} · corte {dateLabel(report.data.period.cutoffDate)} · moneda {report.data.currency}.</p>
      <FinancialReportScreen report={report.data} context={context.data!} />
    </>}
  </section>;
}
