import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { DeliveryAssignmentV1, DeliveryManifestV1, QueueRecordView, QueueStatus } from "./offline/contracts";
import { amountToMinorUnits, createOfflineDeliveryClient, formatMinorUnits, type OfflineDeliveryClient, type SyncSummary } from "./offline/client";
import { isDecimalString } from "./offline/contracts";
import { registerDeliveryPwa } from "./offline/pwa";
import "./delivery-shift.css";

/** Props let the authenticated app mount reparto without ClubProvider or legacy views. */
export interface DeliveryShiftProps {
  client?: OfflineDeliveryClient;
  /** Use a server-issued manifest. It is shown only after the local device is unlocked. */
  manifest?: DeliveryManifestV1;
  /** Main owns session and device selection; this callback must fetch a fresh authenticated manifest. */
  onRefreshManifest?: () => Promise<DeliveryManifestV1>;
  onLogout?: () => Promise<void>;
  className?: string;
}

const STATUS_LABEL: Record<QueueStatus, string> = {
  pending: "Pendiente", accepted: "Sincronizado", duplicate: "Repetido", conflict: "Conflicto",
  rejected: "Rechazado", blocked: "En espera", quarantined: "Revisión requerida",
};

export default function DeliveryShift({ client: suppliedClient, manifest, onRefreshManifest, onLogout, className }: DeliveryShiftProps) {
  const client = useMemo(() => suppliedClient ?? createOfflineDeliveryClient(), [suppliedClient]);
  const [localReady, setLocalReady] = useState(false);
  const [hasLocalProfile, setHasLocalProfile] = useState(false);
  const [unlocked, setUnlocked] = useState(client.isUnlocked);
  const [activeManifest, setActiveManifest] = useState<DeliveryManifestV1 | undefined>(client.currentManifest);
  const [passphrase, setPassphrase] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [queue, setQueue] = useState<QueueRecordView[]>([]);
  const [counts, setCounts] = useState<Record<QueueStatus, number>>({ pending: 0, accepted: 0, duplicate: 0, conflict: 0, rejected: 0, blocked: 0, quarantined: 0 });
  const [online, setOnline] = useState(typeof navigator === "undefined" || navigator.onLine);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const busyRef = useRef(false);
  const actionErrorRef = useRef<HTMLDivElement>(null);
  const reconnectPending = useRef(false);

  useEffect(() => {
    if (actionError) actionErrorRef.current?.focus();
  }, [actionError]);

  const refreshLocalState = useCallback(async () => {
    setUnlocked(client.isUnlocked);
    if (!client.isUnlocked) return;
    setActiveManifest(await client.getSavedManifest());
    setQueue(await client.listQueue());
    setCounts(await client.queueCounts());
  }, [client]);

  useEffect(() => {
    let active = true;
    void registerDeliveryPwa().catch(() => {
      if (active) setActionError("El turno funciona aquí, pero este navegador no pudo preparar el acceso instalable.");
    });
    void (async () => {
      try {
        const present = await client.hasLocalProfile(manifest);
        if (!active) return;
        setHasLocalProfile(present);
        if (client.isUnlocked) {
          setActiveManifest(await client.getSavedManifest());
          setQueue(await client.listQueue());
          setCounts(await client.queueCounts());
          setUnlocked(true);
        }
      } catch (error) {
        if (active) setActionError(error instanceof Error ? error.message : "No se pudo abrir el turno guardado.");
      } finally {
        if (active) setLocalReady(true);
      }
    })();
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      active = false;
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [client, manifest]);

  useEffect(() => {
    if (!online) {
      reconnectPending.current = true;
      return;
    }
    if (!reconnectPending.current || !unlocked || !activeManifest) return;
    if (counts.pending === 0) {
      reconnectPending.current = false;
      return;
    }
    if (busyRef.current) return;

    reconnectPending.current = false;
    busyRef.current = true;
    setBusy(true);
    setPendingAction("Reconectando, guardando copia cifrada y sincronizando eventos pendientes…");
    setNotice("");
    setActionError("");
    void (async () => {
      try {
        if (!navigator.locks?.request) {
          throw new Error("Este navegador no ofrece bloqueo seguro entre pestañas; no se inició la sincronización automática.");
        }
        const cycleLock = `bombo-offline-online-cycle:${activeManifest.userId}:${activeManifest.deviceId}`;
        await navigator.locks.request(cycleLock, { mode: "exclusive" }, async () => {
          const currentCounts = await client.queueCounts();
          if (!currentCounts.pending) {
            await refreshLocalState();
            return;
          }
          // A durable encrypted snapshot protects the queued work before sending it.
          // Its network wait is outside the writer lock so another tab can capture;
          // the ACK write and the following sync each take the shared writer lock.
          await client.uploadEncryptedBackup();
          const summary = await client.syncNow();
          await refreshLocalState();
          await client.uploadEncryptedBackup();
          setNotice(`Ciclo al reconectar completo: copia cifrada durable y ${summary.accepted} aceptados, ${summary.duplicates} repetidos, ${summary.conflicts} conflictos, ${summary.quarantined} en revisión, ${summary.pending} pendientes.`);
        });
      } catch (error) {
        setActionError(error instanceof Error ? error.message : "No se pudo completar el ciclo de reconexión.");
      } finally {
        busyRef.current = false;
        setBusy(false);
        setPendingAction("");
      }
    })();
  }, [activeManifest, busy, client, counts.pending, online, refreshLocalState, unlocked]);

  async function runBusy(action: () => Promise<void>, pending = "Procesando la acción…") {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setPendingAction(pending);
    setNotice("");
    setActionError("");
    try { await action(); }
    catch (error) { setActionError(error instanceof Error ? error.message : "No se pudo completar la acción."); }
    finally {
      busyRef.current = false;
      setBusy(false);
      setPendingAction("");
    }
  }

  function clearFeedbackForValidation() {
    setNotice("");
    setActionError("");
  }

  async function refreshManifest() {
    if (!onRefreshManifest) throw new Error("La app principal todavía no conectó la obtención del manifiesto.");
    const fresh = await onRefreshManifest();
    const hasStoredProfile = await client.hasLocalProfile(fresh);
    if (client.isUnlocked || hasStoredProfile) {
      await client.acceptFreshOnlineManifest(fresh);
      if (client.isUnlocked) await refreshLocalState();
    }
    setHasLocalProfile(hasStoredProfile);
    setActiveManifest(client.isUnlocked ? fresh : undefined);
    if (!client.isUnlocked) setNotice("Turno obtenido. Prepará o desbloqueá el dispositivo para ver las entregas.");
  }

  async function activateOrUnlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runBusy(async () => {
      let storagePersisted: boolean;
      let refreshUnavailable = false;
      if (hasLocalProfile) {
        storagePersisted = await client.unlock(passphrase);
        if (online && onRefreshManifest) {
          try {
            const fresh = await onRefreshManifest();
            await client.acceptFreshOnlineManifest(fresh);
          } catch (error) {
            if (error instanceof TypeError) refreshUnavailable = true;
            else throw error;
          }
        }
      } else {
        const fresh = manifest ?? (onRefreshManifest ? await onRefreshManifest() : undefined);
        if (!fresh) throw new Error("Conectate y pedí a la app principal un manifiesto antes de preparar este dispositivo.");
        storagePersisted = (await client.activateFromOnlineManifest(fresh, passphrase)).storagePersisted;
      }
      setPassphrase("");
      setHasLocalProfile(true);
      await refreshLocalState();
      setNotice(refreshUnavailable
        ? "No se pudo contactar al servidor; se abrió el manifiesto cifrado guardado, válido hasta su vencimiento. La cola cifrada existente se conserva."
        : storagePersisted
        ? "Dispositivo listo. Las capturas se cifran antes de confirmarse en la cola."
        : "El turno quedó preparado, pero el navegador no confirmó almacenamiento persistente. Se conserva la cola cifrada y se bloquean nuevas capturas hasta verificar este dispositivo.");
    }, "Preparando o desbloqueando el dispositivo…");
  }

  async function recordDelivery(event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await runBusy(async () => {
      const lines = assignment.lines.map((line) => {
        const quantity = String(values.get(`quantity:${line.id}`) ?? "").trim();
        const actualQuantity = String(values.get(`actual:${line.id}`) ?? "").trim();
        if (!isDecimalString(quantity)) throw new Error("Indicá la cantidad entregada con decimal exacto para cada artículo.");
        if (actualQuantity && !isDecimalString(actualQuantity)) throw new Error("El peso real debe ser un decimal exacto.");
        return { lineId: line.id, quantity, ...(actualQuantity ? { actualQuantity } : {}) };
      });
      const note = String(values.get("evidence") ?? "").trim();
      if (!note) throw new Error("Describí la constancia de entrega.");
      await client.captureCommand(assignment, "DeliveryRecorded", { lines, evidence: { note } });
      await refreshLocalState();
      setNotice("Entrega guardada en la cola cifrada; queda pendiente de sincronización.");
    }, "Guardando la entrega cifrada…");
  }

  async function reportIncident(event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await runBusy(async () => {
      const note = String(values.get("note") ?? "").trim();
      if (!note) throw new Error("Describí brevemente el incidente.");
      await client.captureCommand(assignment, "DeliveryIncident", {
        kind: String(values.get("kind") ?? "other"), note, evidence: { note },
      });
      await refreshLocalState();
      setNotice("Incidente guardado en la cola cifrada.");
    }, "Guardando el incidente cifrado…");
  }

  async function reportCollection(event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await runBusy(async () => {
      const note = String(values.get("evidence") ?? "").trim();
      if (!note) throw new Error("Describí el comprobante recibido.");
      const method = String(values.get("method") ?? "cash") as "cash" | "transfer" | "mercado_pago" | "card";
      const data = {
        orderId: assignment.orderId,
        deliveryId: assignment.id,
        method,
        currency: String(values.get("currency") ?? assignment.currency) as "ARS" | "USD",
        amountMinor: amountToMinorUnits(String(values.get("amount") ?? "")),
        ...(method === "cash" ? { custodianId: activeManifest?.userId } : {}),
        evidence: { note },
      };
      await client.captureCommand(assignment, "CollectionReported", data);
      await refreshLocalState();
      setNotice("Cobro declarado; informar no lo acredita ni mueve saldos. Queda pendiente de revisión.");
    }, "Guardando el reporte de cobro cifrado…");
  }

  async function sync() {
    await runBusy(async () => {
      const summary: SyncSummary = await client.syncNow();
      await refreshLocalState();
      setNotice(`Sincronización: ${summary.accepted} aceptados, ${summary.duplicates} repetidos, ${summary.conflicts} conflictos, ${summary.quarantined} en revisión, ${summary.pending} pendientes.`);
    }, "Sincronizando eventos pendientes…");
  }

  async function downloadBackup() {
    await runBusy(async () => {
      const created = await client.createEncryptedBackup();
      const blob = new Blob([JSON.stringify(created.package)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `bombo-turno-${created.sha256.slice(0, 12)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice(`Copia cifrada descargada. SHA-256: ${created.sha256}`);
    }, "Creando la copia cifrada…");
  }

  async function restoreBackup(event: FormEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    await runBusy(async () => {
      const parsed: unknown = JSON.parse(await file.text());
      await client.restoreEncryptedBackup(parsed as Parameters<OfflineDeliveryClient["restoreEncryptedBackup"]>[0], restorePassphrase);
      await refreshLocalState();
      setRestorePassphrase("");
      setNotice("Copia cifrada validada y restaurada en este dispositivo.");
    }, "Validando y restaurando la copia cifrada…");
  }

  async function openDocument(documentId: string) {
    await runBusy(async () => {
      const blob = await client.readDocument(documentId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }, "Abriendo el documento del turno…");
  }

  async function lock() {
    await runBusy(async () => {
      client.forgetMemory();
      setUnlocked(false);
      setActiveManifest(undefined);
      setQueue([]);
      setNotice("Turno bloqueado. La cola cifrada se conserva en el dispositivo.");
    }, "Bloqueando el turno…");
  }

  async function logout() {
    await runBusy(async () => {
      await client.logoutAndForgetDocuments();
      setUnlocked(false);
      setActiveManifest(undefined);
      setQueue([]);
      try {
        await onLogout?.();
      } catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        setActionError(`Documentos locales borrados; la cola cifrada se conserva. No se confirmó el cierre remoto.${detail}`);
        return;
      }
      setNotice("Sesión cerrada y documentos locales borrados. La cola cifrada se conserva.");
    }, "Cerrando la sesión local…");
  }

  const shownManifest = unlocked ? (activeManifest ?? client.currentManifest) : undefined;
  const queueTotal = Object.values(counts).reduce((sum, count) => sum + count, 0);

  return <main className={`delivery-shift${className ? ` ${className}` : ""}`} data-offline-startup="independent">
    <header className="delivery-shift__header">
      <img src="/brand/bombo-symbol.png" alt="Bombo" width="42" height="42" />
      <div><p>REPARTO · BOMBO</p><h1>Tu turno, a mano</h1></div>
      <span className={`delivery-shift__connection${online ? " is-online" : ""}`}>{online ? "En línea" : "Sin conexión"}</span>
    </header>

    {!localReady ? <section className="delivery-shift__panel"><p>Preparando el turno en este dispositivo…</p></section> : !unlocked ? <section className="delivery-shift__panel">
      <p className="delivery-shift__eyebrow">Acceso independiente</p>
      <h2>{hasLocalProfile ? "Desbloqueá tu turno" : "Prepará tu turno"}</h2>
      <p>{hasLocalProfile ? "La cola pendiente permanece cifrada en este dispositivo." : "Obtené un manifiesto vigente y creá una frase de acceso que solo vos conozcas."}</p>
      <form className="delivery-shift__unlock" onSubmit={(event) => void activateOrUnlock(event)}>
        <label>Frase de acceso <input type="password" autoComplete="current-password" minLength={15} value={passphrase} onChange={(event) => setPassphrase(event.target.value)} required /></label>
        <button type="submit" disabled={busy || passphrase.length < 15 || (!online && !hasLocalProfile)}>{busy ? "Preparando…" : hasLocalProfile ? "Desbloquear" : "Preparar dispositivo"}</button>
      </form>
      {onRefreshManifest && <button type="button" className="delivery-shift__secondary" onClick={() => void runBusy(refreshManifest, "Obteniendo el turno en línea…")} disabled={!online || busy}>Obtener turno en línea</button>}
      <p>La hora del teléfono y la conexión no autorizan operaciones; el servidor valida cada evento.</p>
    </section> : shownManifest ? <>
      <section className="delivery-shift__panel">
        <div className="delivery-shift__panel-heading"><div><p className="delivery-shift__eyebrow">{shownManifest.assignments.length} entregas asignadas</p><h2>El recorrido está listo</h2></div><span>{queueTotal} eventos en cola</span></div>
        <p>Las capturas se confirman solo después de guardarse cifradas. Al reconectar, el turno crea una copia cifrada durable, sincroniza y guarda otra copia.</p>
        <div className="delivery-shift__actions">
          <button type="button" onClick={() => void sync()} disabled={!online || busy || !counts.pending}>Sincronizar ahora</button>
          <button type="button" onClick={() => void downloadBackup()} disabled={busy}>Descargar copia cifrada</button>
          <label>Frase de la copia<input type="password" autoComplete="off" minLength={15} value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} /></label>
          <label className="delivery-shift__file">Restaurar copia<input type="file" accept="application/json,.json" onChange={(event) => void restoreBackup(event)} disabled={busy || restorePassphrase.length < 15} /></label>
          {onRefreshManifest && <button type="button" className="delivery-shift__secondary" onClick={() => void runBusy(refreshManifest, "Actualizando el turno…")} disabled={!online || busy}>Actualizar turno</button>}
          <button type="button" className="delivery-shift__secondary" onClick={() => void lock()} disabled={busy}>Bloquear</button>
          {(onLogout || unlocked) && <button type="button" className="delivery-shift__secondary" onClick={() => void logout()} disabled={busy}>Salir y borrar documentos</button>}
        </div>
        <div className="delivery-shift__counts" aria-label="Estado de la cola">
          {(Object.entries(counts) as Array<[QueueStatus, number]>).filter(([, count]) => count > 0).map(([status, count]) => <span key={status}>{STATUS_LABEL[status]}: {count}</span>)}
        </div>
      </section>
      {shownManifest.assignments.map((assignment) => <AssignmentCard key={assignment.id} assignment={assignment} busy={busy} snapshotNeedsRefresh={queue.some((item) => deliverySnapshotNeedsRefresh(item, assignment))} onDelivery={recordDelivery} onIncident={reportIncident} onCollection={reportCollection} onValidationFailure={clearFeedbackForValidation} onOpenDocument={openDocument} formatMinorUnits={formatMinorUnits} />)}
      {queue.length > 0 && <section className="delivery-shift__panel"><h2>Actividad del dispositivo</h2><ol className="delivery-shift__queue">{[...queue].reverse().map((item) => <li key={item.requestId}><span>{commandLabel(item.command.command)}</span><strong>{STATUS_LABEL[item.status]}</strong><small>{item.createdAt.slice(0, 16).replace("T", " ")}</small></li>)}</ol></section>}
    </> : <section className="delivery-shift__panel"><h2>Turno no disponible</h2><p>Conectate para actualizar el manifiesto o desbloqueá el dispositivo con conexión.</p>{onRefreshManifest && <button type="button" onClick={() => void runBusy(refreshManifest, "Actualizando el turno…")} disabled={!online || busy}>Actualizar turno</button>}</section>}
    {busy && <p className="delivery-shift__feedback delivery-shift__pending" role="status" aria-live="polite">{pendingAction}</p>}
    {actionError && <div ref={actionErrorRef} className="delivery-shift__feedback delivery-shift__error" role="alert" tabIndex={-1}><strong>La acción requiere atención.</strong><p>{actionError}</p></div>}
    {notice && <p className="delivery-shift__feedback delivery-shift__notice" role="status">{notice}</p>}
  </main>;
}

interface AssignmentCardProps {
  assignment: DeliveryAssignmentV1;
  busy: boolean;
  snapshotNeedsRefresh: boolean;
  onDelivery: (event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) => Promise<void>;
  onIncident: (event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) => Promise<void>;
  onCollection: (event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) => Promise<void>;
  onValidationFailure: () => void;
  onOpenDocument: (id: string) => Promise<void>;
  formatMinorUnits: typeof formatMinorUnits;
}

function AssignmentCard({ assignment, busy, snapshotNeedsRefresh, onDelivery, onIncident, onCollection, onValidationFailure, onOpenDocument, formatMinorUnits: formatAmount }: AssignmentCardProps) {
  const address = displayAddress(assignment.address);
  const formId = useId();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [focusField, setFocusField] = useState("");
  const fieldRefs = useRef(new Map<string, HTMLInputElement>());

  useEffect(() => {
    if (!focusField) return;
    fieldRefs.current.get(focusField)?.focus();
    setFocusField("");
  }, [fieldErrors, focusField]);

  function setFieldRef(field: string, input: HTMLInputElement | null) {
    if (input) fieldRefs.current.set(field, input);
    else fieldRefs.current.delete(field);
  }

  function clearFieldError(field: string) {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function submitDelivery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const errors: Record<string, string> = {};
    for (const line of assignment.lines) {
      const quantityField = "quantity:" + line.id;
      const actualField = "actual:" + line.id;
      const quantity = String(values.get(quantityField) ?? "").trim();
      const actualQuantity = String(values.get(actualField) ?? "").trim();
      if (!isDecimalString(quantity)) errors[quantityField] = "Indicá la cantidad entregada con un decimal exacto.";
      if (actualQuantity && !isDecimalString(actualQuantity)) errors[actualField] = "El peso real debe ser un decimal exacto.";
    }
    setFieldErrors(errors);
    const firstError = Object.keys(errors)[0];
    if (firstError) {
      onValidationFailure();
      setFocusField(firstError);
      return;
    }
    void onDelivery(event, assignment);
  }

  function submitCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const values = new FormData(event.currentTarget);
    const rawAmount = String(values.get("amount") ?? "");
    try {
      amountToMinorUnits(rawAmount);
      clearFieldError("amount");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ingresá un importe decimal válido.";
      setFieldErrors({ amount: message });
      onValidationFailure();
      setFocusField("amount");
      return;
    }
    void onCollection(event, assignment);
  }

  return <article className="delivery-shift__assignment">
    <header><div><p className="delivery-shift__eyebrow">{assignment.window || "Horario a coordinar"}</p><h2>{assignment.customerName}</h2><p>{address}</p>{assignment.route && <p className="delivery-shift__route"><span>Ruta · {formatRouteDate(assignment.route.date)}</span><span>Parada {assignment.route.stop}</span>{assignment.route.eta && assignment.route.etaIsEstimate && <span>ETA estimada · {assignment.route.eta}</span>}</p>}</div><span>{formatAmount(String(assignment.totalMinor), assignment.currency)}</span></header>
    {snapshotNeedsRefresh && <p className="delivery-shift__snapshot-warning" role="status">Hay una entrega de esta parada que puede no estar reflejada. El remanente corresponde al último manifiesto; sincronizá si está pendiente y después actualizá el turno.</p>}
    <ul className="delivery-shift__lines">{assignment.lines.map((line) => {
      const remaining = typeof line.remaining === "string" && isDecimalString(line.remaining) ? line.remaining : undefined;
      const unit = typeof line.unit === "string" && line.unit ? line.unit : "unidad no informada";
      return <li key={line.id}>
        <span>{line.name ?? line.productName ?? "Artículo"}<small className="delivery-shift__line-context">{formatManifestLineQuantities(line)}</small></span>
        <strong className={remaining ? "delivery-shift__remaining" : "delivery-shift__remaining delivery-shift__remaining--missing"}>{remaining ? `Remanente ${snapshotNeedsRefresh ? "del último manifiesto" : "según manifiesto"}: ${remaining} ${unit}` : "Remanente no informado en este manifiesto"}</strong>
      </li>;
    })}</ul>
    {assignment.documents.length > 0 && <details><summary>Documentos del turno ({assignment.documents.length})</summary><ul>{assignment.documents.map((doc) => <li key={doc.id}><button type="button" className="delivery-shift__link" onClick={() => void onOpenDocument(doc.id)}>{doc.name ?? "Abrir documento"}</button></li>)}</ul></details>}
    <details><summary>Registrar entrega</summary><form onSubmit={submitDelivery} aria-busy={busy}>
      {assignment.lines.map((line, index) => {
        const quantityField = "quantity:" + line.id;
        const actualField = "actual:" + line.id;
        const quantityError = fieldErrors[quantityField];
        const actualError = fieldErrors[actualField];
        const quantityId = formId + "-quantity-" + index;
        const actualId = formId + "-actual-" + index;
        return <fieldset key={line.id}><legend>{line.name ?? line.productName ?? "Artículo"}</legend>
          <label htmlFor={quantityId}>Cantidad entregada<input ref={(input) => setFieldRef(quantityField, input)} id={quantityId} name={quantityField} inputMode="decimal" placeholder="0" required disabled={busy} aria-invalid={quantityError ? "true" : undefined} aria-describedby={quantityError ? quantityId + "-error" : undefined} onChange={() => clearFieldError(quantityField)} />{quantityError && <small id={quantityId + "-error"} className="delivery-shift__field-error" role="alert">{quantityError}</small>}</label>
          <label htmlFor={actualId}>Peso real, si corresponde<input ref={(input) => setFieldRef(actualField, input)} id={actualId} name={actualField} inputMode="decimal" placeholder="Opcional" disabled={busy} aria-invalid={actualError ? "true" : undefined} aria-describedby={actualError ? actualId + "-error" : undefined} onChange={() => clearFieldError(actualField)} />{actualError && <small id={actualId + "-error"} className="delivery-shift__field-error" role="alert">{actualError}</small>}</label>
        </fieldset>;
      })}
      <label htmlFor={formId + "-delivery-evidence"}>Constancia / observación<input id={formId + "-delivery-evidence"} name="evidence" maxLength={500} required disabled={busy} /></label><button type="submit" disabled={busy}>Guardar entrega</button>
    </form></details>
    <details><summary>Informar un incidente</summary><form onSubmit={(event) => void onIncident(event, assignment)} aria-busy={busy}>
      <label htmlFor={formId + "-incident-kind"}>Tipo<select id={formId + "-incident-kind"} name="kind" disabled={busy}><option value="absent">No estaba</option><option value="late">Demora</option><option value="address">Dirección</option><option value="damaged">Daño</option><option value="other">Otro</option></select></label>
      <label htmlFor={formId + "-incident-note"}>Detalle<textarea id={formId + "-incident-note"} name="note" maxLength={2000} required disabled={busy} /></label>
      <button type="submit" disabled={busy}>Guardar incidente</button>
    </form></details>
    <details><summary>Informar un cobro</summary><form onSubmit={submitCollection} aria-busy={busy}>
      <div className="delivery-shift__form-row">
        <label htmlFor={formId + "-method"}>Medio<select id={formId + "-method"} name="method" disabled={busy}><option value="cash">Efectivo</option><option value="transfer">Transferencia</option><option value="mercado_pago">Mercado Pago</option><option value="card">Tarjeta</option></select></label>
        <label htmlFor={formId + "-currency"}>Moneda<select id={formId + "-currency"} name="currency" defaultValue={assignment.currency} disabled={busy}><option value="ARS">ARS</option><option value="USD">USD</option></select></label>
      </div>
      <label htmlFor={formId + "-amount"}>Importe<input ref={(input) => setFieldRef("amount", input)} id={formId + "-amount"} name="amount" inputMode="decimal" placeholder="0,00" required disabled={busy} aria-invalid={fieldErrors.amount ? "true" : undefined} aria-describedby={fieldErrors.amount ? formId + "-amount-error" : undefined} onChange={() => clearFieldError("amount")} />{fieldErrors.amount && <small id={formId + "-amount-error"} className="delivery-shift__field-error" role="alert">{fieldErrors.amount}</small>}</label>
      <label htmlFor={formId + "-collection-evidence"}>Comprobante / constancia<input id={formId + "-collection-evidence"} name="evidence" maxLength={500} required disabled={busy} /></label>
      <button type="submit" disabled={busy}>Informar cobro</button>
      <small>El reporte no acredita el cobro ni crea movimientos de saldo.</small>
    </form></details>
  </article>;
}

function displayAddress(address: string | Record<string, unknown>): string {
  if (typeof address === "string") return address;
  for (const key of ["label", "street", "address", "line1"]) if (typeof address[key] === "string") return address[key] as string;
  return "Dirección disponible en el manifiesto";
}

function commandLabel(value: string): string {
  if (value === "DeliveryRecorded") return "Entrega registrada";
  if (value === "DeliveryIncident") return "Incidente informado";
  if (value === "CollectionReported") return "Cobro informado";
  return "Evento del turno";
}

function deliverySnapshotNeedsRefresh(item: QueueRecordView, assignment: DeliveryAssignmentV1): boolean {
  if (item.targetId !== assignment.id || item.command.command !== "DeliveryRecorded") return false;
  if (item.status === "pending" || item.status === "quarantined" || item.status === "conflict") return true;
  if (item.status !== "accepted" && item.status !== "duplicate") return false;
  return !item.serverResult || item.serverResult.version > assignment.version;
}

function formatManifestLineQuantities(line: DeliveryAssignmentV1["lines"][number]): string {
  const quantities: string[] = [];
  const requested = line.requested ?? line.quantity;
  if (typeof requested === "string" && isDecimalString(requested)) quantities.push(`Pedido: ${requested}`);
  if (typeof line.prepared === "string" && isDecimalString(line.prepared)) quantities.push(`Preparado: ${line.prepared}`);
  if (typeof line.delivered === "string" && isDecimalString(line.delivered)) quantities.push(`Entregado: ${line.delivered}`);
  const unit = typeof line.unit === "string" && line.unit ? ` ${line.unit}` : " unidad no informada";
  return quantities.length ? quantities.map((quantity) => quantity + unit).join(" · ") : "Cantidades del manifiesto no informadas";
}

function formatRouteDate(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return value;
  const date = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return value;
  return new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }).format(date);
}
