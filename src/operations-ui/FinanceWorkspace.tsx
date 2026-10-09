import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { z } from "zod";
import type { DecisionInputAttestationInput } from "../../shared/operations/decision-inputs";
import { clearPendingAttestationRequest, fingerprintAttestationPayload, readPendingAttestationRequest, writePendingAttestationRequest } from "../attestation-request";
import { FinancialStatements } from "./FinancialStatements";
import { apiPost, hasCapability, isUncertainCommandOutcome } from "./api";
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

const custodyEvidence = accountEvidence.omit({ kind: true }).extend({
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

function PayablesCoverageAttestation({ fromDate, throughDate, userId, onRefresh }: { fromDate: string | null; throughDate: string | null; userId: string; onRefresh: () => void }) {
  const [from, setFrom] = useState(fromDate ?? "");
  const [through, setThrough] = useState(throughDate ?? "");
  const [sourceReference, setSourceReference] = useState("");
  const [complete, setComplete] = useState(false);
  const [humanReview, setHumanReview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [outcomeUncertain, setOutcomeUncertain] = useState(false);
  const [retrySamePayload, setRetrySamePayload] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [requestId, setRequestId] = useState<string>(() => crypto.randomUUID());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const previousHorizon = useRef({ from: fromDate, through: throughDate });

  useEffect(() => {
    if ((!fromDate || !throughDate) && !outcomeUncertain) setComplete(false);
  }, [fromDate, outcomeUncertain, throughDate]);

  useEffect(() => {
    if (!fromDate || !throughDate) return;
    if (previousHorizon.current.from === fromDate && previousHorizon.current.through === throughDate) return;
    previousHorizon.current = { from: fromDate, through: throughDate };
    if (outcomeUncertain) {
      setError("El horizonte del informe cambió mientras esta declaración tenía un resultado incierto. Conservé el período, la referencia y el mismo ID; confirmá la reintención idéntica antes de preparar otro período.");
      return;
    }
    setFrom(fromDate);
    setThrough(throughDate);
    setComplete(false);
    setHumanReview(false);
    setRequestId(crypto.randomUUID());
    setSaved(false);
    setRetrySamePayload(false);
    setError("");
    setNotice("Cambió el horizonte: actualicé las fechas y conservé la referencia. Revisá de nuevo la fuente antes de declarar la cobertura.");
  }, [from, fromDate, outcomeUncertain, through, throughDate]);

  function changed(event: ChangeEvent<HTMLFormElement>) {
    if (event.target instanceof HTMLInputElement && event.target.name === "retrySamePayload") return;
    if (outcomeUncertain) return;
    setRequestId(crypto.randomUUID());
    setSaved(false);
    setNotice("");
    setError("");
    setRetrySamePayload(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setNotice("");
    setError("");
    let requestWasSent = false;
    try {
      if (!civilDate.safeParse(from).success || !civilDate.safeParse(through).success)
        throw new Error("Indicá fechas válidas para el período.");
      if (from > through) throw new Error("La fecha inicial debe ser anterior o igual a la final.");
      if ((Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 > 730)
        throw new Error("El período de cobertura no puede superar dos años.");
      if (!sourceReference.trim() || sourceReference.trim().length < 3 || sourceReference.trim().length > 240)
        throw new Error("La referencia debe tener entre 3 y 240 caracteres.");
      if (!humanReview) throw new Error("Confirmá que revisaste el período, la cobertura y la referencia.");

      const input: DecisionInputAttestationInput = {
        domain: "payables",
        scenario: null,
        fromDate: from,
        throughDate: through,
        complete,
        sourceReference: sourceReference.trim(),
        requestId,
      };
      if (!outcomeUncertain) {
        const pendingRead = await readPendingAttestationRequest("finance-payables", userId);
        if (!pendingRead.ok) {
          setError("No pude comprobar ni guardar el identificador de recuperación en esta pestaña. No envié la declaración; habilitá el almacenamiento de sesión e intentá otra vez.");
          return;
        }
        const pending = pendingRead.record;
        if (pending) {
          const fingerprint = await fingerprintAttestationPayload(input, userId);
          setRecoveryRequired(true);
          if (!fingerprint || fingerprint !== pending.fingerprint) {
            setError("Hay una declaración previa cuyo resultado no se confirmó. Reconstruí exactamente sus fechas, referencia y cobertura; no enviaré otro contenido hasta resolverla.");
            return;
          }
          setRequestId(pending.requestId);
          setOutcomeUncertain(true);
          setRetrySamePayload(false);
          setRecoveryRequired(false);
          setError("Encontré un reintento pendiente para este mismo borrador. No lo envié todavía; confirmá abajo el reintento idéntico con el ID existente.");
          return;
        }
        if (complete && (!fromDate || !throughDate || from !== fromDate || through !== throughDate))
          throw new Error(fromDate && throughDate
            ? `Para declarar completa la cobertura del horizonte, usá exactamente ${dateLabel(fromDate)}–${dateLabel(throughDate)}.`
            : "El informe todavía no ofrece un horizonte válido para declarar cobertura completa.");
        const fingerprint = await fingerprintAttestationPayload(input, userId);
        if (!fingerprint) {
          setError("No pude preparar un fingerprint seguro para recuperar esta solicitud. No envié la declaración; intentá desde una pestaña con Web Crypto habilitado.");
          return;
        }
        if (!await writePendingAttestationRequest("finance-payables", userId, { requestId, fingerprint })) {
          setError("No pude guardar el ID de recuperación en esta pestaña. No envié la declaración; habilitá el almacenamiento de sesión e intentá otra vez.");
          return;
        }
      }
      let receipt: unknown;
      try {
        requestWasSent = true;
        receipt = await apiPost<unknown>("/api/decision-inputs/attestations", input);
      } catch (cause) {
        if (isUncertainCommandOutcome(cause)) {
          setOutcomeUncertain(true);
          setRetrySamePayload(false);
          setRecoveryRequired(false);
          setError("El servidor no confirmó el resultado. Conservé los datos y el mismo ID; podés confirmar abajo un reintento idéntico para recuperar el comprobante sin duplicar la declaración.");
          onRefresh();
          return;
        }
        throw cause;
      }
      if (!receipt || typeof receipt !== "object" || typeof (receipt as { id?: unknown }).id !== "string" || !(receipt as { id: string }).id.trim() ||
          (receipt as { id: string }).id !== requestId || (receipt as { complete?: unknown }).complete !== complete) {
        setOutcomeUncertain(true);
        setRetrySamePayload(false);
        setRecoveryRequired(false);
        setError("El comprobante no coincide con esta declaración. Conservé los datos y el mismo ID; podés confirmar abajo un reintento idéntico para recuperar el comprobante.");
        onRefresh();
        return;
      }
      await clearPendingAttestationRequest("finance-payables", userId, requestId);
      setOutcomeUncertain(false);
      setRetrySamePayload(false);
      setRecoveryRequired(false);
      setRequestId(crypto.randomUUID());
      const horizonChanged = Boolean(fromDate && throughDate && (from !== fromDate || through !== throughDate));
      if (horizonChanged && fromDate && throughDate) {
        setFrom(fromDate);
        setThrough(throughDate);
        setComplete(false);
        setHumanReview(false);
        setSaved(false);
        setNotice(`La declaración anterior se confirmó. El informe ahora usa ${dateLabel(fromDate)}–${dateLabel(throughDate)}; conservé la referencia y actualicé las fechas. Revisá de nuevo la fuente antes de otra declaración.`);
      } else {
        setSaved(true);
        setNotice(complete
          ? "Declaración completa registrada. Documenta la cobertura declarada; no verifica la fuente ni aprueba automáticamente las cifras del informe."
          : "Declaración parcial registrada como la última revisión. No certifica cobertura completa ni aprueba automáticamente las cifras del informe.");
      }
      onRefresh();
    } catch (cause) {
      if (requestWasSent) {
        await clearPendingAttestationRequest("finance-payables", userId, requestId);
        setRecoveryRequired(false);
      }
      setOutcomeUncertain(false);
      setRetrySamePayload(false);
      setError(cause instanceof Error ? cause.message : "No se pudo registrar la atestación.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="ops-sheet" aria-labelledby="finance-payables-attestation-title">
    <div className="ops-sheet-head"><div><span className="ops-kicker">Declaración manual · sin crear obligaciones</span><h3 id="finance-payables-attestation-title">Documentar cobertura de obligaciones</h3></div></div>
    <p className="ops-small-note">Revisá la fuente real que cubre los vencimientos del horizonte y anotá una referencia descriptiva. El formulario no importa, verifica ni crea obligaciones; la declaración documenta cobertura, pero no verifica la fuente ni aprueba automáticamente las cifras del informe. El servidor exige rol de propietario o administrador. No ingreses claves ni tokens.</p>
    <form className="ops-form-grid finance-attestation-form" aria-busy={saving} onSubmit={(event) => void submit(event)} onChange={changed}>
      <label className="ops-field"><span>Desde · inicio del horizonte de 13 semanas</span><input type="date" value={from} disabled={saving || outcomeUncertain} onChange={event => setFrom(event.target.value)} required /></label>
      <label className="ops-field"><span>Hasta · cierre del horizonte de 13 semanas</span><input type="date" value={through} disabled={saving || outcomeUncertain} onChange={event => setThrough(event.target.value)} required /></label>
      <label className="ops-field"><span>Referencia humana de la fuente</span><input type="text" value={sourceReference} maxLength={240} disabled={saving || outcomeUncertain} onChange={event => setSourceReference(event.target.value)} placeholder="Planilla de vencimientos · corte y responsable…" required /><small>Usá un nombre o referencia verificable que cubra el período completo.</small></label>
      <label className="ops-field ops-field-check"><input type="checkbox" checked={complete} disabled={saving || outcomeUncertain || !fromDate || !throughDate} onChange={event => setComplete(event.target.checked)} /><span>Declaro que esta fuente incluye todas las obligaciones entre las fechas indicadas.</span></label>
      <label className="ops-field ops-field-check"><input type="checkbox" checked={humanReview} disabled={saving || outcomeUncertain} onChange={event => setHumanReview(event.target.checked)} required /><span>Revisé el período y la fuente citada.</span></label>
      {outcomeUncertain && <label className="ops-field ops-field-check"><input type="checkbox" name="retrySamePayload" checked={retrySamePayload} disabled={saving} onChange={event => setRetrySamePayload(event.target.checked)} /><span>Confirmo reintentar exactamente el mismo período, referencia y declaración con el mismo ID.</span></label>}
      {recoveryRequired && !outcomeUncertain && <p className="ops-inline-error finance-attestation-message" role="status">Hay una declaración pendiente de recuperar. Reconstruí el borrador original; se comparará sin guardar el texto y se bloqueará cualquier payload distinto.</p>}
      {error && <p className="ops-inline-error finance-attestation-message" role="alert">{error}</p>}
      {notice && <p className="ops-small-note finance-attestation-message" role="status">{notice}</p>}
      <button className="ops-button finance-attestation-submit" type="submit" disabled={saving || saved || (outcomeUncertain && !retrySamePayload)}>{saving ? "Guardando…" : saved ? "Atestación registrada" : outcomeUncertain ? "Reintentar la misma declaración" : "Guardar declaración de cobertura"}</button>
    </form>
  </section>;
}

function ProjectionSummaryContent({ report }: { report: ProjectionReport }) {
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

function ProjectionSummary({ report, attestation }: { report: ProjectionReport | null; attestation: ReactNode }) {
  return <>
    {report ? <ProjectionSummaryContent report={report} /> : null}
    <div className="finance-attestation-slot">{attestation}</div>
  </>;
}

export function FinanceWorkspace({ context, refreshKey, onRefresh }: WorkspaceProps) {
  const [searchParams] = useSearchParams();
  const allowed = hasCapability(context, "finance.read") && hasCapability(context, "reports.read");
  const canAttestPayables = context.canManageDecisionInputs === true;
  const today = todayInReportTimeZone();
  const selectedDate = searchParams.get("to") ?? today;
  const validDate = civilDate.safeParse(selectedDate).success && selectedDate <= today;
  const summaryPath = allowed && validDate
    ? `/api/reports/operations/summary?area=obligations-13-weeks&to=${encodeURIComponent(selectedDate)}`
    : null;
  const resource = useRemote<unknown>(summaryPath, refreshKey);
  const parsed = resource.data === null ? null : reportResponse.safeParse(resource.data);
  const validReport = parsed?.success ? parsed.data.summary : null;
  const attestation = canAttestPayables
    ? <PayablesCoverageAttestation fromDate={validReport?.metrics.horizon.from ?? null} throughDate={validReport?.metrics.horizon.through ?? null} userId={context.userId} onRefresh={onRefresh} />
    : <p className="ops-small-note">La lectura del informe sigue disponible. Solo un propietario o administrador puede registrar esta declaración.</p>;

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
    <ProjectionSummary report={validReport} attestation={attestation} />
  </div>;
}
