import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { z } from "zod";
import { apiGet, hasCapability, hasCommand, isUncertainCommandOutcome, OperationsApiError } from "./api";
import { ErrorState, InfoBand, StatusTag } from "./Primitives";
import type { JsonRecord, OperationsContext, RunCommand } from "./types";

const MAX_REVIEW_PLAN_BYTES = 100_000;
const reviewCommands = [
  "AppSheetHistorySourceReviewed",
  "AppSheetPendingOrderIdentityReviewed",
  "AppSheetPendingDeliveryResolved",
  "AppSheetPendingImportPlanReviewed",
  "AppSheetPendingImportDestinationReviewed",
] as const;

const reviewPlanSchema = z.strictObject({
  command: z.enum(reviewCommands),
  targetId: z.string().min(1).max(100).refine(value => value.trim().length > 0),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  data: z.record(z.string(), z.unknown()),
});

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);
const destinationPreviewSchema = z.strictObject({
  batchId: z.string().min(1).max(100),
  status: z.literal("staged"),
  expectedVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  captureId: z.string().regex(/^appsreal-[a-f0-9]{16}$/i),
  manifestHash: sha256Schema,
  dataHash: sha256Schema,
  projectionHash: sha256Schema,
  dispositionHash: sha256Schema,
  destinationHash: sha256Schema,
  dispositionCount: z.number().int().min(0),
  legacySettlementCount: z.number().int().min(0),
  pendingDeliveryAssignmentCount: z.number().int().min(0),
});

type ReviewPlan = z.infer<typeof reviewPlanSchema>;
type ReviewCommand = ReviewPlan["command"];
type DestinationPreview = z.infer<typeof destinationPreviewSchema>;
type DestinationPreviewState =
  | { status: "idle" | "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; preview: DestinationPreview };

const commandLabels: Record<ReviewCommand, string> = {
  AppSheetHistorySourceReviewed: "Registrar revisión de origen AppSheet",
  AppSheetPendingOrderIdentityReviewed: "Vincular factura con pedido existente",
  AppSheetPendingDeliveryResolved: "Resolver relación de entrega",
  AppSheetPendingImportPlanReviewed: "Revisar plan de importación",
  AppSheetPendingImportDestinationReviewed: "Revisar destino y crear entregas pendientes",
};

const commandKinds: Record<ReviewCommand, string> = {
  AppSheetHistorySourceReviewed: "Revisión de una captura de origen",
  AppSheetPendingOrderIdentityReviewed: "Revisión del vínculo entre factura y pedido",
  AppSheetPendingDeliveryResolved: "Revisión del vínculo de una entrega",
  AppSheetPendingImportPlanReviewed: "Revisión del plan por alguien distinto del importador y los mapeadores",
  AppSheetPendingImportDestinationReviewed: "Revisión del destino por alguien distinto del importador y los mapeadores",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsForbiddenEnvelopeFields(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenEnvelopeFields);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return normalized === "actorid" || normalized === "requestid" || normalized.includes("token") ||
      normalized === "authorization" || containsForbiddenEnvelopeFields(nested);
  });
}

const reviewMetadataLabels: Record<string, string> = {
  captureId: "Captura AppSheet",
  snapshotId: "Snapshot",
  historySnapshotId: "Snapshot de historia",
  importerId: "Importador (ID)",
  importer: "Importador (ID)",
  target: "Destino revisado",
  destinationIdentity: "Identidad del destino",
  commitSha: "Commit revisado",
  backupSnapshotAt: "Respaldo registrado",
  reviewKind: "Tipo de revisión",
  kind: "Tipo de revisión",
  reviewer: "Revisor (ID)",
  approved: "Aprobación declarada",
  reviewedAt: "Fecha de revisión",
  sourceRecordId: "Registro de origen",
  invoiceRecordId: "Registro de factura",
  operationOrderId: "Pedido operativo asociado",
  operationOrderVersion: "Versión del pedido",
  destinationVersion: "Versión del destino",
};

const reviewHashLabels: Record<string, string> = {
  fileHash: "Hash del archivo",
  manifestHash: "Hash del manifiesto",
  dataHash: "Hash de datos",
  definitionHash: "Hash de definición",
  projectionHash: "Hash de proyección",
  sourceRecordHash: "Hash del registro de origen",
  sourceKeyHash: "Hash de la clave de origen",
  reconciliationHash: "Hash de conciliación",
  mappingHash: "Hash del mapeo",
  sourceSpecHash: "Hash de especificación de origen",
  invoiceRecordHash: "Hash del registro de factura",
  operationOrderHash: "Hash del pedido operativo",
  evidenceHash: "Hash de evidencia",
  sourceCoverageHash: "Hash de cobertura de origen",
  dispositionHash: "Hash de disposiciones",
  destinationHash: "Hash del destino",
  backupManifestHash: "Hash del respaldo",
};

const reviewCountLabels: Record<string, string> = {
  sourceRecordCount: "Registros de origen",
  dispositionCount: "Disposiciones",
  recordCount: "Registros",
  factCount: "Hechos revisados",
  exceptionCount: "Excepciones",
  records: "Registros",
  facts: "Hechos revisados",
  openExceptions: "Excepciones abiertas",
  sheets: "Hojas",
  pages: "Páginas",
  formulas: "Fórmulas",
  unresolvedFormulas: "Fórmulas sin resolver",
  tables: "Tablas",
  columns: "Columnas",
  slices: "Slices",
  views: "Vistas",
  actions: "Acciones",
  bots: "Bots",
};

function reviewSources(data: JsonRecord): Array<{ label: string; value: JsonRecord }> {
  return [
    { label: "", value: data },
    ...(isRecord(data.review) ? [{ label: "Revisión · ", value: data.review }] : []),
  ];
}

function displayScalar(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > 240 ? `${trimmed.slice(0, 237)}…` : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return null;
}

function visibleMetadata(data: JsonRecord): Array<[string, string, string]> {
  const found = new Map<string, [string, string, string]>();
  for (const { label: prefix, value } of reviewSources(data)) {
    for (const [key, label] of Object.entries(reviewMetadataLabels)) {
      const rendered = displayScalar(value[key]);
      if (rendered) found.set(`${label}:${rendered}`, [prefix, label, rendered]);
    }
    for (const [key, label] of Object.entries(reviewHashLabels)) {
      const hash = value[key];
      if (typeof hash === "string" && /^[a-f0-9]{40,64}$/i.test(hash)) {
        found.set(`${label}:${hash}`, [prefix, label, hash]);
      }
    }
  }
  return [...found.values()].slice(0, 32);
}

function visibleCounts(data: JsonRecord): Array<[string, number]> {
  const found = new Map<string, number>();
  for (const { value } of reviewSources(data)) {
    const sources = [value, ...(isRecord(value.counts) ? [value.counts] : [])];
    for (const source of sources) {
      for (const [key, label] of Object.entries(reviewCountLabels)) {
        const count = source[key];
        if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) found.set(label, count);
        else if (key === "tables" && Array.isArray(count)) found.set(label, count.length);
      }
    }
  }
  return [...found.entries()];
}

function visibleCellReferences(data: JsonRecord): Array<[string, string, string]> {
  const labels: Record<string, string> = {
    motoKeyCell: "Clave de moto",
    invoiceReferenceCell: "Referencia de factura",
    invoiceKeyCell: "Clave de factura",
    invoiceAddressCell: "Campo de dirección",
  };
  const references: Array<[string, string, string]> = [];
  for (const key of Object.keys(labels)) {
    const cell = data[key];
    if (!isRecord(cell)) continue;
    const name = typeof cell.header === "string" ? cell.header.trim() : "";
    const coordinate = typeof cell.coordinate === "string" ? cell.coordinate.trim() : "";
    if (name && coordinate) references.push([labels[key]!, name.slice(0, 80), coordinate.slice(0, 20)]);
  }
  return references;
}

function visibleEvidence(data: JsonRecord): Array<[string, string]> {
  const evidence: Array<[string, string]> = [];
  for (const { label, value } of reviewSources(data)) {
    for (const key of ["evidence", "evidenceReference"]) {
      const raw = value[key];
      if (typeof raw === "string" && raw.trim()) {
        evidence.push([`${label}${key === "evidenceReference" ? "Referencia de evidencia" : "Evidencia de revisión"}`, raw.trim()]);
      }
    }
  }
  for (const { label, value } of reviewSources(data)) {
    if (Array.isArray(value.findings)) {
      for (const finding of value.findings) {
        if (typeof finding === "string" && finding.trim()) evidence.push([`${label}Hallazgo de revisión`, finding.trim()]);
      }
    }
  }
  return evidence;
}

function evidenceLimitIssues(data: JsonRecord, ignoreSourceReference = false): string[] {
  const issues: string[] = [];
  for (const { value } of reviewSources(data)) {
    if (value.evidence !== undefined && (typeof value.evidence !== "string" || value.evidence.length > 1_000)) issues.push("evidence");
    if (!(ignoreSourceReference && value === data) && value.evidenceReference !== undefined &&
        (typeof value.evidenceReference !== "string" || value.evidenceReference.length > 2_000)) {
      issues.push("evidenceReference");
    }
    if (value.findings !== undefined && (!Array.isArray(value.findings) ||
        value.findings.some(item => typeof item !== "string" || item.length > 500))) issues.push("findings");
  }
  return [...new Set(issues)];
}

function fileErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "review_plan_size_invalid") return "El archivo debe contener entre 1 y 100 KB.";
  if (error instanceof z.ZodError) return "El JSON no coincide con el sobre de revisión permitido: command, targetId, expectedVersion y data.";
  if (error instanceof Error && error.message === "review_plan_encoding_invalid") return "El archivo no es JSON UTF-8 válido.";
  if (error instanceof Error && error.message === "review_plan_json_invalid") return "El archivo no contiene JSON válido.";
  if (error instanceof Error && error.message === "review_plan_private_fields_invalid") return "El JSON no puede incluir token, actorId ni requestId; la identidad y el UUID salen de la sesión y del ejecutor autenticado.";
  return "No se pudo cargar el plan de revisión.";
}

export function AppSheetMigrationReviewPanel({ context, runCommand, onRefresh, onNotice }: {
  context: OperationsContext;
  runCommand: RunCommand;
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ReviewPlan | null>(null);
  const [filename, setFilename] = useState("");
  const [sourceEvidence, setSourceEvidence] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [destinationPreview, setDestinationPreview] = useState<DestinationPreviewState>({ status: "idle" });
  const [previewReloadToken, setPreviewReloadToken] = useState(0);
  const previewGeneration = useRef(0);
  const canReview = hasCapability(context, "imports.review");

  useEffect(() => {
    if (!canReview || draft?.command !== "AppSheetPendingImportDestinationReviewed") {
      setDestinationPreview({ status: "idle" });
      return;
    }

    const generation = ++previewGeneration.current;
    const controller = new AbortController();
    setDestinationPreview({ status: "loading" });
    void apiGet<unknown>(`/api/operations/appsheet-pending-imports/${encodeURIComponent(draft.targetId)}/review-preview`, {
      signal: controller.signal,
    }).then(raw => {
      const parsed = destinationPreviewSchema.safeParse(raw);
      if (!parsed.success) throw new Error("destination_review_preview_invalid");
      if (previewGeneration.current === generation) setDestinationPreview({ status: "ready", preview: parsed.data });
    }).catch(cause => {
      if (controller.signal.aborted || previewGeneration.current !== generation) return;
      const message = cause instanceof Error && cause.message !== "destination_review_preview_invalid"
        ? cause.message
        : "La respuesta de vista previa no coincide con el contrato. Cargá el plan vigente antes de revisar el destino.";
      setDestinationPreview({ status: "error", message });
    });

    return () => {
      previewGeneration.current += 1;
      controller.abort();
    };
  }, [canReview, draft, previewReloadToken]);

  const availableCommands = reviewCommands.filter(command => hasCommand(context, command));
  const draftCommandAvailable = Boolean(draft && availableCommands.includes(draft.command));
  const metadata = draft ? visibleMetadata(draft.data) : [];
  const counts = draft ? visibleCounts(draft.data) : [];
  const cellReferences = draft ? visibleCellReferences(draft.data) : [];
  const evidence = draft && draft.command !== "AppSheetHistorySourceReviewed" ? visibleEvidence(draft.data) : [];
  const evidenceIssues = draft ? evidenceLimitIssues(draft.data, draft.command === "AppSheetHistorySourceReviewed") : [];
  const sourceEvidenceTooLong = draft?.command === "AppSheetHistorySourceReviewed" && sourceEvidence.length > 2_000;
  const previewReview = draft?.command === "AppSheetPendingImportDestinationReviewed" && isRecord(draft.data.review)
    ? draft.data.review
    : null;
  const previewMatchesDraft = destinationPreview.status === "ready" && Boolean(
    draft?.command === "AppSheetPendingImportDestinationReviewed" && previewReview &&
    destinationPreview.preview.batchId === draft.targetId &&
    destinationPreview.preview.expectedVersion === draft.expectedVersion &&
    destinationPreview.preview.captureId === previewReview.captureId &&
    destinationPreview.preview.manifestHash === previewReview.manifestHash &&
    destinationPreview.preview.dataHash === previewReview.dataHash &&
    destinationPreview.preview.projectionHash === previewReview.projectionHash &&
    destinationPreview.preview.dispositionHash === previewReview.dispositionHash &&
    destinationPreview.preview.destinationHash === previewReview.destinationHash
  );
  const destinationReviewReady = draft?.command !== "AppSheetPendingImportDestinationReviewed" || previewMatchesDraft;

  async function loadReviewPlan(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      if (file.size <= 0 || file.size > MAX_REVIEW_PLAN_BYTES) throw new Error("review_plan_size_invalid");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== file.size || bytes.byteLength > MAX_REVIEW_PLAN_BYTES) throw new Error("review_plan_size_invalid");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("review_plan_encoding_invalid"); }
      let raw: unknown;
      try { raw = JSON.parse(text) as unknown; }
      catch { throw new Error("review_plan_json_invalid"); }
      const parsed = reviewPlanSchema.parse(raw);
      if (containsForbiddenEnvelopeFields(parsed.data)) throw new Error("review_plan_private_fields_invalid");
      if (parsed.command === "AppSheetHistorySourceReviewed" && parsed.data.evidenceReference !== undefined &&
          typeof parsed.data.evidenceReference !== "string") throw new Error("review_plan_json_invalid");
      setDestinationPreview(parsed.command === "AppSheetPendingImportDestinationReviewed" ? { status: "loading" } : { status: "idle" });
      setDraft(parsed);
      setFilename(file.name);
      setSourceEvidence(parsed.command === "AppSheetHistorySourceReviewed" && typeof parsed.data.evidenceReference === "string"
        ? parsed.data.evidenceReference
        : "");
    } catch (cause) {
      const message = fileErrorMessage(cause);
      setError(draft ? `${message} Se conserva el borrador anterior.` : message);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !canReview || !draftCommandAvailable || busy) return;
    if (!destinationReviewReady) {
      setError("La vista previa del lote no coincide con este plan. Actualizá la vista previa o cargá el plan vigente; no se envió el comando.");
      return;
    }
    if (evidenceIssues.length) {
      setError("La evidencia supera el límite aceptado por el servidor. Corregí el archivo del plan antes de registrarlo; no se envió el comando.");
      return;
    }
    const data: JsonRecord = { ...draft.data };
    if (draft.command === "AppSheetHistorySourceReviewed") {
      const evidenceReference = sourceEvidence.trim();
      if (!evidenceReference || evidenceReference.length > 2_000) {
        setError("Escribí una referencia de evidencia no sensible, de hasta 2.000 caracteres.");
        return;
      }
      data.evidenceReference = evidenceReference;
    }

    const pendingDeliveryCount = destinationPreview.status === "ready"
      ? destinationPreview.preview.pendingDeliveryAssignmentCount
      : null;
    setBusy(true);
    setError("");
    try {
      await runCommand(draft.command, draft.targetId, draft.expectedVersion, data);
      setDraft(null);
      setFilename("");
      setSourceEvidence("");
      if (fileInput.current) fileInput.current.value = "";
      onRefresh();
      const notice = draft.command === "AppSheetPendingImportDestinationReviewed"
        ? pendingDeliveryCount === null
          ? "La revisión de destino quedó registrada; verificá el estado actual de las entregas pendientes."
          : pendingDeliveryCount === 0
            ? "La revisión quedó registrada sin nuevas asignaciones de entrega; no se despachó ni cobró ningún pedido."
            : `La revisión creó ${pendingDeliveryCount} asignación${pendingDeliveryCount === 1 ? "" : "es"} de entrega pendiente${pendingDeliveryCount === 1 ? "" : "s"}; no se despachó ni cobró ningún pedido.`
        : "La revisión quedó registrada con la sesión autenticada.";
      onNotice(notice);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "No se pudo registrar la revisión.";
      if (cause instanceof OperationsApiError && cause.code === "VERSION_CONFLICT") {
        setError(`${message} Se conserva este borrador; verificá la versión actual y cargá el plan actualizado antes de volver a registrar.`);
      } else if (isUncertainCommandOutcome(cause)) {
        setError(`${message} Se conserva el borrador para reintentar exactamente el mismo comando con el mismo UUID mientras esta vista siga abierta. Si se recargó, verificá el estado y cargá el plan vigente.`);
      } else {
        setError(`${message} Se conserva el borrador para corregirlo o reintentar.`);
      }
    } finally {
      setBusy(false);
    }
  }

  if (!canReview) return null;

  return <section className="ops-sheet ops-upload-sheet" aria-labelledby="appsheet-migration-review-title">
    <div className="ops-sheet-head">
      <div><span className="ops-kicker">Administración · migración AppSheet</span><h3 id="appsheet-migration-review-title">Revisión humana autenticada</h3></div>
      <StatusTag tone="neutral">Sin ejecución al cargar</StatusTag>
    </div>
    <p className="ops-muted-copy">El servidor registra cada revisión con la persona de la sesión vigente y vuelve a validar permiso, alcance y versión. El efecto concreto de cada acción se muestra antes de enviarla; revisar no publica la migración.</p>
    {!availableCommands.length
      ? <InfoBand tone="info" title="No hay comandos de revisión disponibles"><p>El perfil conserva acceso de revisión, pero el servidor no ofrece acciones de migración para esta sesión.</p></InfoBand>
      : <>
        <label className="ops-field ops-file-field">
          <span>Plan JSON de revisión (máximo 100 KB)</span>
          <input ref={fileInput} type="file" accept="application/json,.json" disabled={busy} onChange={event => void loadReviewPlan(event)} />
          <small>El archivo sólo prepara una revisión. No puede elegir la persona revisora ni el UUID del comando.</small>
        </label>
        {filename && <p className="ops-muted-copy">Plan cargado: <strong>{filename}</strong></p>}
        {error && <ErrorState message={error} />}
        {draft && <>
          <div className="ops-import-progress" aria-label="Resumen del plan de revisión">
            <div><span>Acción</span><strong>{commandLabels[draft.command]}</strong></div>
            <div><span>Tipo</span><strong>{commandKinds[draft.command]}</strong></div>
            <div><span>Objeto</span><code>{draft.targetId}</code></div>
            <div><span>Versión esperada</span><strong>{draft.expectedVersion}</strong></div>
            {metadata.map(([prefix, label, value]) => <div key={`${prefix}${label}${value}`}><span>{prefix}{label}</span><code>{value}</code></div>)}
            {counts.map(([label, value]) => <div key={`${label}${value}`}><span>Conteo · {label}</span><strong>{value}</strong></div>)}
          </div>
          {cellReferences.length > 0 && <div className="ops-import-progress" aria-label="Referencias de celdas de origen">
            {cellReferences.map(([label, name, coordinate]) => <div key={`${label}${coordinate}`}><span>{label}</span><strong>{name} · {coordinate}</strong></div>)}
          </div>}
          {!draftCommandAvailable && <InfoBand tone="blocked" title="Acción no disponible para esta sesión"><p>El plan se conserva, pero el servidor no ofrece ese comando con el permiso actual.</p></InfoBand>}
          {draft.command === "AppSheetHistorySourceReviewed" && <InfoBand tone="warning" title="Revisión de origen, separada del archivo auxiliar"><p>Esta acción registra la revisión de la captura AppSheet. No clasifica un archivo como archivo auxiliar, no publica historia y no ejecuta una importación.</p></InfoBand>}
          {draft.command === "AppSheetPendingImportDestinationReviewed" && <InfoBand tone="warning" title="Esta revisión crea entregas pendientes"><p>Al registrar la revisión, el servidor revisa el lote y sus rendiciones y crea asignaciones de entrega pendientes con sus objetos operativos. No despacha pedidos, cobra ni confirma entregas.</p></InfoBand>}
          {draft.command === "AppSheetPendingImportDestinationReviewed" && <div className="ops-review-destination-preview" aria-label="Vista previa autenticada del destino">
            {destinationPreview.status === "loading" && <InfoBand tone="info" title="Consultando el destino"><p>No se puede registrar la revisión hasta verificar en el servidor el lote, su versión y sus conteos actuales.</p></InfoBand>}
            {destinationPreview.status === "error" && <InfoBand tone="blocked" title="No se pudo verificar el destino"><p>{destinationPreview.message} No se envió ningún comando.</p></InfoBand>}
            {destinationPreview.status === "ready" && <>
              <div className="ops-import-progress" aria-label="Datos actuales del destino en el servidor">
                {([
                  ["Lote", destinationPreview.preview.batchId],
                  ["Estado", destinationPreview.preview.status],
                  ["Versión actual", destinationPreview.preview.expectedVersion],
                  ["Captura AppSheet", destinationPreview.preview.captureId],
                  ["Hash del manifiesto", destinationPreview.preview.manifestHash],
                  ["Hash de datos", destinationPreview.preview.dataHash],
                  ["Hash de proyección", destinationPreview.preview.projectionHash],
                  ["Hash de disposiciones", destinationPreview.preview.dispositionHash],
                  ["Hash de destino", destinationPreview.preview.destinationHash],
                  ["Disposiciones", destinationPreview.preview.dispositionCount],
                  ["Rendiciones históricas", destinationPreview.preview.legacySettlementCount],
                  ["Entregas pendientes que se crearán", destinationPreview.preview.pendingDeliveryAssignmentCount],
                ] as Array<[string, string | number]>).map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code></div>)}
              </div>
              {previewMatchesDraft
                ? <InfoBand tone="info" title="La vista previa coincide con el plan"><p>El lote, la versión, la captura y los hashes comprobados coinciden con el destino actual consultado al servidor. El comando vuelve a validar los demás vínculos antes de escribir.</p></InfoBand>
                : <InfoBand tone="blocked" title="El plan no coincide con el destino actual"><p>No se registrará la revisión. Actualizá la vista previa o cargá el plan vigente; esta revisión requiere que versión, captura y hashes coincidan.</p></InfoBand>}
            </>}
            <button type="button" className="ops-button" disabled={busy || destinationPreview.status === "loading"}
              onClick={() => {
                setDestinationPreview({ status: "loading" });
                setPreviewReloadToken(token => token + 1);
              }}>Actualizar vista previa</button>
          </div>}
          {evidenceIssues.length > 0 && <InfoBand tone="blocked" title="Evidencia inválida o fuera del límite"><p>El plan debe incluir texto de hasta 2.000 caracteres para la referencia, 1.000 para evidencia de revisión y 500 por hallazgo. Corregí el archivo antes de registrarlo; no se enviará el comando.</p></InfoBand>}
          {sourceEvidenceTooLong && <InfoBand tone="blocked" title="La referencia supera el límite"><p>Reducí la referencia de evidencia a 2.000 caracteres o menos antes de registrar la revisión de origen.</p></InfoBand>}
          {evidence.length > 0 && <details className="ops-review-evidence">
            <summary>Evidencia textual completa del plan ({evidence.length})</summary>
            <InfoBand tone="info" title="Evidencia textual incluida en el plan">
              <ul>{evidence.map(([label, value], index) => <li key={`${label}${index}`}><strong>{label}:</strong> {value}</li>)}</ul>
            </InfoBand>
          </details>}
          <form className="ops-form-grid" onSubmit={event => void submit(event)}>
            {draft.command === "AppSheetHistorySourceReviewed" && <label className="ops-field ops-file-field">
              <span>Evidencia de la revisión de origen</span>
              <textarea value={sourceEvidence} onChange={event => setSourceEvidence(event.target.value)} maxLength={2_000} required disabled={busy} />
              <small>{typeof draft.data.evidenceReference === "string" ? "Se cargó la referencia del archivo; revisala. Si la cambiás, el texto nuevo se enviará de forma explícita." : "Agregá una referencia breve, sin credenciales ni tokens."}</small>
            </label>}
            <div className="ops-upload-foot">
              <p>La vista no muestra filas ni contenido bruto. Si la versión quedó desactualizada, el servidor rechazará el comando y el borrador se conservará.</p>
              <button type="submit" className="ops-button ops-button-primary" disabled={busy || !draftCommandAvailable ||
                !destinationReviewReady || evidenceIssues.length > 0 ||
                (draft.command === "AppSheetHistorySourceReviewed" && (!sourceEvidence.trim() || sourceEvidence.length > 2_000))}>
                {busy ? "Registrando…" : draft.command === "AppSheetPendingImportDestinationReviewed"
                  ? "Revisar destino y crear entregas pendientes"
                  : "Registrar revisión"}
              </button>
            </div>
          </form>
        </>}
      </>}
  </section>;
}
