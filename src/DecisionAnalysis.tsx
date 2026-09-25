import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import "./decision-analysis.css";

export type DecisionAnalysisSection = "stock" | "commercial" | "cash" | "members";

export interface DecisionAnalysisProps {
  /** Select a view when the parent owns route state. */
  section?: DecisionAnalysisSection;
}

type DataRecord = Record<string, unknown>;
type ImportedCategory = "delivery" | "receipts" | "cash" | "expenses" | "observations" | "stockouts" | "promotions" | "members";
type ImportedRow = { category: ImportedCategory; count: unknown; sums: Array<{ label: string; value: unknown; unit: "cents" | "milliunits" }> };

const sectionOrder: DecisionAnalysisSection[] = ["stock", "commercial", "cash", "members"];
const sectionLabels: Record<DecisionAnalysisSection, string> = {
  stock: "Stock",
  commercial: "Comercial",
  cash: "Caja",
  members: "Socios",
};
const sectionDescriptions: Record<DecisionAnalysisSection, string> = {
  stock: "Lotes locales, demanda observada, vencimientos y límites de reposición.",
  commercial: "Resultado local del mes, delivery importado y economía de promociones.",
  cash: "Proyecciones de caja separadas de los movimientos importados y una simulación laboral.",
  members: "Segmentos descriptivos y colas de revisión humana, sin datos de contacto.",
};
const analysisTitles: Record<DecisionAnalysisSection, string> = {
  stock: "Análisis de stock", commercial: "Precios y promociones",
  cash: "Análisis de caja", members: "Segmentos de socios",
};
const analysisPaths: Record<DecisionAnalysisSection, string> = {
  stock: "/app/decisiones/stock", commercial: "/app/decisiones/comercial",
  cash: "/app/decisiones/caja", members: "/app/decisiones/socios",
};

const wholeArs = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });
const wholeNumber = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 });
const decimalMark = new Intl.NumberFormat("es-AR").formatToParts(1.1).find((part) => part.type === "decimal")?.value || ",";

function isRecord(value: unknown): value is DataRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): DataRecord {
  return isRecord(value) ? value : {};
}

function asRecords(value: unknown): DataRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function nonNegativeOrSignedCents(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}

function integerCount(value: unknown): bigint | null {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    try { return BigInt(value); } catch { return null; }
  }
  return null;
}

function milliunitInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) {
    try { return BigInt(value); } catch { return null; }
  }
  return null;
}

function formatCents(value: unknown): string {
  const cents = nonNegativeOrSignedCents(value);
  if (cents === null) return value == null ? "Sin dato" : "Importe sin formato de centavos";
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = wholeArs.format(absolute / 100n);
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "−" : ""}${whole}${decimalMark}${fraction}`;
}

function formatCount(value: unknown): string {
  const count = integerCount(value);
  return count === null ? (value == null ? "Sin dato" : "Dato no disponible") : wholeNumber.format(count);
}

function formatMilliunits(value: unknown, unit?: unknown): string {
  const milliunits = milliunitInteger(value);
  if (milliunits === null) return value == null ? "Sin dato" : "Cantidad no disponible";
  const negative = milliunits < 0n;
  const absolute = negative ? -milliunits : milliunits;
  const whole = wholeNumber.format(absolute / 1000n);
  const fraction = (absolute % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  const amount = fraction ? `${whole}${decimalMark}${fraction}` : whole;
  const suffix = typeof unit === "string" && unit.trim() ? ` ${unit.trim()}` : "";
  return `${negative ? "−" : ""}${amount}${suffix}`;
}

function formatBasisPoints(value: unknown): string | null {
  const basisPoints = integerCount(value);
  if (basisPoints === null) return null;
  return `${wholeNumber.format(basisPoints / 100n)}${decimalMark}${(basisPoints % 100n).toString().padStart(2, "0")}%`;
}

function displayText(value: unknown, fallback = "Sin informar"): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Sí" : "No";
  return fallback;
}

function formatDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "Sin fecha informada";
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(isDateOnly ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-AR", {
    day: "numeric", month: "short", year: "numeric",
    ...(isDateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(date);
}

function formatMonth(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return displayText(value);
  const date = new Date(`${value}-01T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(date);
}

function coverageLabel(value: unknown): string {
  if (value === "complete") return "Completa";
  if (value === "partial") return "Parcial";
  if (value === "unknown") return "Desconocida";
  if (value === "missing") return "Faltante";
  return displayText(value, "Sin informar");
}

function coverageTone(value: unknown): string {
  if (value === "complete" || value === "reconciled") return "good";
  if (value === "missing" || value === "unknown") return "caution";
  return "partial";
}

function isDecisionSection(value: unknown): value is DecisionAnalysisSection {
  return typeof value === "string" && sectionOrder.includes(value as DecisionAnalysisSection);
}

function sectionFromUrl(): DecisionAnalysisSection {
  if (typeof window === "undefined") return "stock";
  const valid = (value: string | null): value is DecisionAnalysisSection => isDecisionSection(value);
  const query = new URLSearchParams(window.location.search).get("section");
  if (valid(query)) return query;
  const hashValue = window.location.hash.replace(/^#(?:section=)?/, "");
  if (valid(hashValue)) return hashValue;
  const lastPathPart = window.location.pathname.split("/").filter(Boolean).at(-1) || "";
  return valid(lastPathPart) ? lastPathPart : "stock";
}

async function requestJson(path: string, init?: RequestInit): Promise<DataRecord> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    ...init,
  });
  let body: unknown = null;
  try { body = await response.json(); } catch { /* An empty error body is reported below. */ }
  if (!response.ok) {
    const errorBody = asRecord(body);
    throw new Error(displayText(errorBody.error, `La solicitud falló (${response.status}).`));
  }
  return asRecord(body);
}

function toCurrencyCents(raw: string, label: string): string {
  const value = raw.trim().replace(",", ".");
  if (!value || !/^\d+(?:\.\d{1,2})?$/.test(value))
    throw new Error(`${label}: ingresá un importe positivo o cero, con hasta dos decimales.`);
  const [whole, fraction = ""] = value.split(".");
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0")).toString();
}

function toMilliunits(raw: string, label: string): number {
  const value = raw.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,3})?$/.test(value)) throw new Error(`${label}: ingresá una cantidad con hasta tres decimales.`);
  const [whole, fraction = ""] = value.split(".");
  const milliunits = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0") || "0");
  if (milliunits <= 0n || milliunits > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}: la cantidad debe ser mayor que cero y estar dentro del límite permitido.`);
  return Number(milliunits);
}

function toBasisPoints(raw: string, label: string): number {
  const value = raw.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error(`${label}: ingresá un porcentaje con hasta dos decimales.`);
  const [whole, fraction = ""] = value.split(".");
  const basisPoints = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
  if (basisPoints > 10_000n) throw new Error(`${label}: el porcentaje máximo es 100%.`);
  return Number(basisPoints);
}

function getText(record: DataRecord, key: string, fallback = "Sin dato"): string {
  return displayText(record[key], fallback);
}

function getValueLabel(key: string): string {
  const labels: Record<string, string> = {
    netSalesCents: "Ventas netas observadas",
    historicalCogsCents: "Costo histórico vendido",
    accruedOperatingExpensesCents: "Gastos operativos devengados",
    operatingResultCents: "Resultado operativo completo",
    observedOperatingResultCents: "Resultado aritmético observado",
    inventoryAcquisitionsCents: "Adquisiciones de inventario",
    pointCents: "Estimación central",
    maeCents: "Error absoluto medio (backtest)",
    biasCents: "Sesgo observado (backtest)",
    contributionCents: "Contribución estimada",
    contributionDifferenceCents: "Diferencia frente a referencia",
    monthlyIncrementalContributionNeededCents: "Contribución mensual necesaria",
    cashFloorCents: "Piso de caja ingresado",
  };
  return labels[key] || key.replace(/Cents$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function statusLabel(value: unknown): string {
  const labels: Record<string, string> = {
    ready: "Lista con supuestos actuales",
    cash_limited: "Limitada por caja",
    blocked: "Bloqueada por evidencia faltante",
    unknown: "Desconocido",
    expired: "Vencido",
    due_soon: "Próximo a vencer",
    not_due: "Sin alerta de vencimiento",
    available: "Disponible",
    recent: "Reciente",
    cooling: "En enfriamiento",
    lapsed: "Inactivo",
    never: "Sin compras",
    none: "Sin compras",
    low: "Bajo",
    medium: "Medio",
    high: "Alto",
    unavailable: "No disponible",
    no_increment_needed: "No requiere órdenes incrementales según este cálculo",
    incremental_volume_required: "Requiere volumen incremental bajo estos supuestos",
    unreachable_nonpositive_contribution: "Sin equilibrio con contribución promocionada no positiva",
    not_compared: "Sin escenario de referencia",
    "incomplete-source": "Fuente incompleta",
    "insufficient-history": "Historial insuficiente",
    "date-gap": "Hay días faltantes en la serie",
    "missing-reconciled-opening-balance": "Falta saldo inicial conciliado",
    "incomplete-scenario-input": "Faltan supuestos completos",
    unavailable_without_reconciled_balance_and_complete_assumptions: "No disponible: faltan saldo conciliado y supuestos completos",
  };
  return typeof value === "string" ? labels[value] || value.replaceAll("_", " ") : "Sin informar";
}

const reorderReasonLabels: Record<string, string> = {
  shared_stock_mapping_unknown: "Mapeo de stock local y delivery pendiente",
  unassigned_inventory_location: "Hay inventario sin ubicación asignada",
  unassigned_inbound_location: "Hay ingreso pendiente sin ubicación",
  overdue_inbound_uncertain: "Ingreso vencido con recepción incierta",
  demand_unknown: "Demanda insuficiente o desconocida",
  no_observed_demand: "Sin demanda observada",
  lead_time_unknown: "Plazo del proveedor no validado",
  replacement_quote_unavailable: "Falta cotización de reposición utilizable",
  cash_position_unknown: "Saldo disponible sin conciliar",
  cash_floor_protected: "La compra protegería el piso de caja",
  order_date_out_of_range: "La fecha de pedido está fuera del horizonte",
};

function sourceStateText(state: unknown): string {
  if (state === "missing") return "Faltan importaciones históricas aceptadas";
  if (state === "demo") return "Datos de demostración";
  if (state === "imported") return "Importaciones presentes, pendientes de conciliación";
  if (state === "reconciled") return "Hay fuentes conciliadas";
  return displayText(state, "Estado de fuente desconocido");
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const importedCategories: Array<{ id: ImportedCategory; label: string; keys: string[] }> = [
  { id: "delivery", label: "Ventas históricas de delivery", keys: ["deliverysales", "deliverysale", "historicaldeliverysales", "historicaldeliverysale", "delivery"] },
  { id: "receipts", label: "Recepciones de compras", keys: ["purchasereceipts", "purchasereceipt", "receipts", "receipt", "stockreceipts"] },
  { id: "cash", label: "Movimientos de caja importados", keys: ["cashmovements", "cashmovement", "cashentries", "cashentry"] },
  { id: "expenses", label: "Gastos importados", keys: ["expenses", "expense", "historicalexpenses"] },
  { id: "observations", label: "Observaciones históricas de stock", keys: ["stockobservations", "stockobservation", "observations"] },
  { id: "stockouts", label: "Quiebres de stock importados", keys: ["stockouts", "stockout", "outofstock"] },
  { id: "promotions", label: "Promociones históricas", keys: ["promotions", "promotion", "historicalpromotions"] },
  { id: "members", label: "Socios importados", keys: ["members", "member", "historicalmembers"] },
];

function categoryFromKey(key: string): ImportedCategory | null {
  const normalized = normalizeKey(key);
  return importedCategories.find((category) => category.keys.some((candidate) => normalized === candidate || normalized.startsWith(candidate)))?.id || null;
}

function importedInteger(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) {
    try { return BigInt(value); } catch { return null; }
  }
  return null;
}

function importedHistoryRows(value: unknown): ImportedRow[] {
  const buckets = new Map<ImportedCategory, ImportedRow>();
  const bucketFor = (category: ImportedCategory) => {
    let bucket = buckets.get(category);
    if (!bucket) {
      bucket = { category, count: null, sums: [] };
      buckets.set(category, bucket);
    }
    return bucket;
  };
  const addMetric = (category: ImportedCategory, key: string, metric: unknown) => {
    const bucket = bucketFor(category);
    const normalized = normalizeKey(key);
    if (/(count|records|rows)$/.test(normalized)) {
      if (bucket.count == null) bucket.count = metric;
      return;
    }
    if (/cents$/.test(normalized)) {
      const label = key.replace(/Cents$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2") || "Importe";
      const existing = bucket.sums.find((sum) => sum.label === label && sum.unit === "cents");
      const amount = importedInteger(metric);
      const previous = existing ? importedInteger(existing.value) : null;
      if (existing && amount !== null && previous !== null) existing.value = (previous + amount).toString();
      else bucket.sums.push({ label, value: metric, unit: "cents" });
      return;
    }
    if (/milliunits$/.test(normalized)) {
      const label = key.replace(/Milliunits$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2") || "Cantidad";
      const existing = bucket.sums.find((sum) => sum.label === label && sum.unit === "milliunits");
      const amount = importedInteger(metric);
      const previous = existing ? importedInteger(existing.value) : null;
      if (existing && amount !== null && previous !== null) existing.value = (previous + amount).toString();
      else bucket.sums.push({ label, value: metric, unit: "milliunits" });
    }
  };
  const walk = (node: unknown, activeCategory: ImportedCategory | null = null, depth = 0) => {
    if (depth > 7) return;
    if (Array.isArray(node)) {
      if (activeCategory) {
        bucketFor(activeCategory).count ??= node.length;
        for (const item of node) if (isRecord(item) || Array.isArray(item)) walk(item, activeCategory, depth + 1);
      }
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const matchedCategory = categoryFromKey(key) || activeCategory;
      if (categoryFromKey(key)) {
        if (Array.isArray(child)) walk(child, matchedCategory, depth + 1);
        else if (isRecord(child)) walk(child, matchedCategory, depth + 1);
        else {
          const normalizedKey = normalizeKey(key);
          if (/cents$|milliunits$|count$|records$|rows$/.test(normalizedKey)) addMetric(matchedCategory!, key, child);
          else addMetric(matchedCategory!, "count", child);
        }
        continue;
      }
      if (activeCategory) {
        if (isRecord(child) || Array.isArray(child)) walk(child, activeCategory, depth + 1);
        else addMetric(activeCategory, key, child);
        continue;
      }
      const flattenedCategory = categoryFromKey(key);
      if (flattenedCategory) addMetric(flattenedCategory, key, child);
      else if (isRecord(child)) walk(child, null, depth + 1);
    }
  };
  walk(value);
  return importedCategories.map((category) => buckets.get(category.id)).filter((row): row is ImportedRow => row !== undefined);
}

function csvCell(value: unknown): string {
  const raw = typeof value === "string" ? value : value == null ? "" : String(value);
  return `"${raw.replaceAll('"', '""')}"`;
}

function downloadDeliveryCsv(count: unknown, revenueCents: unknown) {
  const csv = [
    ["fuente", "alcance", "ventas", "ingresos_centavos_ARS", "conciliacion"].map(csvCell).join(","),
    ["delivery histórico importado", "resumen agregado; no contiene transacciones individuales", count == null ? "" : String(count),
      typeof revenueCents === "string" && /^-?\d+$/.test(revenueCents) ? revenueCents : "", "pendiente de conciliación"].map(csvCell).join(","),
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "delivery-historico-resumen-no-conciliado.csv";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function StatusPill({ children, tone = "partial" }: { children: ReactNode; tone?: string }) {
  return <span className={`da-pill da-pill--${tone}`}>{children}</span>;
}

function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="da-empty"><strong>{title}</strong><p>{children}</p></div>;
}

function ImportedHistoryPanel({ value }: { value: unknown }) {
  const rows = importedHistoryRows(value);
  return (
    <section className="da-imported" aria-labelledby="da-imported-title">
      <div className="da-section-heading">
        <div><span className="da-kicker">FUENTE APARTE</span><h2 id="da-imported-title">Historial importado · sin verificar</h2></div>
        <StatusPill tone="caution">No se suma al stock ni a la caja local</StatusPill>
      </div>
      {value == null ? (
        <p className="da-muted">Esta respuesta todavía no incluye el resumen <code>importedHistory</code>. Las fuentes importadas se mostrarán aquí cuando el servidor las entregue.</p>
      ) : rows.length === 0 ? (
        <p className="da-muted">No hay conteos o sumas reconocibles en <code>importedHistory</code>. Se conserva separado hasta tener una estructura interpretable.</p>
      ) : (
        <div className="da-table-wrap">
          <table>
            <caption>Conteos y sumas importados, aún no conciliados con los datos operativos locales.</caption>
            <thead><tr><th scope="col">Fuente</th><th scope="col">Registros</th><th scope="col">Sumas recibidas</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.category}>
                <th scope="row">{importedCategories.find((category) => category.id === row.category)?.label || row.category}</th>
                <td>{formatCount(row.count)}</td>
                <td>{row.sums.length ? row.sums.map((sum, index) => (
                  <span className="da-imported-sum" key={`${sum.label}-${index}`}><span>{sum.label || "Suma"}</span><strong>{sum.unit === "cents" ? formatCents(sum.value) : formatMilliunits(sum.value)}</strong></span>
                )) : "Sin suma informada"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="da-footnote">El historial conserva su procedencia. Las ventas locales, los lotes actuales y los saldos proyectados siguen separados.</p>
    </section>
  );
}

function SourceStatePanel({ value }: { value: unknown }) {
  const state = asRecord(value);
  return (
    <section className="da-source-state" aria-label="Estado de las fuentes históricas">
      <div className="da-source-state__summary"><span className="da-kicker">ESTADO DE FUENTES</span><strong>{sourceStateText(state.state)}</strong></div>
      <dl>
        <div><dt>Importaciones aceptadas</dt><dd>{formatCount(state.committed)}</dd></div>
        <div><dt>Conciliaciones registradas</dt><dd>{formatCount(state.reconciled)}</dd></div>
        <div><dt>Importaciones rechazadas</dt><dd>{formatCount(state.rejected)}</dd></div>
      </dl>
    </section>
  );
}

function Coverage({ value }: { value: unknown }) {
  const source = asRecord(value);
  const entries = Object.entries(source);
  if (!entries.length) return <p className="da-footnote">Cobertura de fuente: sin informar.</p>;
  return <dl className="da-coverage">{entries.map(([key, coverage]) => (
    <div key={key}><dt>{getValueLabel(key)}</dt><dd><StatusPill tone={coverageTone(coverage)}>{coverageLabel(coverage)}</StatusPill></dd></div>
  ))}</dl>;
}

function InventoryView({ data }: { data: DataRecord }) {
  const inventory = asRecord(data.inventory);
  const commerce = asRecord(inventory.commerce);
  const lots = asRecords(inventory.lots);
  const lotPositions = asRecords(commerce.inventoryByLotLocationSupplier);
  const lotPositionByKey = new Map(lotPositions.map((row) => [`${String(row.productId || "")}:${String(row.lotId || "")}`, row]));
  const demandRows = asRecords(commerce.demandByProduct);
  const demandByProduct = new Map(demandRows.map((row) => [String(row.productId || ""), row]));
  const reorderRows = asRecords(commerce.reorderDecisions);
  const reorderByProduct = new Map(reorderRows.map((row) => [String(row.productId || ""), row]));
  const probabilityAvailable = demandRows.some((row) => formatBasisPoints(row.stockoutProbabilityBasisPoints) !== null);
  const mapping = asRecord(commerce.fulfillmentMapping);
  const observedLeadTimes = asRecords(inventory.observedSupplierLeadTimes);
  const limitations = Array.isArray(data.limitations) ? data.limitations.filter((item): item is string => typeof item === "string") : [];

  return (
    <div className="da-view">
      <div className="da-metric-grid">
        <article className="da-metric"><span>Valor local a costo histórico</span><strong>{formatCents(inventory.valueAtHistoricalCostCents)}</strong><small>Valuación de los lotes actuales; no incluye el historial importado.</small></article>
        <article className="da-metric"><span>Lotes locales</span><strong>{formatCount(lots.length)}</strong><small>Fuente operativa del inventario actual.</small></article>
        <article className="da-metric"><span>Mapa de stock compartido</span><strong>{mapping.status === "known" ? "Informado" : "Sin confirmar"}</strong><small>{getText(mapping, "reason", "La relación entre stock local y delivery no está validada.")}</small></article>
      </div>

      <section className="da-card" aria-labelledby="da-lots-title">
        <div className="da-section-heading"><div><span className="da-kicker">INVENTARIO ACTUAL</span><h2 id="da-lots-title">Lotes locales</h2></div><StatusPill tone={lots.length ? "good" : "caution"}>{lots.length ? `${formatCount(lots.length)} lotes` : "Sin lotes"}</StatusPill></div>
        {lots.length === 0 ? <EmptyState title="No hay lotes locales en la respuesta">El historial importado no se usa para completar ni estimar estas existencias.</EmptyState> : (
          <div className="da-table-wrap">
            <table>
              <caption>Existencia actual y evidencia comercial por lote.</caption>
              <thead><tr>
                <th scope="col">Producto / lote</th><th scope="col">Ubicación / proveedor</th><th scope="col">Existencia</th><th scope="col">Mínimo</th><th scope="col">Costo histórico / unidad</th><th scope="col">Precio cargado</th><th scope="col">Vencimiento</th><th scope="col">Cobertura observada</th>
                {probabilityAvailable && <th scope="col">Probabilidad de quiebre</th>}
                <th scope="col">Reposición</th>
              </tr></thead>
              <tbody>{lots.map((lot, index) => {
                const productId = displayText(lot.id, `lote-${index}`);
                const demand = demandByProduct.get(productId) || {};
                const reorder = asRecord(reorderByProduct.get(productId));
                const candidate = asRecord(reorder.combinedLocalDelivery);
                const lotPosition = lotPositionByKey.get(`${productId}:${String(lot.lot || "")}`) || {};
                const probability = formatBasisPoints(demand.stockoutProbabilityBasisPoints);
                const coverDays = demand.coverDays;
                const location = displayText(lot.locationId, "Sin ubicación");
                return <tr key={`${productId}-${index}`}>
                  <th scope="row"><strong>{getText(lot, "name")}</strong><small>{getText(lot, "lot", "Lote sin identificar")}</small></th>
                  <td>{location}<small>{displayText(lot.supplier, "Sin proveedor")}</small></td>
                  <td>{formatMilliunits(lot.stockMilliunits, lot.unit)}</td>
                  <td>{formatMilliunits(lot.minimumMilliunits, lot.unit)}</td>
                  <td>{formatCents(lot.historicalUnitCostCents)}</td>
                  <td>{formatCents(lot.currentUnitPriceCents)}</td>
                  <td><span>{formatDate(lot.expiresOn)}</span><small>{statusLabel(lotPosition.expiryStatus)}{lotPosition.daysUntilExpiry != null ? ` · ${displayText(lotPosition.daysUntilExpiry)} días` : ""}</small></td>
                  <td>{coverDays == null ? "Sin estimación" : `${displayText(coverDays)} días`}<small>{displayText(demand.availableDemandDays, "Sin días disponibles observados")} días de demanda disponible</small></td>
                  {probabilityAvailable && <td>{probability || "No aportada"}{probability && <small>{formatCount(demand.stockoutProbabilitySampleWindows)} ventanas · {getText(demand, "stockoutProbabilityMethod", "método no indicado")}</small>}</td>}
                  <td><StatusPill tone={candidate.status === "ready" ? "good" : candidate.status === "cash_limited" ? "partial" : "caution"}>{statusLabel(candidate.status || reorder.combinedUnavailableReason || "blocked")}</StatusPill><small>{displayText(reorderReasonLabels[String(candidate.reason || reorder.combinedUnavailableReason)] || candidate.reason || reorder.combinedUnavailableReason, "Sin fecha ni cantidad calculable")}</small></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        )}
        {!probabilityAvailable && <p className="da-footnote">No se recibió una probabilidad numérica de quiebre. La vista muestra demanda y cobertura observadas solamente.</p>}
      </section>

      <section className="da-card">
        <div className="da-section-heading"><div><span className="da-kicker">EVIDENCIA PARA REPONER</span><h2>Demanda, costo y posición</h2></div></div>
        <CommerceEvidence commerce={commerce} />
      </section>
      <section className="da-card" aria-labelledby="da-lead-times-title">
        <div className="da-section-heading"><div><span className="da-kicker">COMPRAS HISTÓRICAS</span><h2 id="da-lead-times-title">Plazos reales de entrega</h2></div></div>
        {observedLeadTimes.length ? <div className="da-table-wrap"><table>
          <caption>Pedidos y recepciones de compras importadas con diferencia conciliada cero. Estos plazos no modifican automáticamente la regla de reposición.</caption>
          <thead><tr><th scope="col">Proveedor externo</th><th scope="col">Fuente</th><th scope="col">Muestra</th><th scope="col">Mediana</th><th scope="col">Percentil 75</th><th scope="col">Rango</th></tr></thead>
          <tbody>{observedLeadTimes.map((row, index) => <tr key={`${row.sourceSystem}-${row.supplier}-${index}`}>
            <th scope="row">{displayText(row.supplier, "Sin identificar")}</th>
            <td>{displayText(row.sourceSystem, "Sin fuente")}</td>
            <td>{formatCount(row.sampleCount)} entregas</td>
            <td>{displayText(row.medianDays)} días</td>
            <td>{displayText(row.p75Days)} días</td>
            <td>{displayText(row.minimumDays)}–{displayText(row.maximumDays)} días</td>
          </tr>)}</tbody>
        </table></div> : <p className="da-footnote">Faltan fechas de pedido y recepción en compras conciliadas. El plazo confirmado por Tiziano se configura en Preparar decisiones.</p>}
      </section>
      {limitations.map((limitation, index) => <p className="da-limitation" key={`${index}-${limitation}`}>{limitation}</p>)}
    </div>
  );
}

function CommerceEvidence({ commerce }: { commerce: DataRecord }) {
  const demands = asRecords(commerce.demandByProduct);
  const costs = asRecords(commerce.costEvidence);
  const positions = asRecords(commerce.inventoryByProduct);
  if (!demands.length && !costs.length && !positions.length) return <EmptyState title="Evidencia comercial incompleta">No hay filas de demanda, costo o posición disponibles para mostrar.</EmptyState>;
  const costMap = new Map(costs.map((item) => [String(item.productId || ""), item]));
  const positionMap = new Map(positions.map((item) => [String(item.productId || ""), item]));
  return <div className="da-table-wrap"><table>
    <caption>Las ausencias se conservan como desconocidas; no se infieren compras recomendadas.</caption>
    <thead><tr><th scope="col">Producto</th><th scope="col">Demanda registrada</th><th scope="col">Posición por lote</th><th scope="col">Costo de reposición</th></tr></thead>
    <tbody>{demands.map((demand, index) => {
      const id = displayText(demand.productId, `producto-${index}`);
      const position = positionMap.get(id) || {};
      const cost = asRecord(costMap.get(id));
      const historical = asRecord(cost.latestHistoricalCost);
      const quote = asRecord(cost.usableReplacementQuote);
      return <tr key={`${id}-${index}`}>
        <th scope="row">{id}</th>
        <td>{formatMilliunits(demand.observedSalesMilliunits)} observadas<small>{formatCount(demand.availableDemandDays)} días disponibles · {formatCount(demand.censoredStockoutDays)} días censurados por quiebre · {formatCount(demand.unknownAvailabilityDays)} con disponibilidad desconocida</small></td>
        <td>{formatMilliunits(position.quantityMilliunits)} en {formatCount(position.lotCount)} lotes<small>{formatMilliunits(position.expiredMilliunits)} vencidas · {formatMilliunits(position.expiringSoonMilliunits)} próximas</small></td>
        <td>{quote.unitCostCentsPerUnit != null ? formatCents(quote.unitCostCentsPerUnit) : historical.unitCostCentsPerUnit != null ? formatCents(historical.unitCostCentsPerUnit) : "Sin cotización utilizable"}<small>{quote.unitCostCentsPerUnit != null ? `Cotización al ${formatDate(quote.quotedOn)}` : historical.observedOn ? `Costo histórico observado al ${formatDate(historical.observedOn)}` : "Falta evidencia de costo"}</small></td>
      </tr>;
    })}</tbody>
  </table></div>;
}

function ProfitabilityCard({ profitability, onDownloadDelivery }: { profitability: DataRecord; onDownloadDelivery: (count: unknown, revenue: unknown) => void }) {
  const localMonth = asRecord(profitability.localMonth);
  const delivery = asRecord(profitability.deliveryImported);
  const metadata = asRecord(localMonth.metadata);
  const period = asRecord(localMonth.period);
  return <div className="da-profitability-grid">
    <section className="da-card da-card--subtle" aria-labelledby="da-local-pnl-title">
      <div className="da-section-heading"><div><span className="da-kicker">VENTA LOCAL</span><h3 id="da-local-pnl-title">Resultado observado del mes</h3></div><StatusPill tone="partial">Cobertura parcial</StatusPill></div>
      <p className="da-muted">Período: {formatDate(period.from)} a {formatDate(period.through)}. Las ventas locales se mantienen separadas del delivery histórico.</p>
      <dl className="da-stat-list">
        <div><dt>Ventas netas observadas</dt><dd>{formatCents(localMonth.netSalesCents)}</dd></div>
        <div><dt>Costo histórico vendido</dt><dd>{formatCents(localMonth.historicalCogsCents)}</dd></div>
        <div><dt>Gastos operativos devengados</dt><dd>{formatCents(localMonth.accruedOperatingExpensesCents)}</dd></div>
        <div><dt>Resultado operativo completo</dt><dd>{formatCents(localMonth.operatingResultCents)}</dd></div>
        <div><dt>Resultado aritmético observado</dt><dd>{formatCents(localMonth.observedOperatingResultCents)}</dd></div>
      </dl>
      <Coverage value={metadata.sourceCoverage} />
      <p className="da-footnote">El resultado completo solo aparece cuando ventas, costos y gastos tienen cobertura completa.</p>
    </section>
    <section className="da-card da-card--imported" aria-labelledby="da-delivery-title">
      <div className="da-section-heading"><div><span className="da-kicker">FUENTE HISTÓRICA APARTE</span><h3 id="da-delivery-title">Delivery importado</h3></div><StatusPill tone="caution">No conciliado con ventas locales</StatusPill></div>
      <p className="da-muted">Resumen agregado de registros históricos. No representa ventas individuales ni se incorpora al resultado local.</p>
      <dl className="da-stat-list"><div><dt>Ventas importadas</dt><dd>{formatCount(delivery.saleCount)}</dd></div><div><dt>Ingresos importados</dt><dd>{formatCents(delivery.revenueCents)}</dd></div></dl>
      <button className="da-button da-button--secondary" type="button" onClick={() => onDownloadDelivery(delivery.saleCount, delivery.revenueCents)}>Descargar CSV resumen de delivery</button>
      <p className="da-footnote">El archivo contiene solo estos totales agregados y marca la conciliación pendiente.</p>
    </section>
  </div>;
}

type BreakdownKind = "product" | "category" | "supplier" | "channel";

const breakdownDefinitions: Array<{ kind: BreakdownKind; field: string; title: string }> = [
  { kind: "product", field: "byProduct", title: "Por producto" },
  { kind: "category", field: "byCategory", title: "Por categoría" },
  { kind: "supplier", field: "bySupplier", title: "Por proveedor" },
  { kind: "channel", field: "byChannel", title: "Por canal" },
];

function breakdownName(row: DataRecord, kind: BreakdownKind, index: number): string {
  if (kind === "product") return displayText(row.name ?? row.productId, `Producto ${index + 1}`);
  if (kind === "category") return displayText(row.name ?? row.category, `Categoría ${index + 1}`);
  if (kind === "supplier") return displayText(row.name ?? row.supplier, `Proveedor ${index + 1}`);
  if (row.channel === "local") return "Ventas locales";
  if (row.channel === "delivery_importado") return "Delivery importado";
  return displayText(row.channel, `Canal ${index + 1}`);
}

function breakdownNoteLines(row: DataRecord, kind: BreakdownKind): string[] {
  const rawNotes = [row.note, row.notes].flatMap((value) => Array.isArray(value) ? value : [value]);
  const notes = rawNotes.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim()];
    if (isRecord(item)) {
      const text = item.note ?? item.text ?? item.description ?? item.message;
      return typeof text === "string" && text.trim() ? [text.trim()] : [];
    }
    return [];
  });
  if (row.evidence === "observed_local") notes.push("Fuente: ventas locales observadas.");
  if (row.evidence === "demo") notes.push("Fuente: datos de demostración.");
  if (kind === "channel" && row.channel === "delivery_importado" && (row.historicalCogsCents === null || row.grossMarginCents === null)) {
    notes.push("Importado y no conciliado: el costo y el margen no son calculables con estos datos.");
  }
  if (notes.length === 0) notes.push(kind === "channel"
    ? "Resumen de canal; revisar el alcance y la cobertura de la fuente."
    : "Resumen descriptivo; no equivale a un resultado operativo completo.");
  return [...new Set(notes)];
}

function marginValue(value: unknown): ReactNode {
  if (value === null) return <span className="da-unavailable-value">No calculable</span>;
  if (value === undefined) return "Sin dato";
  return formatCents(value);
}

function CommercialBreakdowns({ profitability }: { profitability: DataRecord }) {
  const period = asRecord(asRecord(profitability.localMonth).period);
  const localScope = period.from && period.through
    ? `Ventas locales del ${formatDate(period.from)} al ${formatDate(period.through)}`
    : "Ventas locales del período informado por el servidor";
  return <section className="da-card da-commercial-breakdowns" aria-labelledby="da-commercial-breakdowns-title">
    <div className="da-section-heading">
      <div><span className="da-kicker">DESGLOSE DESCRIPTIVO</span><h2 id="da-commercial-breakdowns-title">Ingresos y costo histórico</h2></div>
      <StatusPill tone="partial">No es resultado operativo completo</StatusPill>
    </div>
    <p className="da-muted">Producto, categoría, proveedor y canal local: {localScope.toLocaleLowerCase("es-AR")}. El delivery importado muestra el acumulado disponible, sin corte mensual comparable y separado hasta conciliar líneas, lotes y costos.</p>
    <div className="da-breakdown-stack">
      {breakdownDefinitions.map(({ kind, field, title }) => {
        const supplied = profitability[field];
        const isList = Array.isArray(supplied);
        const rows = asRecords(supplied);
        return <section className="da-breakdown" key={field} aria-labelledby={`da-breakdown-${kind}`}>
          <div className="da-breakdown-heading"><h3 id={`da-breakdown-${kind}`}>{title}</h3><span>{supplied == null ? "Fuente no informada" : !isList ? "Formato no reconocido" : `${formatCount(rows.length)} filas`}</span></div>
          {supplied == null ? <p className="da-breakdown-empty">Este desglose todavía no está disponible en la respuesta.</p> : !isList ? <p className="da-breakdown-empty">La respuesta no entregó este desglose como una lista; no se puede interpretar con seguridad.</p> : rows.length === 0 ? <p className="da-breakdown-empty">La respuesta no contiene filas para este desglose.</p> : <div className="da-table-wrap"><table>
            <caption>{title}. Importes en ARS; cantidades recibidas como milliunits. Las notas indican fuente y límites recibidos.</caption>
            <thead><tr><th scope="col">{kind === "channel" ? "Canal" : "Grupo"}</th><th scope="col">Ingresos</th><th scope="col">Costo histórico vendido</th><th scope="col">Margen bruto aritmético</th><th scope="col">Cantidad (milliunits)</th><th scope="col">Líneas / ventas</th><th scope="col">Notas</th></tr></thead>
            <tbody>{rows.map((row, index) => {
              const countValue = row.lineCount ?? row.saleCount;
              const countLabel = row.lineCount != null ? "líneas" : row.saleCount != null ? "ventas" : "";
              const details = kind === "product" ? [
                row.category != null ? `Categoría: ${displayText(row.category)}` : "",
                row.supplier != null ? `Proveedor: ${displayText(row.supplier)}` : "",
                row.productId != null && displayText(row.name, "") ? `Código: ${displayText(row.productId)}` : "",
              ].filter(Boolean).join(" · ") : "";
              return <tr key={`${kind}-${String(row.productId ?? row.name ?? row.channel ?? index)}-${index}`}>
                <th scope="row">{breakdownName(row, kind, index)}{details && <small>{details}</small>}</th>
                <td>{formatCents(row.revenueCents)}</td>
                <td>{marginValue(row.historicalCogsCents)}</td>
                <td>{marginValue(row.grossMarginCents)}</td>
                <td>{formatMilliunits(row.quantityMilliunits)}</td>
                <td>{countValue == null ? "Sin dato" : <>{formatCount(countValue)}{countLabel && <small>{countLabel}</small>}</>}</td>
                <td>{breakdownNoteLines(row, kind).map((note, noteIndex) => <small className="da-breakdown-note" key={`${noteIndex}-${note}`}>{note}</small>)}</td>
              </tr>;
            })}</tbody>
          </table></div>}
        </section>;
      })}
    </div>
    <p className="da-footnote">Las cantidades agrupadas pueden mezclar productos con unidades físicas distintas. El margen bruto se presenta solo cuando la fuente lo entrega; delivery permanece sin costo ni margen conocidos.</p>
  </section>;
}

type PromotionLineDraft = { key: string; productId: string; quantity: string; discountKind: "percent_bps" | "fixed_cents"; discount: string };
type FreebieDraft = { key: string; productId: string; quantity: string };
type PromotionDraft = {
  name: string; lines: PromotionLineDraft[]; freebies: FreebieDraft[]; shippingCharged: string; shippingCost: string; campaignCost: string; compareReference: boolean;
};

let draftRowSequence = 0;
function newRowKey(): string { draftRowSequence += 1; return `da-row-${draftRowSequence}`; }
function emptyPromotionDraft(firstProductId = ""): PromotionDraft {
  return { name: "Promoción propuesta", lines: [{ key: newRowKey(), productId: firstProductId, quantity: "1", discountKind: "percent_bps", discount: "10" }], freebies: [], shippingCharged: "0", shippingCost: "0", campaignCost: "0", compareReference: true };
}

function promotionScenario(draft: PromotionDraft, baseline = false): DataRecord {
  return {
    name: baseline ? `${draft.name.trim()} · referencia` : draft.name.trim(),
    lines: draft.lines.map((line) => ({
      productId: line.productId,
      quantityMilliunits: toMilliunits(line.quantity, "Cantidad"),
      discount: baseline
        ? { kind: "percent_bps", value: 0 }
        : line.discountKind === "percent_bps"
          ? { kind: "percent_bps", value: toBasisPoints(line.discount, "Descuento") }
          : { kind: "fixed_cents", value: toCurrencyCents(line.discount, "Descuento fijo") },
    })),
    shippingChargedCents: toCurrencyCents(draft.shippingCharged, "Envío cobrado"),
    shippingCostCents: toCurrencyCents(draft.shippingCost, "Costo de envío"),
    freebies: baseline ? [] : draft.freebies.map((freebie) => ({ productId: freebie.productId, quantityMilliunits: toMilliunits(freebie.quantity, "Cantidad de obsequio") })),
    campaignCostCents: baseline ? "0" : toCurrencyCents(draft.campaignCost, "Costo de campaña"),
  };
}

function PromotionSimulator({ lots }: { lots: DataRecord[] }) {
  const [draft, setDraft] = useState<PromotionDraft>(() => emptyPromotionDraft());
  const [result, setResult] = useState<DataRecord | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const products = lots.filter((lot) => typeof lot.id === "string");
  useEffect(() => {
    if (products.length && !draft.lines[0]?.productId) {
      const firstId = String(products[0].id);
      setDraft((current) => ({ ...current, lines: current.lines.map((line, index) => index === 0 ? { ...line, productId: firstId } : line) }));
    }
  }, [products.length, products[0]?.id, draft.lines]);

  const setDraftField = <K extends keyof PromotionDraft>(key: K, value: PromotionDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const setLine = (key: string, field: keyof PromotionLineDraft, value: string) => setDraft((current) => ({ ...current, lines: current.lines.map((line) => line.key === key ? { ...line, [field]: value } : line) }));
  const setFreebie = (key: string, field: keyof FreebieDraft, value: string) => setDraft((current) => ({ ...current, freebies: current.freebies.map((row) => row.key === key ? { ...row, [field]: value } : row) }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setResult(null);
    setBusy(true);
    try {
      if (draft.name.trim().length < 2) throw new Error("Ingresá un nombre de al menos dos caracteres.");
      if (!draft.lines.length || draft.lines.some((line) => !line.productId)) throw new Error("Seleccioná un producto para cada línea.");
      const body: DataRecord = { promoted: promotionScenario(draft) };
      if (draft.compareReference) body.reference = promotionScenario(draft, true);
      const response = await requestJson("/api/decision-simulations/promotion", { method: "POST", body: JSON.stringify(body) });
      setResult(response);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo calcular la promoción.");
    } finally { setBusy(false); }
  }

  return <section className="da-card" aria-labelledby="da-promotion-title">
    <div className="da-section-heading"><div><span className="da-kicker">SIMULADOR COMERCIAL</span><h2 id="da-promotion-title">Margen de una promoción</h2></div><StatusPill tone="partial">Escenario, no pronóstico causal</StatusPill></div>
    <p className="da-muted">Usa precio y costo histórico por lote. Incluí envío, obsequios y campaña para estimar la contribución; no demuestra que la promoción genere ventas incrementales.</p>
    {products.length === 0 ? <EmptyState title="Hace falta un lote con producto identificado">La simulación requiere al menos un producto existente en los lotes locales.</EmptyState> : <form className="da-form" onSubmit={submit}>
      <label className="da-field da-field--wide"><span>Nombre del escenario</span><input value={draft.name} onChange={(event) => setDraftField("name", event.target.value)} maxLength={100} required /></label>
      <fieldset className="da-fieldset"><legend>Productos incluidos</legend>
        {draft.lines.map((line, index) => <div className="da-line-editor" key={line.key}>
          <label className="da-field"><span>Producto {index + 1}</span><select value={line.productId} onChange={(event) => setLine(line.key, "productId", event.target.value)} required>{products.map((product) => <option key={String(product.id)} value={String(product.id)}>{displayText(product.name, String(product.id))}</option>)}</select></label>
          <label className="da-field"><span>Cantidad</span><input type="text" inputMode="decimal" value={line.quantity} onChange={(event) => setLine(line.key, "quantity", event.target.value)} aria-describedby={`${line.key}-quantity-help`} required /><small id={`${line.key}-quantity-help`}>Unidades, hasta 3 decimales.</small></label>
          <label className="da-field"><span>Tipo de descuento</span><select value={line.discountKind} onChange={(event) => setLine(line.key, "discountKind", event.target.value as PromotionLineDraft["discountKind"])}><option value="percent_bps">Porcentaje</option><option value="fixed_cents">Importe por línea</option></select></label>
          <label className="da-field"><span>{line.discountKind === "percent_bps" ? "Descuento (%)" : "Descuento (ARS)"}</span><input type="text" inputMode="decimal" value={line.discount} onChange={(event) => setLine(line.key, "discount", event.target.value)} required /></label>
          <button className="da-icon-button" type="button" aria-label={`Quitar producto ${index + 1}`} disabled={draft.lines.length <= 1} onClick={() => setDraft((current) => ({ ...current, lines: current.lines.filter((item) => item.key !== line.key) }))}>Quitar</button>
        </div>)}
        <button className="da-button da-button--secondary" type="button" onClick={() => setDraft((current) => ({ ...current, lines: [...current.lines, { key: newRowKey(), productId: String(products[0].id), quantity: "1", discountKind: "percent_bps", discount: "0" }] }))}>Agregar producto</button>
      </fieldset>
      <fieldset className="da-fieldset"><legend>Envío y campaña</legend><div className="da-field-grid">
        <label className="da-field"><span>Envío cobrado (ARS)</span><input type="text" inputMode="decimal" value={draft.shippingCharged} onChange={(event) => setDraftField("shippingCharged", event.target.value)} required /></label>
        <label className="da-field"><span>Costo del envío (ARS)</span><input type="text" inputMode="decimal" value={draft.shippingCost} onChange={(event) => setDraftField("shippingCost", event.target.value)} required /></label>
        <label className="da-field"><span>Costo de campaña (ARS)</span><input type="text" inputMode="decimal" value={draft.campaignCost} onChange={(event) => setDraftField("campaignCost", event.target.value)} required /></label>
      </div></fieldset>
      <fieldset className="da-fieldset"><legend>Obsequios</legend>
        {draft.freebies.length === 0 && <p className="da-muted">Sin obsequios incluidos.</p>}
        {draft.freebies.map((row, index) => <div className="da-line-editor da-line-editor--freebie" key={row.key}>
          <label className="da-field"><span>Producto obsequio {index + 1}</span><select value={row.productId} onChange={(event) => setFreebie(row.key, "productId", event.target.value)} required>{products.map((product) => <option key={String(product.id)} value={String(product.id)}>{displayText(product.name, String(product.id))}</option>)}</select></label>
          <label className="da-field"><span>Cantidad</span><input type="text" inputMode="decimal" value={row.quantity} onChange={(event) => setFreebie(row.key, "quantity", event.target.value)} required /></label>
          <button className="da-icon-button" type="button" aria-label={`Quitar obsequio ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, freebies: current.freebies.filter((item) => item.key !== row.key) }))}>Quitar</button>
        </div>)}
        <button className="da-button da-button--secondary" type="button" onClick={() => setDraft((current) => ({ ...current, freebies: [...current.freebies, { key: newRowKey(), productId: String(products[0].id), quantity: "1" }] }))}>Agregar obsequio</button>
      </fieldset>
      <label className="da-checkbox"><input type="checkbox" checked={draft.compareReference} onChange={(event) => setDraftField("compareReference", event.target.checked)} /><span>Comparar contra igual cantidad sin descuento, obsequios ni costo de campaña.</span></label>
      {error && <p className="da-error" role="alert">{error}</p>}
      <button className="da-button da-button--primary" type="submit" disabled={busy}>{busy ? "Calculando…" : "Calcular escenario"}</button>
    </form>}
    {result && <PromotionResult result={result} />}
  </section>;
}

function PromotionResult({ result }: { result: DataRecord }) {
  const calculation = asRecord(result.calculation);
  const promoted = asRecord(calculation.promoted);
  const reference = asRecord(calculation.reference);
  const lines = asRecords(promoted.lines);
  return <section className="da-result" aria-label="Resultado de la simulación de promoción" aria-live="polite">
    <div className="da-section-heading"><div><span className="da-kicker">RESULTADO</span><h3>{getText(promoted, "name", "Promoción calculada")}</h3></div><StatusPill tone="partial">{statusLabel(calculation.breakEvenStatus)}</StatusPill></div>
    <dl className="da-stat-list da-stat-list--compact">
      <div><dt>Contribución promocionada</dt><dd>{formatCents(promoted.contributionCents)}</dd></div>
      {calculation.contributionDifferenceCents != null && <div><dt>Diferencia ante referencia</dt><dd>{formatCents(calculation.contributionDifferenceCents)}</dd></div>}
      {calculation.incrementalOrdersToBreakEvenPerReferenceOrder != null && <div><dt>Órdenes incrementales para equilibrar</dt><dd>{formatCount(calculation.incrementalOrdersToBreakEvenPerReferenceOrder)}</dd></div>}
      {reference.contributionCents != null && <div><dt>Contribución de referencia</dt><dd>{formatCents(reference.contributionCents)}</dd></div>}
    </dl>
    {lines.length > 0 && <div className="da-table-wrap"><table><caption>Detalle calculado de la promoción.</caption><thead><tr><th scope="col">Producto</th><th scope="col">Venta neta</th><th scope="col">Costo variable</th><th scope="col">Contribución</th></tr></thead><tbody>{lines.map((line, index) => <tr key={`${String(line.productId)}-${index}`}><th scope="row">{displayText(line.productId)}</th><td>{formatCents(line.netRevenueCents)}</td><td>{formatCents(line.variableCostCents)}</td><td>{formatCents(line.contributionCents)}</td></tr>)}</tbody></table></div>}
    <p className="da-footnote">{getText(result, "limitation", "Comparación descriptiva basada en los supuestos ingresados; no demuestra causalidad.")}</p>
  </section>;
}

function CommercialView({ data, onDownloadDelivery }: { data: DataRecord; onDownloadDelivery: (count: unknown, revenue: unknown) => void }) {
  const inventory = asRecord(data.inventory);
  const profitability = asRecord(data.profitability);
  return <div className="da-view">
    <ProfitabilityCard profitability={profitability} onDownloadDelivery={onDownloadDelivery} />
    <CommercialBreakdowns profitability={profitability} />
    <PromotionSimulator lots={asRecords(inventory.lots)} />
  </div>;
}

function ForecastView({ data }: { data: DataRecord }) {
  const forecast = asRecord(data.forecast);
  const sevenDay = asRecord(forecast.localSevenDay);
  const result = asRecord(sevenDay.forecast);
  const outOfSample = asRecord(sevenDay.outOfSample);
  const interval = asRecord(result.interval80);
  return <section className="da-card" aria-labelledby="da-seven-title">
    <div className="da-section-heading"><div><span className="da-kicker">VENTAS LOCALES</span><h2 id="da-seven-title">Agregado de siete días</h2></div><StatusPill tone={result.available === true ? "partial" : "caution"}>{result.available === true ? "Estimación calculada" : "No disponible"}</StatusPill></div>
    {result.available === true ? <>
      <p className="da-muted">Período estimado del {formatDate(result.from)} al {formatDate(result.through)}; entrenamiento con la serie local declarada en el cálculo.</p>
      <dl className="da-stat-list da-stat-list--compact"><div><dt>Estimación central</dt><dd>{formatCents(result.pointCents)}</dd></div><div><dt>Intervalo 80%</dt><dd>{interval.lowerCents == null ? "Sin calibrar" : `${formatCents(interval.lowerCents)} a ${formatCents(interval.upperCents)}`}</dd></div><div><dt>Orígenes de backtest</dt><dd>{formatCount(outOfSample.forecastOrigins)}</dd></div><div><dt>Error absoluto medio</dt><dd>{formatCents(outOfSample.maeCents)}</dd></div></dl>
    </> : <EmptyState title="No hay una estimación disponible">{displayText(result.unavailableReason, "La cobertura está incompleta o el historial no alcanza el mínimo requerido.")}. No se reemplaza con el delivery importado.</EmptyState>}
    <Coverage value={asRecord(sevenDay.metadata).sourceCoverage} />
  </section>;
}

function HiringSimulator() {
  const currentMonth = new Date().toISOString().slice(0, 7);
  const [form, setForm] = useState({ startMonth: currentMonth, endMonth: "", headcount: "1", monthlyEmployerCost: "0", contributionPerUnit: "0", cashFloor: "0" });
  const [result, setResult] = useState<DataRecord | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setResult(null); setBusy(true);
    try {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(form.startMonth)) throw new Error("El mes de inicio debe usar formato AAAA-MM.");
      if (form.endMonth && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(form.endMonth) || form.endMonth < form.startMonth)) throw new Error("El mes de fin debe ser válido y no anterior al inicio.");
      if (!/^[1-9]\d*$/.test(form.headcount) || BigInt(form.headcount) > 100n) throw new Error("La cantidad de personas debe ser un entero entre 1 y 100.");
      const body = {
        startMonth: form.startMonth,
        endMonth: form.endMonth || null,
        headcount: Number(form.headcount),
        monthlyEmployerCostPerEmployeeCents: toCurrencyCents(form.monthlyEmployerCost, "Costo laboral mensual por persona"),
        incrementalContributionPerUnitCents: toCurrencyCents(form.contributionPerUnit, "Contribución por unidad"),
        cashFloorCents: toCurrencyCents(form.cashFloor, "Piso de caja"),
      };
      setResult(await requestJson("/api/decision-simulations/hiring", { method: "POST", body: JSON.stringify(body) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo calcular la contratación.");
    } finally { setBusy(false); }
  }
  const scenarios = asRecord(result?.scenarios);
  const periods = asRecords(scenarios.periods);
  return <section className="da-card" aria-labelledby="da-hiring-title">
    <div className="da-section-heading"><div><span className="da-kicker">SIMULADOR DE PERSONAL</span><h2 id="da-hiring-title">Costo incremental de contratación</h2></div><StatusPill tone="caution">No decide disponibilidad de caja</StatusPill></div>
    <p className="da-muted">Calcula el costo laboral ingresado y las unidades que cubrirían ese costo según una contribución supuesta. El saldo conciliado y las obligaciones completas siguen siendo necesarios para evaluar caja.</p>
    <form className="da-form da-form--compact" onSubmit={submit}>
      <div className="da-field-grid da-field-grid--three">
        <label className="da-field"><span>Inicio (AAAA-MM)</span><input type="month" value={form.startMonth} onChange={(event) => update("startMonth", event.target.value)} required /></label>
        <label className="da-field"><span>Fin (opcional)</span><input type="month" value={form.endMonth} onChange={(event) => update("endMonth", event.target.value)} /></label>
        <label className="da-field"><span>Personas</span><input type="number" min="1" max="100" step="1" value={form.headcount} onChange={(event) => update("headcount", event.target.value)} required /></label>
        <label className="da-field"><span>Costo empleador mensual por persona (ARS)</span><input type="text" inputMode="decimal" value={form.monthlyEmployerCost} onChange={(event) => update("monthlyEmployerCost", event.target.value)} required /></label>
        <label className="da-field"><span>Contribución incremental por unidad (ARS)</span><input type="text" inputMode="decimal" value={form.contributionPerUnit} onChange={(event) => update("contributionPerUnit", event.target.value)} required /></label>
        <label className="da-field"><span>Piso de caja protegido (ARS)</span><input type="text" inputMode="decimal" value={form.cashFloor} onChange={(event) => update("cashFloor", event.target.value)} required /></label>
      </div>
      {error && <p className="da-error" role="alert">{error}</p>}
      <button className="da-button da-button--primary" type="submit" disabled={busy}>{busy ? "Calculando…" : "Calcular escenario laboral"}</button>
    </form>
    {result && <section className="da-result" aria-label="Resultado de la simulación laboral" aria-live="polite">
      <dl className="da-stat-list da-stat-list--compact"><div><dt>Costo incremental mensual estimado</dt><dd>{formatCents(result.monthlyIncrementalContributionNeededCents)}</dd></div><div><dt>Unidades adicionales al mes</dt><dd>{formatCount(result.additionalUnitsNeeded)}</dd></div><div><dt>Veredicto de caja</dt><dd>{statusLabel(result.cashVerdict)}</dd></div></dl>
      <p className="da-footnote">{getText(result, "limitation", "Los importes dependen de los supuestos ingresados; validar con el profesional correspondiente.")}</p>
      {periods.length > 0 && <div className="da-table-wrap"><table><caption>Escenarios de caja de largo plazo con el supuesto de contratación.</caption><thead><tr><th scope="col">Mes</th><th scope="col">Prudente con contratación</th><th scope="col">Base con contratación</th><th scope="col">Crecimiento con contratación</th></tr></thead><tbody>{periods.map((period, index) => {
        const byScenario = asRecord(period.byScenario);
        const cell = (name: string) => formatCents(asRecord(byScenario[name]).closingCashBalanceWithHiringCents);
        return <tr key={`${String(period.month)}-${index}`}><th scope="row">{formatMonth(period.month)}</th><td>{cell("low")}</td><td>{cell("base")}</td><td>{cell("high")}</td></tr>;
      })}</tbody></table></div>}
    </section>}
  </section>;
}

function InflationComparator() {
  const [form, setForm] = useState({ earlierMonth: "", laterMonth: "", earlierAmount: "", laterAmount: "",
    earlierIndex: "", laterIndex: "", publishedAt: "", seriesVersion: "", sourceUrl: "" });
  const [result, setResult] = useState<DataRecord | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setResult(null); setError(""); setBusy(true);
    try {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(form.earlierMonth) || !/^\d{4}-(0[1-9]|1[0-2])$/.test(form.laterMonth) || form.earlierMonth >= form.laterMonth)
        throw new Error("Elegí un mes base anterior al mes comparado.");
      const index = (value: string) => value.trim().replace(",", ".");
      for (const [label, value] of [["base", index(form.earlierIndex)], ["comparado", index(form.laterIndex)]])
        if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value) || Number(value) <= 0)
          throw new Error(`Índice ${label}: ingresá un valor positivo con hasta seis decimales.`);
      const body = { earlierMonth: form.earlierMonth, laterMonth: form.laterMonth,
        earlierNominalCents: toCurrencyCents(form.earlierAmount, "Importe base"),
        laterNominalCents: toCurrencyCents(form.laterAmount, "Importe comparado"),
        earlierIndex: index(form.earlierIndex), laterIndex: index(form.laterIndex),
        publishedAt: form.publishedAt, seriesVersion: form.seriesVersion.trim(), sourceUrl: form.sourceUrl.trim() };
      setResult(await requestJson("/api/decision-simulations/inflation", { method: "POST", body: JSON.stringify(body) }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "No se pudo comparar en pesos constantes."); }
    finally { setBusy(false); }
  }
  const calculation = asRecord(result?.calculation);
  return <details className="da-card" aria-label="Comparar en pesos constantes">
    <summary>Comparar dos meses en pesos constantes con IPC</summary>
    <p className="da-muted">Ingresá dos puntos de la misma serie oficial de INDEC y guardá la referencia documental. La app calcula el ajuste; Gio debe cotejar los índices publicados. El IPC no reemplaza la cotización de compra de un proveedor.</p>
    <form className="da-form da-form--compact" onSubmit={submit}>
      <div className="da-field-grid da-field-grid--three">
        <label className="da-field"><span>Mes base</span><input type="month" value={form.earlierMonth} onChange={(event) => update("earlierMonth", event.target.value)} required /></label>
        <label className="da-field"><span>Importe del mes base (ARS)</span><input inputMode="decimal" value={form.earlierAmount} onChange={(event) => update("earlierAmount", event.target.value)} required /></label>
        <label className="da-field"><span>IPC del mes base</span><input inputMode="decimal" value={form.earlierIndex} onChange={(event) => update("earlierIndex", event.target.value)} required /></label>
        <label className="da-field"><span>Mes comparado</span><input type="month" value={form.laterMonth} onChange={(event) => update("laterMonth", event.target.value)} required /></label>
        <label className="da-field"><span>Importe del mes comparado (ARS)</span><input inputMode="decimal" value={form.laterAmount} onChange={(event) => update("laterAmount", event.target.value)} required /></label>
        <label className="da-field"><span>IPC del mes comparado</span><input inputMode="decimal" value={form.laterIndex} onChange={(event) => update("laterIndex", event.target.value)} required /></label>
        <label className="da-field"><span>Publicación de la serie</span><input type="date" value={form.publishedAt} onChange={(event) => update("publishedAt", event.target.value)} required /></label>
        <label className="da-field"><span>Versión / tabla</span><input value={form.seriesVersion} onChange={(event) => update("seriesVersion", event.target.value)} maxLength={120} required /></label>
        <label className="da-field"><span>URL de la tabla de INDEC</span><input type="url" value={form.sourceUrl} onChange={(event) => update("sourceUrl", event.target.value)} maxLength={500} placeholder="https://www.indec.gob.ar/…" required /></label>
      </div>
      {error && <p className="da-error" role="alert">{error}</p>}
      <button type="submit" className="da-button da-button--primary" disabled={busy}>{busy ? "Calculando…" : "Comparar en pesos constantes"}</button>
    </form>
    {result && <section className="da-result" aria-label="Comparación de inflación" aria-live="polite">
      <dl className="da-stat-list da-stat-list--compact">
        <div><dt>Importe base actualizado a {form.laterMonth}</dt><dd>{formatCents(calculation.earlierAdjustedToLaterCents)}</dd></div>
        <div><dt>Cambio nominal</dt><dd>{formatCents(calculation.nominalChangeCents)}</dd></div>
        <div><dt>Cambio en pesos de {form.laterMonth}</dt><dd>{formatCents(calculation.cpiAdjustedChangeCents)}</dd></div>
      </dl>
      <p className="da-footnote">{getText(result, "limitation", "Revisá la fuente del índice.")} <a href={String(result.sourceUrl)} target="_blank" rel="noopener noreferrer">Abrir publicación indicada</a></p>
    </section>}
  </details>;
}

function CashView({ data }: { data: DataRecord }) {
  const forecast = asRecord(data.forecast);
  const cash13Weeks = asRecord(forecast.cash13Weeks);
  const longRange = asRecord(forecast.monthsThrough2027);
  const periods = asRecords(longRange.periods);
  const scenarios = ["low", "base", "high"] as const;
  const scenarioNames = { low: "Prudente", base: "Base", high: "Crecimiento" };
  const baseWeeks = asRecords(asRecord(cash13Weeks.base).weeks);
  const baseCashAvailable = asRecord(cash13Weeks.base).available === true;
  return <div className="da-view">
    <ForecastView data={data} />
    <section className="da-card" aria-labelledby="da-cash-weeks-title">
      <div className="da-section-heading"><div><span className="da-kicker">PLANIFICACIÓN</span><h2 id="da-cash-weeks-title">Caja a trece semanas</h2></div><StatusPill tone={baseCashAvailable ? "good" : "caution"}>{baseCashAvailable ? "Saldo y cobertura atestados" : "Falta saldo o cobertura"}</StatusPill></div>
      <p className="da-muted">Se muestran movimientos observados del escenario y saldos solo cuando el servidor los considera disponibles. No se agregan movimientos históricos importados.</p>
      {baseWeeks.length === 0 ? <EmptyState title="No hay semanas de caja">La respuesta no contiene filas para la proyección base.</EmptyState> : <div className="da-table-wrap"><table><caption>Totales semanales reportados por el servidor; los saldos sin conciliar se muestran como faltantes.</caption><thead><tr><th scope="col">Semana</th>{scenarios.map((scenario) => <th scope="col" key={scenario}>{scenarioNames[scenario]} · cambio observado</th>)}<th scope="col">Saldo de cierre base</th></tr></thead><tbody>{baseWeeks.map((week, index) => {
        const weekNumber = week.week;
        const scenarioWeek = (scenario: string) => asRecords(asRecord(cash13Weeks[scenario]).weeks).find((row) => String(row.week) === String(weekNumber));
        return <tr key={`${String(week.week)}-${index}`}><th scope="row">Semana {formatCount(week.week)}<small>{formatDate(week.from)} a {formatDate(week.through)}</small></th>{scenarios.map((scenario) => <td key={scenario}>{formatCents(asRecord(scenarioWeek(scenario)).observedCashChangeCents)}</td>)}<td>{formatCents(week.closingCashBalanceCents)}</td></tr>;
      })}</tbody></table></div>}
      <div className="da-cash-availability">{scenarios.map((scenario) => {
        const item = asRecord(cash13Weeks[scenario]);
        const reasons = Array.isArray(item.unavailableReasons) ? item.unavailableReasons.map((reason) => statusLabel(reason)).join(" · ") : "Sin detalle de disponibilidad";
        return <p key={scenario}><strong>{scenarioNames[scenario]}:</strong> {item.available === true ? "proyección disponible" : `saldo final no disponible · ${reasons || "fuentes incompletas"}`}</p>;
      })}</div>
    </section>
    <section className="da-card" aria-labelledby="da-longrange-title">
      <div className="da-section-heading"><div><span className="da-kicker">HORIZONTE LARGO</span><h2 id="da-longrange-title">Meses hasta 2027</h2></div><StatusPill tone="partial">Supuestos explícitos</StatusPill></div>
      {periods.length === 0 ? <EmptyState title="No hay escenarios mensuales">Sin filas explícitas para mostrar en este horizonte.</EmptyState> : <div className="da-table-wrap"><table><caption>El cambio proyectado y el saldo se distinguen por escenario; los importes no informados permanecen vacíos.</caption><thead><tr><th scope="col">Mes</th>{scenarios.map((scenario) => <th scope="col" key={scenario}>{scenarioNames[scenario]} · cambio</th>)}<th scope="col">Saldo de cierre base</th></tr></thead><tbody>{periods.map((period, index) => {
        const byScenario = asRecord(period.byScenario);
        const row = (scenario: string) => asRecord(byScenario[scenario]);
        return <tr key={`${String(period.month)}-${index}`}><th scope="row">{formatMonth(period.month)}</th>{scenarios.map((scenario) => <td key={scenario}>{formatCents(row(scenario).cashChangeCents)}</td>)}<td>{formatCents(row("base").closingCashBalanceCents)}</td></tr>;
      })}</tbody></table></div>}
    </section>
    <HiringSimulator />
    <InflationComparator />
  </div>;
}

const recencyLabels: Record<string, string> = { recent: "Reciente", cooling: "En enfriamiento", lapsed: "Inactivo", never: "Sin compras", unknown: "Sin fecha conocida" };
const frequencyLabels: Record<string, string> = { none: "Ninguna", low: "Baja", medium: "Media", high: "Alta" };
const spendLabels: Record<string, string> = { low: "Bajo", medium: "Medio", high: "Alto" };
const reviewListLabels: Record<string, string> = { recentHighSpend: "Compra reciente y gasto alto", frequentCore: "Frecuencia alta", lapsedHighSpend: "Inactivo y gasto alto", newOrLowHistory: "Historial nuevo o breve" };

function MembersView({ data }: { data: DataRecord }) {
  const segments = asRecord(data.segments);
  const assumptions = asRecord(segments.assumptions);
  const result = asRecord(segments.result);
  const members = asRecords(result.members);
  const queues = asRecord(result.reviewLists);
  const queueValues = ["recentHighSpend", "frequentCore", "lapsedHighSpend", "newOrLowHistory"] as const;
  return <div className="da-view">
    <section className="da-privacy-note"><span className="da-kicker">USO RESTRINGIDO</span><strong>Revisión humana solamente</strong><p>Los perfiles se muestran con etiquetas temporales. No se exponen identificadores, datos de contacto, permisos ni listas descargables. Esta vista no envía mensajes.</p></section>
    <div className="da-metric-grid da-metric-grid--four">{queueValues.map((key) => <article className="da-metric" key={key}><span>{reviewListLabels[key]}</span><strong>{formatCount(asRecords(queues[key]).length || (Array.isArray(queues[key]) ? queues[key].length : 0))}</strong><small>Perfiles en cola de revisión</small></article>)}</div>
    <section className="da-card" aria-labelledby="da-members-title">
      <div className="da-section-heading"><div><span className="da-kicker">SEGMENTOS LOCALES</span><h2 id="da-members-title">Perfiles descriptivos</h2></div><StatusPill tone="partial">{formatCount(members.length)} perfiles · datos locales</StatusPill></div>
      <p className="da-muted">Corte {formatDate(result.asOfDate)}. El pseudónimo es solo de pantalla y no permite exportar contactos.</p>
      {members.length === 0 ? <EmptyState title="No hay perfiles para revisar">Los miembros del resumen histórico importado, si los hubiera, permanecen separados de esta segmentación local.</EmptyState> : <div className="da-table-wrap"><table><caption>Orden interno estable para esta vista; no se muestran IDs de socio.</caption><thead><tr><th scope="col">Perfil</th><th scope="col">Última compra</th><th scope="col">Compras</th><th scope="col">Gasto acumulado</th><th scope="col">Recencia</th><th scope="col">Frecuencia</th><th scope="col">Gasto</th><th scope="col">Colas humanas</th></tr></thead><tbody>{members.map((member, index) => {
        const queueLabels = Array.isArray(member.reviewLists) ? member.reviewLists.map((item) => reviewListLabels[String(item)] || "Revisión humana").join(" · ") : "Sin cola";
        return <tr key={`profile-${index}`}><th scope="row">Perfil {String(index + 1).padStart(2, "0")}</th><td>{formatDate(member.lastPurchaseDate)}</td><td>{formatCount(member.purchaseCount)}</td><td>{formatCents(member.spendCents)}</td><td>{recencyLabels[String(member.recencyBand)] || "Sin informar"}{member.daysSinceLastPurchase != null && <small>{formatCount(member.daysSinceLastPurchase)} días</small>}</td><td>{frequencyLabels[String(member.frequencyBand)] || "Sin informar"}</td><td>{spendLabels[String(member.spendBand)] || "Sin informar"}</td><td>{queueLabels}</td></tr>;
      })}</tbody></table></div>}
    </section>
    <section className="da-card" aria-labelledby="da-assumptions-title">
      <div className="da-section-heading"><div><span className="da-kicker">REGLAS DEL SEGMENTO</span><h2 id="da-assumptions-title">Supuestos visibles</h2></div></div>
      <dl className="da-assumptions"><div><dt>Reciente, hasta</dt><dd>{formatCount(assumptions.recentDays)} días</dd></div><div><dt>Enfriamiento, hasta</dt><dd>{formatCount(assumptions.coolingDays)} días</dd></div><div><dt>Frecuencia media</dt><dd>{formatCount(assumptions.mediumFrequencyPurchases)} compras</dd></div><div><dt>Frecuencia alta</dt><dd>{formatCount(assumptions.highFrequencyPurchases)} compras</dd></div><div><dt>Gasto medio desde</dt><dd>{formatCents(assumptions.mediumSpendCents)}</dd></div><div><dt>Gasto alto desde</dt><dd>{formatCents(assumptions.highSpendCents)}</dd></div></dl>
    </section>
  </div>;
}

function DecisionPanel({ section, data, onDownloadDelivery }: { section: DecisionAnalysisSection; data: DataRecord; onDownloadDelivery: (count: unknown, revenue: unknown) => void }) {
  if (section === "stock") return <InventoryView data={data} />;
  if (section === "commercial") return <CommercialView data={data} onDownloadDelivery={onDownloadDelivery} />;
  if (section === "cash") return <CashView data={data} />;
  return <MembersView data={data} />;
}

export default function DecisionAnalysis({ section }: DecisionAnalysisProps) {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<DecisionAnalysisSection>(() => isDecisionSection(section) ? section : sectionFromUrl());
  const [data, setData] = useState<DataRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const tabRefs = useRef<Record<DecisionAnalysisSection, HTMLButtonElement | null>>({ stock: null, commercial: null, cash: null, members: null });

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError("");
    try {
      const payload = await requestJson("/api/decision-analysis", { signal });
      if (!signal?.aborted) setData(payload);
    } catch (reason) {
      if (!signal?.aborted) setLoadError(reason instanceof Error ? reason.message : "No se pudo cargar el análisis.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const synchronize = () => setActiveSection(isDecisionSection(section) ? section : sectionFromUrl());
    synchronize();
    window.addEventListener("popstate", synchronize);
    window.addEventListener("hashchange", synchronize);
    return () => {
      window.removeEventListener("popstate", synchronize);
      window.removeEventListener("hashchange", synchronize);
    };
  }, [section]);

  const selectSection = (next: DecisionAnalysisSection) => {
    setActiveSection(next);
    if (isDecisionSection(section)) {
      navigate(analysisPaths[next]);
      window.requestAnimationFrame(() => document.getElementById(`da-tab-${next}`)?.focus());
      return;
    }
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("section", next);
    window.history.replaceState(window.history.state, "", url);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, current: DecisionAnalysisSection) => {
    const index = sectionOrder.indexOf(current);
    const nextIndex = event.key === "ArrowRight" ? (index + 1) % sectionOrder.length
      : event.key === "ArrowLeft" ? (index + sectionOrder.length - 1) % sectionOrder.length
        : event.key === "Home" ? 0 : event.key === "End" ? sectionOrder.length - 1 : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = sectionOrder[nextIndex];
    selectSection(next);
    tabRefs.current[next]?.focus();
  };

  const profitability = asRecord(data?.profitability);
  const delivery = asRecord(profitability.deliveryImported);
  const lastUpdated = data?.asOfDate;

  return <div className="decision-analysis">
    <header className="da-header">
      <div><span className="da-kicker">LECTURA DE NEGOCIO · CON EVIDENCIA</span><h1>{analysisTitles[activeSection]}</h1><p>{sectionDescriptions[activeSection]} Los datos faltantes y no conciliados permanecen visibles.</p></div>
      <div className="da-header-meta"><StatusPill tone={coverageTone(asRecord(data?.sourceState).state)}>{sourceStateText(asRecord(data?.sourceState).state)}</StatusPill><span>Actualizado al {formatDate(lastUpdated)}</span><button type="button" className="da-button da-button--secondary" onClick={() => void load()} disabled={loading}>{loading ? "Actualizando…" : "Actualizar análisis"}</button></div>
    </header>

    {loadError && <div className="da-error da-error--load" role="alert"><p>{loadError}</p><button className="da-button da-button--secondary" type="button" onClick={() => void load()} disabled={loading}>Reintentar</button></div>}
    {loading && !data && <div className="da-loading" role="status" aria-live="polite">Cargando fuentes del análisis…</div>}
    {!loading && !data && !loadError && <EmptyState title="El análisis no devolvió datos">Actualizá la vista para volver a consultar las fuentes.</EmptyState>}

    <div className="da-tabs" role="tablist" aria-label="Vistas del análisis de decisión">
      {sectionOrder.map((item) => <button
        key={item}
        ref={(node) => { tabRefs.current[item] = node; }}
        id={`da-tab-${item}`}
        type="button"
        role="tab"
        aria-selected={activeSection === item}
        aria-controls={`da-panel-${item}`}
        tabIndex={activeSection === item ? 0 : -1}
        onClick={() => selectSection(item)}
        onKeyDown={(event) => onTabKeyDown(event, item)}
      >{sectionLabels[item]}</button>)}
    </div>
    {sectionOrder.map((item) => <section
      key={item}
      id={`da-panel-${item}`}
      className="da-tab-panel"
      role="tabpanel"
      aria-labelledby={`da-tab-${item}`}
      tabIndex={0}
      hidden={activeSection !== item}
      aria-label={`${sectionLabels[item]}: ${sectionDescriptions[item]}`}
    >{data ? <DecisionPanel section={item} data={data} onDownloadDelivery={(count, revenue) => downloadDeliveryCsv(count, revenue)} /> : loading ? null : <EmptyState title="Vista sin datos">Cargá el análisis para ver esta sección.</EmptyState>}</section>)}
    {data && <details className="da-evidence"><summary>Fuentes, historial importado y límites de la evidencia · {sourceStateText(asRecord(data.sourceState).state)}</summary><SourceStatePanel value={data.sourceState} /><ImportedHistoryPanel value={data.importedHistory} /></details>}
  </div>;
}
