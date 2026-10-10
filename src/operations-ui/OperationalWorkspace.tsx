import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { isTechnicalLegacySource } from "../../shared/operations/source-control";
import { cutoverGateIds } from "../../shared/operations/contracts";
import { SourcesWorkspace } from "./SourcesWorkspace";
import { FinanceWorkspace } from "./FinanceWorkspace";
import { apiGet, apiPost, hasCapability, hasCommand, OperationsApiError, recordValue, responseItems, responseVersion, textValue } from "./api";
import { amountFormToMinor, formatMinor } from "./money";
import { ActionButton, DataTable, EmptyState, ErrorState, InfoBand, LoadingState, SectionHeading, StatusTag } from "./Primitives";
import { HomeWorkspace, MissingRoute } from "./HomeWorkspace";
import { CommercialMarginPreview } from "./CommercialMarginPreview";
import { LegacyHistoryWorkflow } from "./LegacyHistoryWorkflow";
import { AppSheetMigrationReviewPanel } from "./AppSheetMigrationReviewPanel";
import { RemoteSelect } from "./RemoteSelect";
import { ProductInspector } from "./ProductInspector";
import { CanonicalExportPanel } from "./CanonicalExportPanel";
import { AccountSetup } from "./AccountSetup";
import { AppSheetCatalogue } from "./AppSheetCatalogue";
import { AppSheetInvoiceForm } from "./AppSheetInvoiceForm";
import { ReplacementReadiness } from "./ReplacementReadiness";
import { useRemote } from "./useRemote";
import type { ActionField, CommandAction, JsonRecord, OperationsContext, RunCommand } from "./types";
import { RouteOrderEditor, type RouteOrderStop } from "./RouteOrderEditor";
import { ManualReferenceData } from "./ManualReferenceData";
import { ManualStockTools } from "./ManualStockTools";

type Row = Record<string, unknown>;
type InvoiceCatalogueChannel = "local" | "delivery";
type InvoiceEditorState = { mode: "invoice" | "preorder" | "edit-preorder" | "confirm-preorder"; order?: Row; expectedVersion?: number; memberName?: string };
function objectValue(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function invoiceCatalogueChannelForOrder(order?: Row): InvoiceCatalogueChannel {
  const input = objectValue(objectValue(order?.quote).input);
  return Object.keys(objectValue(input.moto)).length > 0 ? "delivery" : "local";
}
type InvoiceTotalTrace = {
  currency: string;
  productsTotalMinor: unknown;
  motoClientTotalMinor: unknown;
  totalMinor: unknown;
  evidenceNote: string;
  actorLabel: string;
  confirmedAt: string;
  quoteVersion: string;
  snapshotHash: string;
};

function traceText(value: unknown, fallback = "Dato no disponible") {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return fallback;
}

function traceAmount(value: unknown, currency: string) {
  return typeof value === "string" && /^\d+$/.test(value) ? formatMinor(value, currency) : "Importe no disponible";
}

function InvoiceTotalTraceDialog({ trace, onClose }: { trace: InvoiceTotalTrace; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);
  const fieldStyle = { gridColumn: "1 / -1" as const };
  const valueStyle = { margin: 0, color: "var(--ops-ink)", fontWeight: 600, whiteSpace: "pre-wrap" as const, overflowWrap: "anywhere" as const, lineHeight: 1.5 };
  return <dialog className="ops-dialog" ref={dialog} data-testid="appsheet-invoice-total-trace-dialog" aria-labelledby="invoice-total-trace-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="ops-dialog-card">
      <header className="ops-dialog-head">
        <div><span className="ops-kicker">Confirmado por el personal</span><h2 id="invoice-total-trace-title">Confirmación del total facturado</h2><p>Detalle guardado de la factura. El total confirmado suma productos y moto.</p></div>
        <button type="button" className="ops-icon-button" aria-label="Cerrar confirmación del total" onClick={onClose}>×</button>
      </header>
      <div className="ops-dialog-fields" aria-label="Importes confirmados">
        <div className="ops-field"><span>Total de productos confirmado</span><output style={valueStyle}>{traceAmount(trace.productsTotalMinor, trace.currency)}</output></div>
        <div className="ops-field"><span>Total de moto confirmado</span><output style={valueStyle}>{traceAmount(trace.motoClientTotalMinor, trace.currency)}</output></div>
        <div className="ops-field"><span>Total facturado confirmado</span><output style={valueStyle}>{traceAmount(trace.totalMinor, trace.currency)}</output></div>
        <div className="ops-field" style={fieldStyle}><span>Evidencia registrada</span><output style={valueStyle}>{trace.evidenceNote || "Sin evidencia disponible"}</output></div>
        <div className="ops-field" style={fieldStyle}><span>Confirmado por</span><output style={valueStyle}>{trace.actorLabel}</output></div>
        <div className="ops-field" style={fieldStyle}><span>Fecha de confirmación</span><output style={valueStyle}>{trace.confirmedAt}</output></div>
        <div className="ops-field"><span>Versión de cotización</span><output style={valueStyle}>{trace.quoteVersion}</output></div>
        <div className="ops-field" style={fieldStyle}><span>Huella del resumen confirmado</span><output style={valueStyle}>{trace.snapshotHash}</output></div>
      </div>
      <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-primary" onClick={onClose}>Cerrar</button></footer>
    </div>
  </dialog>;
}
interface Props {
  pageId: string;
  context: OperationsContext;
  refreshKey: number;
  runCommand: RunCommand;
  openAction: (action: CommandAction) => void;
  onNotice: (message: string) => void;
  onRefresh: () => void;
}

const str = (values: Record<string, string | boolean>, key: string) => typeof values[key] === "string" ? values[key] as string : "";
const note = (values: Record<string, string | boolean>, key = "evidence") => {
  const value = str(values, key).trim();
  if (!value) throw new Error("Agregá la evidencia o el motivo requerido.");
  return { note: value };
};
function localDateTimeToIso(value: string, label: string): string {
  const parsed = new Date(value);
  if (!value || !Number.isFinite(parsed.getTime())) throw new Error(`${label}: ingresá una fecha y hora válidas.`);
  return parsed.toISOString();
}
const uuid = () => crypto.randomUUID();
const fields = (...items: ActionField[]) => items;
const field = (name: string, label: string, type: ActionField["type"] = "text", extra: Partial<ActionField> = {}): ActionField => ({ name, label, type, ...extra });
const select = (name: string, label: string, options: Array<{ value: string; label: string }>, required = true, help?: string): ActionField => ({ name, label, type: "select", options, required, help });

function action(command: string, title: string, inputFields: ActionField[], toData: (values: Record<string, string | boolean>) => JsonRecord, targetId?: string, expectedVersion?: number, requestIdIsTarget = false, description?: string): CommandAction {
  return { command, title, description, fields: inputFields, toData, ...(targetId ? { targetId } : {}), ...(expectedVersion !== undefined ? { expectedVersion } : {}), requestIdIsTarget, submitLabel: "Revisar y registrar" };
}

function rowsOf(value: unknown, key = "items"): Row[] {
  const rows = recordValue(value, key);
  return Array.isArray(rows) ? rows.filter((row): row is Row => Boolean(row) && typeof row === "object") : [];
}
function idOf(row: Row) { return textValue(row.id, ""); }
function mergePageRows(first: unknown, second: unknown) {
  const merged = new Map<string, Row>();
  const firstRows = Array.isArray(first) ? first.filter((row): row is Row => Boolean(row) && typeof row === "object") : rowsOf(first);
  const secondRows = Array.isArray(second) ? second.filter((row): row is Row => Boolean(row) && typeof row === "object") : rowsOf(second);
  for (const row of [...firstRows, ...secondRows]) {
    const key = idOf(row) || JSON.stringify(row);
    if (!merged.has(key)) merged.set(key, row);
  }
  return [...merged.values()];
}
function mergePageData(previous: Row, next: Row, listKeys: string[]): Row {
  const merged: Row = { ...previous, ...next };
  for (const key of listKeys) merged[key] = mergePageRows(previous[key], next[key]);
  const oldVersions = recordValue(previous, "versions"), newVersions = recordValue(next, "versions");
  if (oldVersions || newVersions) merged.versions = { ...(oldVersions as Row | undefined), ...(newVersions as Row | undefined) };
  return merged;
}
function useCursorResource(path: string | null, refreshKey: number, cursorParameter: string | null, cursorKey: string, hasMoreKey: string, listKeys: string[]) {
  const [request, setRequest] = useState<{ path: string; cursor: string } | null>(null);
  const [combined, setCombined] = useState<{ path: string; refreshKey: number; data: Row; cursor: string | null; hasMore: boolean } | null>(null);
  const first = useRemote<Row>(path, refreshKey);
  const cursorPath = path && request?.path === path && cursorParameter
    ? `${path}${path.includes("?") ? "&" : "?"}${cursorParameter}=${encodeURIComponent(request.cursor)}`
    : null;
  const next = useRemote<Row>(cursorPath, refreshKey);
  useEffect(() => {
    if (!path) { setCombined(null); setRequest(null); return; }
    if (first.loading || !first.data) return;
    const cursor = first.data[cursorKey];
    const nextCursor = typeof cursor === "string" && cursor.length ? cursor : null;
    setCombined({ path, refreshKey, data: first.data, cursor: nextCursor, hasMore: first.data[hasMoreKey] === true || Boolean(nextCursor) });
    setRequest(null);
  }, [path, refreshKey, first.loading, first.data, cursorKey, hasMoreKey]);
  useEffect(() => {
    if (!next.data || !path || request?.path !== path) return;
    const cursor = next.data[cursorKey];
    const nextCursor = typeof cursor === "string" && cursor.length ? cursor : null;
    setCombined(previous => previous?.path === path && previous.refreshKey === refreshKey
      ? { path, refreshKey, data: mergePageData(previous.data, next.data!, listKeys), cursor: nextCursor, hasMore: next.data![hasMoreKey] === true || Boolean(nextCursor) }
      : previous);
    setRequest(null);
  }, [next.data, path, refreshKey, request, cursorKey, hasMoreKey, listKeys]);
  // Retain the previous page for this resource while a refresh is in flight.
  // The caller keeps its rows visible and disables row actions until the new
  // version arrives, instead of unmounting the table during the read.
  const current = combined?.path === path ? combined : null;
  const currentRefresh = current?.refreshKey === refreshKey;
  return {
    data: current?.data ?? null,
    hasMore: Boolean(current?.hasMore && current.cursor),
    loading: first.loading || next.loading,
    error: first.error || next.error,
    retry: () => {
      if (first.error) first.retry();
      else if (next.error) next.retry();
    },
    loadMore: () => { if (path && cursorParameter && currentRefresh && !first.loading && !first.error && !next.loading && !next.error && current?.cursor) setRequest({ path, cursor: current.cursor }); },
  };
}
function labelOf(row: Row, nameKeys = ["name", "label", "title", "id"]) {
  for (const key of nameKeys) { const value = row[key]; if (typeof value === "string" && value) return value; }
  return "Registro";
}
function optionsOf(rows: Row[], keys = ["name", "label", "title", "id"]) {
  return rows.map(row => ({ value: idOf(row), label: labelOf(row, keys) })).filter(option => option.value);
}
function documentOptions(rows: Row[]) {
  return rows.flatMap(row => {
    const value = idOf(row);
    if (!value) return [];
    const parts = [textValue(row.kind, "Documento")];
    if (typeof row.validUntil === "string" && row.validUntil) parts.push(`vigente hasta ${row.validUntil}`);
    if (typeof row.sensitivity === "string" && row.sensitivity) parts.push(row.sensitivity === "clinical" ? "clínico" : row.sensitivity === "transport" ? "transporte" : "operativo");
    return [{ value, label: parts.join(" · ") }];
  });
}
function objectOptions(rows: Row[], key: string, keys = ["name", "label", "title", "id"]) {
  return rows.flatMap(row => Array.isArray(row[key]) ? (row[key] as Row[]).map(nested => ({ value: idOf(nested), label: labelOf(nested, keys) })) : []).filter(option => option.value);
}
function versionFor(data: unknown, row: Row, fallback = 0) {
  const version = recordValue(row, "version");
  return responseVersion(data, idOf(row), typeof version === "number" ? version : fallback);
}
function displayCell(row: Row, key: string) {
  const value = row[key];
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value.length > 96 ? `${value.slice(0, 93)}…` : value;
  if (Array.isArray(value)) return `${value.length} elementos`;
  return "—";
}
function shortReference(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.slice(0, 8).toUpperCase()
    : value;
}
function tableValue(row: Row, key: string, label: string) {
  if (key === "lastReconciledDate") return displayCell(row, key);
  if (key === "lastCountedMinor" || key === "lastDifferenceMinor") return formatMinor(row[key], row.currency);
  if (key === "id" || key.endsWith("Id")) {
    const raw = textValue(row[key], "");
    if (!raw) return "—";
    const resolved = key === "id" ? row.idLabel : row[`${key}Label`];
    const visible = textValue(resolved, `Ref. #${shortReference(raw)}`);
    return <span className="ops-table-reference" data-reference={key === "id" ? row.referenceKey : undefined} title={`Referencia técnica: ${raw}`}>{visible}</span>;
  }
  if (key === "balanceMinor" || key.endsWith("Minor")) return formatMinor(row[key], row.currency);
  if (key === "scenarioItems") {
    if (row.kind !== "scenarios") return "—";
    const definition = recordValue(row, "definition") && typeof recordValue(row, "definition") === "object" ? recordValue(row, "definition") as Row : {};
    const currency = textValue(definition.currency, "ARS");
    const items = Array.isArray(definition.items) ? definition.items.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
    if (!items.length) return "Sin supuestos";
    return <details className="ops-line-details"><summary>{items.length} supuestos · {currency}</summary><ul>{items.map((item, index) => <li key={textValue(item.id, String(index))}><strong>{textValue(item.date)} · {textValue(item.kind).replaceAll("_", " ")}</strong><span>{formatMinor(item.amountMinor, currency)} · {textValue(item.description)}{item.commitmentId ? ` · compromiso ${textValue(item.commitmentId)}` : ""}</span></li>)}</ul></details>;
  }
  if (key === "lines" && Array.isArray(row.lines)) return <details className="ops-line-details"><summary>{row.lines.length} líneas</summary><ul>{(row.lines as Row[]).map((line, index) => <li key={idOf(line) || index}><span>{textValue(line.skuLabel, "Producto sin nombre disponible")} · {textValue(line.unit, "unidad")} · {textValue(line.requested, "—")}</span></li>)}</ul></details>;
  if (key === "items" && Array.isArray(row.items)) return <details className="ops-line-details"><summary>{row.items.length} artículos</summary><ul>{(row.items as Row[]).map((item, index) => <li key={idOf(item) || index}><span>{textValue(item.skuLabel, "Artículo")} · {textValue(item.quantity)} {textValue(item.unit)} · costo unitario {textValue(item.unitCost)}</span></li>)}</ul></details>;
  if (key === "status" || key.endsWith("State") || key === "state") return <StatusTag>{reportStateLabel(displayCell(row, key))}</StatusTag>;
  if (key === "kind" || key === "coverage") return reportStateLabel(displayCell(row, key));
  if (key === "verified" || key === "active") return <StatusTag tone={row[key] ? "good" : "warn"}>{row[key] ? "Sí" : "Pendiente"}</StatusTag>;
  if (key === "evidence") return <details className="ops-line-details"><summary>Ver evidencia</summary><MetricValueView label="evidence" value={row.evidence} /></details>;
  return <span title={typeof row[key] === "string" ? row[key] as string : undefined}>{displayCell(row, key)}</span>;
}
function tableSearchValue(row: Row, key: string) {
  if (key === "lastCountedMinor" || key === "lastDifferenceMinor" || key === "balanceMinor" || key.endsWith("Minor")) return formatMinor(row[key], row.currency);
  if (key === "scenarioItems") {
    if (row.kind !== "scenarios") return "";
    const definition = recordValue(row, "definition") && typeof recordValue(row, "definition") === "object" ? recordValue(row, "definition") as Row : {};
    const items = Array.isArray(definition.items) ? definition.items : [];
    return `${items.length} supuestos ${textValue(definition.currency, "ARS")}`;
  }
  if (key === "lines" && Array.isArray(row.lines)) return `${row.lines.length} líneas`;
  if (key === "items" && Array.isArray(row.items)) return `${row.items.length} artículos`;
  if (key === "evidence") return "Ver evidencia";
  if (key === "id" || key.endsWith("Id")) {
    const raw = textValue(row[key], "");
    if (!raw) return "";
    const resolved = row[key === "id" ? "idLabel" : `${key}Label`];
    return textValue(resolved, `Ref. #${shortReference(raw)}`);
  }
  if (key === "status" || key.endsWith("State") || key === "state" || key === "kind" || key === "coverage") return reportStateLabel(displayCell(row, key));
  if (key === "verified" || key === "active") return row[key] ? "Sí" : "Pendiente";
  return displayCell(row, key);
}
function normalizeListSearch(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-AR");
}

function ProgressiveActionElements({ actions, alwaysDisclose = false, emptyMessage = null }: {
  actions: Array<ReactNode | null | undefined | false>;
  alwaysDisclose?: boolean;
  emptyMessage?: ReactNode;
}) {
  const visibleActions = actions.flatMap(item => item ? [item] : []);
  if (alwaysDisclose) return <details className="ops-row-actions-disclosure"><summary>Acciones <span>{visibleActions.length}</span></summary>{visibleActions.length ? <div className="ops-row-action-stack">{visibleActions}</div> : emptyMessage}</details>;
  if (!visibleActions.length) return emptyMessage;
  if (visibleActions.length === 1) return <div className="ops-row-action-stack">{visibleActions[0]}</div>;
  return <div className="ops-row-action-stack">{visibleActions[0]}<details className="ops-row-actions-disclosure"><summary>Más acciones <span>{visibleActions.length - 1}</span></summary><div className="ops-row-action-stack">{visibleActions.slice(1)}</div></details></div>;
}
function gateRecordsDisclosure(enabled: boolean, records: ReactNode) {
  return enabled ? <details className="ops-sheet ops-reference-sheet"><summary><span><span className="ops-kicker">Registro técnico</span><strong>Revisiones manuales de habilitaciones</strong></span><span>Detalle</span></summary>{records}</details> : records;
}
function parseRows(value: string, columns: number, labels: string[]): string[][] {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Agregá al menos una línea con los campos indicados.");
  return lines.map((line, index) => {
    const parts = line.split("|").map(part => part.trim());
    if (parts.length !== columns) throw new Error(`La línea ${index + 1} requiere ${columns} campos: ${labels.join(" · ")}.`);
    return parts;
  });
}
function repeatedValues(values: Record<string, string | boolean>, key: string): Record<string, string | boolean>[] {
  const parsed: unknown = JSON.parse(str(values, key) || "[]");
  if (!Array.isArray(parsed) || parsed.some(row => !row || typeof row !== "object" || Array.isArray(row) || Object.values(row).some(value => typeof value !== "string" && typeof value !== "boolean"))) throw new Error("Revisá las líneas del formulario.");
  return parsed as Record<string, string | boolean>[];
}
function scopeIdList(value: string): string[] {
  return [...new Set(value.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean))];
}
function refundAllocation(values: Record<string, string | boolean>): JsonRecord {
  const rows = str(values, "lines").trim() ? parseRows(str(values, "lines"), 2, ["línea", "importe"]) : [];
  const seen = new Set<string>();
  const lines = rows.map(([lineId, amount]) => {
    if (seen.has(lineId)) throw new Error("Cada línea puede aparecer una sola vez en el reintegro.");
    seen.add(lineId);
    const amountMinor = BigInt(amountFormToMinor(amount));
    if (amountMinor <= 0n) throw new Error("Cada importe asignado a una línea debe ser mayor que cero.");
    return { lineId, amountMinor: amountMinor.toString() };
  });
  const deliveryMinor = BigInt(amountFormToMinor(str(values, "delivery") || "0"));
  const surchargeMinor = BigInt(amountFormToMinor(str(values, "surcharge") || "0"));
  if (deliveryMinor < 0n || surchargeMinor < 0n) throw new Error("Los cargos asignados no pueden ser negativos.");
  const amountMinor = lines.reduce((sum, line) => sum + BigInt(line.amountMinor), deliveryMinor + surchargeMinor);
  if (amountMinor <= 0n) throw new Error("Asigná el reintegro a una o más líneas, entrega o recargos.");
  return {
    accountId: str(values, "accountId"),
    amountMinor: amountMinor.toString(),
    lines,
    deliveryMinor: deliveryMinor.toString(),
    surchargeMinor: surchargeMinor.toString(),
    reason: str(values, "reason"),
    evidence: note(values),
  };
}
function scaledQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") return null;
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,12}))?$/.exec(String(value));
  if (!match) return null;
  return BigInt(match[1]!) * 10n ** 12n + BigInt((match[2] ?? "").padEnd(12, "0") || "0");
}
function quantityForUnit(value: string, unit: unknown, label: string, allowZero = false): string {
  const result = decimal(value, label);
  const places = result.split(".")[1]?.length ?? 0;
  if (result.startsWith("-") || (unit === "ud" ? places !== 0 : places > 3))
    throw new Error(`${label}: ${unit === "ud" ? "usá unidades enteras" : "usá hasta tres decimales"}.`);
  if (scaledQuantity(result) === null || (!allowZero && scaledQuantity(result) === 0n)) throw new Error(`${label}: ingresá una cantidad mayor que cero.`);
  return result;
}
function purchaseLines(row: Row): Row[] {
  return Array.isArray(row.items) ? row.items.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
}
function purchaseLineId(line: Row): string {
  return textValue(line.lineId, "").trim() || idOf(line);
}
function activeNamedPurchaseSku(line: Row, catalogRows: Row[]): (Row & { name: string }) | null {
  const skuId = textValue(line.skuId, "");
  const matches = skuId ? catalogRows.filter(row => idOf(row) === skuId) : [];
  if (matches.length !== 1) return null;
  const sku = matches[0]!;
  if (sku.active !== true || typeof sku.name !== "string" || !sku.name.trim() || sku.unit !== line.unit) return null;
  return { ...sku, name: sku.name };
}
function visibleInvoiceLineName(line: Row, catalogRows: Row[]) {
  const skuId = textValue(line.skuId, "");
  const matches = skuId ? catalogRows.filter(row => idOf(row) === skuId) : [];
  const catalogName = matches.length === 1 && typeof matches[0]!.name === "string" ? matches[0]!.name.trim() : "";
  for (const candidate of [catalogName, line.skuLabel, line.skuName, line.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}
function remainingPurchaseLines(row: Row, receipts: Row[]): Array<{ line: Row; remaining: bigint | null }> {
  const receivedByLine = new Map<string, bigint>();
  for (const receipt of receipts) {
    if (receipt.purchaseId !== idOf(row) || !Array.isArray(receipt.items)) continue;
    for (const item of receipt.items) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Row;
      const quantity = scaledQuantity(entry.quantity);
      const lineId = textValue(entry.lineId, "");
      if (lineId && quantity !== null) receivedByLine.set(lineId, (receivedByLine.get(lineId) ?? 0n) + quantity);
    }
  }
  return purchaseLines(row).map(line => {
    const ordered = scaledQuantity(line.quantity);
    const lineId = purchaseLineId(line);
    if (ordered === null || !lineId) return { line, remaining: null };
    const received = receivedByLine.get(lineId) ?? 0n;
    return { line, remaining: received > ordered ? 0n : ordered - received };
  });
}
function formatScaled(value: bigint): string {
  const whole = value / (10n ** 12n);
  const fraction = (value % (10n ** 12n)).toString().padStart(12, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `,${fraction}` : ""}`;
}
function returnAvailability(allocation: Row) {
  const actual = scaledQuantity(allocation.actualQuantity);
  const delivered = scaledQuantity(allocation.deliveredQuantity);
  const returned = scaledQuantity(allocation.returnedQuantity);
  const returnedDelivered = scaledQuantity(allocation.returnedDeliveredQuantity);
  if (actual === null || delivered === null || returned === null || returnedDelivered === null) return null;
  const customer = delivered - returnedDelivered;
  const undelivered = actual - delivered - (returned - returnedDelivered);
  return {
    customer: customer > 0n ? customer : 0n,
    undelivered: undelivered > 0n ? undelivered : 0n,
  };
}
function decimal(value: string, label: string) {
  const normalized = value.replace(",", ".");
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(normalized)) throw new Error(`${label}: usá una cantidad decimal válida.`);
  return normalized;
}
function accrualPeriodValue(values: Record<string, string | boolean>): string {
  const value = str(values, "accrualPeriod");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error("Elegí el período de devengamiento en formato YYYY-MM.");
  return value;
}
function localDate(timeZone = "America/Argentina/Buenos_Aires") { return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date()); }
function maximumPercentToBps(value: string): number {
  const normalized = value.trim().replace(",", ".");
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error("Ingresá un porcentaje decimal entre 0 y 100.");
  const fraction = match[2] ?? "";
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2)))
    throw new Error("El porcentaje debe convertirse a una cantidad entera de puntos básicos; usá hasta dos decimales.");
  const basisPoints = BigInt(match[1]!) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, "0") || "0");
  if (basisPoints > 10000n) throw new Error("El porcentaje no puede superar 100%.");
  return Number(basisPoints);
}
const DAY_MS = 86_400_000;
function civilOrdinal(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const timestamp = Date.UTC(year!, month! - 1, day!);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return Math.floor(timestamp / DAY_MS);
}
function civilDateFromOrdinal(ordinal: number) { return new Date(ordinal * DAY_MS).toISOString().slice(0, 10); }
function thirteenWeekHorizon(referenceDate: string) {
  const ordinal = civilOrdinal(referenceDate);
  if (ordinal === null) throw new Error("No se pudo determinar una fecha civil válida para el horizonte.");
  const weekday = new Date(ordinal * DAY_MS).getUTCDay();
  const firstDay = ordinal - ((weekday + 6) % 7);
  return { from: civilDateFromOrdinal(firstDay), through: civilDateFromOrdinal(firstDay + 13 * 7 - 1) };
}
function proposeManualScenario(values: Record<string, string | boolean>, configurations: Row[], timeZone: string): JsonRecord {
  const currency = str(values, "currency");
  if (currency !== "ARS" && currency !== "USD") throw new Error("Elegí ARS o USD para este escenario.");
  const horizon = thirteenWeekHorizon(localDate(timeZone));
  const date = str(values, "scenarioDate");
  const dateOrdinal = civilOrdinal(date);
  if (dateOrdinal === null || date < horizon.from || date > horizon.through)
    throw new Error(`La fecha debe quedar dentro de las 13 semanas del ${horizon.from} al ${horizon.through}.`);
  const kind = str(values, "scenarioKind");
  if (!["income", "payment", "purchase", "funding"].includes(kind)) throw new Error("Elegí el tipo de escenario publicado.");
  const description = str(values, "description").trim();
  if (!description || description.length > 300) throw new Error("La descripción requiere entre 1 y 300 caracteres.");
  const amountMinor = checkedMinor(str(values, "amount"), "El supuesto", false);
  const commitmentId = str(values, "commitmentId").trim();
  if (commitmentId.length > 100) throw new Error("La referencia del compromiso supera los 100 caracteres admitidos.");
  const name = `Escenarios manuales · ${currency}`;
  const matching = configurations.filter(row => row.name === name);
  if (matching.some(row => row.state === "proposed"))
    throw new Error(`Ya hay una propuesta de escenario ${currency} pendiente de revisión. Resolvela antes de enviar otra versión.`);
  const versions = matching.map(row => row.version).filter((version): version is number => typeof version === "number" && Number.isSafeInteger(version) && version > 0);
  const latestVersion = versions.length ? Math.max(...versions) : 0;
  if (latestVersion >= Number.MAX_SAFE_INTEGER) throw new Error("No se puede crear otra versión de escenario con el contador actual.");
  const approved = matching.filter(row => row.state === "approved" && typeof row.approvedBy === "string" && typeof row.approvedAt === "string")
    .sort((left, right) => Number(right.version) - Number(left.version))[0];
  const approvedDefinition = approved?.definition && typeof approved.definition === "object" ? approved.definition as Row : {};
  const rawItems = Array.isArray(approvedDefinition.items) ? approvedDefinition.items : [];
  const baseItems = rawItems.filter((item): item is Row => Boolean(item) && typeof item === "object")
    .filter(item => typeof item.date === "string" && item.date >= horizon.from && item.date <= horizon.through && typeof item.id === "string" && typeof item.kind === "string" && typeof item.amountMinor === "string" && typeof item.description === "string")
    .map(item => ({ id: item.id as string, date: item.date as string, kind: item.kind as string, amountMinor: item.amountMinor as string, ...(typeof item.commitmentId === "string" ? { commitmentId: item.commitmentId } : {}), description: item.description as string }));
  if (baseItems.length >= 500) throw new Error("El escenario ya contiene el máximo de 500 supuestos para 13 semanas.");
  if (commitmentId && baseItems.some(item => item.commitmentId === commitmentId))
    throw new Error("Ese compromiso ya está incluido en el escenario aprobado.");
  const item = { id: uuid(), date, kind, amountMinor, ...(commitmentId ? { commitmentId } : {}), description };
  const evidence = note(values);
  return {
    name,
    kind: "scenarios",
    version: latestVersion + 1,
    validFrom: horizon.from,
    validUntil: horizon.through,
    definition: { currency, weeks: 13, items: [...baseItems, item], evidence },
    evidence,
  };
}
function checkedMinor(value: string, label: string, allowZero = false): string {
  const amount = BigInt(amountFormToMinor(value.trim() || "0"));
  if ((allowZero ? amount < 0n : amount <= 0n) || amount > 9223372036854775807n)
    throw new Error(`${label}: ingresá un importe ${allowZero ? "no negativo" : "positivo"} dentro del rango admitido.`);
  return amount.toString();
}
function currencyField(currency = "ARS"): ActionField { return select("currency", "Moneda", ["ARS", "USD"].map(value => ({ value, label: value })), true, "Los importes de distintas monedas se conservan por separado."); }
function evidenceField(label = "Motivo y evidencia"): ActionField { return field("evidence", label, "textarea", { required: true, help: "Queda asociado al movimiento y al registro de auditoría." }); }

function pageSpec(pageId: string, context: OperationsContext) {
  const read: Record<string, string> = {
    members: "/api/operations/members", catalog: "/api/operations/catalog", orders: "/api/operations/orders",
    purchases: "/api/operations/purchases", routes: "/api/operations/routes", tasks: "/api/operations/tasks",
    collections: "/api/operations/collections", accounts: "/api/operations/accounts", payables: "/api/operations/payables",
    settlements: "/api/operations/settlements", commercial: "/api/operations/policies", configuration: "/api/operations/configuration",
    access: "/api/operations/access", gates: "/api/operations/authority", permissions: "/api/operations/documents",
  };
  const titles: Record<string, [string, string]> = {
    members: ["Personas", "Socios"], catalog: ["Inventario", "Catálogo y disponibilidad"], orders: ["Operación", "Pedidos"],
    purchases: ["Abastecimiento", "Compras y recepción"], routes: ["Logística", "Rutas y entregas"], tasks: ["Seguimiento", "Tareas"],
    collections: ["Finanzas", "Cobros"], accounts: ["Finanzas", "Cuentas y saldos"], payables: ["Finanzas", "Obligaciones"],
    settlements: ["Finanzas", "Rendiciones"], commercial: ["Gestión comercial", "Políticas, packs y promociones"],
    configuration: ["Gestión", "Configuración versionada"], imports: ["Migración", "Importación legado"], access: ["Administración", "Accesos"],
    gates: ["Control", "Habilitación y auditoría"], permissions: ["Personas", "Permisos y documentos"], reports: ["Control", "Informes operativos"],
  };
  const caps: Record<string, string> = {
    members: "members.read", catalog: hasCapability(context, "stock.read") ? "stock.read" : "orders.write", orders: "operations.read",
    purchases: "purchases.write", routes: "logistics.write", tasks: "operations.read", collections: "finance.read", accounts: "finance.read",
    payables: "finance.read", settlements: "finance.read", commercial: "prices.propose", configuration: "prices.propose", access: "access.manage",
    gates: "cutover.approve", permissions: "documents.read", reports: "reports.read",
  };
  return { path: read[pageId] ?? null, eyebrow: titles[pageId]?.[0] ?? "Operación", title: titles[pageId]?.[1] ?? "Operaciones", capability: caps[pageId] };
}

function PeriodCoveragePanel({ context, runCommand, onRefresh, onNotice }: { context: OperationsContext; runCommand: RunCommand; onRefresh: () => void; onNotice: (message: string) => void }) {
  const canPropose = hasCapability(context, "imports.review") && hasCommand(context, "PeriodCoverageProposed");
  const canApprove = hasCapability(context, "imports.review") && hasCommand(context, "PeriodCoverageApproved");
  const [period, setPeriod] = useState(() => localDate(context.timeZone).slice(0, 7));
  const [sourceReference, setSourceReference] = useState("");
  const [proposalEvidence, setProposalEvidence] = useState("");
  const [approvalId, setApprovalId] = useState("");
  const [approvalEvidence, setApprovalEvidence] = useState("");
  const [createdProposalId, setCreatedProposalId] = useState("");
  const [pendingAttempt, setPendingAttempt] = useState<{ fingerprint: string; targetId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const reference = sourceReference.trim();
    const evidence = proposalEvidence.trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || !reference || !evidence) {
      setError("Indicá un período YYYY-MM, una referencia de conciliación y su evidencia.");
      return;
    }
    const data: JsonRecord = { period, sourceReconciliationReference: reference, evidence: { note: evidence } };
    const fingerprint = JSON.stringify(data);
    const targetId = pendingAttempt?.fingerprint === fingerprint ? pendingAttempt.targetId : uuid();
    setPendingAttempt({ fingerprint, targetId });
    setBusy(true);
    setError("");
    try {
      await runCommand("PeriodCoverageProposed", targetId, 0, data, true);
      setCreatedProposalId(targetId);
      setPendingAttempt(null);
      onRefresh();
      onNotice("Conciliación de período propuesta. Compartí el UUID con otra persona revisora; todavía no está aprobada.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo proponer la conciliación del período.");
    } finally {
      setBusy(false);
    }
  }

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const targetId = approvalId.trim();
    const evidence = approvalEvidence.trim();
    if (!targetId || !evidence) {
      setError("Indicá el UUID de la propuesta y la evidencia de revisión independiente.");
      return;
    }
    if (targetId === createdProposalId) {
      setError("La propuesta que acabás de crear requiere otra persona revisora.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await runCommand("PeriodCoverageApproved", targetId, 1, { evidence: { note: evidence } });
      setApprovalId("");
      setApprovalEvidence("");
      onRefresh();
      onNotice("Conciliación aprobada. El servidor confirmó otra persona revisora y volvió a comparar la huella de fuentes.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo aprobar la conciliación del período.");
    } finally {
      setBusy(false);
    }
  }

  if (!canPropose && !canApprove) return null;
  return <section className="ops-sheet ops-upload-sheet">
    <div className="ops-sheet-head"><div><span className="ops-kicker">Control · cobertura completa</span><h3>Conciliar período de gestión</h3></div><StatusTag tone="warn">Revisión independiente</StatusTag></div>
    <p>La propuesta captura una huella completa del período y su referencia externa. La aprobación vuelve a consultar las fuentes, exige otro revisor y falla si cambió la huella.</p>
    {canPropose && <form className="ops-form-grid" onSubmit={event => void propose(event)}>
      <label className="ops-field"><span>Período a conciliar</span><input aria-label="Período a conciliar" type="month" value={period} onChange={event => setPeriod(event.target.value)} required /></label>
      <label className="ops-field"><span>Referencia de conciliación de origen</span><input aria-label="Referencia de conciliación de origen" value={sourceReference} onChange={event => setSourceReference(event.target.value)} maxLength={500} required /></label>
      <label className="ops-field ops-file-field"><span>Evidencia de la propuesta</span><textarea aria-label="Evidencia de la propuesta" value={proposalEvidence} onChange={event => setProposalEvidence(event.target.value)} maxLength={2000} required /></label>
      <div className="ops-upload-foot"><p>La propuesta no acredita el período hasta que otra persona la apruebe.</p><button className="ops-button ops-button-primary" type="submit" disabled={busy}>{busy ? "Preparando…" : "Proponer conciliación"}</button></div>
    </form>}
    {createdProposalId && <p role="status">UUID de propuesta para compartir con quien revisa: <code>{createdProposalId}</code></p>}
    {canApprove && <form className="ops-form-grid" onSubmit={event => void approve(event)}>
      <label className="ops-field"><span>UUID de propuesta pendiente</span><input aria-label="UUID de propuesta pendiente" value={approvalId} onChange={event => setApprovalId(event.target.value)} maxLength={100} required /></label>
      <label className="ops-field ops-file-field"><span>Evidencia de revisión independiente</span><textarea aria-label="Evidencia de revisión independiente" value={approvalEvidence} onChange={event => setApprovalEvidence(event.target.value)} maxLength={2000} required /></label>
      <div className="ops-upload-foot"><p>Usá el identificador de la propuesta pendiente y adjuntá la evidencia de la revisión independiente. Cada propuesta nueva se crea en versión de objeto 1.</p><button className="ops-button ops-button-primary" type="submit" disabled={busy}>{busy ? "Revisando…" : "Aprobar con revisión independiente"}</button></div>
    </form>}
    {error && <ErrorState message={error} />}
  </section>;
}

function DocImportPanels({ pageId, context, refreshKey, runCommand, onRefresh, onNotice }: { pageId: "permissions" | "imports"; context: OperationsContext; refreshKey: number; runCommand: RunCommand; onRefresh: () => void; onNotice: (message: string) => void }) {
  const [searchParams] = useSearchParams();
  const sourceTarget = (snapshotId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("section", "sources");
    next.set("sourceId", snapshotId);
    for (const key of ["sourceTable", "recordQ", "recordCursor", "recordId", "exceptionsOnly"]) next.delete(key);
    return { search: `?${next.toString()}` };
  };
  const canReadDocs = hasCapability(context, "documents.read");
  const canReadMembers = hasCapability(context, "members.read");
  const docs = useRemote<Record<string, unknown>>(canReadDocs ? "/api/operations/documents" : null, refreshKey);
  const canReviewImports = pageId === "imports" && hasCapability(context, "imports.review");
  const imports = useRemote<Record<string, unknown>>(canReviewImports ? "/api/legacy-imports/coverage" : null, refreshKey);
  const [file, setFile] = useState<File | null>(null);
  const [memberId, setMemberId] = useState("");
  const [kind, setKind] = useState("operations_permission");
  const [sensitivity, setSensitivity] = useState<"commercial" | "clinical">("commercial");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [batchIdInput, setBatchIdInput] = useState("");
  const [progressBatchId, setProgressBatchId] = useState("");
  const [progressRefreshKey, setProgressRefreshKey] = useState(0);
  const progressPath = progressBatchId ? `/api/legacy-imports/batches/${encodeURIComponent(progressBatchId)}` : null;
  const progress = useRemote<Row>(progressPath, refreshKey + progressRefreshKey);

  async function bytesBase64(input: File) {
    const bytes = new Uint8Array(await input.arrayBuffer());
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const digest = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { bytes, base64: btoa(binary), checksum: digest };
  }
  function chooseFile(event: ChangeEvent<HTMLInputElement>, assign: (file: File | null) => void, maxBytes: number) {
    const chosen = event.target.files?.[0] ?? null;
    if (chosen && chosen.size > maxBytes) { setLocalError(`El archivo supera el máximo de ${Math.floor(maxBytes / 1_000_000)} MB.`); assign(null); return; }
    setLocalError(""); assign(chosen);
  }
  async function uploadDocument() {
    if (!file) return;
    setBusy(true); setLocalError("");
    try {
      const mime = file.type === "application/pdf" ? "application/pdf" : file.type === "image/png" ? "image/png" : file.type === "image/jpeg" ? "image/jpeg" : "";
      if (!mime) throw new Error("Elegí un PDF, PNG o JPG para adjuntar como evidencia.");
      const payload = await bytesBase64(file);
      const referenceId = uuid();
      const reference = await runCommand("DocumentReferenced", referenceId, 0, { memberId: memberId.trim() || undefined, kind: kind.trim(), sensitivity, metadata: { filename: file.name } }, true);
      const created = recordValue(reference, "result");
      const document = recordValue(created, "document") as Row | undefined;
      const id = textValue(document?.id, referenceId);
      const stored = await apiPost<{ key: string; version: string; checksum: string; bytes: number; mediaType: string }>(`/api/operations/documents/${id}/upload`, { contentBase64: payload.base64, mediaType: mime, checksum: payload.checksum });
      await runCommand("DocumentMadeAvailable", id, 1, stored);
      setFile(null); onRefresh(); onNotice("Documento cargado, checksum validado y puesto a disposición.");
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : "No se pudo completar la carga del documento."); }
    finally { setBusy(false); }
  }
  function loadBatchProgress() {
    const id = batchIdInput.trim();
    if (!id || id.length > 100) { setLocalError("Ingresá el identificador del lote (hasta 100 caracteres)." ); return; }
    setLocalError("");
    setProgressBatchId(id);
    setProgressRefreshKey(value => value + 1);
  }
  async function reviewSnapshot(row: Row) {
    const snapshotId = idOf(row);
    const fileHash = textValue(row.fileHash, "");
    const changed = Boolean(recordValue(row.controls, "requiresChangedContentReview"));
    const evidence = window.prompt("Evidencia de revisión independiente (no incluyas datos clínicos):");
    if (!evidence?.trim()) return;
    const previous = changed ? window.prompt("Hash de la versión anterior indicado en el lote:", textValue(recordValue(row.controls, "previousFileHash"), "")) : undefined;
    if (changed && !previous) return;
    setBusy(true); setLocalError("");
    try {
      await apiPost(`/api/legacy-imports/${snapshotId}/review`, { requestId: uuid(), fileHash, changedContentReviewed: changed, evidence: { summary: evidence.trim(), ...(previous ? { previousFileHash: previous.trim() } : {}) } });
      onRefresh(); onNotice("Lote revisado. La resolución de excepciones y el mapeo siguen siendo pasos separados.");
    } catch (cause) { setLocalError(cause instanceof Error ? cause.message : "No se pudo revisar el lote."); }
    finally { setBusy(false); }
  }

  if (pageId === "permissions") {
    const documentRows = rowsOf(docs.data);
    const canUploadClinical = hasCapability(context, "documents.write") && hasCapability(context, "clinical.review");
    return <div className="ops-page-body">
      <SectionHeading eyebrow="Personas · evidencia" title="Permisos y documentos" detail="Cargá el documento, validá su integridad y vinculalo al socio antes de verificar un permiso operativo." />
      {hasCommand(context, "DocumentReferenced") && hasCommand(context, "DocumentMadeAvailable") && <section className="ops-sheet ops-upload-sheet">
        <div className="ops-sheet-head"><div><span className="ops-kicker">Documento privado</span><h3>Adjuntar evidencia</h3></div><StatusTag tone="olive">PDF · PNG · JPG</StatusTag></div>
        <div className="ops-form-grid">
          <div className="ops-field"><span>Socio <small>(opcional; requerido para vincular el documento a un permiso)</small></span>{canReadMembers
            ? <RemoteSelect field={{ name: "memberId", label: "Socio", type: "select", required: false, lookupPath: "/api/operations/members" }} value={memberId} onChange={setMemberId} />
            : <small>Este perfil no puede consultar socios por nombre; la carga quedará sin vincular a una persona.</small>}</div>
          <label className="ops-field"><span>Tipo de documento</span><input value={kind} onChange={event => setKind(event.target.value)} maxLength={80} /></label>
          <label className="ops-field"><span>Sensibilidad</span><select value={sensitivity} onChange={event => setSensitivity(event.target.value === "clinical" && canUploadClinical ? "clinical" : "commercial")}><option value="commercial">Comercial / operativo</option>{canUploadClinical && <option value="clinical">Clínica · acceso restringido</option>}</select><small>Los documentos clínicos sólo se habilitan con permisos explícitos de escritura documental y revisión clínica.</small></label>
          <label className="ops-field ops-file-field"><span>Archivo (máximo 3 MB)</span><input type="file" accept="application/pdf,image/png,image/jpeg" onChange={event => chooseFile(event, setFile, 3_000_000)} /></label>
        </div>
        <div className="ops-upload-foot"><p>El archivo se procesa en memoria, se valida por tipo y SHA-256 y viaja al almacenamiento privado del servidor.</p><ActionButton onClick={() => void uploadDocument()} disabled={!file || busy}>{busy ? "Procesando…" : "Cargar y verificar checksum"}</ActionButton></div>
      </section>}
      {localError && <ErrorState message={localError} />}
      {docs.loading && <LoadingState />}{docs.error && <ErrorState message={docs.error} retry={docs.retry} />}
      <ListTable title="Documentos disponibles para este perfil" rows={documentRows} columns={[["kind", "Tipo"], ["sensitivity", "Sensibilidad"], ["memberId", "Socio"], ["orderId", "Pedido"], ["deliveryId", "Entrega"], ["state", "Estado"], ["validUntil", "Vigencia"]]} />
      {hasCapability(context, "permissions.verify") && <InfoBand title="Verificación del permiso operativo">
        <p>Desde Personas › Socios, elegí el registro del socio y usá “Verificar permiso” con un documento disponible vinculado a esa misma persona. La confirmación exige fechas y el servidor valida vigencia.</p>
      </InfoBand>}
    </div>;
  }

  return <div className="ops-page-body">
    <SectionHeading eyebrow="Gestión · migración" title="Importar libro legado" detail="La herramienta local sanea el libro y transmite datos por lotes reanudables. Esta pantalla sólo consulta progreso y conserva la revisión independiente." />
    {(hasCapability(context, "imports.write") || canReviewImports) && <section className="ops-sheet ops-upload-sheet">
      <div className="ops-sheet-head"><div><span className="ops-kicker">Carga resumible · sin archivo en el navegador</span><h3>Seguir un lote de importación</h3></div><StatusTag tone="olive">CLI local · ops:import</StatusTag></div>
      <InfoBand tone="warning" title="Procesá el XLSX en la herramienta local"><p>Ejecutá <code>ops:import</code> en una computadora autorizada. La CLI lee el libro y excluye secretos antes de transmitir filas saneadas. No cargues ni pegues el XLSX en Bombo o en un servicio de producción.</p></InfoBand>
      <form className="ops-form-grid" onSubmit={event => { event.preventDefault(); loadBatchProgress(); }}>
        <label className="ops-field"><span>Identificador devuelto por la CLI</span><input aria-label="Identificador del lote" value={batchIdInput} onChange={event => setBatchIdInput(event.target.value)} maxLength={100} autoComplete="off" /></label>
        <div className="ops-upload-foot"><p>El monitor hace una consulta de sólo lectura a <code>GET /api/legacy-imports/batches/:id</code>.</p><button type="submit" className="ops-button ops-button-primary" disabled={!batchIdInput.trim() || progress.loading}>Consultar progreso</button></div>
      </form>
      {progressBatchId && progress.loading && <LoadingState label="Consultando progreso del lote…" />}
      {progressBatchId && progress.error && <ErrorState message={progress.error} retry={() => setProgressRefreshKey(value => value + 1)} />}
      {progress.data && !progress.error && <div className="ops-import-progress" aria-label="Progreso del lote">
        <div><span>Estado</span><StatusTag tone={progress.data.status === "staged" || progress.data.status === "reviewed" ? "good" : progress.data.status === "quarantined" ? "bad" : "warn"}>{reportStateLabel(textValue(progress.data.status))}</StatusTag></div>
        <div><span>Filas recibidas</span><strong>{textValue(progress.data.receivedRecords, "0")} / {textValue(progress.data.expectedRecords, "0")}</strong></div>
        <div><span>Fragmentos recibidos</span><strong>{rowsOf(progress.data, "chunks").length} / {textValue(progress.data.expectedChunks, "0")}</strong></div>
        <div><span>Bytes recibidos</span><strong>{textValue(progress.data.receivedBytes, "0")}</strong></div>
        <div><span>Finalizado</span><strong>{progress.data.completedAt ? textValue(progress.data.completedAt) : "Todavía no"}</strong></div>
        <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => setProgressRefreshKey(value => value + 1)} disabled={progress.loading}>Actualizar progreso</button>
      </div>}
    </section>}
    {localError && <ErrorState message={localError} />}
    {imports.loading && <LoadingState label="Leyendo lotes y revisiones…" />}{imports.error && <ErrorState message={imports.error} retry={imports.retry} />}
    {canReviewImports && <ListTable title="Lotes y revisiones recientes" rows={rowsOf(imports.data)} columns={[["filename", "Libro"], ["sourceSystem", "Origen"], ["status", "Estado"], ["createdAt", "Creado"]]} renderActions={row => <>
      {row.status === "uploading" && <ActionButton quiet onClick={() => { const id = idOf(row); setBatchIdInput(id); setProgressBatchId(id); setProgressRefreshKey(value => value + 1); }}>Seguir carga</ActionButton>}
      <Link className="ops-button ops-button-quiet ops-button-small" to={sourceTarget(idOf(row))}>Ver tablas y filas</Link>
      {isTechnicalLegacySource(textValue(row.sourceSystem, "")) && <StatusTag tone="neutral">Fuente de consulta</StatusTag>}
      {hasCommand(context, "LegacySnapshotReviewed") && row.status === "staged" && !isTechnicalLegacySource(textValue(row.sourceSystem, "")) && <ActionButton quiet onClick={() => void reviewSnapshot(row)} disabled={busy}>Revisar independientemente</ActionButton>}
    </>} />
    }
    {pageId === "imports" && <LegacyHistoryWorkflow context={context} refreshKey={refreshKey} runCommand={runCommand} onRefresh={onRefresh} onNotice={onNotice} />}
    {pageId === "imports" && <AppSheetMigrationReviewPanel context={context} runCommand={runCommand} onRefresh={onRefresh} onNotice={onNotice} />}
    <PeriodCoveragePanel context={context} runCommand={runCommand} onRefresh={onRefresh} onNotice={onNotice} />
    {hasCapability(context, "imports.write") && !canReviewImports && <InfoBand tone="warning" title="La revisión requiere otro perfil"><p>Este perfil puede consultar el progreso de su carga, pero la revisión de un lote finalizado corresponde a otra persona con permiso imports.review.</p></InfoBand>}
  </div>;
}

function ListTable({ title, rows, columns, renderActions, compactRows = false, showFilter = rows.length >= 8, searchValue, onSearchChange, onClearSearch, hasMore = false }: { title: string; rows: Row[]; columns: Array<[string, string]>; renderActions?: (row: Row) => ReactNode; compactRows?: boolean; showFilter?: boolean; searchValue?: string; onSearchChange?: (value: string) => void; onClearSearch?: () => void; hasMore?: boolean }) {
  const [localSearch, setLocalSearch] = useState("");
  const activeSearch = searchValue ?? localSearch;
  const setSearch = onSearchChange ?? setLocalSearch;
  const normalizedSearch = normalizeListSearch(activeSearch.trim());
  const visibleRows = normalizedSearch
    ? rows.filter(row => columns.some(([key]) => normalizeListSearch(tableSearchValue(row, key)).includes(normalizedSearch)))
    : rows;
  const filtered = normalizedSearch.length > 0;
  if (!rows.length) return <section className="ops-sheet"><EmptyState title="Todavía no hay registros" detail="Los registros aparecen cuando el servidor devuelve datos dentro del alcance de este perfil." /></section>;
  const clearSearch = () => { setSearch(""); onClearSearch?.(); };
  return <section className={`ops-sheet ops-list-sheet${compactRows ? " ops-list-sheet-compact" : ""}`}><div className="ops-sheet-head"><div><span className="ops-kicker">Registros visibles</span><h3>{title}</h3></div><span className="ops-row-count">{visibleRows.length}{filtered ? ` / ${rows.length}` : ""}</span></div>
    {(showFilter || filtered) && <div className="ops-list-controls"><label className="ops-list-filter"><span>Buscar en columnas visibles</span><input type="search" value={activeSearch} onChange={event => setSearch(event.target.value)} placeholder="Nombre, estado, fecha…" /></label><p className="ops-list-filter-count" role="status">{filtered ? `${visibleRows.length} coincidencias` : `${rows.length} registros`}{hasMore ? " en los registros cargados; hay más páginas." : " disponibles."}</p></div>}
    {visibleRows.length ? <DataTable label={title}><thead><tr>{columns.map(([, label]) => <th key={label} scope="col">{label}</th>)}{renderActions && <th scope="col">Acciones</th>}</tr></thead><tbody>{visibleRows.map((row, index) => <tr key={idOf(row) || index}>{columns.map(([key, label]) => <td key={key}>{tableValue(row, key, label)}</td>)}{renderActions && <td className="ops-table-actions">{renderActions(row)}</td>}</tr>)}</tbody></DataTable> : <EmptyState title="No hay coincidencias" detail={hasMore ? "La búsqueda revisa las columnas visibles de los registros ya cargados. Podés cargar más registros o borrar el filtro." : "Probá con otro texto o borrá el filtro para volver a ver los registros."} action={<button type="button" className="ops-button ops-button-quiet" onClick={clearSearch}>Borrar búsqueda</button>} />}
  </section>;
}

export function OperationalWorkspace(props: Props) {
  const { pageId, context, refreshKey, runCommand, openAction, onNotice, onRefresh } = props;
  const [selectedCutoverProfile, setSelectedCutoverProfile] = useState<"legacy" | "appsheet-replacement">("appsheet-replacement");
  const [selectedCutoverCaptureId, setSelectedCutoverCaptureId] = useState("");
  const [returnOrderId, setReturnOrderId] = useState("");
  const [ledgerAccountId, setLedgerAccountId] = useState("");
  const [reconciliationAccountId, setReconciliationAccountId] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [invoiceEditor, setInvoiceEditor] = useState<InvoiceEditorState | null>(null);
  const [invoiceCatalogueChannel, setInvoiceCatalogueChannel] = useState<InvoiceCatalogueChannel>("local");
  const [invoiceTotalTrace, setInvoiceTotalTrace] = useState<InvoiceTotalTrace | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => { if (pageId !== "orders") { setInvoiceEditor(null); setInvoiceCatalogueChannel("local"); setInvoiceTotalTrace(null); } }, [pageId]);
  const openInvoiceEditor = (editor: InvoiceEditorState) => {
    setInvoiceCatalogueChannel(invoiceCatalogueChannelForOrder(editor.order));
    setInvoiceEditor(editor);
  };
  const closeInvoiceEditor = () => {
    setInvoiceEditor(null);
    setInvoiceCatalogueChannel("local");
  };
  const listSearchKey = `q-${pageId}`;
  const tableSearch = pageId === "members" ? "" : searchParams.get(listSearchKey) ?? "";
  const updateTableSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set(listSearchKey, value);
    else next.delete(listSearchKey);
    setSearchParams(next, { replace: true });
  };
  const spec = pageSpec(pageId, context);
  const basePath = pageId === "imports" || pageId === "reports" ? null : spec.path;
  const memberPath = pageId === "members" && basePath
    ? `${basePath}?limit=200${memberSearch.trim() ? `&q=${encodeURIComponent(memberSearch.trim())}` : ""}`
    : basePath;
  const usesPagedMainList = ["members", "routes", "orders", "purchases", "catalog"].includes(pageId);
  const cursorPath = usesPagedMainList ? memberPath : null;
  const cursorQuery = useCursorResource(
    cursorPath,
    refreshKey,
    pageId === "routes" ? "unassignedCursor" : cursorPath ? "cursor" : null,
    pageId === "routes" ? "unassignedNextCursor" : "nextCursor",
    pageId === "routes" ? "unassignedHasMore" : "hasMore",
    pageId === "routes" ? ["items", "deliveries", "unassignedDeliveries"] : pageId === "purchases" ? ["items", "receipts"] : ["items"],
  );
  const path = usesPagedMainList ? null : basePath;
  const regularQuery = useRemote<Record<string, unknown>>(path, refreshKey);
  const query = usesPagedMainList
    ? cursorQuery
    : { ...regularQuery, hasMore: false, loadMore: () => {} };
  const members = useRemote<Record<string, unknown>>(hasCapability(context, "members.read") && ["orders", "collections", "payables"].includes(pageId) ? "/api/operations/members?limit=200" : null, refreshKey);
  const needsCatalogChoices = (hasCapability(context, "stock.read") || hasCapability(context, "orders.write")) && ["orders", "purchases"].includes(pageId);
  const catalogChoices = useCursorResource(needsCatalogChoices ? "/api/operations/catalog" : null, refreshKey, "cursor", "nextCursor", "hasMore", ["items"]);
  const invoiceCataloguePath = invoiceEditor && pageId === "orders"
    ? `/api/operations/catalog?channel=${invoiceCatalogueChannel}`
    : null;
  const invoiceCatalogue = useCursorResource(invoiceCataloguePath, refreshKey, "cursor", "nextCursor", "hasMore", ["items"]);
  const catalogReference = useRemote<Record<string, unknown>>((hasCapability(context, "stock.read") || hasCapability(context, "orders.write")) && ["commercial", "routes", "members"].includes(pageId) ? "/api/operations/catalog" : null, refreshKey);
  const accounts = useRemote<Record<string, unknown>>(hasCapability(context, "finance.read") && ["orders", "collections", "routes", "settlements", "payables"].includes(pageId) ? "/api/operations/accounts" : null, refreshKey);
  const people = useRemote<Record<string, unknown>>(hasCapability(context, "operations.read") && ["routes", "accounts", "collections", "settlements", "payables"].includes(pageId) ? "/api/operations/people" : null, refreshKey);
  const orders = useRemote<Record<string, unknown>>(hasCapability(context, "operations.read") && ["collections", "routes"].includes(pageId) ? "/api/operations/orders" : null, refreshKey);
  const pricing = useRemote<Record<string, unknown>>((pageId === "orders" || pageId === "commercial") && (hasCapability(context, "orders.write") || hasCapability(context, "prices.propose")) ? "/api/operations/policies" : null, refreshKey);
  const access = useRemote<Record<string, unknown>>(hasCapability(context, "access.manage") && ["routes", "accounts", "gates"].includes(pageId) ? "/api/operations/access" : null, refreshKey);
  const gates = useRemote<Record<string, unknown>>(pageId === "gates" ? "/api/operations/authority" : null, refreshKey);
  useEffect(() => {
    const available = rowsOf(gates.data, "captures").map(capture => textValue(capture.captureId, "")).filter(Boolean);
    if (!available.includes(selectedCutoverCaptureId)) setSelectedCutoverCaptureId(available[0] ?? "");
  }, [gates.data, selectedCutoverCaptureId]);
  const audit = useRemote<Record<string, unknown>>(pageId === "gates" && hasCapability(context, "access.manage") ? "/api/operations/audit" : null, refreshKey);
  const documents = useRemote<Record<string, unknown>>(pageId === "members" && hasCapability(context, "documents.read") ? "/api/operations/documents" : null, refreshKey);
  const settlementRoutes = useRemote<Record<string, unknown>>(pageId === "settlements" && hasCapability(context, "logistics.write") ? "/api/operations/routes" : null, refreshKey);
  const settlementPayables = useRemote<Record<string, unknown>>(pageId === "settlements" && hasCapability(context, "payables.write") ? "/api/operations/payables" : null, refreshKey);
  const payablePurchases = useCursorResource(pageId === "payables" && hasCapability(context, "purchases.write") ? "/api/operations/purchases" : null, refreshKey, "cursor", "nextCursor", "hasMore", ["items"]);
  const stockReference = useRemote<Record<string, unknown>>(["purchases", "catalog", "payables"].includes(pageId) && hasCapability(context, "stock.read") ? "/api/operations/stock/reference-data" : null, refreshKey);
  const manualReferenceDataPath = ["purchases", "catalog"].includes(pageId) && (hasCapability(context, "purchases.write") || hasCapability(context, "stock.adjust")) ? "/api/operations/manual-reference-data" : null;
  const manualReferenceData = useRemote<Record<string, unknown>>(manualReferenceDataPath, refreshKey);
  const stockCounts = useRemote<Record<string, unknown>>(pageId === "catalog" && hasCapability(context, "stock.read") ? "/api/operations/stock/counts" : null, refreshKey);

  const peopleRows = rowsOf(people.data);
  const deliveryPeople = peopleRows.filter(person => person.canDeliver === true);
  const payablePurchaseRows = rowsOf(payablePurchases.data);
  const payableSuppliers = rowsOf(stockReference.data, "suppliers");
  const payablePurchaseLabel = (purchase: Row) => {
    const purchaseId = idOf(purchase);
    const supplierId = textValue(purchase.supplierId, "");
    const supplier = payableSuppliers.find(candidate => idOf(candidate) === supplierId);
    const reference = textValue(purchase.reference, `Compra #${shortReference(purchaseId)}`);
    return `${reference} · ${textValue(supplier?.name, supplierId ? `Proveedor #${shortReference(supplierId)}` : "Proveedor sin referencia")} · ${textValue(purchase.agreementDate, "fecha sin registrar")} · ${formatMinor(purchase.totalMinor, purchase.currency)}`;
  };
  const payablePurchaseOptions = payablePurchaseRows.flatMap(purchase => {
    const value = idOf(purchase);
    return value ? [{ value, label: payablePurchaseLabel(purchase) }] : [];
  });
  const mainRows = useMemo<Row[]>(() => {
    if (pageId === "commercial") {
      const data = query.data;
      return ["policies", "packs", "promotions"].flatMap(key => rowsOf(data, key).map(row => ({ ...row, _kind: key })));
    }
    if (pageId === "gates") return rowsOf(gates.data, "gates");
    if (pageId === "access") return rowsOf(query.data, "devices").map(row => ({ ...row, _kind: "device" }));
    if (pageId === "accounts") return rowsOf(query.data).map(row => {
      const reconciliation = recordValue(row, "reconciliation");
      return {
        ...row,
        lastReconciledDate: recordValue(reconciliation, "date") ?? null,
        lastCountedMinor: recordValue(reconciliation, "countedMinor") ?? null,
        lastDifferenceMinor: recordValue(reconciliation, "differenceMinor") ?? null,
      };
    });
    if (pageId === "payables") return rowsOf(query.data).map(row => {
      const evidence = recordValue(row, "evidence");
      const treatment = textValue(recordValue(evidence, "costTreatment"), "");
      const costTreatment = row.kind === "operating_expense"
        ? treatment === "variable" ? "Variable" : treatment === "fixed" ? "Fijo" : "Pendiente de clasificar"
        : row.kind === "courier_fee" ? "Variable · viáticos" : "No aplica";
      const purchaseId = textValue(row.purchaseId, "");
      const linkedPurchase = purchaseId ? payablePurchaseRows.find(purchase => idOf(purchase) === purchaseId) : undefined;
      const purchaseReference = row.kind !== "purchase"
        ? "—"
        : purchaseId
          ? `Vinculada · ${linkedPurchase ? payablePurchaseLabel(linkedPurchase) : `Ref. #${shortReference(purchaseId)}`}`
          : "Sin vínculo registrado";
      return { ...row, costTreatment, purchaseReference };
    });
    return rowsOf(query.data);
  }, [pageId, query.data, gates.data, payablePurchases.data, stockReference.data]);

  if (pageId === "home") return <HomeWorkspace context={context} refreshKey={refreshKey} runCommand={runCommand} openAction={openAction} onNotice={onNotice} onRefresh={onRefresh} />;
  if (pageId === "sources") return <SourcesWorkspace context={context} refreshKey={refreshKey} runCommand={runCommand} openAction={openAction} onNotice={onNotice} onRefresh={onRefresh} />;
  if (pageId === "finance") return <FinanceWorkspace context={context} refreshKey={refreshKey} runCommand={runCommand} openAction={openAction} onNotice={onNotice} onRefresh={onRefresh} />;
  if (pageId === "imports" || pageId === "permissions") return <DocImportPanels pageId={pageId} context={context} refreshKey={refreshKey} runCommand={runCommand} onRefresh={onRefresh} onNotice={onNotice} />;
  if (pageId === "reports") return <ReportsPanel context={context} refreshKey={refreshKey} />;

  const memberRows = pageId === "members" ? rowsOf(query.data) : rowsOf(members.data);
  const accountRows = rowsOf(pageId === "accounts" ? query.data : accounts.data);
  const catalogRows = rowsOf(pageId === "catalog" ? query.data : needsCatalogChoices ? catalogChoices.data : catalogReference.data);
  const invoiceCatalogueRows = rowsOf(invoiceCatalogue.data, "items");
  const purchaseCatalogReady = needsCatalogChoices && Boolean(catalogChoices.data) && !catalogChoices.loading && !catalogChoices.error;
  const stockReferencesUsable = hasCapability(context, "stock.read") && Boolean(stockReference.data) && !stockReference.error;
  const manualReferencesUsable = Boolean(manualReferenceDataPath) && Boolean(manualReferenceData.data) && !manualReferenceData.error;
  const supplierRows = mergePageRows(manualReferencesUsable ? rowsOf(manualReferenceData.data, "suppliers") : [], stockReferencesUsable ? rowsOf(stockReference.data, "suppliers") : []);
  const locationRows = mergePageRows(manualReferencesUsable ? rowsOf(manualReferenceData.data, "locations") : [], stockReferencesUsable ? rowsOf(stockReference.data, "locations").map(row => ({ ...row, active: row.active !== false })) : []).filter(row => row.active === true);
  const custodianRows = stockReferencesUsable ? rowsOf(stockReference.data, "custodians") : [];
  const namedLocationRows = locationRows.filter(row => typeof row.name === "string" && row.name.trim());
  const namedCustodianRows = custodianRows.filter(row => typeof row.name === "string" && row.name.trim());
  const locationReferencesLoading = (hasCapability(context, "stock.read") && stockReference.loading)
    || (Boolean(manualReferenceDataPath) && manualReferenceData.loading);
  const locationReferencesAvailable = stockReferencesUsable || manualReferencesUsable;
  const locationReferencesReady = !locationReferencesLoading && locationReferencesAvailable && namedLocationRows.length > 0;
  const movementReferencesReady = hasCapability(context, "stock.read") && !stockReference.loading && !stockReference.error
    && Boolean(stockReference.data) && namedLocationRows.length > 0 && namedCustodianRows.length > 0;
  const stockBalanceRows: Row[] = catalogRows.flatMap(sku => {
    const lots = Array.isArray(sku.lots) ? sku.lots.filter((lot): lot is Row => Boolean(lot) && typeof lot === "object") : [];
    return lots.flatMap(lot => {
      const balances = Array.isArray(lot.balances) ? lot.balances.filter((balance): balance is Row => Boolean(balance) && typeof balance === "object") : [];
      return balances.map(balance => ({
        ...balance,
        skuId: idOf(sku),
        skuName: textValue(sku.name, "Producto sin nombre disponible"),
        category: textValue(sku.category),
        unit: textValue(balance.unit, textValue(sku.unit)),
        lotId: idOf(lot),
        lotLabel: textValue(lot.label, textValue(lot.name, idOf(lot))),
        availableQuantity: balance.availableQuantity,
        availabilityState: balance.availabilityState,
        availabilityReason: balance.availabilityReason,
      }));
    });
  });
  const stockCountRows = rowsOf(stockCounts.data).map(count => {
    const balance = stockBalanceRows.find(item => idOf(item) === count.balanceId);
    const custodian = custodianRows.find(item => idOf(item) === count.countedBy);
    return {
      ...count,
      balanceLabel: balance ? `${textValue(balance.skuName)} · ${textValue(balance.lotLabel)} · ${textValue(balance.locationId)}` : textValue(count.balanceId),
      countedByLabel: textValue(custodian?.name, textValue(count.countedBy)),
    };
  });
  const pendingManagementPayables = mainRows.filter(row => {
    if (row.kind !== "operating_expense" && row.kind !== "courier_fee") return false;
    const hasAccrualPeriod = typeof row.accrualPeriod === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.accrualPeriod);
    return row.verified !== true || !hasAccrualPeriod || (row.kind === "operating_expense" && row.costTreatment === "Pendiente de clasificar");
  });
  const orderRows = rowsOf(pageId === "orders" ? query.data : orders.data);
  const beneficiaryOptions = [...new Map([
    ...memberRows.map(item => ({ value: idOf(item), label: `Socio · ${labelOf(item, ["name"])}` })),
    ...peopleRows.map(item => ({ value: idOf(item), label: `Persona · ${labelOf(item, ["name"])}` })),
    ...supplierRows.map(item => ({ value: idOf(item), label: `Proveedor · ${labelOf(item, ["name"])}` })),
  ].filter(option => option.value).map(option => [option.value, option])).values()];
  const displayRows: Row[] = mainRows.map((row): Row => {
    const driver = peopleRows.find(item => idOf(item) === String(row.driverId ?? ""));
    const reporter = peopleRows.find(item => idOf(item) === String(row.reporterId ?? ""));
    const beneficiaryMember = memberRows.find(item => idOf(item) === String(row.beneficiaryId ?? ""));
    const beneficiaryPerson = peopleRows.find(item => idOf(item) === String(row.beneficiaryId ?? ""));
    const beneficiarySupplier = supplierRows.find(item => idOf(item) === String(row.beneficiaryId ?? ""));
    const order = orderRows.find(item => idOf(item) === String(row.orderId ?? ""));
    const orderMember = order ? memberRows.find(item => idOf(item) === String(order.memberId ?? "")) : undefined;
    const date = typeof row.shiftDate === "string" ? row.shiftDate : typeof order?.createdAt === "string" ? order.createdAt.slice(0, 10) : "";
    const entityName: Record<string, string> = { orders: "Pedido", collections: "Cobro", purchases: "Compra", accounts: "Cuenta", members: "Socio", catalog: "Producto", routes: "Turno", settlements: "Rendición", payables: "Obligación", tasks: "Tarea", gates: "Habilitación" };
    const rawId = idOf(row);
    const reference = shortReference(rawId);
    const labelledLines = (key: "lines" | "items") => Array.isArray(row[key]) ? (row[key] as Row[]).map(line => {
      const sku = catalogRows.find(candidate => idOf(candidate) === String(line.skuId ?? ""));
      const skuName = key === "lines" ? visibleInvoiceLineName(line, catalogRows) : sku ? textValue(sku.name) : "";
      return { ...line, ...(skuName ? { skuLabel: skuName } : {}) };
    }) : row[key];
    const orderQuote = recordValue(row, "quote");
    const appSheetInvoice = pageId === "orders" && recordValue(orderQuote, "source") === "appsheet-invoice";
    const invoiceTotalState = recordValue(orderQuote, "totalCalculationState");
    const invoiceTotalKnown = appSheetInvoice && (invoiceTotalState === "defined" || invoiceTotalState === "staff_confirmed");
    const invoiceCurrency = textValue(recordValue(orderQuote, "currency"), textValue(row.currency, "ARS"));
    const invoiceResolution = objectValue(recordValue(orderQuote, "financialResolution") ?? row.financialResolution);
    const productsTotalMinor = invoiceResolution.productsTotalMinor;
    const motoClientTotalMinor = invoiceResolution.motoClientTotalMinor;
    const hasInvoiceResolution = typeof productsTotalMinor === "string" && /^\d+$/.test(productsTotalMinor)
      && typeof motoClientTotalMinor === "string" && /^\d+$/.test(motoClientTotalMinor);
    const invoiceTotalMinor = recordValue(orderQuote, "totalMinor") ?? row.totalMinor;
    const hasInvoiceTotal = typeof invoiceTotalMinor === "bigint" || (typeof invoiceTotalMinor === "string" && /^\d+$/.test(invoiceTotalMinor));
    const memberLabel = textValue(memberRows.find(item => idOf(item) === String(row.memberId ?? ""))?.name, row.memberId ? `Socio #${shortReference(String(row.memberId))}` : "—");
    return {
      ...row,
      ...(rawId ? { idLabel: `${entityName[pageId] ?? "Registro"} #${reference}`, referenceKey: `${pageId}-${reference.toLowerCase()}` } : {}),
      ...(row.lines ? { lines: labelledLines("lines") } : {}),
      ...(row.items ? { items: labelledLines("items") } : {}),
      ...(pageId === "orders" && row.memberId ? { memberIdLabel: textValue(memberRows.find(item => idOf(item) === String(row.memberId))?.name, `Socio #${shortReference(String(row.memberId))}`) } : {}),
      ...(pageId === "orders" ? {
        invoiceOrOrderLabel: appSheetInvoice ? textValue(recordValue(orderQuote, "invoiceNumber"), rawId ? `Factura #${reference}` : "Factura sin número") : textValue(row.idLabel, rawId ? `Pedido #${reference}` : "Pedido"),
        invoiceMemberLabel: memberLabel,
        invoiceTotalLabel: appSheetInvoice
          ? invoiceTotalKnown ? hasInvoiceTotal ? formatMinor(invoiceTotalMinor, invoiceCurrency) : "Importe conocido no disponible" : "Pendiente de definición"
          : formatMinor(row.totalMinor, textValue(row.currency, "ARS")),
        invoiceTotalBreakdownLabel: invoiceTotalKnown && hasInvoiceResolution
          ? `Productos ${formatMinor(productsTotalMinor, invoiceCurrency)} · Moto ${formatMinor(motoClientTotalMinor, invoiceCurrency)}`
          : "—",
        invoiceTotalSourceLabel: appSheetInvoice
          ? invoiceTotalState === "defined" ? "Definido por regla" : invoiceTotalState === "staff_confirmed" ? "Confirmado por el personal" : "Pendiente de definición"
          : "—",
        capturedBaseLabel: appSheetInvoice ? formatMinor(recordValue(orderQuote, "capturedBaseMinor"), invoiceCurrency) : "—",
        legacyFinancialLabel: legacyFinancialProjectionLabel(row, invoiceCurrency),
      } : {}),
      ...(row.driverId ? { driverIdLabel: textValue(driver?.name, "Persona asignada") } : {}),
      ...(row.reporterId ? { reporterIdLabel: textValue(reporter?.name, "Persona reportante") } : {}),
      ...(row.beneficiaryId ? { beneficiaryIdLabel: textValue(beneficiaryMember?.name, textValue(beneficiaryPerson?.name, textValue(beneficiarySupplier?.name, "Beneficiario registrado"))) } : {}),
      ...(row.orderId ? { orderIdLabel: order ? `Pedido #${shortReference(idOf(order))} · ${textValue(orderMember?.name, "Socio")} · ${order.channel === "local" ? "Retiro" : "Reparto"}${date ? ` · ${date}` : ""}` : `Pedido #${shortReference(String(row.orderId))}` } : {}),
    };
  });
  const approvedPolicies = rowsOf(pricing.data, "policies").filter(row => row.status === "approved");
  const approvedPacks = rowsOf(pricing.data, "packs").filter(row => row.status === "approved");
  const approvedPromotions = rowsOf(pricing.data, "promotions").filter(row => row.status === "approved" && (hasCapability(context, "prices.approve") || Object.keys(recordValue(row.definition, "eligibility") as object ?? {}).length === 0));
  const accessData = pageId === "access" ? query.data : access.data;
  const userRows = rowsOf(accessData, "users").filter(user => user.active !== false);
  const gateRowsById = new Map<string, Row | null>();
  for (const gate of rowsOf(gates.data, "gates")) {
    const gateId = idOf(gate);
    if (!gateId || !(cutoverGateIds as readonly string[]).includes(gateId)) continue;
    gateRowsById.set(gateId, gateRowsById.has(gateId) ? null : gate);
  }
  const captureRows = rowsOf(gates.data, "captures");
  const selectedCapture = captureRows.find(capture => textValue(capture.captureId, "") === selectedCutoverCaptureId) ?? null;
  const replacementGateIds = selectedCutoverProfile === "appsheet-replacement"
    ? cutoverGateIds.filter(gateId => gateId !== "legacy-writes-disabled")
    : cutoverGateIds;
  const gateMatchesSelectedCapture = (gate: Row | null | undefined) => {
    if (selectedCutoverProfile !== "appsheet-replacement") return true;
    const replacementEvidence = objectValue(objectValue(gate?.evidence).appSheetReplacement);
    const captureId = textValue(selectedCapture?.captureId, "");
    return Boolean(selectedCutoverCaptureId && gate?.captureManifestId === selectedCutoverCaptureId
      && replacementEvidence.captureId === selectedCutoverCaptureId
      && replacementEvidence.manifestHash === selectedCapture?.manifestHash
      && replacementEvidence.dataHash === selectedCapture?.dataHash
      && replacementEvidence.captureDefinitionHash === selectedCapture?.definitionHash
      && captureId === selectedCutoverCaptureId);
  };
  const activeGateUserIds = new Set(rowsOf(access.data, "users")
    .filter(user => user.active === true)
    .map(idOf)
    .filter(Boolean));
  const approvedGateCount = replacementGateIds.filter(gateId => {
    const gate = gateRowsById.get(gateId);
    return gate?.status === "approved" && gateMatchesSelectedCapture(gate);
  }).length;
  const gatesHaveIndependentActiveReview = replacementGateIds.every(gateId => {
    const gate = gateRowsById.get(gateId);
    const authorId = typeof gate?.approvedBy === "string" ? gate.approvedBy : "";
    const reviewerId = typeof gate?.reviewedBy === "string" ? gate.reviewedBy : "";
    return gate?.status === "approved" && gateMatchesSelectedCapture(gate) && authorId.length > 0 && reviewerId.length > 0
      && authorId !== reviewerId && activeGateUserIds.has(authorId) && activeGateUserIds.has(reviewerId);
  });
  const selectedCaptureStability = objectValue(selectedCapture?.stability);
  const selectedCaptureStable = selectedCapture !== null && selectedCaptureStability.stable === true
    && selectedCaptureStability.metadataStable === true && selectedCaptureStability.headersStable === true
    && selectedCaptureStability.pageHashesStable === true && selectedCaptureStability.scanComplete === true
    && selectedCaptureStability.cutoverEligible === true && selectedCaptureStability.changedPages === 0
    && selectedCaptureStability.failedPages === 0 && selectedCaptureStability.unresolvedFormulaCount === 0
    && selectedCapture.dataUnresolvedFormulaCount === 0 && typeof selectedCapture.cutoffAt === "string";
  const authorityRow = recordValue(gates.data, "authority");
  const serverAuthorityMode = authorityRow === null ? "shadow"
    : typeof recordValue(authorityRow, "mode") === "string" ? String(recordValue(authorityRow, "mode")) : "unknown";
  const operationalApprovalConfigured = context.operationalApprovalConfigured === true;
  const authorityActivationBlocker = !hasCapability(context, "cutover.approve") ? "Tu perfil no tiene permiso para activar la autoridad."
    : !hasCommand(context, "AuthorityActivated") ? "El servidor no ofrece la acción de activación para esta sesión."
    : context.rehearsal ? "La sesión está marcada como ensayo; no se puede activar autoridad real desde aquí."
    : !operationalApprovalConfigured ? "El servidor aún no está habilitado para activar autoridad y aceptar escrituras reales."
    : context.authority.mode !== "shadow" ? "El contexto no informa autoridad en sombra; actualizá la vista para confirmar el estado vigente."
    : !hasCapability(context, "access.manage") ? "Tu perfil no permite comprobar si las personas autoras y revisoras siguen activas; se necesita acceso a la gestión de usuarios."
    : gates.loading || query.loading || access.loading ? "Esperá a que terminen de cargar las habilitaciones y las personas activas."
    : gates.error || query.error ? "No se pudo consultar el estado actual de las habilitaciones; reintentá la consulta."
    : access.error ? "No se pudo comprobar el estado activo de las personas; reintentá la consulta de accesos."
    : !gates.data || !query.data ? "No hay una respuesta actual del servidor para validar la autoridad."
    : !access.data ? "No hay una lista actual de personas para validar autores y revisores."
    : serverAuthorityMode === "active" ? "La autoridad ya figura activa en el servidor."
    : serverAuthorityMode !== "shadow" ? "El estado de autoridad no se pudo confirmar como sombra."
    : selectedCutoverProfile === "appsheet-replacement" && !selectedCutoverCaptureId ? "Elegí una captura identificada para revisar el reemplazo de AppSheet."
    : selectedCutoverProfile === "appsheet-replacement" && !selectedCapture ? "La captura seleccionada no aparece en el inventario vigente; actualizá la vista."
    : selectedCutoverProfile === "appsheet-replacement" && !selectedCaptureStable ? "La captura seleccionada no demuestra estabilidad completa; el servidor mantendrá bloqueada la activación."
    : approvedGateCount !== replacementGateIds.length ? `Hay ${approvedGateCount} de ${replacementGateIds.length} controles aprobados para el perfil seleccionado; el servidor exige que estén aprobados todos.`
    : !gatesHaveIndependentActiveReview ? "Cada control debe conservar una persona autora y otra revisora, distintas y activas."
    : null;
  const canActivateAuthority = pageId === "gates"
    && authorityActivationBlocker === null;
  const profileValues = recordValue(query.data, "profiles");
  const profileOptions = Array.isArray(profileValues) ? profileValues.filter((profile): profile is string => typeof profile === "string").map(profile => ({ value: profile, label: profile.replaceAll("_", " ") })) : [];
  const documentRows = rowsOf(documents.data).filter(document => document.sensitivity !== "clinical");
  const accessGrants = rowsOf(accessData, "grants");
  const driverRows = deliveryPeople;
  const settlementRouteRows = rowsOf(settlementRoutes.data);
  const settlementPayableRows = rowsOf(settlementPayables.data).filter(payable => payable.kind === "courier_fee" && payable.verified === true);
  const settlementSourceAccounts = accountRows.filter(account => account.kind === "custody"
    && idOf(account) && typeof account.custodianId === "string" && account.custodianId.trim()
    && typeof account.openingApprovedBy === "string" && account.openingApprovedBy.trim()
    && typeof account.currency === "string" && account.currency.trim());
  const settlementDestinationAccounts = accountRows.filter(account => account.kind !== "custody"
    && idOf(account) && typeof account.openingApprovedBy === "string" && account.openingApprovedBy.trim()
    && typeof account.currency === "string" && account.currency.trim());
  const settlementSourceOptions = settlementSourceAccounts.map(account => ({ value: idOf(account), label: `${labelOf(account)} · ${textValue(account.currency)} · saldo ${formatMinor(account.balanceMinor, account.currency)}` }));
  const settlementDestinationOptions = settlementDestinationAccounts.map(account => ({ value: idOf(account), label: `${labelOf(account)} · ${textValue(account.currency)}` }));
  const settlementRouteOptions = settlementRouteRows.flatMap(route => {
    const id = idOf(route), driverId = textValue(route.driverId, ""), shiftDate = textValue(route.shiftDate, "");
    return id && driverId && shiftDate ? [{ value: id, label: `${shiftDate} · ${driverId}` }] : [];
  });
  const settlementPayableOptions = settlementPayableRows.flatMap(payable => {
    const id = idOf(payable), beneficiaryId = textValue(payable.beneficiaryId, "");
    return id && beneficiaryId && typeof payable.currency === "string" && typeof payable.dueDate === "string"
      ? [{ value: id, label: `${beneficiaryId} · ${formatMinor(payable.amountMinor, payable.currency)} · ${payable.dueDate}` }]
      : [];
  });
  const canReadSettlementAccounts = hasCapability(context, "finance.read");
  const needsSettlementRoutes = hasCapability(context, "logistics.write");
  const needsSettlementPayables = hasCapability(context, "payables.write");
  const settlementReferenceQueriesReady = canReadSettlementAccounts
    && Boolean(accounts.data) && !accounts.loading && !accounts.error
    && (!needsSettlementRoutes || Boolean(settlementRoutes.data) && !settlementRoutes.loading && !settlementRoutes.error)
    && (!needsSettlementPayables || Boolean(settlementPayables.data) && !settlementPayables.loading && !settlementPayables.error);
  const settlementHasCompatibleAccountPair = settlementSourceAccounts.some(source => settlementDestinationAccounts.some(destination => source.currency === destination.currency));
  const renditionReferenceErrors = [
    accounts.error ? `cuentas: ${accounts.error}` : "",
    needsSettlementRoutes && settlementRoutes.error ? `turnos: ${settlementRoutes.error}` : "",
    needsSettlementPayables && settlementPayables.error ? `obligaciones: ${settlementPayables.error}` : "",
  ].filter(Boolean);
  const renditionReferencesLoading = canReadSettlementAccounts && (accounts.loading || !accounts.data)
    || needsSettlementRoutes && (settlementRoutes.loading || !settlementRoutes.data)
    || needsSettlementPayables && (settlementPayables.loading || !settlementPayables.data);
  const renditionReferenceError = !canReadSettlementAccounts
    ? "Tu perfil no puede consultar las cuentas necesarias para aceptar una rendición."
    : renditionReferenceErrors.length
      ? `No se pudieron cargar referencias actuales para aceptar la rendición. ${renditionReferenceErrors.join(" · ")}`
      : !settlementReferenceQueriesReady && !renditionReferencesLoading
        ? "No hay respuestas actuales de todas las referencias necesarias para aceptar la rendición."
        : null;
  const needsRenditionReferences = pageId === "settlements" && hasCommand(context, "RenditionAccepted");
  const canAcceptRendition = settlementReferenceQueriesReady && settlementHasCompatibleAccountPair;
  const renditionReferenceBlocker = renditionReferenceError
    ?? (renditionReferencesLoading ? "Cargando cuentas y referencias para aceptar una rendición…"
      : !settlementHasCompatibleAccountPair ? "No hay una custodia y una cuenta del club con apertura aprobada en una misma moneda. Actualizá las referencias antes de aceptar una rendición."
        : null);
  const tariffChoices = approvedPolicies.flatMap(policy => {
    const tiers = recordValue(policy.definition, "tiers");
    return Array.isArray(tiers) ? tiers.filter((tier): tier is Row => Boolean(tier) && typeof tier === "object").map((tier, index) => ({ id: `${idOf(policy)}:${index}`, policy, tier })) : [];
  });
  const quoteItemFields = (values: Record<string, string | boolean>): ActionField[] => [
    select("skuId", "Producto", optionsOf(catalogRows, ["name"]), false),
    field("quantity", "Cantidad solicitada", "decimal", { help: "Gramos: hasta tres decimales. Artículos: unidades enteras." }),
    select("tariff", "Tarifa y escala aprobadas", tariffChoices.filter(choice => choice.tier.skuId === str(values, "skuId")).map(choice => ({ value: choice.id, label: `${labelOf(choice.policy)} · ${textValue(choice.tier.scale)} · desde ${textValue(choice.tier.minQuantity)} · ${textValue(choice.tier.unitPrice)} ${textValue(choice.policy.currency)}` })), false, "Sin tarifa, completá el precio y el motivo de la cotización manual."),
    field("manualUnitPrice", "Precio unitario manual (opcional)", "decimal", { help: "Debe ser positivo. Una bonificación requiere aprobación del propietario." }),
    field("manualReason", "Motivo del precio manual (si corresponde)", "textarea"),
  ];
  const quotePackFields = (values: Record<string, string | boolean>): ActionField[] => {
    const pack = approvedPacks.find(item => item.id === str(values, "packId"));
    const components = Array.isArray(pack?.components) ? pack.components.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
    return [select("packId", "Pack aprobado", optionsOf(approvedPacks, ["name"]), false), field("count", "Cantidad de packs", "integer", { defaultValue: "1" }), ...components.filter(component => component.category).map(component => select(`component-${idOf(component)}`, `Variedad · ${textValue(component.category)} · ${textValue(component.quantity)} ${textValue(component.unit)}`, optionsOf(catalogRows.filter(sku => sku.category === component.category && sku.unit === component.unit), ["name"]), true))];
  };

  const version = (row: Row, fallback = Number.NaN) => versionFor(query.data, row, fallback);
  const runAction = (command: string, title: string, fieldsIn: ActionField[], build: (values: Record<string, string | boolean>) => JsonRecord, row?: Row, description?: string, create = false, actionHint?: string, options: { targetId?: string; requestIdIsTarget?: boolean } = {}) => {
    if (!hasCommand(context, command)) return;
    if (query.loading || query.error) { onNotice("Esperá a que termine la actualización antes de registrar otro cambio."); return; }
    const expectedVersion = row ? version(row) : create ? 0 : undefined;
    if (row && !Number.isSafeInteger(expectedVersion)) {
      onNotice(`Acción bloqueada: GET ${spec.path ?? "de esta sección"} no devuelve una versión para ${idOf(row)}. El API debe exponer versions[${idOf(row)}].`);
      return;
    }
    openAction(action(command, title, fieldsIn, build, row ? idOf(row) : options.targetId, expectedVersion, options.requestIdIsTarget ?? create, actionHint ?? description));
  };
  const reportCollection = (order?: Row) => {
    if (order && (order.commercialState !== "confirmed" || !idOf(order))) return;
    const orderId = order ? idOf(order) : "";
    const orderLabel = order
      ? textValue(order.invoiceOrOrderLabel, `Pedido #${shortReference(orderId)}`)
      : "";
    const memberLabel = order
      ? textValue(order.invoiceMemberLabel, textValue(memberRows.find(member => idOf(member) === String(order.memberId ?? ""))?.name, "Socio sin nombre disponible"))
      : "";
    const orderContext = order
      ? `Pedido fijado: ${orderLabel} · ${memberLabel} · ${order.channel === "local" ? "Retiro" : "Reparto"}. `
      : "";
    const reportOnlyGuidance = "El aviso conserva quién informó el cobro. No confirma el pago ni modifica el pedido o la caja; la recepción se verifica desde Cobros.";

    runAction("CollectionReported", "Reportar un cobro", fields(
      ...(order ? [] : [select("orderId", "Pedido confirmado", orderRows.filter(candidate => candidate.commercialState === "confirmed").map(candidate => ({
        value: idOf(candidate),
        label: `${labelOf(memberRows.find(member => idOf(member) === String(candidate.memberId ?? "")) ?? candidate, ["name", "id"])} · ${candidate.channel === "local" ? "Retiro" : "Reparto"} · ${formatMinor(candidate.totalMinor, candidate.currency)} · ${idOf(candidate)}`,
      })))]),
      select("method", "Medio recibido", [{ value: "cash", label: "Efectivo" }, { value: "transfer", label: "Transferencia" }, { value: "mercado_pago", label: "Mercado Pago" }, { value: "card", label: "Tarjeta" }]),
      select("currency", "Moneda", ["ARS", "USD"].map(value => ({ value, label: value })), true, "Indicá la moneda realmente recibida; no se toma del pedido."),
      field("amount", "Importe recibido", "amount", { required: true }),
      select("custodianId", "Custodia del efectivo (opcional)", accountRows.filter(account => account.kind === "custody" && account.custodianId).map(account => ({ value: String(account.custodianId), label: `${labelOf(account)} · ${textValue(account.currency)}` })), false, "Vacío significa recepción directa por el club. Indicá custodia sólo para efectivo; la verificación determina la cuenta real."),
      evidenceField("Nota del reporte"),
    ), values => ({
      orderId: orderId || str(values, "orderId"),
      method: str(values, "method"),
      currency: str(values, "currency"),
      amountMinor: amountFormToMinor(str(values, "amount")),
      ...(str(values, "custodianId") ? { custodianId: str(values, "custodianId") } : {}),
      evidence: note(values),
    }), undefined, "", true, `${orderContext}${reportOnlyGuidance}`, { targetId: uuid(), requestIdIsTarget: true });
  };
  const acceptRendition = () => {
    if (!canAcceptRendition) {
      onNotice(renditionReferenceBlocker ?? "Las cuentas y referencias de la rendición todavía no están listas.");
      return;
    }
    runAction("RenditionAccepted", "Aceptar rendición del repartidor", fields(
      select("fromAccountId", "Custodia de origen · moneda", settlementSourceOptions),
      select("toAccountId", "Cuenta del club de destino", settlementDestinationOptions),
      field("gross", "Dinero bruto por rendir", "amount", { required: true }),
      { ...select("mode", "Modalidad de rendición", [{ value: "gross", label: "Bruta · entrega todo al club" }, { value: "net", label: "Neta · descuenta remuneración aprobada" }]), defaultValue: "gross" },
      field("delivered", "Dinero entregado al club (si es neta)", "amount"), field("fee", "Remuneración descontada (si es neta)", "amount"),
      select("feePayableId", "Obligación de remuneración aprobada (si es neta)", settlementPayableOptions, false),
      select("routeId", "Turno asociado (opcional)", settlementRouteOptions, false), evidenceField("Evidencia de la rendición"),
    ), v => {
      const from = accountRows.find(account => account.id === str(v, "fromAccountId")), to = accountRows.find(account => account.id === str(v, "toAccountId"));
      if (!from || !to || from.currency !== to.currency || !from.custodianId) throw new Error("Elegí custodia y destino en la misma moneda.");
      const grossMinor = amountFormToMinor(str(v, "gross")), net = str(v, "mode") === "net";
      const route = settlementRouteRows.find(route => route.id === str(v, "routeId"));
      if (route && route.driverId !== from.custodianId) throw new Error("El turno corresponde a otro repartidor.");
      return { driverId: from.custodianId, fromAccountId: idOf(from), toAccountId: idOf(to), grossMinor, deliveredMinor: net ? amountFormToMinor(str(v, "delivered")) : grossMinor, feeMinor: net ? amountFormToMinor(str(v, "fee") || "0") : "0", mode: str(v, "mode"), ...(net && str(v, "feePayableId") ? { feePayableId: str(v, "feePayableId") } : {}), ...(route ? { routeId: idOf(route) } : {}), evidence: note(v) };
    }, undefined, "La rendición mueve dinero verificado desde custodia al club. Conserva por separado la remuneración; no vuelve a reconocer la venta ni el cobro.", true);
  };
  const activateAuthority = () => runAction(
    "AuthorityActivated",
    "Activar autoridad del circuito",
    fields(evidenceField("Evidencia humana explícita de la decisión de activar autoridad")),
    values => ({
      cutoverProfile: selectedCutoverProfile,
      ...(selectedCutoverProfile === "appsheet-replacement" ? { captureId: selectedCutoverCaptureId } : {}),
      evidence: note(values),
    }),
    authorityRow && typeof authorityRow === "object" ? authorityRow as Row : undefined,
    `El servidor volverá a validar el perfil ${selectedCutoverProfile}, su captura y controles aprobados, además de las personas autoras y revisoras activas. La autoridad sólo cambia después de guardar el comando y su comprobante.`,
    true,
    undefined,
    { targetId: "operations", requestIdIsTarget: false },
  );
  const suspendAuthority = () => runAction(
    "AuthoritySuspended",
    "Suspender autoridad del circuito",
    fields(field("reason", "Motivo humano de la suspensión", "textarea", { required: true, help: "El motivo queda en auditoría. La suspensión conserva operaciones y evidencias; no restaura ni borra datos." })),
    values => ({ reason: str(values, "reason").trim() }),
    authorityRow && typeof authorityRow === "object" ? authorityRow as Row : { id: "operations" },
    "El servidor verificará propietario, autoridad activa y versión vigente. El circuito pasa a sombra y conserva su historial.",
    false,
  );
  const reconcileAccount = (account: Row) => runAction("AccountReconciled", "Registrar arqueo de cuenta", fields(
    field("date", "Fecha del arqueo", "date", { required: true, defaultValue: localDate() }),
    field("counted", "Saldo contado", "amount", { required: true, help: `Importe expresado en ${textValue(account.currency)}.` }),
    evidenceField("Evidencia del arqueo"),
  ), values => ({ date: str(values, "date"), countedMinor: amountFormToMinor(str(values, "counted")), evidence: note(values) }), account,
  "Se compara el saldo calculado para la fecha con el saldo contado y se conserva la evidencia.");

  const stockActionsForBalance = (row: Row) => {
    const buttons: Array<{ label: string; onClick: () => void }> = [];
    const balanceId = idOf(row);
    const unit = row.unit;
    const onHand = scaledQuantity(row.quantity);
    const reserved = scaledQuantity(row.reserved);
    const available = onHand !== null && reserved !== null ? onHand - reserved : null;
    const quantityHelp = `Saldo físico ${textValue(row.quantity)} ${textValue(unit)} · reservado ${textValue(row.reserved)} · disponible ${available === null ? "sin detalle" : formatScaled(available)} ${textValue(unit)}.`;

    if (balanceId && hasCommand(context, "StockWasteRecorded") && (available === null || available > 0n)) buttons.push({
      label: "Registrar merma",
      onClick: () => runAction("StockWasteRecorded", "Registrar merma", fields(
        field("quantity", "Cantidad descartada", "decimal", { required: true, help: quantityHelp }),
        field("reason", "Motivo", "textarea", { required: true }),
        evidenceField(),
      ), values => ({ balanceId, quantity: quantityForUnit(str(values, "quantity"), unit, "Cantidad descartada"), reason: str(values, "reason"), evidence: note(values) }), undefined, "La merma queda asociada al lote y se descuenta del saldo disponible.", true),
    });

    if (balanceId && hasCommand(context, "StockMoved") && movementReferencesReady && (available === null || available > 0n)) buttons.push({
      label: "Trasladar saldo",
      onClick: () => runAction("StockMoved", "Trasladar stock entre custodias", fields(
        field("quantity", "Cantidad a trasladar", "decimal", { required: true, help: quantityHelp }),
        select("toLocationId", "Ubicación de destino", optionsOf(namedLocationRows)),
        select("toCustodianId", "Persona custodio de destino", optionsOf(namedCustodianRows, ["name"])),
        field("reason", "Motivo del traslado", "textarea", { required: true }),
        evidenceField(),
      ), values => ({ balanceId, quantity: quantityForUnit(str(values, "quantity"), unit, "Cantidad a trasladar"), toLocationId: str(values, "toLocationId"), toCustodianId: str(values, "toCustodianId"), reason: str(values, "reason"), evidence: note(values) }), undefined, "El sistema descuenta el saldo de origen y lo incorpora a la ubicación y custodia elegidas.", true),
    });

    if (balanceId && hasCommand(context, "StockCountRecorded")) buttons.push({
      label: "Registrar conteo",
      onClick: () => openAction(action("StockCountRecorded", "Registrar conteo físico", fields(
          field("countedQuantity", "Cantidad contada", "decimal", { required: true, help: `Unidades físicas encontradas en el saldo · ${textValue(unit)}. Se admite cero.` }),
          evidenceField("Evidencia del conteo"),
        ), values => ({ balanceId, countedQuantity: quantityForUnit(str(values, "countedQuantity"), unit, "Cantidad contada", true), evidence: note(values) }), undefined, 0, true, "El conteo conserva el saldo y las reservas observadas; una diferencia requiere aprobación independiente.")),
    });

    return buttons;
  };

  const stockCountActionsFor = (row: Row) => {
    if (row.status !== "pending" || !hasCommand(context, "StockCountAdjustmentApproved")) return [];
    if (row.countedBy === context.userId) return [];
    const id = idOf(row);
    const expectedVersion = responseVersion(stockCounts.data, id, Number.NaN);
    return [{ label: "Aprobar ajuste", onClick: () => {
      if (!Number.isSafeInteger(expectedVersion)) {
        onNotice(`GET /api/operations/stock/counts no devolvió una versión vigente para el conteo ${id}.`);
        return;
      }
      openAction(action("StockCountAdjustmentApproved", "Revisar diferencia del conteo", fields(
        field("reason", "Motivo de aprobación", "textarea", { required: true }),
        evidenceField("Evidencia de revisión independiente"),
      ), values => ({ reason: str(values, "reason"), evidence: note(values) }), id, expectedVersion, false, "Sólo otra persona puede aprobar el ajuste. Si el saldo cambió desde el conteo, el servidor lo rechazará y requerirá un nuevo conteo."));
    }}];
  };

  const createButtons = () => {
    const buttons: Array<{ label: string; onClick: () => void; disabled?: boolean }> = [];
    if (pageId === "members" && hasCommand(context, "MemberCreated")) buttons.push({ label: "＋ Nuevo socio", onClick: () => runAction("MemberCreated", "Crear socio", fields(field("name", "Nombre completo", "text", { required: true }), field("email", "Correo electrónico", "email"), field("phone", "Teléfono", "tel")), v => ({ name: str(v, "name"), email: str(v, "email"), phone: str(v, "phone"), address: {}, preferences: {} }), undefined, "", true) });
    if (pageId === "orders" && hasCommand(context, "OrderCreated")) buttons.push({ label: "＋ Pedido avanzado", onClick: () => runAction("OrderCreated", "Iniciar pedido", fields({ ...select("memberId", "Socio", optionsOf(memberRows), true), lookupPath: "/api/operations/members" }, select("channel", "Modalidad", [{ value: "local", label: "Retiro" }, { value: "delivery", label: "Reparto" }]), currencyField(), field("address", "Domicilio de reparto (opcional)", "textarea"), field("preorder", "Crear como preventa", "checkbox")), v => ({ memberId: str(v, "memberId"), channel: str(v, "channel"), currency: str(v, "currency"), address: str(v, "address") ? { address: str(v, "address") } : {}, preorder: v.preorder === true }), undefined, "", true) });
    const purchaseSupplierOptions = rowsOf(manualReferenceData.data, "suppliers").flatMap(row => row.active === true && idOf(row) && typeof row.name === "string" && row.name.trim() ? [{ value: idOf(row), label: row.name }] : []);
    const purchaseSkuOptions = catalogRows.flatMap(row => {
      const value = idOf(row), label = textValue(row.name, textValue(row.code, ""));
      return value && label && (row.unit === "g" || row.unit === "ud") ? [{ value, label }] : [];
    });
    const purchaseLineFields = (values: Record<string, string | boolean>): ActionField[] => {
      const sku = catalogRows.find(row => idOf(row) === str(values, "skuId"));
      const unit = sku?.unit === "g" || sku?.unit === "ud" ? sku.unit : "";
      const unitOptions = unit ? [{ value: unit, label: unit === "g" ? "Gramos (g)" : "Unidades (ud)" }] : [];
      return [
        select("skuId", "Producto", purchaseSkuOptions, true, "Elegí el nombre del producto del catálogo."),
        { ...select("unit", "Unidad del producto", unitOptions, true, "La unidad se determina por el producto elegido."), autoSelectSingleOption: true },
        field("quantity", "Cantidad acordada", "decimal", { required: true, step: "any" }),
        field("unitCost", "Costo unitario exacto", "decimal", { required: true, step: "any", help: "Se conserva como decimal exacto, hasta 12 posiciones." }),
      ];
    };
    if (pageId === "purchases" && hasCommand(context, "PurchaseOrderCreated") && !manualReferenceData.loading && !manualReferenceData.error && purchaseSupplierOptions.length > 0 && purchaseSkuOptions.length > 0) buttons.push({ label: "＋ Nueva compra", onClick: () => runAction("PurchaseOrderCreated", "Registrar acuerdo de compra", fields(select("supplierId", "Proveedor activo", purchaseSupplierOptions), field("agreementDate", "Fecha del acuerdo", "date", { required: true, defaultValue: localDate() }), field("expectedDate", "Fecha prevista (opcional)", "date"), currencyField(), field("items", "Artículos del acuerdo", "repeat", { fields: purchaseLineFields({}), rowFields: purchaseLineFields, initialRows: 1, maxRows: 200, addLabel: "Agregar artículo", required: true }), evidenceField("Nota del acuerdo")), v => {
      const lineValues = repeatedValues(v, "items").filter(item => str(item, "skuId") || str(item, "quantity") || str(item, "unitCost"));
      if (!lineValues.length) throw new Error("Agregá al menos un artículo al acuerdo.");
      const items = lineValues.map(line => {
        const skuId = str(line, "skuId");
        const sku = catalogRows.find(candidate => idOf(candidate) === skuId);
        if (!sku || !purchaseSkuOptions.some(option => option.value === skuId)) throw new Error("Elegí un producto disponible del catálogo para cada línea.");
        const unit = sku.unit;
        if (unit !== "g" && unit !== "ud") throw new Error("El producto seleccionado no tiene una unidad de compra válida.");
        const exactCost = decimal(str(line, "unitCost"), "Costo unitario");
        const scaledCost = scaledQuantity(exactCost);
        if (scaledCost === null || scaledCost <= 0n) throw new Error("El costo unitario debe ser positivo y admitir hasta 12 decimales.");
        return { lineId: uuid(), skuId, unit, quantity: quantityForUnit(str(line, "quantity"), unit, "Cantidad acordada"), unitCost: exactCost };
      });
      return { supplierId: str(v, "supplierId"), agreementDate: str(v, "agreementDate"), ...(str(v, "expectedDate") ? { expectedDate: str(v, "expectedDate") } : {}), currency: str(v, "currency"), items, evidence: note(v) };
    }, undefined, "", true) });
    if (pageId === "accounts" && hasCommand(context, "AccountCreated")) buttons.push({ label: "＋ Nueva cuenta", onClick: () => runAction("AccountCreated", "Registrar cuenta", fields(field("name", "Nombre", "text", { required: true }), currencyField(), select("kind", "Tipo", ["cash", "bank", "reserve", "custody"].map(x => ({ value: x, label: ({ cash: "Caja", bank: "Banco", reserve: "Reserva", custody: "Custodia" } as Record<string, string>)[x] }))), field("holder", "Titular", "text", { required: true }), field("purpose", "Uso de la cuenta", "textarea", { required: true }), field("custodianId", "ID de custodio (si corresponde)", "text")), v => ({ name: str(v, "name"), currency: str(v, "currency"), kind: str(v, "kind"), holder: str(v, "holder"), purpose: str(v, "purpose"), ...(str(v, "custodianId") ? { custodianId: str(v, "custodianId") } : {}) }), undefined, "", true) });
    const contributionAccounts = accountRows.filter(account => account.kind !== "custody" && account.verified === true && typeof account.openingApprovedBy === "string");
    if (pageId === "accounts" && hasCommand(context, "OwnerContributionRecorded") && contributionAccounts.length > 0) buttons.push({ label: "＋ Registrar aporte del propietario", onClick: () => runAction("OwnerContributionRecorded", "Registrar aporte del propietario", fields(select("accountId", "Cuenta del club · moneda", contributionAccounts.map(account => ({ value: idOf(account), label: `${labelOf(account, ["name"])} · ${textValue(account.currency)}` }))), field("amount", "Importe recibido", "amount", { required: true }), field("contributor", "Titular / propietario que aporta", "text", { required: true, max: "150" }), evidenceField("Evidencia del aporte")), v => ({ accountId: str(v, "accountId"), amountMinor: checkedMinor(str(v, "amount"), "El aporte"), contributor: str(v, "contributor").trim(), evidence: note(v) }), undefined, "Este movimiento registra un aporte del propietario a una cuenta del club; no crea una venta ni una deuda.", true) });
    if (pageId === "routes" && hasCapability(context, "logistics.write") && hasCommand(context, "RouteCreated") && deliveryPeople.length > 0) buttons.push({ label: "＋ Nueva ruta", onClick: () => runAction("RouteCreated", "Programar ruta", fields(select("driverId", "Repartidor autorizado", optionsOf(deliveryPeople, ["name"])), field("shiftDate", "Fecha del turno", "date", { required: true, defaultValue: localDate() }), select("custodianAccountId", "Cuenta de custodia (opcional)", [{ value: "", label: "Sin asignar" }, ...optionsOf(accountRows.filter(a => a.kind === "custody"))], false)), v => ({ driverId: str(v, "driverId"), shiftDate: str(v, "shiftDate"), ...(str(v, "custodianAccountId") ? { custodianAccountId: str(v, "custodianAccountId") } : {}) }), undefined, "", true) });
    if (pageId === "collections" && hasCommand(context, "CollectionReported")) buttons.push({ label: "＋ Reportar cobro", onClick: () => reportCollection() });
    if (pageId === "settlements" && hasCommand(context, "RenditionAccepted")) buttons.push({
      label: "＋ Aceptar rendición",
      disabled: !canAcceptRendition || query.loading || Boolean(query.error),
      onClick: acceptRendition,
    });
    if (pageId === "payables" && hasCommand(context, "PayableCreated")) {
      const accrualField = () => field("accrualPeriod", "Período de devengamiento · YYYY-MM", "month", { required: true, help: "Mes al que corresponde la obligación; no es la fecha de pago." });
      buttons.push({ label: "＋ Gasto operativo", onClick: () => runAction("PayableCreated", "Registrar gasto operativo", fields(
        field("beneficiaryId", "ID del beneficiario", "text", { required: true }),
        currencyField(), field("amount", "Importe", "amount", { required: true }),
        field("dueDate", "Vencimiento", "date", { required: true }), accrualField(),
        select("costTreatment", "Tratamiento del gasto", [{ value: "variable", label: "Variable · se descuenta en el mes devengado" }, { value: "fixed", label: "Fijo · se informa por separado" }]),
        evidenceField("Evidencia de la obligación y su período"),
      ), v => ({ beneficiaryId: str(v, "beneficiaryId"), kind: "operating_expense", currency: str(v, "currency"), amountMinor: amountFormToMinor(str(v, "amount")), dueDate: str(v, "dueDate"), accrualPeriod: accrualPeriodValue(v), costTreatment: str(v, "costTreatment"), evidence: note(v) }), undefined, "El gasto sólo se reconoce cuando se verifica. Los costos variables restan a la contribución de gestión; los fijos quedan separados.", true) });
      if (hasCapability(context, "purchases.write") && payablePurchases.data && payablePurchaseOptions.length > 0) buttons.push({ label: "＋ Deuda de compra", onClick: () => runAction("PayableCreated", "Registrar deuda de compra", fields(
        select("purchaseId", "Compra y proveedor", payablePurchaseOptions, true, "El proveedor y la moneda se tomarán de la compra seleccionada."),
        field("amount", "Importe de la obligación", "amount", { required: true }),
        field("dueDate", "Vencimiento", "date", { required: true }), accrualField(),
        evidenceField("Evidencia de la deuda de compra"),
      ), v => {
        const purchase = payablePurchaseRows.find(item => idOf(item) === str(v, "purchaseId"));
        if (!purchase) throw new Error("Elegí una compra cargada para conservar su proveedor y moneda.");
        const supplierId = textValue(purchase.supplierId, "");
        const currency = textValue(purchase.currency, "");
        if (!supplierId || !["ARS", "USD"].includes(currency)) throw new Error("La compra elegida no informa un proveedor y una moneda válidos.");
        return { purchaseId: idOf(purchase), beneficiaryId: supplierId, kind: "purchase", currency, amountMinor: amountFormToMinor(str(v, "amount")), dueDate: str(v, "dueDate"), accrualPeriod: accrualPeriodValue(v), evidence: note(v) };
      }, undefined, "El vínculo conserva la compra de origen. El importe y las fechas se registran según la obligación documentada.", true) });
      buttons.push({ label: "＋ Deuda histórica sin vínculo", onClick: () => runAction("PayableCreated", "Registrar deuda histórica sin vínculo a compra", fields(
        field("beneficiaryId", "ID del beneficiario", "text", { required: true }), currencyField(),
        field("amount", "Importe de la obligación", "amount", { required: true }),
        field("dueDate", "Vencimiento", "date", { required: true }), accrualField(),
        field("sourceSystem", "Sistema de origen (opcional)", "text", { max: "120" }),
        field("sourceId", "Referencia de origen (opcional)", "text", { max: "150" }),
        evidenceField("Evidencia de la deuda histórica"),
      ), v => {
        const sourceSystem = str(v, "sourceSystem").trim(), sourceId = str(v, "sourceId").trim();
        if (Boolean(sourceSystem) !== Boolean(sourceId)) throw new Error("Completá juntos el sistema y la referencia de origen, o dejá ambos vacíos.");
        return { beneficiaryId: str(v, "beneficiaryId"), kind: "purchase", currency: str(v, "currency"), amountMinor: amountFormToMinor(str(v, "amount")), dueDate: str(v, "dueDate"), accrualPeriod: accrualPeriodValue(v), ...(sourceSystem ? { sourceSystem, sourceId } : {}), evidence: note(v) };
      }, undefined, "Esta obligación se registra como deuda histórica de compra y permanece sin vínculo a una compra vigente.", true) });
      buttons.push({ label: "＋ Nueva obligación", onClick: () => runAction("PayableCreated", "Registrar obligación", fields(
        field("beneficiaryId", "ID del beneficiario", "text", { required: true }),
        select("kind", "Tipo", ["courier_fee", "asset_purchase", "owner_withdrawal", "other"].map(value => ({ value, label: value.replaceAll("_", " ") }))),
        currencyField(), field("amount", "Importe", "amount", { required: true }),
        field("dueDate", "Vencimiento", "date", { required: true }), accrualField(),
        evidenceField("Evidencia de la obligación y su período"),
      ), v => ({ beneficiaryId: str(v, "beneficiaryId"), kind: str(v, "kind"), currency: str(v, "currency"), amountMinor: amountFormToMinor(str(v, "amount")), dueDate: str(v, "dueDate"), accrualPeriod: accrualPeriodValue(v), evidence: note(v) }), undefined, "El período de devengamiento es independiente de cuándo se pague la obligación.", true) });
    }
    if (pageId === "commercial" && hasCommand(context, "PricePolicyProposed")) buttons.push({ label: "＋ Proponer política", onClick: () => runAction("PricePolicyProposed", "Proponer una versión de precios", fields(
      field("name", "Nombre", "text", { required: true }), field("version", "Versión", "integer", { required: true, defaultValue: "1" }), currencyField(), field("validFrom", "Vigente desde", "date", { required: true, defaultValue: localDate() }), field("validUntil", "Vigente hasta (opcional)", "date"),
      field("tiers", "Escalas", "repeat", { initialRows: 1, maxRows: 1000, addLabel: "Agregar escala", fields: [select("skuId", "Producto", optionsOf(catalogRows, ["name"])), field("minQuantity", "Cantidad mínima", "decimal", { required: true }), field("unitPrice", "Precio por unidad", "decimal", { required: true }), field("scale", "Nombre de la escala", "text", { required: true })] }),
      select("payment", "Medio de pago habilitado", [{ value: "cash", label: "Efectivo" }, { value: "transfer", label: "Transferencia" }, { value: "mercado_pago", label: "Mercado Pago" }, { value: "card", label: "Tarjeta" }]), field("productPercent", "Recargo de producto (%)", "decimal", { defaultValue: "0" }), field("deliveryPercent", "Recargo de entrega (%)", "decimal", { defaultValue: "0" }),
      field("benefits", "Beneficios por segmento", "repeat", { addLabel: "Agregar beneficio", fields: [field("segment", "Segmento", "text", { required: true }), field("amount", "Descuento en la moneda de la política", "amount", { required: true })] }), evidenceField(),
    ), v => {
      const tiers = repeatedValues(v, "tiers").map(tier => {
        const sku = catalogRows.find(sku => sku.id === str(tier, "skuId"));
        if (!sku) throw new Error("Elegí el producto de cada escala.");
        return { skuId: idOf(sku), minQuantity: quantityForUnit(str(tier, "minQuantity"), sku.unit, "Cantidad mínima"), unitPrice: decimal(str(tier, "unitPrice"), "Precio unitario"), scale: str(tier, "scale") };
      });
      const benefits = repeatedValues(v, "benefits");
      if (new Set(benefits.map(benefit => str(benefit, "segment"))).size !== benefits.length) throw new Error("Cada segmento debe aparecer una sola vez.");
      return { name: str(v, "name"), version: Number(str(v, "version")), currency: str(v, "currency"), validFrom: str(v, "validFrom"), ...(str(v, "validUntil") ? { validUntil: str(v, "validUntil") } : {}), definition: { tiers, productSurchargeBps: maximumPercentToBps(str(v, "productPercent")), deliverySurchargeBps: maximumPercentToBps(str(v, "deliveryPercent")), paymentMethods: [str(v, "payment")], automaticScaleVerified: false, segmentBenefits: Object.fromEntries(benefits.map(benefit => [str(benefit, "segment"), amountFormToMinor(str(benefit, "amount"))])), evidence: note(v) } };
    }, undefined, "La selección de escalas seguirá siendo explícita hasta verificar una regla automática. La propuesta requiere aprobación del propietario.", true) });
    if (pageId === "commercial" && hasCommand(context, "PackProposed")) buttons.push({ label: "＋ Proponer pack", onClick: () => runAction("PackProposed", "Proponer pack y composición", fields(
      field("name", "Nombre", "text", { required: true }), field("version", "Versión", "integer", { required: true, defaultValue: "1" }), currencyField(), field("price", "Precio total del pack", "amount", { required: true }), field("validFrom", "Vigente desde", "date", { required: true, defaultValue: localDate() }), field("validUntil", "Vigente hasta (opcional)", "date"),
      field("components", "Componentes", "repeat", { initialRows: 1, maxRows: 100, addLabel: "Agregar componente", fields: [select("skuId", "Producto fijo (opcional)", optionsOf(catalogRows, ["name"]), false), select("category", "Categoría a elegir (si no es fijo)", [...new Set(catalogRows.map(sku => String(sku.category)))].map(category => ({ value: category, label: category })), false), select("unit", "Unidad", [{ value: "g", label: "Gramos" }, { value: "ud", label: "Unidades" }]), field("quantity", "Cantidad por pack", "decimal", { required: true }), field("reference", "Importe de referencia del componente", "amount", { required: true, help: "Estas referencias distribuyen el descuento y se congelan al aprobar." })] }),
    ), v => ({ name: str(v, "name"), version: Number(str(v, "version")), currency: str(v, "currency"), priceMinor: amountFormToMinor(str(v, "price")), validFrom: str(v, "validFrom"), ...(str(v, "validUntil") ? { validUntil: str(v, "validUntil") } : {}), components: repeatedValues(v, "components").map(component => {
      if (Boolean(str(component, "skuId")) === Boolean(str(component, "category"))) throw new Error("Cada componente debe tener un producto fijo o una categoría para elegir.");
      return { id: str(component, "entryId"), ...(str(component, "skuId") ? { skuId: str(component, "skuId") } : { category: str(component, "category") }), unit: str(component, "unit"), quantity: quantityForUnit(str(component, "quantity"), str(component, "unit"), "Cantidad del componente"), referenceMinor: amountFormToMinor(str(component, "reference")) };
    }) }), undefined, "La composición y las referencias necesitan aprobación antes de cotizar. Completar una tarea no activa este pack.", true) });
    if (pageId === "commercial" && hasCommand(context, "PromotionProposed")) buttons.push({ label: "＋ Proponer promoción", onClick: () => runAction("PromotionProposed", "Proponer promoción", fields(
      field("name", "Nombre", "text", { required: true }), field("version", "Versión", "integer", { required: true, defaultValue: "1" }), field("validFrom", "Vigente desde", "date", { required: true, defaultValue: localDate() }), field("validUntil", "Vigente hasta", "date", { required: true }), select("policyId", "Política aprobada (opcional)", optionsOf(approvedPolicies), false), select("packId", "Pack aprobado (opcional)", optionsOf(approvedPacks), false), field("description", "Descripción", "textarea", { required: true }), field("eligibility", "Condiciones que debe revisar el propietario (opcional)", "textarea"), evidenceField(),
    ), v => ({ name: str(v, "name"), version: Number(str(v, "version")), validFrom: str(v, "validFrom"), validUntil: str(v, "validUntil"), definition: { ...(str(v, "policyId") ? { policyId: str(v, "policyId") } : {}), ...(str(v, "packId") ? { packId: str(v, "packId") } : {}), eligibility: str(v, "eligibility") ? { ownerReview: str(v, "eligibility") } : {}, description: str(v, "description"), evidence: note(v) } }), undefined, "La vigencia y elegibilidad se revisan antes de aplicar. La propuesta no envía mensajes ni activa promociones.", true) });
    if (pageId === "tasks" && hasCommand(context, "TaskCreated")) buttons.push({ label: "＋ Nueva tarea", onClick: () => runAction("TaskCreated", "Crear tarea", fields(field("title", "Tarea", "text", { required: true }), userRows.length ? select("responsibleId", "Responsable", optionsOf(userRows, ["name", "id"])) : field("responsibleId", "ID de responsable", "text", { required: true }), field("dueDate", "Fecha límite", "date", { required: true, defaultValue: localDate() })), v => ({ title: str(v, "title"), responsibleId: str(v, "responsibleId"), dueDate: str(v, "dueDate"), links: {} }), undefined, "", true) });
    if (pageId === "configuration" && hasCapability(context, "finance.read") && hasCommand(context, "ConfigurationProposed")) {
      const horizon = thirteenWeekHorizon(localDate(context.timeZone));
      buttons.push({ label: "＋ Proponer supuesto de 13 semanas", onClick: () => runAction("ConfigurationProposed", "Proponer supuesto financiero", fields(
        field("scenarioDate", "Fecha del supuesto", "date", { required: true, min: horizon.from, max: horizon.through, defaultValue: localDate(context.timeZone) }),
        select("scenarioKind", "Tipo", [{ value: "income", label: "Ingreso esperado" }, { value: "payment", label: "Pago previsto" }, { value: "purchase", label: "Compra" }, { value: "funding", label: "Aporte esperado" }]),
        currencyField(), field("amount", "Importe", "amount", { required: true }),
        field("description", "Descripción", "textarea", { required: true, max: "300" }),
        field("commitmentId", "Identificador del compromiso (opcional)", "text", { max: "100", help: "Si existe, usá la referencia del compromiso correspondiente." }),
        evidenceField("Base y evidencia del supuesto"),
      ), v => proposeManualScenario(v, rowsOf(query.data), context.timeZone), undefined,
      `La fecha debe quedar entre ${horizon.from} y ${horizon.through}. La propuesta se revisa aparte; sólo supuestos aprobados pueden alimentar la proyección.`, true) });
    }
    if (pageId === "configuration" && hasCommand(context, "ConfigurationProposed")) buttons.push({ label: "＋ Proponer configuración", onClick: () => runAction("ConfigurationProposed", "Proponer una configuración versionada", fields(field("name", "Nombre de la regla", "text", { required: true }), select("kind", "Tipo", [{ value: "preparation_limits", label: "Límites de preparación" }, { value: "stock_thresholds", label: "Umbrales de stock" }, ...(hasCapability(context, "stock.adjust") ? [{ value: "stock_availability", label: "Disponibilidad comercial por ubicación" }] : []), ...(hasCapability(context, "finance.read") ? [{ value: "objectives", label: "Objetivos financieros" }, { value: "fixed_costs", label: "Costos fijos" }] : [])]), field("version", "Versión", "integer", { required: true, defaultValue: "1" }), field("validFrom", "Vigencia desde", "date", { required: true, defaultValue: localDate() }), field("maximumGramsPerOrder", "Máximo de gramos por pedido", "decimal"), field("maximumExtraGramsPerLine", "Máximo extra por línea", "decimal"), field("maximumExtraPercent", "Máximo adicional (%)", "decimal", { min: "0", max: "100", step: "0.01", defaultValue: "1", help: "Ingresá un porcentaje; se convierte exactamente a puntos básicos enteros (1 % = 100 pb)." }), field("category", "Categoría para umbral (si aplica)", "text"), field("minimumQuantity", "Cantidad mínima", "decimal"), field("minimumVarieties", "Variedades mínimas", "integer"), field("availabilityRules", "Reglas de disponibilidad · una por línea: ubicación | custodio | local/delivery | true/false | motivo", "textarea", { help: "Las referencias deben ser ubicaciones y custodios activos; cada combinación ubicación/custodio/canal puede aparecer una sola vez." }), currencyField(), field("monthlyContribution", "Objetivo de aporte mensual", "amount"), field("costCategory", "Categoría de costo (si aplica)", "text"), field("costAmount", "Importe del costo", "amount"), field("accrualPeriod", "Período YYYY-MM", "text"), evidenceField()), v => {
      const kind = str(v, "kind");
      const definition = kind === "preparation_limits" ? { maximumGramsPerOrder: decimal(str(v, "maximumGramsPerOrder"), "Máximo por pedido"), maximumExtraGramsPerLine: decimal(str(v, "maximumExtraGramsPerLine"), "Máximo extra"), maximumExtraBps: maximumPercentToBps(str(v, "maximumExtraPercent")), evidence: note(v) }
        : kind === "stock_thresholds" ? { categories: [{ category: str(v, "category"), unit: "g", minimumQuantity: decimal(str(v, "minimumQuantity"), "Cantidad mínima"), minimumVarieties: Number.parseInt(str(v, "minimumVarieties"), 10) }] }
          : kind === "stock_availability" ? { rules: parseRows(str(v, "availabilityRules"), 5, ["ubicación", "custodio", "canal", "true/false", "motivo"]).map(([locationId, custodianId, channel, available, reason]) => {
              if (channel !== "local" && channel !== "delivery") throw new Error("El canal debe ser local o delivery.");
              if (available !== "true" && available !== "false") throw new Error("La disponibilidad debe ser true o false.");
              if (!reason.trim()) throw new Error("Cada regla requiere un motivo.");
              return { locationId, custodianId, channel, available: available === "true", reason };
            }) }
          : kind === "objectives" ? { currency: str(v, "currency"), monthlyContributionMinor: amountFormToMinor(str(v, "monthlyContribution")) }
            : { currency: str(v, "currency"), items: [{ category: str(v, "costCategory"), amountMinor: amountFormToMinor(str(v, "costAmount")), accrualPeriod: str(v, "accrualPeriod"), recurring: false }] };
      return { name: str(v, "name"), kind, version: Number.parseInt(str(v, "version"), 10), validFrom: str(v, "validFrom"), definition, evidence: note(v) };
    }, undefined, "", true, "La propuesta no se activa al guardarse; queda pendiente de aprobación independiente." ) });
    if (pageId === "access" && profileOptions.length > 0 && hasCommand(context, "AccessGranted")) buttons.push({ label: "＋ Conceder perfil", onClick: () => runAction("AccessGranted", "Conceder acceso operativo", fields(
      userRows.length ? select("userId", "Usuario activo", optionsOf(userRows, ["name", "id"])) : field("userId", "ID de usuario", "text", { required: true }),
      select("profile", "Perfil publicado", profileOptions),
      field("accountIds", "Cuentas incluidas en el alcance (opcional)", "textarea", { help: "UUIDs, separados por coma, espacio o salto de línea." }),
      field("memberIds", "Socios incluidos en el alcance (opcional)", "textarea", { help: "Necesario junto con accountIds para revisar cobros reportados aún sin cuenta." }),
      field("locationIds", "Ubicaciones incluidas en el alcance (opcional)", "textarea", { help: "UUIDs, separados por coma, espacio o salto de línea." }),
      field("custodianIds", "Custodios incluidos en el alcance (opcional)", "textarea", { help: "Necesario junto con accountIds para revisar cobros reportados aún sin cuenta." }),
      field("confirmation", "Confirmo que revisé el alcance solicitado", "checkbox", { required: true }),
    ), v => {
      if (v.confirmation !== true) throw new Error("Confirmá la revisión del alcance.");
      const scope = Object.fromEntries((["accountIds", "memberIds", "locationIds", "custodianIds"] as const).flatMap(key => {
        const ids = scopeIdList(str(v, key));
        return ids.length ? [[key, ids]] : [];
      }));
      return { userId: str(v, "userId"), profile: str(v, "profile"), additional: [], scope };
    }, undefined, "", true) });
    return buttons;
  };

  const create = createButtons();
  const columnsByPage: Record<string, Array<[string, string]>> = {
    members: [["name", "Socio"], ["email", "Correo"], ["phone", "Teléfono"], ["active", "Activo"]],
    catalog: [["name", "Producto"], ["category", "Categoría"], ["unit", "Unidad"], ["active", "Activo"]],
    orders: [["invoiceOrOrderLabel", "Factura / pedido"], ["invoiceMemberLabel", "Cliente"], ["lines", "Productos"], ["commercialState", "Estado comercial"], ["fulfillmentState", "Preparación"], ["financialState", "Cobro"], ["legacyFinancialLabel", "Saldo y pago histórico"], ["invoiceTotalLabel", "Total facturado"], ["invoiceTotalBreakdownLabel", "Desglose confirmado"], ["invoiceTotalSourceLabel", "Origen del total"], ["capturedBaseLabel", "Importe capturado"]],
    purchases: [["id", "Compra"], ["supplierId", "Proveedor"], ["agreementDate", "Acuerdo"], ["expectedDate", "Prevista"], ["items", "Artículos"], ["totalMinor", "Total"], ["currency", "Moneda"], ["status", "Estado"]],
    routes: [["shiftDate", "Turno"], ["driverId", "Repartidor"], ["status", "Estado"], ["closedWithPending", "Cierre con pendientes"]],
    tasks: [["title", "Tarea"], ["dueDate", "Vence"], ["status", "Estado"], ["responsibleId", "Responsable"]],
    collections: [["id", "Referencia de cobro"], ["orderId", "Pedido"], ["reporterId", "Reportado por"], ["method", "Medio"], ["amountMinor", "Importe informado"], ["currency", "Moneda"], ["evidence", "Evidencia"], ["status", "Estado"]],
    accounts: [["name", "Cuenta"], ["kind", "Tipo"], ["currency", "Moneda"], ["balanceMinor", "Saldo calculado"], ["lastReconciledDate", "Último arqueo"], ["lastCountedMinor", "Último saldo contado"], ["lastDifferenceMinor", "Última diferencia"], ["coverage", "Cobertura"]],
    payables: [["beneficiaryId", "Beneficiario"], ["kind", "Tipo"], ["purchaseReference", "Compra de origen"], ["amountMinor", "Importe"], ["accrualPeriod", "Devengamiento"], ["costTreatment", "Tratamiento de costo"], ["paidMinor", "Pagado"], ["verified", "Verificada"]],
    settlements: [["driverId", "Repartidor"], ["grossMinor", "Bruto rendido"], ["deliveredMinor", "Entregado"], ["feeMinor", "Remuneración"], ["acceptedAt", "Aceptada"]],
    commercial: [["name", "Nombre"], ["_kind", "Clase"], ["version", "Versión"], ["status", "Estado"], ["validFrom", "Desde"], ["validUntil", "Hasta"]],
    configuration: [["name", "Regla"], ["kind", "Tipo"], ["version", "Versión"], ["state", "Estado"], ["validFrom", "Vigencia"]],
    gates: [["id", "Habilitación"], ["status", "Estado"], ["approvedBy", "Autor"], ["reviewedBy", "Revisor"], ["approvedAt", "Fecha"]],
  };
  const title = spec.title;
  const purchaseRemainingLines = (purchase: Row) => remainingPurchaseLines(purchase, rowsOf(query.data, "receipts"));
  const purchaseReceiptLinesAreValid = (purchase: Row) => {
    const remaining = purchaseRemainingLines(purchase);
    if (!remaining.length || remaining.some(item => item.remaining === null)) return false;
    const pending = remaining.filter(item => item.remaining! > 0n);
    return pending.length === 0 || (purchaseCatalogReady && pending.every(({ line }) => Boolean(purchaseLineId(line)) && activeNamedPurchaseSku(line, catalogRows) !== null));
  };
  const hasPurchaseAwaitingReceipt = pageId === "purchases" && mainRows.some(row => ["approved", "partially_received"].includes(String(row.status)));
  const purchasesBlockedByCatalog = hasPurchaseAwaitingReceipt && hasCommand(context, "GoodsReceived")
    ? mainRows.filter(row => ["approved", "partially_received"].includes(String(row.status)) && !purchaseReceiptLinesAreValid(row))
    : [];
  const actionButtonsFor = (row: Row) => {
    const id = idOf(row);
    const buttons: Array<{ label: string; onClick: () => void }> = [];
    const quote = recordValue(row, "quote");
    const isAppSheetInvoice = recordValue(quote, "source") === "appsheet-invoice";
    const isConfirmedAppSheetInvoice = isAppSheetInvoice && row.commercialState === "confirmed";
    if (pageId === "orders" && row.commercialState === "confirmed" && hasCommand(context, "CollectionReported")) buttons.push({ label: "＋ Reportar cobro", onClick: () => reportCollection(row) });
    if (pageId === "catalog" && hasCapability(context, "stock.read")) buttons.push({ label: "Historia del producto", onClick: () => setSelectedProductId(id) });
    if (pageId === "purchases" && row.status === "draft" && hasCommand(context, "PurchaseOrderApproved")) buttons.push({ label: "Aprobar compra", onClick: () => runAction("PurchaseOrderApproved", "Revisar y aprobar la compra", fields(evidenceField("Motivo de aprobación")), v => ({ evidence: note(v) }), row, "La persona que aprobó debe ser distinta de quien creó el acuerdo.") });
    if (pageId === "purchases" && ["approved", "partially_received"].includes(String(row.status)) && hasCommand(context, "GoodsReceived") && locationReferencesReady && purchaseReceiptLinesAreValid(row)) {
      const remaining = purchaseRemainingLines(row);
      const receivable = remaining.filter(item => item.remaining !== null && item.remaining > 0n);
      if (remaining.length > 0 && remaining.every(item => item.remaining !== null) && receivable.length > 0) {
      const receiveFields: ActionField[] = [
        field("receivedDate", "Fecha de recepción", "date", { required: true, defaultValue: localDate() }),
        select("locationId", "Ubicación de ingreso", optionsOf(namedLocationRows)),
        select("custodianId", "Custodio (opcional; por defecto, vos)", [{ value: "", label: "Yo recibo" }, ...optionsOf(namedCustodianRows, ["name"])], false),
      ];
        for (const item of receivable) {
          const lineId = purchaseLineId(item.line);
          const sku = activeNamedPurchaseSku(item.line, catalogRows)!;
          const label = `${sku.name.trim()} · ${formatScaled(item.remaining!)} ${textValue(item.line.unit)}`;
          receiveFields.push(field(`quantity_${lineId}`, `Cantidad recibida · ${label}`, "decimal", { help: `Pendiente según las recepciones anteriores: ${formatScaled(item.remaining!)} ${textValue(item.line.unit)}. Vacío para no recibir este renglón.` }));
          receiveFields.push(field(`lotLabel_${lineId}`, `Etiqueta del lote · ${label}`, "text", { help: "Obligatoria si ingresás una cantidad." }));
          receiveFields.push(field(`expiresOn_${lineId}`, `Vencimiento del lote · ${label}`, "date"));
        }
        receiveFields.push(evidenceField("Nota de recepción"));
        buttons.push({ label: "Registrar recepción", onClick: () => runAction("GoodsReceived", "Registrar recepción de mercadería", receiveFields, v => {
          const receivedDate = str(v, "receivedDate");
          const items = receivable.flatMap(({ line }) => {
            const lineId = purchaseLineId(line);
            const sku = activeNamedPurchaseSku(line, catalogRows);
            if (!sku) throw new Error("El catálogo vigente ya no identifica todos los productos de esta compra; actualizá la vista antes de recibirla.");
            const rawQuantity = str(v, `quantity_${lineId}`);
            if (!rawQuantity) return [];
            const lotLabel = str(v, `lotLabel_${lineId}`).trim();
            if (!lotLabel) throw new Error(`Agregá la etiqueta del lote para ${sku.name.trim()}.`);
            const quantity = quantityForUnit(rawQuantity, line.unit, "Cantidad recibida");
            const available = remaining.find(candidate => purchaseLineId(candidate.line) === lineId)?.remaining;
            if (available !== null && available !== undefined && scaledQuantity(quantity)! > available) throw new Error(`La cantidad supera lo pendiente para ${sku.name.trim()}.`);
            const expiresOn = str(v, `expiresOn_${lineId}`);
            if (expiresOn && expiresOn < receivedDate) throw new Error("El vencimiento no puede ser anterior a la fecha de recepción.");
            return [{ lineId, quantity, lotLabel, ...(expiresOn ? { expiresOn } : {}) }];
          });
          if (!items.length) throw new Error("Indicá al menos un renglón recibido.");
          return { purchaseId: idOf(row), receivedDate, locationId: str(v, "locationId"), ...(str(v, "custodianId") ? { custodianId: str(v, "custodianId") } : {}), items, evidence: note(v) };
        }, undefined, "Podés registrar una recepción parcial. Cada cantidad crea un lote y saldo bajo custodia en la ubicación elegida.", true) });
      }
    }
    if (pageId === "members" && hasCommand(context, "MemberUpdated")) buttons.push({ label: "Editar", onClick: () => runAction("MemberUpdated", "Actualizar socio", fields(field("name", "Nombre completo", "text", { required: true, defaultValue: String(row.name ?? "") }), field("email", "Correo", "email", { defaultValue: String(row.email ?? "") }), field("phone", "Teléfono", "tel", { defaultValue: String(row.phone ?? "") })), v => ({ name: str(v, "name"), email: str(v, "email"), phone: str(v, "phone"), address: typeof row.address === "object" && row.address ? row.address as JsonRecord : {}, preferences: typeof row.preferences === "object" && row.preferences ? row.preferences as JsonRecord : {} }), row) });
    if (pageId === "members" && hasCommand(context, "PermissionVerified")) buttons.push({ label: "Verificar permiso", onClick: () => runAction("PermissionVerified", "Verificar permiso operativo", fields(field("kind", "Tipo de permiso", "text", { required: true, defaultValue: "operations" }), field("validFrom", "Válido desde", "date", { required: true, defaultValue: localDate() }), field("validUntil", "Válido hasta", "date", { required: true }), select("evidenceDocumentId", "Documento disponible vinculado al socio", documentOptions(documentRows.filter(doc => doc.memberId === id && doc.state === "available")), true, "Elegí el tipo y vigencia del documento cargado para este socio.")), v => ({ kind: str(v, "kind"), validFrom: str(v, "validFrom"), validUntil: str(v, "validUntil"), evidenceDocumentId: str(v, "evidenceDocumentId") }), row) });
    if (pageId === "orders" && isAppSheetInvoice && row.commercialState === "preorder" && hasCommand(context, "InvoiceUpdated")) buttons.push({ label: "Formulario de venta", onClick: () => {
      const expectedVersion = versionFor(query.data, row, Number.NaN);
      if (!Number.isSafeInteger(expectedVersion)) { onNotice("No se pudo confirmar la versión de la preventa. Actualizá Pedidos antes de editarla."); return; }
      const memberName = textValue(memberRows.find(member => idOf(member) === String(row.memberId ?? ""))?.name, "");
      openInvoiceEditor({ mode: "edit-preorder", order: row, expectedVersion, memberName });
    } });
    const invoiceLines = Array.isArray(recordValue(quote, "lines")) ? recordValue(quote, "lines") as unknown[] : [];
    if (pageId === "orders" && isAppSheetInvoice && row.commercialState === "preorder" && invoiceLines.length > 0 && hasCommand(context, "InvoiceConfirmed")) buttons.push({ label: "Confirmar preventa", onClick: () => {
      const expectedVersion = versionFor(query.data, row, Number.NaN);
      if (!Number.isSafeInteger(expectedVersion)) { onNotice("No se pudo confirmar la versión de la preventa. Actualizá Pedidos antes de confirmarla."); return; }
      openInvoiceEditor({ mode: "confirm-preorder", order: row, expectedVersion });
    } });
    if (pageId === "orders" && isConfirmedAppSheetInvoice && recordValue(quote, "totalCalculationState") === "pending_definition" && hasCommand(context, "InvoiceTotalsConfirmed")) buttons.push({ label: "Confirmar total facturado", onClick: () => {
      const currencyValue = recordValue(quote, "currency") ?? row.currency;
      const currency = currencyValue === "ARS" || currencyValue === "USD" ? currencyValue : null;
      if (!currency) { onNotice("No se pudo confirmar el total: la factura no tiene una moneda ARS o USD disponible."); return; }
      const moto = objectValue(recordValue(quote, "moto"));
      const hasMoto = Object.keys(moto).length > 0;
      const totalFields = fields(
        field("currency", "Moneda de la factura", "select", { required: true, defaultValue: currency, options: [{ value: currency, label: currency }], help: "Se toma de la factura y queda fija; no hay conversión de moneda." }),
        field("productsTotal", "Total de productos confirmado", "amount", { required: true, min: "0.01", help: `Transcribí el total de productos de la factura fuente en ${currency}; no se recalculan precios por gramo ni escalas.` }),
        ...(hasMoto ? [field("motoClientTotal", "Total de moto confirmado", "amount", { required: true, min: "0", help: `Transcribí el total de moto de la factura fuente en ${currency}; no se recalculan tarifas.` })] : []),
        field("evidence", "Evidencia del total facturado", "textarea", { required: true, help: "Ingresá la transcripción de la factura fuente o la aceptación del cliente." }),
      );
      runAction("InvoiceTotalsConfirmed", "Confirmar total facturado", totalFields, values => {
        const productsTotalMinor = amountFormToMinor(str(values, "productsTotal"));
        if (BigInt(productsTotalMinor) <= 0n) throw new Error("El total de productos confirmado debe ser mayor que cero.");
        const motoClientTotalMinor = hasMoto ? amountFormToMinor(str(values, "motoClientTotal")) : "0";
        if (BigInt(motoClientTotalMinor) < 0n) throw new Error("El total de moto confirmado no puede ser negativo.");
        return { currency, productsTotalMinor, motoClientTotalMinor, evidence: note(values) };
      }, row, "Ingresá los importes tal como figuran en la factura fuente o fueron aceptados por el cliente. El total final es la suma de productos y moto; Bombo no recalcula precios ni tarifas.");
    } });
    if (pageId === "orders" && isConfirmedAppSheetInvoice && recordValue(quote, "totalCalculationState") === "staff_confirmed") buttons.push({ label: "Ver confirmación del total", onClick: () => {
      const resolution = objectValue(recordValue(quote, "financialResolution") ?? row.financialResolution);
      const actorId = traceText(resolution.actorId, "Persona no disponible");
      const actor = userRows.find(person => idOf(person) === actorId) ?? peopleRows.find(person => idOf(person) === actorId);
      const evidence = objectValue(resolution.evidence);
      setInvoiceTotalTrace({
        currency: textValue(recordValue(quote, "currency"), textValue(row.currency, "ARS")),
        productsTotalMinor: resolution.productsTotalMinor,
        motoClientTotalMinor: resolution.motoClientTotalMinor,
        totalMinor: recordValue(quote, "totalMinor") ?? row.totalMinor,
        evidenceNote: traceText(evidence.note, ""),
        actorLabel: actor ? `${textValue(actor.name, actorId)} · ${actorId}` : actorId,
        confirmedAt: traceText(resolution.confirmedAt),
        quoteVersion: traceText(resolution.quoteVersion),
        snapshotHash: traceText(resolution.snapshotHash),
      });
    } });
    if (pageId === "orders" && !isAppSheetInvoice && ["draft", "preorder"].includes(String(row.commercialState)) && hasCommand(context, "OrderQuoted")) buttons.push({ label: "Cotizar", onClick: () => runAction("OrderQuoted", "Preparar cotización", fields(
      field("paymentMethod", "Medio de pago general", "select", { required: true, defaultValue: "cash", options: [{ value: "cash", label: "Efectivo" }, { value: "transfer", label: "Transferencia" }, { value: "mercado_pago", label: "Mercado Pago" }, { value: "card", label: "Tarjeta" }], help: "Se usa en productos y entrega cuando no elegís un medio específico." }),
      field("productPaymentMethod", "Medio de pago de productos (opcional)", "select", { required: false, help: "Dejalo sin elegir para heredar el medio general.", options: [{ value: "", label: "Usar medio general" }, { value: "cash", label: "Efectivo" }, { value: "transfer", label: "Transferencia" }, { value: "mercado_pago", label: "Mercado Pago" }, { value: "card", label: "Tarjeta" }] }),
      field("deliveryPaymentMethod", "Medio de pago de entrega (opcional)", "select", { required: false, help: "Dejalo sin elegir para heredar el medio general.", options: [{ value: "", label: "Usar medio general" }, { value: "cash", label: "Efectivo" }, { value: "transfer", label: "Transferencia" }, { value: "mercado_pago", label: "Mercado Pago" }, { value: "card", label: "Tarjeta" }] }),
      field("items", "Productos", "repeat", { fields: quoteItemFields({}), rowFields: quoteItemFields, initialRows: 1, maxRows: 200, addLabel: "Agregar producto" }),
      field("packs", "Packs", "repeat", { fields: quotePackFields({}), rowFields: quotePackFields, maxRows: 100, addLabel: "Agregar pack" }),
      select("promotionId", "Promoción aprobada (opcional)", optionsOf(approvedPromotions), false),
      field("promotionEvidence", "Evidencia de elegibilidad de promoción (si corresponde)", "textarea"),
      field("delivery", "Importe de entrega (opcional)", "amount"), field("deliverySurcharge", "Recargo de entrega explícito (opcional)", "amount"), field("productSurcharge", "Recargo de producto explícito (opcional)", "amount"),
      ...(hasCapability(context, "prices.approve") ? [field("surchargeOverrideReason", "Motivo para reemplazar los recargos (opcional)", "textarea"), field("bonus", "Bonificación autorizada (opcional)", "amount"), field("bonusReason", "Motivo de la bonificación", "textarea"), select("benefit", "Beneficio de segmento aprobado (opcional)", approvedPolicies.flatMap(policy => Object.keys(recordValue(policy.definition, "segmentBenefits") as object ?? {}).map(segment => ({ value: JSON.stringify([idOf(policy), segment]), label: `${labelOf(policy)} · ${segment}` }))), false), field("benefitEvidence", "Evidencia de elegibilidad del segmento", "textarea")] : []),
      field("deliveryPolicyEvidence", "Evidencia para cargos manuales o regla de entrega", "textarea"),
    ), v => {
      const items = repeatedValues(v, "items").filter(item => str(item, "skuId") || str(item, "quantity")).map(item => {
        const sku = catalogRows.find(sku => sku.id === str(item, "skuId"));
        if (!sku) throw new Error("Elegí un producto de catálogo para cada línea.");
        const tariff = tariffChoices.find(choice => choice.id === str(item, "tariff") && choice.tier.skuId === sku.id);
        if (!tariff && (!str(item, "manualUnitPrice") || !str(item, "manualReason"))) throw new Error("Elegí una tarifa aprobada o completá precio y motivo manuales.");
        if (!tariff && BigInt(decimal(str(item, "manualUnitPrice"), "Precio manual").replace(".", "")) <= 0n) throw new Error("El precio manual debe ser positivo. Usá una bonificación aprobada para una entrega sin cargo.");
        return { id: str(item, "entryId"), skuId: idOf(sku), quantity: quantityForUnit(str(item, "quantity"), sku.unit, "Cantidad solicitada"), ...(tariff ? { policyId: idOf(tariff.policy), scale: String(tariff.tier.scale) } : { manualUnitPrice: decimal(str(item, "manualUnitPrice"), "Precio manual"), manualReason: str(item, "manualReason") }) };
      });
      const packs = repeatedValues(v, "packs").filter(item => str(item, "packId")).map(item => {
        const pack = approvedPacks.find(pack => pack.id === str(item, "packId"));
        if (!pack || !/^[1-9]\d{0,4}$/.test(str(item, "count")) || Number(str(item, "count")) > 10000) throw new Error("Elegí un pack aprobado y una cantidad entera entre 1 y 10.000.");
        const components = Array.isArray(pack.components) ? pack.components as Row[] : [];
        return { id: str(item, "entryId"), packId: idOf(pack), count: Number(str(item, "count")), selections: Object.fromEntries(components.filter(component => component.category).map(component => {
          const skuId = str(item, `component-${idOf(component)}`);
          if (!catalogRows.some(sku => sku.id === skuId && sku.category === component.category && sku.unit === component.unit)) throw new Error("Elegí la variedad de cada componente del pack.");
          return [idOf(component), skuId];
        })) };
      });
      if (!items.length && !packs.length) throw new Error("Agregá al menos un producto o pack.");
      const policyIds = [...new Set(items.flatMap(item => "policyId" in item ? [item.policyId] : []))];
      const chargeEvidence = str(v, "deliveryPolicyEvidence").trim(), promotionEvidence = str(v, "promotionEvidence").trim();
      const benefit = str(v, "benefit") ? JSON.parse(str(v, "benefit")) as [string, string] : null;
      return { items, packs, currency: String(row.currency ?? "ARS"), paymentMethod: str(v, "paymentMethod"),
        ...(str(v, "productPaymentMethod") ? { productPaymentMethod: str(v, "productPaymentMethod") } : {}), ...(str(v, "deliveryPaymentMethod") ? { deliveryPaymentMethod: str(v, "deliveryPaymentMethod") } : {}),
        ...(str(v, "delivery") ? { deliveryMinor: amountFormToMinor(str(v, "delivery")) } : {}), ...(str(v, "deliverySurcharge") ? { deliverySurchargeMinor: amountFormToMinor(str(v, "deliverySurcharge")) } : {}), ...(str(v, "productSurcharge") ? { productSurchargeMinor: amountFormToMinor(str(v, "productSurcharge")) } : {}),
        ...(str(v, "surchargeOverrideReason") ? { surchargeOverrideReason: str(v, "surchargeOverrideReason") } : {}), ...(str(v, "promotionId") ? { promotionId: str(v, "promotionId") } : {}), promotionEligibilityEvidence: promotionEvidence ? { evidence: promotionEvidence } : {}, deliveryPolicyEvidence: chargeEvidence ? { note: chargeEvidence } : policyIds.length ? { approvedPolicyIds: policyIds } : {},
        ...(str(v, "bonus") ? { bonusDiscountMinor: amountFormToMinor(str(v, "bonus")), bonusReason: str(v, "bonusReason") } : {}), ...(benefit ? { segmentBenefit: { policyId: benefit[0], segment: benefit[1], eligibilityEvidence: note(v, "benefitEvidence") } } : {}),
      };
    }, row, "Los productos conservan su tarifa y escala seleccionadas. Packs, promociones y beneficios requieren versiones aprobadas. Cualquier recargo reemplazado exige un motivo autorizado.") });
    if (pageId === "orders" && ["draft", "preorder"].includes(String(row.commercialState)) && hasCommand(context, "OrderCancelled")) buttons.push({ label: "Cancelar borrador", onClick: () => runAction("OrderCancelled", "Cancelar pedido", fields(field("reason", "Motivo", "textarea", { required: true }), evidenceField()), v => ({ reason: str(v, "reason"), evidence: note(v) }), row) });
    if (pageId === "orders" && isConfirmedAppSheetInvoice && ["unprepared", "partially_prepared"].includes(String(row.fulfillmentState)) && hasCommand(context, "OrderLinesCancelled")) {
      const cancellableLines = (Array.isArray(row.lines) ? row.lines as Row[] : []).flatMap((line, index) => {
        const requested = scaledQuantity(line.requested);
        const prepared = scaledQuantity(line.prepared ?? "0");
        const cancelled = scaledQuantity(line.cancelled ?? "0");
        const lineId = idOf(line);
        if (!lineId || requested === null || prepared === null || cancelled === null) return [];
        const remaining = requested - prepared - cancelled;
        return remaining > 0n ? [{ line, lineId, lineNumber: index + 1, productName: visibleInvoiceLineName(line, catalogRows), remaining }] : [];
      });
      const eligibleLines = cancellableLines.filter(candidate => candidate.productName);
      const hasUnidentifiedCancellableLine = cancellableLines.some(candidate => !candidate.productName);
      if (eligibleLines.length && !hasUnidentifiedCancellableLine) {
        const correctionFields = [
          ...eligibleLines.map(({ line, lineId, lineNumber, productName, remaining }) => {
            return field(`cancel_${lineId}`, `Cantidad a corregir · renglón ${lineNumber}: ${productName}`, "decimal", { help: `Máximo todavía no preparado: ${formatScaled(remaining)} ${textValue(line.unit)}.` });
          }),
          evidenceField("Motivo y evidencia de la corrección"),
        ];
        buttons.push({ label: "Corregir cantidades", onClick: () => runAction(
          "OrderLinesCancelled",
          "Corregir líneas de factura confirmada",
          correctionFields,
          values => {
            const lines = eligibleLines.flatMap(({ line, lineId, productName, remaining }) => {
              const raw = str(values, `cancel_${lineId}`);
              if (!raw) return [];
              const quantity = quantityForUnit(raw, line.unit, "Cantidad a corregir");
              const scaled = scaledQuantity(quantity);
              if (scaled === null || scaled > remaining) throw new Error(`La cantidad para ${productName} supera lo que todavía no se preparó.`);
              return [{ lineId, quantity }];
            });
            if (!lines.length) throw new Error("Ingresá al menos una cantidad a corregir.");
            return { lines, evidence: note(values) };
          },
          row,
          "Sólo permite cancelar cantidades todavía no preparadas antes del despacho. No cambia cobros ni registra un reembolso; cualquier devolución de dinero es un paso separado.",
        ) });
      } else if (hasUnidentifiedCancellableLine) {
        buttons.push({ label: "Corrección pausada", onClick: () => onNotice("No se puede corregir esta factura hasta identificar con nombre visible todos los productos todavía no preparados. No se aceptan identificadores de producto en lugar del nombre.") });
      }
    }
    if (pageId === "orders" && !isAppSheetInvoice && ["draft", "preorder"].includes(String(row.commercialState)) && Number(row.quoteVersion) > 0 && hasCommand(context, "OrderConfirmed")) buttons.push({ label: "Confirmar pedido", onClick: () => runAction("OrderConfirmed", "Confirmar cotización aceptada", fields(field("quoteVersion", "Versión cotizada", "integer", { required: true, defaultValue: String(row.quoteVersion) }), evidenceField("Aceptación registrada")), v => ({ quoteVersion: Number.parseInt(str(v, "quoteVersion"), 10), acceptance: note(v) }), row, "La confirmación reserva stock y exige permiso operativo vigente del socio." ) });
    if (pageId === "orders" && row.commercialState === "confirmed" && ["unprepared", "partially_prepared"].includes(String(row.fulfillmentState)) && hasCommand(context, "OrderPrepared")) buttons.push({ label: "Preparar por lote", onClick: () => {
      void apiGet<Row>(`/api/operations/orders/${encodeURIComponent(id)}`).then(detail => {
        const detailOrder = objectValue(recordValue(detail, "order"));
        const detailLines = Array.isArray(detailOrder.lines) ? detailOrder.lines.filter((line): line is Row => Boolean(line) && typeof line === "object") : [];
        const lineById = new Map(detailLines.map(line => [idOf(line), line]));
        const visibleReservations = rowsOf(detail, "reservations");
        const reservationCandidates: Array<{ balance: Row; line: Row; productName: string; remaining: bigint }> = [];
        let unidentifiedPendingReservation = false;
        for (const reservation of visibleReservations) {
          const quantity = scaledQuantity(reservation.quantity), consumed = scaledQuantity(reservation.consumed);
          if (quantity === null || consumed === null || quantity < 0n || consumed < 0n || consumed > quantity) {
            unidentifiedPendingReservation = true;
            break;
          }
          if (quantity === consumed) continue;

          const lineId = textValue(reservation.lineId, "").trim();
          const line = lineById.get(lineId);
          const balance = objectValue(reservation.balance);
          const reservationBalanceId = textValue(reservation.balanceId, "").trim();
          const balanceId = idOf(balance);
          const balanceSkuId = textValue(balance.skuId, "").trim();
          const balanceUnit = textValue(balance.unit, "").trim();
          const lotId = textValue(balance.lotId, "").trim();
          const lotLabel = textValue(balance.lotLabel, "").trim();
          const lineSkuId = textValue(line?.skuId, "").trim();
          const lineUnit = textValue(line?.unit, "").trim();
          const metadataMatchesLine = Boolean(line && lineId && reservationBalanceId && balanceId === reservationBalanceId
            && balanceSkuId && balanceSkuId === lineSkuId && balanceUnit && balanceUnit === lineUnit && lotId && lotLabel);
          const productName = line
            ? visibleInvoiceLineName(line, catalogRows) || (metadataMatchesLine ? textValue(balance.skuName, "").trim() : "")
            : "";
          if (!metadataMatchesLine || !productName) {
            unidentifiedPendingReservation = true;
            break;
          }
          reservationCandidates.push({ balance, line: line!, productName, remaining: quantity - consumed });
        }
        if (unidentifiedPendingReservation) {
          onNotice("La preparación queda pausada: una reserva pendiente no tiene nombre, lote o unidad verificables, o no coincide con el renglón. Actualizá el pedido y el stock antes de continuar.");
          return;
        }
        if (!reservationCandidates.length) { onNotice("No hay reservas pendientes visibles para preparar. Actualizá stock y el pedido."); return; }
        const reservations = reservationCandidates;
        runAction("OrderPrepared", "Preparar pedido con lote y peso real", [
          ...reservations.flatMap((entry, index) => [
            field(`requested-${index}`, `Cantidad reservada · ${entry.productName} · ${textValue(entry.balance.lotLabel)}`, "decimal", { defaultValue: formatScaled(entry.remaining), help: `${textValue(entry.line.unit)}. Para una preparación parcial, reducí esta cantidad; cero deja la reserva pendiente.` }),
            field(`actual-${index}`, `Peso real · ${entry.productName}`, "decimal", { defaultValue: formatScaled(entry.remaining), help: "Incluí el excedente físico. No modifica el importe confirmado." }),
          ]), evidenceField("Evidencia de preparación"),
        ], v => ({ allocations: reservations.flatMap((entry, index) => {
          const requestedQuantity = quantityForUnit(str(v, `requested-${index}`), entry.line.unit, "Cantidad reservada", true);
          if (scaledQuantity(requestedQuantity) === 0n) return [];
          return [{ lineId: idOf(entry.line), lotId: String(entry.balance.lotId), balanceId: idOf(entry.balance), requestedQuantity, actualQuantity: quantityForUnit(str(v, `actual-${index}`), entry.line.unit, "Peso real") }];
        }), evidence: note(v) }), row, "Las reservas indican el lote asignado. El peso real consume existencias y se conserva para la entrega y el costo.");
      }).catch(error => onNotice(error instanceof Error ? error.message : "No pudo cargarse la reserva."));
    } });
    if (pageId === "orders" && row.channel === "local" && row.commercialState === "confirmed" && ["prepared", "partially_delivered", "dispatched"].includes(String(row.fulfillmentState)) && hasCommand(context, "LocalPickupCompleted")) {
      const lines = (Array.isArray(row.lines) ? row.lines as Row[] : []).flatMap((line, index) => {
        const remaining = (scaledQuantity(line.requested) ?? 0n) - (scaledQuantity(line.delivered) ?? 0n) - (scaledQuantity(line.cancelled) ?? 0n);
        const productName = visibleInvoiceLineName(line, catalogRows);
        return remaining > 0n ? [{ line, index, remaining, productName }] : [];
      });
      if (lines.length && lines.every(line => line.productName)) buttons.push({ label: "Completar retiro", onClick: () => {
        runAction("LocalPickupCompleted", "Registrar retiro y cantidades físicas", [
          ...lines.flatMap(({ line, index, remaining, productName }) => [
            field(`quantity-${index}`, `Cantidad entregada · renglón ${index + 1}: ${productName}`, "decimal", { defaultValue: formatScaled(remaining) }),
            field(`actual-${index}`, `Cantidad física · renglón ${index + 1}: ${productName}`, "decimal", { required: true, help: "Registrá el peso que efectivamente retira el socio, incluido el excedente preparado." }),
          ]), evidenceField("Evidencia del retiro"),
        ], v => ({ lines: lines.flatMap(({ line, index }) => {
          const quantity = quantityForUnit(str(v, `quantity-${index}`), line.unit, "Cantidad entregada", true);
          return scaledQuantity(quantity) === 0n ? [] : [{ lineId: idOf(line), quantity, actualQuantity: quantityForUnit(str(v, `actual-${index}`), line.unit, "Cantidad física") }];
        }), evidence: note(v) }), row);
      } });
      else if (lines.length) buttons.push({ label: "Retiro pausado", onClick: () => onNotice("No se puede registrar el retiro hasta identificar con nombre visible todos los productos pendientes. Cargá las páginas faltantes del catálogo o revisá si algún producto está inactivo.") });
    }
    const refundBalance = typeof row.verifiedMinor === "string" && typeof row.refundedMinor === "string" && /^\d+$/.test(row.verifiedMinor) && /^\d+$/.test(row.refundedMinor) ? BigInt(row.verifiedMinor) - BigInt(row.refundedMinor) : 0n;
    const refundAccounts = accountRows.filter(account => account.currency === row.currency && typeof account.balanceMinor === "string" && /^-?\d+$/.test(account.balanceMinor));
    if (pageId === "orders" && ["confirmed", "cancelled"].includes(String(row.commercialState)) && refundBalance > 0n && refundAccounts.length > 0 && hasCommand(context, "OrderRefunded")) buttons.push({ label: "Preparar reintegro", onClick: () => runAction("OrderRefunded", "Asignar cada parte del reintegro", fields(select("accountId", "Cuenta conciliada · misma moneda", optionsOf(refundAccounts, ["name", "id"])), field("lines", "Importes por línea · una por renglón: ID de línea | importe", "textarea", { help: "Usá los identificadores mostrados en el detalle del pedido. Dejá afuera entrega y recargos." }), field("delivery", "Parte de entrega", "amount", { defaultValue: "0" }), field("surcharge", "Parte de recargos", "amount", { defaultValue: "0" }), field("reason", "Motivo", "textarea", { required: true }), evidenceField()), v => refundAllocation(v), row, "El total se calcula sumando las líneas, entrega y recargos; no se admite un importe global sin asignación." ) });
    if (pageId === "orders" && ["dispatched", "partially_delivered", "delivered"].includes(String(row.fulfillmentState)) && hasCommand(context, "OrderReturnInspected")) buttons.push({ label: "Inspeccionar devolución", onClick: () => setReturnOrderId(id) });
    if (pageId === "accounts" && !row.verified && hasCommand(context, "AccountVerified")) buttons.push({ label: "Verificar cuenta", onClick: () => runAction("AccountVerified", "Verificar titularidad de la cuenta", fields(evidenceField("Evidencia de titularidad")), v => ({ evidence: note(v) }), row, "La verificación no inventa un saldo inicial." ) });
    if (pageId === "accounts") {
      buttons.push({ label: "Ver movimientos", onClick: () => setLedgerAccountId(id) });
      buttons.push({ label: "Ver conciliaciones", onClick: () => setReconciliationAccountId(id) });
      if (row.verified === true && row.openingApprovedBy && hasCommand(context, "AccountReconciled")) buttons.push({
        label: "Conciliar saldo",
        onClick: () => {
          setReconciliationAccountId(id);
          reconcileAccount(row);
        },
      });
    }
    if (pageId === "members") buttons.push({ label: "Ficha e historial", onClick: () => setSelectedMemberId(id) });
    if (pageId === "accounts" && row.verified && !row.openingApprovedBy && hasCommand(context, "AccountOpeningApproved")) buttons.push({ label: "Aprobar apertura", onClick: () => runAction(
      "AccountOpeningApproved", "Aprobar saldo de apertura con dos personas", fields(
        field("amount", "Saldo de apertura conocido", "amount", { required: true }),
        userRows.length ? select("preparedBy", "Preparó el saldo (otra persona activa)", optionsOf(userRows.filter(user => user.id !== context.userId), ["name", "id"])) : field("preparedBy", "UUID de otra persona activa que preparó el saldo", "text", { required: true }),
        ...(context.authority.cutoverProfile === "appsheet-replacement" ? [field("sourceRecordId", "ID de fila histórica AppSheet vinculada", "text", { required: true, help: "La apertura debe enlazar una fila histórica revisada del mismo corte." })] : []),
        evidenceField("Evidencia de apertura"),
      ), v => ({ amountMinor: amountFormToMinor(str(v, "amount")), preparedBy: str(v, "preparedBy"), ...(context.authority.cutoverProfile === "appsheet-replacement" ? { sourceRecordId: str(v, "sourceRecordId") } : {}), evidence: note(v) }),
      row, "El saldo seguirá desconocido hasta que esta apertura sea aprobada por una persona distinta de quien la preparó." ) });
    if (pageId === "accounts" && row.openingApprovedBy && hasCommand(context, "AccountTransferred")) buttons.push({ label: "Transferir", onClick: () => runAction("AccountTransferred", "Transferir entre cuentas", fields(select("toAccountId", "Cuenta de destino en la misma moneda", optionsOf(accountRows.filter(a => a.id !== id && a.currency === row.currency), ["name", "id"])), field("amount", "Importe", "amount", { required: true }), field("reason", "Concepto", "textarea", { required: true })), v => ({ toAccountId: str(v, "toAccountId"), amountMinor: amountFormToMinor(str(v, "amount")), reason: str(v, "reason") }), row, "Un depósito de efectivo en banco se registra como una transferencia separada y evidenciada." ) });
    if (pageId === "collections" && row.status === "reported" && hasCommand(context, "CollectionVerified")) buttons.push({ label: "Verificar recepción", onClick: () => runAction("CollectionVerified", "Verificar recepción bancaria o de caja", fields(
      select("accountId", "Cuenta donde se recibió físicamente", optionsOf(accountRows.filter(account => account.currency === row.currency && (row.method === "cash" ? row.custodianId ? account.kind === "custody" && account.custodianId === row.custodianId : account.kind === "cash" : account.kind === "bank")), ["name", "id"])),
      field("exchangeRate", "Tasa aprobada · ARS por 1 USD", "decimal", { help: "Para aplicar un pago a una deuda en otra moneda, ingresá siempre cuántos ARS equivalen a 1 USD." }),
      select("excessTreatment", "Tratamiento de un excedente", [{ value: "member_credit", label: "Crédito del socio" }, { value: "refund_due", label: "Dinero por devolver" }]), evidenceField("Evidencia de recepción"),
    ), v => ({ accountId: str(v, "accountId"), excessTreatment: str(v, "excessTreatment"), ...(str(v, "exchangeRate") ? { exchangeRate: decimal(str(v, "exchangeRate"), "Tasa") } : {}), evidence: note(v) }), row, "Verificá dónde se recibió realmente el dinero. La custodia del repartidor se rinde después." ) });
    if (pageId === "collections" && row.status === "reported" && hasCommand(context, "CollectionReportRejected")) buttons.push({ label: "Rechazar aviso", onClick: () => runAction("CollectionReportRejected", "Rechazar aviso de cobro", fields(field("reason", "Motivo del rechazo", "textarea", { required: true }), evidenceField("Evidencia del rechazo")), v => ({ reason: str(v, "reason"), evidence: note(v) }), row, "Este paso resuelve el aviso reportado y no crea un asiento financiero." ) });
    if (pageId === "collections" && row.status === "verified" && hasCommand(context, "CollectionVerificationReversed")) buttons.push({ label: "Corregir verificación", onClick: () => runAction("CollectionVerificationReversed", "Corregir cobro verificado", fields(field("reason", "Motivo de la corrección", "textarea", { required: true }), evidenceField("Evidencia de la corrección")), v => ({ reason: str(v, "reason"), evidence: note(v) }), row, "Se registra una corrección forward-only. El servidor la rechaza si hay crédito utilizado, reintegros posteriores o fondos que ya salieron de la cuenta original." ) });
    if (pageId === "access" && row._kind === "device" && row.storageCertified !== true && !row.revokedAt && hasCommand(context, "DeviceCertified")) buttons.push({ label: "Registrar prueba manual", onClick: () => runAction("DeviceCertified", "Registrar resultado de prueba manual", fields(evidenceField("Evidencia de persistencia y reinicio del dispositivo")), v => ({ storageCertified: true, evidence: note(v) }), row, "Completá primero una prueba manual de persistencia y reinicio. Este registro sólo conserva la evidencia; no ejecuta la prueba." ) });
    if (pageId === "payables" && !row.verified && hasCommand(context, "PayableVerified")) {
      const payableEvidence = recordValue(row, "evidence");
      const priorTreatment = textValue(recordValue(payableEvidence, "costTreatment"), "");
      const treatmentOptions = [{ value: "variable", label: "Variable · se descuenta en el mes devengado" }, { value: "fixed", label: "Fijo · se informa por separado" }];
      buttons.push({ label: "Verificar obligación", onClick: () => runAction("PayableVerified", "Verificar obligación y devengamiento", fields(
        field("accrualPeriod", "Período de devengamiento · YYYY-MM", "month", { required: true, defaultValue: typeof row.accrualPeriod === "string" ? row.accrualPeriod : undefined, help: "Confirmá el mes al que corresponde la obligación, no la fecha de pago." }),
        ...(row.kind === "operating_expense" ? [field("costTreatment", "Tratamiento del gasto", "select", { required: true, options: treatmentOptions, defaultValue: priorTreatment === "variable" || priorTreatment === "fixed" ? priorTreatment : undefined, help: "La clasificación es necesaria para separar costos variables y fijos." })] : []),
        evidenceField("Evidencia de verificación"),
      ), v => ({ accrualPeriod: accrualPeriodValue(v), ...(row.kind === "operating_expense" ? { costTreatment: str(v, "costTreatment") } : {}), evidence: note(v) }), row, "La verificación conserva evidencia. La obligación no se reconoce en la contribución hasta tener período y tratamiento confirmados." ) });
    }
    if (pageId === "payables" && row.verified && String(row.paidMinor ?? "0") !== String(row.amountMinor ?? "") && hasCommand(context, "PayablePaid")) buttons.push({ label: "Registrar pago", onClick: () => runAction("PayablePaid", "Pagar obligación desde una cuenta conciliada", fields(select("accountId", "Cuenta de pago", optionsOf(accountRows.filter(a => a.currency === row.currency && typeof a.balanceMinor === "string"), ["name", "id"])), field("amount", "Importe", "amount", { required: true }), field("date", "Fecha", "date", { required: true, defaultValue: localDate() }), evidenceField()), v => ({ accountId: str(v, "accountId"), amountMinor: amountFormToMinor(str(v, "amount")), date: str(v, "date"), evidence: note(v) }), row) });
    if (pageId === "tasks" && row.status !== "completed" && hasCommand(context, "TaskCompleted")) buttons.push({ label: "Completar", onClick: () => runAction("TaskCompleted", "Completar tarea", fields(evidenceField()), v => ({ evidence: note(v) }), row) });
    if (pageId === "commercial") {
      const kind = String(row._kind ?? "");
      const mapping: Record<string, [string, string]> = { policies: ["PricePolicyApproved", "Aprobar tarifa"], packs: ["PackApproved", "Aprobar pack"], promotions: ["PromotionApproved", "Aprobar promoción"] };
      const pair = mapping[kind];
      if (pair && row.status === "draft" && hasCommand(context, pair[0])) buttons.push({ label: pair[1], onClick: () => runAction(pair[0], pair[1], fields(evidenceField()), v => ({ evidence: note(v) }), row, "La aprobación es manual y conserva la evidencia de la persona revisora." ) });
    }
    if (pageId === "configuration" && row.kind !== "period_coverage" && row.state === "proposed" && hasCommand(context, "ConfigurationApproved")) buttons.push({ label: "Aprobar versión", onClick: () => runAction("ConfigurationApproved", "Aprobar configuración propuesta", fields(evidenceField()), v => ({ evidence: note(v) }), row, "Las versiones aprobadas quedan inmutables; un cambio requiere otra propuesta." ) });
    const needsCaptureBoundRereview = pageId === "gates" && selectedCutoverProfile === "appsheet-replacement"
      && row.status === "approved" && !gateMatchesSelectedCapture(row);
    if (pageId === "gates" && (row.status !== "approved" || needsCaptureBoundRereview) && hasCommand(context, "CutoverGateReviewed")
      && !(selectedCutoverProfile === "appsheet-replacement" && id === "legacy-writes-disabled")) buttons.push({ label: "Revisar habilitación", onClick: () => {
        if (selectedCutoverProfile === "appsheet-replacement" && !selectedCutoverCaptureId) { onNotice("Elegí una captura antes de revisar controles del reemplazo de AppSheet."); return; }
        const finalDeltaFields = selectedCutoverProfile === "appsheet-replacement" && id === "final-delta-reconciled" ? [
          field("manualPauseStartedAt", "Inicio de la pausa manual de AppSheet", "datetime-local", { required: true, help: "La captura seleccionada debe comenzar después de esta fecha y hora." }),
          field("manualPauseEndedAt", "Fin de la pausa (si ya ocurrió)", "datetime-local", { help: "Dejalo vacío si AppSheet sigue pausado; no registra por sí solo que la pausa ocurrió." }),
          field("manualPauseEvidenceRef", "Referencia verificable de la pausa", "text", { required: true, help: "Indicá una referencia específica que otra persona pueda revisar." }),
          field("expectedHandoffChangesRef", "Referencia separada para cambios del legado", "text", { required: true, help: "Los cambios posteriores permanecen separados para revisión." }),
        ] : [];
        runAction("CutoverGateReviewed", "Registrar revisión humana de la habilitación", fields(
          userRows.length ? select("authorId", "Persona autora de la evidencia", optionsOf(userRows.filter(user => user.id !== context.userId), ["name", "id"])) : field("authorId", "UUID de la persona autora (distinta del revisor)", "text", { required: true }),
          evidenceField("Evidencia revisada"), ...finalDeltaFields,
        ), v => ({
          gateId: id, cutoverProfile: selectedCutoverProfile,
          ...(selectedCutoverProfile === "appsheet-replacement" ? { captureId: selectedCutoverCaptureId } : {}),
          authorId: str(v, "authorId"), evidence: note(v),
          ...(finalDeltaFields.length ? {
            manualPauseStartedAt: localDateTimeToIso(str(v, "manualPauseStartedAt"), "Inicio de la pausa"),
            manualPauseEndedAt: str(v, "manualPauseEndedAt") ? localDateTimeToIso(str(v, "manualPauseEndedAt"), "Fin de la pausa") : null,
            manualPauseEvidenceRef: str(v, "manualPauseEvidenceRef").trim(),
            expectedHandoffChangesRef: str(v, "expectedHandoffChangesRef").trim(),
          } : {}),
        }), row, "El servidor coteja la pausa con una captura estable posterior y conserva por separado los cambios esperados del legado; esta revisión no activa autoridad." );
      } });
    if (pageId === "orders" && Number(row.quoteVersion) > 0) {
      const confirmationIndex = buttons.findIndex(button => button.label === "Confirmar pedido");
      const quoteIndex = buttons.findIndex(button => button.label === "Cotizar");
      const primaryIndex = quoteIndex >= 0 ? quoteIndex : 0;
      if (confirmationIndex > primaryIndex) {
        const [confirmation] = buttons.splice(confirmationIndex, 1);
        buttons.splice(primaryIndex, 0, confirmation);
      }
    }
    return buttons;
  };

  if (query.loading && !query.data && pageId !== "members" && pageId !== "routes") return <div className="ops-page-body"><SectionHeading eyebrow={spec.eyebrow} title={title} /><LoadingState /></div>;
  const catalogAdminWithoutStockRead = pageId === "catalog" && (hasCapability(context, "stock.adjust") || hasCapability(context, "openings.approve"));
  if (query.error && !query.data && pageId !== "members" && pageId !== "routes" && !catalogAdminWithoutStockRead) return <div className="ops-page-body"><SectionHeading eyebrow={spec.eyebrow} title={title} /><ErrorState message={query.error} retry={query.retry} /></div>;

  const headerActions = <div className="ops-header-actions">
    <button type="button" className="ops-button ops-button-quiet" onClick={onRefresh}>↻ Actualizar</button>
    {pageId === "orders" && hasCommand(context, "InvoiceSaved") && hasCapability(context, "members.read") && <>
      <button type="button" className="ops-button ops-button-primary" data-testid="appsheet-invoice-open" onClick={() => openInvoiceEditor({ mode: "invoice" })}>＋ Nueva factura</button>
      <button type="button" className="ops-button ops-button-quiet" data-testid="appsheet-preorder-open" onClick={() => openInvoiceEditor({ mode: "preorder" })}>＋ Nueva preventa</button>
    </>}
    {create.map(button => <button type="button" className="ops-button ops-button-primary" key={button.label} disabled={button.disabled} onClick={button.onClick}>{button.label}</button>)}
  </div>;
  const emptyMessages: Record<string, [string, string]> = {
    orders: ["Todavía no hay pedidos", "Los pedidos disponibles para tu cuenta van a aparecer acá."],
    catalog: ["Todavía no hay productos", "El catálogo y sus lotes de stock van a aparecer acá."],
    purchases: ["Todavía no hay compras", "Las compras y sus recepciones van a aparecer acá."],
    members: [memberSearch ? "No encontramos socios" : "Todavía no hay socios", memberSearch ? "Probá con otro nombre, correo o teléfono." : "Los socios disponibles para tu cuenta van a aparecer acá."],
  };
  const [emptyTitle, emptyDetail] = emptyMessages[pageId] ?? ["No hay registros para mostrar", "Todavía no hay registros disponibles para tu cuenta."];

  return <div className="ops-page-body">
    <SectionHeading title={title} detail={pageId === "orders" ? "Productos, cobros y entregas de cada pedido." : pageId === "accounts" ? "Cuentas por moneda. El saldo requiere una apertura conciliada." : undefined} action={headerActions} />
    {needsRenditionReferences && !renditionReferenceError && renditionReferencesLoading && <p className="ops-inline-status" role="status">Cargando cuentas y referencias para aceptar una rendición…</p>}
    {needsRenditionReferences && renditionReferenceError && <ErrorState message={renditionReferenceError} retry={canReadSettlementAccounts ? () => {
      accounts.retry();
      if (needsSettlementRoutes) settlementRoutes.retry();
      if (needsSettlementPayables) settlementPayables.retry();
    } : undefined} />}
    {needsRenditionReferences && !renditionReferencesLoading && !renditionReferenceError && !settlementHasCompatibleAccountPair && <p className="ops-inline-status" role="status">No hay una custodia y una cuenta del club con apertura aprobada en una misma moneda. Actualizá las referencias antes de aceptar una rendición.</p>}
    {["catalog", "purchases"].includes(pageId) && !context.rehearsal && context.authority.mode !== "active" && <InfoBand tone="warning" title={context.authority.mode === "shadow" ? "Circuito en sombra · habilitación pendiente" : "Autoridad del circuito por confirmar"}><p>El contexto no confirma autoridad activa. El servidor puede rechazar altas y cambios de catálogo, compras, recepciones y otros registros hasta la habilitación correspondiente. Esta pantalla no activa esa autoridad. La apertura inicial usa una regla administrativa separada y todavía requiere producto y ubicación activos, costo y una persona preparadora distinta de quien aprueba.</p></InfoBand>}
    {pageId === "catalog" && <InfoBand title="Stock disponible"><p>El stock disponible descuenta las reservas. Al preparar un pedido, elegí el lote y registrá el peso real.</p></InfoBand>}
    {pageId === "catalog" && <AppSheetCatalogue context={context} refreshKey={refreshKey} runCommand={runCommand} onRefresh={onRefresh} onNotice={onNotice} />}
    {(["catalog", "purchases"].includes(pageId) && (hasCapability(context, "stock.adjust") || hasCapability(context, "purchases.write"))) && <ManualReferenceData context={context} refreshKey={refreshKey} openAction={openAction} onNotice={onNotice} />}
    {pageId === "catalog" && <ManualStockTools context={context} refreshKey={refreshKey} openAction={openAction} onNotice={onNotice} />}
    {pageId === "orders" && <PricingReference policies={approvedPolicies} packs={approvedPacks} promotions={approvedPromotions} />}
    {pageId === "purchases" && <><PurchaseJourneyStatus context={context} /><PurchaseReference suppliers={supplierRows} catalog={catalogRows} locations={locationRows} />
      {hasCommand(context, "PurchaseOrderCreated") && !catalogRows.length && <InfoBand tone="info" title="Catálogo no disponible"><p>Para crear una compra, el perfil necesita consultar los productos y sus unidades en Inventario. No se puede registrar una línea escribiendo identificadores.</p></InfoBand>}
      {hasCommand(context, "PurchaseOrderCreated") && manualReferenceData.data && !rowsOf(manualReferenceData.data, "suppliers").some(row => row.active === true) && <InfoBand tone="info" title="Sin proveedores activos"><p>Creá o activá un proveedor desde Referencias de compras antes de iniciar el acuerdo.</p></InfoBand>}
      {hasCommand(context, "PurchaseOrderCreated") && manualReferenceData.error && <InfoBand tone="warning" title="No se pudieron cargar proveedores"><p>La creación de compras queda pausada hasta cargar proveedores activos con nombre visible.</p></InfoBand>}
      {hasCommand(context, "GoodsReceived") && !locationReferencesReady && <InfoBand tone="warning" title="Recepción pausada: falta una ubicación visible"><p>Para registrar una recepción se necesita una ubicación activa dentro del alcance de este perfil. No se aceptan identificadores escritos a mano. Consultá las referencias o pedí que agreguen la ubicación a tu alcance.</p></InfoBand>}
      {purchasesBlockedByCatalog.length > 0 && <InfoBand tone="warning" title="Recepción pausada: no se pudieron validar las líneas pendientes"><p>{!needsCatalogChoices
        ? "Este perfil no puede consultar el catálogo activo. Se necesita stock.read o orders.write para validar los productos antes de recibirlos."
        : catalogChoices.error
          ? "No se pudo cargar el catálogo activo; las recepciones quedan pausadas hasta reintentar la consulta."
          : catalogChoices.loading
            ? "El catálogo todavía se está cargando o actualizando; las recepciones se habilitan cuando todas las líneas tengan un producto activo, con nombre y unidad coincidente."
            : !purchaseCatalogReady
              ? "No hay una respuesta vigente del catálogo. Actualizá la vista y comprobá la consulta antes de recibir."
              : catalogChoices.hasMore
                ? "La página cargada no identifica todas las líneas pendientes. Cargá más productos para validar sus nombres y unidades."
                : "Una línea pendiente no se pudo validar: debe tener cantidad y renglón válidos, además de un producto activo con nombre y unidad coincidentes. Revisá la compra, las recepciones y el catálogo antes de continuar."}</p>
        {needsCatalogChoices && catalogChoices.hasMore && !catalogChoices.loading && !catalogChoices.error && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={catalogChoices.loadMore}>Cargar más productos para validar líneas pendientes</button>}
        {needsCatalogChoices && catalogChoices.error && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={catalogChoices.retry}>Reintentar catálogo</button>}
      </InfoBand>}
    </>}
    {pageId === "gates" && <InfoBand tone="warning" title="Activar autoridad exige una revisión completa"><p>El servidor exige {replacementGateIds.length} controles del perfil seleccionado, cada uno con autor y revisor distintos y activos, además de evidencia verificable de captura e historia para AppSheet. La activación requiere evidencia humana explícita y el servidor vuelve a validar esas condiciones al registrar el cambio.</p></InfoBand>}
    {pageId === "accounts" && <InfoBand title="Saldo desconocido hasta una apertura conciliada"><p>Crear o verificar la titularidad no asigna saldo. Efectivo reportado se verifica en caja o custodia; el depósito bancario es una transferencia independiente.</p></InfoBand>}
    {pageId === "collections" && <InfoBand title="Reporte y verificación son pasos separados"><p>Un cobro reportado no modifica una cuenta. Verificá la recepción en caja/custodia para efectivo o en banco para transferencia, Mercado Pago o tarjeta.</p></InfoBand>}
    {pageId === "payables" && <InfoBand title="Devengamiento y clasificación antes del objetivo"><p>Indicá el mes YYYY-MM al que corresponde cada obligación. Un gasto operativo requiere clasificación variable o fija y verificación; si falta cualquiera de esos datos, la contribución frente al objetivo queda desconocida o sin avance.</p>{pendingManagementPayables.length > 0 && <p>{pendingManagementPayables.length} obligaciones variables o gastos operativos visibles siguen pendientes de verificación, período o clasificación.</p>}</InfoBand>}
    {pageId === "collections" && recordValue(query.data, "pendingScopeRequired") === true && <InfoBand tone="warning" title="Falta alcance para revisar cobros sin cuenta"><p>Este perfil ve las cuentas asignadas, pero los cobros reportados que todavía no tienen cuenta requieren además socios o custodios asignados. En Accesos, agregá esos identificadores al alcance financiero antes de revisar esos avisos.</p></InfoBand>}
    {pageId === "commercial" && <CommercialMarginPreview packs={rowsOf(query.data, "packs")} />}
    {pageId === "members" && <div className="ops-list-controls"><label className="ops-list-filter"><span>Buscar socio</span><input type="search" value={memberSearch} onChange={event => setMemberSearch(event.target.value)} placeholder="Nombre, correo o teléfono" /></label>{memberSearch && <button type="button" className="ops-button ops-button-quiet" onClick={() => setMemberSearch("")}>Borrar búsqueda</button>}<p className="ops-list-filter-count" role="status">La búsqueda consulta nombre, correo y teléfono de los socios dentro del alcance del perfil.</p></div>}
    {pageId === "access" && profileOptions.length === 0 && hasCommand(context, "AccessGranted") && <InfoBand tone="warning" title="No se pudieron cargar los perfiles vigentes"><p>La lista de perfiles debe venir del servidor para poder conceder acceso. Actualizá Accesos y verificá la respuesta publicada antes de asignar un perfil.</p></InfoBand>}
    {pageId === "access" && <InfoBand title="La certificación del dispositivo requiere una prueba humana"><p>Probá manualmente la persistencia y el reinicio antes de registrar el resultado. La consola sólo guarda la evidencia y no certifica el dispositivo de forma automática.</p></InfoBand>}
    {pageId === "gates" && audit.error && <InfoBand tone="info" title="Auditoría"><p>El historial general requiere permisos de gestión de accesos. {audit.error}</p></InfoBand>}
    {pageId === "gates" && <section className="ops-sheet" aria-label="Activación de autoridad">
      <SectionHeading eyebrow="Autoridad del circuito" title="Activar autoridad" detail="La acción queda disponible sólo cuando el servidor confirma todos los requisitos vigentes." />
      <div className="ops-dialog-fields" aria-label="Perfil y captura del corte">
        <label className="ops-field"><span>Perfil del corte</span><select value={selectedCutoverProfile} onChange={event => setSelectedCutoverProfile(event.target.value as "legacy" | "appsheet-replacement")}><option value="appsheet-replacement">Reemplazo verificado de AppSheet</option><option value="legacy">Perfil legado compatible</option></select></label>
        {selectedCutoverProfile === "appsheet-replacement" && <label className="ops-field"><span>Captura AppSheet registrada</span><select value={selectedCutoverCaptureId} onChange={event => setSelectedCutoverCaptureId(event.target.value)}><option value="">Elegí una captura</option>{captureRows.map(capture => {
          const stability = objectValue(capture.stability);
          const captureId = textValue(capture.captureId, "");
          return <option key={captureId} value={captureId}>{captureId || "Captura sin identificador"} · {stability.stable === true ? "estable según captura" : "estabilidad no confirmada"} · {textValue(capture.dataPageCount, "?")} páginas</option>;
        })}</select></label>}
      </div>
      {selectedCutoverProfile === "appsheet-replacement" && <InfoBand tone="warning" title="AppSheet permanece intacto"><p>Bombo será la autoridad elegida; los cambios posteriores del legado quedan separados para revisión. La selección de una captura no certifica su integridad ni completa las revisiones humanas.</p>{selectedCapture && <p>Captura {textValue(selectedCapture.captureId, "ID no disponible")} · {selectedCaptureStable ? "lectura estable según sus metadatos" : "sin estabilidad completa"} · {textValue(selectedCapture.dataSheetCount, "?")} hojas · {textValue(selectedCapture.dataPageCount, "?")} páginas · {textValue(selectedCapture.dataRecordCount, "?")} filas con datos · {textValue(selectedCapture.dataFormulaCount, "?")} fórmulas · {textValue(selectedCapture.dataUnresolvedFormulaCount, "?")} resultados pendientes.</p>}</InfoBand>}
      {gates.loading && <LoadingState label="Consultando estado de autoridad…" />}
      {gates.error && <ErrorState message={`No se pudo confirmar el estado vigente de la autoridad. ${gates.error}`} retry={gates.retry} />}
      {!gates.loading && !gates.error && gates.data && serverAuthorityMode === "active" && <InfoBand title="La autoridad ya figura activa en el servidor"><p>Estado leído desde la respuesta vigente de Habilitación y auditoría. Suspenderla pasa el circuito a sombra y conserva las operaciones, las aprobaciones, la captura y la fecha de primera escritura.</p>{context.isOwner && hasCapability(context, "cutover.approve") && hasCommand(context, "AuthoritySuspended") && <ActionButton quiet onClick={suspendAuthority}>Suspender autoridad</ActionButton>}</InfoBand>}
      {!gates.loading && !gates.error && gates.data && serverAuthorityMode !== "active" && <>
        <p><StatusTag tone={approvedGateCount === replacementGateIds.length ? "good" : "warn"}>{approvedGateCount} de {replacementGateIds.length} controles aprobados</StatusTag></p>
        {access.loading && <LoadingState label="Comprobando si autores y revisores siguen activos…" />}
        {access.error && <ErrorState message={`No se pudo comprobar el estado activo de autores y revisores. ${access.error}`} retry={access.retry} />}
        {!canActivateAuthority && <InfoBand tone="warning" title="Activación pausada"><p>{authorityActivationBlocker ?? "Actualizá el estado de autoridad antes de continuar."}</p></InfoBand>}
        {canActivateAuthority && <div className="ops-heading-action"><ActionButton onClick={activateAuthority}>Activar autoridad</ActionButton></div>}
      </>}
      <InfoBand tone={operationalApprovalConfigured ? "info" : "warning"} title="Habilitación del servidor para escrituras reales">
        <p>{operationalApprovalConfigured
          ? "El servidor confirma que está habilitado para operar. Las escrituras reales también requieren que la autoridad quede activa y que cada comando supere sus validaciones."
          : "El servidor aún no está habilitado para activar autoridad y aceptar escrituras reales. Esta pantalla no cambia esa habilitación."}</p>
      </InfoBand>
    </section>}
    {pageId === "gates" && query.data && <ReplacementReadiness context={context} cutoverProfile={selectedCutoverProfile} capture={selectedCapture} gates={rowsOf(gates.data, "gates")} stale={gates.loading || Boolean(gates.error)} />}
    {pageId === "accounts" && query.data && <AccountSetup context={context} snapshot={query.data} loading={query.loading} snapshotError={query.error} runCommand={runCommand} onRefresh={onRefresh} onNotice={onNotice} />}
    {needsCatalogChoices && catalogChoices.loading && !catalogChoices.data && <LoadingState label="Cargando productos para los selectores…" />}
    {needsCatalogChoices && catalogChoices.error && <ErrorState message={catalogChoices.error} retry={catalogChoices.retry} />}
    {pageId === "payables" && hasCapability(context, "purchases.write") && payablePurchases.loading && !payablePurchases.data && <LoadingState label="Cargando compras para registrar deudas vinculadas…" />}
    {pageId === "payables" && hasCapability(context, "purchases.write") && payablePurchases.error && <ErrorState message={`No se pudieron cargar compras para el vínculo de deuda. ${payablePurchases.error}`} retry={payablePurchases.retry} />}
    {pageId === "payables" && hasCapability(context, "purchases.write") && payablePurchases.data && !payablePurchases.loading && !payablePurchases.error && payablePurchaseRows.length === 0 && <InfoBand tone="info" title="Sin compras para vincular"><p>No hay compras vigentes disponibles en la lista cargada. Las deudas históricas sin vínculo se registran por separado con evidencia.</p></InfoBand>}
    {query.loading && query.data && <p className="ops-inline-status" role="status">Actualizando datos · las acciones están temporalmente bloqueadas.</p>}
    {query.loading && !query.data ? <section className="ops-sheet"><LoadingState label={pageId === "members" ? "Buscando socios…" : "Cargando registros…"} /></section> : query.error && !query.data ? <section className="ops-sheet"><ErrorState message={query.error} retry={query.retry} /></section> : mainRows.length ? gateRecordsDisclosure(pageId === "gates", <ListTable key={pageId} title={`${title} · ${displayRows.length}`} rows={displayRows} columns={columnsByPage[pageId] ?? [["id", "Identificador"], ["status", "Estado"]]} compactRows={pageId === "accounts"} showFilter={pageId !== "members"} searchValue={pageId === "members" ? undefined : tableSearch} onSearchChange={pageId === "members" ? undefined : updateTableSearch} onClearSearch={pageId === "members" ? undefined : () => updateTableSearch("")} hasMore={query.hasMore} renderActions={pageId === "routes" ? undefined : row => {
      const buttons = actionButtonsFor(row);
      return <ProgressiveActionElements alwaysDisclose={pageId === "accounts"} actions={buttons.map(item => <button key={item.label} type="button" className="ops-button ops-button-quiet ops-button-small" disabled={query.loading || Boolean(query.error)} onClick={item.onClick}>{item.label}</button>)} emptyMessage={<span className="ops-review-pending">Sin acciones disponibles</span>} />;
    }} />) : pageId === "routes" ? null : <section className="ops-sheet"><EmptyState title={pageId === "members" && memberSearch.trim() ? "No encontramos socios" : tableSearch.trim() ? "No hay coincidencias" : emptyTitle} detail={pageId === "members" && memberSearch.trim() ? "Probá con otro nombre, correo o teléfono o borrá la búsqueda para volver a ver los socios disponibles." : tableSearch.trim() ? "No hay registros para ese texto. Borrá la búsqueda para volver a ver la lista." : emptyDetail} action={(pageId === "members" && memberSearch.trim() || tableSearch.trim()) ? <button type="button" className="ops-button ops-button-quiet" onClick={() => pageId === "members" ? setMemberSearch("") : updateTableSearch("")}>Borrar búsqueda</button> : undefined} /></section>}
    {query.error && query.data && <ErrorState message={`${pageId === "routes" ? "No se pudieron actualizar los turnos; se conservan los datos anteriores y las acciones están pausadas." : "No se pudo cargar la página siguiente."} ${query.error}`} retry={query.retry} />}
    {pageId === "members" && query.hasMore && <button type="button" className="ops-button ops-button-quiet" onClick={query.loadMore} disabled={query.loading}>Cargar más socios</button>}
    {pageId === "routes" && query.hasMore && <button type="button" className="ops-button ops-button-quiet" onClick={query.loadMore} disabled={query.loading || Boolean(query.error)}>Cargar más entregas pendientes</button>}
    {pageId === "orders" && query.hasMore && <button type="button" className="ops-button ops-button-quiet" onClick={query.loadMore} disabled={query.loading}>Cargar más pedidos</button>}
    {pageId === "purchases" && query.hasMore && <button type="button" className="ops-button ops-button-quiet" onClick={query.loadMore} disabled={query.loading}>Cargar más compras</button>}
    {pageId === "catalog" && query.hasMore && <button type="button" className="ops-button ops-button-quiet" onClick={query.loadMore} disabled={query.loading}>Cargar más productos</button>}
    {pageId === "payables" && payablePurchases.hasMore && <button type="button" className="ops-button ops-button-quiet" onClick={payablePurchases.loadMore} disabled={payablePurchases.loading || Boolean(payablePurchases.error)}>Cargar más compras para vincular</button>}
    {needsCatalogChoices && catalogChoices.hasMore && !(pageId === "purchases" && purchasesBlockedByCatalog.length > 0) && <button type="button" className="ops-button ops-button-quiet" onClick={catalogChoices.loadMore} disabled={catalogChoices.loading}>Cargar más productos para selectores</button>}
    {pageId === "catalog" && hasCommand(context, "StockMoved") && stockBalanceRows.length > 0 && !movementReferencesReady && <InfoBand tone="warning" title="Traslados pausados: faltan referencias visibles"><p>Para trasladar stock se necesitan ubicaciones y personas custodio activas dentro del alcance. La acción queda oculta hasta que cargue la lista completa; no se aceptan códigos manuales.</p></InfoBand>}
    {pageId === "catalog" && stockCounts.loading && <section className="ops-sheet"><LoadingState label="Cargando conteos de stock…" /></section>}
    {pageId === "catalog" && stockCounts.error && <section className="ops-sheet"><SectionHeading eyebrow="Inventario" title="Conteos de stock" /><ErrorState message={stockCounts.error} retry={stockCounts.retry} /></section>}
    {pageId === "catalog" && stockCountRows.length > 0 && <ListTable title={`Conteos de stock · ${stockCountRows.length}`} rows={stockCountRows} columns={[["balanceLabel", "Producto · lote · ubicación"], ["recordedQuantity", "Registrado"], ["countedQuantity", "Contado"], ["unit", "Unidad"], ["countedByLabel", "Contó"], ["status", "Estado"]]} renderActions={row => {
      const actions = stockCountActionsFor(row);
      if (actions.length) return <ProgressiveActionElements actions={actions.map(item => <button key={item.label} type="button" className="ops-button ops-button-quiet ops-button-small" disabled={stockCounts.loading || Boolean(stockCounts.error) || query.loading || Boolean(query.error)} onClick={item.onClick}>{item.label}</button>)} />;
      if (row.status === "pending" && row.countedBy === context.userId) return <span className="ops-review-pending">Revisión independiente pendiente</span>;
      return row.status === "pending" ? <span className="ops-review-pending">Sin acción disponible</span> : null;
    }} />}
    {pageId === "catalog" && !stockCounts.loading && !stockCounts.error && stockCounts.data && stockCountRows.length === 0 && <p className="ops-small-note">Todavía no hay conteos de stock registrados.</p>}
    {pageId === "catalog" && stockBalanceRows.length > 0 && <ListTable title={`Saldos por lote · ${stockBalanceRows.length}`} rows={stockBalanceRows} columns={[["skuName", "Producto"], ["category", "Categoría"], ["lotLabel", "Lote"], ["quantity", "Saldo físico"], ["reserved", "Reservado"], ["availableQuantity", "Disponible para venta aprobada"], ["availabilityState", "Estado comercial"], ["availabilityReason", "Motivo comercial"], ["locationId", "Ubicación"], ["custodianId", "Custodio"]]} renderActions={row => <ProgressiveActionElements actions={stockActionsForBalance(row).map(item => <button key={item.label} type="button" className="ops-button ops-button-quiet ops-button-small" disabled={query.loading || Boolean(query.error)} onClick={item.onClick}>{item.label}</button>)} />} />}
    {pageId === "catalog" && selectedProductId && <ProductInspector skuId={selectedProductId} skuName={labelOf(catalogRows.find(sku => idOf(sku) === selectedProductId) ?? {}, ["name"])} refreshKey={refreshKey} canReadFinance={hasCapability(context, "finance.read")} onClose={() => setSelectedProductId("")} />}
    {pageId === "purchases" && rowsOf(query.data, "receipts").length > 0 && <ListTable title="Recepciones registradas" rows={rowsOf(query.data, "receipts")} columns={[["id", "Recepción"], ["purchaseId", "Compra"], ["receivedDate", "Fecha"], ["receivedBy", "Recibió"], ["items", "Lotes ingresados"]]} />}
    {pageId === "orders" && returnOrderId && <OrderReturnInspector orderId={returnOrderId} context={context} refreshKey={refreshKey} catalog={catalogRows} openAction={openAction} onClose={() => setReturnOrderId("")} onNotice={onNotice} />}
    {pageId === "accounts" && ledgerAccountId && <AccountLedger account={accountRows.find(account => idOf(account) === ledgerAccountId)} refreshKey={refreshKey} onClose={() => setLedgerAccountId("")} />}
    {pageId === "accounts" && reconciliationAccountId && <AccountReconciliations account={accountRows.find(account => idOf(account) === reconciliationAccountId)} refreshKey={refreshKey} actionsBlocked={query.loading || Boolean(query.error)} onClose={() => setReconciliationAccountId("")} onReconcile={reconcileAccount} />}
    {pageId === "members" && selectedMemberId && <MemberInspector memberId={selectedMemberId} refreshKey={refreshKey} documents={rowsOf(documents.data).filter(document => document.memberId === selectedMemberId)} catalog={catalogRows} onClose={() => setSelectedMemberId("")} />}
    {pageId === "orders" && hasCapability(context, "collections.verify") && accountRows.length === 0 && <InfoBand tone="warning" title="Falta una cuenta para devoluciones"><p>En Cuentas y saldos, necesitás una cuenta conciliada en la moneda del pedido.</p></InfoBand>}
    {pageId === "routes" && (orders.error || people.error) && <InfoBand tone="warning" title="Faltan referencias de apoyo para la vista de rutas"><p>Los turnos siguen visibles, pero algunas referencias de pedidos o repartidores pueden estar incompletas.</p>{orders.error && <ErrorState message={orders.error} retry={orders.retry} />}{people.error && <ErrorState message={people.error} retry={people.retry} />}</InfoBand>}
    {pageId === "routes" && <RoutesDetails data={query.data} context={context} runAction={runAction} deliveryPeople={deliveryPeople} catalog={catalogRows} orders={orderRows} actionsBlocked={query.loading || Boolean(query.error)} hasMore={query.hasMore} />}
    {pageId === "settlements" && <InfoBand title="Custodia y rendición"><p>Una rendición debe explicar el bruto como dinero entregado más remuneración. El pago de remuneración requiere una obligación verificada y se registra con cuentas de custodia conciliadas.</p></InfoBand>}
    {pageId === "orders" && invoiceEditor && <AppSheetInvoiceForm key={`${invoiceEditor.mode}-${idOf(invoiceEditor.order ?? {}) || "new"}`} open mode={invoiceEditor.mode} order={invoiceEditor.order} expectedVersion={invoiceEditor.expectedVersion} memberName={invoiceEditor.memberName} context={context} catalog={invoiceCatalogueRows} catalogChannel={invoiceCatalogueChannel} onCatalogChannelChange={setInvoiceCatalogueChannel} catalogLoading={invoiceCatalogue.loading} catalogError={invoiceCatalogue.error ?? undefined} retryCatalog={invoiceCatalogue.retry} loadMoreCatalog={invoiceCatalogue.loadMore} hasMoreCatalog={invoiceCatalogue.hasMore} runCommand={runCommand} onClose={closeInvoiceEditor} onSaved={(_orderId, message) => { closeInvoiceEditor(); onRefresh(); onNotice(message); }} />}
    {pageId === "orders" && invoiceTotalTrace && <InvoiceTotalTraceDialog trace={invoiceTotalTrace} onClose={() => setInvoiceTotalTrace(null)} />}
  </div>;
}

function RoutesDetails({ data, context, runAction, deliveryPeople, catalog, orders, actionsBlocked = false, hasMore = false }: { data: unknown; context: OperationsContext; runAction: (command: string, title: string, fieldsIn: ActionField[], build: (values: Record<string, string | boolean>) => JsonRecord, row?: Row, description?: string, create?: boolean) => void; deliveryPeople: Row[]; catalog: Row[]; orders: Row[]; actionsBlocked?: boolean; hasMore?: boolean }) {
  const routeRows = rowsOf(data);
  const deliveries = rowsOf(data, "deliveries");
  const unassignedDeliveries = rowsOf(data, "unassignedDeliveries");
  const routeIsOpen = (route: Row) => route.status === "planned" && route.closedWithPending !== true;
  const routeOptions = routeRows.flatMap(route => {
    if (!routeIsOpen(route) || !idOf(route) || typeof route.driverId !== "string" || !route.driverId) return [];
    const driver = deliveryPeople.find(person => idOf(person) === route.driverId);
    return [{ value: idOf(route), route, label: textValue(route.shiftDate, "Turno sin fecha") + " · " + textValue(driver?.name, "Repartidor asignado") }];
  });
  const orderFor = (delivery: Row) => orders.find(order => idOf(order) === String(delivery.orderId ?? ""));
  const orderLabel = (delivery: Row) => {
    const order = orderFor(delivery);
    const orderId = String(delivery.orderId ?? "");
    const mode = order?.channel === "local" ? "Retiro" : "Reparto";
    const rawDate = typeof order?.createdAt === "string" ? order.createdAt : "";
    const parsedDate = rawDate ? new Date(rawDate) : null;
    const date = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" }) : rawDate.slice(0, 10);
    return { title: orderId ? "Pedido #" + shortReference(orderId) : "Pedido sin referencia", detail: [mode, date].filter(Boolean).join(" · ") };
  };
  const timeWindow = (delivery: Row) => {
    const start = textValue(delivery.windowStart, "");
    const end = textValue(delivery.windowEnd, "");
    if (start && end) return "Ventana " + start + "–" + end;
    if (start) return "Desde " + start;
    if (end) return "Hasta " + end;
    return "Sin ventana horaria";
  };
  const deliveryView = (delivery: Row): Row => {
    const route = routeRows.find(candidate => idOf(candidate) === String(delivery.routeId ?? ""));
    const driver = deliveryPeople.find(person => idOf(person) === String(delivery.driverId ?? route?.driverId ?? ""));
    const order = orderLabel(delivery);
    const date = route ? textValue(route.shiftDate, "Turno sin fecha") : "";
    return {
      ...delivery,
      orderIdLabel: order.title + " · " + order.detail,
      routeIdLabel: route ? date + " · " + textValue(deliveryPeople.find(person => idOf(person) === String(route.driverId ?? ""))?.name, "Repartidor asignado") : "Sin ruta",
      driverIdLabel: textValue(driver?.name, "Sin repartidor asignado"),
      stopSequenceLabel: Number.isSafeInteger(delivery.stopSequence) ? "Parada " + (Number(delivery.stopSequence) + 1) : "Sin orden",
    };
  };
  const deliveryActions = (delivery: Row) => {
    const orderLines = rowsOf(orderFor(delivery), "lines");
    const remainingLines = orderLines.flatMap(line => {
      const requested = scaledQuantity(line.requested) ?? 0n;
      const delivered = scaledQuantity(line.delivered) ?? 0n;
      const cancelled = scaledQuantity(line.cancelled) ?? 0n;
      const remaining = requested - delivered - cancelled;
      return remaining > 0n ? [{ line, remaining }] : [];
    });
    const hasVersion = Number.isSafeInteger(versionFor(data, delivery, Number.NaN));
    const disabled = actionsBlocked || !hasVersion;
    return <div className="ops-row-action-stack">
      {delivery.status === "pending" && hasCommand(context, "DeliveryAssigned") && routeOptions.length > 0 && <button type="button" className="ops-button ops-button-quiet ops-button-small" disabled={disabled} onClick={() => runAction("DeliveryAssigned", "Asignar entrega a ruta", fields(
        select("routeId", "Turno y repartidor", routeOptions.map(option => ({ value: option.value, label: option.label }))),
        field("stopSequence", "Orden de parada (0 es la primera)", "integer", { required: true, defaultValue: "0", help: "Indicá una posición explícita dentro del recorrido." }),
        field("windowStart", "Ventana de entrega desde", "datetime-local"), field("windowEnd", "Ventana de entrega hasta", "datetime-local"),
        field("eta", "Horario estimado de llegada", "datetime-local", { help: "Es una estimación operativa, no una hora garantizada." }), evidenceField(),
      ), values => {
        const chosen = routeOptions.find(option => option.value === str(values, "routeId"));
        if (!chosen) throw new Error("Elegí un turno programado.");
        const windowStart = str(values, "windowStart");
        const windowEnd = str(values, "windowEnd");
        if (windowStart && windowEnd && windowStart > windowEnd) throw new Error("La ventana desde debe ser anterior a la hora hasta.");
        const stopSequence = Number.parseInt(str(values, "stopSequence"), 10);
        if (!Number.isSafeInteger(stopSequence) || stopSequence < 0) throw new Error("Ingresá una posición de parada igual o mayor a cero.");
        return { routeId: chosen.value, driverId: String(chosen.route.driverId), stopSequence, ...(windowStart ? { windowStart } : {}), ...(windowEnd ? { windowEnd } : {}), ...(str(values, "eta") ? { eta: str(values, "eta") } : {}), evidence: note(values) };
      }, delivery, "El repartidor se completa desde el turno elegido; los horarios de llegada son estimaciones.")}>Asignar a turno</button>}
      {delivery.status === "assigned" && hasCommand(context, "DeliveryDispatched") && <button type="button" className="ops-button ops-button-quiet ops-button-small" disabled={disabled} onClick={() => runAction("DeliveryDispatched", "Despachar entrega", fields(evidenceField()), values => ({ evidence: note(values) }), delivery)}>Despachar</button>}
      {["dispatched", "partially_delivered"].includes(String(delivery.status)) && hasCommand(context, "DeliveryRecorded") && remainingLines.length > 0 && <button type="button" className="ops-button ops-button-quiet ops-button-small" disabled={disabled} onClick={() => runAction("DeliveryRecorded", "Registrar cantidades entregadas", fields(...remainingLines.flatMap(({ line, remaining }, index) => {
        const sku = catalog.find(candidate => idOf(candidate) === String(line.skuId ?? ""));
        const itemName = textValue(sku?.name, "Artículo " + (index + 1));
        const unit = textValue(line.unit, textValue(sku?.unit, "unidad"));
        const defaultQuantity = formatScaled(remaining);
        return [
          field("quantity-" + index, "Entregado · " + itemName + " (" + unit + ")", "decimal", { defaultValue: defaultQuantity, help: "Podés reducir la cantidad para registrar una entrega parcial; dejá en blanco si no se entregó este artículo." }),
          field("actual-" + index, "Peso real · " + itemName + " (" + unit + ")", "decimal", { defaultValue: defaultQuantity, help: "Cantidad física efectivamente entregada, incluido cualquier excedente." }),
        ];
      }), evidenceField()), values => ({ lines: remainingLines.flatMap(({ line }, index) => {
        const quantity = str(values, "quantity-" + index);
        if (!quantity) return [];
        const actualQuantity = str(values, "actual-" + index);
        return [{ lineId: idOf(line), quantity: quantityForUnit(quantity, line.unit, "Cantidad entregada"), ...(actualQuantity ? { actualQuantity: quantityForUnit(actualQuantity, line.unit, "Peso real") } : {}) }];
      }), evidence: note(values) }), delivery, "Los nombres de los artículos vienen del pedido; el registro queda pendiente de revisión.")}>Registrar entrega</button>}
      {!["cancelled", "delivered", "returned"].includes(String(delivery.status)) && hasCommand(context, "DeliveryIncident") && <button type="button" className="ops-button ops-button-quiet ops-button-small" disabled={disabled} onClick={() => runAction("DeliveryIncident", "Registrar incidencia de entrega", fields(
        select("kind", "Tipo de incidencia", [{ value: "absent", label: "Socio ausente" }, { value: "late", label: "Demora" }, { value: "address", label: "Domicilio" }, { value: "damaged", label: "Producto dañado" }, { value: "other", label: "Otra" }]),
        field("note", "Detalle", "textarea", { required: true }), evidenceField(),
      ), values => ({ kind: str(values, "kind"), note: str(values, "note"), evidence: note(values) }), delivery)}>Registrar incidencia</button>}
      {!hasVersion && <span className="ops-review-pending">Sin versión actual: acciones bloqueadas</span>}
    </div>;
  };
  const statusTone = (status: unknown): RouteOrderStop["statusTone"] => {
    if (status === "delivered") return "good";
    if (status === "returned" || status === "partially_delivered" || status === "dispatched") return "olive";
    if (status === "assigned" || status === "pending") return "warn";
    if (status === "cancelled") return "bad";
    return "neutral";
  };
  const orderEditors = routeRows.flatMap(route => {
    const assigned = deliveries.filter(delivery => String(delivery.routeId ?? "") === idOf(route) && delivery.status !== "cancelled")
      .sort((left, right) => Number(left.stopSequence ?? 0) - Number(right.stopSequence ?? 0) || idOf(left).localeCompare(idOf(right)));
    if (assigned.length < 2) return [];
    const deliveryIds = assigned.map(idOf);
    if (deliveryIds.some(id => !id) || new Set(deliveryIds).size !== deliveryIds.length) return [<p className="ops-route-order-note" role="status" key={idOf(route)}>El turno tiene referencias de parada incompletas o repetidas; el reordenamiento está bloqueado.</p>];
    if (!routeIsOpen(route)) return [<p className="ops-route-order-note" key={idOf(route)}>El turno del {textValue(route.shiftDate, "fecha pendiente")} está cerrado; conserva su orden de paradas.</p>];
    if (!hasCapability(context, "logistics.write") || !hasCommand(context, "RouteReordered")) return [];
    const routeVersion = versionFor(data, route, Number.NaN);
    if (!Number.isSafeInteger(routeVersion)) return [<p className="ops-route-order-note" role="status" key={idOf(route)}>El turno del {textValue(route.shiftDate, "fecha pendiente")} no se puede reordenar porque falta su versión actual.</p>];
    if (assigned.length > 500) return [<p className="ops-route-order-note" role="status" key={idOf(route)}>El turno del {textValue(route.shiftDate, "fecha pendiente")} supera las 500 paradas admitidas para reordenar.</p>];
    const stops: RouteOrderStop[] = assigned.map(delivery => {
      const order = orderLabel(delivery);
      const detail = [order.detail, timeWindow(delivery), delivery.eta ? "ETA estimada " + textValue(delivery.eta) : "Sin ETA estimada"].filter(Boolean).join(" · ");
      return { deliveryId: idOf(delivery), title: order.title, detail, statusLabel: reportStateLabel(delivery.status), statusTone: statusTone(delivery.status) };
    });
    const driver = deliveryPeople.find(person => idOf(person) === String(route.driverId ?? ""));
    const routeLabel = textValue(route.shiftDate, "fecha pendiente") + " · " + textValue(driver?.name, "repartidor asignado");
    return [<RouteOrderEditor key={idOf(route)} routeLabel={routeLabel} stops={stops} revision={routeVersion} disabled={actionsBlocked} onReview={deliveryIds => runAction("RouteReordered", "Reordenar paradas de la ruta", fields(evidenceField("Evidencia del cambio de recorrido")), values => {
      const expected = assigned.map(idOf);
      if (deliveryIds.length !== expected.length || new Set(deliveryIds).size !== expected.length || expected.some(id => !deliveryIds.includes(id))) throw new Error("El orden debe incluir todas las paradas activas una sola vez.");
      return { deliveryIds, evidence: note(values) };
    }, route, "El orden incluye todas las paradas no canceladas, también las entregas ya completadas.")} />];
  });
  return <div className="ops-route-workspace">
    {!routeRows.length && <section className="ops-sheet"><EmptyState title="Todavía no hay rutas programadas" detail={hasCommand(context, "RouteCreated") ? "Programá un turno con «Nueva ruta»; después asigná pedidos pendientes desde la lista inferior." : "No hay turnos dentro del alcance de este perfil."} /></section>}
    {orderEditors.length > 0 && <section className="ops-sheet ops-route-orders"><div className="ops-sheet-head"><div><span className="ops-kicker">Recorrido</span><h3>Orden de paradas</h3></div></div><div className="ops-route-order-groups">{orderEditors}</div></section>}
    {unassignedDeliveries.length ? <ListTable title="Entregas pendientes sin ruta" rows={unassignedDeliveries.map(deliveryView)} columns={[["orderId", "Pedido"], ["status", "Estado"], ["driverId", "Repartidor"]]} renderActions={deliveryActions} hasMore={hasMore} /> : <section className="ops-sheet"><EmptyState title="No hay entregas pendientes sin ruta" detail={routeRows.length ? "Cuando aparezca un pedido pendiente, vas a poder asignarlo desde aquí a un turno programado." : "Las rutas y entregas pendientes aparecerán cuando el servidor las devuelva para este perfil."} /></section>}
    {deliveries.length ? <ListTable title="Entregas asociadas a rutas" rows={deliveries.map(deliveryView)} columns={[["orderId", "Pedido"], ["routeId", "Turno"], ["driverId", "Repartidor"], ["stopSequenceLabel", "Parada"], ["status", "Estado"]]} renderActions={deliveryActions} /> : <section className="ops-sheet"><EmptyState title="No hay entregas asociadas a rutas" detail={routeRows.length ? "Los turnos vacíos se muestran en la lista superior y podrán recibir pedidos pendientes desde la lista de entregas." : "Todavía no hay turnos con entregas asignadas."} /></section>}
  </div>;
}

function AccountLedger({ account, refreshKey, onClose }: { account?: Row; refreshKey: number; onClose: () => void }) {
  const accountId = account ? idOf(account) : "";
  const path = accountId ? `/api/operations/accounts/${encodeURIComponent(accountId)}/ledger?limit=200` : null;
  const ledger = useCursorResource(path, refreshKey, "cursor", "nextCursor", "hasMore", ["items"]);
  const rows = rowsOf(ledger.data).map(item => {
    const event = recordValue(item, "event");
    const metadata = recordValue(event, "metadata");
    const date = recordValue(metadata, "timestampPrecision") === "civil_date"
      ? `${textValue(recordValue(metadata, "declaredDate"), "Fecha pendiente")} (fecha declarada)`
      : textValue(recordValue(event, "occurredAt"), "");
    return { ...item, occurredAt: date, eventType: textValue(recordValue(event, "kind"), "Movimiento") };
  });
  if (!account) return null;
  return <section className="ops-sheet">
    <SectionHeading eyebrow="Finanzas" title={`Movimientos · ${labelOf(account, ["name", "id"])}`} action={<button type="button" className="ops-button ops-button-quiet" onClick={onClose}>Cerrar movimientos</button>} />
    {ledger.loading && <p className="ops-inline-status" role="status">Actualizando movimientos; se conservan los datos de la última consulta.</p>}
    {ledger.error && <ErrorState message={`No se pudo actualizar el libro. ${ledger.error}`} retry={ledger.retry} />}
    {!ledger.data && ledger.loading ? <LoadingState label="Cargando movimientos de la cuenta…" /> : !ledger.data && ledger.error ? null : <>
      <ListTable title="Libro de la cuenta" rows={rows} columns={[["occurredAt", "Fecha"], ["eventType", "Tipo"], ["amountMinor", "Importe"], ["currency", "Moneda"], ["eventId", "Evento"]]} />
      {ledger.hasMore && <button type="button" className="ops-button ops-button-quiet" onClick={ledger.loadMore} disabled={ledger.loading || Boolean(ledger.error)}>Cargar más movimientos</button>}
    </>}
  </section>;
}

function AccountReconciliations({ account, refreshKey, actionsBlocked = false, onClose, onReconcile }: { account?: Row; refreshKey: number; actionsBlocked?: boolean; onClose: () => void; onReconcile: (account: Row) => void }) {
  const accountId = account ? idOf(account) : "";
  const path = accountId ? `/api/operations/accounts/${encodeURIComponent(accountId)}/reconciliations?limit=100` : null;
  const history = useCursorResource(path, refreshKey, "cursor", "nextCursor", "hasMore", ["items"]);
  if (!account) return null;
  const rows = rowsOf(history.data).map(row => ({ ...row, currency: account.currency }));
  const latest = recordValue(account, "reconciliation");
  const writesBlocked = actionsBlocked || history.loading || Boolean(history.error);
  return <section className="ops-sheet">
    <SectionHeading eyebrow="Finanzas · control" title={`Conciliaciones · ${labelOf(account, ["name"])}`} detail={`Moneda ${textValue(account.currency)}`} action={<div className="ops-header-actions">{account.verified === true && typeof account.openingApprovedBy === "string" && <button type="button" className="ops-button ops-button-primary" onClick={() => onReconcile(account)} disabled={writesBlocked}>Registrar arqueo</button>}<button type="button" className="ops-button ops-button-quiet" onClick={onClose}>Cerrar conciliaciones</button></div>} />
    <div className="ops-member-facts ops-reconciliation-summary">
      <div><span>Saldo calculado</span><strong>{formatMinor(account.balanceMinor, account.currency)}</strong></div>
      <div><span>Último saldo contado</span><strong>{latest ? formatMinor(recordValue(latest, "countedMinor"), account.currency) : "Sin arqueos registrados"}</strong></div>
      <div><span>Diferencia del último arqueo</span><strong>{latest ? formatMinor(recordValue(latest, "differenceMinor"), account.currency) : "—"}</strong></div>
      <div><span>Fecha del último arqueo</span><strong>{textValue(recordValue(latest, "date"), "—")}</strong></div>
    </div>
    {history.loading && <p className="ops-inline-status" role="status">Actualizando conciliaciones; se conserva el historial de la última consulta.</p>}
    {history.error && <ErrorState message={`No se pudo actualizar el historial. ${history.error}`} retry={history.retry} />}
    {!history.data && history.loading ? <LoadingState label="Cargando conciliaciones…" /> : !history.data && history.error ? null : rows.length ? <>
      <ListTable title={`Historial · ${rows.length}`} rows={rows} columns={[["date", "Fecha"], ["calculatedMinor", "Saldo calculado"], ["countedMinor", "Saldo contado"], ["differenceMinor", "Diferencia"], ["evidence", "Evidencia"]]} />
      {history.hasMore && <button type="button" className="ops-button ops-button-quiet" onClick={history.loadMore} disabled={history.loading || Boolean(history.error)}>Cargar más conciliaciones</button>}
    </> : <EmptyState title="Todavía no hay conciliaciones" detail="La fecha, saldo contado y diferencia aparecerán después de registrar el primer arqueo." />}
  </section>;
}

function factAmountLabel(fact: Row) {
  const amount = fact.amountMinor;
  if (fact.amountState !== "known" || (typeof amount !== "string" && typeof amount !== "bigint")) return "Importe no disponible";
  const currency = fact.currency;
  if (fact.currencyState === "known" && (currency === "ARS" || currency === "USD")) return formatMinor(amount, currency);
  return `${String(amount)} unidades mínimas · moneda no identificada`;
}
function factDateLabel(fact: Row) {
  if (fact.dateState !== "known" || typeof fact.date !== "string") return `Fecha no disponible · ${textValue(fact.dateState, "sin clasificar")}`;
  return fact.date;
}
function legacyBasisLabel(fact: Row) {
  if (fact.amountBasis === "Total_Facturado" && fact.totalMinor !== null && fact.totalMinor !== undefined) return `Total facturado · ${factAmountLabel(fact)}`;
  if (fact.amountBasis === "Subtotal_Venta" && fact.productMinor !== null && fact.productMinor !== undefined) return `Subtotal de venta · ${factAmountLabel(fact)}`;
  return `Base: ${textValue(fact.amountBasis, "no identificada")} · ${factAmountLabel(fact)}`;
}

function legacyFinancialProjectionLabel(row: Row, currency: unknown) {
  if (row.legacyFinancialProjectionState !== "reviewed") return "Saldo no disponible · requiere revisión";
  const balance = formatMinor(row.outstandingMinor, currency);
  const legacyPaid = typeof row.legacyPaidMinor === "string" && /^\d+$/.test(row.legacyPaidMinor) ? BigInt(row.legacyPaidMinor) : 0n;
  return legacyPaid > 0n ? `Saldo ${balance} · pago histórico revisado ${formatMinor(row.legacyPaidMinor, currency)}` : `Saldo ${balance}`;
}

function MemberInspector({ memberId, refreshKey, documents, catalog, onClose }: { memberId: string; refreshKey: number; documents: Row[]; catalog: Row[]; onClose: () => void }) {
  const [member, setMember] = useState<Row | null>(null);
  const [permissions, setPermissions] = useState<Row[]>([]);
  const [orderRows, setOrderRows] = useState<Row[]>([]);
  const [historicalRows, setHistoricalRows] = useState<Row[]>([]);
  const [coverage, setCoverage] = useState<Row | null>(null);
  const [orderCursor, setOrderCursor] = useState<string | null>(null);
  const [historicalCursor, setHistoricalCursor] = useState<string | null>(null);
  const [orderHasMore, setOrderHasMore] = useState(false);
  const [historicalHasMore, setHistoricalHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"orders" | "history" | "" > ("");
  const [error, setError] = useState("");
  const [historicalChanged, setHistoricalChanged] = useState(false);
  const [loadedMemberId, setLoadedMemberId] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const basePath = `/api/operations/members/${encodeURIComponent(memberId)}`;
  useEffect(() => {
    let active = true;
    const sameMember = loadedMemberId === memberId;
    setLoading(true); setError(""); setHistoricalChanged(false);
    if (!sameMember) {
      setLoadedMemberId(""); setMember(null); setPermissions([]); setOrderRows([]); setHistoricalRows([]); setCoverage(null);
      setOrderCursor(null); setHistoricalCursor(null); setOrderHasMore(false); setHistoricalHasMore(false);
    }
    Promise.all([apiGet<Row>(basePath), apiGet<Row>(`${basePath}/history?limit=20`)]).then(([profile, history]) => {
      if (!active) return;
      const current = rowsOf(history, "orders");
      const legacy = rowsOf(history, "legacyInvoices");
      setMember(recordValue(profile, "member") as Row ?? null);
      setPermissions(rowsOf(profile, "permissions"));
      setOrderRows(current); setHistoricalRows(legacy); setCoverage(recordValue(history, "coverage") as Row ?? null);
      setOrderCursor(typeof history.nextCursor === "string" ? history.nextCursor : null);
      setHistoricalCursor(typeof history.historicalNextCursor === "string" ? history.historicalNextCursor : null);
      setOrderHasMore(history.hasMore === true); setHistoricalHasMore(history.historicalHasMore === true);
      setLoadedMemberId(memberId);
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof OperationsApiError && [401, 403, 404].includes(cause.status)) {
        setLoadedMemberId(""); setMember(null); setPermissions([]); setOrderRows([]); setHistoricalRows([]); setCoverage(null);
        setOrderCursor(null); setHistoricalCursor(null); setOrderHasMore(false); setHistoricalHasMore(false);
      }
      setError(cause instanceof Error ? cause.message : "No se pudo cargar la ficha del socio.");
    })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [basePath, refreshKey, retryKey]);

  const hasCurrentMember = loadedMemberId === memberId && member !== null;
  const retry = () => setRetryKey(value => value + 1);

  async function loadOrders() {
    if (!orderCursor) return;
    setBusy("orders"); setError("");
    try {
      const params = new URLSearchParams({ limit: "20", cursor: orderCursor });
      const page = await apiGet<Row>(`${basePath}/history?${params}`);
      setOrderRows(current => mergePageRows(current, rowsOf(page, "orders")));
      setOrderCursor(typeof page.nextCursor === "string" ? page.nextCursor : null); setOrderHasMore(page.hasMore === true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo cargar el resto de los pedidos."); }
    finally { setBusy(""); }
  }
  async function loadHistorical(reset = false) {
    if (!reset && !historicalCursor) return;
    setBusy("history"); setError("");
    const params = new URLSearchParams({ limit: "20", ...(!reset && historicalCursor ? { historicalCursor } : {}) });
    try {
      const page = await apiGet<Row>(`${basePath}/history?${params}`);
      setHistoricalRows(current => reset ? rowsOf(page, "legacyInvoices") : mergePageRows(current, rowsOf(page, "legacyInvoices")));
      setCoverage(recordValue(page, "coverage") as Row ?? null);
      setHistoricalCursor(typeof page.historicalNextCursor === "string" ? page.historicalNextCursor : null);
      setHistoricalHasMore(page.historicalHasMore === true); setHistoricalChanged(false);
    } catch (cause) {
      if (cause instanceof OperationsApiError && cause.status === 409 && cause.code === "HISTORY_POPULATION_CHANGED") {
        setHistoricalRows([]); setHistoricalCursor(null); setHistoricalHasMore(false); setHistoricalChanged(true);
        setError("Cambió la población histórica revisada. La lista histórica se reinició; los pedidos actuales conservaron su página.");
      } else setError(cause instanceof Error ? cause.message : "No se pudo cargar la historia aprobada.");
    } finally { setBusy(""); }
  }
  if (loading && !hasCurrentMember) return <section className="ops-sheet"><SectionHeading eyebrow="Personas" title="Ficha del socio" action={<button type="button" className="ops-button ops-button-quiet" onClick={onClose}>Cerrar ficha</button>} /><LoadingState label="Cargando ficha e historial…" /></section>;
  if (error && !hasCurrentMember) return <section className="ops-sheet"><SectionHeading eyebrow="Personas" title="Ficha del socio" action={<button type="button" className="ops-button ops-button-quiet" onClick={onClose}>Cerrar ficha</button>} /><ErrorState message={error} retry={retry} /></section>;
  const address = recordValue(member, "address");
  const preferences = recordValue(member, "preferences");
  const addressParts = ["street", "streetNumber", "floor", "apartment", "unit", "city", "province", "postalCode", "country"].flatMap(key => {
    const value = recordValue(address, key); return typeof value === "string" && value.trim() ? [value.trim()] : [];
  });
  const zone = textValue(recordValue(address, "zone"), "");
  const addressReference = textValue(recordValue(address, "reference"), "");
  const preferenceChannel = textValue(recordValue(preferences, "preferredChannel"), "");
  const contactPreference = textValue(recordValue(preferences, "contactPreference"), "");
  const paymentPreference = textValue(recordValue(preferences, "preferredPaymentMethod"), "");
  const deliveryWindow = recordValue(preferences, "deliveryWindow");
  const categories = Array.isArray(recordValue(preferences, "preferredCategories")) ? recordValue(preferences, "preferredCategories") as unknown[] : [];
  const preferredSkuIds = Array.isArray(recordValue(preferences, "preferredSkus")) ? recordValue(preferences, "preferredSkus") as unknown[] : [];
  const skuNames = preferredSkuIds.flatMap(value => typeof value === "string" ? catalog.filter(sku => idOf(sku) === value).map(sku => labelOf(sku, ["name"])) : []);
  const windowLabel = deliveryWindow && typeof deliveryWindow === "object" ? `${textValue(recordValue(deliveryWindow, "from"), "")}–${textValue(recordValue(deliveryWindow, "to"), "")}` : "";
  const contactLabels: Record<string, string> = { whatsapp: "WhatsApp", phone: "Teléfono", email: "Correo", manual: "Manual" };
  const paymentLabels: Record<string, string> = { cash: "Efectivo", transfer: "Transferencia", mercado_pago: "Mercado Pago", card: "Tarjeta" };
  const preferenceSummary = [
    preferenceChannel === "delivery" ? "Reparto" : preferenceChannel === "local" ? "Retiro" : preferenceChannel,
    contactLabels[contactPreference] ?? contactPreference,
    categories.length ? `Categorías: ${categories.filter((value): value is string => typeof value === "string").join(", ")}` : "",
    preferredSkuIds.length ? `Artículos: ${skuNames.length ? skuNames.join(", ") : `${preferredSkuIds.length} seleccionados`}` : "",
    paymentPreference ? `Pago: ${paymentLabels[paymentPreference] ?? paymentPreference}` : "",
    windowLabel ? `Horario de reparto: ${windowLabel}` : "",
  ].filter(Boolean).join(" · ");
  return <section className="ops-sheet ops-member-inspector">
    <SectionHeading eyebrow="Personas · ficha e historial" title={textValue(member?.name, "Ficha del socio")} detail={[textValue(member?.email, ""), textValue(member?.phone, "")].filter(Boolean).join(" · ") || "Sin contacto informado"} action={<button type="button" className="ops-button ops-button-quiet" onClick={onClose}>Cerrar ficha</button>} />
    {loading && <p className="ops-inline-status" role="status">Actualizando ficha; se muestran los últimos datos confirmados y las acciones de carga están pausadas.</p>}
    <div className="ops-member-facts">
      <div><span>Domicilio</span><strong>{addressParts.join(" · ") || "No informado"}{addressReference ? ` · ${addressReference}` : ""}</strong></div>
      <div><span>Zona</span><strong>{zone || "No informada"}</strong></div>
      <div><span>Preferencias</span><strong>{preferenceSummary || "Sin preferencias informadas"}</strong></div>
      <div><span>Permisos</span><strong>{permissions.length ? permissions.map(row => `${textValue(row.kind)} · ${textValue(row.status)}${row.validUntil ? ` · hasta ${textValue(row.validUntil)}` : ""}`).join("; ") : "Sin permisos registrados"}</strong></div>
    </div>
    {documents.length > 0 && <ListTable title="Documentos operativos disponibles" rows={documents} columns={[["kind", "Tipo"], ["state", "Estado"], ["validUntil", "Vigencia"]]} />}
    {error && <InfoBand tone="warning" title="No se pudo completar la actualización; se conservan los datos anteriores">{error}<button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={retry} disabled={loading || busy !== ""}>Reintentar actualización</button>{historicalChanged && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => void loadHistorical(true)} disabled={busy === "history" || loading}>Volver a consultar historia</button>}</InfoBand>}
    <div className="ops-member-history-grid">
      <section><h3>Pedidos de Bombo</h3>{orderRows.length ? <ListTable title="Pedidos actuales" rows={orderRows.map(row => ({ ...row, amountLabel: row.totalCalculationState === "pending_definition" ? "Pendiente de definición" : typeof row.currency === "string" ? formatMinor(row.totalMinor, row.currency) : "Importe no disponible", legacyFinancialLabel: legacyFinancialProjectionLabel(row, row.currency) }))} columns={[["createdAt", "Fecha"], ["channel", "Modalidad"], ["fulfillmentState", "Preparación"], ["financialState", "Cobro"], ["legacyFinancialLabel", "Saldo y pago histórico"], ["amountLabel", "Total"]]} /> : <p className="ops-muted-copy">No hay pedidos actuales en el alcance.</p>}{orderHasMore && <button type="button" className="ops-button ops-button-quiet" onClick={() => void loadOrders()} disabled={busy !== "" || loading || Boolean(error)}>{busy === "orders" ? "Cargando…" : "Cargar más pedidos"}</button>}</section>
      <section><h3>Historia legado aprobada</h3>{coverage && <p className="ops-muted-copy">{textValue(coverage.historical, "Cobertura pendiente")}{typeof coverage.fingerprint === "string" ? ` · revisión ${coverage.fingerprint.slice(0, 12)}` : ""}. La historia no crea saldos ni acredita pagos.</p>}{historicalRows.length ? <ul className="ops-fact-list">{historicalRows.map((fact, index) => <li key={textValue(fact.id, String(index))}><strong>{factDateLabel(fact)} · {legacyBasisLabel(fact)}</strong><span>{textValue(fact.reference, "Factura histórica")} · moneda {fact.currencyState === "known" && (fact.currency === "ARS" || fact.currency === "USD") ? String(fact.currency) : "no identificada"}{fact.correctionOf ? " · versión corregida" : ""}</span></li>)}</ul> : <p className="ops-muted-copy">No hay facturas publicadas para mostrar en esta página.</p>}{historicalHasMore && <button type="button" className="ops-button ops-button-quiet" onClick={() => void loadHistorical()} disabled={busy !== "" || loading || Boolean(error)}>{busy === "history" ? "Cargando…" : "Cargar más historia"}</button>}</section>
    </div>
  </section>;
}

function PurchaseJourneyStatus({ context }: { context: OperationsContext }) {
  const steps = [
    { command: "PurchaseOrderCreated", label: "Crear una compra", capability: "purchases.write" },
    { command: "PurchaseOrderApproved", label: "Aprobar una compra", capability: "purchases.write" },
    { command: "GoodsReceived", label: "Registrar una recepción", capability: "stock.receive" },
  ];
  const unavailable = steps.filter(step => !hasCapability(context, step.capability) || !hasCommand(context, step.command));
  if (!unavailable.length) return null;
  return <InfoBand tone="warning" title="Algunas acciones de compra no están disponibles">
    <p>El alcance del perfil y las acciones publicadas determinan qué pasos podés completar en esta sesión.</p>
    <details className="ops-command-diagnostics"><summary>Ver pasos pendientes y referencias para pruebas</summary><ul>{unavailable.map(step => <li key={step.command}><span>{step.label}</span><strong>{hasCapability(context, step.capability) ? "Este perfil tiene el permiso, pero el contexto no publica la acción." : `El perfil no tiene ${step.capability}; esa acción puede estar oculta por el alcance.`}</strong><code>{step.command}</code></li>)}</ul></details>
  </InfoBand>;
}

function PurchaseReference({ suppliers, catalog, locations }: { suppliers: Row[]; catalog: Row[]; locations: Row[] }) {
  if (!suppliers.length && !catalog.length && !locations.length) return null;
  return <details className="ops-sheet ops-reference-sheet"><summary><span><span className="ops-kicker">Compras y recepción</span><strong>Referencias disponibles</strong></span><span>{suppliers.length} proveedores · {catalog.length} productos · {locations.length} ubicaciones</span></summary>
    <div className="ops-reference-group">
      {suppliers.length > 0 && <><h3>Proveedores</h3>{suppliers.map(row => <article className="ops-reference-item" key={idOf(row)}><strong>{labelOf(row)}</strong><code>{idOf(row)}</code></article>)}</>}
      {catalog.length > 0 && <><h3>Productos</h3>{catalog.slice(0, 80).map(row => <article className="ops-reference-item" key={idOf(row)}><strong>{labelOf(row)}</strong><code>{idOf(row)}</code><span>{textValue(row.unit)} · {textValue(row.category)}</span></article>)}{catalog.length > 80 && <small>Se muestran los primeros 80 productos activos.</small>}</>}
      {locations.length > 0 && <><h3>Ubicaciones</h3>{locations.map(row => <article className="ops-reference-item" key={idOf(row)}><strong>{labelOf(row)}</strong><code>{idOf(row)}</code></article>)}</>}
    </div>
  </details>;
}

function OrderReturnInspector({ orderId, context, refreshKey, catalog, openAction, onClose, onNotice }: { orderId: string; context: OperationsContext; refreshKey: number; catalog: Row[]; openAction: (action: CommandAction) => void; onClose: () => void; onNotice: (message: string) => void }) {
  const detail = useRemote<Record<string, unknown>>(`/api/operations/orders/${encodeURIComponent(orderId)}`, refreshKey);
  if (!detail.data) return <section className="ops-sheet"><SectionHeading eyebrow="Devoluciones" title="Inspección física" action={<button type="button" className="ops-button ops-button-quiet" onClick={onClose}>Cerrar</button>} />{detail.loading ? <LoadingState label="Cargando preparación y entregas…" /> : detail.error ? <ErrorState message={detail.error} retry={detail.retry} /> : null}</section>;

  const order = recordValue(detail.data, "order") as Row | undefined;
  const lines = Array.isArray(order?.lines) ? order.lines as Row[] : [];
  const lineById = new Map(lines.map(line => [idOf(line), line]));
  const allocations = rowsOf(detail.data, "allocations").filter(row => ["dispatched", "delivered", "partially_returned"].includes(String(row.state)));
  const eligibleAllocations = allocations.filter(allocation => {
    const available = returnAvailability(allocation);
    return available !== null && (available.customer > 0n || available.undelivered > 0n);
  });
  const namedEligibleAllocations = eligibleAllocations.filter(allocation => {
    const line = lineById.get(textValue(allocation.lineId, ""));
    return Boolean(line && visibleInvoiceLineName(line, catalog));
  });
  const unidentifiedEligibleAllocationCount = eligibleAllocations.length - namedEligibleAllocations.length;
  const detailVersion = recordValue(detail.data, "version");
  const version = typeof detailVersion === "number" ? detailVersion : Number.NaN;
  const fieldsIn: ActionField[] = [];
  for (const allocation of namedEligibleAllocations) {
    const allocationId = idOf(allocation);
    const line = lineById.get(textValue(allocation.lineId, ""));
    const available = returnAvailability(allocation)!;
    const originOptions = [
      ...(available.customer > 0n ? [{ value: "customer", label: `Devuelto por cliente · hasta ${formatScaled(available.customer)} ${textValue(line?.unit)}` }] : []),
      ...(available.undelivered > 0n ? [{ value: "undelivered", label: `Preparado y no entregado · hasta ${formatScaled(available.undelivered)} ${textValue(line?.unit)}` }] : []),
    ];
    const maxAvailable = available.customer > available.undelivered ? available.customer : available.undelivered;
    const label = `${visibleInvoiceLineName(line ?? {}, catalog)} · lote ${textValue(allocation.lotId, "sin lote")}`;
    fieldsIn.push(field(`quantity_${allocationId}`, `Cantidad a inspeccionar · ${label}`, "decimal", { help: `Línea ${textValue(allocation.lineId)} · preparación ${allocationId} · máximo posible ${formatScaled(maxAvailable)} ${textValue(line?.unit)}. El origen elegido determina el límite exacto.` }));
    fieldsIn.push(select(`origin_${allocationId}`, `Origen · ${label}`, originOptions, false));
    fieldsIn.push(select(`disposition_${allocationId}`, `Destino · ${label}`, [{ value: "restock", label: "Reingresar al stock" }, { value: "merma", label: "Registrar como merma" }], false));
    fieldsIn.push(field(`evidence_${allocationId}`, `Observación de inspección · ${label}`, "textarea", { help: "Obligatoria si informás una cantidad." }));
  }
  fieldsIn.push(evidenceField("Evidencia general de inspección"));
  const submit = () => {
    if (!hasCommand(context, "OrderReturnInspected")) {
      onNotice("La inspección de devoluciones no está disponible para esta sesión. Revisá el contexto del perfil.");
      return;
    }
    if (!Number.isSafeInteger(version)) {
      onNotice(`La consulta del pedido no devolvió la versión necesaria para inspeccionar. Pedido ${orderId}.`);
      return;
    }
    openAction(action("OrderReturnInspected", "Inspeccionar devolución física", fieldsIn, values => {
      const returns = namedEligibleAllocations.flatMap(allocation => {
        const allocationId = idOf(allocation);
        const rawQuantity = str(values, `quantity_${allocationId}`);
        if (!rawQuantity) return [];
        const lineId = textValue(allocation.lineId, "");
        const line = lineById.get(lineId);
        if (!line) throw new Error("Una preparación ya no corresponde a un renglón visible del pedido.");
        const quantity = quantityForUnit(rawQuantity, line.unit, "Cantidad inspeccionada");
        const quantityScaled = scaledQuantity(quantity);
        const available = returnAvailability(allocation);
        if (!available || quantityScaled === null) throw new Error("La consulta del pedido no contiene cantidades suficientes para limitar esta devolución.");
        const origin = str(values, `origin_${allocationId}`);
        const disposition = str(values, `disposition_${allocationId}`);
        if (origin !== "customer" && origin !== "undelivered") throw new Error("Elegí de dónde vuelve cada cantidad inspeccionada.");
        const originLimit = origin === "customer" ? available.customer : available.undelivered;
        if (originLimit <= 0n || quantityScaled > originLimit) throw new Error(`La cantidad supera el máximo disponible para el origen ${origin === "customer" ? "cliente" : "no entregado"}: ${formatScaled(originLimit)} ${textValue(line.unit)}.`);
        if (disposition !== "restock" && disposition !== "merma") throw new Error("Elegí el destino de cada cantidad inspeccionada.");
        return [{ lineId, allocationId, quantity, origin, disposition, evidence: note(values, `evidence_${allocationId}`) }];
      });
      if (!returns.length) throw new Error("Indicá al menos una cantidad física recibida para inspeccionar.");
      return { returns, evidence: note(values) };
    }, orderId, version));
  };

  return <section className="ops-sheet ops-return-inspector"><SectionHeading eyebrow="Devoluciones" title="Inspección física" detail="Elegí la preparación, el origen y el destino de cada cantidad devuelta." action={<button type="button" className="ops-button ops-button-quiet" onClick={onClose}>Cerrar</button>} />
    {detail.loading && <p className="ops-inline-status" role="status">Actualizando preparación; los últimos datos confirmados siguen visibles y la inspección está pausada.</p>}
    {detail.error && <ErrorState message={`No se pudo actualizar la preparación. ${detail.error}`} retry={detail.retry} />}
    {eligibleAllocations.length ? <><p>Las cantidades se limitan a lo entregado al cliente o preparado y aún no entregado. La inspección requiere revisión independiente de quien llevó el pedido.</p>{unidentifiedEligibleAllocationCount > 0 && <InfoBand tone="warning" title="Hay preparaciones sin producto identificable"><p>Las cantidades cuyo producto no tiene un nombre visible quedan excluidas. Actualizá el catálogo o reactivá el nombre antes de inspeccionar esas devoluciones.</p></InfoBand>}<div className="ops-return-allocations">{allocations.map(allocation => { const line = lineById.get(textValue(allocation.lineId, "")); const available = returnAvailability(allocation); return <article key={idOf(allocation)}><strong>{visibleInvoiceLineName(line ?? {}, catalog) || "Producto sin nombre disponible"} · lote {textValue(allocation.lotId, "sin lote")}</strong><span>{textValue(line?.unit)} · cliente {available ? formatScaled(available.customer) : "—"} · no entregado {available ? formatScaled(available.undelivered) : "—"}</span><code>{textValue(allocation.lineId)} · preparación {idOf(allocation)}</code></article>; })}</div>{namedEligibleAllocations.length > 0 ? <button type="button" className="ops-button ops-button-primary" onClick={submit} disabled={detail.loading || Boolean(detail.error)}>Completar inspección</button> : <InfoBand tone="warning" title="Inspección pausada"><p>No se puede registrar una inspección hasta identificar con nombre visible el producto de cada preparación elegible.</p></InfoBand>}</>
      : <EmptyState title="No hay cantidades disponibles para inspeccionar" detail={allocations.length ? "Las preparaciones visibles ya no tienen cantidades entregadas o no entregadas elegibles, o la consulta no devolvió los acumulados requeridos." : "El pedido todavía no tiene asignaciones despachadas o entregadas disponibles."} />}
  </section>;
}

function ReportsPanel({ context, refreshKey }: { context: OperationsContext; refreshKey: number }) {
  const areas = useRemote<Record<string, unknown>>("/api/reports/operations/areas", refreshKey);
  const catalog = useRemote<Record<string, unknown>>("/api/reports/operations/metrics", refreshKey);
  const [areaId, setAreaId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const reportUrl = areaId ? `/api/reports/operations/summary?area=${encodeURIComponent(areaId)}${from ? `&from=${encodeURIComponent(from)}` : ""}${to ? `&to=${encodeURIComponent(to)}` : ""}` : null;
  const summary = useRemote<Record<string, unknown>>(reportUrl, refreshKey);
  const areaRows = rowsOf(areas.data, "areas");
  const metricRows = rowsOf(catalog.data, "metrics");
  const selected = areaRows.find(row => row.id === areaId) ?? areaRows[0];
  const data = recordValue(summary.data, "summary") as Row | undefined;
  const metricValues = (recordValue(data, "metrics") && typeof recordValue(data, "metrics") === "object" ? recordValue(data, "metrics") : {}) as Row;
  const coverage = Array.isArray(recordValue(data, "coverage")) ? recordValue(data, "coverage") as Row[] : [];
  const definition = metricRows.find(row => row.id === (selected?.id ?? areaId));

  useEffect(() => {
    if (!areaId && areaRows.length) setAreaId(textValue(areaRows[0].id, ""));
  }, [areaId, areaRows]);

  return <div className="ops-page-body">
    <SectionHeading eyebrow="Control · analítica" title="Informes operativos" detail="Consultas por fecha civil inclusiva; monedas y estados de cobertura se presentan por separado." />
    <CanonicalExportPanel context={context} />
    {areas.loading && <LoadingState label="Cargando catálogo de áreas…" />}{areas.error && <ErrorState message={areas.error} retry={areas.retry} />}
    {areaRows.length > 0 && <>
      <section className="ops-sheet ops-report-filter">
        <label className="ops-field"><span>Área analítica</span><select value={areaId || textValue(areaRows[0].id, "")} onChange={event => setAreaId(event.target.value)}>{areaRows.map(row => <option key={textValue(row.id)} value={textValue(row.id)}>{textValue(row.title, textValue(row.id))}</option>)}</select></label>
        <label className="ops-field"><span>Desde (opcional)</span><input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label className="ops-field"><span>Hasta (opcional)</span><input type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
        <div className="ops-report-controls"><span className="ops-small-note">Las fechas se interpretan en la zona horaria de Bombo y ambos extremos se incluyen.</span><button className="ops-button ops-button-primary" type="button" onClick={() => { if (!areaId && areaRows[0]) setAreaId(textValue(areaRows[0].id, "")); }}>Consultar informe</button></div>
      </section>
      {definition && <div className="ops-report-description"><strong>{reportGrain(textValue(definition.id, areaId))}</strong><p>Estado de consulta: {reportStateLabel(definition.queryState)}</p><p>{reportGuidance(textValue(definition.id, areaId))}</p></div>}
      {summary.loading && <LoadingState label="Consultando fuentes dentro del alcance…" />}{summary.error && <ErrorState message={summary.error} retry={summary.retry} />}
      {data && <>
        <div className="ops-sheet-head ops-report-state"><div><span className="ops-kicker">Calidad de la evidencia</span><h3>{textValue(selected?.title, reportAreaLabel(areaId))}</h3></div><StatusTag tone={data.evidenceState === "partial" ? "bad" : data.evidenceState === "reconciled" ? "good" : "warn"}>{reportStateLabel(data.evidenceState)}</StatusTag></div>
        <div className="ops-report-metrics">{Object.entries(metricValues).map(([key, value]) => <MetricValueView key={key} label={key} value={value} />)}</div>
        <section className="ops-sheet ops-list-sheet"><div className="ops-sheet-head"><div><span className="ops-kicker">Cobertura por fuente</span><h3>Período y completitud</h3></div></div>
          {coverage.length ? <DataTable label="Cobertura de fuentes"><thead><tr><th>Fuente</th><th>Estado</th><th>Filas conocidas</th><th>Esperadas</th><th>Motivo</th></tr></thead><tbody>{coverage.map((row, index) => <tr key={`${textValue(row.source)}-${index}`}><td>{reportSourceLabel(textValue(row.source))}</td><td><StatusTag tone={row.state === "partial" || row.state === "excluded" ? "warn" : row.state === "unverified" ? "neutral" : "good"}>{reportStateLabel(row.state)}</StatusTag></td><td>{textValue(row.knownCount, "Sin dato")}</td><td>{textValue(row.expectedCount, "No informado")}</td><td>{reportReasonLabel(textValue(row.reason))}</td></tr>)}</tbody></DataTable> : <EmptyState title="Sin datos de cobertura" detail="El informe no informó fuentes para este período." />}
        </section>
        <InfoBand tone="warning" title="Las cifras conservan su estado de cobertura"><p>Un resultado vacío no prueba un período en cero. Las monedas se agrupan por separado y una consulta local no equivale a una certificación contable.</p></InfoBand>
      </>}
    </>}
  </div>;
}

const REPORT_METRIC_LABELS: Record<string, string> = {
  pendingAppSheetInvoiceMemberCount: "Socios con facturas de cálculo pendiente", pendingAppSheetInvoiceOrderCount: "Facturas pendientes para segmentación", segmentationDataComplete: "Datos completos para segmentación",
  pendingAppSheetInvoices: "Facturas con cálculo pendiente", capturedBaseMinorByCurrency: "Importes capturados de referencia por moneda", capturedProductLineMinorByCurrency: "Valores explícitos de productos por moneda", capturedProductLineCount: "Líneas de productos capturadas", capturedClientTariffMinorByCurrency: "Tarifas Cliente capturadas por moneda", totalMinorByCurrency: "Total facturado por moneda", totalCalculationState: "Definición del total", recognizedAsSalesRevenue: "Reconocido como venta", amountBasis: "Base del importe", pendingAppSheetDeliveryTariffByCurrency: "Tarifas de entrega pendientes por moneda", pendingAppSheetDeliveryTariffRecognized: "Tarifas pendientes reconocidas", pendingAppSheetInvoiceCount: "Facturas con cálculo pendiente",
  orderCount: "Pedidos incluidos", netProductRevenueByCurrency: "Ingresos netos por moneda", orderTotalByCurrency: "Total de pedidos por moneda", saleTotalByCurrency: "Ventas históricas por moneda", lineTotalByCurrency: "Líneas históricas por moneda", historicalSales: "Ventas históricas", operationalSales: "Ventas de operación", operationalOrderCount: "Pedidos de operación", historicalDeliverySaleCount: "Ventas históricas de reparto",
  deliveredLineCount: "Líneas entregadas", linesWithRevenueObserved: "Líneas con ingresos observados", revenueByCurrency: "Ingresos por moneda", actualAllocatedCostSoldByCurrency: "Costo de lotes vendidos por moneda", grossContributionBeforeFixedCostsByCurrency: "Margen por lote antes de costos fijos", managementContributionBeforeFixedCostsByCurrency: "Contribución de gestión antes de costos fijos", recognizedDeliveryAndSurchargeByCurrency: "Cargos de entrega y recargos reconocidos", approvedAccruedVariableCostsByCurrency: "Costos variables devengados aprobados", allocationCoverage: "Cobertura de asignación por lote", managementCoverage: "Cobertura de costos y período", fixedCosts: "Costos fijos aprobados", contributionAfterFixedCostsByCurrency: "Contribución después de costos fijos",
  historicalExpenseByCurrency: "Gastos históricos por moneda", compatibilityExpenseByCurrency: "Gastos de registros anteriores", currencyStatusForHistoricalSources: "Estado de moneda de fuentes históricas", verifiedPayableAccrualByCurrency: "Obligaciones verificadas devengadas", unverifiedPayableAccrualByCurrency: "Obligaciones sin verificar", paidPayableByObligationCurrency: "Pagos por moneda de obligación", openVerifiedOperatingPayablesByCurrency: "Obligaciones operativas verificadas pendientes", openUnverifiedOperatingPayablesByCurrency: "Obligaciones operativas sin verificar pendientes", counts: "Cantidades por fuente",
  purchaseOrders: "Órdenes de compra", receipts: "Recepciones", verifiedOpenPurchasePayablesByCurrency: "Compras verificadas pendientes", pendingOpenPurchasePayablesByCurrency: "Compras sin verificar pendientes", historicalPurchaseReceiptCount: "Recepciones históricas", historicalPurchaseTotalByCurrency: "Compras históricas por moneda", historicalCurrencyStatus: "Estado de moneda histórica", receiptQuantities: "Cantidades recibidas",
  current: "Stock actual", balanceRows: "Saldos visibles", lotCount: "Lotes", activeReservationCount: "Reservas activas", availableBalancesByLotLocationCustodian: "Disponibilidad por lote y custodia", balanceOnHandByUnit: "Saldo físico por unidad", reservedByUnit: "Reservado por unidad", availableByUnit: "Disponible por unidad", preparationDeliveryCustodyByLotLocationCustodian: "Stock en preparación y reparto", preparationCustodyByUnit: "En preparación por unidad", deliveryCustodyByUnit: "En reparto por unidad", physicalClubStockByUnit: "Stock físico del club por unidad", physicalCustodyFormula: "Cálculo de custodia física", custodyLocationBasis: "Base de ubicación de custodia", custodyState: "Estado de custodia", stockFacts: "Movimientos de stock", historicalStock: "Observaciones históricas de stock",
  accountCount: "Cuentas", ledgerLegCount: "Movimientos de cuenta", reconciledBalanceByCurrency: "Saldo conciliado por moneda", ledgerMovementByCurrency: "Movimientos contables por moneda", historicalMovementByCurrency: "Movimientos históricos por moneda", accounts: "Detalle de cuentas", reconciliations: "Conciliaciones", collectionReportCount: "Cobros informados", reportedCollectionByCurrency: "Cobros informados por moneda", verifiedAppliedCollectionByCurrency: "Cobros verificados aplicados", verifiedExcessByCurrency: "Excedentes verificados", acceptedRenditionCount: "Rendiciones aceptadas", renditionGrossByCurrency: "Bruto rendido por moneda", renditionDeliveredByCurrency: "Entregado al club por moneda", renditionFeeByCurrency: "Remuneración por moneda", deliveryLifecycleCounts: "Entregas por estado", collectionStatusCounts: "Cobros por estado", collectionReportsWithCustodyIdentity: "Cobros con custodio identificado",
  conversionEventCount: "Conversiones registradas", validatedPairedConversionCount: "Conversiones conciliadas", invalidOrIncompleteFxEventCount: "Conversiones incompletas", accountScopedEventsNotPaired: "Movimientos en alcance de cuenta", fxEvents: "Detalle de conversiones", source: "Base de origen", segmentCounts: "Socios por segmento", includedMemberCount: "Socios incluidos", currentOperationOrderCount: "Pedidos considerados", segmentationAsOfDate: "Segmentación al día", memberHistoryBasis: "Base histórica de socio", spendBasis: "Base de gasto", unlinkedHistoricalDeliverySaleCount: "Ventas históricas sin socio asociado", unlinkedHistoricalDeliveryState: "Estado de ventas sin vínculo", segmentationScope: "Alcance de segmentación", spendCurrencyPolicy: "Política de moneda", minimumVisibleGroup: "Mínimo para mostrar un grupo", sourceRowsComplete: "Fuentes completas",
  pricePolicies: "Tarifas", commercialPacks: "Packs comerciales", commercialPromotions: "Promociones", historicalPromotionCount: "Promociones históricas", replacementQuoteCount: "Cotizaciones de reemplazo", scenarioCalculations: "Proyecciones de escenarios", proposalsAreNotBookedActuals: "Las propuestas no son movimientos realizados", horizon: "Horizonte", weekly: "Resumen semanal", attestation: "Conciliación de fuentes", sourceCoverage: "Cobertura de fuentes", verifiedObligationsByIdentity: "Obligaciones verificadas por compromiso", pendingObligationsByIdentity: "Obligaciones pendientes por compromiso", clubAccounts: "Cuentas del club", custodyAccounts: "Cuentas de custodia", cashPathState: "Estado de la proyección de caja", currenciesCombined: "Monedas combinadas",
  metrics: "Métricas", value: "Valor", state: "Estado", reason: "Motivo", dateRange: "Período consultado", currency: "Moneda", minor: "Importe", amountByCurrency: "Importe por moneda", monthlyScheduleByCurrency: "Costo mensual aprobado por moneda", periodCoverage: "Cobertura del período", monthlyScheduleMinor: "Costo mensual", amountMinor: "Importe", amount: "Importe", count: "Cantidad", total: "Total", expectedCount: "Filas esperadas", knownCount: "Filas conocidas", queryComplete: "Consulta completa", sourcePeriodCompletenessAttested: "Período conciliado documentalmente", arithmeticCompleteForObservedRecords: "Cálculo completo para los registros observados", pendingCostCount: "Costos pendientes de clasificar", classifiedCostCount: "Costos clasificados", costQueryComplete: "Consulta completa de costos", unresolvedChargeOrderCount: "Pedidos con cargos pendientes", costRecognition: "Criterio de reconocimiento de costos", chargeRecognition: "Criterio de cargos de entrega",
};

const REPORT_WORD_LABELS: Record<string, string> = {
  order: "pedido",
  orders: "pedidos",
  line: "línea",
  lines: "líneas",
  member: "socio",
  members: "socios",
  count: "cantidad",
  total: "total",
  currency: "moneda",
  currencies: "monedas",
  by: "por",
  net: "neto",
  revenue: "ingreso",
  revenues: "ingresos",
  sale: "venta",
  sales: "ventas",
  product: "producto",
  contribution: "contribución",
  management: "gestión",
  gross: "bruto",
  fixed: "fijo",
  variable: "variable",
  cost: "costo",
  costs: "costos",
  payable: "obligación",
  payables: "obligaciones",
  accrued: "devengado",
  paid: "pagado",
  verified: "verificado",
  unverified: "sin verificar",
  open: "pendiente",
  pending: "pendiente",
  historical: "histórico",
  operational: "operativo",
  delivery: "entrega",
  deliveries: "entregas",
  collection: "cobro",
  collections: "cobros",
  report: "informe",
  reports: "informes",
  account: "cuenta",
  accounts: "cuentas",
  balance: "saldo",
  balances: "saldos",
  lot: "lote",
  lots: "lotes",
  allocation: "asignación",
  allocations: "asignaciones",
  actual: "real",
  approved: "aprobado",
  recognized: "reconocido",
  period: "período",
  source: "fuente",
  sources: "fuentes",
  coverage: "cobertura",
  state: "estado",
  status: "estado",
  number: "número",
  date: "fecha",
  range: "rango",
  expense: "gasto",
  expenses: "gastos",
  purchase: "compra",
  purchases: "compras",
  receipt: "recepción",
  receipts: "recepciones",
  inventory: "inventario",
  stock: "stock",
  cash: "efectivo",
  ledger: "libro",
  movement: "movimiento",
  movements: "movimientos",
  reconciliation: "conciliación",
  reconciliations: "conciliaciones",
  segment: "segmento",
  segmentation: "segmentación",
  scenario: "escenario",
  scenarios: "escenarios",
  promotion: "promoción",
  promotions: "promociones",
  pack: "pack",
  packs: "packs",
  policy: "política",
  policies: "políticas",
  known: "conocidas",
  expected: "esperadas",
  complete: "completa",
  completeness: "completitud",
  error: "error",
  exception: "excepción",
  exceptions: "excepciones",
  missing: "faltante",
  available: "disponible",
  reserved: "reservado",
  physical: "físico",
  preparation: "preparación",
  custody: "custodia",
  location: "ubicación",
  custodian: "custodio",
  formula: "fórmula",
  method: "método",
  bycurrency: "por moneda",
  unlinked: "sin vínculo",
  statusfor: "estado para",
  historicalsources: "fuentes históricas",
  unlinkedhistorical: "histórico sin vínculo",
  after: "después",
  before: "antes",
  accountscoped: "en alcance de cuenta",
  invalid: "inválido",
  incomplete: "incompleto",
  validated: "validado",
  paired: "conciliado",
  transfer: "transferencia",
  fx: "cambio",
  event: "evento",
  events: "eventos",
  accepted: "aceptado",
  rendition: "rendición",
  renditions: "rendiciones",
  excess: "excedente",
  current: "actual",
  active: "activo",
  reservation: "reserva",
  reservations: "reservas",
  byunit: "por unidad",
  bylot: "por lote"
};

const REPORT_ENUM_LABELS: Record<string, string> = {
  pending_definition: "Pendiente de definición", "captured-components-not-a-calculated-invoice-total": "Valores capturados; fórmula del total pendiente", "captured-base-is-invalid-or-missing": "Referencia capturada inválida o ausente", "captured-product-lines-are-exposed-separately-until-invoice-total-is-defined": "Productos capturados separados hasta definir el total de factura",
  preorder: "Preventa", planned: "Programado", unprepared: "Sin preparar", partially_prepared: "Preparación parcial", prepared: "Preparado", partially_delivered: "Entrega parcial", unpaid: "Sin cobros verificados", partially_paid: "Cobro parcial", paid: "Pagado", rejected: "Rechazado", closed_with_pending: "Cerrado con pendientes",
  cash: "Caja", bank: "Banco", reserve: "Reserva", custody: "Custodia", approved_opening_and_events: "Apertura y movimientos aprobados", opening_pending: "Apertura pendiente", operating_expense: "Gasto operativo", courier_fee: "Remuneración del repartidor", purchase: "Compra", asset_purchase: "Compra de activo", owner_withdrawal: "Retiro del propietario", other: "Otro",
  partial: "Parcial", unknown: "Desconocido", unverified: "Observado · sin verificar", reconciled: "Conciliado", estimated: "Estimado", scenario: "Escenario", missing: "Sin dato", complete: "Completo", excluded: "Excluido", approved: "Aprobado", pending: "Pendiente", reported: "Informado", verified: "Verificado", staged: "En preparación", draft: "Borrador", confirmed: "Confirmado", cancelled: "Cancelado", dispatched: "Despachado", delivered: "Entregado", blocked: "Bloqueado", active: "Activo", inactive: "Inactivo", attested: "Conciliado y vigente", stale: "Conciliación desactualizada", incomplete: "Lectura de fuentes incompleta", scope_excluded: "Excluido por alcance parcial", "unknown-in-source-schema": "Moneda desconocida en el esquema de origen", "source-period-completeness-not-attested": "El período de origen aún no está conciliado", "cost-allocation-or-charge-coverage-pending": "Pendiente la cobertura de costos o cargos", "no-current-approved-scenario": "No hay escenarios aprobados vigentes", "calculated-from-approved-versioned-cash-inputs": "Calculado desde supuestos de caja aprobados", "approved-schedule-does-not-cover-whole-accrual-period": "El cronograma aprobado no cubre todo el período devengado", "unclassified-treatment-or-invalid-credit-balance": "Clasificación pendiente o saldo de crédito inválido",
};

const REPORT_AREAS: Record<string, { title: string; grain: string; guidance: string }> = {
  "sales-revenue": { title: "Ventas e ingresos", grain: "Pedidos confirmados y sus renglones", guidance: "Las ventas históricas se mantienen separadas de los pedidos del club. Ingreso de producto, total del pedido, cobros verificados y movimientos de caja son conceptos distintos." },
  "product-contribution": { title: "Contribución por producto", grain: "Renglón entregado y costo del lote", guidance: "El cálculo usa ingresos netos, costo asignado al lote y obligaciones variables devengadas verificadas. Los pagos en efectivo no vuelven a reconocer el mismo costo." },
  "operating-expenses": { title: "Gastos operativos", grain: "Obligación devengada y pago por separado", guidance: "La obligación reconocida y su pago se informan por separado. Las compras de inventario y las inversiones no se clasifican como gasto operativo." },
  purchases: { title: "Compras y costos de ingreso", grain: "Recepción, renglón de compra y lote", guidance: "La cantidad recibida y su evidencia determinan el ingreso a stock. Ordenar mercadería no equivale a recibirla, y pagarla no la expensa dos veces." },
  inventory: { title: "Inventario por lote", grain: "SKU, lote, ubicación y custodia", guidance: "Los saldos, reservas y cantidades todavía en preparación o reparto conservan bases separadas y unidades explícitas." },
  "cash-ledger": { title: "Caja y bancos", grain: "Movimiento y conciliación por cuenta", guidance: "Los saldos se separan por cuenta y moneda. Los reportes de cobro no son por sí mismos movimientos conciliados." },
  "delivery-collections": { title: "Entregas, cobros y rendiciones", grain: "Entrega, cobro informado y rendición aceptada", guidance: "Informar, verificar y rendir son pasos diferentes. El excedente y la remuneración permanecen separados del dinero entregado." },
  "fx-reconciliation": { title: "Conciliación de cambios", grain: "Conversión registrada con sus movimientos", guidance: "Cada moneda conserva sus importes y las diferencias requieren evidencia; no se combinan monedas automáticamente." },
  "customer-segmentation": { title: "Segmentación de socios", grain: "Socio vigente al día de análisis", guidance: "La segmentación describe actividad observada. No habilita promociones, beneficios ni permisos." },
  "commercial-scenarios": { title: "Escenarios comerciales", grain: "Tarifas aprobadas y supuestos de caja", guidance: "Las propuestas y proyecciones no son ventas, deudas, ingresos ni movimientos realizados." },
  "obligations-13-weeks": { title: "Obligaciones a 13 semanas", grain: "Obligación verificada por fecha de vencimiento", guidance: "Las obligaciones pendientes y aprobadas permanecen diferenciadas. La proyección de caja no equivale a una certificación de liquidez." },
};

function reportAreaLabel(area: string): string { return REPORT_AREAS[area]?.title ?? "Informe operativo"; }
function reportGrain(area: string): string { return REPORT_AREAS[area]?.grain ?? "Detalle de registros incluidos"; }
function reportGuidance(area: string): string { return REPORT_AREAS[area]?.guidance ?? "Revisá los datos y la cobertura informada antes de interpretar el resultado."; }
function reportStateLabel(value: unknown): string {
  const text = textValue(value, "Sin estado");
  return REPORT_ENUM_LABELS[text] ?? REPORT_ENUM_LABELS[text.toLowerCase()] ?? text.replaceAll(/[-_]/g, " ");
}
function reportSourceLabel(value: string): string {
  if (value === "pending-appsheet-invoice-segmentation-inputs") return "Facturas pendientes que impiden completar la segmentación";
  if (value === "pending-appsheet-invoice-captures") return "Facturas capturadas con cálculo pendiente";
  if (value === "pending-appsheet-captured-product-lines") return "Productos con facturación pendiente de definición";
  const exact: Record<string, string> = { "delivered-operation-order-lines": "Renglones entregados del club", "preparation-allocations": "Asignaciones de lotes", "approved-fixed-cost-configuration": "Configuración aprobada de costos fijos", "historical-delivery-sales": "Ventas históricas de reparto", "operation-orders": "Pedidos del club", "historical-expenses": "Gastos históricos", "compatibility-expenses": "Gastos de registros anteriores", "operating-payables": "Obligaciones operativas", "purchase-orders": "Órdenes de compra", "goods-receipts": "Recepciones de mercadería", "historical-purchase-receipts": "Recepciones históricas", "purchase-payables": "Obligaciones de compra", "collection-reports": "Reportes de cobro", "delivery-assignments": "Asignaciones de reparto", "accepted-renditions": "Rendiciones aceptadas", "fx-ledger-events": "Movimientos de cambio", "fx-events-with-complete-recorded-legs-and-metadata": "Cambios con movimientos y evidencia completos", "operation-members": "Socios del club", "confirmed-orders-for-segmentation": "Pedidos usados para segmentación", "customer-return-allocations": "Devoluciones de clientes", "unlinked-historical-delivery-sales": "Ventas históricas sin vínculo a socio", "commercial-policy-records": "Tarifas y políticas comerciales", "historical-promotions": "Promociones históricas", "13-week-payables": "Obligaciones del horizonte de 13 semanas", "club-and-custody-accounts": "Cuentas del club y de custodia" };
  return exact[value] ?? metricLabel(value);
}
function reportReasonLabel(value: string): string { if (value === "pending-invoice-total-definition-prevents-complete-spend-classification") return "Falta definir el total de factura para completar el historial de gasto"; return REPORT_ENUM_LABELS[value] ?? value.replaceAll(/[-_]/g, " "); }
function metricLabel(value: string): string {
  if (REPORT_METRIC_LABELS[value]) return REPORT_METRIC_LABELS[value];
  const tokens = value.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll(/[-_]/g, " ").split(/\s+/).filter(Boolean);
  return tokens.map(token => REPORT_WORD_LABELS[token.toLowerCase()] ?? token).join(" ");
}
function metricScalar(value: unknown, key: string, currency?: unknown): string {
  if (value === null || value === undefined) return "Sin dato";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (key.toLowerCase().includes("minor") || key === "minor" || key === "amountMinor") return formatMinor(value, currency);
  if (key === "state" || key === "status" || key === "queryState" || key === "reason" || key.toLowerCase().includes("status") || key.toLowerCase().endsWith("state")) return reportStateLabel(value);
  if (key === "currency" && typeof value === "string") return value === "ARS" ? "Pesos argentinos · ARS" : value === "USD" ? "Dólares estadounidenses · USD" : value;
  if (typeof value === "string" && REPORT_ENUM_LABELS[value]) return REPORT_ENUM_LABELS[value];
  return String(value);
}

function MetricValueView({ label, value, depth = 0 }: { label: string; value: unknown; depth?: number }) {
  if (Array.isArray(value)) return <MetricArrayView label={label} values={value} depth={depth} />;
  if (value && typeof value === "object") {
    const row = value as Row;
    if ("minor" in row && ("currency" in row || Object.keys(row).every(key => key === "minor"))) return <div className="ops-count-block"><span>{metricLabel(label)}</span><strong>{formatMinor(row.minor, row.currency)}</strong></div>;
    const entries = Object.entries(row);
    if (entries.length && entries.every(([key, item]) => (key === "ARS" || key === "USD") && (typeof item === "string" || typeof item === "number" || item === null))) return <section className="ops-sheet ops-currency-sheet"><div className="ops-sheet-head"><div><span className="ops-kicker">Por moneda</span><h4>{metricLabel(label)}</h4></div></div><div className="ops-currency-grid">{entries.map(([currency, amount]) => <div className="ops-currency-item" key={currency}><span>{currency}</span><strong>{formatMinor(amount, currency)}</strong></div>)}</div></section>;
    return <details className="ops-report-metric-group" open={depth === 0}><summary>{metricLabel(label)} · {entries.length} campos</summary><div className="ops-count-grid ops-metric-grid">{entries.map(([key, child]) => <MetricValueView key={key} label={key} value={child} depth={depth + 1} />)}</div></details>;
  }
  return <div className="ops-count-block"><span>{metricLabel(label)}</span><strong>{metricScalar(value, label)}</strong></div>;
}

function MetricArrayView({ label, values, depth }: { label: string; values: unknown[]; depth: number }) {
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const pageCount = Math.max(1, Math.ceil(values.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = values.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const objectRows = visible.map(value => value && typeof value === "object" && !Array.isArray(value) ? value as Row : null);
  const columns = [...new Set(objectRows.flatMap(row => row ? Object.keys(row) : []))];
  return <details className="ops-report-array"><summary>{metricLabel(label)} · {values.length} registros</summary>
    {values.length === 0 ? <p className="ops-home-muted">Sin registros para mostrar.</p> : <>
      {objectRows.every(row => row !== null) ? <DataTable label={metricLabel(label)}><thead><tr>{columns.map(key => <th key={key} scope="col">{metricLabel(key)}</th>)}</tr></thead><tbody>{visible.map((item, index) => { const row = item as Row; return <tr key={textValue(row.id, `${safePage}-${index}`)}>{columns.map(key => <td key={key}><MetricCell label={key} value={row[key]} depth={depth + 1} currency={row.currency} /></td>)}</tr>; })}</tbody></DataTable>
        : <DataTable label={metricLabel(label)}><thead><tr><th scope="col">#</th><th scope="col">Valor</th></tr></thead><tbody>{visible.map((item, index) => <tr key={`${safePage}-${index}`}><td>{safePage * pageSize + index + 1}</td><td><MetricCell label={label} value={item} depth={depth + 1} /></td></tr>)}</tbody></DataTable>}
      {pageCount > 1 && <div className="ops-report-pagination"><button className="ops-button ops-button-quiet ops-button-small" type="button" disabled={safePage === 0} onClick={() => setPage(Math.max(0, safePage - 1))}>Anterior</button><span>Página {safePage + 1} de {pageCount}</span><button className="ops-button ops-button-quiet ops-button-small" type="button" disabled={safePage + 1 >= pageCount} onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}>Siguiente</button></div>}
    </>}
  </details>;
}

function MetricCell({ label, value, depth, currency }: { label: string; value: unknown; depth: number; currency?: unknown }) {
  if (Array.isArray(value) || (value !== null && typeof value === "object")) return <details className="ops-line-details"><summary>{Array.isArray(value) ? `${value.length} registros · detalle` : "Ver detalle"}</summary><MetricValueView label={label} value={value} depth={depth} /></details>;
  return <span>{metricScalar(value, label, currency)}</span>;
}

function PricingReference({ policies, packs, promotions }: { policies: Row[]; packs: Row[]; promotions: Row[] }) {
  if (!policies.length && !packs.length && !promotions.length) return <InfoBand tone="info" title="Precios y promociones"><p>Todavía no hay tarifas, packs o promociones aprobados para tu cuenta. Para cotizar con un precio manual, indicá el motivo en cada producto.</p></InfoBand>;
  return <details className="ops-sheet ops-reference-sheet"><summary><span><span className="ops-kicker">Referencia al cotizar</span><strong>Versiones comerciales aprobadas</strong></span><span>{policies.length + packs.length + promotions.length} disponibles</span></summary>
    {policies.length > 0 && <div className="ops-reference-group"><h3>Tarifas</h3>{policies.map(policy => { const def = recordValue(policy, "definition") as Row | undefined; const tiers = Array.isArray(def?.tiers) ? def.tiers as Row[] : []; return <article className="ops-reference-item" key={idOf(policy)}><strong>{labelOf(policy)}</strong><code>{idOf(policy)}</code><span>v{textValue(policy.version)} · {textValue(policy.currency)}</span>{tiers.map((tier, index) => <small key={index}>SKU {textValue(tier.skuId)} · mínimo {textValue(tier.minQuantity)} · escala {textValue(tier.scale)} · precio {textValue(tier.unitPrice)}</small>)}</article>; })}</div>}
    {packs.length > 0 && <div className="ops-reference-group"><h3>Packs</h3>{packs.map(pack => <article className="ops-reference-item" key={idOf(pack)}><strong>{labelOf(pack)}</strong><code>{idOf(pack)}</code><span>v{textValue(pack.version)} · {textValue(pack.currency)} · {formatMinor(pack.priceMinor, pack.currency)}</span></article>)}</div>}
    {promotions.length > 0 && <div className="ops-reference-group"><h3>Promociones</h3>{promotions.map(promotion => <article className="ops-reference-item" key={idOf(promotion)}><strong>{labelOf(promotion)}</strong><code>{idOf(promotion)}</code><span>v{textValue(promotion.version)}</span></article>)}</div>}
  </details>;
}
