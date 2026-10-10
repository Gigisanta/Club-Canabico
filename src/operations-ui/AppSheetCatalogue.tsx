import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type SyntheticEvent } from "react";
import {
  appSheetCataloguePatchSchema,
  type AppSheetCatalogueData,
  type AppSheetCatalogueMoney,
  type AppSheetCataloguePatch,
} from "../../shared/operations/appsheet-catalogue.js";
import { appSheetExactTariffFields, type AppSheetExactTariffField } from "../../shared/operations/appsheet-line-pricing.js";
import { apiGet, hasCapability, hasCommand, isUncertainCommandOutcome, OperationsApiError } from "./api";
import { amountFormToMinor, formatMinor } from "./money";
import { ActionButton, DataTable, EmptyState, ErrorState, InfoBand, LoadingState, StatusTag } from "./Primitives";
import type { OperationsContext, RunCommand } from "./types";
import { useRemote } from "./useRemote";
import "./AppSheetCatalogue.css";

type MoneyField = AppSheetExactTariffField
  | "price10To15Grams"
  | "price15To20Grams"
  | "price20To25Grams"
  | "price25To30Grams"
  | "priceOver30Grams"
  | "clientTariff"
  | "administrationTariff"
  | "totalTariff";
type CatalogueSheetItem = {
  id: string;
  code: string;
  name: string;
  variety: string;
  category: string;
  unit: "g" | "ud";
  active: boolean;
  appSheet: AppSheetCatalogueData;
};
type CatalogueSheetRow = CatalogueSheetItem & {
  version: number;
};
type CatalogueSheetResponse = {
  items: CatalogueSheetItem[];
  versions: Record<string, number>;
  hasMore: boolean;
  nextCursor: string | null;
};
type AmountDraft = { amount: string; currency: string };
type CatalogueDraft = {
  catalogId: string;
  availability: string;
  segment: string;
  description: string;
  amounts: Record<MoneyField, AmountDraft>;
};
type PendingSave = { targetId: string; version: number; data: Record<string, unknown> };

const exactAmountFields = Object.values(appSheetExactTariffFields).map(({ field, label }) => ({ key: field, label }));
const amountFields: Array<{ key: MoneyField; label: string }> = [
  ...exactAmountFields,
  { key: "price10To15Grams", label: "Rango legado: 10 a 15 g" },
  { key: "price15To20Grams", label: "Rango legado: 15 a 20 g" },
  { key: "price20To25Grams", label: "Rango legado: 20 a 25 g" },
  { key: "price25To30Grams", label: "Rango legado: 25 a 30 g" },
  { key: "priceOver30Grams", label: "Rango legado: más de 30 g" },
  { key: "clientTariff", label: "Tarifa_Cliente" },
  { key: "administrationTariff", label: "Tarifa_Administración" },
  { key: "totalTariff", label: "Total" },
];

function minorToInput(value: string) {
  const minor = BigInt(value), whole = minor / 100n, cents = String(minor % 100n).padStart(2, "0");
  return `${whole}.${cents}`;
}

function newDraft(sheet: AppSheetCatalogueData): CatalogueDraft {
  const amounts = Object.fromEntries(amountFields.map(({ key }) => {
    const value = sheet[key] as AppSheetCatalogueMoney | null | undefined;
    return [key, value && typeof value.amountMinor === "string" && (value.currency === "ARS" || value.currency === "USD")
      ? { amount: minorToInput(value.amountMinor), currency: value.currency }
      : { amount: "", currency: "" }];
  })) as Record<MoneyField, AmountDraft>;
  return {
    catalogId: typeof sheet.catalogId === "string" ? sheet.catalogId : "",
    availability: sheet.availability ?? "",
    segment: sheet.segment ?? "",
    description: typeof sheet.description === "string" ? sheet.description : "",
    amounts,
  };
}

function displayAmount(value: unknown) {
  if (!value || typeof value !== "object") return "Dato no registrado";
  const amount = value as Partial<AppSheetCatalogueMoney>;
  return typeof amount.amountMinor === "string" && (amount.currency === "ARS" || amount.currency === "USD")
    ? formatMinor(amount.amountMinor, amount.currency)
    : "Dato no registrado";
}

function itemName(row: CatalogueSheetRow) {
  return row.name || row.variety || row.code || "SKU sin nombre";
}

export function AppSheetCatalogue({ context, refreshKey, runCommand, onRefresh, onNotice }: {
  context: OperationsContext;
  refreshKey: number;
  runCommand: RunCommand;
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const canRead = hasCapability(context, "prices.propose") || hasCapability(context, "stock.adjust");
  const canEdit = hasCapability(context, "prices.propose") && hasCommand(context, "CatalogueSheetSaved");
  const [search, setSearch] = useState("");
  const query = search.trim();
  const params = new URLSearchParams({ limit: "200", ...(query ? { q: query } : {}) });
  const response = useRemote<CatalogueSheetResponse>(canRead ? `/api/operations/catalogue-sheets?${params}` : null, refreshKey);
  const [loaded, setLoaded] = useState<CatalogueSheetRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedSnapshot, setSelectedSnapshot] = useState<CatalogueSheetRow | null>(null);
  const [draft, setDraft] = useState<CatalogueDraft | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingSave | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const editorDialog = useRef<HTMLDialogElement>(null);
  const discardPrompt = useRef<HTMLDivElement>(null);
  const discardPromptWasOpen = useRef(false);
  const pendingDialog = useRef<HTMLDialogElement>(null);
  const pageRequest = useRef<AbortController | null>(null);
  const pageGeneration = useRef(0);
  const visibleItems = useMemo(() => loaded, [loaded]);
  const shouldOpenEditor = canEdit && Boolean(selectedSnapshot) && Boolean(draft);

  useLayoutEffect(() => {
    pageGeneration.current += 1;
    pageRequest.current?.abort();
    pageRequest.current = null;
    setPageBusy(false);
    setPageError("");
    return () => {
      pageGeneration.current += 1;
      pageRequest.current?.abort();
      pageRequest.current = null;
    };
  }, [query, refreshKey, response.data]);

  useLayoutEffect(() => {
    setLoaded([]);
    setNextCursor(null);
    setPageError("");
    setSelectedId("");
    setSelectedSnapshot(null);
    setDraft(null);
    setBaseVersion(null);
    setDirty(new Set());
  }, [query]);
  useLayoutEffect(() => {
    if (!response.data) return;
    setLoaded(response.data.items.map(item => ({ ...item, version: response.data!.versions?.[item.id] ?? 0 })));
    setNextCursor(response.data.nextCursor);
    setPageError("");
  }, [response.data, query, refreshKey]);
  useEffect(() => {
    if (!dirty.size && !pending) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty.size, pending]);
  useLayoutEffect(() => {
    const dialog = editorDialog.current;
    if (!dialog) return;
    if (shouldOpenEditor && !dialog.open) dialog.showModal();
    else if (!shouldOpenEditor && dialog.open) dialog.close();
  }, [shouldOpenEditor]);
  useEffect(() => {
    if (confirmDiscard) {
      discardPromptWasOpen.current = true;
      discardPrompt.current?.focus();
    } else if (discardPromptWasOpen.current) {
      discardPromptWasOpen.current = false;
      editorDialog.current?.querySelector<HTMLElement>("[data-editor-initial-focus]")?.focus();
    }
  }, [confirmDiscard]);
  useEffect(() => {
    const dialog = pendingDialog.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    else if (!pending && dialog.open) dialog.close();
  }, [pending]);

  const knownDescriptions = [...new Set(visibleItems.flatMap(item => typeof item.appSheet.description === "string" && item.appSheet.description.trim() ? [item.appSheet.description] : []))].sort((a, b) => a.localeCompare(b, "es"));
  const editable = canEdit && !busy && !pending && !confirmDiscard;

  if (!canRead) return null;

  function choose(item: CatalogueSheetRow) {
    if (pending || dirty.size) return;
    if (selectedId === item.id) { requestEditorClose(); return; }
    setSelectedId(item.id);
    setSelectedSnapshot(item);
    setDraft(newDraft(item.appSheet ?? {}));
    setBaseVersion(item.version);
    setError("");
  }

  function markDirty(key: string) {
    setDirty(previous => new Set(previous).add(key));
  }

  function updateBasic<K extends "catalogId" | "availability" | "segment" | "description">(key: K, value: CatalogueDraft[K]) {
    setDraft(previous => previous ? { ...previous, [key]: value } : previous);
    markDirty(key);
  }

  function updateAmount(key: MoneyField, part: keyof AmountDraft, value: string) {
    setDraft(previous => previous ? { ...previous, amounts: { ...previous.amounts, [key]: { ...previous.amounts[key], [part]: value } } } : previous);
    markDirty(key);
  }

  function clearAmount(key: MoneyField) {
    setDraft(previous => previous ? { ...previous, amounts: { ...previous.amounts, [key]: { amount: "", currency: "" } } } : previous);
    markDirty(key);
  }

  function discardEditorDraft() {
    if (pending || busy) return;
    setConfirmDiscard(false);
    setSelectedId(""); setSelectedSnapshot(null); setDraft(null); setBaseVersion(null); setDirty(new Set()); setError("");
    onRefresh();
  }

  function requestEditorClose() {
    if (pending || busy) return;
    if (dirty.size) { setConfirmDiscard(true); return; }
    discardEditorDraft();
  }

  function handleEditorCancel(event: SyntheticEvent<HTMLDialogElement, Event>) {
    event.preventDefault();
    if (pending || busy) return;
    if (confirmDiscard) { setConfirmDiscard(false); return; }
    requestEditorClose();
  }

  function makePatch(): AppSheetCataloguePatch {
    const result: Record<string, unknown> = {};
    for (const key of dirty) {
      if (key === "catalogId" || key === "description") {
        const value = draft?.[key];
        result[key] = value?.trim() ? value : null;
      } else if (key === "availability" || key === "segment") {
        const value = draft?.[key];
        result[key] = value || null;
      } else {
        const amount = draft?.amounts[key as MoneyField];
        if (!amount?.amount.trim() && !amount?.currency) result[key] = null;
        else {
          if (!amount?.amount.trim() || !amount.currency) throw new Error("Completá importe y moneda en cada campo de precio que edites.");
          const amountMinor = amountFormToMinor(amount.amount);
          if (BigInt(amountMinor) < 0n) throw new Error("Los precios y tarifas no pueden ser negativos.");
          result[key] = { amountMinor, currency: amount.currency };
        }
      }
    }
    return appSheetCataloguePatchSchema.parse(result);
  }

  async function save(action: PendingSave) {
    setBusy(true); setError("");
    try {
      await runCommand("CatalogueSheetSaved", action.targetId, action.version, action.data);
      setPending(null); setBaseVersion(action.version + 1); setDirty(new Set()); onRefresh();
      onNotice("Ficha comercial guardada. Estos valores quedan separados de las tarifas aprobadas y no cambian ventas ni stock.");
    } catch (cause) {
      setError(cause instanceof OperationsApiError && cause.code === "VERSION_CONFLICT"
        ? "El producto cambió en otra sesión. Tu borrador sigue intacto y no sobrescribe ese cambio; copiá lo que necesites, descartá y reabrí la ficha para revisar los datos actuales."
        : cause instanceof Error ? cause.message : "No se pudo guardar la ficha.");
      setPending(isUncertainCommandOutcome(cause) ? action : null);
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedSnapshot || baseVersion === null || !dirty.size || !editable) return;
    try {
      const patch = makePatch();
      void save({ targetId: selectedSnapshot.id, version: baseVersion, data: { patch } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Revisá los campos editados.");
    }
  }

  async function loadMore() {
    if (!nextCursor || pageBusy || response.loading || pageRequest.current) return;
    const generation = pageGeneration.current;
    const controller = new AbortController();
    pageRequest.current = controller;
    setPageBusy(true); setPageError("");
    try {
      const next = await apiGet<CatalogueSheetResponse>(`/api/operations/catalogue-sheets?${new URLSearchParams({ limit: "200", ...(query ? { q: query } : {}), cursor: nextCursor })}`, { signal: controller.signal });
      if (controller.signal.aborted || generation !== pageGeneration.current) return;
      const items = next.items.map(item => ({ ...item, version: next.versions?.[item.id] ?? 0 }));
      setLoaded(previous => [...new Map([...previous, ...items].map(row => [row.id, row])).values()]);
      setNextCursor(next.nextCursor);
    } catch (cause) {
      if (controller.signal.aborted || generation !== pageGeneration.current) return;
      setPageError(cause instanceof Error ? cause.message : "No se pudo cargar la siguiente página.");
    } finally {
      if (pageRequest.current === controller) {
        pageRequest.current = null;
        if (generation === pageGeneration.current) setPageBusy(false);
      }
    }
  }

  const sourceError = response.error || pageError;
  return <section className="ops-sheet appsheet-catalogue" aria-label="Fichas comerciales del catálogo">
    <div className="ops-sheet-head">
      <div><span className="ops-kicker">Catálogo · precios y tarifas</span><h3>Fichas comerciales del catálogo</h3></div>
      <span className="ops-row-count">{visibleItems.length}{nextCursor ? "+" : ""} productos</span>
    </div>
    <InfoBand title="Valores comerciales, separados del stock"><p>Registrá cada tramo, promoción, tarifa y total con su moneda. Los cambios no calculan descuentos ni alteran tarifas aprobadas, ventas o existencias.</p></InfoBand>
    <label className="ops-field appsheet-catalogue-search"><span>Buscar producto</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Código, nombre o variedad" autoComplete="off" disabled={!!dirty.size || !!pending || busy} /></label>
    {response.loading && !visibleItems.length && <LoadingState label="Cargando catálogo…" />}
    {sourceError && <ErrorState message={sourceError} retry={response.error ? response.retry : () => void loadMore()} />}
    {!response.loading && !response.error && !visibleItems.length && <EmptyState title={query ? "No hay productos con esa búsqueda" : "Todavía no hay productos"} detail={query ? "Probá con otro código, nombre o variedad." : "Los SKU aparecen cuando existen en el catálogo operativo."} />}
    {!!visibleItems.length && <>
      {!!dirty.size && <p className="appsheet-catalogue-draft-note" role="status">La búsqueda queda bloqueada mientras haya cambios sin guardar. Guardá o descartá esta ficha para cambiar de producto.</p>}
      <DataTable label="Fichas comerciales del catálogo">
        <thead><tr><th scope="col">SKU / código</th><th scope="col">TipoVariedad</th><th scope="col">Unidad</th><th scope="col">Disponibilidad</th><th scope="col">Segmento</th><th scope="col">Precio 5 g</th>{canEdit && <th scope="col">Acción</th>}</tr></thead>
        <tbody>{visibleItems.map(item => <tr key={item.id}>
          <td><strong>{itemName(item)}</strong><small className="appsheet-catalogue-code">{item.code} · {item.category}</small>{!item.active && <StatusTag tone="warn">SKU inactivo en stock</StatusTag>}</td>
          <td>{item.variety}</td><td>{item.unit}</td><td>{item.appSheet.availability ?? "Dato no registrado"}</td><td>{item.appSheet.segment ?? "Dato no registrado"}</td><td>{displayAmount(item.appSheet.price5Grams)}</td>
          {canEdit && <td><button type="button" className="ops-button ops-button-quiet ops-button-small" aria-expanded={selectedId === item.id} aria-controls="appsheet-catalogue-editor" disabled={!!pending || !!dirty.size && selectedId !== item.id} onClick={() => choose(item)}>{selectedId === item.id ? "Ficha abierta" : "Editar ficha"}</button></td>}
        </tr>)}</tbody>
      </DataTable>
      {nextCursor && <div className="appsheet-catalogue-more"><ActionButton quiet disabled={pageBusy || response.loading} onClick={() => void loadMore()}>{pageBusy ? "Cargando…" : "Cargar más productos"}</ActionButton></div>}
      {canEdit && dirty.size > 0 && <p className="appsheet-catalogue-draft-note" role="status">Hay cambios sin guardar. Guardá o descartá esta ficha antes de abrir otro producto.</p>}
      {!canEdit && <InfoBand title="Consulta de catálogo"><p>Tu perfil permite consultar estas fichas. Para editar precios y tarifas, pedile a un administrador que habilite la edición comercial.</p></InfoBand>}
    </>}
    {canEdit && selectedSnapshot && draft && <dialog ref={editorDialog} className="appsheet-catalogue-editor-dialog" aria-labelledby="appsheet-catalogue-editor-title" onCancel={handleEditorCancel}>
    <form id="appsheet-catalogue-editor" className="appsheet-catalogue-editor" onSubmit={submit}>
      <div className="appsheet-catalogue-editor-head"><div><span className="ops-kicker">SKU existente</span><h4 id="appsheet-catalogue-editor-title">{itemName(selectedSnapshot)}</h4></div><button type="button" className="ops-button ops-button-quiet ops-button-small" disabled={busy || !!pending || confirmDiscard} onClick={requestEditorClose}>Cerrar ficha</button></div>
      <div className="appsheet-catalogue-identity" aria-label="Identidad operativa protegida">
        <div><span>SKU Bombo</span><strong>{selectedSnapshot.code} · {selectedSnapshot.category}</strong></div>
        <div><span>TipoVariedad</span><strong>{selectedSnapshot.variety}</strong></div>
        <div><span>Unidad inmutable</span><strong>{selectedSnapshot.unit === "g" ? "Gramos" : "Unidades"}</strong></div>
        <div><span>Estado operativo</span><strong>{selectedSnapshot.active ? "Activo" : "Inactivo"}</strong></div>
      </div>
      <div className="appsheet-catalogue-fields">
        <label className="ops-field"><span>CatalogoID</span><input data-editor-initial-focus type="text" value={draft.catalogId} maxLength={100} disabled={!editable} onChange={event => updateBasic("catalogId", event.target.value)} placeholder="Sin dato registrado" /></label>
        <label className="ops-field"><span>Descripcion</span><input type="text" list="appsheet-catalogue-description-options" value={draft.description} maxLength={500} disabled={!editable} onChange={event => updateBasic("description", event.target.value)} placeholder="Elegí una descripción conocida o escribila" /><datalist id="appsheet-catalogue-description-options">{knownDescriptions.map(description => <option key={description} value={description} />)}</datalist><small>Las sugerencias muestran descripciones ya registradas.</small></label>
        <label className="ops-field"><span>Disponibilidad</span><select value={draft.availability} disabled={!editable} onChange={event => updateBasic("availability", event.target.value)}><option value="">Sin dato conocido</option><option value="NO">NO</option><option value="Sí">Sí</option></select><small>La disponibilidad comercial se conserva separada del stock físico.</small></label>
        <label className="ops-field"><span>SegmentoTarifario</span><select value={draft.segment} disabled={!editable} onChange={event => updateBasic("segment", event.target.value)}><option value="">Sin dato conocido</option><option value="Premium">Premium</option><option value="Estandar">Estandar</option></select></label>
      </div>
      <fieldset className="appsheet-catalogue-prices"><legend>Precios, promociones y tarifas</legend><p>Escribí el importe en moneda principal con hasta dos decimales y elegí la moneda. Se guarda como unidades menores enteras; los campos vacíos siguen desconocidos.</p><p role="note">Los campos “Rango legado” se conservan como referencia. No determinan un precio exacto de 10, 15, 20, 25 o 30 gramos.</p>
        <div className="appsheet-catalogue-money-grid">{amountFields.map(({ key, label }) => {
          const value = draft.amounts[key];
          const inputId = `appsheet-catalogue-${selectedSnapshot.id}-${key}`;
          return <div className="appsheet-catalogue-money" key={key}>
            <label className="ops-field" htmlFor={inputId}><span>{label}</span><input id={inputId} type="text" inputMode="decimal" autoComplete="off" value={value.amount} disabled={!editable} onChange={event => updateAmount(key, "amount", event.target.value)} placeholder="Dato no registrado" aria-label={`${label}: importe`} /></label>
            <label className="ops-field"><span>Moneda</span><select value={value.currency} disabled={!editable} onChange={event => updateAmount(key, "currency", event.target.value)} aria-label={`${label}: moneda`}><option value="">Sin moneda</option><option value="ARS">ARS</option><option value="USD">USD</option></select></label>
            <button type="button" className="ops-button ops-button-quiet ops-button-small appsheet-catalogue-clear" disabled={!editable || !value.amount && !value.currency} onClick={() => clearAmount(key)}>Borrar este dato</button>
          </div>;
        })}</div>
      </fieldset>
      {error && <div className="appsheet-catalogue-feedback"><ErrorState message={error} /></div>}
      <div className="appsheet-catalogue-actions"><ActionButton quiet disabled={busy || !!pending || confirmDiscard} onClick={requestEditorClose}>Cerrar ficha</ActionButton><ActionButton disabled={!editable || !dirty.size} onClick={() => { const form = document.getElementById("appsheet-catalogue-editor") as HTMLFormElement | null; form?.requestSubmit(); }}>{busy ? "Guardando…" : pending ? "Esperando comprobante…" : "Guardar ficha"}</ActionButton></div>
    </form>
    {confirmDiscard && <div ref={discardPrompt} className="appsheet-catalogue-discard-confirm" role="alertdialog" aria-modal="true" aria-labelledby="appsheet-catalogue-discard-title" aria-describedby="appsheet-catalogue-discard-description" tabIndex={-1}>
      <h4 id="appsheet-catalogue-discard-title">¿Descartar los cambios?</h4>
      <p id="appsheet-catalogue-discard-description">La ficha todavía tiene cambios sin guardar. Podés seguir editando o descartarlos y cerrar.</p>
      <div><ActionButton quiet disabled={busy || !!pending} onClick={() => setConfirmDiscard(false)}>Seguir editando</ActionButton><ActionButton disabled={busy || !!pending} onClick={discardEditorDraft}>Descartar y cerrar</ActionButton></div>
    </div>}
    </dialog>}
    {canEdit && <dialog ref={pendingDialog} className="appsheet-catalogue-pending" aria-labelledby="appsheet-catalogue-pending-title" onCancel={event => event.preventDefault()}>
      <span className="ops-kicker">Confirmación segura</span>
      <h4 id="appsheet-catalogue-pending-title">La respuesta quedó pendiente</h4>
      <p>El servidor no confirmó si guardó la ficha. El formulario queda intacto; recuperá el comprobante con la misma solicitud antes de seguir.</p>
      {error && <p className="appsheet-catalogue-pending-error" role="alert">{error}</p>}
      {pending && <ActionButton disabled={busy} onClick={() => void save(pending)}>{busy ? "Confirmando…" : "Recuperar comprobante"}</ActionButton>}
    </dialog>}
  </section>;
}
