import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { hasCapability, hasCommand, isUncertainCommandOutcome } from "./api";
import { ActionButton, DataTable, EmptyState, ErrorState, InfoBand, LoadingState, SectionHeading, StatusTag } from "./Primitives";
import { useRemote } from "./useRemote";
import type { WorkspaceProps } from "./WorkspaceProps";
import type { JsonRecord } from "./types";
import { isTechnicalLegacySource, legacySourceFollowUpObjectId } from "../../shared/operations/source-control";
import type { LegacySourceExceptionPage, LegacySourceExceptionView, LegacySourceFollowUp, LegacySourceFollowUpStatus, LegacySourceRecordView, LegacySourceSummary, LegacySourceTableSummary } from "../../shared/operations/source-control";
import "./sources-workspace.css";

type FollowUpStatus = LegacySourceFollowUpStatus;
type FollowUp = LegacySourceFollowUp;
type SourceTable = LegacySourceTableSummary;
type SourceSummary = LegacySourceSummary;
type SourceList = { items: SourceSummary[]; nextCursor: string | null };
type SourceDetail = { source: SourceSummary; tables?: SourceTable[] };
type SourceException = LegacySourceExceptionView;
type SourceRecord = LegacySourceRecordView;
type RecordPage = { items: SourceRecord[]; nextCursor: string | null };
type ExceptionPage = LegacySourceExceptionPage;
type FollowUpDraft = { status: FollowUpStatus; note: string; evidence: string };
type PendingFollowUp = {
  command: string;
  targetId: string;
  expectedVersion: number;
  data: JsonRecord;
  draft: FollowUpDraft;
};

const statusNames: Record<FollowUpStatus, string> = {
  pending: "Pendiente",
  reviewing: "En revisión",
  explained: "Explicado",
};

function row(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function queryPath(path: string, entries: Record<string, string | null | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value) query.set(key, value);
  return `${path}?${query.toString()}`;
}

function updateQuery(searchParams: URLSearchParams, setSearchParams: (next: URLSearchParams, options?: { replace?: boolean }) => void, changes: Record<string, string | null>, replace = false) {
  const next = new URLSearchParams(searchParams);
  for (const [key, value] of Object.entries(changes)) value ? next.set(key, value) : next.delete(key);
  setSearchParams(next, { replace });
}

function sectionLink(searchParams: URLSearchParams, section: string) {
  const next = new URLSearchParams(searchParams);
  next.set("section", section);
  return `/app/operations?${next.toString()}`;
}

function statusLabel(status: string, source: SourceSummary) {
  if (source.technicalSource || isTechnicalLegacySource(source.sourceSystem)) return "Observación técnica · sin aprobar";
  if (status === "staged") return "Cargada · sin aprobación";
  if (status === "reviewed") return "Revisada";
  return status || "Estado no informado";
}

function technicalSource(source: SourceSummary) {
  return source.technicalSource || isTechnicalLegacySource(source.sourceSystem);
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function prettyValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "Sin dato";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value, null, 2) ?? "Sin dato"; } catch { return "Dato no disponible"; }
}

function CellValue({ value }: { value: unknown }) {
  const cell = row(value);
  if (cell.kind === "excluded_credential_value") return <StatusTag tone="neutral">Valor excluido por seguridad</StatusTag>;
  if (cell.kind === "formula") return <div className="source-formula-value">
    <span>Fórmula</span><pre>{prettyValue(cell.formula)}</pre>
    {Object.hasOwn(cell, "sharedFormula") && <><span>Fórmula compartida</span><pre>{prettyValue(cell.sharedFormula)}</pre></>}
    <span>Resultado almacenado en el archivo</span><pre>{prettyValue(cell.cachedResult)}</pre>
    <small>No se ejecuta ni se recalcula en esta pantalla.</small>
  </div>;
  if (value && typeof value === "object") return <details className="source-cell-structured"><summary>Ver contenido estructurado</summary><pre>{prettyValue(value)}</pre></details>;
  return <span className="source-cell-scalar">{prettyValue(value)}</span>;
}

function FieldValues({ value, title }: { value: unknown; title: string }) {
  const data = row(value);
  const columns = Array.isArray(data.columns) ? data.columns.map(row).filter(column => Object.keys(column).length > 0) : [];
  const extras = Object.fromEntries(Object.entries(data).filter(([key]) => key !== "columns"));
  if (!columns.length && !Object.keys(extras).length) return <section className="source-record-values"><h4>{title}</h4><p>El origen no informó valores para esta fila.</p></section>;
  return <section className="source-record-values">
    <h4>{title}</h4>
    {columns.length > 0 && <>
      <DataTable label={`${title}: celdas de la fila`}>
        <thead><tr><th>Campo</th><th>Coordenada</th><th>Valor</th><th>Precisión y formato del lector</th></tr></thead>
        <tbody>{columns.map((column, index) => {
          const metadata = [
            typeof column.numberFormat === "string" ? `Formato del libro: ${column.numberFormat}` : null,
            typeof column.exactDecimal === "string" ? `Decimal exacto informado: ${column.exactDecimal}` : null,
            typeof column.moneyMinorUnits === "string" ? `Unidades menores registradas: ${column.moneyMinorUnits}` : null,
          ].filter((item): item is string => Boolean(item));
          return <tr key={`${String(column.coordinate ?? "celda")}-${index}`}>
            <td>{typeof column.header === "string" && column.header ? column.header : "Columna sin encabezado"}</td>
            <td><code>{typeof column.coordinate === "string" ? column.coordinate : "Sin coordenada"}</code></td>
            <td><CellValue value={column.value} /></td>
            <td>{metadata.length ? metadata.map(item => <small className="source-cell-meta" key={item}>{item}</small>) : <small>Sin metadatos adicionales</small>}</td>
          </tr>;
        })}</tbody>
      </DataTable>
      <p className="source-value-integrity-note">Las representaciones numéricas aparecen tal como las devolvió el lector; la UI no recalcula importes ni conversiones.</p>
    </>}
    {Object.keys(extras).length > 0 && <details className="source-record-extra"><summary>Ver otros metadatos del bloque</summary><pre>{prettyValue(extras)}</pre></details>}
    {!columns.length && <p>El servidor no informó celdas para este bloque.</p>}
  </section>;
}

function draftFromFollowUp(followUp: FollowUp | null): FollowUpDraft {
  return followUp ? { status: followUp.status, note: followUp.note, evidence: followUp.evidence }
    : { status: "pending", note: "", evidence: "" };
}

function followUpCommand(context: WorkspaceProps["context"]) {
  return hasCommand(context, "LegacySourceFollowUpRecorded") ? "LegacySourceFollowUpRecorded" : null;
}

export function SourcesWorkspace({ context, refreshKey, runCommand, onNotice, onRefresh }: WorkspaceProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const canRead = hasCapability(context, "imports.review");
  const sourceQuery = searchParams.get("sourceQ") ?? "";
  const sourceCursor = searchParams.get("sourceCursor");
  const sourceId = searchParams.get("sourceId");
  const selectedTable = searchParams.get("sourceTable") ?? "";
  const recordQuery = searchParams.get("recordQ") ?? "";
  const exceptionsOnly = searchParams.get("exceptionsOnly") === "true";
  const recordCursor = searchParams.get("recordCursor");
  const recordId = searchParams.get("recordId");
  const exceptionCursor = searchParams.get("exceptionCursor");
  const sourceExceptionCursor = searchParams.get("sourceExceptionCursor");
  const [sourceCursorHistory, setSourceCursorHistory] = useState<string[]>([]);
  const [recordCursorHistory, setRecordCursorHistory] = useState<string[]>([]);
  const [exceptionCursorHistory, setExceptionCursorHistory] = useState<string[]>([]);
  const [sourceExceptionCursorHistory, setSourceExceptionCursorHistory] = useState<string[]>([]);
  const previousSourceId = useRef(sourceId);
  const [revision, setRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, FollowUpDraft>>({});
  const [confirmedFollowUps, setConfirmedFollowUps] = useState<Record<string, FollowUp>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saveNotice, setSaveNotice] = useState("");
  const [pendingFollowUp, setPendingFollowUp] = useState<PendingFollowUp | null>(null);

  const sourcePath = canRead ? queryPath("/api/legacy-imports/source-control", {
    cursor: sourceCursor,
    limit: "25",
    q: sourceQuery.trim() || null,
  }) : null;
  const sourcePage = useRemote<SourceList>(sourcePath, refreshKey + revision);
  const detail = useRemote<SourceDetail>(sourceId && canRead ? `/api/legacy-imports/source-control/${encodeURIComponent(sourceId)}` : null, refreshKey + revision);
  const selectedSource = detail.data?.source ?? sourcePage.data?.items.find(item => item.snapshotId === sourceId) ?? null;
  const unattachedExceptionCount = selectedSource?.unattachedExceptionCount;
  const sourceExceptionsPath = sourceId && canRead && typeof unattachedExceptionCount === "number" && unattachedExceptionCount > 0
    ? queryPath(`/api/legacy-imports/source-control/${encodeURIComponent(sourceId)}/exceptions`, { cursor: sourceExceptionCursor, limit: "50" })
    : null;
  const sourceExceptionPage = useRemote<ExceptionPage>(sourceExceptionsPath, refreshKey + revision);
  const tables = detail.data?.tables ?? selectedSource?.tables ?? [];
  const recordsPath = useMemo(() => sourceId && canRead ? queryPath(`/api/legacy-imports/source-control/${encodeURIComponent(sourceId)}/records`, {
    snapshotTable: selectedTable || null,
    q: recordQuery.trim() || null,
    exceptionOnly: exceptionsOnly ? "true" : null,
    cursor: recordCursor,
    limit: "50",
  }) : null, [sourceId, selectedTable, recordQuery, exceptionsOnly, recordCursor, canRead]);
  const records = useRemote<RecordPage>(recordsPath, refreshKey + revision);
  const recordPage = records.data?.items ?? [];
  const selectedRecord = recordPage.find(item => item.recordId === recordId) ?? null;
  const exceptionsPath = selectedRecord && exceptionCursor ? queryPath(`/api/legacy-imports/source-control/${encodeURIComponent(sourceId ?? "")}/records/${encodeURIComponent(selectedRecord.recordId)}/exceptions`, { cursor: exceptionCursor, limit: "50" }) : null;
  const exceptionPage = useRemote<ExceptionPage>(exceptionsPath, refreshKey + revision);
  const displayedExceptions = exceptionCursor
    ? exceptionPage.data?.items ?? []
    : selectedRecord?.exceptions ?? [];
  const nextExceptionCursor = exceptionCursor
    ? exceptionPage.data?.nextCursor ?? null
    : selectedRecord?.exceptionsNextCursor ?? null;
  const serverFollowUp = selectedRecord?.followUp ?? null;
  const confirmedFollowUp = selectedRecord ? confirmedFollowUps[selectedRecord.recordId] ?? null : null;
  const persistedFollowUp = serverFollowUp && confirmedFollowUp
    ? serverFollowUp.version >= confirmedFollowUp.version ? serverFollowUp : confirmedFollowUp
    : serverFollowUp ?? confirmedFollowUp;
  const currentDraft = selectedRecord ? drafts[selectedRecord.recordId] ?? draftFromFollowUp(persistedFollowUp) : null;
  const canRecordSelectedFollowUp = selectedRecord?.canRecordFollowUp ?? false;
  const command = selectedRecord && canRecordSelectedFollowUp && selectedSource?.allowedActions.recordFollowUp ? followUpCommand(context) : null;

  useEffect(() => {
    setSourceCursorHistory([]);
  }, [sourceQuery]);
  useEffect(() => {
    setRecordCursorHistory([]);
  }, [sourceId, selectedTable, recordQuery, exceptionsOnly]);
  useEffect(() => {
    setExceptionCursorHistory([]);
  }, [recordId]);
  useEffect(() => {
    if (previousSourceId.current === sourceId) return;
    previousSourceId.current = sourceId;
    setSourceExceptionCursorHistory([]);
    if (sourceExceptionCursor) updateQuery(searchParams, setSearchParams, { sourceExceptionCursor: null }, true);
  }, [sourceId, sourceExceptionCursor, searchParams, setSearchParams]);
  useEffect(() => {
    if (!pendingFollowUp) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pendingFollowUp]);

  function editDraft(field: keyof FollowUpDraft, value: string) {
    if (!selectedRecord || !currentDraft) return;
    setDrafts(previous => ({ ...previous, [selectedRecord.recordId]: { ...currentDraft, [field]: value } }));
    setSaveError("");
    setSaveNotice("");
  }

  async function saveFollowUp(action = pendingFollowUp) {
    if (!action) return;
    setSaving(true);
    setSaveError("");
    setSaveNotice("");
    setPendingFollowUp(action);
    let commandConfirmed = false;
    try {
      const receipt = row(await runCommand(action.command, action.targetId, action.expectedVersion, action.data));
      commandConfirmed = true;
      // The command receipt includes the persisted follow-up; keep the original values visible until it confirms.
      onRefresh();
      setRevision(value => value + 1);
      const savedRecordId = typeof action.data.recordId === "string" ? action.data.recordId : "";
      const commandResult = row(receipt.result);
      const stored = row(commandResult.followUp) as Partial<FollowUp>;
      if (commandResult.recordId !== savedRecordId || stored.status !== action.draft.status || stored.note !== action.draft.note.trim() || stored.evidence !== action.draft.evidence.trim() || !Number.isSafeInteger(stored.version) || stored.version !== action.expectedVersion + 1 || typeof stored.updatedAt !== "string" || typeof stored.updatedBy !== "string") {
        setPendingFollowUp(null);
        setSaveNotice("El comando terminó, pero su comprobante no confirmó los datos del seguimiento. Actualizá la fuente antes de iniciar otra edición.");
        return;
      }
      setConfirmedFollowUps(previous => ({ ...previous, [savedRecordId]: stored as FollowUp }));
      setDrafts(previous => { const next = { ...previous }; delete next[savedRecordId]; return next; });
      setPendingFollowUp(null);
      setSaveNotice("Seguimiento guardado y verificado en la fuente.");
      onNotice("Seguimiento guardado y verificado en la fuente.");
    } catch (cause) {
      if (commandConfirmed) {
        setPendingFollowUp(null);
        setSaveNotice("El comprobante del servidor confirmó la escritura, pero no pude volver a leerla. Actualizá la fuente antes de iniciar otro seguimiento.");
      } else {
        setSaveError(cause instanceof Error ? cause.message : "No se pudo confirmar el seguimiento.");
        if (!isUncertainCommandOutcome(cause)) setPendingFollowUp(null);
      }
    } finally {
      setSaving(false);
    }
  }

  function saveCurrentFollowUp() {
    if (!selectedRecord || !currentDraft || !command || saving) return;
    const action: PendingFollowUp = {
      command,
      targetId: legacySourceFollowUpObjectId(selectedRecord.recordId),
      expectedVersion: persistedFollowUp?.version ?? 0,
      data: { snapshotId: sourceId, recordId: selectedRecord.recordId, status: currentDraft.status, note: currentDraft.note.trim(), evidence: currentDraft.evidence.trim() },
      draft: currentDraft,
    };
    void saveFollowUp(action);
  }

  function openSource(source: SourceSummary) {
    if (pendingFollowUp) return;
    setSourceCursorHistory([]);
    setRecordCursorHistory([]);
    setSourceExceptionCursorHistory([]);
    updateQuery(searchParams, setSearchParams, { sourceId: source.snapshotId, sourceTable: null, recordId: null, recordQ: null, exceptionsOnly: null, recordCursor: null, exceptionCursor: null, sourceExceptionCursor: null }, false);
    setSaveError("");
    setSaveNotice("");
  }

  function selectTable(tableName: string) {
    if (pendingFollowUp) return;
    setRecordCursorHistory([]);
    updateQuery(searchParams, setSearchParams, { sourceTable: tableName || null, recordId: null, recordCursor: null, exceptionCursor: null }, false);
  }

  function selectRecord(record: SourceRecord) {
    if (pendingFollowUp) return;
    setExceptionCursorHistory([]);
    updateQuery(searchParams, setSearchParams, { recordId: record.recordId, exceptionCursor: null }, false);
    setSaveError("");
    setSaveNotice("");
  }

  function nextSourcePage() {
    const next = sourcePage.data?.nextCursor;
    if (!next) return;
    setSourceCursorHistory(previous => [...previous, sourceCursor ?? ""]);
    updateQuery(searchParams, setSearchParams, { sourceCursor: next }, false);
  }

  function previousSourcePage() {
    const previous = sourceCursorHistory.at(-1);
    setSourceCursorHistory(history => history.slice(0, -1));
    updateQuery(searchParams, setSearchParams, { sourceCursor: previous || null }, false);
  }

  function nextRecordPage() {
    const next = records.data?.nextCursor;
    if (!next) return;
    setRecordCursorHistory(previous => [...previous, recordCursor ?? ""]);
    updateQuery(searchParams, setSearchParams, { recordCursor: next, recordId: null, exceptionCursor: null }, false);
  }

  function previousRecordPage() {
    const previous = recordCursorHistory.at(-1);
    setRecordCursorHistory(history => history.slice(0, -1));
    updateQuery(searchParams, setSearchParams, { recordCursor: previous || null, recordId: null, exceptionCursor: null }, false);
  }

  function nextExceptionPage() {
    if (!nextExceptionCursor) return;
    setExceptionCursorHistory(previous => [...previous, exceptionCursor ?? ""]);
    updateQuery(searchParams, setSearchParams, { exceptionCursor: nextExceptionCursor }, false);
  }

  function previousExceptionPage() {
    const previous = exceptionCursorHistory.at(-1);
    setExceptionCursorHistory(history => history.slice(0, -1));
    updateQuery(searchParams, setSearchParams, { exceptionCursor: previous || null }, false);
  }

  function nextSourceExceptionPage() {
    const next = sourceExceptionPage.data?.nextCursor;
    if (!next) return;
    setSourceExceptionCursorHistory(previous => [...previous, sourceExceptionCursor ?? ""]);
    updateQuery(searchParams, setSearchParams, { sourceExceptionCursor: next }, false);
  }

  function previousSourceExceptionPage() {
    const previous = sourceExceptionCursorHistory.at(-1);
    setSourceExceptionCursorHistory(history => history.slice(0, -1));
    updateQuery(searchParams, setSearchParams, { sourceExceptionCursor: previous || null }, false);
  }

  if (!canRead) return <InfoBand tone="blocked" title="Acceso restringido"><p>Tu perfil no tiene permiso imports.review para consultar las fuentes importadas.</p></InfoBand>;

  return <div className="source-workspace">
    <SectionHeading eyebrow="Datos de origen · lectura y seguimiento" title="Fuentes importadas" detail="Consultá los archivos recibidos, sus tablas, filas y excepciones. El seguimiento queda auditado aparte y no cambia los valores originales ni crea saldos o stock." />

    <nav className="source-links" aria-label="Ir a la gestión operativa">
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "catalog")}>Catálogo y stock</Link>
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "orders")}>Ventas y pedidos</Link>
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "purchases")}>Compras y recepción</Link>
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "collections")}>Cobros y caja</Link>
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "accounts")}>Cuentas y saldos</Link>
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "finance")}>Estados financieros</Link>
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "reports")}>Informes operativos</Link>
      {(!selectedSource || selectedSource.allowedActions.genericLegacyWorkflow) && <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "imports")}>Importación y conciliación</Link>}
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "configuration")}>Costos y objetivos</Link>
      <Link aria-disabled={!!pendingFollowUp} onClick={event => { if (pendingFollowUp) event.preventDefault(); }} to={sectionLink(searchParams, "gates")}>Habilitación y auditoría</Link>
    </nav>

    <section className="ops-sheet source-list-sheet" aria-labelledby="source-list-title">
      <SectionHeading eyebrow="Archivos cargados" title="Fuentes" detail="El nombre, la fecha y los conteos salen del servidor conectado." />
      <label className="ops-field source-filter"><span>Buscar fuentes</span><input type="search" value={sourceQuery} maxLength={120} disabled={!!pendingFollowUp} placeholder="Nombre de archivo o sistema de origen" onChange={event => updateQuery(searchParams, setSearchParams, { sourceQ: event.target.value || null, sourceCursor: null }, true)} /></label>
      {sourcePage.loading && !sourcePage.data && <LoadingState label="Cargando fuentes…" />}
      {sourcePage.error && !sourcePage.data && <ErrorState message={sourcePage.error} retry={sourcePage.retry} />}
      {sourcePage.loading && sourcePage.data && <p className="source-updating" role="status">Actualizando fuentes…</p>}
      {sourcePage.error && sourcePage.data && <ErrorState message={`No se pudo actualizar la lista. Se conserva la última respuesta recibida. ${sourcePage.error}`} retry={sourcePage.retry} />}
      {!sourcePage.loading && !sourcePage.error && sourcePage.data && sourcePage.data.items.length === 0 && <EmptyState title="No hay fuentes que coincidan" detail={sourceQuery ? "Probá otro nombre de archivo o sistema." : "Todavía no hay fuentes cargadas con acceso para este perfil."} />}
      {sourcePage.data && sourcePage.data.items.length > 0 && <DataTable label="Fuentes importadas">
        <thead><tr><th>Archivo y origen</th><th>Estado</th><th>Filas</th><th>Excepciones</th><th>Revisión</th><th>Checksum</th><th>Acción</th></tr></thead>
        <tbody>{sourcePage.data.items.map(source => {
          const isTechnical = technicalSource(source);
          const isSelected = source.snapshotId === sourceId;
          return <tr key={source.snapshotId} className={isSelected ? "source-row-selected" : undefined}>
            <td><strong>{source.filename}</strong><small>{source.sourceSystem}</small><small>{dateLabel(source.createdAt)}</small></td>
            <td><StatusTag tone={isTechnical ? "warn" : source.status === "reviewed" ? "good" : "neutral"}>{statusLabel(source.status, source)}</StatusTag></td>
            <td>{source.rowCount.toLocaleString("es-AR")}</td>
            <td>{source.exceptionCount.toLocaleString("es-AR")}</td>
            <td>{source.reviewedAt ? <small>Revisada el {dateLabel(source.reviewedAt)}</small> : <small>Sin revisión registrada</small>}</td>
            <td><code title={source.fileHash}>{source.fileHash}</code></td>
            <td><ActionButton quiet disabled={!!pendingFollowUp} onClick={() => openSource(source)}>{isSelected ? "Fuente abierta" : `Ver fuente ${source.filename}`}</ActionButton></td>
          </tr>;
        })}</tbody>
      </DataTable>}
      {sourcePage.data && <div className="source-pagination" aria-label="Paginación de fuentes">
        <ActionButton quiet disabled={!!pendingFollowUp || !sourceCursorHistory.length} onClick={previousSourcePage}>Fuentes anteriores</ActionButton>
        {sourceCursor && !sourceCursorHistory.length && <ActionButton quiet disabled={!!pendingFollowUp} onClick={() => updateQuery(searchParams, setSearchParams, { sourceCursor: null }, false)}>Volver a fuentes recientes</ActionButton>}
        <span>{sourcePage.data.items.length} fuentes en esta página</span>
        <ActionButton quiet disabled={!!pendingFollowUp || !sourcePage.data.nextCursor || sourcePage.loading} onClick={nextSourcePage}>Fuentes siguientes</ActionButton>
      </div>}
    </section>

    {sourceId && <>
      {detail.loading && !detail.data && <LoadingState label="Cargando detalle de la fuente…" />}
      {detail.error && !detail.data && <ErrorState message={detail.error} retry={detail.retry} />}
      {selectedSource && <section className="ops-sheet source-detail-sheet" aria-labelledby="source-detail-title">
        <SectionHeading eyebrow="Identidad y cobertura" title={selectedSource.filename} detail={`${selectedSource.sourceSystem} · ${dateLabel(selectedSource.createdAt)}`} action={<ActionButton quiet disabled={!!pendingFollowUp} onClick={() => updateQuery(searchParams, setSearchParams, { sourceId: null, sourceTable: null, recordId: null, recordCursor: null, exceptionCursor: null, sourceExceptionCursor: null }, false)}>Cerrar fuente</ActionButton>} />
        <div className="source-source-facts">
          <div><span>Estado informado</span><strong>{statusLabel(selectedSource.status, selectedSource)}</strong></div>
          <div><span>Filas de origen</span><strong>{selectedSource.rowCount.toLocaleString("es-AR")}</strong></div>
          <div><span>Excepciones</span><strong>{selectedSource.exceptionCount.toLocaleString("es-AR")}</strong></div>
          <div><span>Checksum SHA-256</span><code>{selectedSource.fileHash}</code></div>
          <div><span>ID de la carga</span><code>{selectedSource.snapshotId}</code></div>
          <div><span>Versión del lector</span><code>{selectedSource.importerVersion}</code></div>
        </div>
        {technicalSource(selectedSource) && <InfoBand tone="warning" title="Fuente técnica en observación"><p>Los datos se pueden consultar y seguir. Esta fuente no se puede revisar, mapear ni publicar como historia operativa; tampoco establece stock, caja, saldos ni aprobación.</p></InfoBand>}
        <div className="source-tables-block">
          <h3>Tablas del archivo</h3>
          {!tables.length ? <EmptyState title="El servidor no informó tablas" detail="Reintentá la lectura de esta fuente para comprobar su cobertura." action={<ActionButton quiet onClick={detail.retry}>Reintentar</ActionButton>} /> : <DataTable label="Tablas de la fuente seleccionada">
            <thead><tr><th>Tabla</th><th>Filas</th><th>Excepciones</th><th>Acción</th></tr></thead>
            <tbody>{tables.map(table => <tr key={table.tableName} className={selectedTable === table.tableName ? "source-row-selected" : undefined}>
              <td><strong>{table.tableName}</strong></td><td>{table.rowCount.toLocaleString("es-AR")}</td><td>{table.exceptionCount.toLocaleString("es-AR")}</td>
              <td><ActionButton quiet disabled={!!pendingFollowUp} onClick={() => selectTable(selectedTable === table.tableName ? "" : table.tableName)}>{selectedTable === table.tableName ? "Ver todas las tablas" : `Ver filas de ${table.tableName}`}</ActionButton></td>
            </tr>)}</tbody>
          </DataTable>}
        </div>
        {!!selectedSource.coordinateOnlySheets?.length && <section className="source-coordinate-only" aria-labelledby="source-coordinate-title">
          <div><h3 id="source-coordinate-title">Hojas auxiliares pendientes de interpretación</h3><p>El inventario del archivo conserva sólo el nombre y la dimensión disponible. No se extrajeron sus valores y esta lista no representa registros ni datos financieros.</p></div>
          <DataTable label="Hojas auxiliares sin valores extraídos">
            <thead><tr><th>Hoja</th><th>Dimensión informada</th><th>Valores</th></tr></thead>
            <tbody>{selectedSource.coordinateOnlySheets.map(sheet => <tr key={sheet.name}><td>{sheet.name}</td><td>{sheet.dimension ?? "Dimensión no informada"}</td><td>Sin valores extraídos</td></tr>)}</tbody>
          </DataTable>
        </section>}
        <section className="source-unattached-exceptions" aria-labelledby="source-unattached-exceptions-title">
          <div className="source-unattached-exceptions-heading">
            <div><h3 id="source-unattached-exceptions-title">Excepciones de la fuente sin fila</h3><p>Se consultan aparte porque el archivo no vinculó estas excepciones con una fila de origen.</p></div>
            {typeof unattachedExceptionCount === "number" && <StatusTag tone={unattachedExceptionCount ? "warn" : "good"}>{unattachedExceptionCount.toLocaleString("es-AR")} {unattachedExceptionCount === 1 ? "excepción" : "excepciones"}</StatusTag>}
          </div>
          {typeof unattachedExceptionCount !== "number" ? <InfoBand tone="warning" title="Conteo no informado"><p>El servidor todavía no informó cuántas excepciones quedaron sin fila; no se interpreta la ausencia del dato como cero.</p></InfoBand>
            : unattachedExceptionCount === 0 ? <EmptyState title="Sin excepciones fuera de filas" detail="El servidor informó cero excepciones de la fuente sin fila asociada." /> : <>
              {sourceExceptionPage.loading && !sourceExceptionPage.data && <LoadingState label="Cargando excepciones de la fuente…" />}
              {sourceExceptionPage.error && !sourceExceptionPage.data && <ErrorState message={sourceExceptionPage.error} retry={sourceExceptionPage.retry} />}
              {sourceExceptionPage.loading && sourceExceptionPage.data && <p className="source-updating" role="status">Actualizando excepciones de la fuente…</p>}
              {sourceExceptionPage.error && sourceExceptionPage.data && <ErrorState message={`No se pudo actualizar la página. Se conserva la última respuesta recibida. ${sourceExceptionPage.error}`} retry={sourceExceptionPage.retry} />}
              {!sourceExceptionPage.loading && !sourceExceptionPage.error && sourceExceptionPage.data?.items.length === 0 && <EmptyState title="Sin resultados para este cursor" detail="El conteo de excepciones de la fuente no cambió, pero el servidor no devolvió elementos en esta página." />}
              {sourceExceptionPage.data && sourceExceptionPage.data.items.length > 0 && <DataTable label="Excepciones de la fuente sin fila">
                <thead><tr><th>Identidad</th><th>Tipo</th><th>Gravedad</th><th>Estado</th></tr></thead>
                <tbody>{sourceExceptionPage.data.items.map(exception => <tr key={exception.exceptionId}><td><code>{exception.exceptionId}</code></td><td><code>{exception.code}</code></td><td>{exception.severity}</td><td>{exception.status}</td></tr>)}</tbody>
              </DataTable>}
              {(sourceExceptionPage.data || sourceExceptionCursor) && <div className="source-pagination" aria-label="Paginación de excepciones sin fila">
                <ActionButton quiet disabled={!sourceExceptionCursorHistory.length} onClick={previousSourceExceptionPage}>Excepciones anteriores</ActionButton>
                {sourceExceptionCursor && !sourceExceptionCursorHistory.length && <ActionButton quiet onClick={() => updateQuery(searchParams, setSearchParams, { sourceExceptionCursor: null }, false)}>Volver a las primeras excepciones</ActionButton>}
                {sourceExceptionPage.data && <span>{sourceExceptionPage.data.items.length} en esta página · {unattachedExceptionCount.toLocaleString("es-AR")} sin fila</span>}
                <ActionButton quiet disabled={!sourceExceptionPage.data?.nextCursor || sourceExceptionPage.loading} onClick={nextSourceExceptionPage}>Excepciones siguientes</ActionButton>
              </div>}
            </>}
        </section>
      </section>}

      {selectedSource && <section className="ops-sheet source-records-sheet" aria-labelledby="source-records-title">
        <SectionHeading eyebrow="Registro conservado" title="Filas y excepciones" detail="La búsqueda y los filtros se aplican en el servidor a la fuente completa, no sólo a las filas de esta página." />
        <div className="source-record-filters">
          <label className="ops-field"><span>Buscar en filas</span><input type="search" value={recordQuery} maxLength={120} disabled={!!pendingFollowUp} placeholder="Buscar en valores permitidos del origen" onChange={event => updateQuery(searchParams, setSearchParams, { recordQ: event.target.value || null, recordCursor: null, recordId: null, exceptionCursor: null }, true)} /></label>
          <label className="ops-field"><span>Tabla de origen</span><select value={selectedTable} disabled={!!pendingFollowUp} onChange={event => selectTable(event.target.value)}><option value="">Todas las tablas</option>{tables.map(table => <option key={table.tableName} value={table.tableName}>{table.tableName} · {table.rowCount.toLocaleString("es-AR")} filas</option>)}</select></label>
          <label className="source-checkbox"><input type="checkbox" checked={exceptionsOnly} disabled={!!pendingFollowUp} onChange={event => updateQuery(searchParams, setSearchParams, { exceptionsOnly: event.target.checked ? "true" : null, recordCursor: null, recordId: null, exceptionCursor: null }, false)} /><span>Sólo filas con excepciones</span></label>
        </div>
        {records.loading && !records.data && <LoadingState label="Buscando filas en el servidor…" />}
        {records.error && !records.data && <ErrorState message={records.error} retry={records.retry} />}
        {records.loading && records.data && <p className="source-updating" role="status">Actualizando filas…</p>}
        {records.error && records.data && <ErrorState message={`No se pudo actualizar la búsqueda. Se conserva la última respuesta recibida. ${records.error}`} retry={records.retry} />}
        {!records.loading && !records.error && records.data && records.data.items.length === 0 && <EmptyState title="No hay filas que coincidan" detail="Probá quitar el filtro de excepciones, elegir otra tabla o cambiar la búsqueda." />}
        {records.data && records.data.items.length > 0 && <DataTable label="Filas de la fuente seleccionada">
          <thead><tr><th>Tabla y fila</th><th>Tratamiento</th><th>Identidad de origen</th><th>Excepciones</th><th>Seguimiento</th><th>Acción</th></tr></thead>
          <tbody>{recordPage.map(record => {
            const followUp = confirmedFollowUps[record.recordId] ?? record.followUp;
            return <tr key={record.recordId} className={record.recordId === recordId ? "source-row-selected" : undefined}>
              <td><strong>{record.tableName}</strong><small>Fila {record.rowNumber}</small></td>
              <td>{record.treatment || "Sin clasificación informada"}</td>
              <td><code title={record.recordId}>{record.recordId}</code></td>
              <td>{record.exceptionCount === 0 ? <StatusTag>Sin excepción</StatusTag> : <StatusTag tone="warn">{record.exceptionCount} {record.exceptionCount === 1 ? "excepción" : "excepciones"}</StatusTag>}</td>
              <td>{followUp ? <StatusTag tone={followUp.status === "explained" ? "good" : "neutral"}>{statusNames[followUp.status]}</StatusTag> : <StatusTag>Sin seguimiento</StatusTag>}</td>
              <td><ActionButton quiet disabled={!!pendingFollowUp} onClick={() => selectRecord(record)}>{record.recordId === recordId ? "Fila abierta" : `Ver fila ${record.tableName} ${record.rowNumber}`}</ActionButton></td>
            </tr>;
          })}</tbody>
        </DataTable>}
        {records.data && <div className="source-pagination" aria-label="Paginación de filas">
          <ActionButton quiet disabled={!!pendingFollowUp || !recordCursorHistory.length} onClick={previousRecordPage}>Filas anteriores</ActionButton>
          {recordCursor && !recordCursorHistory.length && <ActionButton quiet disabled={!!pendingFollowUp} onClick={() => updateQuery(searchParams, setSearchParams, { recordCursor: null, recordId: null, exceptionCursor: null }, false)}>Volver a las primeras filas</ActionButton>}
          <span>{records.data.items.length} filas en esta página</span>
          <ActionButton quiet disabled={!!pendingFollowUp || !records.data.nextCursor || records.loading} onClick={nextRecordPage}>Filas siguientes</ActionButton>
        </div>}
      </section>}
    </>}

    {sourceId && recordId && <>
      {records.loading && !records.data && <LoadingState label="Cargando fila seleccionada…" />}
      {selectedRecord && <section className="ops-sheet source-record-detail" aria-labelledby="source-record-title">
        <SectionHeading eyebrow={`${selectedRecord.tableName} · fila ${selectedRecord.rowNumber}`} title="Detalle de fila" detail={`Identidad de origen: ${selectedRecord.recordId}`} action={<ActionButton quiet disabled={!!pendingFollowUp} onClick={() => updateQuery(searchParams, setSearchParams, { recordId: null, exceptionCursor: null }, false)}>Cerrar detalle</ActionButton>} />
        <InfoBand title="Registro original conservado"><p>Los valores originales y los datos interpretados se muestran tal como el servidor los permite consultar. Esta pantalla no edita ni reemplaza la fila importada.</p></InfoBand>
        <div className="source-record-values-grid">
          <FieldValues title="Valores originales" value={selectedRecord.original} />
          <FieldValues title="Datos interpretados" value={selectedRecord.normalized} />
        </div>
        <section className="source-exceptions" aria-labelledby="source-exceptions-title">
          <h3 id="source-exceptions-title">Excepciones</h3>
          {selectedRecord.exceptionCount === 0 ? <StatusTag tone="good">Sin excepciones informadas</StatusTag> : <>
            {exceptionPage.loading && <LoadingState label="Cargando excepciones…" />}
            {exceptionPage.error && <ErrorState message={exceptionPage.error} retry={exceptionPage.retry} />}
            {displayedExceptions.length > 0 ? <DataTable label="Excepciones de la fila seleccionada">
              <thead><tr><th>Identidad</th><th>Tipo</th><th>Gravedad</th><th>Estado</th></tr></thead>
              <tbody>{displayedExceptions.map(exception => <tr key={exception.exceptionId}><td><code>{exception.exceptionId}</code></td><td><code>{exception.code}</code></td><td>{exception.severity}</td><td>{exception.status}</td></tr>)}</tbody>
            </DataTable> : !exceptionPage.loading && !exceptionPage.error && <EmptyState title="No hay excepciones en esta página" detail="El servidor no devolvió filas de excepción para este cursor." />}
            <div className="source-pagination" aria-label="Paginación de excepciones">
              <ActionButton quiet disabled={!exceptionCursorHistory.length} onClick={previousExceptionPage}>Excepciones anteriores</ActionButton>
              {exceptionCursor && !exceptionCursorHistory.length && <ActionButton quiet onClick={() => updateQuery(searchParams, setSearchParams, { exceptionCursor: null }, false)}>Volver a las primeras excepciones</ActionButton>}
              <span>{displayedExceptions.length} de {selectedRecord.exceptionCount} excepciones</span>
              <ActionButton quiet disabled={!nextExceptionCursor || exceptionPage.loading} onClick={nextExceptionPage}>Excepciones siguientes</ActionButton>
            </div>
          </>}
        </section>
        <section className="source-follow-up" aria-labelledby="source-follow-up-title">
          <div><span className="ops-kicker">Anotación auditable · recurso separado</span><h3 id="source-follow-up-title">Seguimiento</h3><p>La nota y la evidencia agregan contexto a la fila. “Explicado” no aprueba la fuente ni resuelve una excepción técnica.</p></div>
          {persistedFollowUp && <p className="source-follow-up-meta">Último seguimiento {statusNames[persistedFollowUp.status].toLowerCase()} · versión {persistedFollowUp.version}{persistedFollowUp.updatedAt ? ` · ${dateLabel(persistedFollowUp.updatedAt)}` : ""}</p>}
          {currentDraft && <div className="source-follow-up-form">
            <label className="ops-field"><span>Estado del seguimiento</span><select value={currentDraft.status} disabled={!command || saving || !!pendingFollowUp} onChange={event => editDraft("status", event.target.value as FollowUpStatus)}><option value="pending">Pendiente</option><option value="reviewing">En revisión</option><option value="explained">Explicado</option></select></label>
            <label className="ops-field"><span>Nota de seguimiento</span><textarea value={currentDraft.note} maxLength={2000} disabled={!command || saving || !!pendingFollowUp} onChange={event => editDraft("note", event.target.value)} placeholder="Contexto para la revisión del registro" /></label>
            <label className="ops-field"><span>Evidencia del seguimiento (opcional)</span><textarea value={currentDraft.evidence} maxLength={2000} disabled={!command || saving || !!pendingFollowUp} onChange={event => editDraft("evidence", event.target.value)} placeholder="Referencia verificable o ubicación de evidencia" /></label>
          </div>}
          {selectedRecord && !canRecordSelectedFollowUp && <InfoBand tone="warning" title="Seguimiento de sólo lectura"><p>Tu perfil puede consultar esta fila, pero no registrar cambios de seguimiento en ella.</p></InfoBand>}
          {selectedRecord && canRecordSelectedFollowUp && !command && <InfoBand tone="warning" title="Seguimiento sin permiso de escritura"><p>Tu perfil no tiene habilitado el comando específico de seguimiento. La fila y sus excepciones siguen disponibles para consulta.</p></InfoBand>}
          {saveError && <ErrorState message={saveError} />}
          {saveError && !pendingFollowUp && <ActionButton quiet onClick={() => { onRefresh(); setRevision(value => value + 1); }}>Actualizar fila del servidor</ActionButton>}
          {saveNotice && <InfoBand tone={saveNotice.startsWith("Seguimiento guardado") ? "info" : "warning"} title="Resultado del seguimiento"><p>{saveNotice}</p></InfoBand>}
          {pendingFollowUp && <InfoBand tone="warning" title="Comprobante pendiente"><p>La conexión no confirmó el resultado. Conservé la nota y la evidencia; recuperá la misma solicitud antes de cambiar los datos.</p><ActionButton onClick={() => void saveFollowUp(pendingFollowUp)} disabled={saving}>Recuperar el mismo seguimiento</ActionButton></InfoBand>}
          {command && currentDraft && <ActionButton onClick={saveCurrentFollowUp} disabled={saving || !!pendingFollowUp || !currentDraft.note.trim()}>{saving ? "Guardando…" : persistedFollowUp ? "Guardar cambios del seguimiento" : "Guardar seguimiento"}</ActionButton>}
        </section>
      </section>}
      {records.error && !selectedRecord && <ErrorState message={records.error} retry={records.retry} />}
      {records.data && !selectedRecord && <EmptyState title="La fila no está en esta página" detail="Puede haber cambiado la búsqueda o el filtro. Volvé a seleccionar una fila desde el resultado actual." action={<ActionButton quiet onClick={() => updateQuery(searchParams, setSearchParams, { recordId: null }, false)}>Ver filas actuales</ActionButton>} />}
    </>}
  </div>;
}
