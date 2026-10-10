import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { apiGet, hasCapability, hasCommand, isUncertainCommandOutcome } from "./api";
import { amountFormToMinor, formatMinor } from "./money";
import { calculateAppSheetInvoiceFinancials } from "../../shared/operations/appsheet-invoice-rules";
import { appSheetCatalogueStoredSchema } from "../../shared/operations/appsheet-catalogue";
import { proposeAppSheetLinePricingInitialValue, proposeAppSheetLineSubtotal } from "../../shared/operations/appsheet-line-pricing";
import { RemoteSelect } from "./RemoteSelect";
import type { OperationsContext, RunCommand } from "./types";
import "./appsheet-invoice-form.css";

type Row = Record<string, unknown>;
type EditorMode = "invoice" | "preorder" | "edit-preorder" | "confirm-preorder";
type Payment = "cash" | "transfer" | "mercado_pago" | "card";
type NewMemberDraft = { name: string; email: string; phone: string; address: string };
type InvoiceLineDraft = { id: string; skuId: string; sourceLotId: string; date: string; scale: string; quantity: string; total: string; pricePerGram: string; priceManual: boolean; totalManual: boolean };
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
type SnapshotDraft =
  | { status: "valid"; draft: InvoiceDraft }
  | { status: "unavailable" | "invalid-currency"; error: string };

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
function sourceLotOptions(item: Row | undefined): Row[] {
  const value = item?.appSheetSourceLots;
  return Array.isArray(value) ? value.filter((row): row is Row => Boolean(row) && typeof row === "object" && !Array.isArray(row)) : [];
}
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
function fromSnapshot(order: Row | undefined, fallbackDate: string): SnapshotDraft {
  const quote = objectValue(order?.quote);
  const input = objectValue(quote.input);
  if (quote.source !== "appsheet-invoice" || !Object.keys(input).length) return {
    status: "unavailable",
    error: "No se pudo cargar la preventa original para editar. La versión guardada se conserva; volvé a abrir el registro o consultá soporte antes de guardar.",
  };
  if (input.currency !== "ARS" && input.currency !== "USD") return {
    status: "invalid-currency",
    error: "La preventa original no tiene una moneda admitida (ARS o USD). La versión guardada se conserva; revisá el dato de origen antes de editar.",
  };
  const lines = Array.isArray(input.lines) ? input.lines.filter((item): item is Row => Boolean(item) && typeof item === "object").map(line => ({
    id: stringValue(line.id, crypto.randomUUID()), skuId: stringValue(line.skuId), sourceLotId: stringValue(line.sourceLotId), date: stringValue(line.date, stringValue(input.invoiceDate, fallbackDate)),
    scale: stringValue(line.scale), quantity: stringValue(line.quantity), total: minorToForm(line.totalMinor),
    pricePerGram: minorToForm(line.pricePerGramMinor), priceManual: true, totalManual: true,
  })) : [];
  const motoValue = objectValue(input.moto);
  const payment = (value: unknown): Payment => value === "transfer" || value === "mercado_pago" || value === "card" ? value : "cash";
  const addressObject = objectValue(input.address);
  return { status: "valid", draft: {
    memberId: stringValue(input.memberId, stringValue(order?.memberId)),
    invoiceNumber: stringValue(input.invoiceNumber) || stringValue(quote.invoiceNumber), invoiceDate: stringValue(input.invoiceDate, fallbackDate), currency: input.currency,
    address: formatAddress(addressObject), addressObject, note: stringValue(input.note),
    productPaymentMethod: payment(input.productPaymentMethod), lines,
    moto: Object.keys(motoValue).length ? {
      deliveryDate: stringValue(motoValue.deliveryDate, fallbackDate), paymentMethod: payment(motoValue.paymentMethod),
      serviceType: stringValue(motoValue.serviceType, "CABA"), destination: stringValue(motoValue.destination),
      clientTariff: minorToForm(motoValue.clientTariffMinor), adminTariff: minorToForm(motoValue.adminTariffMinor),
      totalTariff: minorToForm(motoValue.totalTariffMinor), notes: stringValue(motoValue.notes),
    } : null,
  } };
}
function blankDraft(date: string): InvoiceDraft {
  return { memberId: "", invoiceNumber: "", invoiceDate: date, currency: "ARS", address: "", addressObject: {}, note: "", productPaymentMethod: "cash", lines: [], moto: null };
}
function blankMemberDraft(): NewMemberDraft { return { name: "", email: "", phone: "", address: "" }; }
function amountMinorOrNull(value: string): bigint | null {
  try {
    const amount = BigInt(amountFormToMinor(value));
    return amount < 0n ? null : amount;
  } catch { return null; }
}
function calculateMotoPreview(clientTariff: string, paymentMethod: Payment, currency: "ARS" | "USD") {
  const clientTariffMinor = amountMinorOrNull(clientTariff);
  if (clientTariffMinor === null) return null;
  const result = calculateAppSheetInvoiceFinancials({
    subtotalMinor: 0n,
    clientTariffMinor,
    paymentMethod: "cash",
    currency,
    moto: { paymentMethod },
  });
  if (result.motoTransferMinor === null || result.motoClientSubtotalMinor === null) return null;
  return { transferMinor: result.motoTransferMinor, subtotalMinor: result.motoClientSubtotalMinor };
}
function addressObjectWithText(source: Row, address: string): Row {
  return { ...source, address: address.trim() };
}
function scaledGrams(lines: InvoiceLineDraft[]): string | null {
  let total = 0n;
  for (const line of lines) {
    const value = line.quantity.trim().replace(",", ".");
    if (!/^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(value)) return null;
    const [whole, fraction = ""] = value.split(".");
    const lineThousandths = BigInt(whole!) * 1000n + BigInt((fraction + "000").slice(0, 3));
    if (lineThousandths <= 0n) return null;
    total += lineThousandths;
  }
  const whole = total / 1000n, fraction = (total % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole},${fraction}` : whole.toString();
}
function positiveQuantity(value: string) {
  const normalized = value.trim().replace(",", ".");
  return /^(0|[1-9]\d*)(?:\.\d{1,3})?$/.test(normalized) && Number(normalized) > 0;
}
function invoiceQuantityValid(value: string, replacementProfile: boolean) {
  if (!positiveQuantity(value)) return false;
  if (!replacementProfile) return true;
  const quantity = Number(value.trim().replace(",", "."));
  return quantity >= 1 && quantity <= 99;
}
function invoiceSkuSelectable(item: Row, replacementProfile: boolean) {
  const available = objectValue(item.appSheet).availability;
  return item.active !== false && item.unit === "g" && (replacementProfile ? available === "Sí" : available !== "NO");
}
function paymentOptions(legacyCard = false) {
  return [...(legacyCard ? [{ value: "card", label: "Tarjeta · valor heredado" }] : []), { value: "cash", label: "ARS" }, { value: "transfer", label: "Transferencia" }, { value: "mercado_pago", label: "Mercado Pago" }] as const;
}

const observedScales = ["Precio_5_Gramos", "Precio_10_Gramos", "Precio_15_Gramos", "Precio_20_Gramos", "Precio_25_Gramos", "Precio_30_Gramos", "Pack Premium", "Pack Amigos", "Promo_C"];
const observedServiceTypes = ["CABA", "Zona Norte 1", "Zona Norte 2", "CABA - ENVIO GRATIS", "PBA"];
const MAX_INVOICE_MINOR = 9223372036854775807n;

export function AppSheetInvoiceForm(props: Props) {
  const { open, mode, order, expectedVersion, memberName, context, catalog, catalogLoading, catalogError, retryCatalog, loadMoreCatalog, hasMoreCatalog, runCommand, onClose, onSaved } = props;
  const replacementProfile = context.authority.cutoverProfile === "appsheet-replacement";
  const dialog = useRef<HTMLDialogElement>(null);
  const productDialog = useRef<HTMLDialogElement>(null);
  const motoDialog = useRef<HTMLDialogElement>(null);
  const memberDialog = useRef<HTMLDialogElement>(null);
  const target = useRef(crypto.randomUUID());
  const memberTarget = useRef(crypto.randomUUID());
  const attempted = useRef<{ command: string; data: Row } | null>(null);
  const submitting = useRef(false);
  const memberSubmitting = useRef(false);
  const initialDate = useMemo(() => civilDate(context.timeZone), [context.timeZone]);
  const snapshot = useMemo(() => mode === "edit-preorder" ? fromSnapshot(order, initialDate) : null, [mode, order, initialDate]);
  const snapshotError = mode === "edit-preorder" && snapshot?.status !== "valid"
    ? snapshot?.error ?? "No se pudo cargar la preventa original para editar. La versión guardada se conserva."
    : "";
  const initial = useMemo(() => snapshot?.status === "valid" ? snapshot.draft : blankDraft(initialDate), [snapshot, initialDate]);
  const [draft, setDraft] = useState<InvoiceDraft>(initial);
  const [stage, setStage] = useState<"main" | "product" | "moto" | "member">("main");
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
  const [newMemberDraft, setNewMemberDraft] = useState<NewMemberDraft>(blankMemberDraft);
  const [newMemberSaving, setNewMemberSaving] = useState(false);
  const [newMemberUncertain, setNewMemberUncertain] = useState(false);
  const [newMemberError, setNewMemberError] = useState("");
  const [memberSelectionNotice, setMemberSelectionNotice] = useState("");
  const [createdMemberOption, setCreatedMemberOption] = useState<{ value: string; label: string } | null>(null);
  const [memberLookupRevision, setMemberLookupRevision] = useState(0);
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
    if (mode === "edit-preorder") setConfirmationEvidence("");
  }, [mode, draft]);

  useEffect(() => {
    const element = stage === "product" ? productDialog.current : stage === "moto" ? motoDialog.current : stage === "member" ? memberDialog.current : null;
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
    if (!busy && !uncertain && !newMemberSaving && !newMemberUncertain) return;
    const preventLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeaving);
    return () => window.removeEventListener("beforeunload", preventLeaving);
  }, [busy, uncertain, newMemberSaving, newMemberUncertain]);

  function close() {
    if (busy || uncertain || submitting.current || newMemberSaving || newMemberUncertain || memberSubmitting.current) return;
    dialog.current?.close();
    onClose();
  }
  function updateDraft<K extends keyof InvoiceDraft>(key: K, value: InvoiceDraft[K]) {
    setDraft(current => ({ ...current, [key]: value }));
  }
  function openProduct(index?: number) {
    const existing = index === undefined ? null : draft.lines[index] ?? null;
    setProductIndex(index ?? null);
    setProductDraft(existing ? { ...existing } : { id: crypto.randomUUID(), skuId: "", sourceLotId: "", date: draft.invoiceDate, scale: "", quantity: "", total: "", pricePerGram: "", priceManual: false, totalManual: false });
    setStage("product");
    setError("");
  }
  function maybeSetInitialPricePerGram(line: InvoiceLineDraft): InvoiceLineDraft {
    if (!replacementProfile || mode !== "invoice" || productIndex !== null) return line;
    let next = line;
    let proposedPriceMinor: string | undefined;
    if (!line.priceManual) {
      const item = line.skuId && line.scale
        ? catalog.find(candidate => String(candidate.id) === line.skuId && invoiceSkuSelectable(candidate, true))
        : undefined;
      const catalogue = item ? appSheetCatalogueStoredSchema.safeParse(objectValue(item.appSheet)) : null;
      const proposal = catalogue?.success ? proposeAppSheetLinePricingInitialValue({
        catalogue: catalogue.data,
        scale: line.scale,
        quantityGrams: line.quantity.trim().replace(",", "."),
        expectedCurrency: draft.currency,
      }) : null;
      proposedPriceMinor = proposal?.status === "defined" ? proposal.unitPriceMinor : undefined;
      next = { ...next, pricePerGram: proposedPriceMinor === undefined ? "" : minorToForm(proposedPriceMinor) };
    }

    if (!line.totalManual) {
      let unitPriceMinor = proposedPriceMinor;
      if (line.priceManual && line.pricePerGram.trim()) {
        try { unitPriceMinor = amountFormToMinor(line.pricePerGram); } catch { unitPriceMinor = undefined; }
      }
      const subtotal = unitPriceMinor === undefined ? null : proposeAppSheetLineSubtotal({
        unitPriceMinor,
        quantityGrams: line.quantity.trim().replace(",", "."),
      });
      next = { ...next, total: subtotal?.status === "defined" ? minorToForm(subtotal.subtotalMinor) : "" };
    }
    return next;
  }
  function updateProductField(field: "id" | "skuId" | "sourceLotId" | "date" | "scale" | "quantity" | "total" | "pricePerGram", value: string) {
    setProductDraft(current => {
      if (!current) return current;
      const updated: InvoiceLineDraft = { ...current, [field]: value, ...(field === "skuId" ? { sourceLotId: "" } : {}) };
      if (field === "pricePerGram") return maybeSetInitialPricePerGram({ ...updated, priceManual: Boolean(value.trim()) });
      if (field === "total") return maybeSetInitialPricePerGram({ ...updated, totalManual: Boolean(value.trim()) });
      if (field === "skuId" || field === "scale" || field === "quantity") return maybeSetInitialPricePerGram(updated);
      return updated;
    });
  }
  function cancelProduct() {
    if (busy || uncertain) return;
    productDialog.current?.close(); setProductDraft(null); setProductIndex(null); setStage("main");
  }
  function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!productDraft) return;
    const submittedDraft = maybeSetInitialPricePerGram(productDraft);
    const selected = catalog.find(item => String(item.id) === submittedDraft.skuId && invoiceSkuSelectable(item, replacementProfile));
    const retainedHistoricalSku = replacementProfile && mode === "edit-preorder" && productIndex !== null && initial.lines.some(line => line.id === submittedDraft.id && line.skuId === submittedDraft.skuId);
    if (!selected && !retainedHistoricalSku) {
      setError("La variedad seleccionada ya no está disponible para nuevas líneas. Conservamos el borrador; elegí otra o verificá el catálogo antes de continuar.");
      return;
    }
    const requiresSelectedSourceLot = activeReplacement && selected?.requiresAppSheetSourceLot === true && mode !== "preorder" && mode !== "edit-preorder";
    const sourceLotOptionsForLine = sourceLotOptions(selected);
    if (requiresSelectedSourceLot && (!submittedDraft.sourceLotId || !sourceLotOptionsForLine.some(option => stringValue(option.sourceLotId) === submittedDraft.sourceLotId))) {
      setError("Elegí un lote de origen con disponibilidad actual para cada producto antes de guardar la factura.");
      return;
    }
    if (activeReplacement && submittedDraft.sourceLotId && selected?.requiresAppSheetSourceLot !== true) {
      setError("Los productos nativos no usan lotes de origen AppSheet. Volvé a seleccionar el producto para limpiar esa referencia.");
      return;
    }
    if (activeReplacement && selected?.requiresAppSheetSourceLot === true && mode === "preorder" && submittedDraft.sourceLotId && !sourceLotOptionsForLine.some(option => stringValue(option.sourceLotId) === submittedDraft.sourceLotId)) {
      setError("El lote guardado ya no tiene disponibilidad actual. Elegí otro o dejá la selección vacía para resolverlo al editar la preventa.");
      return;
    }
    if (!submittedDraft.date) { setError("Completá la fecha del producto."); return; }
    if (!invoiceQuantityValid(submittedDraft.quantity, replacementProfile)) {
      setError(replacementProfile ? "Ingresá entre 1 y 99 gramos, con hasta tres decimales." : "Ingresá gramos mayores que cero, con hasta tres decimales.");
      return;
    }
    let totalMinor: string;
    try { totalMinor = amountFormToMinor(submittedDraft.total); } catch { setError("Ingresá el Valor total con hasta dos decimales."); return; }
    let pricePerGramMinor: string | undefined;
    try {
      if (submittedDraft.pricePerGram.trim()) {
        pricePerGramMinor = amountFormToMinor(submittedDraft.pricePerGram);
        if (pricePerGramMinor.startsWith("-") || BigInt(pricePerGramMinor) > MAX_INVOICE_MINOR) throw new Error("El precio debe ser no negativo y estar dentro del rango admitido.");
      }
    } catch { setError("Ingresá un Precio por gramo opcional, no negativo y con hasta dos decimales."); return; }
    const committed = {
      ...submittedDraft,
      total: minorToForm(totalMinor),
      pricePerGram: pricePerGramMinor === undefined ? "" : minorToForm(pricePerGramMinor),
      priceManual: true,
      totalManual: true,
      skuId: submittedDraft.skuId,
    };
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
  function openMemberCreate() {
    if (busy || uncertain || newMemberSaving || newMemberUncertain || mode === "edit-preorder" || mode === "confirm-preorder") return;
    memberTarget.current = crypto.randomUUID();
    setNewMemberDraft(blankMemberDraft());
    setNewMemberError(""); setNewMemberUncertain(false); setMemberSelectionNotice("");
    setStage("member");
  }
  function cancelMemberCreate() {
    if (newMemberSaving || newMemberUncertain || memberSubmitting.current) return;
    memberDialog.current?.close(); setStage("main"); setNewMemberError("");
  }
  async function createMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (memberSubmitting.current || newMemberSaving || !canCreateMember) return;
    const name = newMemberDraft.name.trim();
    if (!name) { setNewMemberError("Completá el nombre completo del socio."); return; }
    memberSubmitting.current = true; setNewMemberSaving(true); setNewMemberUncertain(false); setNewMemberError(""); setMemberSelectionNotice("");
    const data: Row = {
      name,
      email: newMemberDraft.email.trim(),
      phone: newMemberDraft.phone.trim(),
      address: newMemberDraft.address.trim() ? { address: newMemberDraft.address.trim() } : {},
      preferences: {},
    };
    try {
      await runCommand("MemberCreated", memberTarget.current, 0, data);
    } catch (cause) {
      const pending = isUncertainCommandOutcome(cause);
      setNewMemberUncertain(pending);
      setNewMemberError(pending
        ? "La confirmación del socio quedó pendiente. Conservamos los datos; reintentá sin editarlos para recuperar el mismo registro."
        : cause instanceof Error ? cause.message : "No se pudo crear el socio.");
      memberSubmitting.current = false; setNewMemberSaving(false);
      return;
    }

    try {
      const response = await apiGet<Row>(`/api/operations/members/${encodeURIComponent(memberTarget.current)}`);
      const member = objectValue(response.member);
      const id = stringValue(member.id), label = stringValue(member.name).trim();
      if (id !== memberTarget.current || !label) throw new Error("La ficha devuelta no coincide con el socio recién creado.");
      setCreatedMemberOption({ value: id, label });
      setMemberLookupRevision(value => value + 1);
      selectedMember(id);
      memberDialog.current?.close(); setStage("main"); setNewMemberError(""); setMemberSelectionNotice("");
      memberTarget.current = crypto.randomUUID();
    } catch {
      memberDialog.current?.close(); setStage("main"); setNewMemberError("");
      setMemberSelectionNotice("El socio fue guardado, pero no se pudo comprobar su ficha para seleccionarlo. Conservamos la factura; buscá el socio en la lista antes de guardar.");
      memberTarget.current = crypto.randomUUID();
    } finally {
      memberSubmitting.current = false; setNewMemberSaving(false);
    }
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
      if (!line.skuId || !invoiceQuantityValid(line.quantity, replacementProfile) || !line.date) {
        throw new Error(replacementProfile
          ? "Revisá cada producto: variedad, fecha y gramos entre 1 y 99, con hasta tres decimales, son obligatorios."
          : "Revisá cada producto: variedad, fecha y gramos son obligatorios.");
      }
      const includePricePerGram = !preorder && (mode === "invoice" || mode === "edit-preorder") && line.pricePerGram.trim() !== "";
      const originalLine = initial.lines.find(original => original.id === line.id);
      const preservedPreorderPrice = preorder && originalLine?.pricePerGram.trim()
        ? amountFormToMinor(originalLine.pricePerGram)
        : undefined;
      const pricePerGramMinor = includePricePerGram
        ? amountFormToMinor(line.pricePerGram)
        : preservedPreorderPrice;
      return {
        id: line.id, skuId: line.skuId, date: line.date, scale: line.scale,
        quantity: line.quantity.trim().replace(",", "."), totalMinor: amountFormToMinor(line.total),
        ...(line.sourceLotId ? { sourceLotId: line.sourceLotId } : {}),
        ...(pricePerGramMinor === undefined ? {} : { pricePerGramMinor }),
      };
    });
    const moto = draft.moto ? {
      deliveryDate: draft.moto.deliveryDate, paymentMethod: draft.moto.paymentMethod,
      serviceType: draft.moto.serviceType.trim(), destination: draft.moto.destination.trim(),
      clientTariffMinor: amountFormToMinor(draft.moto.clientTariff), adminTariffMinor: amountFormToMinor(draft.moto.adminTariff), totalTariffMinor: amountFormToMinor(draft.moto.totalTariff), notes: draft.moto.notes,
    } : undefined;
    return {
      memberId: draft.memberId, ...((!replacementProfile || mode === "edit-preorder") && draft.invoiceNumber.trim() ? { invoiceNumber: draft.invoiceNumber.trim() } : {}), invoiceDate: draft.invoiceDate,
      currency: draft.currency, address, note: draft.note, productPaymentMethod: draft.productPaymentMethod,
      lines, ...(moto ? { moto } : {}), preorder,
    };
  }
  async function saveInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || memberSubmitting.current || newMemberUncertain || !draft.memberId || busy) return;
    setError("");
    if (mode === "invoice" && !draft.lines.length) { setError("Agregá al menos un producto antes de guardar la factura."); return; }
    if (replacementProfile && !uncertain) {
      const missingSku = draft.lines.find(line =>
        !catalog.some(item => String(item.id) === line.skuId && invoiceSkuSelectable(item, true)),
      );
      if (missingSku) {
        const missingFromLoadedPages = !catalog.some(item => String(item.id) === missingSku.skuId);
        if (isRetainedHistoricalLine(missingSku)) {
          const recovery = catalogError
            ? "Reintentá la carga del catálogo"
            : catalogLoading
              ? "Esperá a que termine la verificación del catálogo"
              : hasMoreCatalog && missingFromLoadedPages
                ? "Cargá más variedades para verificarla"
                : "Verificá el catálogo o elegí una variedad disponible";
          setError(`La variedad se conserva desde la preventa original, pero requiere disponibilidad actual en el catálogo para confirmar. ${recovery}; conservamos el borrador.`);
          return;
        }
        setError(catalogError
          ? "No se pudo verificar el catálogo. Reintentá la carga antes de guardar; conservamos las líneas del borrador."
          : catalogLoading || hasMoreCatalog && missingFromLoadedPages
            ? "La variedad no aparece entre las páginas cargadas. Cargá más variedades para verificarla; conservamos la línea del borrador."
            : "La variedad seleccionada dejó de estar disponible. Conservamos la línea del borrador; elegí una variedad disponible o quitá esa línea antes de guardar.");
        return;
      }
      if (activeReplacement && mode !== "preorder" && mode !== "edit-preorder") {
        if (catalogLoading || catalogError) {
          setError(catalogError
            ? "No se pudo verificar la disponibilidad de lotes. Reintentá la carga antes de guardar; conservamos el borrador."
            : "Esperá a que termine la verificación de lotes antes de guardar; conservamos el borrador.");
          return;
        }
        const missingSourceLot = draft.lines.find(line => {
          const product = catalog.find(item => String(item.id) === line.skuId);
          if (product?.requiresAppSheetSourceLot !== true) return false;
          const options = sourceLotOptions(product);
          return !line.sourceLotId || !options.some(option => stringValue(option.sourceLotId) === line.sourceLotId);
        });
        if (missingSourceLot) {
          setError("Cada producto necesita un lote de origen con disponibilidad actual. Editá la línea, elegí un lote vigente y guardá de nuevo.");
          return;
        }
      }
    }
    submitting.current = true; setBusy(true);
    const isCreate = mode === "invoice" || mode === "preorder";
    const command = isCreate ? "InvoiceSaved" : "InvoiceUpdated";
    let data: Row;
    try {
      if (mode === "edit-preorder" && snapshotError) {
        setError(snapshotError);
        submitting.current = false; setBusy(false);
        return;
      }
      data = attempted.current?.command === command
        ? attempted.current.data
        : {
          ...payload(mode === "preorder" || mode === "edit-preorder"),
        };
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Revisá los datos de la factura."); submitting.current = false; setBusy(false); return; }
    attempted.current = { command, data };
    try {
      await runCommand(command, isCreate ? target.current : String(order?.id), isCreate ? 0 : expectedVersion ?? Number.NaN, data, isCreate);
      const orderId = isCreate ? target.current : String(order?.id);
      const message = mode === "preorder" ? "Preventa creada. Todavía no reserva stock ni programa un envío." : mode === "edit-preorder" ? "Preventa guardada y todavía pendiente de confirmación. No se reservó stock ni se programó un envío." : "Factura guardada y confirmada. El envío quedó vinculado cuando corresponde; no se registró ningún cobro.";
      dialog.current?.close(); onSaved(orderId, message); onClose();
    } catch (cause) {
      const pending = uncertain || isUncertainCommandOutcome(cause);
      setUncertain(pending);
      if (!pending) attempted.current = null;
      setError(pending
        ? mode === "edit-preorder"
          ? "Resultado del guardado pendiente: el servidor pudo haber guardado esta preventa. No cambies los campos; reintentá para recuperar el mismo registro."
          : "Confirmación pendiente: el servidor pudo haber guardado esta factura. No cambies los campos; reintentá para recuperar el mismo comprobante."
        : cause instanceof Error ? cause.message : "No se pudo guardar la factura.");
    } finally { submitting.current = false; setBusy(false); }
  }

  async function confirmPreorder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = String(order?.id ?? "");
    const quote = objectValue(confirmation?.quote);
    const savedLines = Array.isArray(quote.lines) ? quote.lines : [];
    if (!id || !savedLines.length || !confirmationEvidence.trim() || !Number.isSafeInteger(confirmationVersion)) {
      setConfirmationError(!savedLines.length ? "La preventa todavía no tiene productos guardados. Abrí «Formulario de venta» antes de confirmar." : "Cargá la evidencia informada y actualizá la versión del registro.");
      return;
    }
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setConfirmationError("");
    try {
      await runCommand("InvoiceConfirmed", id, confirmationVersion!, { acceptance: { note: confirmationEvidence.trim() } });
      dialog.current?.close(); onSaved(id, "Preventa confirmada con la versión guardada y la evidencia aportada por el operador. Se reservó stock y se creó el envío si incluye servicio de moto; no se registró un cobro."); onClose();
    } catch (cause) {
      setUncertain(isUncertainCommandOutcome(cause));
      setConfirmationError(isUncertainCommandOutcome(cause)
        ? "Confirmación pendiente: se pudo confirmar la preventa. Conservá la evidencia y reintentá exactamente la misma acción."
        : cause instanceof Error ? cause.message : "No se pudo confirmar la preventa.");
    } finally { submitting.current = false; setBusy(false); }
  }

  if (!open) return null;
  if (mode === "edit-preorder" && snapshotError) return <dialog className="ops-dialog appsheet-invoice-dialog" ref={dialog} data-testid="appsheet-invoice-dialog" aria-labelledby="appsheet-invoice-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="ops-dialog-card appsheet-invoice-card">
      <header className="ops-dialog-head appsheet-invoice-head">
        <div><span className="ops-kicker">Bombo · Facturación</span><h2 id="appsheet-invoice-title">Formulario de venta</h2><p>La preventa original debe conservarse para poder editarla.</p></div>
        <button type="button" className="ops-icon-button" aria-label="Cerrar formulario" onClick={close}>×</button>
      </header>
      <div className="appsheet-invoice-body"><p className="ops-inline-error" role="alert">{snapshotError}</p>
        <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={close}>Cerrar</button></footer>
      </div>
    </div>
  </dialog>;
  const creatingShell = mode === "preorder";
  const confirming = mode === "confirm-preorder";
  const selectedMember = (value: string) => {
    if (busy || uncertain || value === draft.memberId) return;
    addressEdited.current = false;
    setAddressTouched(false); setMemberLoading(false); setMemberError(""); setMemberSelectionNotice("");
    setDraft(current => ({ ...current, memberId: value, address: "", addressObject: {} }));
  };
  const canCreateMember = mode !== "edit-preorder" && mode !== "confirm-preorder" && hasCommand(context, "MemberCreated") && hasCapability(context, "members.write") && hasCapability(context, "members.read");
  const saleProducts = catalog.filter(item => invoiceSkuSelectable(item, replacementProfile));
  const activeReplacement = replacementProfile && context.authority.mode === "active";
  const selectedProduct = productDraft ? catalog.find(item => String(item.id) === productDraft.skuId) : undefined;
  const selectedSourceLots = sourceLotOptions(selectedProduct);
  const retainedProductIsHistorical = Boolean(productDraft && replacementProfile && mode === "edit-preorder" && initial.lines.some(line => line.id === productDraft.id && line.skuId === productDraft.skuId));
  const isRetainedHistoricalLine = (line: InvoiceLineDraft) =>
    replacementProfile && mode === "edit-preorder" && initial.lines.some(original => original.id === line.id && original.skuId === line.skuId);
  const lineSkuNeedsAttention = (line: InvoiceLineDraft) =>
    replacementProfile && !catalog.some(item => String(item.id) === line.skuId && invoiceSkuSelectable(item, true));
  const lineSkuAttentionMessage = (line: InvoiceLineDraft) => {
    const item = catalog.find(candidate => String(candidate.id) === line.skuId);
    if (isRetainedHistoricalLine(line)) return "Variedad conservada desde la preventa original; requiere disponibilidad actual en el catálogo para confirmar. Verificá el catálogo o elegí una variedad disponible.";
    if (catalogError) return "No se pudo verificar esta variedad. Reintentá la carga; conservamos la línea.";
    if (!item && hasMoreCatalog) return "No aparece en las páginas cargadas. Cargá más variedades para verificarla; conservamos la línea.";
    return "Esta variedad ya no está disponible. Conservamos la línea; elegí otra variedad o quitá esta antes de guardar.";
  };
  const invoiceGrams = scaledGrams(draft.lines);
  const productLineAmounts = draft.lines.map(line => amountMinorOrNull(line.total));
  const validProductAmounts = productLineAmounts.filter((amount): amount is bigint => amount !== null);
  const productSubtotalMinor = validProductAmounts.length === productLineAmounts.length
    ? validProductAmounts.reduce((sum, amount) => sum + amount, 0n)
    : null;
  const productPreviewReady = draft.lines.length > 0 && productSubtotalMinor !== null && draft.lines.every(line => Boolean(line.skuId && line.date && invoiceQuantityValid(line.quantity, replacementProfile)));
  const clientTariffPreview = draft.moto ? amountMinorOrNull(draft.moto.clientTariff) : 0n;
  const clientTariffMinor = clientTariffPreview;
  const capturedBaseMinor = productSubtotalMinor === null || clientTariffMinor === null ? null : productSubtotalMinor + clientTariffMinor;
  const motoSummaryPreview = replacementProfile && mode !== "edit-preorder" && draft.moto
    ? calculateMotoPreview(draft.moto.clientTariff, draft.moto.paymentMethod, draft.currency)
    : null;
  const motoEditorPreview = replacementProfile && mode !== "edit-preorder" && motoDraft
    ? calculateMotoPreview(motoDraft.clientTariff, motoDraft.paymentMethod, draft.currency)
    : null;
  const formulaPreview = replacementProfile && mode !== "edit-preorder" && productPreviewReady && productSubtotalMinor !== null && clientTariffPreview !== null ? calculateAppSheetInvoiceFinancials({
    subtotalMinor: productSubtotalMinor,
    clientTariffMinor: clientTariffPreview,
    paymentMethod: draft.productPaymentMethod,
    currency: draft.currency,
    ...(draft.moto ? { moto: { paymentMethod: draft.moto.paymentMethod } } : {}),
  }) : null;
  const quote = objectValue(confirmation?.quote);
  const savedLines = Array.isArray(quote.lines) ? quote.lines.filter((item): item is Row => Boolean(item) && typeof item === "object") : [];
  const savedInput = objectValue(quote.input);
  const savedInputLines = Array.isArray(savedInput.lines)
    ? savedInput.lines.filter((item): item is Row => Boolean(item) && typeof item === "object")
    : savedLines;
  const unboundConfirmedSourceLot = activeReplacement && !catalogLoading && !catalogError
    ? savedInputLines.find(line => {
      const product = catalog.find(item => String(item.id) === stringValue(line.skuId));
      if (product?.requiresAppSheetSourceLot !== true) return false;
      const sourceLotId = stringValue(line.sourceLotId);
      const options = sourceLotOptions(product);
      return !sourceLotId || !options.some(option => stringValue(option.sourceLotId) === sourceLotId);
    })
    : undefined;
  const blankPreorder = confirming && savedLines.length === 0;

  return <dialog className="ops-dialog appsheet-invoice-dialog" ref={dialog} data-testid="appsheet-invoice-dialog" aria-labelledby="appsheet-invoice-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="ops-dialog-card appsheet-invoice-card">
      <header className="ops-dialog-head appsheet-invoice-head">
        <div><span className="ops-kicker">Bombo · Facturación</span><h2 id="appsheet-invoice-title">{confirming ? "Confirmar preventa" : creatingShell ? "Preventa" : mode === "edit-preorder" ? "Formulario de venta" : "Nueva factura"}</h2>
          <p>{confirming ? "Se confirma exactamente la última versión guardada, sin volver a cotizar." : creatingShell ? "Guardá fecha y socio para continuar el formulario más tarde." : mode === "edit-preorder" ? "Guardá los cambios; la preventa sigue pendiente hasta que elijas Confirmar preventa." : "Completá la factura y el viaje de moto con los importes ingresados."}</p></div>
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
          <div><span>Total facturado</span><strong>{quote.totalCalculationState === "defined" ? formatMinor(quote.totalMinor, quote.currency) : "Pendiente de definición"}</strong></div>
          <div><span>Importe capturado</span><strong>{formatMinor(quote.capturedBaseMinor, stringValue(quote.currency, "ARS"))}</strong></div>
          {quote.currency === "USD" && <div><span>Moneda</span><strong>USD</strong></div>}
          {savedLines.map((line, index) => <p key={stringValue(line.id, String(index))}>{stringValue(line.date)} · {stringValue(line.scale, "Escala sin dato")} · {stringValue(line.quantity, stringValue(line.requested))} g · {formatMinor(line.explicitTotalMinor, quote.currency)}</p>)}
          {Boolean(objectValue(quote.moto).deliveryDate) && <p>Viaje en moto · {stringValue(objectValue(quote.moto).deliveryDate)} · {stringValue(objectValue(quote.moto).destination)}</p>}
        </section>}
        {unboundConfirmedSourceLot && <p className="ops-inline-error" role="alert">Esta preventa no tiene un lote de origen con disponibilidad actual para cada producto. Abrí «Formulario de venta», elegí un lote vigente y guardá los cambios antes de confirmar.</p>}
        {unboundConfirmedSourceLot && hasMoreCatalog && !catalog.some(item => String(item.id) === stringValue(unboundConfirmedSourceLot.skuId)) && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={loadMoreCatalog} disabled={catalogLoading}>Cargar más variedades para verificar el lote</button>}
        {activeReplacement && catalogLoading && <p role="status">Verificando la disponibilidad de lotes de origen…</p>}
        {activeReplacement && catalogError && <p className="ops-inline-error" role="alert">No se pudo verificar la disponibilidad de lotes. Reintentá cargar el catálogo antes de confirmar.</p>}
        {confirmation && !blankPreorder && <label className="ops-field appsheet-field" htmlFor="appsheet-acceptance"><span>Evidencia aportada por el operador</span><textarea id="appsheet-acceptance" name="acceptance" value={confirmationEvidence} onChange={event => setConfirmationEvidence(event.target.value)} maxLength={2000} required disabled={busy || uncertain} /><small>El sistema registra esta evidencia, pero no verifica el consentimiento del cliente.</small></label>}
        {uncertain && <p className="appsheet-pending" role="alert">Confirmación pendiente: se pudo confirmar la preventa. Conservá la evidencia y reintentá exactamente la misma acción.</p>}
        <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={close} disabled={busy || uncertain}>Cancelar</button><button type="submit" className="ops-button ops-button-primary" data-testid={uncertain ? "appsheet-retry-confirm-preorder" : "appsheet-confirm-preorder"} disabled={busy || confirmationLoading || !confirmation || blankPreorder || Boolean(unboundConfirmedSourceLot) || (activeReplacement && (catalogLoading || Boolean(catalogError))) || !Number.isSafeInteger(confirmationVersion) || !confirmationEvidence.trim()}>{busy ? "Confirmando…" : uncertain ? "Reintentar confirmación" : "Confirmar preventa"}</button></footer>
      </form> : <form className="appsheet-invoice-body" onSubmit={event => void saveInvoice(event)} aria-busy={busy}>
        {creatingShell ? <div className="appsheet-shell-grid">
          <label className="ops-field appsheet-field"><span>Fecha</span><input name="invoiceDate" data-testid="invoiceDate" aria-label="Fecha" type="date" value={draft.invoiceDate} disabled /></label>
          {replacementProfile && <label className="ops-field appsheet-field"><span>Nro Factura</span><input name="invoiceNumber" data-testid="invoiceNumber" aria-label="Nro Factura" value="Se asigna al guardar" readOnly /></label>}
          <div className="ops-field appsheet-field"><span>Nombre del asociado</span><fieldset className="appsheet-lookup-fieldset" disabled={busy || uncertain}><RemoteSelect field={{ name: "memberId", label: "Nombre del asociado", type: "select", required: true, lookupPath: "/api/operations/members" }} value={draft.memberId} onChange={selectedMember} /></fieldset></div>
        </div> : <>
          {draft.currency === "USD" && <p className="appsheet-currency-label">Moneda de la preventa original: <strong>USD</strong>. Se conserva sin conversión.</p>}
          <div className="appsheet-invoice-fields">
            {replacementProfile
              ? <label className="ops-field appsheet-field"><span>Nro Factura</span><input name="invoiceNumber" data-testid="invoiceNumber" aria-label="Nro Factura" value={draft.invoiceNumber || (mode === "edit-preorder" ? "No disponible" : "Se asigna al guardar")} readOnly /></label>
              : <label className="ops-field appsheet-field"><span>Nro Factura</span><input name="invoiceNumber" data-testid="invoiceNumber" aria-label="Nro Factura" value={draft.invoiceNumber} onChange={event => updateDraft("invoiceNumber", event.target.value)} maxLength={120} disabled={busy || uncertain} />
              </label>
            }
            <label className="ops-field appsheet-field"><span>Fecha</span><input name="invoiceDate" data-testid="invoiceDate" aria-label="Fecha" type="date" value={draft.invoiceDate} onChange={event => updateDraft("invoiceDate", event.target.value)} required disabled={busy || uncertain} /></label>
            <div className="ops-field appsheet-field"><span>Cliente</span>{mode === "edit-preorder" ? <input aria-label="Cliente" value={memberName || `Socio #${draft.memberId.slice(0, 8)}`} readOnly /> : <fieldset className="appsheet-lookup-fieldset" disabled={busy || uncertain}><RemoteSelect key={memberLookupRevision} field={{ name: "memberId", label: "Cliente", type: "select", required: true, lookupPath: "/api/operations/members", ...(createdMemberOption ? { defaultValue: createdMemberOption.value, options: [createdMemberOption] } : {}) }} value={draft.memberId} onChange={selectedMember} /></fieldset>}{canCreateMember && <button type="button" className="ops-button ops-button-quiet ops-button-small" data-testid="appsheet-add-member" onClick={openMemberCreate} disabled={busy || uncertain || newMemberSaving || newMemberUncertain}>＋ Añadir socio</button>}{memberSelectionNotice && <small className="appsheet-subtle-error" role="alert">{memberSelectionNotice}</small>}{mode === "edit-preorder" && <small>El socio se conserva desde la preventa original.</small>}</div>
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
              const sourceLot = sourceLotOptions(product).find(option => stringValue(option.sourceLotId) === line.sourceLotId);
              const skuNeedsAttention = replacementProfile && !saleProducts.some(item => String(item.id) === line.skuId);
              const lineTotalMinor = amountMinorOrNull(line.total);
              return <li className="appsheet-dialog-line" key={line.id} data-testid={`appsheet-product-row-${line.id}`}>
                <div><strong>{stringValue(product?.name, line.skuId || "Producto")}</strong><span>{line.date} · {line.scale || "Escala sin dato"} · {line.quantity} g · {lineTotalMinor === null ? "Importe pendiente de corregir" : formatMinor(lineTotalMinor.toString(), draft.currency)}{line.sourceLotId ? ` · Lote ${sourceLot?.receivedDate ?? "sin disponibilidad actual"}${sourceLot ? ` · ${sourceLot.availableQuantity} g disponibles` : ""}` : activeReplacement && product?.requiresAppSheetSourceLot === true ? " · lote pendiente" : ""}</span>{skuNeedsAttention && <small className="appsheet-subtle-error" role="alert">{lineSkuAttentionMessage(line)}</small>}</div>
                <div className="appsheet-line-actions"><button type="button" className="ops-button ops-button-quiet ops-button-small" data-testid={`appsheet-edit-product-${line.id}`} onClick={() => openProduct(index)} disabled={busy || uncertain}>Editar producto</button><button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => removeProduct(index)} disabled={busy || uncertain}>Quitar</button></div>
              </li>;
            })}</ul> : <p className="appsheet-footnote">Todavía no agregaste productos.</p>}
            {replacementProfile && draft.lines.some(lineSkuNeedsAttention) && hasMoreCatalog && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={loadMoreCatalog} disabled={catalogLoading}>Cargar más variedades para verificar las líneas</button>}
            {replacementProfile && draft.lines.some(lineSkuNeedsAttention) && catalogError && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={retryCatalog}>Reintentar catálogo</button>}
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
            {mode !== "edit-preorder" && replacementProfile && draft.productPaymentMethod !== "cash" && draft.productPaymentMethod !== "card"
              ? <label className="ops-field appsheet-field"><span>Transferencia</span><input name="productTransfer" data-testid="productTransfer" aria-label="Transferencia" value={formulaPreview ? formatMinor(formulaPreview.transferMinor.toString(), draft.currency) : "Pendiente de definición"} readOnly /><small>5% del subtotal de productos según la regla capturada; el importe se redondea al centavo con mitad hacia arriba.</small></label>
              : mode !== "edit-preorder" && !replacementProfile && draft.productPaymentMethod === "transfer" && <label className="ops-field appsheet-field"><span>Transferencia</span><input name="productTransfer" data-testid="productTransfer" aria-label="Transferencia" value="Pendiente de definición" readOnly /><small>El campo observado está deshabilitado; el importe derivado y su fórmula siguen pendientes de cotejo.</small></label>}
          </section>

          {mode === "edit-preorder"
            ? <p className="appsheet-footnote">El valor total de cada línea se conserva como fue ingresado; guardar esta preventa no vuelve a calcular ni confirma el total de la factura.</p>
            : <><section className="appsheet-totals" aria-label="Resumen de factura" aria-live="polite">
            <div><span>Gramos</span><strong>{invoiceGrams === null ? "Pendiente de corregir" : `${invoiceGrams} g`}</strong></div>
            <div><span>Monto parcial</span><strong>{formulaPreview ? formatMinor(formulaPreview.subtotalMinor.toString(), draft.currency) : "Pendiente de definición"}</strong></div>
            <div><span>Suma explícita de líneas</span><strong>{productSubtotalMinor === null ? "Pendiente de completar importes" : formatMinor(productSubtotalMinor.toString(), draft.currency)}</strong></div>
            <div><span>Transferencia</span><strong data-testid="appsheet-product-transfer-preview">{formulaPreview ? formatMinor(formulaPreview.transferMinor.toString(), draft.currency) : draft.productPaymentMethod === "transfer" ? "Pendiente de definición" : "—"}</strong></div>
            {draft.moto && <>
              <div><span>Tarifa Cliente moto</span><strong>{clientTariffPreview === null ? "Pendiente de definición" : formatMinor(clientTariffPreview.toString(), draft.currency)}</strong></div>
              <div><span>Transferencia moto</span><strong data-testid="appsheet-moto-transfer-preview">{motoSummaryPreview ? formatMinor(motoSummaryPreview.transferMinor.toString(), draft.currency) : "Pendiente de definición"}</strong></div>
              <div><span>Subtotal cliente moto</span><strong data-testid="appsheet-moto-subtotal-preview">{motoSummaryPreview ? formatMinor(motoSummaryPreview.subtotalMinor.toString(), draft.currency) : "Pendiente de definición"}</strong></div>
            </>}
            <div><span>Importe capturado</span><strong>{capturedBaseMinor === null ? "Pendiente de completar importes" : formatMinor(capturedBaseMinor.toString(), draft.currency)}</strong></div>
            <div className="appsheet-total"><span>Total facturado</span><strong data-testid="appsheet-total-preview">{formulaPreview ? formatMinor(formulaPreview.totalMinor.toString(), draft.currency) : "Pendiente de definición"}</strong></div>
          </section>
          <p className="appsheet-footnote">{formulaPreview
            ? draft.moto
              ? "El total suma el subtotal de productos y su recargo, junto con Tarifa Cliente moto y su recargo independiente. Tarifa Administración se conserva aparte."
              : "El total suma el subtotal de productos y el recargo correspondiente a su forma de pago."
            : replacementProfile
              ? motoSummaryPreview
                ? "Tarifa Cliente moto y su recargo se muestran junto a los productos. El total de la factura queda pendiente hasta completar productos válidos."
                : "Completá productos válidos para calcular el total de la factura."
              : "El importe capturado reúne productos y Tarifa Cliente como referencia. El total facturado todavía está pendiente de definición."}</p></>}
          <label className="ops-field appsheet-field"><span>Aclaración</span><textarea name="note" data-testid="note" aria-label="Aclaración" value={draft.note} onChange={event => updateDraft("note", event.target.value)} rows={2} maxLength={2000} disabled={busy || uncertain} /></label>
          {mode === "edit-preorder" && <p className="appsheet-footnote">Guardar conserva la preventa pendiente sin reservar stock ni crear un envío. Usá «Confirmar preventa» por separado para volver a verificar disponibilidad y aplicar esos efectos.</p>}
          {mode === "invoice" && <p className="appsheet-footnote">Guardar confirma la factura y su envío cuando hay moto. El cobro queda pendiente y no afecta cajas.</p>}
        </>}
        {error && <p className={uncertain ? "appsheet-pending" : "ops-inline-error"} role="alert">{error}</p>}
        <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={close} disabled={busy || uncertain}>Cancelar</button><button type="submit" className="ops-button ops-button-primary" data-testid={uncertain ? "appsheet-retry-invoice" : "appsheet-save-invoice"} disabled={busy || (!uncertain && (!draft.memberId || ((mode === "invoice" || mode === "edit-preorder") && !draft.lines.length) || (mode === "edit-preorder" && !Number.isSafeInteger(expectedVersion))))}>{busy ? "Guardando…" : uncertain ? mode === "edit-preorder" ? "Reintentar guardado" : "Reintentar confirmación" : creatingShell || mode === "edit-preorder" ? "Guardar preventa" : "Guardar"}</button></footer>
      </form>}

      {stage === "member" && <dialog className="ops-dialog appsheet-child-dialog" ref={memberDialog} data-testid="appsheet-member-dialog" aria-labelledby="appsheet-member-title" onCancel={event => { event.preventDefault(); cancelMemberCreate(); }}>
        <form className="ops-dialog-card appsheet-child-card" onSubmit={event => void createMember(event)} aria-busy={newMemberSaving}>
          <header className="ops-dialog-head"><div><span className="ops-kicker">Bombo · Facturación</span><h2 id="appsheet-member-title">Añadir socio</h2><p>Guardá los datos básicos del socio y volvés a esta factura.</p></div><button type="button" className="ops-icon-button" aria-label="Cerrar alta de socio" onClick={cancelMemberCreate} disabled={newMemberSaving || newMemberUncertain}>×</button></header>
          <fieldset className="appsheet-child-fields" disabled={newMemberSaving || newMemberUncertain}>
            <label className="ops-field appsheet-field"><span>Nombre completo</span><input name="newMember-name" data-testid="newMember-name" value={newMemberDraft.name} onChange={event => setNewMemberDraft(current => ({ ...current, name: event.target.value }))} maxLength={200} autoComplete="name" required /></label>
            <label className="ops-field appsheet-field"><span>Correo electrónico</span><input name="newMember-email" data-testid="newMember-email" type="email" value={newMemberDraft.email} onChange={event => setNewMemberDraft(current => ({ ...current, email: event.target.value }))} maxLength={254} autoComplete="email" /></label>
            <label className="ops-field appsheet-field"><span>Teléfono</span><input name="newMember-phone" data-testid="newMember-phone" type="tel" value={newMemberDraft.phone} onChange={event => setNewMemberDraft(current => ({ ...current, phone: event.target.value }))} maxLength={80} autoComplete="tel" /></label>
            <label className="ops-field appsheet-field"><span>Domicilio</span><textarea name="newMember-address" data-testid="newMember-address" value={newMemberDraft.address} onChange={event => setNewMemberDraft(current => ({ ...current, address: event.target.value }))} maxLength={500} autoComplete="street-address" rows={2} /></label>
          </fieldset>
          {newMemberSaving && <p role="status">{newMemberUncertain ? "Recuperando el mismo registro…" : "Guardando y comprobando al socio…"}</p>}
          {newMemberError && <p className={newMemberUncertain ? "appsheet-pending" : "ops-inline-error"} role="alert">{newMemberError}</p>}
          <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={cancelMemberCreate} disabled={newMemberSaving || newMemberUncertain}>Cancelar</button><button type="submit" className="ops-button ops-button-primary" data-testid={newMemberUncertain ? "appsheet-retry-member" : "appsheet-save-member"} disabled={newMemberSaving || (!newMemberUncertain && !newMemberDraft.name.trim())}>{newMemberSaving ? "Guardando…" : newMemberUncertain ? "Reintentar alta" : "Guardar y volver a la factura"}</button></footer>
        </form>
      </dialog>}

      {stage === "product" && productDraft && <dialog className="ops-dialog appsheet-child-dialog" ref={productDialog} data-testid="appsheet-product-dialog" aria-labelledby="appsheet-product-title" onCancel={event => { event.preventDefault(); cancelProduct(); }}>
        <form className="ops-dialog-card appsheet-child-card" onSubmit={saveProduct}>
          <header className="ops-dialog-head"><div><span className="ops-kicker">Detalle de factura</span><h2 id="appsheet-product-title">Agregar producto</h2></div><button type="button" className="ops-icon-button" aria-label="Cerrar producto" onClick={cancelProduct} disabled={busy || uncertain}>×</button></header>
          <fieldset className="appsheet-child-fields" disabled={busy || uncertain}>
            <label className="ops-field appsheet-field"><span>Id_Detalle</span><input name="line-id" data-testid="line-id" value={productDraft.id} onChange={event => updateProductField("id", event.target.value)} maxLength={100} required /></label>
            <label className="ops-field appsheet-field"><span>ID. Factura</span><input aria-label="ID. Factura" value={draft.invoiceNumber || "Se asigna al guardar"} readOnly /></label>
            <label className="ops-field appsheet-field"><span>Fecha</span><input name="line-date" data-testid="line-date" aria-label="Fecha del producto" type="date" value={productDraft.date} onChange={event => updateProductField("date", event.target.value)} required /></label>
            <label className="ops-field appsheet-field"><span>Variedad</span><select name="line-skuId" data-testid="line-skuId" aria-label="Variedad" value={productDraft.skuId} onChange={event => updateProductField("skuId", event.target.value)} required><option value="">Elegí variedad</option>{productDraft.skuId && !saleProducts.some(item => String(item.id) === productDraft.skuId) && <option value={productDraft.skuId}>{stringValue(catalog.find(item => String(item.id) === productDraft.skuId)?.name, productDraft.skuId)} · {retainedProductIsHistorical ? "guardada en la preventa" : "no disponible; borrador conservado"}</option>}{saleProducts.map(item => <option key={String(item.id)} value={String(item.id)}>{stringValue(item.name, stringValue(item.code, String(item.id)))}</option>)}</select>{catalogLoading && <small role="status">Cargando variedades…</small>}{catalogError && <small className="appsheet-subtle-error">No se pudo cargar catálogo. <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={retryCatalog}>Reintentar</button></small>}{!catalogLoading && !catalogError && !saleProducts.length && <small>No hay variedades activas disponibles para factura.</small>}{hasMoreCatalog && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={loadMoreCatalog} disabled={catalogLoading}>Cargar más variedades</button>}</label>
            {activeReplacement && selectedProduct?.requiresAppSheetSourceLot === true && <label className="ops-field appsheet-field"><span>Lote de origen</span><select name="line-sourceLotId" data-testid="line-sourceLotId" aria-label="Lote de origen" value={productDraft.sourceLotId} onChange={event => updateProductField("sourceLotId", event.target.value)} required={mode !== "preorder" && mode !== "edit-preorder"}><option value="">{mode === "preorder" || mode === "edit-preorder" ? "Resolver al confirmar" : "Elegí un lote disponible"}</option>{productDraft.sourceLotId && !selectedSourceLots.some(option => stringValue(option.sourceLotId) === productDraft.sourceLotId) && <option value={productDraft.sourceLotId}>{productDraft.sourceLotId} · no disponible; elegí otro</option>}{selectedSourceLots.map(option => <option key={stringValue(option.sourceLotId)} value={stringValue(option.sourceLotId)}>{stringValue(option.receivedDate)} · {stringValue(option.availableQuantity)} g disponibles · {stringValue(option.sourceLotId).slice(0, 18)}</option>)}</select><small>{mode === "preorder" || mode === "edit-preorder" ? "La preventa puede guardarse sin lote. Elegilo antes de confirmar; su disponibilidad se verificará de nuevo." : "La confirmación reserva únicamente el lote elegido y vuelve a comprobar su disponibilidad."}</small></label>}
            <label className="ops-field appsheet-field"><span>Escala_Tarifaria</span><select name="line-scale" data-testid="line-scale" aria-label="Escala tarifaria" value={productDraft.scale} onChange={event => updateProductField("scale", event.target.value)}><option value="">Elegí una escala</option>{productDraft.scale && !observedScales.includes(productDraft.scale) && <option value={productDraft.scale}>{productDraft.scale}</option>}{observedScales.map(scale => <option key={scale} value={scale}>{scale}</option>)}</select><small>Se conserva la escala elegida; el precio sugerido sólo se propone cuando coincide exactamente el campo del catálogo y la moneda.</small></label>
            <label className="ops-field appsheet-field"><span>Gramos pedidos</span><input name="line-quantity" data-testid="line-quantity" aria-label="Gramos pedidos" type={replacementProfile ? "number" : "text"} inputMode="decimal" {...(replacementProfile ? { min: 1, max: 99, step: "any", "aria-describedby": "appsheet-quantity-guidance" } : {})} onInvalid={() => { if (replacementProfile) setError("Ingresá entre 1 y 99 gramos, con hasta tres decimales."); }} value={productDraft.quantity} onChange={event => updateProductField("quantity", event.target.value)} required placeholder="Ej.: 3,5" />{replacementProfile && <small id="appsheet-quantity-guidance">1–99 gramos, hasta tres decimales.</small>}</label>
            <label className="ops-field appsheet-field"><span>Valor total</span><input name="line-total" data-testid="line-total" aria-label="Valor total" inputMode="decimal" value={productDraft.total} onChange={event => updateProductField("total", event.target.value)} required placeholder="Importe editable" /><small>El total editable se propone si el cálculo es exacto y se actualiza hasta que ingreses un valor.</small></label>
            {mode === "invoice" && <details className="appsheet-field appsheet-optional-price" data-testid="appsheet-line-price-details">
              <summary>Precio por gramo · opcional</summary>
              <label className="ops-field appsheet-field"><span>Precio por gramo</span><input name="line-pricePerGram" data-testid="line-price-per-gram" aria-label="Precio por gramo" inputMode="decimal" value={productDraft.pricePerGram} onChange={event => updateProductField("pricePerGram", event.target.value)} placeholder="Sin dato" /></label>
              <small>Precio editable e independiente del total. En una línea nueva, la propuesta sigue los cambios de variedad y escala hasta que ingreses un precio.</small>
            </details>}
            <label className="ops-field appsheet-field"><span>N_Factura_Virtual</span><input aria-label="N_Factura_Virtual" value="Se asigna al guardar" disabled /></label>
          </fieldset>
          {error && <p className="ops-inline-error" role="alert">{error}</p>}
          <footer className="ops-dialog-actions"><button type="button" className="ops-button ops-button-quiet" onClick={cancelProduct} disabled={busy || uncertain}>Cancelar</button><button type="submit" className="ops-button ops-button-primary" disabled={busy || uncertain}>{productIndex === null ? "Añadir producto" : "Guardar cambios"}</button></footer>
        </form>
      </dialog>}

      {stage === "moto" && motoDraft && <dialog className="ops-dialog appsheet-child-dialog" ref={motoDialog} data-testid="appsheet-moto-dialog" aria-labelledby="appsheet-moto-title" onCancel={event => { event.preventDefault(); cancelMoto(); }}>
        <form className="ops-dialog-card appsheet-child-card" onSubmit={saveMoto}>
          <header className="ops-dialog-head"><div><span className="ops-kicker">Envío de factura</span><h2 id="appsheet-moto-title">Cargar viaje en moto</h2></div><button type="button" className="ops-icon-button" aria-label="Cerrar viaje" onClick={cancelMoto} disabled={busy || uncertain}>×</button></header>
          <fieldset className="appsheet-child-fields" disabled={busy || uncertain}>
            <label className="ops-field appsheet-field"><span>Envio moto</span><input aria-label="Envio moto" value="Se asigna al guardar" readOnly /></label>
            <label className="ops-field appsheet-field"><span>Fecha_Entrega</span><input name="moto-deliveryDate" data-testid="moto-deliveryDate" aria-label="Fecha de entrega" type="date" value={motoDraft.deliveryDate} onChange={event => setMotoDraft(current => current ? { ...current, deliveryDate: event.target.value } : current)} required /></label>
            <label className="ops-field appsheet-field"><span>Forma de pago moto</span><select name="moto-paymentMethod" data-testid="moto-paymentMethod" aria-label="Forma de pago moto" value={motoDraft.paymentMethod} onChange={event => setMotoDraft(current => current ? { ...current, paymentMethod: event.target.value as Payment } : current)}>{paymentOptions(motoDraft.paymentMethod === "card").map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
            <label className="ops-field appsheet-field"><span>Transferencia moto</span><input name="moto-transfer" data-testid="moto-transfer" aria-label="Transferencia moto" value={motoEditorPreview ? formatMinor(motoEditorPreview.transferMinor.toString(), draft.currency) : "Pendiente de definición"} disabled />{replacementProfile && <small>5% de Tarifa Cliente para Transferencia o Mercado Pago; cero para efectivo.</small>}</label>
            <label className="ops-field appsheet-field"><span>Tipo de Servicio</span><select name="moto-serviceType" data-testid="moto-serviceType" aria-label="Tipo de servicio" value={motoDraft.serviceType} onChange={event => setMotoDraft(current => current ? { ...current, serviceType: event.target.value } : current)} required><option value="">Elegí un servicio</option>{motoDraft.serviceType && !observedServiceTypes.includes(motoDraft.serviceType) && <option value={motoDraft.serviceType}>{motoDraft.serviceType}</option>}{observedServiceTypes.map(serviceType => <option key={serviceType} value={serviceType}>{serviceType}</option>)}</select></label>
            <label className="ops-field appsheet-field"><span>Destino</span><input name="moto-destination" data-testid="moto-destination" aria-label="Destino" value={motoDraft.destination} onChange={event => setMotoDraft(current => current ? { ...current, destination: event.target.value } : current)} maxLength={1000} required /></label>
            <label className="ops-field appsheet-field"><span>Tarifa Cliente</span><input name="moto-clientTariff" data-testid="moto-clientTariff" aria-label="Tarifa Cliente" inputMode="decimal" value={motoDraft.clientTariff} onChange={event => setMotoDraft(current => current ? { ...current, clientTariff: event.target.value } : current)} required /><small>{replacementProfile
              ? `Base del recargo de moto y del subtotal cliente en ${draft.currency}; Tarifa Administración se conserva aparte.`
              : `Importe editable en ${draft.currency}; se conserva junto a los productos como referencia. Los importes derivados de la moto siguen pendientes de definición.`}</small></label>
            <label className="ops-field appsheet-field"><span>Subtotal cliente</span><input name="moto-subtotal" data-testid="moto-subtotal" aria-label="Subtotal cliente" value={motoEditorPreview ? formatMinor(motoEditorPreview.subtotalMinor.toString(), draft.currency) : "Pendiente de definición"} disabled /></label>
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
