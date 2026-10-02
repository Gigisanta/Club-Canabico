import { useEffect, useState } from "react";
import { hasCapability, hasCommand, isUncertainCommandOutcome, responseVersion } from "./api";
import { useRemote } from "./useRemote";
import { ActionButton, ErrorState, InfoBand, LoadingState } from "./Primitives";
import type { JsonRecord, OperationsContext, RunCommand } from "./types";

type Snapshot = { id: string; filename: string; sourceSystem: string; status: string; reviewedBy: string | null; createdBy: string; fileHash: string };
type Rule = { table: string; kind: string; dateField: string | null; amountField: string | null; quantityField: string | null; currencyField: string | null; unitField: string | null; defaultCurrency: string | null; defaultUnit: string | null };
type Policy = { id: string; name: string; kind: string; state: string; definition: { tables: Rule[] } };
type Progress = { snapshotId: string; fileHash: string; version: number; tables: Array<{ name: string; coordinateOnly: boolean; headers: string[] }>; expectedRecords: number; projectedRecords: number; remainingRecords: number; nextRecords: Array<{ id: string; contentHash: string }> };
type Replacement = { previousFingerprint: string; missingRecordHash: string; missingRecordCount: number };
type Pending = { command: string; targetId: string; version: number; data: JsonRecord };
const emptyRule = (table: string): Rule => ({ table, kind: "", dateField: null, amountField: null, quantityField: null, currencyField: null, unitField: null, defaultCurrency: null, defaultUnit: null });
const treatments = [["archive", "Conservar como archivo"], ["invoice", "Factura"], ["sale-line", "Detalle de venta"], ["purchase", "Compra"], ["stock", "Movimiento físico"], ["cash", "Movimiento de dinero"], ["expense", "Gasto"], ["fx", "Cambio de moneda"], ["delivery", "Entrega"]];

/** Reviewed history is published independently of operational balances and opening. */
export function LegacyHistoryWorkflow({ context, refreshKey, runCommand, onRefresh, onNotice }: {
  context: OperationsContext; refreshKey: number; runCommand: RunCommand; onRefresh: () => void; onNotice: (message: string) => void;
}) {
  const allowed = hasCapability(context, "imports.review");
  const sources = useRemote<{ items: Snapshot[] }>(allowed ? "/api/legacy-imports/coverage?limit=100" : null, refreshKey);
  const policies = useRemote<{ items: Policy[]; versions: Record<string, number> }>(allowed ? "/api/operations/configuration" : null, refreshKey);
  const [snapshotId, setSnapshotId] = useState(""), [mappingId, setMappingId] = useState("");
  const [selectedTable, setSelectedTable] = useState(""), [rules, setRules] = useState<Rule[]>([]);
  const [policyName, setPolicyName] = useState(""), [note, setNote] = useState(""), [replacementReason, setReplacementReason] = useState("");
  const [policyVersion, setPolicyVersion] = useState("1");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [pending, setPending] = useState<Pending | null>(null);
  const [revision, setRevision] = useState(0);
  const source = sources.data?.items.find(row => row.id === snapshotId);
  const mapping = policies.data?.items.find(row => row.id === mappingId && row.kind === "legacy_history_mapping");
  const progress = useRemote<Progress>(source ? `/api/legacy-imports/history/projection-status?snapshotId=${encodeURIComponent(source.id)}${mapping?.state === "approved" ? `&mappingId=${encodeURIComponent(mapping.id)}` : ""}` : null, refreshKey + revision);
  const preview = useRemote<{ replacement: Replacement | null }>(source ? `/api/legacy-imports/history/publication-preview?snapshotId=${encodeURIComponent(source.id)}` : null, refreshKey + revision);
  const policyOptions = policies.data?.items.filter(row => row.kind === "legacy_history_mapping") ?? [];
  const tables = progress.data?.tables ?? [], table = tables.find(row => row.name === selectedTable);
  const rule = rules.find(row => row.table === selectedTable) ?? emptyRule(selectedTable);
  const allTablesExplicitlyClassified = tables.length > 0 && tables.every(sourceTable => {
    const selected = rules.find(candidate => candidate.table === sourceTable.name);
    return !!selected?.kind && treatments.some(([kind]) => kind === selected.kind);
  });
  const editable = !busy && !pending;

  useEffect(() => {
    if (!source) { setRules([]); setSelectedTable(""); return; }
    if (progress.data?.snapshotId !== source.id) return;
    setRules(previous => previous.length ? previous : progress.data!.tables.map(row => emptyRule(row.name)));
    setSelectedTable(previous => previous || progress.data!.tables[0]?.name || "");
  }, [source?.id, progress.data]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
  function updateRule(key: keyof Rule, value: string) {
    setRules(previous => previous.map(row => row.table === selectedTable ? { ...row, [key]: value || null } : row));
  }
  async function submit(action: Pending) {
    setBusy(true); setError(""); setPending(action);
    try {
      await runCommand(action.command, action.targetId, action.version, action.data);
      setPending(null); setRevision(value => value + 1); onRefresh();
      onNotice(action.command === "LegacyHistoryPublished" ? "Historia publicada. La apertura operativa continúa separada." : "Tratamiento histórico registrado con su comprobante.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo confirmar la acción.");
      if (!isUncertainCommandOutcome(cause)) setPending(null);
    } finally { setBusy(false); }
  }
  function fieldSelect(key: keyof Rule, label: string) {
    return <label className="ops-field"><span>{label}</span><select value={String(rule[key] ?? "")} onChange={event => updateRule(key, event.target.value)} disabled={!editable || table?.coordinateOnly}>
      <option value="">Sin correspondencia · dato desconocido</option>{table?.headers.map(header => <option key={header} value={header}>{header}</option>)}
    </select></label>;
  }
  if (!allowed) return null;
  const replacement = preview.data?.replacement;
  return <section className="ops-sheet" aria-label="Publicación histórica">
    <div className="ops-sheet-head"><div><span className="ops-kicker">Fuente revisada · reglas aprobadas</span><h3>Publicar historia conservada</h3></div></div>
    <InfoBand title="Historia y apertura"><p>La publicación conserva los hechos anteriores para consulta. Ninguna tabla recibe una clasificación automática: elegí un tratamiento para cada una; los valores ausentes siguen desconocidos. Este paso no crea saldo, stock, deuda ni permisos operativos.</p></InfoBand>
    <div className="ops-form-grid">
      <label className="ops-field"><span>Fuente revisada</span><select value={snapshotId} disabled={!editable} onChange={event => { setSnapshotId(event.target.value); setRules([]); setSelectedTable(""); setError(""); }}>
        <option value="">Elegir una fuente</option>{sources.data?.items.filter(row => row.status === "reviewed" && row.reviewedBy && row.reviewedBy !== row.createdBy).map(row => <option key={row.id} value={row.id}>{row.filename} · {row.sourceSystem} · {row.fileHash.slice(0, 10)}</option>)}
      </select></label>
      <label className="ops-field"><span>Interpretación histórica</span><select value={mappingId} disabled={!editable} onChange={event => { setMappingId(event.target.value); setError(""); }}><option value="">Elegir una versión</option>{policyOptions.map(row => <option key={row.id} value={row.id}>{row.name} · {row.state === "approved" ? "Aprobada" : "Propuesta"}</option>)}</select></label>
      <label className="ops-field"><span>Evidencia de interpretación o publicación</span><textarea value={note} disabled={!editable} onChange={event => setNote(event.target.value)} maxLength={1000} /></label>
    </div>
    {(sources.error || policies.error || progress.error || preview.error || error) && <ErrorState message={error || progress.error || preview.error || sources.error || policies.error} />}
    {progress.loading && <LoadingState label="Comprobando conservación y proyección…" />}
    {pending && <InfoBand tone="warning" title="Comprobante pendiente"><p>Conservá esta pantalla y recuperá la misma solicitud antes de cambiar la fuente o la regla.</p><ActionButton onClick={() => void submit(pending)} disabled={busy}>Recuperar comprobante</ActionButton></InfoBand>}
    {source && progress.data && <>
      <p>{progress.data.projectedRecords} de {progress.data.expectedRecords} registros tratados con la versión seleccionada. Pendientes: {progress.data.remainingRecords}.</p>
      {mapping && <details><summary>Revisar la definición de la versión seleccionada</summary><ul>{mapping.definition.tables.map(row => <li key={row.table}>{row.table}: {treatments.find(([kind]) => kind === row.kind)?.[1] ?? row.kind}; importe {row.amountField ?? "desconocido"}; moneda {row.currencyField ?? row.defaultCurrency ?? "desconocida"}; fecha {row.dateField ?? "desconocida"}; cantidad {row.quantityField ?? "desconocida"}; unidad {row.unitField ?? row.defaultUnit ?? "desconocida"}.</li>)}</ul></details>}
      {hasCommand(context, "ConfigurationProposed") && <details><summary>Proponer una nueva interpretación</summary>
        <p>Seleccioná un tratamiento explícito para cada tabla antes de proponer. Los auxiliares por coordenadas no completan campos automáticamente.</p>
        <div className="ops-form-grid">
          <label className="ops-field"><span>Nombre de la interpretación</span><input value={policyName} maxLength={120} disabled={!editable} onChange={event => setPolicyName(event.target.value)} /></label>
          <label className="ops-field"><span>Versión de la interpretación</span><input type="number" min="1" step="1" value={policyVersion} disabled={!editable} onChange={event => setPolicyVersion(event.target.value)} /></label>
          <label className="ops-field"><span>Tabla a interpretar</span><select value={selectedTable} disabled={!editable} onChange={event => setSelectedTable(event.target.value)}>{tables.map(row => <option key={row.name} value={row.name}>{row.name}{row.coordinateOnly ? " · auxiliar por coordenadas" : ""}</option>)}</select></label>
          <label className="ops-field"><span>Tratamiento</span><select value={rule.kind} disabled={!editable} onChange={event => updateRule("kind", event.target.value)}><option value="">Elegir explícitamente</option>{treatments.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label>
          {fieldSelect("dateField", "Fecha del hecho")}{fieldSelect("amountField", "Base monetaria")}{fieldSelect("currencyField", "Moneda en el origen")}{fieldSelect("quantityField", "Cantidad física")}{fieldSelect("unitField", "Unidad en el origen")}
          <label className="ops-field"><span>Moneda fija aprobable (si no hay columna)</span><select value={rule.defaultCurrency ?? ""} disabled={!editable || !!rule.currencyField || table?.coordinateOnly} onChange={event => updateRule("defaultCurrency", event.target.value)}><option value="">Desconocida</option><option value="ARS">ARS</option><option value="USD">USD</option></select></label>
          <label className="ops-field"><span>Unidad fija aprobable (si no hay columna)</span><select value={rule.defaultUnit ?? ""} disabled={!editable || !!rule.unitField || table?.coordinateOnly} onChange={event => updateRule("defaultUnit", event.target.value)}><option value="">Desconocida</option><option value="g">Gramos</option><option value="ud">Unidades</option></select></label>
        </div>
        <ActionButton disabled={!editable || !policyName.trim() || !note.trim() || !allTablesExplicitlyClassified || !Number.isSafeInteger(Number(policyVersion)) || Number(policyVersion) < 1} onClick={() => void submit({ command: "ConfigurationProposed", targetId: crypto.randomUUID(), version: 0, data: { name: policyName.trim(), kind: "legacy_history_mapping", version: Number(policyVersion), validFrom: new Intl.DateTimeFormat("en-CA", { timeZone: context.timeZone }).format(new Date()), definition: { tables: rules }, evidence: { note: note.trim() } } })}>Proponer interpretación</ActionButton>
      </details>}
      <div className="ops-upload-foot">
        {mapping?.state === "proposed" && context.isOwner && hasCommand(context, "ConfigurationApproved") && <ActionButton disabled={!editable || !note.trim()} onClick={() => void submit({ command: "ConfigurationApproved", targetId: mapping.id, version: responseVersion(policies.data, mapping.id), data: { evidence: { note: note.trim() } } })}>Aprobar interpretación como propietario</ActionButton>}
        {mapping?.state === "approved" && hasCommand(context, "LegacyHistoryProjected") && <ActionButton disabled={!editable || progress.loading || !progress.data.nextRecords.length} onClick={() => void submit({ command: "LegacyHistoryProjected", targetId: source.id, version: progress.data!.version, data: { fileHash: source.fileHash, mappingId: mapping.id, records: progress.data!.nextRecords } })}>Tratar próximo bloque (hasta 500)</ActionButton>}
      </div>
      {replacement && <InfoBand tone="warning" title="Esta publicación sustituye una fuente anterior"><p>Identidades que quedarán fuera: {replacement.missingRecordCount}. La fuente anterior seguirá conservada. Revisá la diferencia y registrá el motivo.</p><label className="ops-field"><span>Motivo de sustitución</span><textarea value={replacementReason} disabled={!editable} onChange={event => setReplacementReason(event.target.value)} minLength={10} maxLength={1000} /></label></InfoBand>}
      {mapping?.state === "approved" && context.isOwner && hasCommand(context, "LegacyHistoryPublished") && <ActionButton disabled={!editable || progress.loading || preview.loading || !!preview.error || !!progress.error || progress.data.remainingRecords !== 0 || !note.trim() || !!replacement && replacementReason.trim().length < 10} onClick={() => void submit({ command: "LegacyHistoryPublished", targetId: source.id, version: progress.data!.version, data: { fileHash: source.fileHash, mappingId: mapping.id, evidence: { note: note.trim() }, ...(replacement ? { replacementReview: { previousFingerprint: replacement.previousFingerprint, missingRecordHash: replacement.missingRecordHash, reason: replacementReason.trim() } } : {}) } })}>Publicar historia aprobada</ActionButton>}
    </>}
  </section>;
}
