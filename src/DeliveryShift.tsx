import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
  const [notice, setNotice] = useState("");
  const reconnectPending = useRef(false);

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
      if (active) setNotice("El turno funciona aquí, pero este navegador no pudo preparar el acceso instalable.");
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
        if (active) setNotice(error instanceof Error ? error.message : "No se pudo abrir el turno guardado.");
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
    if (busy) return;

    reconnectPending.current = false;
    setBusy(true);
    setNotice("");
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
        setNotice(error instanceof Error ? error.message : "No se pudo completar el ciclo de reconexión.");
      } finally {
        setBusy(false);
      }
    })();
  }, [activeManifest, busy, client, counts.pending, online, refreshLocalState, unlocked]);

  async function runBusy(action: () => Promise<void>) {
    setBusy(true);
    setNotice("");
    try { await action(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "No se pudo completar la acción."); }
    finally { setBusy(false); }
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
    });
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
    });
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
    });
  }

  async function reportCollection(event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await runBusy(async () => {
      const note = String(values.get("evidence") ?? "").trim();
      if (!note) throw new Error("Describí el comprobante recibido.");
      const method = String(values.get("method") ?? "cash") as "cash" | "transfer" | "card";
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
    });
  }

  async function sync() {
    await runBusy(async () => {
      const summary: SyncSummary = await client.syncNow();
      await refreshLocalState();
      setNotice(`Sincronización: ${summary.accepted} aceptados, ${summary.duplicates} repetidos, ${summary.conflicts} conflictos, ${summary.quarantined} en revisión, ${summary.pending} pendientes.`);
    });
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
    });
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
    });
  }

  async function openDocument(documentId: string) {
    await runBusy(async () => {
      const blob = await client.readDocument(documentId);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });
  }

  async function lock() {
    client.forgetMemory();
    setUnlocked(false);
    setActiveManifest(undefined);
    setQueue([]);
    setNotice("Turno bloqueado. La cola cifrada se conserva en el dispositivo.");
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
        setNotice(`Documentos locales borrados; la cola cifrada se conserva. No se confirmó el cierre remoto.${detail}`);
        return;
      }
      setNotice("Sesión cerrada y documentos locales borrados. La cola cifrada se conserva.");
    });
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
      {onRefreshManifest && <button type="button" className="delivery-shift__secondary" onClick={() => void runBusy(refreshManifest)} disabled={!online || busy}>Obtener turno en línea</button>}
      <p>La hora del teléfono y la conexión no autorizan operaciones; el servidor valida cada evento.</p>
    </section> : shownManifest ? <>
      <section className="delivery-shift__panel">
        <div className="delivery-shift__panel-heading"><div><p className="delivery-shift__eyebrow">{shownManifest.assignments.length} entregas asignadas</p><h2>El recorrido está listo</h2></div><span>{queueTotal} eventos en cola</span></div>
        <p>Las capturas se confirman solo después de guardarse cifradas. Al reconectar, el turno crea una copia cifrada durable, sincroniza y guarda otra copia.</p>
        <div className="delivery-shift__actions">
          <button type="button" onClick={() => void sync()} disabled={!online || busy || !counts.pending}>Sincronizar ahora</button>
          <button type="button" onClick={() => void runBusy(downloadBackup)} disabled={busy}>Descargar copia cifrada</button>
          <label>Frase de la copia<input type="password" autoComplete="off" minLength={15} value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} /></label>
          <label className="delivery-shift__file">Restaurar copia<input type="file" accept="application/json,.json" onChange={(event) => void restoreBackup(event)} disabled={busy || restorePassphrase.length < 15} /></label>
          {onRefreshManifest && <button type="button" className="delivery-shift__secondary" onClick={() => void runBusy(refreshManifest)} disabled={!online || busy}>Actualizar turno</button>}
          <button type="button" className="delivery-shift__secondary" onClick={() => void lock()} disabled={busy}>Bloquear</button>
          {(onLogout || unlocked) && <button type="button" className="delivery-shift__secondary" onClick={() => void logout()} disabled={busy}>Salir y borrar documentos</button>}
        </div>
        <div className="delivery-shift__counts" aria-label="Estado de la cola">
          {(Object.entries(counts) as Array<[QueueStatus, number]>).filter(([, count]) => count > 0).map(([status, count]) => <span key={status}>{STATUS_LABEL[status]}: {count}</span>)}
        </div>
      </section>
      {shownManifest.assignments.map((assignment) => <AssignmentCard key={assignment.id} assignment={assignment} busy={busy} onDelivery={recordDelivery} onIncident={reportIncident} onCollection={reportCollection} onOpenDocument={openDocument} formatMinorUnits={formatMinorUnits} />)}
      {queue.length > 0 && <section className="delivery-shift__panel"><h2>Actividad del dispositivo</h2><ol className="delivery-shift__queue">{[...queue].reverse().map((item) => <li key={item.requestId}><span>{commandLabel(item.command.command)}</span><strong>{STATUS_LABEL[item.status]}</strong><small>{item.createdAt.slice(0, 16).replace("T", " ")}</small></li>)}</ol></section>}
    </> : <section className="delivery-shift__panel"><h2>Turno no disponible</h2><p>Conectate para actualizar el manifiesto o desbloqueá el dispositivo con conexión.</p>{onRefreshManifest && <button type="button" onClick={() => void runBusy(refreshManifest)} disabled={!online || busy}>Actualizar turno</button>}</section>}
    {notice && <p className="delivery-shift__notice" role="status">{notice}</p>}
  </main>;
}

interface AssignmentCardProps {
  assignment: DeliveryAssignmentV1;
  busy: boolean;
  onDelivery: (event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) => Promise<void>;
  onIncident: (event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) => Promise<void>;
  onCollection: (event: FormEvent<HTMLFormElement>, assignment: DeliveryAssignmentV1) => Promise<void>;
  onOpenDocument: (id: string) => Promise<void>;
  formatMinorUnits: typeof formatMinorUnits;
}

function AssignmentCard({ assignment, busy, onDelivery, onIncident, onCollection, onOpenDocument, formatMinorUnits: formatAmount }: AssignmentCardProps) {
  const address = displayAddress(assignment.address);
  return <article className="delivery-shift__assignment">
    <header><div><p className="delivery-shift__eyebrow">{assignment.window || "Horario a coordinar"}</p><h2>{assignment.customerName}</h2><p>{address}</p></div><span>{formatAmount(String(assignment.totalMinor), assignment.currency)}</span></header>
    <ul className="delivery-shift__lines">{assignment.lines.map((line) => <li key={line.id}><span>{line.name ?? line.productName ?? "Artículo"}</span><small>{line.requested ?? line.quantity ?? "—"} {line.unit ?? ""}</small></li>)}</ul>
    {assignment.documents.length > 0 && <details><summary>Documentos del turno ({assignment.documents.length})</summary><ul>{assignment.documents.map((doc) => <li key={doc.id}><button type="button" className="delivery-shift__link" onClick={() => void onOpenDocument(doc.id)}>{doc.name ?? "Abrir documento"}</button></li>)}</ul></details>}
    <details><summary>Registrar entrega</summary><form onSubmit={(event) => void onDelivery(event, assignment)}>
      {assignment.lines.map((line) => <fieldset key={line.id}><legend>{line.name ?? line.productName ?? "Artículo"}</legend><label>Cantidad entregada<input name={`quantity:${line.id}`} inputMode="decimal" placeholder="0" required /></label><label>Peso real, si corresponde<input name={`actual:${line.id}`} inputMode="decimal" placeholder="Opcional" /></label></fieldset>)}
      <label>Constancia / observación<input name="evidence" maxLength={500} required /></label><button type="submit" disabled={busy}>Guardar entrega</button>
    </form></details>
    <details><summary>Informar un incidente</summary><form onSubmit={(event) => void onIncident(event, assignment)}><label>Tipo<select name="kind"><option value="absent">No estaba</option><option value="late">Demora</option><option value="address">Dirección</option><option value="damaged">Daño</option><option value="other">Otro</option></select></label><label>Detalle<textarea name="note" maxLength={2000} required /></label><button type="submit" disabled={busy}>Guardar incidente</button></form></details>
    <details><summary>Informar un cobro</summary><form onSubmit={(event) => void onCollection(event, assignment)}><div className="delivery-shift__form-row"><label>Medio<select name="method"><option value="cash">Efectivo</option><option value="transfer">Transferencia</option><option value="card">Tarjeta</option></select></label><label>Moneda<select name="currency" defaultValue={assignment.currency}><option value="ARS">ARS</option><option value="USD">USD</option></select></label></div><label>Importe<input name="amount" inputMode="decimal" placeholder="0,00" required /></label><label>Comprobante / constancia<input name="evidence" maxLength={500} required /></label><button type="submit" disabled={busy}>Informar cobro</button><small>El reporte no acredita el cobro ni crea movimientos de saldo.</small></form></details>
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
