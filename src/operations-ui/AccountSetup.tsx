import { useEffect, useRef, useState, type FormEvent } from "react";
import { hasCapability, hasCommand, isUncertainCommandOutcome, OperationsApiError } from "./api";
import { InfoBand } from "./Primitives";
import type { JsonRecord, OperationsContext, RunCommand } from "./types";

type AccountKind = "cash" | "bank" | "reserve";
type AccountDraft = {
  id: string;
  name: string;
  kind: AccountKind | "";
  holder: string;
  purpose: string;
};

const currencies = ["ARS", "ARS", "ARS", "USD", "USD", "USD"] as const;
const accountKinds: Array<{ value: AccountKind; label: string }> = [
  { value: "cash", label: "Caja" },
  { value: "bank", label: "Banco" },
  { value: "reserve", label: "Reserva" },
];

function newDrafts(): AccountDraft[] {
  return currencies.map(() => ({ id: crypto.randomUUID(), name: "", kind: "", holder: "", purpose: "" }));
}

function fieldKey(accountId: string, name: keyof Omit<AccountDraft, "id">) {
  return `${accountId}-${name}`;
}

export function AccountSetup({
  context,
  snapshot,
  loading,
  snapshotError,
  runCommand,
  onRefresh,
  onNotice,
}: {
  context: OperationsContext;
  snapshot: Record<string, unknown> | null;
  loading: boolean;
  snapshotError: string | null;
  runCommand: RunCommand;
  onRefresh: () => void;
  onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<AccountDraft[]>([]);
  const [targetId, setTargetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [terminalRejection, setTerminalRejection] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const formRef = useRef<HTMLFormElement>(null);
  const errorSummaryRef = useRef<HTMLParagraphElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const submitting = useRef(false);
  const attemptedData = useRef<JsonRecord | null>(null);

  const hasAccess = hasCapability(context, "accounts.write") && hasCommand(context, "AccountsInitialized");
  const accountBootstrapEligible = snapshot?.accountBootstrapEligible === true;
  const currentSnapshot = Boolean(snapshot) && !loading && !snapshotError;
  const canStart = hasAccess && currentSnapshot && accountBootstrapEligible && !terminalRejection;

  useEffect(() => {
    const name = pendingFocus.current;
    if (!name) return;
    pendingFocus.current = null;
    if (name === "summary") {
      errorSummaryRef.current?.focus();
      return;
    }
    const control = formRef.current?.elements.namedItem(name);
    if (control instanceof HTMLElement) control.focus();
    else errorSummaryRef.current?.focus();
  }, [focusRevision]);

  if (!hasAccess || (!canStart && !open)) return null;

  function start() {
    if (!canStart) return;
    setDrafts(newDrafts());
    setTargetId(crypto.randomUUID());
    attemptedData.current = null;
    setFieldErrors({});
    setError("");
    setUncertain(false);
    setOpen(true);
  }

  function close() {
    if (busy || uncertain) return;
    setOpen(false);
    setDrafts([]);
    setTargetId("");
    attemptedData.current = null;
    setFieldErrors({});
    setError("");
  }

  function updateDraft(index: number, key: keyof Omit<AccountDraft, "id">, value: string) {
    setDrafts(current => current.map((draft, currentIndex) => currentIndex === index ? { ...draft, [key]: value } : draft));
    const id = drafts[index]?.id;
    if (!id) return;
    const name = fieldKey(id, key);
    if (fieldErrors[name]) setFieldErrors(current => { const next = { ...current }; delete next[name]; return next; });
    if (!uncertain) setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || terminalRejection) return;
    const replayingUncertain = uncertain && attemptedData.current !== null;
    if (uncertain && !replayingUncertain) return;
    if (!replayingUncertain && (!currentSnapshot || !accountBootstrapEligible)) {
      pendingFocus.current = "summary";
      setFocusRevision(current => current + 1);
      setError("El servidor ya no confirma que la configuración inicial esté habilitada. Conservé tus datos; actualizá Cuentas antes de iniciar un nuevo envío.");
      return;
    }

    const invalid: Record<string, string> = {};
    for (const draft of drafts) {
      if (!draft.name.trim()) invalid[fieldKey(draft.id, "name")] = "Ingresá un nombre de cuenta.";
      if (!draft.holder.trim()) invalid[fieldKey(draft.id, "holder")] = "Ingresá el titular de la cuenta.";
      if (!draft.kind) invalid[fieldKey(draft.id, "kind")] = "Elegí el tipo de cuenta.";
      if (!draft.purpose.trim()) invalid[fieldKey(draft.id, "purpose")] = "Indicá para qué se usará esta cuenta.";
    }
    if (Object.keys(invalid).length) {
      setFieldErrors(invalid);
      pendingFocus.current = `account-setup-${Object.keys(invalid)[0]}`;
      setFocusRevision(current => current + 1);
      setError("Completá los datos de las seis cuentas para continuar.");
      return;
    }

    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const data = attemptedData.current ?? {
        accounts: drafts.map((draft, index) => ({
          id: draft.id,
          name: draft.name.trim(),
          kind: draft.kind,
          holder: draft.holder.trim(),
          purpose: draft.purpose.trim(),
          currency: currencies[index],
        })),
      };
      attemptedData.current = data;
      await runCommand("AccountsInitialized", targetId, 0, data, true);
      attemptedData.current = null;
      setOpen(false);
      setDrafts([]);
      setTargetId("");
      setFieldErrors({});
      setError("");
      setUncertain(false);
      onNotice("Se registraron seis cuentas. Sus titulares y saldos siguen pendientes de verificación y apertura conciliada.");
      onRefresh();
    } catch (cause) {
      const alreadyInitialized = cause instanceof OperationsApiError && cause.status === 409 && cause.code === "ACCOUNTS_ALREADY_INITIALIZED";
      const pendingConfirmation = !alreadyInitialized && (uncertain || isUncertainCommandOutcome(cause));
      setUncertain(pendingConfirmation);
      if (alreadyInitialized || !pendingConfirmation) attemptedData.current = null;
      if (alreadyInitialized) {
        setTerminalRejection(true);
        onRefresh();
      }
      pendingFocus.current = "summary";
      setFocusRevision(current => current + 1);
      setError(alreadyInitialized
        ? cause.message
        : pendingConfirmation
          ? "La confirmación quedó pendiente. Conservé las seis cuentas y la misma clave; reintentá para recuperar el comprobante."
          : cause instanceof Error ? cause.message : "No se pudo registrar la configuración. Revisá el error y conservé tus datos.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const controlsDisabled = busy || terminalRejection || (uncertain ? attemptedData.current === null : !currentSnapshot || !accountBootstrapEligible);

  return <section className="ops-sheet ops-account-setup">
    {!open && <div className="ops-sheet-head">
      <div><span className="ops-kicker">Configuración inicial</span><h3>Seis cuentas del club</h3></div>
      <button type="button" className="ops-button ops-button-primary" onClick={start} disabled={!canStart}>Configurar seis cuentas</button>
    </div>}
    {open && <>
      <div className="ops-sheet-head">
        <div><span className="ops-kicker">Configuración inicial</span><h3>Prepará las seis cuentas del club</h3></div>
        <button type="button" className="ops-button ops-button-quiet" onClick={close} disabled={busy || uncertain}>Cancelar</button>
      </div>
      <InfoBand title="El alta no verifica ni abre saldos">
        <p>Creá tres cuentas en ARS y tres en USD. Después verificá sus titulares y conciliá los saldos de apertura.</p>
      </InfoBand>
      {loading && <p className="ops-inline-status" role="status">Actualizando cuentas. Los envíos nuevos quedan pausados; una confirmación pendiente puede reintentarse con la misma clave.</p>}
      {snapshotError && <p className="ops-inline-error" role="alert">No se pudo actualizar la lista de cuentas. Los envíos nuevos quedan pausados; una confirmación pendiente puede reintentarse con la misma clave.</p>}
      {!uncertain && !loading && !snapshotError && !accountBootstrapEligible && <p className="ops-inline-status" role="status">El servidor dejó de habilitar la configuración inicial. Conservé los datos; revisá la lista de cuentas antes de iniciar un nuevo envío.</p>}
      {terminalRejection && <p className="ops-inline-status" role="status">El servidor informó que ya existen cuentas. Cancelá para volver a la lista actualizada.</p>}
      <form className="ops-form-grid" ref={formRef} noValidate aria-busy={busy} onSubmit={submit}>
        <div className="ops-repeat-fields">
          {drafts.map((draft, index) => {
            const currency = currencies[index];
            const nameId = `account-setup-${draft.id}-name`;
            const kindId = `account-setup-${draft.id}-kind`;
            const holderId = `account-setup-${draft.id}-holder`;
            const purposeId = `account-setup-${draft.id}-purpose`;
            const errorId = (key: keyof Omit<AccountDraft, "id">) => fieldErrors[fieldKey(draft.id, key)];
            return <fieldset className="ops-repeat-row" key={draft.id} disabled={busy || uncertain || terminalRejection}>
              <legend>Cuenta {index + 1} · {currency}</legend>
              <div className="ops-form-grid">
                <label className="ops-field" htmlFor={nameId}><span>Nombre</span>
                  <input id={nameId} name={nameId} value={draft.name} maxLength={150} required aria-invalid={Boolean(errorId("name")) || undefined} aria-describedby={errorId("name") ? `${nameId}-error` : undefined} onChange={event => updateDraft(index, "name", event.target.value)} />
                  {errorId("name") && <small id={`${nameId}-error`} className="ops-inline-error" role="alert">{errorId("name")}</small>}
                </label>
                <label className="ops-field" htmlFor={kindId}><span>Tipo</span>
                  <select id={kindId} name={kindId} value={draft.kind} required aria-invalid={Boolean(errorId("kind")) || undefined} aria-describedby={errorId("kind") ? `${kindId}-error` : undefined} onChange={event => updateDraft(index, "kind", event.target.value)}>
                    <option value="">Elegí un tipo</option>
                    {accountKinds.map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}
                  </select>
                  {errorId("kind") && <small id={`${kindId}-error`} className="ops-inline-error" role="alert">{errorId("kind")}</small>}
                </label>
                <label className="ops-field" htmlFor={holderId}><span>Titular</span>
                  <input id={holderId} name={holderId} value={draft.holder} maxLength={150} required aria-invalid={Boolean(errorId("holder")) || undefined} aria-describedby={errorId("holder") ? `${holderId}-error` : undefined} onChange={event => updateDraft(index, "holder", event.target.value)} />
                  {errorId("holder") && <small id={`${holderId}-error`} className="ops-inline-error" role="alert">{errorId("holder")}</small>}
                </label>
                <label className="ops-field" htmlFor={purposeId}><span>Uso de la cuenta</span>
                  <textarea id={purposeId} name={purposeId} value={draft.purpose} maxLength={500} required aria-invalid={Boolean(errorId("purpose")) || undefined} aria-describedby={errorId("purpose") ? `${purposeId}-error` : undefined} onChange={event => updateDraft(index, "purpose", event.target.value)} />
                  {errorId("purpose") && <small id={`${purposeId}-error`} className="ops-inline-error" role="alert">{errorId("purpose")}</small>}
                </label>
              </div>
            </fieldset>;
          })}
        </div>
        {error && <p ref={errorSummaryRef} className="ops-inline-error" role="alert" tabIndex={-1}>{error}</p>}
        {busy && <p className="sr-only" role="status">Enviando la inicialización. No cierres el formulario.</p>}
        {uncertain && <p className="ops-inline-status" role="status">La misma acción se reintentará con la misma clave para evitar duplicar cuentas.</p>}
        <div className="ops-dialog-actions">
          <button type="button" className="ops-button ops-button-quiet" onClick={close} disabled={busy || uncertain}>Cancelar</button>
          <button type="submit" className="ops-button ops-button-primary" disabled={controlsDisabled}>{busy ? "Registrando…" : uncertain ? "Reintentar confirmación" : "Crear seis cuentas"}</button>
        </div>
      </form>
    </>}
  </section>;
}
