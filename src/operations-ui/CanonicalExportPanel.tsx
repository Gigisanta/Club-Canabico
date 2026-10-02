import { useEffect, useRef, useState } from "react";
import { apiGet, hasCapability } from "./api";
import { ActionButton, ErrorState, InfoBand } from "./Primitives";
import type { OperationsContext } from "./types";

type Block = { csv: string; rows: number; nextCursor: string | null; fingerprint: string; coverage: { totalRows: string; population: string } };
export function CanonicalExportPanel({ context }: { context: OperationsContext }) {
  const [feed, setFeed] = useState("sales-lines"), [from, setFrom] = useState(""), [to, setTo] = useState("");
  const [cursor, setCursor] = useState<string | null>(null), [parts, setParts] = useState(0), [complete, setComplete] = useState(false), [total, setTotal] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  if (!hasCapability(context, "reports.read") || !hasCapability(context, "finance.read")) return null;
  const reset = () => { setCursor(null); setParts(0); setComplete(false); setTotal(""); setError(""); };
  async function download() {
    const request = new AbortController(); controller.current = request; setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ limit: "200", ...(from ? { from } : {}), ...(to ? { to } : {}), ...(cursor ? { cursor } : {}) });
      const block = await apiGet<Block>(`/api/reports/operations/exports/${feed}?${query}`, { signal: request.signal });
      if (request.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([block.csv], { type: "text/csv;charset=utf-8" }));
      const link = document.createElement("a"); link.href = url; link.download = `bombo-${feed}-parte-${parts+1}-${block.fingerprint.slice(0,12)}.csv`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setParts(value => value+1); setCursor(block.nextCursor); setComplete(!block.nextCursor); setTotal(block.coverage.totalRows);
    } catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "No se pudo descargar la parte."); }
    finally { if (!request.signal.aborted) setBusy(false); }
  }
  return <section className="ops-sheet" aria-label="Exportación canónica">
    <div className="ops-sheet-head"><h3>Exportar hechos verificables</h3></div>
    <InfoBand title="Importes, moneda y procedencia"><p>Cada parte contiene hasta 200 hechos. Conservá todas las partes del mismo fingerprint. Historia aprobada y operaciones nuevas tienen poblaciones separadas. Los valores desconocidos incluyen su estado; las fechas desconocidas sólo se incluyen sin filtro de período.</p></InfoBand>
    <div className="ops-form-grid">
      <label className="ops-field"><span>Hechos</span><select value={feed} disabled={busy || parts > 0} onChange={event => { setFeed(event.target.value); reset(); }}>
        <option value="sales-lines">Detalle de ventas nuevas</option><option value="ledger">Movimientos de cuentas</option>
        {hasCapability(context, "stock.read") && <option value="stock">Movimientos físicos</option>}
        {hasCapability(context, "imports.review") && <option value="history">Historia aprobada</option>}
      </select></label>
      <label className="ops-field"><span>Desde</span><input type="date" value={from} disabled={busy || parts > 0} onChange={event => { setFrom(event.target.value); reset(); }} /></label>
      <label className="ops-field"><span>Hasta</span><input type="date" value={to} disabled={busy || parts > 0} onChange={event => { setTo(event.target.value); reset(); }} /></label>
    </div>
    {error && <ErrorState message={error} />}
    {parts > 0 && <p>{parts} partes descargadas · {total} hechos en la población · {complete ? "Descarga completa" : "Hay más partes"}.</p>}
    <div className="ops-upload-foot"><ActionButton disabled={busy || complete || !!from && !!to && from > to} onClick={() => void download()}>{busy ? "Preparando parte…" : parts ? "Descargar próxima parte" : "Descargar primera parte"}</ActionButton><ActionButton quiet disabled={busy} onClick={reset}>Reiniciar exportación</ActionButton></div>
  </section>;
}
