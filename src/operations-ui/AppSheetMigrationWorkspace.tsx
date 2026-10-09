import { useSearchParams } from "react-router-dom";
import { DataTable, EmptyState, ErrorState, InfoBand, LoadingState, SectionHeading, StatusTag } from "./Primitives";
import { formatMinor } from "./money";
import { useRemote } from "./useRemote";
import type { AppSheetHistoryPage, AppSheetMigrationCapture, AppSheetMigrationSnapshot, AppSheetMigrationSummary, AppSheetPendingPage } from "../../shared/operations/appsheet-migration";
import type { AppSheetPendingDimension, AppSheetPendingReconciliation, AppSheetPendingRelationship, AppSheetPendingStatus } from "../../shared/operations/appsheet-pending";

const kindLabels: Record<string, string> = {
  invoice: "Facturas",
  "sale-line": "Detalle de ventas",
  purchase: "Compras",
  stock: "Movimientos de stock",
  cash: "Movimientos de dinero",
  expense: "Gastos",
  fx: "Operaciones de moneda",
  delivery: "Entregas",
  archive: "Archivo auxiliar",
};

type Selection =
  | { type: "capture"; value: AppSheetMigrationCapture }
  | { type: "preliminary"; value: AppSheetMigrationSnapshot & { createdAt: string; manifestHash: string } };

function dateLabel(value: string) {
  const civilDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (civilDate) return `${civilDate[3]}/${civilDate[2]}/${civilDate[1]}`;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Fecha no disponible"
    : new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Argentina/Buenos_Aires" }).format(date);
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    staged: "Conservado para revisión",
    previewed: "Vista previa preparada",
    applied: "Carga derivada registrada",
    rejected: "Rechazado con evidencia conservada",
  };
  return labels[value] ?? "Pendiente de revisión";
}

function valueStateLabel(value: string) {
  const labels: Record<string, string> = {
    known: "Disponible en la fuente",
    absent: "No informado en la fuente",
    invalid: "No interpretable",
    "not-applicable": "No corresponde",
    unknown: "Pendiente de verificar",
  };
  return labels[value] ?? "Pendiente de verificar";
}

function exactDecimalFromMinor(value: string) {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return null;
  try {
    const minor = BigInt(value);
    const absolute = minor < 0n ? -minor : minor;
    const whole = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const fraction = (absolute % 100n).toString().padStart(2, "0");
    return `${minor < 0n ? "−" : ""}${whole},${fraction}`;
  } catch {
    return null;
  }
}

function amountLabel(amountMinor: string | null, currency: string | null) {
  if (amountMinor === null) return "Sin importe derivado";
  if (currency === "ARS" || currency === "USD") return formatMinor(amountMinor, currency);
  const exactDecimal = exactDecimalFromMinor(amountMinor);
  return exactDecimal === null ? "Importe no interpretable" : `${exactDecimal} · moneda sin verificar`;
}

const pendingDimensionLabels: Record<keyof AppSheetPendingReconciliation["dimensions"], string> = {
  preSale: "Preventa",
  receivable: "Cobro de factura",
  unpaidPurchase: "Compra recibida y pago",
  delivery: "Entrega",
};

const pendingStatusLabels: Record<AppSheetPendingStatus, string> = {
  confirmed_pending: "Pendiente confirmado por relaciones",
  not_pending: "Sin pendiente según la evidencia observada",
  needs_review: "Requiere revisión",
  not_applicable: "No corresponde a este registro",
};

const pendingReasonLabels: Record<string, string> = {
  presale_source_evidence_unresolved: "Faltan datos de origen para resolver la preventa.",
  presale_cancelled: "La preventa figura cancelada y no se encontró un vínculo conflictivo.",
  cancelled_presale_has_conflicting_relationships: "La preventa cancelada tiene vínculos que requieren revisión.",
  presale_status_not_recognized: "El estado de la preventa no coincide con los estados reconocidos.",
  presale_has_invoice_reference: "La preventa tiene una factura vinculada.",
  presale_invoice_reference_ambiguous: "La referencia de factura coincide con más de un registro.",
  presale_has_no_linked_details: "No se encontraron detalles vinculados a la preventa.",
  presale_detail_relationship_unresolved: "No se pudo resolver el vínculo con los detalles de la preventa.",
  confirmed_presale_without_invoice_and_with_details: "La preventa está confirmada, tiene detalles y no tiene factura vinculada.",
  receivable_relationship_or_source_unresolved: "Faltan datos para resolver la factura o sus movimientos.",
  invoice_detail_relationship_not_proven: "No se pudo demostrar el vínculo entre la factura y sus detalles.",
  legacy_movement_overlap_not_settled: "Hay movimientos en ambas fuentes que requieren conciliación.",
  invoice_currency_missing_no_default_applied: "La factura no informa moneda; no se asignó una por defecto.",
  invoice_total_not_exact: "El total de la factura no pudo interpretarse con precisión exacta.",
  invoice_total_zero_or_ambiguous: "El total de la factura es cero o ambiguo.",
  payment_fields_unresolved: "Faltan datos para interpretar uno o más movimientos vinculados.",
  linked_movement_is_not_explicit_income: "Un movimiento vinculado no está identificado explícitamente como ingreso.",
  payment_currency_differs_from_invoice: "La moneda del movimiento difiere de la moneda de la factura.",
  payment_amount_not_exact: "Un movimiento no pudo interpretarse con precisión exacta.",
  explicit_invoice_currency_and_partial_payments: "La factura y los cobros explícitos dejan un saldo pendiente.",
  invoice_fully_paid_in_explicit_currency: "Los cobros explícitos igualan el total en la moneda de la factura.",
  payments_exceed_invoice_total: "Los movimientos vinculados superan el total de la factura.",
  purchase_or_payment_relationship_unresolved: "Faltan datos para resolver la compra o sus movimientos.",
  purchase_receipt_status_not_proven: "La recepción de la compra no está demostrada por el estado de origen.",
  purchase_total_due_and_currency_not_source_proven: "La fuente no demuestra el total adeudado ni su moneda.",
  delivery_invoice_reference_ambiguous: "La referencia de factura de la entrega coincide con varios registros.",
  delivery_invoice_reference_unresolved: "No se pudo resolver la factura de la entrega.",
  delivery_route_reference_ambiguous: "La referencia de ruta coincide con varios registros.",
  delivery_route_reference_unresolved: "No se pudo resolver la ruta de la entrega.",
  delivery_route_status_unresolved: "No se pudo verificar el estado de la ruta.",
  delivery_route_not_confirmed_active: "La ruta vinculada no está confirmada como activa.",
  delivery_completion_explicit_true: "La fuente marca explícitamente la entrega como completada.",
  delivery_not_completed_on_active_route: "La entrega figura pendiente en una ruta activa.",
  delivery_not_completed_without_route_assignment: "La entrega figura pendiente y todavía no tiene ruta asignada.",
  delivery_completion_status_ambiguous: "El estado de finalización de la entrega no es concluyente.",
};

function fieldLabel(value: string) {
  const labels: Record<string, string> = {
    Estado_Preventa: "Estado de preventa",
    Id_facturado: "Referencia de factura",
    Id_Preventa: "ID de preventa",
    Id_Pre_Venta: "ID de preventa",
    Id_Factura: "ID de factura",
    N_factura: "Número de factura",
    N_Factura: "Número de factura",
    Total_Facturado: "Total facturado",
    Tipo_Moneda: "Moneda",
    Monto: "Importe",
    Tipo_Movimiento: "Tipo de movimiento",
    Tabla_Origen: "Tabla de origen",
    Origen_ID: "ID de origen",
    ID_Origen_2: "Referencia de origen",
    ID_Mercaderia: "ID de mercadería",
    Tipo_Registro_Mercaderia: "Tipo de registro de mercadería",
    Precio_Total_Abonado: "Total abonado informado",
    Entrega_completada: "Entrega completada",
    Moto_Ruta_ID: "Referencia de ruta",
    Ruta_ID: "ID de ruta",
    Ruta_Activa: "Ruta activa",
    "Pre_Detalle_Fact.Id_Pre_Venta": "Detalle de preventa · ID de preventa",
    "C_Facturacion.N_Factura": "Facturación · número de factura",
    "C_Moto.N_Factura": "Moto · número de factura",
    "C_Moto.Id_Moto": "Moto · ID de registro",
    "C_Mercaderia.ID_Mercaderia": "Mercadería · ID de registro",
    "Movimiento_Nueva.Monto": "Movimiento nuevo · importe",
    "Movimiento_Nueva.Tipo_Moneda": "Movimiento nuevo · moneda",
    "Movimiento_Nueva.Tipo_Movimiento": "Movimiento nuevo · tipo",
    "Movimiento_Nueva.Origen_ID": "Movimiento nuevo · ID de origen",
    "Movimiento_Nueva.ID_Origen_2": "Movimiento nuevo · referencia de origen",
    "Movimiento_Nueva.Tabla_Origen": "Movimiento nuevo · tabla de origen",
    "O_Ruta.Ruta_Activa": "Ruta · estado activo",
  };
  return labels[value] ?? value.replaceAll("_", " ").replaceAll(".", " · ");
}

function relationshipStatusLabel(value: AppSheetPendingRelationship["status"]) {
  const labels: Record<AppSheetPendingRelationship["status"], string> = {
    unique: "un vínculo encontrado",
    multiple: "varios vínculos encontrados",
    missing: "sin vínculo encontrado",
    ambiguous: "vínculo ambiguo",
    unresolved: "no se pudo resolver",
    not_applicable: "no corresponde",
  };
  return labels[value];
}

function evidenceReasonLabel(value: string) {
  return pendingReasonLabels[value] ?? value.replaceAll("_", " ");
}

function pendingDimensionView(label: string, value: AppSheetPendingDimension) {
  return <section className="ops-sheet" key={label} aria-label={label}>
    <div className="ops-sheet-head"><div><span className="ops-kicker">Dimensión</span><h4>{label}</h4></div><StatusTag tone={value.status === "not_applicable" ? "neutral" : "warn"}>{pendingStatusLabels[value.status]}</StatusTag></div>
    {!!value.reasonCodes.length && <div><strong>Resultado observado</strong><ul>{value.reasonCodes.map(reason => <li key={reason}>{evidenceReasonLabel(reason)}</li>)}</ul></div>}
    {!!value.evidenceFields.length && <div><strong>Campos revisados</strong><ul>{value.evidenceFields.map(field => <li key={field}><code>{fieldLabel(field)}</code></li>)}</ul></div>}
    {!!value.relationships.length && <div><strong>Relaciones observadas</strong><ul>{value.relationships.map((relation, index) => {
      const targets = relation.targets ?? (relation.target ? [relation.target] : []);
      const visibleTargets = targets.slice(0, 5);
      return <li key={`${relation.sourceField}:${relation.targetTable}.${relation.targetField}:${index}`}>
        <span><code>{fieldLabel(relation.sourceField)}</code> → <code>{relation.targetTable}.{fieldLabel(relation.targetField)}</code>: {relationshipStatusLabel(relation.status)}{relation.matchCount !== null ? ` (${relation.matchCount})` : ""}.</span>
        {visibleTargets.length > 0 && <small> Filas vinculadas: {visibleTargets.map(target => `${target.sourceTable}, fila ${target.sourceRow}`).join("; ")}{targets.length > visibleTargets.length ? `; y ${targets.length - visibleTargets.length} más` : ""}.</small>}
      </li>;
    })}</ul></div>}
    {value.settlement && <div><strong>Importes derivados para revisar</strong><ul>
      <li>Total informado: {amountLabel(value.settlement.dueMinorUnits, value.settlement.currency)}</li>
      <li>Movimientos vinculados: {amountLabel(value.settlement.paidMinorUnits, value.settlement.currency)}</li>
      <li>Diferencia calculada: {amountLabel(value.settlement.remainingMinorUnits, value.settlement.currency)}</li>
    </ul><small>La diferencia es una clasificación de fuente y no aprueba ni registra un cobro.</small></div>}
  </section>;
}

function selectedTables(selection: Selection | null) {
  const counts = new Map<string, number>();
  const snapshots = selection?.type === "capture" ? selection.value.snapshots : selection ? [selection.value] : [];
  for (const snapshot of snapshots) {
    for (const table of snapshot.tables) counts.set(table.name, (counts.get(table.name) ?? 0) + table.records);
  }
  return [...counts].map(([name, records]) => ({ name, records })).sort((a, b) => a.name.localeCompare(b.name));
}

export function AppSheetMigrationWorkspace({ refreshKey }: { refreshKey: number }) {
  const [params, setParams] = useSearchParams();
  const summary = useRemote<AppSheetMigrationSummary>("/api/operations/appsheet-migration", refreshKey);
  const requestedCapture = params.get("capture");
  const requestedSnapshot = params.get("snapshot");
  const hasExplicitSelection = requestedCapture !== null || requestedSnapshot !== null;
  const capture = summary.data?.captures.find(item => item.captureId === requestedCapture);
  const preliminary = summary.data?.preliminary.find(item => item.id === requestedSnapshot);
  const defaultPreliminary = !hasExplicitSelection ? summary.data?.preliminary[0] : undefined;
  const defaultCapture = !hasExplicitSelection && !defaultPreliminary ? summary.data?.captures[0] : undefined;
  const selection: Selection | null = capture
    ? { type: "capture", value: capture }
    : preliminary
      ? { type: "preliminary", value: preliminary }
      : defaultPreliminary
        ? { type: "preliminary", value: defaultPreliminary }
        : defaultCapture
          ? { type: "capture", value: defaultCapture }
          : null;
  const table = params.get("sourceTable") ?? "";
  const requestedKind = params.get("sourceKind") ?? "all";
  const kind = requestedKind === "all" || Object.prototype.hasOwnProperty.call(kindLabels, requestedKind) ? requestedKind : "all";
  const cursor = params.get("sourceCursor");
  const tables = selectedTables(selection);
  const selectedTableIsAvailable = !table || tables.some(item => item.name === table);
  const activeTable = selectedTableIsAvailable ? table : "";
  const historyQuery = new URLSearchParams({ limit: "50" });
  if (kind !== "all") historyQuery.set("kind", kind);
  if (activeTable) historyQuery.set("table", activeTable);
  if (cursor && selectedTableIsAvailable) historyQuery.set("cursor", cursor);
  const historyPath = selection
    ? selection.type === "capture"
      ? `/api/operations/appsheet-migration/${encodeURIComponent(selection.value.captureId)}/history?${historyQuery}`
      : `/api/operations/appsheet-migration/snapshots/${encodeURIComponent(selection.value.id)}/history?${historyQuery}`
    : null;
  const history = useRemote<AppSheetHistoryPage>(historyPath, refreshKey);
  const pendingTable = params.get("pendingTable") ?? "";
  const pendingDimension = params.get("pendingDimension") ?? "";
  const pendingStatus = params.get("pendingStatus") ?? "";
  const pendingCursor = params.get("pendingCursor");
  const selectedPendingTableIsAvailable = !pendingTable || tables.some(item => item.name === pendingTable);
  const activePendingTable = selectedPendingTableIsAvailable ? pendingTable : "";
  const pendingQuery = new URLSearchParams({ limit: "50" });
  if (activePendingTable) pendingQuery.set("table", activePendingTable);
  if (pendingDimension) pendingQuery.set("dimension", pendingDimension);
  if (pendingStatus && pendingDimension) pendingQuery.set("status", pendingStatus);
  if (pendingCursor && selectedPendingTableIsAvailable) pendingQuery.set("cursor", pendingCursor);
  const pendingPath = selection
    ? selection.type === "capture"
      ? `/api/operations/appsheet-migration/${encodeURIComponent(selection.value.captureId)}/pending?${pendingQuery}`
      : `/api/operations/appsheet-migration/snapshots/${encodeURIComponent(selection.value.id)}/pending?${pendingQuery}`
    : null;
  const pending = useRemote<AppSheetPendingPage>(pendingPath, refreshKey);

  function select(key: string, value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== "sourceCursor") next.delete("sourceCursor");
      if (key === "sourceTable") next.delete("sourceCursor");
      if (key === "snapshot" || key === "capture") {
        next.delete("sourceTable");
        next.delete("pendingCursor");
        next.delete("pendingTable");
        next.delete("pendingDimension");
        next.delete("pendingStatus");
      }
      return next;
    });
  }

  function selectPending(key: string, value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value);
      else next.delete(key);
      next.delete("pendingCursor");
      if (key === "pendingDimension") next.delete("pendingStatus");
      return next;
    });
  }

  function selectSource(value: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.delete("sourceCursor");
      next.delete("sourceTable");
      next.delete("capture");
      next.delete("snapshot");
      next.delete("pendingCursor");
      next.delete("pendingTable");
      next.delete("pendingDimension");
      next.delete("pendingStatus");
      if (value.startsWith("snapshot:")) next.set("snapshot", value.slice("snapshot:".length));
      else if (value.startsWith("capture:")) next.set("capture", value.slice("capture:".length));
      return next;
    });
  }

  const selectionValue = selection ? `${selection.type === "capture" ? "capture" : "snapshot"}:${selection.type === "capture" ? selection.value.captureId : selection.value.id}` : "";
  const sourceSelectionMissing = hasExplicitSelection && !selection;
  const activePendingStatus = pendingDimension ? pendingStatus : "";

  return <>
    <SectionHeading eyebrow="Procedencia y conciliación" title="Migración de AppSheet" detail="Consultá la captura, su historia y los puntos que requieren verificación." />
    {summary.error && <ErrorState message={summary.error} retry={summary.retry} />}
    {summary.loading && <LoadingState label="Leyendo la cobertura de la migración…" />}
    {!summary.loading && !summary.error && !selection && <EmptyState
      title={sourceSelectionMissing ? "La captura seleccionada ya no está disponible" : "Todavía no hay una captura derivada cargada"}
      detail={sourceSelectionMissing ? "Elegí otra captura para consultar su historia." : "El archivo técnico existente se consulta en Datos cargados. La captura aparecerá aquí después de su importación."}
    />}
    {selection && <>
      {selection.type === "preliminary" ? <InfoBand tone="warning" title="Fuente activa · corte pendiente">
        Este lote conserva datos de una lectura preliminar. AppSheet puede seguir cambiando; la cobertura no representa un cierre conciliado y ningún registro de este lote está certificado.
      </InfoBand> : <InfoBand tone="warning" title="Historia conservada · certificación pendiente">
        Esta captura conserva los valores de la fuente. La consulta no genera cobros, entregas ni movimientos de stock; sus registros siguen pendientes de conciliación.
      </InfoBand>}

      <div className="ops-filter-row">
        <label>Captura o lote<select value={selectionValue} onChange={event => selectSource(event.target.value)}>
          {(summary.data?.preliminary.length ?? 0) > 0 && <optgroup label="Fuente activa · lotes preliminares">
            {summary.data?.preliminary.map(item => <option key={`snapshot:${item.id}`} value={`snapshot:${item.id}`}>
              {dateLabel(item.createdAt)} · {item.records.toLocaleString("es-AR")} registros · corte pendiente
            </option>)}
          </optgroup>}
          {(summary.data?.captures.length ?? 0) > 0 && <optgroup label="Capturas con corte verificado">
            {summary.data?.captures.map(item => <option key={`capture:${item.captureId}`} value={`capture:${item.captureId}`}>
              {dateLabel(item.cutoffAt)} · {item.records.toLocaleString("es-AR")} registros
            </option>)}
          </optgroup>}
        </select></label>
      </div>

      {selection.type === "capture" ? <>
        <DataTable label="Cobertura de la captura"><thead><tr><th>Libro</th><th>Lectura verificada</th><th>Registros fuente</th><th>Fórmulas de Sheets</th></tr></thead><tbody><tr>
          <td>{selection.value.sheets} hojas · {selection.value.pages} páginas</td><td>{dateLabel(selection.value.verifiedAt)}</td><td>{selection.value.records.toLocaleString("es-AR")}</td><td>{selection.value.formulas.toLocaleString("es-AR")} · {selection.value.unresolvedFormulas.toLocaleString("es-AR")} sin resultado observado</td>
        </tr></tbody></DataTable>
        <details><summary>Definición y huellas de origen</summary>
          <p>{selection.value.inventory.tables ?? "Pendiente"} tablas · {selection.value.inventory.columns ?? "Pendiente"} columnas · {selection.value.inventory.slices ?? "Pendiente"} slices · {selection.value.inventory.views ?? "Pendiente"} vistas · {selection.value.inventory.actions ?? "Pendiente"} acciones · {selection.value.inventory.bots ?? "Pendiente"} bots inventariados</p>
          <p>Manifiesto de datos SHA-256: <code>{selection.value.manifestHash}</code></p>
          <p>Definición SHA-256: <code>{selection.value.definitionHash ?? "Pendiente de captura"}</code></p>
        </details>
        <DataTable label="Lotes de la captura"><thead><tr><th>Lote</th><th>Registros</th><th>Hechos históricos</th><th>Excepciones abiertas</th><th>Estado</th></tr></thead><tbody>{selection.value.snapshots.map(snapshot => <tr key={snapshot.id}>
          <td>{snapshot.importerVersion}</td><td>{snapshot.records.toLocaleString("es-AR")}</td><td>{snapshot.facts.toLocaleString("es-AR")}</td><td>{snapshot.openExceptions.toLocaleString("es-AR")}</td><td><StatusTag tone="warn">{statusLabel(snapshot.status)}</StatusTag></td>
        </tr>)}</tbody></DataTable>
      </> : <>
        <DataTable label="Cobertura del lote preliminar"><thead><tr><th>Lote</th><th>Preparado</th><th>Registros fuente</th><th>Hechos históricos</th><th>Excepciones abiertas</th><th>Estado</th></tr></thead><tbody><tr>
          <td>{selection.value.importerVersion}</td><td>{dateLabel(selection.value.createdAt)}</td><td>{selection.value.records.toLocaleString("es-AR")}</td><td>{selection.value.facts.toLocaleString("es-AR")}</td><td>{selection.value.openExceptions.toLocaleString("es-AR")}</td><td><StatusTag tone="warn">{statusLabel(selection.value.status)}</StatusTag></td>
        </tr></tbody></DataTable>
        <details><summary>Procedencia del lote</summary>
          <p>El lote fue derivado mientras la fuente podía seguir recibiendo cambios; esta huella identifica la importación mostrada.</p>
          <p>Huella de importación SHA-256: <code>{selection.value.manifestHash}</code></p>
        </details>
      </>}

      <DataTable label="Cobertura por tabla de origen"><thead><tr><th>Tabla</th><th>Registros conservados</th></tr></thead><tbody>
        {tables.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.records.toLocaleString("es-AR")}</td></tr>)}
        {!tables.length && <tr><td colSpan={2}>Este lote todavía no informa tablas derivadas.</td></tr>}
      </tbody></DataTable>

      <SectionHeading title="Historia de la fuente" detail="Se muestran los valores conservados por el importador. Los valores sin moneda, fecha o unidad verificada siguen identificados como pendientes." />
      <div className="ops-filter-row">
        <label>Tipo de registro<select value={kind} onChange={event => select("sourceKind", event.target.value)}><option value="all">Todas las historias</option>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Tabla de origen<select value={selectedTableIsAvailable ? table : ""} onChange={event => select("sourceTable", event.target.value)}><option value="">Todas las tablas</option>{tables.map(item => <option key={item.name} value={item.name}>{item.name} · {item.records.toLocaleString("es-AR")}</option>)}</select></label>
      </div>
      {!selectedTableIsAvailable && <InfoBand tone="warning" title="La tabla elegida no está en este lote">La consulta se restableció a todas las tablas disponibles.</InfoBand>}
      {history.loading && <LoadingState label="Leyendo los registros originales…" />}
      {history.error && <ErrorState message={history.error} retry={history.retry} />}
      {history.data && <>
        {!history.data.items.length ? <EmptyState title="Sin registros para estos filtros" detail="Probá otro tipo o tabla de origen." /> : <DataTable label="Registros históricos derivados de AppSheet"><thead><tr><th>Origen</th><th>Fecha</th><th>Importe original</th><th>Cantidad</th><th>Verificación</th></tr></thead><tbody>{history.data.items.map(item => <tr key={item.id}>
          <td><strong>{item.sourceTable}</strong><br />Fila {item.sourceRow} · {item.sourceKey}<details><summary>Procedencia</summary><p>Registro derivado: <code>{item.sourceRecordId}</code></p><p>Huella del registro SHA-256: <code>{item.sourceHash}</code></p></details></td>
          <td>{item.occurredOn ? dateLabel(item.occurredOn) : "Sin fecha verificada"}<br /><small>{valueStateLabel(item.dateState)}</small></td>
          <td>{amountLabel(item.amountMinor, item.currency)}<br /><small>{item.currency ?? "Moneda no identificada"} · {valueStateLabel(item.amountState)} · {valueStateLabel(item.currencyState)}</small></td>
          <td>{item.quantity ?? "Sin cantidad derivada"} {item.unit ?? ""}<br /><small>Cantidad: {valueStateLabel(item.quantityState)}{item.unit ? ` · unidad ${item.unit}` : " · unidad no identificada"}</small></td>
          <td><StatusTag tone="warn">{item.openExceptions ? `${item.openExceptions} excepciones abiertas` : "Pendiente de conciliar"}</StatusTag></td>
        </tr>)}</tbody></DataTable>}
        <div className="ops-filter-row">{cursor && <button type="button" className="ops-button ops-button-quiet" onClick={() => select("sourceCursor", "")}>Primera página</button>}{history.data.nextCursor && <button type="button" className="ops-button ops-button-quiet" disabled={history.loading} onClick={() => select("sourceCursor", history.data!.nextCursor!)}>Página siguiente</button>}</div>
      </>}

      <SectionHeading title="Pendientes relacionados" detail="La clasificación cruza estados, importes explícitos y relaciones entre tablas del lote seleccionado." />
      <InfoBand tone="warning" title="Clasificación para revisión · no es una aprobación">
        Estas relaciones ayudan a localizar preventas, saldos, compras recibidas y entregas que podrían seguir pendientes. No crean movimientos ni certifican el estado de una cuenta.
      </InfoBand>
      <div className="ops-filter-row">
        <label>Tabla<select value={activePendingTable} onChange={event => selectPending("pendingTable", event.target.value)}><option value="">Todas las tablas con clasificación</option>{tables.map(item => <option key={item.name} value={item.name}>{item.name} · {item.records.toLocaleString("es-AR")}</option>)}</select></label>
        <label>Dimensión<select value={pendingDimension} onChange={event => selectPending("pendingDimension", event.target.value)}><option value="">Todas las dimensiones</option>{Object.entries(pendingDimensionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Resultado<select value={activePendingStatus} disabled={!pendingDimension} onChange={event => selectPending("pendingStatus", event.target.value)}><option value="">Todos</option>{Object.entries(pendingStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      {!selectedPendingTableIsAvailable && <InfoBand tone="warning" title="La tabla elegida no está en este lote">La consulta de pendientes se restableció a todas las tablas disponibles.</InfoBand>}
      {pending.loading && <LoadingState label="Revisando relaciones entre registros…" />}
      {pending.error && <ErrorState message={pending.error} retry={pending.retry} />}
      {pending.data && <>
        {!pending.data.items.length ? <EmptyState title="No hay registros para estos filtros" detail="Probá otra dimensión, resultado o tabla de origen." /> : <div className="ops-reference-group">
          {pending.data.items.map(item => <article className="ops-sheet" key={item.sourceRecordId}>
            <div className="ops-sheet-head"><div><span className="ops-kicker">Registro de origen</span><h4>{item.sourceTable} · fila {item.sourceRow}</h4></div>
              <StatusTag tone={item.integrity === "valid" ? "warn" : "bad"}>{item.integrity === "valid" ? "Clasificación estructurada" : "Clasificación incompleta"}</StatusTag>
            </div>
            <p>Esta evaluación no certifica el registro y no habilita una operación.</p>
            {item.reconciliation ? <>
              <div className="ops-reference-group">{Object.entries(item.reconciliation.dimensions).map(([dimension, result]) => pendingDimensionView(
                pendingDimensionLabels[dimension as keyof AppSheetPendingReconciliation["dimensions"]], result,
              ))}</div>
              <details><summary>Procedencia y huellas técnicas</summary>
                <p>Modo de lectura: {item.reconciliation.capture.mode === "stable" ? "captura con corte verificado" : "delta preliminar"} · {item.reconciliation.capture.provisional ? "provisional" : "revisión pendiente"}</p>
                <p>Manifiesto de captura SHA-256: <code>{item.reconciliation.capture.manifestHash}</code></p>
                <p>Regla de conciliación SHA-256: <code>{item.reconciliation.mappingHash}</code></p>
                <p>Registro derivado: <code>{item.sourceRecordId}</code></p>
                <p>Huella del registro fuente SHA-256: <code>{item.sourceHash}</code></p>
              </details>
            </> : <p role="status">No se pudo leer la clasificación asociada a este registro. Conservá el lote para revisión.</p>}
          </article>)}
        </div>}
        <div className="ops-filter-row">{pendingCursor && <button type="button" className="ops-button ops-button-quiet" onClick={() => selectPending("pendingCursor", "")}>Primera página</button>}{pending.data.nextCursor && <button type="button" className="ops-button ops-button-quiet" disabled={pending.loading} onClick={() => selectPending("pendingCursor", pending.data!.nextCursor!)}>Página siguiente</button>}</div>
      </>}
    </>}
  </>;
}
