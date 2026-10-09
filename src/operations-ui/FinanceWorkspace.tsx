import { useSearchParams, Link } from "react-router-dom";
import { z } from "zod";
import { FinancialStatements } from "./FinancialStatements";
import { hasCapability } from "./api";
import { DataTable, EmptyState, ErrorState, InfoBand, LoadingState, SectionHeading, StatusTag } from "./Primitives";
import { useRemote } from "./useRemote";
import { formatMinor } from "./money";
import type { WorkspaceProps } from "./WorkspaceProps";
import "./finance-workspace.css";

const civilDate = z.string().refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, "fecha civil inválida");
const safeCount = z.number().int().nonnegative().refine(Number.isSafeInteger, "cantidad fuera de rango");
const minor = z.string().regex(/^-?(0|[1-9]\d*)$/);
const nullableMinor = minor.nullable();
const currency = z.enum(["ARS", "USD"]);
const coverageState = z.enum(["complete", "partial", "unverified", "unknown", "excluded"]);
const moneyByCurrency = z.object({ currency, minor });

const obligationWeek = z.object({
  week: z.number().int().min(1).max(13),
  weekStart: civilDate,
  weekEnd: civilDate,
  obligationCount: safeCount,
  verifiedCount: safeCount,
  unverifiedCount: safeCount,
  outstandingByCurrency: z.array(moneyByCurrency),
  verifiedOutstandingByCurrency: z.array(moneyByCurrency),
});

const scenarioWeek = z.object({
  week: z.number().int().min(1).max(13),
  weekStart: civilDate,
  weekEnd: civilDate,
  itemCount: safeCount,
  inflowMinor: minor,
  outflowMinor: minor,
  netFlowMinor: minor,
  openPayableMinor: minor,
  verifiedOpenPayableMinor: minor,
  unverifiedOpenPayableMinor: minor,
  netFlowAfterVerifiedOpenPayablesMinor: minor,
  netFlowAfterAllOpenPayablesMinor: minor,
});

const scenarioProjection = z.object({
  configurationId: z.string().min(1),
  name: z.string(),
  version: safeCount,
  validFrom: civilDate,
  validUntil: civilDate.nullable(),
  approvedAt: z.string().datetime().nullable(),
  currency,
  state: z.enum(["partial", "unverified"]),
  inputItemCount: safeCount,
  includedItemCount: safeCount,
  outsideHorizonCount: safeCount,
  duplicateCommitmentCount: safeCount,
  conflictingCommitmentCount: safeCount,
  matchedExistingObligationCount: safeCount,
  unmatchedCommitmentCount: safeCount,
  invalidItemCount: safeCount,
  openingBalanceMinor: nullableMinor,
  closingBalanceMinor: nullableMinor,
  balanceState: z.string(),
  weeks: z.array(scenarioWeek).length(13),
});

const accountEvidence = z.object({
  accountId: z.string().min(1),
  currency,
  kind: z.string(),
  verified: z.boolean(),
  openingApproved: z.boolean(),
  observedPreHorizonLedgerMinor: nullableMinor,
  countedBalanceMinor: nullableMinor,
  reconciledThrough: civilDate.nullable(),
});

const custodyEvidence = accountEvidence.extend({
  custodianId: z.string().nullable(),
  excludedFromClubSpendableCash: z.literal(true),
});

const coverageRow = z.object({
  source: z.string(),
  knownCount: safeCount.nullable(),
  expectedCount: safeCount.nullable(),
  queryComplete: z.boolean().nullable(),
  state: coverageState,
  reason: z.string(),
});

const reportResponse = z.object({
  summary: z.object({
    area: z.literal("obligations-13-weeks"),
    range: z.object({ from: civilDate.nullable(), to: civilDate.nullable(), timeZone: z.string(), inclusive: z.literal(true) }),
    metrics: z.object({
      horizon: z.object({ from: civilDate, through: civilDate, weeks: z.literal(13) }),
      sourceCoverage: z.enum(["complete", "partial", "unknown"]),
      attestation: z.union([
        z.object({ present: z.literal(false) }),
        z.object({ present: z.literal(true), sourceReference: z.string(), fromDate: civilDate, throughDate: civilDate, confirmedAt: z.string().datetime() }),
      ]),
      weekly: z.array(obligationWeek).length(13).nullable(),
      payableSummaryComplete: z.boolean(),
      invalidPayableDateCount: safeCount,
      invalidPayableCurrencyCount: safeCount,
      invalidPayableAmountCount: safeCount,
      payableRowsComplete: z.boolean(),
      visiblePayableRows: safeCount,
      payableDetailLimit: safeCount,
      activeAccountRowsComplete: z.boolean(),
      visibleActiveAccountRows: safeCount,
      scenarioProjections: z.array(scenarioProjection),
      scenarioConfigurationCoverage: z.object({
        source: z.string(),
        state: coverageState,
        approvedVersionCount: safeCount.nullable(),
        loadedApprovedVersionCount: safeCount,
        selectedScenarioCount: safeCount.nullable(),
        validScenarioCount: safeCount.nullable(),
        invalidConfigurationCount: safeCount.nullable(),
        malformedScenarioItemCount: safeCount.nullable(),
        reason: z.string(),
      }),
      scenarioCombinationPolicy: z.literal("each-approved-scenario-is-an-alternative; no-scenario-balances-are-added-together"),
      cashPathState: z.string(),
      clubAccounts: z.array(accountEvidence),
      custodyAccounts: z.array(custodyEvidence),
      currenciesCombined: z.literal(false),
    }),
    coverage: z.array(coverageRow),
    evidenceState: z.enum(["unknown", "partial", "unverified"]),
    currenciesCombined: z.literal(false),
  }),
});

type ProjectionReport = z.infer<typeof reportResponse>["summary"];
type ProjectionMetrics = ProjectionReport["metrics"];
type Scenario = ProjectionMetrics["scenarioProjections"][number];
type Currency = "ARS" | "USD";

const reportTimeZone = "America/Argentina/Buenos_Aires";

function todayInReportTimeZone() {
  const parts = new Intl.DateTimeFormat("en", { timeZone: reportTimeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const year = parts.find(part => part.type === "year")?.value ?? "0000";
  const month = parts.find(part => part.type === "month")?.value ?? "01";
  const day = parts.find(part => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function dateLabel(value: string) {
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString("es-AR", { timeZone: reportTimeZone, day: "numeric", month: "short", year: "numeric" });
}

function stateLabel(state: string) {
  if (state === "complete") return "Completa";
  if (state === "partial") return "Parcial";
  if (state === "unverified") return "Sin verificar";
  if (state === "excluded") return "Excluida";
  return "Sin datos observados";
}

function stateTone(state: string): "good" | "warn" | "neutral" {
  if (state === "complete") return "good";
  if (state === "partial" || state === "excluded") return "warn";
  return "neutral";
}

function readableReason(reason: string) {
  const known: Record<string, string> = {
    "no-current-approved-scenario-configuration": "No hay una configuración aprobada vigente para este horizonte.",
    "invalid-or-incomplete-payable-population; scenario-cash-values-not-calculated": "Hay obligaciones inválidas o incompletas; los flujos de los escenarios no se calcularon.",
    "approved-scenario-inputs-do-not-attest-source-completeness": "Los supuestos aprobados no certifican que todas las fuentes estén completas.",
    "invalid-approved-scenario-configuration": "Hay configuraciones aprobadas o supuestos con datos inválidos.",
    "approved-scenario-configuration-limit-reached": "El servidor alcanzó el límite de configuraciones aprobadas que puede consultar.",
  };
  return known[reason] ?? reason.replaceAll(/[-_]/g, " ");
}

function reportError(path: string | null, response: unknown, loading: boolean, error: string, retry: () => void) {
  if (!path) return <InfoBand tone="warning" title="Elegí una fecha válida para consultar las 13 semanas"><p>La fecha de referencia debe ser anterior o igual a hoy y usa la zona horaria de Bombo.</p></InfoBand>;
  if (loading && !response) return <LoadingState label="Cargando obligaciones y escenarios vigentes…" />;
  if (error) return <ErrorState message={error} retry={retry} />;
  if (!response) return <LoadingState label="Esperando el informe del servidor…" />;
  return null;
}

function amountLabel(value: string | null, curr: Currency) {
  return value === null ? "Pendiente" : formatMinor(value, curr);
}

function currencyValue(rows: Array<{ currency: Currency; minor: string }>, curr: Currency, coverageComplete: boolean) {
  const row = rows.find(item => item.currency === curr);
  if (row) return amountLabel(row.minor, curr);
  return coverageComplete ? formatMinor("0", curr) : "Sin registros confirmados";
}

function SectionLink({ section, label, searchParams }: { section: string; label: string; searchParams: URLSearchParams }) {
  const params = new URLSearchParams(searchParams);
  params.set("section", section);
  return <Link to={`/app/operations?${params.toString()}`}>{label}</Link>;
}

function AccountEvidence({ metrics }: { metrics: ProjectionMetrics }) {
  const accounts = metrics.clubAccounts;
  const custody = metrics.custodyAccounts;
  if (!accounts.length && !custody.length) return <EmptyState title="Sin cuentas activas informadas" detail="El reporte no devolvió cuentas para el horizonte. No se asume saldo inicial cero." />;

  return <div className="finance-projection-accounts">
    {accounts.map((account, index) => <article className="finance-projection-account" key={account.accountId}>
      <div><strong>Cuenta operativa {index + 1} · {account.currency}</strong><StatusTag tone={account.verified && account.openingApproved ? "good" : "warn"}>{account.verified && account.openingApproved ? "Verificada y apertura aprobada" : "Verificación o apertura pendiente"}</StatusTag></div>
      <dl><div><dt>Saldo conciliado previo</dt><dd>{amountLabel(account.countedBalanceMinor, account.currency)}</dd></div>
        <div><dt>Conciliado hasta</dt><dd>{account.reconciledThrough ? dateLabel(account.reconciledThrough) : "Sin fecha"}</dd></div>
        <div><dt>Mayor observado antes del horizonte</dt><dd>{amountLabel(account.observedPreHorizonLedgerMinor, account.currency)}</dd></div></dl>
    </article>)}
    {custody.length > 0 && <details className="finance-projection-custody"><summary>Fondos en custodia excluidos de caja disponible · {custody.length}</summary>
      <ul>{custody.map((account, index) => <li key={account.accountId}>Custodia {index + 1} · {account.currency} · conciliado {amountLabel(account.countedBalanceMinor, account.currency)} · {account.reconciledThrough ? dateLabel(account.reconciledThrough) : "sin fecha de conciliación"}</li>)}</ul>
    </details>}
  </div>;
}

function ScenarioCard({ scenario }: { scenario: Scenario }) {
  return <article className="finance-projection-scenario">
    <div className="finance-projection-scenario-head">
      <div><span className="ops-kicker">Supuesto aprobado · versión {scenario.version}</span><h4>{scenario.name || "Escenario sin nombre"} · {scenario.currency}</h4>
        <p>Vigente desde {dateLabel(scenario.validFrom)}{scenario.validUntil ? ` hasta ${dateLabel(scenario.validUntil)}` : " sin vencimiento informado"}{scenario.approvedAt ? ` · aprobado ${dateLabel(scenario.approvedAt.slice(0, 10))}` : ""}</p>
      </div>
      <StatusTag tone="warn">{scenario.state === "partial" ? "Supuesto parcial" : "Supuesto sin certificar"}</StatusTag>
    </div>
    <div className="finance-projection-balances" aria-label="Apertura y cierre del escenario">
      <div><span>Apertura conciliada</span><strong>{amountLabel(scenario.openingBalanceMinor, scenario.currency)}</strong></div>
      <div><span>Cierre conciliado</span><strong>{amountLabel(scenario.closingBalanceMinor, scenario.currency)}</strong></div>
      <div><span>Estado de caja continua</span><strong>Pendiente</strong></div>
    </div>
    <p className="finance-projection-scenario-note">Estos importes representan un supuesto de entradas y salidas, no ingresos confirmados ni un saldo disponible. Cada escenario se presenta por separado; no se suman entre sí. Las obligaciones ya vinculadas se excluyen de los supuestos para evitar contarlas dos veces.</p>
    <DataTable label={`Flujos del escenario ${scenario.name} en ${scenario.currency}`}>
      <thead><tr><th>Semana</th><th>Entradas supuestas</th><th>Salidas supuestas</th><th>Neto supuesto</th><th>Obligaciones abiertas</th><th>Verificadas</th><th>Pendientes</th><th>Neto tras verificadas</th><th>Neto tras todas</th></tr></thead>
      <tbody>{scenario.weeks.map(week => <tr key={`${week.weekStart}-${scenario.configurationId}`}>
        <th scope="row">{dateLabel(week.weekStart)}–{dateLabel(week.weekEnd)}<small>{week.itemCount} supuestos</small></th>
        <td>{amountLabel(week.inflowMinor, scenario.currency)}</td><td>{amountLabel(week.outflowMinor, scenario.currency)}</td><td>{amountLabel(week.netFlowMinor, scenario.currency)}</td>
        <td>{amountLabel(week.openPayableMinor, scenario.currency)}</td><td>{amountLabel(week.verifiedOpenPayableMinor, scenario.currency)}</td><td>{amountLabel(week.unverifiedOpenPayableMinor, scenario.currency)}</td>
        <td>{amountLabel(week.netFlowAfterVerifiedOpenPayablesMinor, scenario.currency)}</td><td>{amountLabel(week.netFlowAfterAllOpenPayablesMinor, scenario.currency)}</td>
      </tr>)}</tbody>
    </DataTable>
    {(scenario.invalidItemCount > 0 || scenario.outsideHorizonCount > 0 || scenario.duplicateCommitmentCount > 0 || scenario.conflictingCommitmentCount > 0 || scenario.unmatchedCommitmentCount > 0) && <p className="finance-projection-scenario-note">Revisión de supuestos: {scenario.invalidItemCount} inválidos · {scenario.outsideHorizonCount} fuera del horizonte · {scenario.duplicateCommitmentCount} duplicados · {scenario.conflictingCommitmentCount} en conflicto · {scenario.unmatchedCommitmentCount} sin obligación vinculada.</p>}
  </article>;
}

function ProjectionSummary({ report }: { report: ProjectionReport }) {
  const metrics = report.metrics;
  const complete = metrics.sourceCoverage === "complete" && metrics.payableSummaryComplete && metrics.weekly !== null;
  return <section className="finance-projection-panel" aria-labelledby="finance-projection-title">
    <SectionHeading eyebrow="Caja · horizonte móvil" title="Proyección de las próximas 13 semanas" detail={`${dateLabel(metrics.horizon.from)}–${dateLabel(metrics.horizon.through)} · importes y caminos separados por moneda.`} />
    <InfoBand tone="warning" title="La caja proyectada todavía no está certificada"><p>El servidor no calcula apertura ni cierre para estos escenarios mientras falten conciliación inicial y cobertura continua. Las obligaciones se muestran por separado en verificadas y pendientes; los ingresos futuros sólo aparecen si forman parte de un supuesto aprobado vigente.</p></InfoBand>

    <section className="ops-sheet" aria-labelledby="finance-projection-openings-title">
      <div className="ops-sheet-head"><div><span className="ops-kicker">Apertura y respaldo</span><h3 id="finance-projection-openings-title">Saldos conciliados previos</h3></div><StatusTag tone={stateTone(metrics.sourceCoverage)}>{stateLabel(metrics.sourceCoverage)}</StatusTag></div>
      <AccountEvidence metrics={metrics} />
    </section>

    <section className="ops-sheet" aria-labelledby="finance-projection-obligations-title">
      <div className="ops-sheet-head"><div><span className="ops-kicker">Vencimientos · sin conversión entre monedas</span><h3 id="finance-projection-obligations-title">Obligaciones verificadas y pendientes</h3></div><StatusTag tone={complete ? "good" : "warn"}>{complete ? "Detalle agregado disponible" : "Cobertura incompleta"}</StatusTag></div>
      <p className="ops-small-note">La tabla conserva lo observado por semana. Un período vacío no se toma como saldo cero cuando falta cobertura o attestation documental.</p>
      {metrics.weekly ? <DataTable label="Obligaciones semanales por moneda">
        <thead><tr><th>Semana</th><th>Registros</th><th>Verificados</th><th>Pendientes de verificar</th><th>ARS abiertas</th><th>ARS verificadas</th><th>USD abiertas</th><th>USD verificadas</th></tr></thead>
        <tbody>{metrics.weekly.map(week => <tr key={week.weekStart}>
          <th scope="row">{dateLabel(week.weekStart)}–{dateLabel(week.weekEnd)}</th><td>{week.obligationCount}</td><td>{week.verifiedCount}</td><td>{week.unverifiedCount}</td>
          <td>{currencyValue(week.outstandingByCurrency, "ARS", complete)}</td><td>{currencyValue(week.verifiedOutstandingByCurrency, "ARS", complete)}</td>
          <td>{currencyValue(week.outstandingByCurrency, "USD", complete)}</td><td>{currencyValue(week.verifiedOutstandingByCurrency, "USD", complete)}</td>
        </tr>)}</tbody>
      </DataTable> : <EmptyState title="El total semanal está pendiente" detail="El servidor retuvo los agregados porque la población de obligaciones tiene fechas, monedas o importes inválidos, o su recuento no coincide." />}
      <div className="finance-projection-coverage-grid">
        <div><span>Revisión documental</span><strong>{metrics.attestation.present ? "Informada" : "Pendiente"}</strong><small>{metrics.attestation.present ? `${metrics.attestation.sourceReference} · ${dateLabel(metrics.attestation.fromDate)}–${dateLabel(metrics.attestation.throughDate)}` : "No hay constancia completa para todo el horizonte."}</small></div>
        <div><span>Detalle visible</span><strong>{metrics.visiblePayableRows} / {metrics.payableRowsComplete ? metrics.visiblePayableRows : metrics.payableDetailLimit} registros</strong><small>{metrics.payableRowsComplete ? "Incluye la población completa." : "El servidor informa límite de detalle; los agregados y la lista pueden diferir."}</small></div>
        <div><span>Datos inválidos</span><strong>{metrics.invalidPayableDateCount} fechas · {metrics.invalidPayableCurrencyCount} monedas · {metrics.invalidPayableAmountCount} importes</strong><small>Los registros inválidos impiden certificar el total afectado.</small></div>
        <div><span>Cuentas activas visibles</span><strong>{metrics.visibleActiveAccountRows}</strong><small>{metrics.activeAccountRowsComplete ? "Detalle completo." : "La lista de cuentas alcanzó el límite de detalle."}</small></div>
      </div>
      {report.coverage.length > 0 && <details className="finance-projection-source-coverage"><summary>Cobertura técnica por fuente</summary><ul>{report.coverage.map((row, index) => <li key={`${row.source}-${index}`}><span><strong>{row.source.replaceAll(/[-_]/g, " ")}</strong><small>{row.knownCount ?? "Sin dato"} conocidas · {row.expectedCount ?? "esperadas no informadas"}{row.queryComplete === null ? "" : row.queryComplete ? " · consulta completa" : " · consulta incompleta"}</small>{row.reason && <small>{readableReason(row.reason)}</small>}</span><StatusTag tone={stateTone(row.state)}>{stateLabel(row.state)}</StatusTag></li>)}</ul></details>}
    </section>

    <section className="ops-sheet" aria-labelledby="finance-projection-scenarios-title">
      <div className="ops-sheet-head"><div><span className="ops-kicker">Supuestos aprobados</span><h3 id="finance-projection-scenarios-title">Caminos de caja por escenario</h3></div><StatusTag tone={stateTone(metrics.scenarioConfigurationCoverage.state)}>{stateLabel(metrics.scenarioConfigurationCoverage.state)}</StatusTag></div>
      <p className="ops-small-note">Configuraciones aprobadas vigentes: {metrics.scenarioConfigurationCoverage.approvedVersionCount ?? "sin dato"}. Se cargaron {metrics.scenarioConfigurationCoverage.loadedApprovedVersionCount}; seleccionadas {metrics.scenarioConfigurationCoverage.selectedScenarioCount ?? "sin dato"}. {readableReason(metrics.scenarioConfigurationCoverage.reason)}</p>
      {metrics.scenarioProjections.length ? <div className="finance-projection-scenarios">{metrics.scenarioProjections.map(scenario => <ScenarioCard key={`${scenario.configurationId}-${scenario.version}`} scenario={scenario} />)}</div>
        : <EmptyState title="No hay un supuesto aprobado para mostrar" detail={metrics.scenarioConfigurationCoverage.reason === "no-current-approved-scenario-configuration" ? "Configurá un escenario operativo y completá su aprobación antes de usarlo como supuesto de caja." : "La cobertura actual no permite calcular o mostrar caminos de escenario."} />}
    </section>
  </section>;
}

export function FinanceWorkspace({ context, refreshKey }: WorkspaceProps) {
  const [searchParams] = useSearchParams();
  const allowed = hasCapability(context, "finance.read") && hasCapability(context, "reports.read");
  const today = todayInReportTimeZone();
  const selectedDate = searchParams.get("to") ?? today;
  const validDate = civilDate.safeParse(selectedDate).success && selectedDate <= today;
  const summaryPath = allowed && validDate
    ? `/api/reports/operations/summary?area=obligations-13-weeks&to=${encodeURIComponent(selectedDate)}`
    : null;
  const resource = useRemote<unknown>(summaryPath, refreshKey);
  const parsed = resource.data === null ? null : reportResponse.safeParse(resource.data);
  const validReport = parsed?.success ? parsed.data.summary : null;

  const links = <nav className="financial-workspace-nav" aria-label="Herramientas financieras">
    {hasCapability(context, "finance.read") && <SectionLink section="payables" label="Obligaciones" searchParams={searchParams} />}
    {hasCapability(context, "finance.read") && <SectionLink section="accounts" label="Cuentas y saldos" searchParams={searchParams} />}
    {hasCapability(context, "prices.propose") && <SectionLink section="configuration" label="Configurar escenarios" searchParams={searchParams} />}
    {hasCapability(context, "imports.review") && <SectionLink section="sources" label="Datos cargados" searchParams={searchParams} />}
    {hasCapability(context, "imports.write") && <SectionLink section="imports" label="Importación legado" searchParams={searchParams} />}
  </nav>;

  if (!allowed) return <div className="ops-page-body bombo-finance-workspace">{links}<InfoBand tone="blocked" title="Acceso financiero no disponible"><p>El perfil necesita lectura financiera e informes; el servidor mantiene la autorización vigente.</p></InfoBand></div>;

  return <div className="ops-page-body bombo-finance-workspace">
    {links}
    <FinancialStatements key={refreshKey} />
    <div className="finance-projection-heading"><SectionHeading eyebrow="Informe del servidor · separado de los resultados históricos" title="Caja proyectada y obligaciones" detail="Horizonte de 13 semanas anclado a la fecha elegida arriba; escenarios ARS y USD por separado." /></div>
    {reportError(summaryPath, resource.data, resource.loading, resource.error, resource.retry)}
    {resource.data !== null && parsed && !parsed.success && <ErrorState message="La respuesta del informe no coincide con el formato esperado. No se muestran cifras parciales; reintentá para obtener una respuesta válida." retry={resource.retry} />}
    {validReport && <ProjectionSummary report={validReport} />}
  </div>;
}
