import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiGet, isUncertainCommandOutcome } from "./api";
import { amountFormToMinor, formatMinor } from "./money";
import { RemoteSelect } from "./RemoteSelect";
import type { OperationsContext, RunCommand } from "./types";
import "./appsheet-invoice-form.css";

type Row = Record<string, unknown>;
type EditorMode = "invoice" | "preorder" | "edit-preorder" | "confirm-preorder";
type Payment = "cash" | "transfer" | "mercado_pago" | "card";
type InvoiceLineDraft = { id: string; skuId: string; date: string; scale: string; quantity: string; total: string };
type MotoDraft = {
  deliveryDate: string;
  paymentMethod: Payment;
  serviceType: string;
  destination: string;
  clientTariff: string;
  adminTariff: string;
  totalTariff: string;
  notes: string;
};
type InvoiceDraft = {
  memberId: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: "ARS" | "USD";
  address: string;
  addressObject: Row;
  note: string;
  productPaymentMethod: Payment;
  lines: InvoiceLineDraft[];
  moto: MotoDraft | null;
};

interface Props {
  open: boolean;
  mode: EditorMode;
  order?: Row;
  expectedVersion?: number;
  memberName?: string;
  context: OperationsContext;
  catalog: Row[];
  catalogLoading: boolean;
  catalogError?: string;
  retryCatalog: () => void;
  loadMoreCatalog: () => void;
  hasMoreCatalog: boolean;
  runCommand: RunCommand;
  onClose: () => void;
  onSaved: (orderId: string, message: string) => void;
}

function civilDate(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function objectValue(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function stringValue(value: unknown, fallback = "") { return typeof value === "string" ? value : fallback; }
function minorToForm(value: unknown) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return "";
  const digits = value.padStart(3, "0");
  const amount = `${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return amount.replace(/\.00$/, "");
}
function formatAddress(value: Row) {
  const direct = stringValue(value.address || value.addressLine1 || value.street);
  const parts = [
    direct,
    stringValue(value.streetNumber || value.number),
    stringValue(value.floor),
    stringValue(value.apartment || value.unit),
    stringValue(value.city),
    stringValue(value.province),
    stringValue(value.postalCode),
    stringValue(value.zone),
    stringValue(value.reference),
  ].map(part => part.trim()).filter(Boolean);
  return [...new Set(parts)].join(" · ");
}
function fromSnapshot(order: Row | undefined, fallbackDate: string): InvoiceDraft | null {
  const quote = objectValue(order?.quote);
  const input = objectValue(quote.input);
  if (quote.source !== "appsheet-invoice" || !Object.keys(input).length) return null;
  const lines = Array.isArray(input.lines) ? input.lines.filter((item): item is Row => Boolean(item) && typeof item === "object").map(line => ({
    id: stringValue(line.id, crypto.randomUUID()), skuId: stringValue(line.skuId), date: stringValue(line.date, stringValue(input.invoiceDate, fallbackDate)),
    scale: stringValue(line.scale), quantity: stringValue(line.quantity), total: minorToForm(line.totalMinor),
  })) : [];
  const motoValue = objectValue(input.moto);
  const payment = (value: unknown): Payment => value === "transfer" || value === "mercado_pago" || value === "card" ? value : "cash";
  const addressObject = objectValue(input.address);
  return {
    memberId: stringValue(input.memberId, stringValue(order?.memberId)),
    invoiceNumber: stringValue(input.invoiceNumber), invoiceDate: stringValue(input.invoiceDate, fallbackDate), currency: input.currency === "USD" ? "USD" : "ARS",
    address: formatAddress(addressObject), addressObject, note: stringValue(input.note),
    productPaymentMethod: payment(input.productPaymentMethod), lines,
    moto: Object.keys(motoValue).length ? {
      deliveryDate: stringValue(motoValue.deliveryDate, fallbackDate), paymentMethod: payment(motoValue.paymentMethod),
      serviceType: stringValue(motoValue.serviceType, "CABA"), destination: stringValue(motoValue.destination),
      clientTariff: minorToForm(motoValue.clientTariffMinor), adminTariff: minorToForm(motoValue.adminTariffMinor),
      totalTariff: minorToForm(motoValue.totalTariffMinor), notes: stringValue(motoValue.notes),
    } : null,
  };
}
function blankDraft(date: string): InvoiceDraft {
  return { memberId: "", invoiceNumber: "", invoiceDate: date, currency: "ARS", address: "", addressObject: {}, note: "", productPaymentMethod: "cash", lines: [], moto: null };
}
function addressObjectWithText(source: Row, address: string): Row {
  return { ...source, address: address.trim() };
}
function scaledGrams(lines: InvoiceLineDraft[]) {
  let total = 0n;
  for (const line of lines) {
    const value = line.quantity.trim().replace(",", ".");
    if (!/^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value)) continue;
    const [whole, fraction = ""] = value.split(".");
    total += BigInt(whole!) * 1000n + BigInt((fraction + "000").slice(0, 3));
  }
  const whole = total / 1000n, fraction = (total % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole},${fraction}` : whole.toString();
}
function positiveQuantity(value: string) {
  const normalized = value.trim().replace(",", ".");
  return /^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(normalized) && Number(normalized) > 0;
}
function paymentOptions(legacyCard = false) {
  return [...(legacyCard ? [{ value: "card", label: "Tarjeta · valor heredado" }] : []), { value: "cash", label: "ARS" }, { value: "transfer", label: "Transferencia" }, { value: "mercado_pago", label: "Mercado Pago" }] as const;
}

const observedScales = ["Precio_5_Gramos", "Precio_10_Gramos", "Precio_15_Gramos", "Precio_20_Gramos", "Precio_25_Gramos", "Precio_30_Gramos", "Pack Premium", "Pack Amigos", "Promo_C"];
const observedServiceTypes = ["CABA", "Zona Norte 1", "Zona Norte 2", "CABA - ENVIO GRATIS", "PBA"];

export function AppSheetInvoiceForm(props: Props) {
  const { open, mode, order, expectedVersion, memberName, context, catalog, catalogLoading, catalogError, retryCatalog, loadMoreCatalog, hasMoreCatalog, runCommand, onClose, onSaved } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const productDialog = useRef<HTMLDialogElement>(null);
  const motoDialog = useRef<HTMLDialogElement>(null);
  const target = useRef(crypto.randomUUID());
  const attempted = useRef<{ command: string; data: Row } | null>(null);
  const submitting = useRef(false);
  const initialDate = useMemo(() => civilDate(context.timeZone), [context.timeZone]);
  const initial = useMemo(() => mode === "edit-preorder" ? fromSnapshot(order, initialDate) ?? blankDraft(initialDate) : blankDraft(initialDate), [mode, order, initialDate]);
  const [draft, setDraft] = useState<InvoiceDraft>(initial);
  const [stage, setStage] = useState<"main" | "product" | "moto">("main");
  const [productDraft, setProductDraft] = useState<InvoiceLineDraft | null>(null);
  const [productIndex, setProductIndex] = useState<number | null>(null);
  const [motoDraft, setMotoDraft] = useState<MotoDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [addressTouched, setAddressTouched] = useState(false);
  const addressEdited = useRef(false);
  const [memberLoading, setMemberLoading] = useState(false);
  const [memberError, setMemberError] = useState("");
  const [confirmation, setConfirmation] = useState<Row | null>(null);
  const [confirmationLoading, setConfirmationLoading] = useState(false);
  const [confirmationError, setConfirmationError] = useState("");
  const [confirmationEvidence, setConfirmationEvidence] = useState("");
  const [confirmationVersion, setConfirmationVersion] = useState<number | undefined>(expectedVersion);

  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, [open]);

  useEffect(() => {
    const element = stage === "product" ? productDialog.current : stage === "moto" ? motoDialog.current : null;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, [stage]);

  useEffect(() => {
    if (!open || mode !== "confirm-preorder" || !order?.id) return;
    let active = true;
    setConfirmationLoading(true); setConfirmationError("");
    apiGet<Row>(`/api/operations/orders/${encodeURIComponent(String(order.id))}`).then(response => {
      if (!active) return;
      const current = objectValue(response.order);
      setConfirmation(current);
      const currentVersion = response.version;
      setConfirmationVersion(typeof currentVersion === "number" && Number.isSafeInteger(currentVersion) ? currentVersion : expectedVersion);
    }).catch(cause => { if (active) setConfirmationError(cause instanceof Error ? cause.message : "No se pudo consultar la preventa guardada."); })
      .finally(() => { if (active) setConfirmationLoading(false); });
    return () => { active = false; };
  }, [open, mode, order?.id, expectedVersion]);

  useEffect(() => {
    if (!open || mode === "edit-preorder" || mode === "confirm-preorder" || !draft.memberId || addressTouched) return;
    let active = true;
    const controller = new AbortController();
    setMemberLoading(true); setMemberError("");
    apiGet<Row>(`/api/operations/members/${encodeURIComponent(draft.memberId)}`, { signal: controller.signal }).then(response => {
      if (!active || addressEdited.current) return;
      const member = objectValue(response.member);
      const address = objectValue(member.address);
      setDraft(current => current.memberId !== draft.memberId || addressEdited.current ? current : ({ ...current, addressObject: address, address: formatAddress(address) }));
    }).catch(cause => {
      if (active && !addressEdited.current && !(cause instanceof DOMException && cause.name === "AbortError")) setMemberError(cause instanceof Error ? cause.message : "No se pudo completar el domicilio del socio.");
    }).finally(() => { if (active) setMemberLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [open, mode, draft.memberId, addressTouched]);

  useEffect(() => {
    if (!busy && !uncertain) return;
    const preventLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeaving);
    return () => window.removeEventListener("beforeunload", preventLeaving);
  }, [busy, uncertain]);

  function close() {
    if (busy || uncertain || submitting.current) return;
    dialog.current?.close();
    onClose();
  }
  function updateDraft<K extends keyof InvoiceDraft>(key: K, value: InvoiceDraft[K]) {
    setDraft(current => ({ ...current, [key]: value }));
  }
  function openProduct(index?: number) {
    const existing = index === undefined ? null : draft.lines[index] ?? null;
    setProductIndex(index ?? null);
    setProductDraft(existing ? { ...existing } : { id: crypto.randomUUID(), skuId: "", date: draft.invoiceDate, scale: "", quantity: "", total: "" });
    setStage("product");
    setError("");
  }
  function cancelProduct() {
    if (busy || uncertain) return;
    productDialog.current?.close(); setProductDraft(null); setProductIndex(null); setStage("main");
  }
  function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!productDraft) return;
    const selected = catalog.find(item => String(item.id) === productDraft.skuId && item.active !== false && item.unit === "g" && objectValue(item.appSheet).availability !== "NO");
    if (!selected) { setError("Elegí una variedad activa y disponible del catálogo con unidad en gramos."); return; }
    if (!productDraft.date) { setError("Completá la fecha del producto."); return; }
    if (!positiveQuantity(productDraft.quantity)) { setError("Ingresá gramos mayores que cero, con hasta tres decimales."); return; }
    let totalMinor: string;
    try { totalMinor = amountFormToMinor(productDraft.total); } catch { setError("Ingresá el Valor total con hasta dos decimales."); return; }
    const committed = { ...productDraft, total: minorToForm(totalMinor), skuId: String(selected.id) };
    setDraft(current => {
      const lines = [...current.lines];
      if (productIndex === null) lines.push(committed); else lines[productIndex] = committed;
      return { ...current, lines };
    });
    productDialog.current?.close(); setProductDraft(null); setProductIndex(null); setStage("main"); setError("");
  }
  function removeProduct(index: number) {
    if (busy || uncertain) return;
    setDraft(current => ({ ...current, lines: current.lines.filter((_, currentIndex) => currentIndex !== index) }));
  }
  function openMoto() {
    setMotoDraft(draft.moto ? { ...draft.moto } : {
      deliveryDate: draft.invoiceDate, paymentMethod: "cash", serviceType: "CABA", destination: "",
      clientTariff: "", adminTariff: "", totalTariff: "", notes: "",
    });
    setStage("moto"); setError("");
  }
  function cancelMoto() {
    if (busy || uncertain) return;
    motoDialog.current?.close(); setMotoDraft(null); setStage("main");
  }
  function saveMoto(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!motoDraft) return;
    try {
      amountFormToMinor(motoDraft.clientTariff); amountFormToMinor(motoDraft.adminTariff); amountFormToMinor(motoDraft.totalTariff);
    } catch { setError("Revisá las tarifas: usá importes con hasta dos decimales."); return; }
    if (!motoDraft.deliveryDate || !motoDraft.serviceType.trim() || !motoDraft.destination.trim()) { setError("Completá Fecha_Entrega, Tipo de Servicio y Destino."); return; }
    setDraft(current => ({ ...current, moto: { ...motoDraft } }));
    motoDialog.current?.close(); setMotoDraft(null); setStage("main"); setError("");
  }
  function setService(enabled: boolean) {
    if (enabled) { if (!draft.moto) openMoto(); }
    else updateDraft("moto", null);
  }

  function editAddress(value: string) {
    addressEdited.current = true;
    setAddressTouched(true); setMemberLoading(false); setMemberError("");
    // A manual destination replaces the lookup snapshot, including old coordinates.
    setDraft(current => ({ ...current, address: value, addressObject: {} }));
  }

  function payload(preorder: boolean): Row {
    const address = addressObjectWithText(draft.addressObject, draft.address);
    const lines = draft.lines.map(line => {
      if (!line.skuId || !positiveQuantity(line.quantity) || !line.date) throw new Error("Revisá cada producto: variedad, fecha y gramos son obligatorios.");
      return { id: line.id, skuId: line.skuId, date: line.date, scale: line.scale, quantity: line.quantity.trim().replace(",", "."), totalMinor: amountFormToMinor(line.total) };
    });
    const moto = draft.moto ? {
      deliveryDate: draft.moto.deliveryDate, paymentMethod: draft.moto.paymentMethod,
      serviceType: draft.moto.serviceType.trim(), destination: draft.moto.destination.trim(),
      clientTariffMinor: amountFormToMinor(draft.moto.clientTariff), adminTariffMinor: amountFormToMinor(draft.moto.adminTariff), totalTariffMinor: amountFormToMinor(draft.moto.totalTariff), notes: draft.moto.notes,
    } : undefined;
    return {
      memberId: draft.memberId, ...(draft.invoiceNumber.trim() ? { invoiceNumber: draft.invoiceNumber.trim() } : {}), invoiceDate: draft.invoiceDate,
      currency: draft.currency, address, note: draft.note, productPaymentMethod: draft.productPaymentMethod,
      lines, ...(moto ? { moto } : {}), preorder,
    };
  }
  async function saveInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || !draft.memberId || busy) return;
    setError("");
    if (mode === "invoice" && !draft.lines.length) { setError("Agregá al menos un producto antes de guardar la factura."); return; }
    submitting.current = true; setBusy(true);
    const isCreate = mode === "invoice" || mode === "preorder";
    const command = isCreate ? "InvoiceSaved" : "InvoiceUpdated";
    let data: Row;
    try { data = attempted.current?.command === command ? attempted.current.data : payload(mode === "preorder"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Revisá los datos de la factura."); submitting.current = false; setBusy(false); return; }
    attempted.current = { command, data };
    try {
      await runCommand(command, isCreate ? target.current : String(order?.id), isCreate ? 0 : expectedVersion ?? Number.NaN, data, isCreate);
      const orderId = isCreate ? target.current : String(order?.id);
      const message = mode === "preorder" ? "Preventa creada. Todavía no reserva stock ni programa un envío." : mode === "edit-preorder" ? "Factura guardada y confirmada desde la preventa. El envío quedó vinculado cuando corresponde; no se registró ningún cobro." : "Factura guardada y confirmada. El envío quedó vinculado cuando corresponde; no se registró ningún cobro.";
      dialog.current?.close(); onSaved(orderId, message); onClose();
    } catch (cause) {
      const pending = uncertain || isUncertainCommandOutcome(cause);
      setUncertain(pending);
      if (!pending) attempted.current = null;
      setError(pending
        ? "Confirmación pendiente: el servidor pudo haber guardado esta factura. No cambies los campos; reintentá para recuperar el mismo comprobante."
        : cause instanceof Error ? cause.message : "No se pudo guardar la factura.");
    } finally { submitting.current = false; setBusy(false); }
  }

  async function confirmPreorder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = String(order?.id ?? "");
    const quote = objectValue(confirmation?.quote);
    const savedLines = Array.isArray(quote.lines) ? quote.lines : [];
    if (!id || !savedLines.length || !confirmationEvidence.trim() || !Number.isSafeInteger(confirmationVersion)) {
      setConfirmationError(!savedLines.length ? "La preventa todavía no tiene productos guardados. Abrí «Formulario de venta» antes de confirmar." : "Cargá la aceptación y actualizá la versión del registro.");
      return;
    }
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setConfirmationError("");
    try {
      await runCommand("InvoiceConfirmed", id, confirmationVersion!, { acceptance: { note: confirmationEvidence.trim() } });
      dialog.current?.close(); onSaved(id, "Preventa confirmada con la versión guardada. Se reservó stock y se creó el envío si incluye servicio de moto; no se registró un cobro."); onClose();
    } catch (cause) {
      setUncertain(isUncertainCommandOutcome(cause));
      setConfirmationError(isUncertainCommandOutcome(cause)
        ? "Confirmación pendiente: se pudo confirmar la preventa. Conservá la evidencia y reintentá exactamente la misma acción."
        : cause instanceof Error ? cause.message : "No se pudo confirmar la preventa.");
    } finally { submitting.current = false; setBusy(false); }
  }

  if (!open) return null;
  const creatingShell = mode === "preorder";
  const confirming = mode === "confirm-preorder";
  const selectedMember = (value: string) => {
    if (busy || uncertain || value === draft.memberId) return;
    addressEdited.current = false;
    setAddressTouched(false); setMemberLoading(false); setMemberError("");
    setDraft(current => ({ ...current, memberId: value, address: "", addressObject: {} }));
  };
  const saleProducts = catalog.filter(item => item.active !== false && item.unit === "g" && objectValue(item.appSheet).availability !== "NO");
  const productSubtotalMinor = draft.lines.reduce((sum, line) => {
    try { return sum + BigInt(amountFormToMinor(line.total)); } catch { return sum; }
  }, 0n);
  const clientTariffMinor = (() => { try { return draft.moto ? BigInt(amountFormToMinor(draft.moto.clientTariff)) : 0n; } catch { return 0n; } })();
  const capturedBaseMinor = productSubtotalMinor + clientTariffMinor;
  const quote = objectValue(confirmation?.quote);
  const savedLines = Array.isArray(quote.lines) ? quote.lines.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
  const blankPreorder = confirming && savedLines.length === 0;

  return <dialog className="ops-dialog appsheet-invoice-dialog" ref={dialog} data-testid="appsheet-invoice-dialog" aria-labelledby="appsheet-invoice-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="ops-dialog-card appsheet-invoice-card">
      <header className="ops-dialog-head appsheet-invoice-head">
        <div><span className="ops-kicker">Bombo · Facturación</span><h2 id="appsheet-invoice-title">{confirming ? "Confirmar preventa" : creatingShell ? "Preventa" : mode === "edit-preorder" ? "Formulario de venta" : "Nueva factura"}</h2>
          <p>{confirming ? "Se confirma exactamente la última versión guardada, sin volver a cotizar." : creatingShell ? "Guardá fecha y socio para continuar el formulario más tarde." : "Completá la factura y el viaje de moto con los importes ingresados."}</p></div>
        <button type="button" className="ops-icon-button" aria-label="Cerrar formulario" onClick={close} disabled={busy || uncertain}>×</button>
      </header>

      {confirming ? <form className="appsheet-invoice-body" onSubmit={event => void confirmPreorder(event)}>
        {confirmationLoading && <p role="status">Consultando la versión guardada…</p>}
        {confirmationError && !confirmationLoading && <p className="ops-inline-error" role="alert">{confirmationError}</p>}
        {confirmation && <section className="appsheet-saved-summary" aria-label="Factura guardada para confirmar">
          <div><span>Factura</span><strong>{stringValue(quote.invoiceNumber, "Sin número visible")}</strong></div>
          <div><span>Fecha</span><strong>{stringValue(quote.invoiceDate, stringValue(confirmation.createdAt, "—").slice(0, 10))}</strong></div>
          <div><span>Cliente</span><strong>{stringValue(confirmation.memberName, `Ref. ${stringValue(confirmation.memberId)}`)}</strong></div>
          <div><span>Productos</span><strong>{savedLines.length}</strong></div>
          <div><span>Total facturado</span><strong>Pendiente de definición</strong></div>
          <div><span>Importe capturado</span><strong>{formatMinor(quote.capturedBaseMinor, stringValue(quote.currency, "ARS"))}</strong></div>
          {quote.currency === "USD" && <div><span>Moneda</span><strong>USD</strong></div>}
          {savedLines.map((line, index) => <p key={stringValue(line.id, String(index))}>{stringValue(line.date)} · {stringValue(line.scale, "Escala sin dato")} · {stringValue(line.quantity, stringValue(line.requested))} g · {formatMinor(line.explicitTotalMinor, quote.currency)}</p>)}
          {Boolean(objectValue(quote.moto).deliveryDate) && <p>Viaje en moto · {stringValue(objectValue(quote.moto).deliveryDate)} · {stringValue(objectValue(quote.moto).destination)}</p>}
        </section>}
        {confirmation && !blankPreorder && <label className="ops-field appsheet-field" htmlFor="appsheet-acceptance"><span>Aceptación registrada</span><textarea id="appsheet-acceptance" name="acceptance" value={confirmationEvidence} onChange={event => setConfirmationEvidence(event.target.value)} maxLength={2000} required disabled={busy || uncertain} /></label>}
        {uncertain && <p className="appsheet-pending" role="alert">Confirmación pendiente: se pudo confirmar la preventa. Conservá la evidencia y reintentá exactamente la misma acción.</p>}
        <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={close} disabled={busy || uncertain}>Cancelar</button><button type="submit" className="ops-button ops-button-primary" data-testid={uncertain ? "appsheet-retry-confirm-preorder" : "appsheet-confirm-preorder"} disabled={busy || confirmationLoading || !confirmation || blankPreorder || !Number.isSafeInteger(confirmationVersion) || !confirmationEvidence.trim()}>{busy ? "Confirmando…" : uncertain ? "Reintentar confirmación" : "Confirmar preventa"}</button></footer>
      </form> : <form className="appsheet-invoice-body" onSubmit={event => void saveInvoice(event)} aria-busy={busy}>
        {creatingShell ? <div className="appsheet-shell-grid">
          <label className="ops-field appsheet-field"><span>Fecha</span><input name="invoiceDate" data-testid="invoiceDate" aria-label="Fecha" type="date" value={draft.invoiceDate} disabled /></label>
          <div className="ops-field appsheet-field"><span>Nombre del asociado</span><fieldset className="appsheet-lookup-fieldset" disabled={busy || uncertain}><RemoteSelect field={{ name: "memberId", label: "Nombre del asociado", type: "select", required: true, lookupPath: "/api/operations/members" }} value={draft.memberId} onChange={selectedMember} /></fieldset></div>
        </div> : <>
          {draft.currency === "USD" && <p className="appsheet-currency-label">Moneda de la preventa original: <strong>USD</strong>. Se conserva sin conversión.</p>}
          <div className="appsheet-invoice-fields">
            <label className="ops-field appsheet-field"><span>Nro Factura</span><input name="invoiceNumber" data-testid="invoiceNumber" aria-label="Nro Factura" value={draft.invoiceNumber} onChange={event => updateDraft("invoiceNumber", event.target.value)} maxLength={120} disabled={busy || uncertain} /></label>
            <label className="ops-field appsheet-field"><span>Fecha</span><input name="invoiceDate" data-testid="invoiceDate" aria-label="Fecha" type="date" value={draft.invoiceDate} onChange={event => updateDraft("invoiceDate", event.target.value)} required disabled={busy || uncertain} /></label>
            <div className="ops-field appsheet-field"><span>Cliente</span>{mode === "edit-preorder" ? <input aria-label="Cliente" value={memberName || `Socio #${draft.memberId.slice(0, 8)}`} readOnly /> : <fieldset className="appsheet-lookup-fieldset" disabled={busy || uncertain}><RemoteSelect field={{ name: "memberId", label: "Cliente", type: "select", required: true, lookupPath: "/api/operations/members" }} value={draft.memberId} onChange={selectedMember} /></fieldset>}{mode === "edit-preorder" && <small>El socio se conserva desde la preventa original.</small>}</div>
            <label className="ops-field appsheet-field appsheet-address-field"><span>Domicilio</span><textarea name="address" data-testid="address" aria-label="Domicilio" value={draft.address} onChange={event => editAddress(event.target.value)} rows={2} maxLength={500} disabled={busy || uncertain} />{memberLoading && <small role="status">Completando desde el socio…</small>}{memberError && <small className="appsheet-subtle-error">{memberError} · podés cargar el domicilio manualmente.</small>}</label>
          </div>

          <section className="appsheet-section appsheet-child-actions" aria-label="Productos y envío">
            <button type="button" className="appsheet-add-card" data-testid="appsheet-add-product" onClick={() => openProduct()} disabled={busy || uncertain}>
              <span className="appsheet-add-icon" aria-hidden="true">＋</span><span><strong>Agregar producto</strong><small>Variedad, fecha, escala, gramos y valor total</small></span>
            </button>
            <button type="button" className="appsheet-add-card" data-testid="appsheet-add-moto" onClick={openMoto} disabled={busy || uncertain}>
              <span className="appsheet-add-icon" aria-hidden="true">↗</span><span><strong>Cargar viaje en Moto</strong><small>Fecha de entrega, pago y tarifas</small></span>
            </button>
          </section>
          <section className="appsheet-section" aria-label="Productos agregados">
            <h3>Productos de la factura</h3>
            {draft.lines.length ? <ul className="appsheet-dialog-lines">{draft.lines.map((line, index) => {
              const product = catalog.find(item => String(item.id) === line.skuId);
              return <li className="appsheet-dialog-line" key={line.id} data-testid={`appsheet-product-row-${line.id}`}>
                <div><strong>{stringValue(product?.name, line.skuId || "Producto")}</strong><span>{line.date} · {line.scale || "Escala sin dato"} · {line.quantity} g · {formatMinor((() => { try { return amountFormToMinor(line.total); } catch { return "0"; } })(), draft.currency)}</span></div>
                <div className="appsheet-line-actions"><button type="button" className="ops-button ops-button-quiet ops-button-small" data-testid={`appsheet-edit-product-${line.id}`} onClick={() => openProduct(index)} disabled={busy || uncertain}>Editar producto</button><button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => removeProduct(index)} disabled={busy || uncertain}>Quitar</button></div>
              </li>;
            })}</ul> : <p className="appsheet-footnote">Todavía no agregaste productos.</p>}
          </section>
          <section className="appsheet-section appsheet-service-row">
            <fieldset className="appsheet-radio-group" disabled={busy || uncertain}>
              <legend>Servicio de moto</legend>
              <label><input type="radio" name="serviceMoto" data-testid="serviceMoto" value="no" checked={!draft.moto} onChange={() => setService(false)} /> <span>No</span></label>
              <label><input type="radio" name="serviceMoto" data-testid="serviceMoto" value="yes" checked={Boolean(draft.moto)} onChange={() => setService(true)} /> <span>Sí</span></label>
            </fieldset>
            {draft.moto && <div className="appsheet-moto-chip"><strong>{draft.moto.deliveryDate}</strong><span>{draft.moto.serviceType} · {draft.moto.destination || "Destino pendiente"}</span><button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={openMoto} disabled={busy || uncertain}>Editar viaje</button></div>}
          </section>

          <section className="appsheet-section appsheet-payment-section">
            <label className="ops-field appsheet-field"><span>Forma de pago</span><select name="productPaymentMethod" data-testid="productPaymentMethod" aria-label="Forma de pago" value={draft.productPaymentMethod} onChange={event => updateDraft("productPaymentMethod", event.target.value as Payment)} disabled={busy || uncertain}>{paymentOptions(draft.productPaymentMethod === "card").map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            {draft.productPaymentMethod === "transfer" && <label className="ops-field appsheet-field"><span>Transferencia</span><input name="productTransfer" data-testid="productTransfer" aria-label="Transferencia" value="Pendiente de definición" readOnly /><small>El campo observado está deshabilitado; el importe derivado y su fórmula siguen pendientes de cotejo.</small></label>}
          </section>

          <section className="appsheet-totals" aria-label="Resumen de factura" aria-live="polite">
            <div><span>Gramos</span><strong>{scaledGrams(draft.lines)} g</strong></div>
            <div><span>Monto parcial</span><strong>Pendiente de definición</strong></div>
            <div><span>Suma explícita de líneas</span><strong>{formatMinor(productSubtotalMinor.toString(), draft.currency)}</strong></div>
            <div><span>Transferencia</span><strong>{draft.productPaymentMethod === "transfer" ? "Pendiente de definición" : "—"}</strong></div>
            <div><span>Importe capturado</span><strong>{formatMinor(capturedBaseMinor.toString(), draft.currency)}</strong></div>
            <div className="appsheet-total"><span>Total facturado</span><strong>Pendiente de definición</strong></div>
          </section>
          <p className="appsheet-footnote">El importe capturado reúne productos y Tarifa Cliente como referencia. El total facturado todavía está pendiente de definición.</p>
          <label className="ops-field appsheet-field"><span>Aclaración</span><textarea name="note" data-testid="note" aria-label="Aclaración" value={draft.note} onChange={event => updateDraft("note", event.target.value)} rows={2} maxLength={2000} disabled={busy || uncertain} /></label>
          {mode === "edit-preorder" && <p className="appsheet-footnote">Guardar completa y confirma la preventa; reserva stock y crea el envío cuando hay moto. El cobro queda pendiente.</p>}
          {mode === "invoice" && <p className="appsheet-footnote">Guardar confirma la factura y su envío cuando hay moto. El cobro queda pendiente y no afecta cajas.</p>}
        </>}
        {error && <p className={uncertain ? "appsheet-pending" : "ops-inline-error"} role="alert">{error}</p>}
        <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={close} disabled={busy || uncertain}>Cancelar</button><button type="submit" className="ops-button ops-button-primary" data-testid={uncertain ? "appsheet-retry-invoice" : "appsheet-save-invoice"} disabled={busy || (!uncertain && (!draft.memberId || ((mode === "invoice" || mode === "edit-preorder") && !draft.lines.length) || (mode === "edit-preorder" && !Number.isSafeInteger(expectedVersion))))}>{busy ? "Guardando…" : uncertain ? "Reintentar confirmación" : creatingShell ? "Guardar preventa" : mode === "edit-preorder" ? "Guardar y confirmar" : "Guardar"}</button></footer>
      </form>}

      {stage === "product" && productDraft && <dialog className="ops-dialog appsheet-child-dialog" ref={productDialog} data-testid="appsheet-product-dialog" aria-labelledby="appsheet-product-title" onCancel={event => { event.preventDefault(); cancelProduct(); }}>
        <form className="ops-dialog-card appsheet-child-card" onSubmit={saveProduct}>
          <header className="ops-dialog-head"><div><span className="ops-kicker">Detalle de factura</span><h2 id="appsheet-product-title">Agregar producto</h2></div><button type="button" className="ops-icon-button" aria-label="Cerrar producto" onClick={cancelProduct} disabled={busy || uncertain}>×</button></header>
          <fieldset className="appsheet-child-fields" disabled={busy || uncertain}>
            <label className="ops-field appsheet-field"><span>Id_Detalle</span><input name="line-id" data-testid="line-id" value={productDraft.id} onChange={event => setProductDraft(current => current ? { ...current, id: event.target.value } : current)} maxLength={100} required /></label>
            <label className="ops-field appsheet-field"><span>ID. Factura</span><input aria-label="ID. Factura" value={draft.invoiceNumber || "Se asigna al guardar"} readOnly /></label>
            <label className="ops-field appsheet-field"><span>Fecha</span><input name="line-date" data-testid="line-date" aria-label="Fecha del producto" type="date" value={productDraft.date} onChange={event => setProductDraft(current => current ? { ...current, date: event.target.value } : current)} required /></label>
            <label className="ops-field appsheet-field"><span>Variedad</span><select name="line-skuId" data-testid="line-skuId" aria-label="Variedad" value={productDraft.skuId} onChange={event => setProductDraft(current => current ? { ...current, skuId: event.target.value } : current)} required><option value="">Elegí variedad</option>{saleProducts.map(item => <option key={String(item.id)} value={String(item.id)}>{stringValue(item.name, stringValue(item.code, String(item.id)))}</option>)}</select>{catalogLoading && <small role="status">Cargando variedades…</small>}{catalogError && <small className="appsheet-subtle-error">No se pudo cargar catálogo. <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={retryCatalog}>Reintentar</button></small>}{!catalogLoading && !catalogError && !saleProducts.length && <small>No hay variedades activas disponibles para factura.</small>}{hasMoreCatalog && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={loadMoreCatalog} disabled={catalogLoading}>Cargar más variedades</button>}</label>
            <label className="ops-field appsheet-field"><span>Escala_Tarifaria</span><select name="line-scale" data-testid="line-scale" aria-label="Escala tarifaria" value={productDraft.scale} onChange={event => setProductDraft(current => current ? { ...current, scale: event.target.value } : current)}><option value="">Elegí una escala</option>{productDraft.scale && !observedScales.includes(productDraft.scale) && <option value={productDraft.scale}>{productDraft.scale}</option>}{observedScales.map(scale => <option key={scale} value={scale}>{scale}</option>)}</select><small>Se conserva la escala elegida; no hay relación verificada entre escala y precio.</small></label>
            <label className="ops-field appsheet-field"><span>Gramos pedidos</span><input name="line-quantity" data-testid="line-quantity" aria-label="Gramos pedidos" inputMode="decimal" value={productDraft.quantity} onChange={event => setProductDraft(current => current ? { ...current, quantity: event.target.value } : current)} required placeholder="Ej.: 3,5" /></label>
            <label className="ops-field appsheet-field"><span>Valor total</span><input name="line-total" data-testid="line-total" aria-label="Valor total" inputMode="decimal" value={productDraft.total} onChange={event => setProductDraft(current => current ? { ...current, total: event.target.value } : current)} required placeholder="Importe editable" /><small>Se conserva como importe total de línea; no se calcula por gramo.</small></label>
            <label className="ops-field appsheet-field"><span>N_Factura_Virtual</span><input aria-label="N_Factura_Virtual" value="Se asigna al guardar" disabled /></label>
          </fieldset>
          {error && <p className="ops-inline-error" role="alert">{error}</p>}
          <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={cancelProduct} disabled={busy || uncertain}>Cancelar</button><button type="submit" className="ops-button ops-button-primary" disabled={!saleProducts.length || busy || uncertain}>{productIndex === null ? "Añadir producto" : "Guardar cambios"}</button></footer>
        </form>
      </dialog>}

      {stage === "moto" && motoDraft && <dialog className="ops-dialog appsheet-child-dialog" ref={motoDialog} data-testid="appsheet-moto-dialog" aria-labelledby="appsheet-moto-title" onCancel={event => { event.preventDefault(); cancelMoto(); }}>
        <form className="ops-dialog-card appsheet-child-card" onSubmit={saveMoto}>
          <header className="ops-dialog-head"><div><span className="ops-kicker">Envío de factura</span><h2 id="appsheet-moto-title">Cargar viaje en moto</h2></div><button type="button" className="ops-icon-button" aria-label="Cerrar viaje" onClick={cancelMoto} disabled={busy || uncertain}>×</button></header>
          <fieldset className="appsheet-child-fields" disabled={busy || uncertain}>
            <label className="ops-field appsheet-field"><span>Envio moto</span><input aria-label="Envio moto" value="Se asigna al guardar" readOnly /></label>
            <label className="ops-field appsheet-field"><span>Fecha_Entrega</span><input name="moto-deliveryDate" data-testid="moto-deliveryDate" aria-label="Fecha de entrega" type="date" value={motoDraft.deliveryDate} onChange={event => setMotoDraft(current => current ? { ...current, deliveryDate: event.target.value } : current)} required /></label>
            <label className="ops-field appsheet-field"><span>Forma de pago moto</span><select name="moto-paymentMethod" data-testid="moto-paymentMethod" aria-label="Forma de pago moto" value={motoDraft.paymentMethod} onChange={event => setMotoDraft(current => current ? { ...current, paymentMethod: event.target.value as Payment } : current)}>{paymentOptions(motoDraft.paymentMethod === "card").map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="ops-field appsheet-field"><span>Transferencia moto</span><input name="moto-transfer" data-testid="moto-transfer" aria-label="Transferencia moto" value="Pendiente de definición" disabled /></label>
            <label className="ops-field appsheet-field"><span>Tipo de Servicio</span><select name="moto-serviceType" data-testid="moto-serviceType" aria-label="Tipo de servicio" value={motoDraft.serviceType} onChange={event => setMotoDraft(current => current ? { ...current, serviceType: event.target.value } : current)} required><option value="">Elegí un servicio</option>{motoDraft.serviceType && !observedServiceTypes.includes(motoDraft.serviceType) && <option value={motoDraft.serviceType}>{motoDraft.serviceType}</option>}{observedServiceTypes.map(serviceType => <option key={serviceType} value={serviceType}>{serviceType}</option>)}</select></label>
            <label className="ops-field appsheet-field"><span>Destino</span><input name="moto-destination" data-testid="moto-destination" aria-label="Destino" value={motoDraft.destination} onChange={event => setMotoDraft(current => current ? { ...current, destination: event.target.value } : current)} maxLength={1000} required /></label>
            <label className="ops-field appsheet-field"><span>Tarifa Cliente</span><input name="moto-clientTariff" data-testid="moto-clientTariff" aria-label="Tarifa Cliente" inputMode="decimal" value={motoDraft.clientTariff} onChange={event => setMotoDraft(current => current ? { ...current, clientTariff: event.target.value } : current)} required /><small>Importe editable en {draft.currency}; se incluye en el importe capturado. El total facturado sigue pendiente de definición.</small></label>
            <label className="ops-field appsheet-field"><span>Subtotal cliente</span><input aria-label="Subtotal cliente" value="Pendiente de definición" disabled /></label>
            <label className="ops-field appsheet-field"><span>Tarifa Administracion</span><input name="moto-adminTariff" data-testid="moto-adminTariff" aria-label="Tarifa Administración" inputMode="decimal" value={motoDraft.adminTariff} onChange={event => setMotoDraft(current => current ? { ...current, adminTariff: event.target.value } : current)} required /><small>Se conserva aparte como dato administrativo.</small></label>
            <label className="ops-field appsheet-field"><span>Total Tarifa</span><input name="moto-totalTariff" data-testid="moto-totalTariff" aria-label="Total Tarifa" inputMode="decimal" value={motoDraft.totalTariff} onChange={event => setMotoDraft(current => current ? { ...current, totalTariff: event.target.value } : current)} required /><small>Editable; se guarda separado y no se usa para recalcular Tarifa Cliente.</small></label>
            <label className="ops-field appsheet-field"><span>Aclaraciones</span><textarea name="moto-notes" data-testid="moto-notes" aria-label="Aclaraciones del viaje" value={motoDraft.notes} onChange={event => setMotoDraft(current => current ? { ...current, notes: event.target.value } : current)} maxLength={2000} rows={2} /></label>
            <label className="ops-field appsheet-field"><span>Cantidad Transportada</span><input aria-label="Cantidad Transportada" value="Pendiente de definición" disabled /></label>
          </fieldset>
          {error && <p className="ops-inline-error" role="alert">{error}</p>}
          <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={cancelMoto} disabled={busy || uncertain}>Cancelar</button><button type="submit" className="ops-button ops-button-primary" disabled={busy || uncertain}>Añadir viaje en moto</button></footer>
        </form>
      </dialog>}
    </div>
  </dialog>;
}
