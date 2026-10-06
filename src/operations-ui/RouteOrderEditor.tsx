import { useEffect, useState } from "react";
import { StatusTag } from "./Primitives";

export interface RouteOrderStop {
  deliveryId: string;
  title: string;
  detail: string;
  statusLabel: string;
  statusTone: "neutral" | "good" | "warn" | "bad" | "olive";
}

interface RouteOrderEditorProps {
  routeLabel?: string;
  stops: RouteOrderStop[];
  revision: number;
  disabled: boolean;
  onReview: (deliveryIds: string[]) => void;
}

export function RouteOrderEditor({ routeLabel = "esta ruta", stops, revision, disabled, onReview }: RouteOrderEditorProps) {
  const [editing, setEditing] = useState(false);
  const [order, setOrder] = useState(() => stops.map(stop => stop.deliveryId));
  const stopIds = stops.map(stop => stop.deliveryId);
  const stopSignature = JSON.stringify(stopIds);
  const currentFingerprint = JSON.stringify({ revision, stopIds });
  const [baseFingerprint, setBaseFingerprint] = useState<string | null>(null);
  const stale = editing && baseFingerprint !== currentFingerprint;
  useEffect(() => {
    if (!editing) setOrder(JSON.parse(stopSignature) as string[]);
  }, [editing, stopSignature]);
  const stopById = new Map(stops.map(stop => [stop.deliveryId, stop]));
  const orderedStops = order.flatMap(deliveryId => {
    const stop = stopById.get(deliveryId);
    return stop ? [stop] : [];
  });
  const expectedIds = stops.map(stop => stop.deliveryId);
  const completeOrder = order.length === expectedIds.length
    && new Set(order).size === order.length
    && order.every(deliveryId => stopById.has(deliveryId))
    && expectedIds.every(deliveryId => order.includes(deliveryId));
  const changed = completeOrder && order.some((deliveryId, index) => deliveryId !== expectedIds[index]);

  const move = (index: number, offset: -1 | 1) => {
    const destination = index + offset;
    if (disabled || stale || destination < 0 || destination >= order.length) return;
    setOrder(current => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination]!, next[index]!];
      return next;
    });
  };

  if (stops.length < 2 && !editing) return null;

  if (!editing) {
    return <button type="button" className="ops-button ops-button-quiet ops-button-small ops-route-order-start" aria-label={`Cambiar orden de paradas · ${routeLabel}`} disabled={disabled || stops.length < 2} onClick={() => {
      setOrder([...stopIds]);
      setBaseFingerprint(currentFingerprint);
      setEditing(true);
    }}>
      Cambiar orden de paradas · {routeLabel}
    </button>;
  }

  return <section className="ops-route-order-editor" aria-label={`Editar orden de paradas · ${routeLabel}`}>
    <p className="ops-route-order-help">Mové cada pedido con los botones. El orden de abajo es el que se propondrá al servidor; todavía no se modifica la ruta.</p>
    {stale && <p className="ops-route-order-note" role="alert">La ruta cambió desde que abriste este borrador. No se va a enviar el orden anterior. Cancelá y volvé a abrir el editor para cargar la versión actual.</p>}
    <ol className="ops-route-order-list" aria-label="Orden propuesto de paradas">
      {orderedStops.map((stop, index) => <li className="ops-route-order-row" key={stop.deliveryId}>
        <div className="ops-route-order-stop">
          <span className="ops-route-stop-index">Parada {index + 1}</span>
          <strong>{stop.title}</strong>
          <span>{stop.detail}</span>
          <StatusTag tone={stop.statusTone}>{stop.statusLabel}</StatusTag>
        </div>
        <div className="ops-route-order-controls" aria-label={`Controles para ${stop.title}`}>
          <button type="button" className="ops-button ops-button-quiet ops-button-small" aria-label={`Subir ${stop.title} una posición`} disabled={disabled || stale || index === 0} onClick={() => move(index, -1)}>↑ Subir</button>
          <button type="button" className="ops-button ops-button-quiet ops-button-small" aria-label={`Bajar ${stop.title} una posición`} disabled={disabled || stale || index === order.length - 1} onClick={() => move(index, 1)}>↓ Bajar</button>
        </div>
      </li>)}
    </ol>

    <div className="ops-route-order-preview">
      <h4>Vista previa del recorrido</h4>
      {completeOrder ? <ol aria-label="Vista previa humana del recorrido">
        {orderedStops.map((stop, index) => <li key={stop.deliveryId}><span>Parada {index + 1}</span><strong>{stop.title}</strong><small>{stop.detail} · {stop.statusLabel}</small></li>)}
      </ol> : <p className="ops-inline-error" role="alert">El orden debe conservar todas las entregas una sola vez.</p>}
    </div>

    <div className="ops-route-order-actions">
      <button type="button" className="ops-button ops-button-primary ops-button-small" disabled={disabled || stale || !completeOrder || !changed} onClick={() => {
        if (!disabled && !stale && baseFingerprint === currentFingerprint && completeOrder && changed) onReview([...order]);
      }}>Agregar evidencia y revisar</button>
      <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => {
        setOrder([...stopIds]);
        setBaseFingerprint(null);
        setEditing(false);
      }}>Cancelar edición</button>
    </div>
  </section>;
}
