import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, hasCapability, hasCommand, responseItems, responseVersion, recordValue } from "./api";
import { useRemote } from "./useRemote";
import { ActionButton, DataTable, EmptyState, ErrorState, InfoBand, LoadingState, SectionHeading, StatusTag } from "./Primitives";
import type { ActionField, CommandAction, JsonRecord, OperationsContext } from "./types";
import "./ManualStockTools.css";

type Row = Record<string, unknown>;
type CatalogResponse = { items?: Row[]; versions?: Record<string, number>; hasMore?: boolean; nextCursor?: string | null };
type ReferenceResponse = { locations?: Row[]; custodians?: Row[] };

interface Props {
  context: OperationsContext;
  refreshKey: number;
  openAction: (action: CommandAction) => void;
  onNotice: (message: string) => void;
}

function rowsOf(value: unknown, key = "items"): Row[] {
  const rows = key === "items" ? responseItems<Row>(value) : recordValue(value, key);
  return Array.isArray(rows) ? rows.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function idOf(row: Row) { return text(row.id); }
function hasHumanLabel(row: Row) {
  return ["name", "label", "title"].some(key => typeof row[key] === "string" && (row[key] as string).trim().length > 0);
}
function labelOf(row: Row, keys = ["name", "label", "title", "id"]) {
  for (const key of keys) if (typeof row[key] === "string" && row[key]) return row[key] as string;
  return "Registro";
}
function optionsOf(rows: Row[], label: (row: Row) => string = row => labelOf(row)) {
  return rows.flatMap(row => idOf(row) ? [{ value: idOf(row), label: label(row) }] : []);
}
function localDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
}
function mergeRows(previous: Row[], next: Row[]) {
  const byId = new Map(previous.map(row => [idOf(row), row]));
  for (const row of next) byId.set(idOf(row), row);
  return [...byId.values()];
}
function message(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function textField(name: string, label: string, required = true, defaultValue = "", help?: string): ActionField {
  return { name, label, type: "text", required, defaultValue, ...(help ? { help } : {}) };
}
function areaField(name: string, label: string, required = true, defaultValue = "", help?: string): ActionField {
  return { name, label, type: "textarea", required, defaultValue, ...(help ? { help } : {}) };
}
function selectField(name: string, label: string, options: Array<{ value: string; label: string }>, required = true, help?: string): ActionField {
  return { name, label, type: "select", options, required, ...(help ? { help } : {}) };
}
function evidenceField(): ActionField {
  return areaField("evidence", "Motivo o evidencia del cambio", true, "", "Se guarda en la auditoría de la operación.");
}
function value(values: Record<string, string | boolean>, key: string) {
  return typeof values[key] === "string" ? String(values[key]).trim() : "";
}
function note(values: Record<string, string | boolean>) {
  const evidence = value(values, "evidence");
  if (!evidence) throw new Error("Agregá el motivo o la evidencia requerida.");
  return { note: evidence };
}
function decimalValue(raw: string, label: string, maxScale: number, allowZero: boolean) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match || (match[2]?.length ?? 0) > maxScale || match[1]!.length + (match[2]?.length ?? 0) > 38) {
    throw new Error(`${label}: ingresá un número válido con hasta ${maxScale} decimales.`);
  }
  const scaled = BigInt(match[1]!) * 10n ** 12n + BigInt((match[2] ?? "").padEnd(12, "0") || "0");
  if (!allowZero && scaled <= 0n) throw new Error(`${label}: ingresá un valor mayor que cero.`);
  return raw;
}

function skuAction(row: Row | null, version: number, openAction: Props["openAction"], onNotice: Props["onNotice"]) {
  const create = row === null;
  if (!create && !Number.isSafeInteger(version)) {
    onNotice("No se puede editar este producto: el catálogo no devolvió una versión vigente.");
    return;
  }
  const fields: ActionField[] = [
    textField("code", "Código", true, text(row?.code)),
    textField("name", "Nombre", true, text(row?.name)),
    textField("variety", "Variedad", true, text(row?.variety)),
    textField("category", "Categoría", true, text(row?.category)),
    ...(create ? [selectField("unit", "Unidad", [{ value: "g", label: "Gramos · g" }, { value: "ud", label: "Unidades · ud" }])] : []),
    { name: "minQuantity", label: "Stock mínimo", type: "decimal", required: true, defaultValue: text(row?.minQuantity, "0"), help: create ? "Usá la unidad que elegiste para el producto." : `Unidad actual inmutable: ${text(row?.unit) === "g" ? "gramos (g)" : "unidades (ud)"}.` },
    { name: "minVarieties", label: "Variedades mínimas", type: "integer", required: true, defaultValue: String(row?.minVarieties ?? 0) },
    ...(!create ? [{ name: "active", label: "Producto activo", type: "checkbox" as const, defaultValue: row?.active === true }] : []),
    evidenceField(),
  ];
  const toData = (values: Record<string, string | boolean>): JsonRecord => {
    const minimum = value(values, "minQuantity");
    const minimumVarieties = value(values, "minVarieties");
    if (!/^\d{1,4}$/.test(minimumVarieties) || Number(minimumVarieties) > 1000) throw new Error("Las variedades mínimas deben ser un entero entre 0 y 1000.");
    const unit = create ? value(values, "unit") : text(row?.unit);
    if (unit !== "g" && unit !== "ud") throw new Error("Elegí una unidad válida.");
    decimalValue(minimum, "El stock mínimo", unit === "g" ? 3 : 0, true);
    return {
      code: value(values, "code"),
      name: value(values, "name"),
      variety: value(values, "variety"),
      category: value(values, "category"),
      unit,
      minQuantity: minimum,
      minVarieties: Number(minimumVarieties),
      ...(!create ? { active: values.active === true } : {}),
      evidence: note(values),
    };
  };
  openAction({
    command: create ? "CatalogSkuCreated" : "CatalogSkuUpdated",
    title: create ? "Crear producto de catálogo" : "Editar producto de catálogo",
    description: create
      ? "El producto se crea activo. Un saldo sólo se registra mediante una recepción o una apertura de stock aprobada."
      : `El cambio requiere motivo y versión vigente. La unidad actual es ${text(row?.unit) === "g" ? "gramos (g)" : "unidades (ud)"} y es inmutable; para otra unidad, creá otro producto.`,
    fields,
    toData,
    ...(row ? { targetId: idOf(row), expectedVersion: version } : { targetId: crypto.randomUUID(), expectedVersion: 0, requestIdIsTarget: true }),
    submitLabel: create ? "Crear producto" : "Guardar cambios",
  });
}

function openingAction(
  context: OperationsContext,
  skus: Row[],
  locations: Row[],
  custodians: Row[],
  preparers: Row[],
  openAction: Props["openAction"],
) {
  const activeSkus = skus.filter(row => row.active === true && hasHumanLabel(row));
  const activeLocations = locations.filter(row => row.active === true && hasHumanLabel(row));
  const visibleCustodians = custodians.filter(hasHumanLabel);
  const otherPreparers = preparers.filter(row => idOf(row) && idOf(row) !== context.userId && hasHumanLabel(row));
  if (!activeSkus.length || !activeLocations.length || !otherPreparers.length) return false;
  const fields: ActionField[] = [
    selectField("skuId", "Producto activo", optionsOf(activeSkus, row => `${labelOf(row)} · ${text(row.code, "sin código")} · ${text(row.variety)} · ${text(row.unit)}`)),
    textField("label", "Etiqueta del lote"),
    { name: "quantity", label: "Cantidad inicial", type: "decimal", required: true, help: "Debe ser mayor que cero y respetar la unidad del producto." },
    { name: "unitCost", label: "Costo unitario conocido", type: "decimal", required: true, help: "Debe ser mayor que cero; se registra para trazabilidad del lote." },
    selectField("costCurrency", "Moneda del costo", [{ value: "ARS", label: "ARS · pesos argentinos" }, { value: "USD", label: "USD · dólares estadounidenses" }]),
    { name: "receivedDate", label: "Fecha de apertura / ingreso del stock", type: "date", required: true, defaultValue: localDate(), help: "El contrato guarda esta fecha; no tiene un período contable independiente." },
    { name: "expiresOn", label: "Vencimiento (opcional)", type: "date", required: false },
    selectField("locationId", "Ubicación visible", optionsOf(activeLocations, row => `${labelOf(row)}${row.isDefault === true ? " · predeterminada" : ""}`)),
    selectField("custodianId", "Custodia (opcional; por defecto, quien aprueba)", [{ value: "", label: "Usar a la persona que aprueba" }, ...optionsOf(visibleCustodians)], false),
    selectField("preparedBy", "Persona que preparó el relevamiento (distinta de quien aprueba)", optionsOf(otherPreparers), true, "La persona preparadora debe estar activa y no puede ser quien aprueba esta apertura."),
    evidenceField(),
  ];
  openAction({
    command: "StockOpeningRecorded",
    title: "Registrar apertura de stock",
    description: "Esta operación crea un lote y un saldo inicial con costo, moneda, ubicación y evidencia. Una persona distinta debe aprobarla; no reemplaza una recepción de compra.",
    fields,
    toData: values => {
      const quantity = value(values, "quantity"), unitCost = value(values, "unitCost");
      const sku = activeSkus.find(row => idOf(row) === value(values, "skuId"));
      if (!sku) throw new Error("Elegí un producto activo del catálogo.");
      decimalValue(quantity, "La cantidad de apertura", sku.unit === "g" ? 3 : 0, false);
      decimalValue(unitCost, "El costo unitario", 12, false);
      const receivedDate = value(values, "receivedDate"), expiresOn = value(values, "expiresOn");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) throw new Error("Ingresá una fecha de apertura válida.");
      if (receivedDate > localDate()) throw new Error("La fecha de apertura no puede ser futura.");
      if (expiresOn && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || expiresOn < receivedDate)) throw new Error("El vencimiento no puede ser anterior a la fecha de apertura.");
      const preparedBy = value(values, "preparedBy");
      if (!otherPreparers.some(row => idOf(row) === preparedBy)) throw new Error("Elegí una persona preparadora activa distinta de quien aprueba.");
      if (!activeLocations.some(row => idOf(row) === value(values, "locationId"))) throw new Error("Elegí una ubicación activa visible.");
      const custodianId = value(values, "custodianId");
      if (custodianId && !visibleCustodians.some(row => idOf(row) === custodianId)) throw new Error("Elegí una persona custodio visible.");
      const currency = value(values, "costCurrency");
      if (currency !== "ARS" && currency !== "USD") throw new Error("Elegí ARS o USD para el costo.");
      return {
        skuId: value(values, "skuId"), label: value(values, "label"), quantity, unitCost,
        costCurrency: currency, receivedDate, ...(expiresOn ? { expiresOn } : {}),
        locationId: value(values, "locationId"), ...(custodianId ? { custodianId } : {}),
        preparedBy, evidence: note(values),
      };
    },
    targetId: crypto.randomUUID(), expectedVersion: 0, requestIdIsTarget: true, submitLabel: "Registrar y aprobar apertura",
  });
  return true;
}

export function ManualStockTools({ context, refreshKey, openAction, onNotice }: Props) {
  const canCreate = hasCapability(context, "stock.adjust") && hasCommand(context, "CatalogSkuCreated");
  const canEdit = hasCapability(context, "stock.adjust") && hasCommand(context, "CatalogSkuUpdated");
  const canOpen = hasCapability(context, "openings.approve") && hasCommand(context, "StockOpeningRecorded");
  const canReadCatalog = hasCapability(context, "stock.read") || hasCapability(context, "orders.write") || hasCapability(context, "stock.adjust");
  const catalogPathBase = hasCapability(context, "stock.adjust")
    ? "/api/operations/catalogue-sheets?limit=200"
    : canOpen && canReadCatalog ? "/api/operations/catalog?limit=200" : null;
  const [search, setSearch] = useState("");
  const [catalogSnapshot, setCatalogSnapshot] = useState<{ path: string; refreshKey: number; items: Row[]; versions: Record<string, number>; nextCursor: string; hasMore: boolean } | null>(null);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreController = useRef<AbortController | null>(null);
  const catalogPath = catalogPathBase
    ? `${catalogPathBase}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""}`
    : null;
  const catalog = useRemote<CatalogResponse>(catalogPath, refreshKey);
  const canReadStockReferences = hasCapability(context, "stock.read");
  const canReadEditableReferences = hasCapability(context, "stock.adjust");
  const stockReference = useRemote<ReferenceResponse>(canReadStockReferences ? "/api/operations/stock/reference-data" : null, refreshKey);
  const editableReferences = useRemote<ReferenceResponse>(canReadEditableReferences ? "/api/operations/manual-reference-data" : null, refreshKey);
  const preparers = useRemote<{ items?: Row[] }>(canOpen ? "/api/operations/manual-reference-data/preparers" : null, refreshKey);
  const pageItems = useMemo(() => rowsOf(catalog.data), [catalog.data]);

  useEffect(() => {
    const snapshotPath = catalogPathBase;
    const requestedPath = catalogPath;
    if (catalog.loading || catalog.error || !catalog.data || !requestedPath || !snapshotPath) return;
    const versions = recordValue(catalog.data, "versions");
    setCatalogSnapshot({
      path: snapshotPath,
      refreshKey,
      items: pageItems,
      versions: versions && typeof versions === "object" ? versions as Record<string, number> : {},
      nextCursor: text(catalog.data.nextCursor),
      hasMore: catalog.data.hasMore === true || Boolean(catalog.data.nextCursor),
    });
  }, [catalog.loading, catalog.error, catalog.data, catalogPath, catalogPathBase, refreshKey, pageItems]);

  useEffect(() => {
    loadMoreController.current?.abort();
    loadMoreController.current = null;
    setCatalogSnapshot(null);
    setLoadMoreError("");
    setLoadingMore(false);
  }, [catalogPathBase, search, refreshKey]);
  useEffect(() => () => loadMoreController.current?.abort(), []);

  const snapshotCurrent = catalogSnapshot?.path === catalogPathBase && catalogSnapshot.refreshKey === refreshKey;
  const skuRows = snapshotCurrent ? catalogSnapshot.items : [];
  const skuVersions = snapshotCurrent ? catalogSnapshot.versions : {};
  const locationRows = useMemo(() => {
    const stock = !canReadStockReferences || stockReference.error ? [] : rowsOf(stockReference.data, "locations").map(row => ({ ...row, active: row.active !== false }));
    const manual = !canReadEditableReferences || editableReferences.error ? [] : rowsOf(editableReferences.data, "locations");
    return mergeRows(stock, manual).filter(row => row.active === true);
  }, [canReadStockReferences, stockReference.data, stockReference.error, canReadEditableReferences, editableReferences.data, editableReferences.error]);
  const custodianRows = useMemo(() => !canReadStockReferences || stockReference.error ? [] : rowsOf(stockReference.data, "custodians").filter(row => row.active !== false), [canReadStockReferences, stockReference.data, stockReference.error]);
  const preparerRows = useMemo(() => rowsOf(preparers.data).filter(row => row.active !== false), [preparers.data]);
  const selectableSkuRows = skuRows.filter(row => row.active === true && hasHumanLabel(row));
  const selectableLocationRows = locationRows.filter(hasHumanLabel);
  const selectablePreparerRows = preparerRows.filter(row => idOf(row) !== context.userId && hasHumanLabel(row));
  const locationQueryAvailable = Boolean((canReadStockReferences && stockReference.data && !stockReference.error) || (canReadEditableReferences && editableReferences.data && !editableReferences.error));
  const locationQueryLoading = (canReadStockReferences && stockReference.loading)
    || (canReadEditableReferences && editableReferences.loading);
  const locationQueryError = !locationQueryAvailable ? (canReadStockReferences ? stockReference.error : "") || (canReadEditableReferences ? editableReferences.error : "") : "";
  const canShowOpening = canOpen && snapshotCurrent && !catalog.loading && !catalog.error && locationQueryAvailable && !locationQueryLoading && !preparers.loading && !preparers.error
    && selectableSkuRows.length > 0 && selectableLocationRows.length > 0 && selectablePreparerRows.length > 0;
  const createAction = () => skuAction(null, 0, openAction, onNotice);
  const loadMore = async () => {
    const snapshot = catalogSnapshot;
    if (!snapshot?.nextCursor || !snapshot.hasMore || !catalogPathBase || loadingMore || catalog.loading || catalog.error) return;
    loadMoreController.current?.abort();
    const controller = new AbortController();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setLoadMoreError("");
    const path = `${catalogPathBase}${search.trim() ? `&q=${encodeURIComponent(search.trim())}` : ""}&cursor=${encodeURIComponent(snapshot.nextCursor)}`;
    try {
      const next = await apiGet<CatalogResponse>(path, { signal: controller.signal });
      if (controller.signal.aborted || snapshot.path !== catalogPathBase || snapshot.refreshKey !== refreshKey) return;
      const versions = recordValue(next, "versions");
      setCatalogSnapshot(previous => previous?.path === catalogPathBase && previous.refreshKey === refreshKey ? {
        ...previous,
        items: mergeRows(previous.items, rowsOf(next)),
        versions: { ...previous.versions, ...(versions && typeof versions === "object" ? versions as Record<string, number> : {}) },
        nextCursor: text(next.nextCursor),
        hasMore: next.hasMore === true || Boolean(next.nextCursor),
      } : previous);
    } catch (error) {
      if (!controller.signal.aborted) setLoadMoreError(message(error, "No se pudieron cargar más productos."));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  };

  return <section className="manual-stock-tools ops-sheet" aria-label="Administración manual de catálogo y stock">
    <SectionHeading eyebrow="Inventario manual" title="Productos y apertura de stock" detail="Creá o editá productos de catálogo y registrá saldos iniciales con costo y aprobación independiente." action={canCreate ? <ActionButton onClick={createAction}>＋ Nuevo producto</ActionButton> : undefined} />

    {canOpen && !canReadCatalog && <InfoBand tone="warning" title="Falta permiso de lectura del catálogo"><p>La apertura requiere elegir un producto activo. Este perfil tiene permiso para aprobarla, pero no puede consultar productos; se necesita `stock.read` o `orders.write` para completar la selección.</p></InfoBand>}
    {canOpen && locationQueryError && <InfoBand tone="warning" title="No se pudieron cargar ubicaciones"><p>La apertura queda bloqueada hasta consultar ubicaciones visibles para este perfil. No se aceptan identificadores escritos a mano.</p></InfoBand>}
    {canOpen && !locationQueryLoading && !locationQueryAvailable && !locationQueryError && <InfoBand tone="warning" title="Falta permiso de lectura de ubicaciones"><p>La apertura necesita elegir una ubicación activa visible. Este perfil no puede consultar ubicaciones con sus permisos actuales.</p></InfoBand>}
    {canOpen && !locationQueryLoading && locationQueryAvailable && !selectableLocationRows.length && <InfoBand tone="info" title="Sin ubicaciones activas visibles"><p>Creá o activá una ubicación autorizada antes de registrar la apertura de stock.</p></InfoBand>}
    {canOpen && !preparers.loading && preparers.error && <InfoBand tone="warning" title="No se pudieron cargar personas preparadoras"><p>La apertura requiere una persona activa distinta de quien aprueba. La lista no está disponible para este alcance.</p></InfoBand>}
    {canOpen && !preparers.loading && !preparers.error && !selectablePreparerRows.length && preparers.data && <InfoBand tone="info" title="Falta una segunda persona"><p>Agregá o activá a otra persona para preparar el relevamiento. Quien aprueba no puede aprobar su propia preparación.</p></InfoBand>}
    {canOpen && !selectableSkuRows.length && snapshotCurrent && !catalog.loading && !catalog.error && <InfoBand tone="info" title="Sin productos activos visibles"><p>Creá un producto activo con nombre en catálogo antes de registrar el saldo inicial.</p></InfoBand>}
    {canOpen && catalogPathBase === null && canReadCatalog && <InfoBand tone="warning" title="No se pudo preparar el catálogo"><p>La lista de productos no está disponible para esta sesión. Actualizá la vista y verificá los permisos de lectura.</p></InfoBand>}

    {canCreate || canEdit || canOpen ? <div className="manual-stock-tools__controls">
      <label className="ops-field"><span>Buscar producto por nombre, código, variedad o categoría</span><input type="search" value={search} maxLength={120} onChange={event => { loadMoreController.current?.abort(); setLoadingMore(false); setSearch(event.target.value); setCatalogSnapshot(null); setLoadMoreError(""); }} placeholder="Ej.: Nalga, VAC-001" /></label>
      {canShowOpening && <ActionButton onClick={() => openingAction(context, selectableSkuRows, selectableLocationRows, custodianRows, selectablePreparerRows, openAction)}>Registrar apertura de stock</ActionButton>}
    </div> : null}

    {catalog.loading && !snapshotCurrent && <LoadingState label="Cargando productos activos e inactivos…" />}
    {catalog.error && !snapshotCurrent && <ErrorState message={catalog.error} retry={catalog.retry} />}
    {loadMoreError && <ErrorState message={loadMoreError} retry={() => { void loadMore(); }} />}

    {snapshotCurrent && skuRows.length === 0 && !catalog.loading && !catalog.error && (canCreate
      ? <EmptyState title={search ? "No encontramos productos" : "Todavía no hay productos"} detail={search ? "Probá otro código, nombre, variedad o categoría." : "Creá un producto y después registrá su stock mediante una recepción o apertura aprobada."} action={!search && canCreate ? <ActionButton onClick={createAction}>Crear producto</ActionButton> : undefined} />
      : <EmptyState title="No hay productos activos para seleccionar" detail="El stock inicial sólo puede asociarse a un producto de catálogo activo." />)}

    {snapshotCurrent && skuRows.length > 0 && <DataTable label="Productos de catálogo manual">
      <thead><tr><th scope="col">Producto</th><th scope="col">Código</th><th scope="col">Categoría · variedad</th><th scope="col">Unidad</th><th scope="col">Estado</th><th scope="col">Versión</th><th scope="col">Acciones</th></tr></thead>
      <tbody>{skuRows.map(row => {
        const id = idOf(row);
        const version = responseVersion({ versions: skuVersions }, id, Number.NaN);
        return <tr key={id}>
          <th scope="row">{labelOf(row)}</th>
          <td>{text(row.code, "—")}</td>
          <td>{text(row.category, "—")} · {text(row.variety, "—")}</td>
          <td>{text(row.unit) === "g" ? "Gramos · g" : "Unidades · ud"}</td>
          <td><StatusTag tone={row.active === true ? "good" : "neutral"}>{row.active === true ? "Activo" : "Inactivo"}</StatusTag></td>
          <td>{Number.isSafeInteger(version) ? version : "Sin versión"}</td>
          <td>{canEdit ? <ActionButton quiet disabled={catalog.loading || Boolean(catalog.error)} onClick={() => skuAction(row, version, openAction, onNotice)}>Editar</ActionButton> : "—"}</td>
        </tr>;
      })}</tbody>
    </DataTable>}
    {snapshotCurrent && catalogSnapshot.hasMore && <button type="button" className="ops-button ops-button-quiet" disabled={catalog.loading || loadingMore} onClick={() => { void loadMore(); }}>{loadingMore ? "Cargando productos…" : "Cargar más productos"}</button>}
    {canOpen && locationQueryLoading && <LoadingState label="Cargando ubicaciones y preparadores para la apertura…" />}
    {canOpen && !catalog.loading && !catalog.error && !locationQueryLoading && !preparers.loading && !preparers.error && snapshotCurrent && !canShowOpening && (selectableSkuRows.length > 0 && selectableLocationRows.length > 0) && <InfoBand tone="warning" title="Apertura no disponible"><p>Se necesita una lista vigente de preparadores activos y una persona distinta de quien aprueba. Actualizá las referencias antes de continuar.</p></InfoBand>}
    <p className="manual-stock-tools__note">El saldo no se modifica escribiendo cantidades en el catálogo: sólo una recepción registrada o una apertura aprobada crea stock.</p>
  </section>;
}
