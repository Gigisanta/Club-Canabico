import { useEffect, useRef, useState } from "react";
import { apiGet, OperationsApiError, recordValue, textValue } from "./api";
import { formatMinor } from "./money";
import { EmptyState, ErrorState, InfoBand, LoadingState, SectionHeading } from "./Primitives";

type Row = Record<string, unknown>;
type Stream = "stock" | "history";

function rows(value: unknown, key: string): Row[] {
  const result = recordValue(value, key);
  return Array.isArray(result) ? result.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
}

function appendUnique(previous: Row[], next: Row[]): Row[] {
  const seen = new Set(previous.map(item => textValue(item.id, "")));
  return [...previous, ...next.filter(item => !seen.has(textValue(item.id, "")))];
}

function kindLabel(value: unknown) {
  const labels: Record<string, string> = { purchase: "Compra histórica", stock: "Movimiento de stock histórico", "sale-line": "Venta histórica" };
  const kind = textValue(value, "Hecho histórico");
  return labels[kind] ?? kind.replaceAll("_", " ");
}

function dateLabel(fact: Row) {
  if (fact.dateState === "known" && typeof fact.occurredOn === "string") return fact.occurredOn;
  if (typeof fact.occurredAt === "string") return fact.occurredAt.slice(0, 10);
  return fact.dateState === "known" && typeof fact.date === "string" ? fact.date
    : `Fecha no identificada · ${textValue(fact.dateState, "sin clasificar")}`;
}

function quantityLabel(fact: Row) {
  const quantity = fact.quantity;
  if (fact.quantityState !== "known" || (typeof quantity !== "string" && typeof quantity !== "number"))
    return `Cantidad no identificada · ${textValue(fact.quantityState, "sin clasificar")}`;
  const unit = fact.unitState === "known" && typeof fact.unit === "string" ? fact.unit : "unidad no identificada";
  return `${String(quantity)} ${unit}`;
}

function amountLabel(fact: Row) {
  const amount = fact.amountMinor;
  if (fact.amountState !== "known" || (typeof amount !== "string" && typeof amount !== "bigint")) return "Importe restringido o no identificado";
  if (fact.currencyState === "known" && (fact.currency === "ARS" || fact.currency === "USD")) return formatMinor(amount, fact.currency);
  const currency = fact.currencyState === "known" && typeof fact.currency === "string" ? fact.currency : "moneda no identificada";
  return `${String(amount)} unidades mínimas · ${currency}`;
}

export function ProductInspector({ skuId, skuName, refreshKey, canReadFinance, onClose }: {
  skuId: string;
  skuName: string;
  refreshKey: number;
  canReadFinance: boolean;
  onClose: () => void;
}) {
  const [stockItems, setStockItems] = useState<Row[]>([]);
  const [historyItems, setHistoryItems] = useState<Row[]>([]);
  const [stockCursor, setStockCursor] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [stockHasMore, setStockHasMore] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [coverage, setCoverage] = useState<Row | null>(null);
  const [loading, setLoading] = useState<Stream | "initial" | "">("initial");
  const [errors, setErrors] = useState<{ stock: string; history: string }>({ stock: "", history: "" });
  const requestGeneration = useRef(0);

  async function load(stream: Stream, cursor: string | null = null, reset = false) {
    const generation = requestGeneration.current;
    setLoading(stream);
    setErrors(previous => ({ ...previous, [stream]: "" }));
    const params = new URLSearchParams({ limit: "50" });
    if (!reset && cursor) params.set(stream === "stock" ? "cursor" : "historicalCursor", cursor);
    try {
      const response = await apiGet<Row>(`/api/operations/catalog/${encodeURIComponent(skuId)}/history?${params}`);
      if (generation !== requestGeneration.current) return;
      if (stream === "stock") {
        const page = rows(response, "items");
        setStockItems(previous => reset || !cursor ? page : appendUnique(previous, page));
        setStockCursor(typeof response.nextCursor === "string" ? response.nextCursor : null);
        setStockHasMore(response.hasMore === true);
      } else {
        const page = rows(response, "historicalItems");
        setHistoryItems(previous => reset || !cursor ? page : appendUnique(previous, page));
        setHistoryCursor(typeof response.historicalNextCursor === "string" ? response.historicalNextCursor : null);
        setHistoryHasMore(response.historicalHasMore === true);
        const safeCoverage = recordValue(response, "coverage");
        setCoverage(safeCoverage && typeof safeCoverage === "object" ? safeCoverage as Row : null);
      }
    } catch (cause) {
      if (generation !== requestGeneration.current) return;
      if (stream === "history" && cause instanceof OperationsApiError && (cause.code === "HISTORY_POPULATION_CHANGED" || cause.code === "HISTORY_CURSOR_INVALID")) {
        setHistoryItems([]);
        setHistoryCursor(null);
        setHistoryHasMore(false);
        setErrors(previous => ({ ...previous, history: "Cambió el conjunto de hechos históricos aprobados. Volvé a consultar esta historia; los movimientos actuales siguen disponibles." }));
      } else {
        setErrors(previous => ({ ...previous, [stream]: cause instanceof Error ? cause.message : "No se pudo cargar el historial." }));
      }
    } finally {
      if (generation === requestGeneration.current) setLoading("");
    }
  }

  useEffect(() => {
    requestGeneration.current += 1;
    setStockItems([]); setHistoryItems([]); setStockCursor(null); setHistoryCursor(null);
    setStockHasMore(false); setHistoryHasMore(false); setCoverage(null); setErrors({ stock: "", history: "" });
    void load("stock", null, true);
    void load("history", null, true);
    return () => { requestGeneration.current += 1; };
  // load intentionally tracks only the selected SKU and explicit refresh generation.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skuId, refreshKey]);

  const historicalState = textValue(recordValue(coverage, "historical"), "approved-catalogue-identity-pending");
  return <section className="ops-sheet ops-product-inspector">
    <SectionHeading eyebrow="Inventario · trazabilidad" title={skuName || "Historia del producto"} detail="Los hechos históricos aprobados conservan sus unidades y monedas originales; no crean saldos ni movimientos locales." action={<button type="button" className="ops-button ops-button-quiet" onClick={onClose}>Cerrar historia</button>} />
    {coverage && <InfoBand title="Cobertura histórica"><p>{historicalState.replaceAll("-", " ")}. La historia de stock queda separada de la existencia actual. Las relaciones no resueltas no se agregan a esta ficha.</p></InfoBand>}
    {loading === "initial" && !stockItems.length && !historyItems.length && <LoadingState label="Consultando movimientos e historia aprobada…" />}
    <div className="ops-member-history-grid">
      <section>
        <h3>Movimientos actuales</h3>
        {errors.stock && <ErrorState message={errors.stock} retry={() => void load("stock", null, true)} />}
        {stockItems.length ? <ul className="ops-fact-list">{stockItems.map((fact, index) => <li key={textValue(fact.id, String(index))}>
          <strong>{dateLabel(fact)} · {kindLabel(fact.kind)}</strong>
          <span>{quantityLabel(fact)} · lote {textValue(fact.lotLabel, "sin lote identificado")}</span>
          {canReadFinance && fact.costMinor !== null && fact.costMinor !== undefined && <span>Costo registrado · {amountLabel({ amountMinor: fact.costMinor, amountState: "known", currency: fact.costCurrency, currencyState: fact.costCurrency ? "known" : "unknown" })}</span>}
        </li>)}</ul> : loading === "stock" ? <LoadingState label="Cargando movimientos actuales…" /> : <EmptyState title="Sin movimientos actuales visibles" detail="No hay movimientos de stock asociados a los lotes de este producto dentro del alcance." />}
        {stockHasMore && stockCursor && <button type="button" className="ops-button ops-button-quiet" onClick={() => void load("stock", stockCursor)} disabled={loading !== ""}>Cargar más movimientos</button>}
      </section>
      <section>
        <h3>Historia legada aprobada</h3>
        {errors.history && <InfoBand tone="warning" title="La historia cambió o requiere revisión"><p>{errors.history} <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => void load("history", null, true)} disabled={loading !== ""}>Volver a consultar</button></p></InfoBand>}
        {historyItems.length ? <ul className="ops-fact-list">{historyItems.map((fact, index) => {
          const provenance = recordValue(fact, "provenance");
          return <li key={textValue(fact.id, String(index))}>
            <strong>{dateLabel(fact)} · {kindLabel(fact.kind)}</strong>
            <span>{quantityLabel(fact)} · moneda {fact.currencyState === "known" && typeof fact.currency === "string" ? fact.currency : "no identificada"} · {amountLabel(fact)}</span>
            <span>{textValue(recordValue(provenance, "sourceTable"), "Origen aprobado")} · fila {textValue(recordValue(provenance, "sourceRow"), "no identificada")} · {textValue(fact.relationship, "relación de catálogo")}</span>
          </li>;
        })}</ul> : loading === "history" ? <LoadingState label="Cargando hechos aprobados…" /> : <EmptyState title="No hay hechos históricos aprobados para mostrar" detail="Las fuentes sin identidad de catálogo aprobada o publicación revisada quedan fuera de esta historia." />}
        {historyHasMore && historyCursor && <button type="button" className="ops-button ops-button-quiet" onClick={() => void load("history", historyCursor)} disabled={loading !== ""}>Cargar más historia</button>}
      </section>
    </div>
  </section>;
}
