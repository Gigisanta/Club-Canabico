import { useState, type FormEvent } from "react";
import { formatDecimal, moneyForQuantity, parseQuantity, roundHalfUp } from "../../shared/operations/exact";
import { amountFormToMinor, formatMinor } from "./money";
import { textValue } from "./api";

type Row = Record<string, unknown>;
export function CommercialMarginPreview({ packs }: { packs: Row[] }) {
  const [packId, setPackId] = useState("");
  const [result, setResult] = useState<{ currency: string; revenue: string; cost: string; extraCosts: string; contribution: string; margin: string | null; markup: string | null } | null>(null);
  const [error, setError] = useState("");
  const pack = packs.find(pack => pack.id === packId);
  const components = Array.isArray(pack?.components) ? pack.components as Row[] : [];
  function calculate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setResult(null);
    try {
      if (!pack) throw new Error("Elegí un pack para comparar su precio con costos previstos.");
      const form = new FormData(event.currentTarget), countText = String(form.get("count") ?? "");
      if (!/^[1-9]\d{0,4}$/.test(countText) || BigInt(countText) > 10000n) throw new Error("La cantidad de packs debe ser entera entre 1 y 10.000.");
      const count = BigInt(countText), currency = textValue(pack.currency), revenue = BigInt(String(pack.priceMinor)) * count;
      let cost = 0n;
      for (const [index, component] of components.entries()) {
        const unit = component.unit === "ud" ? "ud" : "g";
        const physical = String(form.get(`physical-${index}`) ?? "").replace(",", ".");
        const requested = parseQuantity(String(component.quantity), unit);
        const parsed = parseQuantity(physical, unit);
        if (parsed < requested || parsed <= 0n) throw new Error("El peso físico previsto debe cubrir la cantidad del componente y conservar su unidad.");
        const unitCost = String(form.get(`cost-${index}`) ?? "").replace(",", ".");
        if (!/^(0|[1-9]\d*)(?:\.\d{1,12})?$/.test(unitCost)) throw new Error("Cada costo unitario requiere un decimal positivo o cero, con hasta doce decimales.");
        cost += moneyForQuantity(formatDecimal(parsed * count, unit === "g" ? 3 : 0), unitCost);
      }
      const extraCosts = BigInt(amountFormToMinor(String(form.get("extraCosts") || "0")));
      if (extraCosts < 0n) throw new Error("Los otros costos variables no pueden ser negativos.");
      const contribution = revenue - cost - extraCosts;
      setResult({ currency, revenue: revenue.toString(), cost: cost.toString(), extraCosts: extraCosts.toString(), contribution: contribution.toString(), margin: revenue > 0n ? formatDecimal(roundHalfUp(contribution * 10000n, revenue), 2) : null, markup: cost > 0n ? formatDecimal(roundHalfUp((revenue - cost) * 10000n, cost), 2) : null });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Revisá los supuestos de costo."); }
  }
  return <section className="ops-sheet" aria-label="Margen previsto del pack">
    <div className="ops-sheet-head"><div><span className="ops-kicker">Propuesta comercial</span><h3>Margen previsto del pack</h3></div></div>
    <p className="ops-muted">Usá costos previstos en la moneda del pack. Este cálculo conserva los supuestos en esta pantalla; una propuesta necesita su aprobación comercial antes de activarse.</p>
    <form onSubmit={calculate}>
      <div className="ops-form-grid">
        <label className="ops-field"><span>Pack para simular</span><select value={packId} onChange={event => { setPackId(event.target.value); setResult(null); setError(""); }} required><option value="">Elegí un pack</option>{packs.map(pack => <option key={String(pack.id)} value={String(pack.id)}>{textValue(pack.name)} · {textValue(pack.currency)} · {textValue(pack.status)}</option>)}</select></label>
        <label className="ops-field"><span>Cantidad de packs a simular</span><input name="count" defaultValue="1" inputMode="numeric" required /></label>
        {components.map((component, index) => <fieldset className="ops-repeat-row ops-repeat-group" key={`${packId}:${index}`}><legend>{textValue(component.category, textValue(component.skuId, `Componente ${index + 1}`))} · {textValue(component.unit)}</legend>
          <label className="ops-field"><span>Cantidad física por pack · componente {index + 1}</span><input name={`physical-${index}`} defaultValue={String(component.quantity)} inputMode="decimal" required /></label>
          <label className="ops-field"><span>Costo por {component.unit === "g" ? "gramo" : "unidad"} · componente {index + 1}</span><input name={`cost-${index}`} inputMode="decimal" required /><small>{textValue(pack?.currency)}. Indicá el costo y su base de cantidad; no se obtiene de la tarifa de venta.</small></label>
        </fieldset>)}
        <label className="ops-field"><span>Otros costos variables previstos</span><input name="extraCosts" defaultValue="0" inputMode="decimal" /><small>Reparto, comisiones u otros costos previstos, en {textValue(pack?.currency, "la moneda del pack")} para toda la simulación.</small></label>
      </div>
      <button type="submit" className="ops-button ops-button-primary" disabled={!pack}>Calcular margen previsto</button>
    </form>
    {error && <p className="ops-inline-error" role="alert">{error}</p>}
    {result && <dl className="ops-detail-grid" aria-label="Resultado de la simulación">
      <div><dt>Ingreso previsto</dt><dd>{formatMinor(result.revenue, result.currency)}</dd></div>
      <div><dt>Costo físico previsto</dt><dd>{formatMinor(result.cost, result.currency)}</dd></div>
      <div><dt>Otros costos variables</dt><dd>{formatMinor(result.extraCosts, result.currency)}</dd></div>
      <div><dt>Contribución prevista antes de costos fijos</dt><dd>{formatMinor(result.contribution, result.currency)}</dd></div>
      <div><dt>Margen sobre venta</dt><dd>{result.margin === null ? "Sin base de venta" : `${result.margin} %`}</dd></div>
      <div><dt>Markup bruto sobre costo físico</dt><dd>{result.markup === null ? "Sin base de costo" : `${result.markup} %`}</dd></div>
    </dl>}
  </section>;
}
