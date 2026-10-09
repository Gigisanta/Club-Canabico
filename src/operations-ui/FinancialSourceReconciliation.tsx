import { useEffect, useState } from "react";
import { apiGet, hasCapability, OperationsApiError } from "./api";
import { formatMinor } from "./money";
import type {
  FinancialSourceControl,
  FinancialSourceControlComparison,
  FinancialSourceExclusionCounts,
  FinancialSourcePeriod,
  FinancialSourceReconciliationReport,
  FinancialSourceSnapshotReport,
} from "../../shared/operations/financial-source-report";
import { financialSourceExclusionReasons } from "../../shared/operations/financial-source-report";
import type { OperationsContext } from "./types";
import "./financial-source-reconciliation.css";

interface PeriodSelection {
  from: string;
  to: string;
}

interface SourceReadFailure {
  message: string;
  status: number | null;
  code?: string;
}

interface Resource<T> {
  path: string | null;
  version: number;
  data: T | null;
  loading: boolean;
  error: SourceReadFailure | null;
}

interface Props {
  context: OperationsContext | null;
  contextLoading: boolean;
  contextError: string | null;
  contextForbidden: boolean;
  onRetryContext: () => void;
  onSelectPeriod: (period: PeriodSelection) => void;
}

const exclusionLabels: Record<string, string> = {
  missingDate: "Sin fecha",
  invalidDate: "Fecha inválida",
  futureDate: "Fecha posterior al corte",
  nonNumericAmount: "Importe no numérico",
  negativeAmount: "Importe negativo",
  invalidMovementType: "Tipo de movimiento inválido",
  invalidCurrency: "Moneda no reconocida",
  blankCashBox: "Sin caja informada",
  duplicateIdentity: "Identidad duplicada",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCivilDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function isMonth(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  return isCivilDate(`${value}-01`);
}

function isMinor(value: unknown): value is string {
  return typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value);
}

function isUnsignedMinor(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
}

function isNonNegativeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPeriod(value: unknown): value is FinancialSourcePeriod {
  if (!isRecord(value)) return false;
  return isMonth(value.month)
    && (value.currency === "ARS" || value.currency === "USD")
    && isNonNegativeCount(value.count)
    && isUnsignedMinor(value.inflowMinor)
    && isUnsignedMinor(value.outflowMinor)
    && isMinor(value.netMovementMinor)
    && BigInt(value.inflowMinor) - BigInt(value.outflowMinor) === BigInt(value.netMovementMinor);
}

function isPeriodArray(value: unknown): value is FinancialSourcePeriod[] {
  return Array.isArray(value) && value.every(isPeriod);
}

function isControl(value: unknown): value is FinancialSourceControl {
  if (!isRecord(value)) return false;
  const periods = value.periods;
  if (typeof value.fileHash !== "string"
    || !/^[a-f0-9]{64}$/.test(value.fileHash)
    || !isCivilDate(value.cutoffDate)
    || !isNonNegativeCount(value.rawCount)
    || !isNonNegativeCount(value.eligibleCount)
    || !isNonNegativeCount(value.excludedCount)
    || !isPeriodArray(periods)) return false;
  const periodKeys = periods.map(period => `${period.month}\u0000${period.currency}`);
  return new Set(periodKeys).size === periodKeys.length
    && value.eligibleCount + value.excludedCount === value.rawCount
    && periods.reduce((sum, period) => sum + period.count, 0) === value.eligibleCount;
}

function isExclusionCounts(value: unknown): value is FinancialSourceExclusionCounts {
  if (!isRecord(value)) return false;
  return financialSourceExclusionReasons.every(reason => isNonNegativeCount(value[reason]));
}

function isControlComparison(value: unknown): value is FinancialSourceControlComparison {
  if (!isRecord(value)) return false;
  return typeof value.scope === "boolean"
    && typeof value.fileHash === "boolean"
    && typeof value.cutoffDate === "boolean"
    && typeof value.rawCount === "boolean"
    && typeof value.eligibleCount === "boolean"
    && typeof value.excludedCount === "boolean"
    && typeof value.periods === "boolean"
    && typeof value.exact === "boolean";
}

function isTechnicalReconciliationReason(value: unknown): value is FinancialSourceSnapshotReport["technicalReconciliationReason"] {
  return value === null
    || value === "control-manifest-missing-or-invalid"
    || value === "source-scope-mismatch"
    || value === "control-file-hash-mismatch"
    || value === "control-cutoff-date-mismatch"
    || value === "control-counts-mismatch"
    || value === "control-periods-mismatch";
}

function samePeriods(left: readonly FinancialSourcePeriod[], right: readonly FinancialSourcePeriod[]) {
  if (left.length !== right.length) return false;
  const compare = (a: FinancialSourcePeriod, b: FinancialSourcePeriod) => a.month.localeCompare(b.month) || a.currency.localeCompare(b.currency);
  const orderedLeft = [...left].sort(compare);
  const orderedRight = [...right].sort(compare);
  return orderedLeft.every((period, index) => {
    const other = orderedRight[index];
    return period.month === other?.month
      && period.currency === other.currency
      && period.count === other.count
      && period.inflowMinor === other.inflowMinor
      && period.outflowMinor === other.outflowMinor
      && period.netMovementMinor === other.netMovementMinor;
  });
}

function isSnapshot(value: unknown): value is FinancialSourceSnapshotReport {
  if (!isRecord(value)) return false;
  const expectedControl = value.expectedControl;
  const observedControl = value.observedControl;
  const controlComparisonValue = value.controlComparison;
  if (value.status !== "staged" || value.sourceReviewApproved !== false) return false;
  if (value.label !== "STAGED · observación de origen sin aprobar") return false;
  if (typeof value.snapshotId !== "string" || typeof value.filename !== "string" || typeof value.fileHash !== "string") return false;
  if (!/^[a-f0-9]{64}$/.test(value.fileHash)) return false;
  if (!isNonNegativeCount(value.loadedCount) || !isNonNegativeCount(value.eligibleCount) || !isNonNegativeCount(value.excludedCount)) return false;
  if (!isExclusionCounts(value.exclusionCounts)) return false;
  if (!(expectedControl === null || isControl(expectedControl)) || !isControl(observedControl)) return false;
  if (value.loadedCount !== observedControl.rawCount
      || value.eligibleCount !== observedControl.eligibleCount
      || value.excludedCount !== observedControl.excludedCount) return false;
  if (value.latestObservedDate !== null && !isCivilDate(value.latestObservedDate)) return false;
  if (!isControlComparison(controlComparisonValue)) return false;
  if (!isTechnicalReconciliationReason(value.technicalReconciliationReason)) return false;
  const comparison = controlComparisonValue;
  const exact = comparison.scope && comparison.fileHash && comparison.cutoffDate
    && comparison.rawCount && comparison.eligibleCount && comparison.excludedCount && comparison.periods;
  if (comparison.exact !== exact || (value.technicalReconciliation === "reconciled" && !comparison.exact)) return false;
  return value.technicalReconciliation === "reconciled" || value.technicalReconciliation === "unverified";
}

function isSnapshotArray(value: unknown): value is FinancialSourceSnapshotReport[] {
  return Array.isArray(value) && value.every(isSnapshot);
}

function isReport(value: unknown): value is FinancialSourceReconciliationReport {
  if (!isRecord(value)) return false;
  const sources = value.sources;
  const periods = value.periods;
  if (value.report !== "operations-financial-source-reconciliation"
    || !isCivilDate(value.cutoffDate)
    || !isSnapshotArray(sources)
    || (value.latestObservedDate !== null && !isCivilDate(value.latestObservedDate))
    || !(periods === null || isPeriodArray(periods))
    || value.sourceUnapproved !== true
    || value.createsBalances !== false
    || value.currentPeriodStatus !== "unknown"
    || (value.completeness !== "technical-source-reconciled" && value.completeness !== "unverified")) return false;
  if (sources.length === 0 || sources.length > 1) return periods === null;
  const [source] = sources;
  return source !== undefined && periods !== null && samePeriods(periods, source.observedControl.periods);
}

function useSourceReport(path: string | null) {
  const [resource, setResource] = useState<Resource<FinancialSourceReconciliationReport>>({
    path: null, version: -1, data: null, loading: false, error: null,
  });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!path) {
      setResource({ path: null, version, data: null, loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    setResource({ path, version, data: null, loading: true, error: null });
    apiGet<FinancialSourceReconciliationReport>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResource({ path, version, data, loading: false, error: null });
    }).catch(cause => {
      if (controller.signal.aborted) return;
      const failure: SourceReadFailure = cause instanceof OperationsApiError
        ? { message: cause.message, status: cause.status, code: cause.code }
        : { message: cause instanceof Error ? cause.message : "No se pudo cargar la conciliación de esta fuente.", status: null };
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

function dateLabel(value: string) {
  if (!isCivilDate(value)) return "Fecha pendiente";
  return new Date(`${value}T12:00:00.000Z`).toLocaleDateString("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires", day: "numeric", month: "short", year: "numeric",
  });
}

function periodRange(month: string, cutoffDate: string): PeriodSelection | null {
  if (!isMonth(month) || !isCivilDate(cutoffDate)) return null;
  const [year, monthNumber] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return to <= cutoffDate ? { from, to } : null;
}

function periodRows(snapshot: FinancialSourceSnapshotReport, report: FinancialSourceReconciliationReport, sourceCount: number) {
  if (!snapshot.controlComparison.scope) return [];
  const rows = sourceCount === 1 && report.periods !== null ? report.periods : snapshot.observedControl.periods;
  return rows.filter(row => row.count > 0).sort((left, right) => left.month.localeCompare(right.month) || left.currency.localeCompare(right.currency));
}

function exclusionRows(snapshot: FinancialSourceSnapshotReport) {
  return Object.entries(snapshot.exclusionCounts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({ label: exclusionLabels[key] ?? "Otra causa de exclusión", count }))
    .sort((left, right) => left.label.localeCompare(right.label, "es"));
}

function controlStatus(snapshot: FinancialSourceSnapshotReport, key: keyof FinancialSourceSnapshotReport["controlComparison"]) {
  return snapshot.controlComparison[key] ? "Coincide" : "No coincide";
}

function SnapshotCard({ snapshot, index, report }: {
  snapshot: FinancialSourceSnapshotReport;
  index: number;
  report: FinancialSourceReconciliationReport;
}) {
  const rows = periodRows(snapshot, report, report.sources.length);
  const exclusions = exclusionRows(snapshot);
  const reconciled = snapshot.technicalReconciliation === "reconciled" && snapshot.controlComparison.exact;

  return <article className="financial-source-snapshot">
    <div className="financial-source-snapshot-head">
      <div><span className="financial-source-caption">AppSheet · Movimiento_Nueva{report.sources.length > 1 ? ` · carga ${index + 1}` : ""}</span>
        <h4>Fuente en preparación</h4></div>
      <span className="financial-source-status">STAGED · sin aprobación humana</span>
    </div>
    <p className="financial-source-review-note">Fuente en revisión. Estos movimientos no confirman saldos ni un resultado cerrado.</p>
    {snapshot.latestObservedDate && <p className="financial-source-last-date">Última fecha observada en esta carga: {dateLabel(snapshot.latestObservedDate)}.</p>}
    <dl className="financial-source-counts">
      <div><dt>Filas cargadas</dt><dd>{snapshot.loadedCount.toLocaleString("es-AR")}</dd></div>
      <div><dt>Elegibles para observación</dt><dd>{snapshot.eligibleCount.toLocaleString("es-AR")}</dd></div>
      <div><dt>Excluidas</dt><dd>{snapshot.excludedCount.toLocaleString("es-AR")}</dd></div>
    </dl>
    <section className="financial-source-technical" aria-label="Conciliación técnica de la carga">
      <div className="financial-source-technical-head">
        <h5>Conciliación técnica</h5>
        <span className={reconciled ? "is-reconciled" : "is-unverified"}>
          {reconciled ? "Controles técnicos coincidentes" : "Verificación técnica pendiente"}
        </span>
      </div>
      <p>{reconciled
        ? "La huella y los conteos observados coinciden con el control de importación."
        : "No se pudo confirmar la coincidencia completa con el control de importación."}</p>
      <details>
        <summary>Ver controles comparados</summary>
        <ul className="financial-source-control-list">
          {([
            ["Alcance de la fuente", "scope"],
            ["Huella del archivo", "fileHash"],
            ["Fecha de corte", "cutoffDate"],
            ["Filas cargadas", "rawCount"],
            ["Filas elegibles", "eligibleCount"],
            ["Filas excluidas", "excludedCount"],
            ["Períodos observados", "periods"],
            ["Coincidencia integral", "exact"],
          ] as const).map(([label, key]) => <li key={key}><span>{label}</span><strong>{controlStatus(snapshot, key)}</strong></li>)}
        </ul>
      </details>
    </section>
    {exclusions.length > 0 && <details className="financial-source-exclusions">
      <summary>Detalle de exclusiones</summary>
      <p>Los conteos por causa pueden superponerse; cada fila excluida se cuenta una sola vez en el total.</p>
      <ul>{exclusions.map(item => <li key={item.label}><span>{item.label}</span><strong>{item.count.toLocaleString("es-AR")}</strong></li>)}</ul>
    </details>}
    <div className="financial-source-period-heading">
      <h5>Importes observados por período y moneda</h5>
      <span>Corte de fuente: {dateLabel(report.cutoffDate)}</span>
    </div>
    {rows.length > 0 ? <div className="financial-source-table-wrap" role="region" aria-label="Importes observados por período y moneda" tabIndex={0}>
      <table className="financial-source-table">
        <caption>Movimientos importados observados, sin conversión entre monedas</caption>
        <thead><tr><th scope="col">Período</th><th scope="col">Moneda</th><th scope="col">Movimientos</th><th scope="col">Entradas observadas</th><th scope="col">Salidas observadas</th><th scope="col">Diferencia observada (entradas menos salidas)</th></tr></thead>
        <tbody>{rows.map(row => <tr key={`${row.month}-${row.currency}`}>
          <th scope="row">{row.month}</th>
          <td>{row.currency}</td>
          <td>{row.count.toLocaleString("es-AR")}</td>
          <td>{formatMinor(row.inflowMinor, row.currency)}</td>
          <td>{formatMinor(row.outflowMinor, row.currency)}</td>
          <td>{formatMinor(row.netMovementMinor, row.currency)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className="financial-source-empty">{snapshot.controlComparison.scope
      ? "No hay períodos con movimientos observados para esta carga."
      : "No se muestran importes porque el alcance de esta carga no coincide con la fuente esperada."}</p>}
  </article>;
}

export function FinancialSourceReconciliation({
  context, contextLoading, contextError, contextForbidden, onRetryContext, onSelectPeriod,
}: Props) {
  const hasSourceAccess = context !== null
    && hasCapability(context, "reports.read")
    && hasCapability(context, "finance.read")
    && hasCapability(context, "imports.review");
  const path = hasSourceAccess ? "/api/reports/operations/financial-source-reconciliation" : null;
  const sourceReport = useSourceReport(path);

  if (contextLoading) return <section className="financial-report-card financial-source-card" aria-labelledby="financial-source-title">
    <div className="financial-report-card-head"><div><span className="financial-report-eyebrow">Fuentes cargadas</span><h3 id="financial-source-title">Origen financiero</h3></div></div>
    <p className="financial-report-loading" role="status">Confirmando permisos para leer la fuente…</p>
  </section>;

  if (!context) return <section className="financial-report-card financial-source-card" aria-labelledby="financial-source-title">
    <div className="financial-report-card-head"><div><span className="financial-report-eyebrow">Fuentes cargadas</span><h3 id="financial-source-title">Origen financiero</h3></div></div>
    <div className="financial-report-error" role="alert"><p>{contextError ?? "No se pudo confirmar el acceso a la fuente financiera."}</p>
      {!contextForbidden && <button type="button" onClick={onRetryContext}>Reintentar</button>}</div>
  </section>;

  if (!hasSourceAccess) return <section className="financial-report-card financial-source-card" aria-labelledby="financial-source-title">
    <div className="financial-report-card-head"><div><span className="financial-report-eyebrow">Fuentes cargadas</span><h3 id="financial-source-title">Origen financiero</h3></div></div>
    <div className="financial-report-blocked" role="status"><strong>Fuente no disponible para este perfil</strong><p>Se requieren permisos de lectura financiera, informes e importaciones.</p></div>
  </section>;

  const report = sourceReport.data;
  const malformed = report !== null && !isReport(report);
  const inconsistentControls = report !== null && isReport(report) && report.sources.some(snapshot =>
    snapshot.technicalReconciliation === "reconciled" && snapshot.controlComparison.exact !== true);
  const incompleteReportClaim = report !== null && isReport(report)
    && report.completeness === "technical-source-reconciled"
    && (report.sources.length === 0 || report.sources.some(snapshot => snapshot.technicalReconciliation !== "reconciled" || !snapshot.controlComparison.scope));
  const invalidResponse = malformed || inconsistentControls || incompleteReportClaim;
  const hasSelectablePeriod = report !== null && isReport(report) && report.sources.some(snapshot =>
    periodRows(snapshot, report, report.sources.length).some(row => row.count > 0 && periodRange(row.month, report.cutoffDate) !== null));

  return <section className="financial-report-card financial-source-card" aria-labelledby="financial-source-title">
    <div className="financial-report-card-head"><div><span className="financial-report-eyebrow">Fuentes cargadas</span><h3 id="financial-source-title">Origen financiero</h3></div>
      {report && !invalidResponse && <span className="financial-source-status">Solo lectura · STAGED</span>}
    </div>
    {sourceReport.loading && <p className="financial-report-loading" role="status">Cargando fuente y controles técnicos…</p>}
    {sourceReport.error && <div className="financial-report-error" role="alert"><p>{sourceReport.error.message}</p><button type="button" onClick={sourceReport.retry}>Reintentar</button></div>}
    {invalidResponse && <div className="financial-report-error" role="alert"><p>La respuesta no permite confirmar el estado en revisión de esta fuente. No se muestran sus importes.</p><button type="button" onClick={sourceReport.retry}>Reintentar</button></div>}
    {report && !invalidResponse && !sourceReport.error && !sourceReport.loading && report.sources.length === 0 && <div className="financial-source-empty" role="status"><strong>No hay una fuente financiera cargada para mostrar.</strong><span>No se muestran importes sin filas de origen.</span></div>}
    {report && !invalidResponse && !sourceReport.error && !sourceReport.loading && report.sources.map((snapshot, index) => <SnapshotCard
      key={snapshot.snapshotId} snapshot={snapshot} index={index} report={report} />)}
    {report && !invalidResponse && !sourceReport.error && !sourceReport.loading && report.sources.length > 0 && !hasSelectablePeriod && <p className="financial-source-empty" role="status">No hay un mes completo con movimientos observados hasta el corte de la fuente.</p>}
    {report && !invalidResponse && !sourceReport.error && !sourceReport.loading && report.sources.length > 0 && hasSelectablePeriod && <button type="button" className="financial-source-select-period" onClick={() => {
      const periods = report.sources.flatMap(snapshot => periodRows(snapshot, report, report.sources.length)
        .filter(row => row.count > 0)
        .map(row => ({ month: row.month, range: periodRange(row.month, report.cutoffDate) })))
        .filter((item): item is { month: string; range: PeriodSelection } => item.range !== null)
        .sort((left, right) => right.month.localeCompare(left.month));
      const latest = periods[0];
      if (latest) onSelectPeriod(latest.range);
    }}>Ver último período con datos</button>}
    {report && !invalidResponse && !sourceReport.error && !sourceReport.loading && report.sources.length > 0 && <p className="financial-source-footnote">Los períodos se presentan por moneda, sin conversión ni suma entre ARS y USD. Los movimientos observados no constituyen ventas, cobros, saldos ni un resultado financiero cerrado.</p>}
  </section>;
}
