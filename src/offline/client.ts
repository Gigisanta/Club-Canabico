import type { BackupAcknowledgementV1, CommandEnvelope, CommandResult, DeliveryAssignmentV1, DeliveryDocumentV1, DeliveryManifestV1, DriverCommandName, EncryptedBackupPackageV1, MinorUnitString, OfflineClientOptions, QueueRecordView, QueueRecoveryConfigV1, QueueRecoveryStatus, QueueStatus } from "./contracts";
import { assertExactCommandData, assertManifest, assertPassphrase, isMinorUnitString } from "./contracts";
import {
  aadFor,
  addQueueRecoveryWrap,
  canonicalJson,
  createQueueRecoverySession,
  createKeyring,
  decryptBytes,
  decryptJson,
  encodeBytes,
  encryptBytes,
  encryptJson,
  sha256Hex,
  stableUUID,
  unwrapRecoveredQueueKey,
  unlockKeyring,
  type CiphertextV1,
  type KeyringV1,
  type QueueRecoverySessionV1,
  type QueueRecoveryWrappedKeyV1,
  type UnlockedKeys,
} from "./crypto";
import {
  clearDocuments,
  commitQueuedCommand,
  commitRestoredData,
  deleteRecord,
  openOfflineDatabase,
  readAllQueueRecords,
  readDocuments,
  readQueue,
  readRecord,
  readRecordsWithPrefix,
  updateRecord,
  writeDocument,
  writeQueueRecord,
  writeRecord,
  writeRecords,
  type QueueCursor,
  type ObjectVersionCursor,
  type StoredDocumentRecord,
  type StoredQueueRecord,
} from "./storage";

const PROFILE_ID = "active-profile";
const DEFAULT_SYNC_ENDPOINT = "/api/delivery/sync";
const DEFAULT_BACKUP_ENDPOINT = "/api/delivery/backups";
const DEFAULT_READINESS_ENDPOINT_BASE = "/api/delivery/readiness/devices";
function withOfflineWriter<T>(profileKey: string, action: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks?.request) {
    return Promise.reject(new Error("Este navegador no ofrece bloqueo seguro entre pestañas; no se modificó el estado local del turno."));
  }
  return navigator.locks.request<Promise<T>>(`bombo-offline-writer:${profileKey}`, { mode: "exclusive" }, action)
    .then((result) => result);
}

async function explainBackupIntegrityFailure<T>(restore: () => Promise<T>): Promise<T> {
  try {
    return await restore();
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "OperationError") {
      throw new Error("La copia no superó la verificación de integridad. No se restauró nada.");
    }
    throw error;
  }
}
interface ActiveProfile { userId: string; deviceId: string; profileId: string }
interface UnlockControl { failedAttempts: number; requiresOnline: boolean }
interface LocalStorageCertificationV1 { persistent: boolean; requested: boolean; certifiedAt?: string }
interface EncryptedCommand { command: CommandEnvelope; serverResult?: CommandResult }
interface QueueBackupPayloadV1 {
  schemaVersion: 1;
  queue: StoredQueueRecord[];
  cursors: QueueCursor[];
  versions: ObjectVersionCursor[];
}
interface DocumentsBackupPayloadV1 {
  schemaVersion: 1;
  documents: StoredDocumentRecord[];
}

export interface SyncSummary {
  sent: number;
  accepted: number;
  duplicates: number;
  conflicts: number;
  rejected: number;
  blocked: number;
  quarantined: number;
  pending: number;
}

export interface RestoreSummary {
  restoredRequestIds: string[];
  quarantinedRequestIds: string[];
  restoredDocumentIds: string[];
  alreadyPresentRequestIds: string[];
  verified: true;
}

export interface CreatedBackup {
  package: EncryptedBackupPackageV1;
  sha256: string;
}

export interface PersistedBackupAcknowledgementV1 extends BackupAcknowledgementV1 {
  packageId: string;
  acknowledgedAt: string;
}

export interface RemoteBackupSummary {
  backupId: string;
  packageId: string;
  deviceId: string;
  sha256: string;
  createdAt: string;
}

export interface RemoteBackupPage {
  items: RemoteBackupSummary[];
  nextCursor: string | null;
}

export class OfflineLockoutError extends Error {
  constructor() { super("Se agotaron cinco intentos. Validá tu acceso con el servidor para volver a desbloquear este dispositivo."); }
}

export class InvalidPassphraseError extends Error {
  constructor() { super("La frase de acceso no coincide."); }
}

export class OfflineDeliveryClient {
  private profile?: ActiveProfile;
  private keyring?: KeyringV1;
  private keys?: UnlockedKeys;
  private manifest?: DeliveryManifestV1;
  private persistentStorageReady = false;
  private readonly fetcher: typeof fetch;
  private readonly syncEndpoint: string;
  private readonly backupEndpoint: string;
  private readonly readinessEndpointBase: string;
  private readonly recoveryConfigEndpoint: string;
  private readonly recoveryEndpointBase: string;
  private readonly injectedRecoveryPublicKeyPem?: string;

  constructor(options: OfflineClientOptions = {}) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.syncEndpoint = options.syncEndpoint ?? DEFAULT_SYNC_ENDPOINT;
    this.backupEndpoint = options.backupEndpoint ?? DEFAULT_BACKUP_ENDPOINT;
    this.readinessEndpointBase = options.readinessEndpointBase ?? DEFAULT_READINESS_ENDPOINT_BASE;
    this.recoveryConfigEndpoint = options.recoveryConfigEndpoint ?? "/api/delivery/recovery-config";
    this.recoveryEndpointBase = options.recoveryEndpointBase ?? "/api/delivery/recoveries";
    this.injectedRecoveryPublicKeyPem = options.recoveryPublicKeyPem;
  }

  get isUnlocked(): boolean { return Boolean(this.profile && this.keys); }
  get currentManifest(): DeliveryManifestV1 | undefined { return this.manifest; }
  get activeProfile(): Readonly<ActiveProfile> | undefined { return this.profile; }
  get queueRecoveryAvailable(): boolean { return Boolean(this.keyring?.queueRecoveryWrappedKey); }

  async hasLocalProfile(manifest?: Pick<DeliveryManifestV1, "userId" | "deviceId">): Promise<boolean> {
    const current = manifest
      ? await readRecord<KeyringV1>(this.keyringRecordId(profileId(manifest.userId, manifest.deviceId)))
      : await this.getActiveKeyring();
    return Boolean(current);
  }

  async currentLockout(): Promise<{ failedAttempts: number; requiresOnline: boolean }> {
    const profile = this.profile ?? await this.getActiveProfile();
    if (!profile) return { failedAttempts: 0, requiresOnline: false };
    return (await readRecord<UnlockControl>(this.controlRecordId(profile.profileId))) ?? { failedAttempts: 0, requiresOnline: false };
  }

  async getQueueRecoveryStatus(): Promise<QueueRecoveryStatus> {
    if (this.keyring?.queueRecoveryWrappedKey) return "available";
    const profile = this.profile ?? await this.getActiveProfile();
    if (profile) {
      const stored = await readRecord<KeyringV1>(this.keyringRecordId(profile.profileId));
      if (stored?.queueRecoveryWrappedKey) return "available";
    }
    return (await this.resolveRecoveryConfig(this.manifest)).status;
  }

  async createQueueRecoverySession(): Promise<QueueRecoverySessionV1> {
    return createQueueRecoverySession();
  }

  /** Receives the key wrapped to the recipient fixed in the approved recovery request. */
  async receiveRecoveredQueueKey(recoveryId: string, session: QueueRecoverySessionV1): Promise<CryptoKey> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recoveryId)) {
      throw new TypeError("El identificador de recuperación no es válido.");
    }
    const response = await this.fetcher(`${this.recoveryEndpointBase}/${encodeURIComponent(recoveryId)}/key`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    const payload = await readResponse(response);
    if (!response.ok) throw new Error(`La recuperación no está aprobada o disponible. ${messageOf(payload)}`);
    const result = payload as { algorithm?: unknown; wrappedQueueKey?: unknown; quarantineRequired?: unknown };
    if (result.algorithm !== "RSA-OAEP-256" || typeof result.wrappedQueueKey !== "string" || result.quarantineRequired !== true) {
      throw new Error("El servidor no devolvió una clave de cola válida para recuperación aprobada.");
    }
    return unwrapRecoveredQueueKey({ algorithm: "RSA-OAEP-256", ciphertext: result.wrappedQueueKey }, session.privateKey);
  }

  /** Call only with a manifest returned by a fresh authenticated server response. */
  async activateFromOnlineManifest(manifest: DeliveryManifestV1, passphrase: string): Promise<{ storagePersisted: boolean; queueRecoveryStatus: QueueRecoveryStatus }> {
    assertManifest(manifest);
    assertPassphrase(passphrase);
    const targetProfile = profileId(manifest.userId, manifest.deviceId);
    return this.withExclusiveWriter(targetProfile, () => this.activateFromOnlineManifestExclusively(manifest, passphrase));
  }

  private async activateFromOnlineManifestExclusively(manifest: DeliveryManifestV1, passphrase: string): Promise<{ storagePersisted: boolean; queueRecoveryStatus: QueueRecoveryStatus }> {
    assertManifest(manifest);
    assertPassphrase(passphrase);
    const recovery = await this.resolveRecoveryConfig(manifest);
    const recoveryPublicKeyPem = recovery.status === "available" ? recovery.publicKeyPem : undefined;
    const targetProfile = profileId(manifest.userId, manifest.deviceId);
    const keyringId = this.keyringRecordId(targetProfile);
    const existingKeyring = await readRecord<KeyringV1>(keyringId);
    const storageRequested = await requestPersistentStorage();
    const storagePersisted = storageRequested && await persistentStorageGranted();
    const storageCertification: LocalStorageCertificationV1 = {
      persistent: storagePersisted,
      requested: true,
      ...(storagePersisted ? { certifiedAt: new Date().toISOString() } : {}),
    };

    if (!existingKeyring) {
      const created = await createKeyring(manifest.userId, manifest.deviceId, passphrase, recoveryPublicKeyPem);
      const encryptedManifest = await encryptJson(manifest, created.keys.documents, aadFor(manifest.userId, manifest.deviceId, "manifest", manifest.leaseId));
      const active: ActiveProfile = { userId: manifest.userId, deviceId: manifest.deviceId, profileId: targetProfile };
      await writeRecords([
        { id: keyringId, value: created.keyring },
        { id: this.manifestRecordId(targetProfile), value: { leaseId: manifest.leaseId, encrypted: encryptedManifest } },
        { id: this.controlRecordId(targetProfile), value: { failedAttempts: 0, requiresOnline: false } satisfies UnlockControl },
        { id: PROFILE_ID, value: active },
        { id: this.storageCertificationRecordId(targetProfile), value: storageCertification },
      ]);
      this.profile = active;
      this.keyring = created.keyring;
      this.keys = created.keys;
      this.manifest = manifest;
      this.persistentStorageReady = storagePersisted;
      try { await this.ensureManifestDocuments(manifest); }
      catch (error) { this.forgetMemory(); throw error; }
      return { storagePersisted, queueRecoveryStatus: created.keyring.queueRecoveryWrappedKey ? "available" : recovery.status };
    }

    if (existingKeyring.userId !== manifest.userId || existingKeyring.deviceId !== manifest.deviceId) {
      throw new Error("La llave local pertenece a otra identidad de dispositivo.");
    }
    // A successful authenticated lease refresh is the only path that clears the
    // offline attempt limit. Local clock time and navigator.onLine grant nothing.
    await writeRecord(this.controlRecordId(targetProfile), { failedAttempts: 0, requiresOnline: false } satisfies UnlockControl);
    const keys = await this.unwrapWithFailureTracking(existingKeyring, targetProfile, passphrase);
    const nextKeyring = !existingKeyring.queueRecoveryWrappedKey && recoveryPublicKeyPem
      ? await addQueueRecoveryWrap(existingKeyring, passphrase, recoveryPublicKeyPem)
      : existingKeyring;
    const encryptedManifest = await encryptJson(manifest, keys.documents, aadFor(manifest.userId, manifest.deviceId, "manifest", manifest.leaseId));
    const active: ActiveProfile = { userId: manifest.userId, deviceId: manifest.deviceId, profileId: targetProfile };
    await writeRecords([
      ...(nextKeyring === existingKeyring ? [] : [{ id: keyringId, value: nextKeyring }]),
      { id: this.manifestRecordId(targetProfile), value: { leaseId: manifest.leaseId, encrypted: encryptedManifest } },
      { id: PROFILE_ID, value: active },
      { id: this.storageCertificationRecordId(targetProfile), value: storageCertification },
    ]);
    this.profile = active;
    this.keyring = nextKeyring;
    this.keys = keys;
    this.manifest = manifest;
    this.persistentStorageReady = storagePersisted;
    try { await this.ensureManifestDocuments(manifest); }
    catch (error) { this.forgetMemory(); throw error; }
    return { storagePersisted, queueRecoveryStatus: nextKeyring.queueRecoveryWrappedKey ? "available" : recovery.status };
  }

  async unlock(passphrase: string): Promise<boolean> {
    assertPassphrase(passphrase);
    const active = this.profile ?? await this.getActiveProfile();
    if (!active) throw new Error("Todavía no hay un dispositivo de entrega preparado.");
    return this.withExclusiveWriter(active.profileId, () => this.unlockExclusively(passphrase));
  }

  private async unlockExclusively(passphrase: string): Promise<boolean> {
    assertPassphrase(passphrase);
    const active = this.profile ?? await this.getActiveProfile();
    if (!active) throw new Error("Todavía no hay un dispositivo de entrega preparado.");
    const control = (await readRecord<UnlockControl>(this.controlRecordId(active.profileId))) ?? { failedAttempts: 0, requiresOnline: false };
    if (control.requiresOnline || control.failedAttempts >= 5) throw new OfflineLockoutError();
    const keyring = await readRecord<KeyringV1>(this.keyringRecordId(active.profileId));
    if (!keyring) throw new Error("No se encontró la llave cifrada de este dispositivo.");
    const keys = await this.unwrapWithFailureTracking(keyring, active.profileId, passphrase);
    this.profile = active;
    this.keyring = keyring;
    this.keys = keys;
    this.manifest = await this.readSavedManifest(active, keys);
    this.persistentStorageReady = await this.hasPersistentStorageCertification(active.profileId);
    try {
      if (this.manifest) await this.ensureManifestDocuments(this.manifest);
    } catch (error) {
      this.forgetMemory();
      throw error;
    }
    await writeRecord(this.controlRecordId(active.profileId), { failedAttempts: 0, requiresOnline: false } satisfies UnlockControl);
    return this.persistentStorageReady;
  }

  async acceptFreshOnlineManifest(manifest: DeliveryManifestV1): Promise<void> {
    assertManifest(manifest);
    const targetProfile = profileId(manifest.userId, manifest.deviceId);
    return this.withExclusiveWriter(targetProfile, () => this.acceptFreshOnlineManifestExclusively(manifest));
  }

  private async acceptFreshOnlineManifestExclusively(manifest: DeliveryManifestV1): Promise<void> {
    assertManifest(manifest);
    const active = this.profile ?? await this.getActiveProfile();
    if (!active || profileId(manifest.userId, manifest.deviceId) !== active.profileId) {
      throw new Error("El manifiesto en línea no corresponde al dispositivo con la cola guardada.");
    }
    await writeRecord(this.controlRecordId(active.profileId), { failedAttempts: 0, requiresOnline: false } satisfies UnlockControl);
    if (!this.keys) {
      this.profile = active;
      this.manifest = undefined;
      return;
    }
    this.persistentStorageReady = await this.hasPersistentStorageCertification(active.profileId);
    await this.ensureManifestDocuments(manifest);
    await this.storeManifest(manifest);
  }

  async getSavedManifest(): Promise<DeliveryManifestV1 | undefined> {
    const active = this.profile ?? await this.getActiveProfile();
    if (!active || !this.keys) return undefined;
    this.profile = active;
    this.manifest = await this.readSavedManifest(active, this.keys);
    return this.manifest;
  }

  async captureCommand(assignment: DeliveryAssignmentV1, commandName: DriverCommandName, data: Record<string, unknown>): Promise<QueueRecordView> {
    const { profile } = this.requireUnlocked();
    return this.withExclusiveWriter(profile.profileId, () => this.captureCommandExclusively(assignment, commandName, data));
  }

  private async captureCommandExclusively(assignment: DeliveryAssignmentV1, commandName: DriverCommandName, data: Record<string, unknown>): Promise<QueueRecordView> {
    const { profile, keys, manifest } = this.requireUnlocked();
    if (!manifest || !Number.isFinite(Date.parse(manifest.expiresAt)) || Date.parse(manifest.expiresAt) <= Date.now()) {
      throw new Error("El turno offline venció o no tiene una vigencia válida. No se agregó ningún evento; la cola cifrada existente se conserva.");
    }
    this.persistentStorageReady = await this.hasPersistentStorageCertification(profile.profileId);
    if (!this.persistentStorageReady) {
      throw new Error("Este navegador no confirmó almacenamiento persistente para el dispositivo. No se agregó ningún evento; la cola cifrada existente se conserva.");
    }
    const authorizedAssignment = manifest?.assignments.find((item) => item.id === assignment.id);
    if (!authorizedAssignment) {
      throw new Error("La entrega ya no pertenece al manifiesto desbloqueado.");
    }
    assertExactCommandData(data);
    if (!Number.isSafeInteger(authorizedAssignment.version) || authorizedAssignment.version < 0) throw new TypeError("Versión de entrega inválida.");
    const isCollectionReport = commandName === "CollectionReported";
    if (isCollectionReport) assertCollectionReportedData(data, authorizedAssignment, profile.userId);

    const requestId = stableUUID();
    const targetId = isCollectionReport ? requestId : authorizedAssignment.id;
    const versionScope = isCollectionReport ? "record" : "delivery";
    const createdAt = new Date().toISOString(); // Informational audit time; never used as authorization.
    const cursorId = this.cursorRecordId(profile.profileId, authorizedAssignment.id);
    const versionCursorId = this.versionCursorRecordId(profile.profileId, targetId);
    for (let retry = 0; retry < 20; retry += 1) {
      const expectedCursor = await readRecord<QueueCursor>(cursorId);
      const sequence = (expectedCursor?.sequence ?? 0) + 1;
      const expectedVersionCursor = isCollectionReport ? undefined : await readRecord<ObjectVersionCursor>(versionCursorId);
      const expectedVersion = isCollectionReport ? 0 : expectedVersionCursor?.nextExpectedVersion ?? authorizedAssignment.version;
      const envelope: CommandEnvelope = {
        schemaVersion: 1,
        requestId,
        targetId,
        expectedVersion,
        occurredAt: createdAt,
        command: commandName,
        data,
      };
      const queueRecord: StoredQueueRecord = {
        requestId,
        profileId: profile.profileId,
        leaseId: manifest.leaseId,
        authorizationEpoch: manifest.authorizationEpoch,
        targetId,
        streamId: authorizedAssignment.id,
        orderId: authorizedAssignment.orderId,
        sequence,
        dependsOn: expectedCursor?.lastRequestId ?? null,
        expectedVersion,
        versionScope,
        status: "pending",
        attempted: false,
        createdAt,
        encrypted: await encryptJson({ command: envelope } satisfies EncryptedCommand, keys.queue, aadFor(profile.userId, profile.deviceId, "queue", requestId)),
      };
      const nextCursor: QueueCursor = {
        id: cursorId,
        profileId: profile.profileId,
        targetId: authorizedAssignment.id,
        sequence,
        lastRequestId: requestId,
      };
      const versionChange = isCollectionReport ? undefined : {
        expected: expectedVersionCursor,
        next: { id: versionCursorId, profileId: profile.profileId, targetId, nextExpectedVersion: expectedVersion + 1 } satisfies ObjectVersionCursor,
      };
      if (await commitQueuedCommand(queueRecord, expectedCursor, nextCursor, versionChange)) {
        return this.toQueueView(queueRecord, { command: envelope });
      }
    }
    throw new Error("No se pudo reservar un orden de evento estable. Reintentá la captura.");
  }

  async listQueue(): Promise<QueueRecordView[]> {
    const { profile, keys } = this.requireUnlocked();
    const rows = await readQueue(profile.profileId);
    const views = await Promise.all(rows.map(async (row) => {
      const encrypted = await decryptJson<EncryptedCommand>(row.encrypted as CiphertextV1, keys.queue, aadFor(profile.userId, profile.deviceId, "queue", row.requestId));
      if (encrypted.command.requestId !== row.requestId || encrypted.command.targetId !== row.targetId || encrypted.command.expectedVersion !== row.expectedVersion) {
        throw new Error("La cola cifrada no coincide con sus identificadores guardados.");
      }
      return this.toQueueView(row, encrypted);
    }));
    return views;
  }

  async queueCounts(): Promise<Record<QueueStatus, number>> {
    const profile = this.profile ?? await this.getActiveProfile();
    const counts: Record<QueueStatus, number> = { pending: 0, accepted: 0, duplicate: 0, conflict: 0, rejected: 0, blocked: 0, quarantined: 0 };
    if (!profile) return counts;
    for (const row of await readQueue(profile.profileId)) counts[row.status] += 1;
    return counts;
  }

  async storeDocument(documentId: string, contents: Blob | ArrayBuffer | Uint8Array, mimeType = "application/octet-stream"): Promise<void> {
    const { profile } = this.requireUnlocked();
    return this.withExclusiveWriter(profile.profileId, () => this.storeDocumentExclusively(documentId, contents, mimeType));
  }

  private async storeDocumentExclusively(documentId: string, contents: Blob | ArrayBuffer | Uint8Array, mimeType: string): Promise<void> {
    const { profile, keys, manifest } = this.requireUnlocked();
    if (!documentId) throw new TypeError("El documento necesita un identificador estable.");
    const authorized = manifest?.assignments.flatMap((assignment) => assignment.documents).find((document) => document.id === documentId);
    if (!authorized) throw new Error("El documento no pertenece al manifiesto desbloqueado.");
    const bytes = contents instanceof Blob
      ? new Uint8Array(await contents.arrayBuffer())
      : new Uint8Array(contents);
    try {
      if (mimeType !== authorized.mimeType || bytes.byteLength !== authorized.byteLength || await sha256Hex(bytes) !== authorized.sha256) {
        throw new Error(`El tipo, tamaño o SHA-256 del documento ${documentId} no coincide con el manifiesto.`);
      }
      const encrypted = await encryptBytes(bytes, keys.documents, aadFor(profile.userId, profile.deviceId, "document", documentId));
      const row: StoredDocumentRecord = {
        id: `${profile.profileId}:${documentId}`,
        profileId: profile.profileId,
        encrypted,
        mimeType,
        byteLength: authorized.byteLength,
        sha256: authorized.sha256,
        version: authorized.version,
      };
      await writeDocument(row);
    } finally {
      bytes.fill(0);
    }
  }

  private async ensureManifestDocuments(manifest: DeliveryManifestV1): Promise<void> {
    const { profile, keys } = this.requireUnlocked();
    if (profileId(manifest.userId, manifest.deviceId) !== profile.profileId) {
      throw new Error("Los documentos del manifiesto pertenecen a otro dispositivo.");
    }
    const documents = manifest.assignments.flatMap((assignment) => assignment.documents);
    if (!documents.length) return;
    const href = globalThis.location?.href;
    if (!href) throw new Error("No se puede verificar el origen de los documentos del turno.");
    const origin = new URL(href).origin;
    const localById = new Map((await readDocuments(profile.profileId)).map((row) => [row.id, row]));
    for (const document of documents) {
      const recordId = `${profile.profileId}:${document.id}`;
      const local = localById.get(recordId);
      if (local && local.sha256 === document.sha256 && local.version === document.version &&
        local.mimeType === document.mimeType && local.byteLength === document.byteLength) {
        try {
          const savedBytes = await decryptBytes(local.encrypted as CiphertextV1, keys.documents, aadFor(profile.userId, profile.deviceId, "document", document.id));
          const verified = savedBytes.byteLength === document.byteLength && await sha256Hex(savedBytes) === document.sha256;
          savedBytes.fill(0);
          if (verified) continue;
        } catch {
          // Replace a corrupt cache entry only after a fresh verified download.
        }
      }

      const url = new URL(document.url, href);
      const expectedPath = `/api/operations/documents/${encodeURIComponent(document.id)}/content`;
      if (url.origin !== origin || url.pathname !== expectedPath || url.search || url.hash) {
        throw new Error(`El documento ${document.id} no apunta al contenido autorizado del mismo origen.`);
      }
      const response = await this.fetcher(url.href, {
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { accept: document.mimeType },
      });
      if (!response.ok) throw new Error(`No se pudo descargar el documento ${document.id} para el turno.`);
      const finalUrl = response.url ? new URL(response.url) : url;
      if (finalUrl.origin !== origin || finalUrl.pathname !== expectedPath || finalUrl.search || finalUrl.hash) {
        throw new Error(`La respuesta del documento ${document.id} salió de su ruta autorizada.`);
      }
      const responseType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      const declaredLength = response.headers.get("content-length");
      if (responseType !== document.mimeType || (declaredLength !== null && Number(declaredLength) !== document.byteLength)) {
        throw new Error(`El tipo o tamaño declarado del documento ${document.id} no coincide con el manifiesto.`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      try {
        if (bytes.byteLength !== document.byteLength || await sha256Hex(bytes) !== document.sha256) {
          throw new Error(`El SHA-256 o tamaño del documento ${document.id} no coincide con el manifiesto.`);
        }
        const encrypted = await encryptBytes(bytes, keys.documents, aadFor(profile.userId, profile.deviceId, "document", document.id));
        const stored: StoredDocumentRecord = {
          id: recordId,
          profileId: profile.profileId,
          encrypted,
          mimeType: document.mimeType,
          byteLength: document.byteLength,
          sha256: document.sha256,
          version: document.version,
        };
        await writeDocument(stored);
        localById.set(recordId, stored);
      } finally {
        bytes.fill(0);
      }
    }
  }

  async readDocument(documentId: string): Promise<Blob> {
    const { profile, keys, manifest } = this.requireUnlocked();
    const expected = manifest?.assignments.flatMap((assignment) => assignment.documents).find((document) => document.id === documentId);
    if (!expected) throw new Error("El documento no está autorizado por el manifiesto vigente del turno.");
    const row = (await readDocuments(profile.profileId)).find((item) => item.id === `${profile.profileId}:${documentId}`);
    if (!row) throw new Error("El documento no está guardado para uso sin conexión.");
    if (row.sha256 !== expected.sha256 || row.version !== expected.version || row.mimeType !== expected.mimeType || row.byteLength !== expected.byteLength) {
      throw new Error("Los metadatos del documento local no coinciden con el manifiesto vigente.");
    }
    const bytes = await decryptBytes(row.encrypted as CiphertextV1, keys.documents, aadFor(profile.userId, profile.deviceId, "document", documentId));
    try {
      if (bytes.byteLength !== expected.byteLength || await sha256Hex(bytes) !== expected.sha256) {
        throw new Error("El contenido del documento local no coincide con el manifiesto vigente.");
      }
      return new Blob([bytes], { type: expected.mimeType });
    } finally {
      bytes.fill(0);
    }
  }

  private withExclusiveWriter<T>(profileKey: string, action: () => Promise<T>): Promise<T> {
    return withOfflineWriter(profileKey, action);
  }

  async syncNow(): Promise<SyncSummary> {
    const { profile } = this.requireUnlocked();
    return this.withExclusiveWriter(profile.profileId, () => this.syncNowExclusively());
  }

  private async syncNowExclusively(): Promise<SyncSummary> {
    const { profile, manifest } = this.requireUnlocked();
    if (!manifest) throw new Error("Necesitás un manifiesto de entrega antes de sincronizar.");
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error("No hay conexión. La cola cifrada sigue guardada en este dispositivo.");

    const totals: SyncSummary = { sent: 0, accepted: 0, duplicates: 0, conflicts: 0, rejected: 0, blocked: 0, quarantined: 0, pending: 0 };
    for (let round = 0; round < 100; round += 1) {
      const records = await readQueue(profile.profileId);
      const byId = new Map(records.map((record) => [record.requestId, record]));
      let changed = false;
      for (const record of records) {
        if (record.status !== "pending" || !record.dependsOn) continue;
        const parent = byId.get(record.dependsOn);
        if (!parent || ["conflict", "rejected", "blocked", "quarantined"].includes(parent.status)) {
          await this.setQueueStatus(record, "blocked", "DEPENDENCY_NOT_ACCEPTED");
          totals.blocked += 1;
          changed = true;
        }
      }
      if (changed) continue;

      const heads = new Map<string, StoredQueueRecord>();
      for (const record of records) {
        if (record.status !== "pending" || heads.has(record.streamId)) continue;
        if (record.dependsOn) {
          const parent = byId.get(record.dependsOn);
          if (!parent || (parent.status !== "accepted" && parent.status !== "duplicate")) continue;
        }
        heads.set(record.streamId, record);
      }
      const ready = [...heads.values()].sort((a, b) => a.sequence - b.sequence);
      if (ready.length === 0) break;

      let madeProgress = false;
      for (const record of ready) {
        const current = await readQueue(profile.profileId).then((rows) => rows.find((row) => row.requestId === record.requestId));
        if (!current || current.status !== "pending") continue;
        const encrypted = await decryptJson<EncryptedCommand>(current.encrypted as CiphertextV1, this.keys!.queue, aadFor(profile.userId, profile.deviceId, "queue", current.requestId));
        if (encrypted.command.requestId !== current.requestId || encrypted.command.targetId !== current.targetId) {
          throw new Error("Los identificadores del comando cifrado no coinciden con la cola local.");
        }
        // Persist the attempt before sending. If the connection drops after the
        // server commits, retrying this exact envelope reuses the same UUID.
        const attemptedCurrent = { ...current, attempted: true };
        await writeQueueRecord(attemptedCurrent);
        totals.sent += 1;

        let response: Response;
        try {
          response = await this.fetcher(this.syncEndpoint, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              leaseId: manifest.leaseId,
              deviceId: profile.deviceId,
              events: [{ ...encrypted.command, sequence: current.sequence, dependsOn: current.dependsOn }],
            }),
          });
        } catch (error) {
          totals.pending = (await readQueue(profile.profileId)).filter((item) => item.status === "pending").length;
          throw new Error(`No se pudo contactar al servidor. Los ${totals.pending} eventos siguen cifrados para reintentar con los mismos UUID. ${messageOf(error)}`);
        }

        const payload = await readResponse(response);
        if (response.status === 401 || response.status === 403 || isAuthorizationFailure(payload)) {
          totals.pending = (await readQueue(profile.profileId)).filter((item) => item.status === "pending").length;
          throw new Error(`El servidor no confirmó una cuarentena con identidad archivada. Los ${totals.pending} eventos siguen cifrados y pendientes; no se autorizó ninguna operación. ${messageOf(payload)}`);
        }
        if (!response.ok) {
          const code = errorCode(payload) ?? `HTTP_${response.status}`;
          if (response.status === 409 && code === "VERSION_CONFLICT") {
            await this.setQueueStatus(attemptedCurrent, "conflict", code);
            totals.conflicts += 1;
            madeProgress = true;
            continue;
          }
          if (response.status === 423) {
            await this.setQueueStatus(attemptedCurrent, "blocked", code);
            totals.blocked += 1;
            madeProgress = true;
            continue;
          }
          if (response.status >= 500 || response.status === 429) {
            totals.pending = (await readQueue(profile.profileId)).filter((item) => item.status === "pending").length;
            throw new Error(`El servidor no confirmó la sincronización (${response.status}). Se reintentará con los mismos UUID. ${messageOf(payload)}`);
          }
          const status = response.status === 409 ? "quarantined" : "rejected";
          await this.setQueueStatus(attemptedCurrent, status, code);
          totals[status] += 1;
          madeProgress = true;
          continue;
        }

        const resultRow = normalizeResults(payload).get(current.requestId);
        const normalized = resultRow && normalizeStatus(resultRow);
        if (!normalized) {
          throw new Error("La respuesta de sincronización no confirmó el UUID enviado. El evento queda pendiente para reintentar con la misma clave.");
        }
        if (normalized.result && normalized.result.targetId !== current.targetId) {
          throw new Error("La respuesta del servidor confirmó un destino distinto al evento enviado.");
        }
        const receipt = normalized.status === "accepted" || normalized.status === "duplicate"
          ? validatedCommandReceipt(resultRow, current, normalized.status)
          : normalized.result;
        if ((normalized.status === "accepted" || normalized.status === "duplicate") && !receipt) {
          throw new Error("La respuesta no contiene un recibo completo para confirmar el UUID enviado. El evento queda pendiente para reintentar con la misma clave.");
        }
        await this.setQueueStatus(attemptedCurrent, normalized.status, resultRow?.code as string | undefined, receipt);
        if (normalized.status === "conflict") totals.conflicts += 1;
        else if (normalized.status === "duplicate") totals.duplicates += 1;
        else totals[normalized.status] += 1;
        madeProgress = true;
        if (normalized.status === "quarantined") {
          continue;
        }
        if (normalized.status === "accepted" || normalized.status === "duplicate") {
          await this.rebaseUnattemptedDependents(current, normalized.version);
        }
      }
      if (!madeProgress) break;
    }
    totals.pending = (await readQueue(profile.profileId)).filter((item) => item.status === "pending").length;
    totals.blocked = (await readQueue(profile.profileId)).filter((item) => item.status === "blocked").length;
    totals.quarantined = (await readQueue(profile.profileId)).filter((item) => item.status === "quarantined").length;
    return totals;
  }

  async createEncryptedBackup(): Promise<CreatedBackup> {
    const { profile } = this.requireUnlocked();
    return this.withExclusiveWriter(profile.profileId, () => this.createEncryptedBackupExclusively());
  }

  private async createEncryptedBackupExclusively(): Promise<CreatedBackup> {
    const { profile, keys } = this.requireUnlocked();
    const keyring = await readRecord<KeyringV1>(this.keyringRecordId(profile.profileId));
    if (!keyring) throw new Error("No se encontró la llave local para preparar el respaldo.");
    this.keyring = keyring;
    const packageId = stableUUID();
    const queue = await readAllQueueRecords(profile.profileId);
    const documents = await readDocuments(profile.profileId);
    const cursorRows = await readRecordsWithPrefix<QueueCursor>(`cursor:${profile.profileId}:`);
    const versionRows = await readRecordsWithPrefix<ObjectVersionCursor>(`version-cursor:${profile.profileId}:`);
    const queuePayload: QueueBackupPayloadV1 = {
      schemaVersion: 1,
      queue,
      cursors: cursorRows.map((entry) => entry.value),
      versions: versionRows.map((entry) => entry.value),
    };
    const documentsPayload: DocumentsBackupPayloadV1 = { schemaVersion: 1, documents };
    const encryptedQueue = await encryptJson(queuePayload, keys.queue, aadFor(profile.userId, profile.deviceId, "backup-queue", packageId));
    const encryptedDocuments = await encryptJson(documentsPayload, keys.documents, aadFor(profile.userId, profile.deviceId, "backup-documents", packageId));
    const backupPackage: EncryptedBackupPackageV1 = {
      schemaVersion: 1,
      packageId,
      userId: profile.userId,
      sourceDeviceId: profile.deviceId,
      keyring,
      queuePayload: encryptedQueue,
      documentsPayload: encryptedDocuments,
    };
    return { package: backupPackage, sha256: await sha256Hex(canonicalJson(backupPackage)) };
  }

  async uploadEncryptedBackup(): Promise<{ backupId: string; sha256: string; durable: true }> {
    const { profile, manifest } = this.requireUnlocked();
    if (!manifest) throw new Error("Necesitás un manifiesto vigente para enviar un respaldo.");
    const backup = await this.createEncryptedBackup();
    const response = await this.fetcher(this.backupEndpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ leaseId: manifest.leaseId, deviceId: profile.deviceId, package: backup.package, sha256: backup.sha256 }),
    });
    const payload = await readResponse(response);
    if (!response.ok) throw new Error(`El servidor no confirmó el respaldo. ${messageOf(payload)}`);
    const ack = payload as { backupId?: unknown; sha256?: unknown; durable?: unknown };
    if (typeof ack.backupId !== "string" || ack.sha256 !== backup.sha256 || ack.durable !== true) {
      throw new Error("El respaldo no recibió una confirmación durable con el mismo SHA-256.");
    }
    const acknowledgement: BackupAcknowledgementV1 = { backupId: ack.backupId, sha256: backup.sha256, durable: true };
    await this.withExclusiveWriter(profile.profileId, () => writeRecord(`backup-ack:${profile.profileId}:${ack.backupId}`, {
        ...acknowledgement,
        packageId: backup.package.packageId,
        acknowledgedAt: new Date().toISOString(),
      } satisfies PersistedBackupAcknowledgementV1));
    // The durable receipt never purges the local queue or encrypted documents.
    return acknowledgement;
  }

  async listBackupAcknowledgements(): Promise<PersistedBackupAcknowledgementV1[]> {
    const profile = this.profile ?? await this.getActiveProfile();
    if (!profile) return [];
    const rows = await readRecordsWithPrefix<PersistedBackupAcknowledgementV1>(`backup-ack:${profile.profileId}:`);
    return rows.map((row) => row.value).sort((left, right) => right.acknowledgedAt.localeCompare(left.acknowledgedAt));
  }

  async restoreEncryptedBackup(backupPackage: EncryptedBackupPackageV1, passphrase: string): Promise<RestoreSummary> {
    assertPassphrase(passphrase);
    const { profile: target, keys: targetKeys } = this.requireUnlocked();
    assertBackupIdentity(backupPackage, target.userId);
    const sourceKeyring = validateBackupKeyring(backupPackage);
    let sourceKeys: UnlockedKeys;
    try {
      sourceKeys = await unlockKeyring(sourceKeyring, passphrase);
    } catch {
      throw new InvalidPassphraseError();
    }
    return explainBackupIntegrityFailure(async () => {
      const queuePayload = await decryptJson<QueueBackupPayloadV1>(backupPackage.queuePayload, sourceKeys.queue, aadFor(backupPackage.userId, backupPackage.sourceDeviceId, "backup-queue", backupPackage.packageId));
      const documentsPayload = await decryptJson<DocumentsBackupPayloadV1>(backupPackage.documentsPayload, sourceKeys.documents, aadFor(backupPackage.userId, backupPackage.sourceDeviceId, "backup-documents", backupPackage.packageId));
      validateQueueBackupPayload(queuePayload);
      if (documentsPayload.schemaVersion !== 1 || !Array.isArray(documentsPayload.documents)) throw new Error("El contenido de documentos del respaldo no supera la validación de estructura.");
      return this.withExclusiveWriter(target.profileId, () => this.restoreQueuePayload(backupPackage, sourceKeys.queue, queuePayload, sourceKeys.documents, documentsPayload));
    });
  }

  /** Restores only the independently encrypted outbox after dual-approved queue-key recovery. */
  async restoreQueueWithRecoveryKey(backupPackage: EncryptedBackupPackageV1, recoveredQueueKey: CryptoKey): Promise<RestoreSummary> {
    const { profile: target } = this.requireUnlocked();
    assertBackupIdentity(backupPackage, target.userId);
    return explainBackupIntegrityFailure(async () => {
      const queuePayload = await decryptJson<QueueBackupPayloadV1>(backupPackage.queuePayload, recoveredQueueKey, aadFor(backupPackage.userId, backupPackage.sourceDeviceId, "backup-queue", backupPackage.packageId));
      validateQueueBackupPayload(queuePayload);
      return this.withExclusiveWriter(target.profileId, () => this.restoreQueuePayload(backupPackage, recoveredQueueKey, queuePayload));
    });
  }

  private async restoreQueuePayload(
    backupPackage: EncryptedBackupPackageV1,
    sourceQueueKey: CryptoKey,
    sourcePayload: QueueBackupPayloadV1,
    sourceDocumentKey?: CryptoKey,
    documentsPayload?: DocumentsBackupPayloadV1,
  ): Promise<RestoreSummary> {
    const { profile: target, keys: targetKeys } = this.requireUnlocked();

    const existingQueue = await readQueue(target.profileId);
    const existingById = new Map(existingQueue.map((row) => [row.requestId, row]));
    const restoredQueue: StoredQueueRecord[] = [];
    const quarantinedRequestIds: string[] = [];
    const alreadyPresentRequestIds: string[] = [];
    const importedPlainByStream = new Map<string, StoredQueueRecord[]>();
    for (const oldRow of sourcePayload.queue) {
      const plain = await decryptJson<EncryptedCommand>(
        oldRow.encrypted as CiphertextV1,
        sourceQueueKey,
        aadFor(backupPackage.userId, backupPackage.sourceDeviceId, "queue", oldRow.requestId),
      );
      const envelope = plain.command;
      if (envelope.requestId !== oldRow.requestId || envelope.targetId !== oldRow.targetId || envelope.expectedVersion !== oldRow.expectedVersion || oldRow.profileId !== profileId(backupPackage.userId, backupPackage.sourceDeviceId) || !oldRow.streamId ||
        (envelope.command === "CollectionReported" && (oldRow.versionScope !== "record" || oldRow.targetId !== oldRow.requestId || oldRow.expectedVersion !== 0 || envelope.data.deliveryId !== oldRow.streamId || envelope.data.orderId !== oldRow.orderId)) ||
        (envelope.command !== "CollectionReported" && (oldRow.versionScope !== "delivery" || oldRow.targetId !== oldRow.streamId))) {
        throw new Error("Un evento del respaldo no coincide con su UUID, destino o versión. No se restauró nada.");
      }
      const present = existingById.get(oldRow.requestId);
      if (present) {
        const presentPlain = await decryptJson<EncryptedCommand>(present.encrypted as CiphertextV1, targetKeys.queue, aadFor(target.userId, target.deviceId, "queue", present.requestId));
        if (canonicalJson(presentPlain) !== canonicalJson(plain)) throw new Error(`El UUID ${oldRow.requestId} ya existe con otro contenido. No se restauró nada.`);
        alreadyPresentRequestIds.push(oldRow.requestId);
        continue;
      }
      const receiptVerified = isValidatedQueueReceipt(oldRow, plain.serverResult);
      const nextRow: StoredQueueRecord = {
        ...oldRow,
        profileId: target.profileId,
        status: receiptVerified ? oldRow.status : "quarantined",
        errorCode: receiptVerified ? oldRow.errorCode : "RESTORE_REVIEW_REQUIRED",
        encrypted: await encryptJson(plain, targetKeys.queue, aadFor(target.userId, target.deviceId, "queue", oldRow.requestId)),
      };
      if (!receiptVerified) quarantinedRequestIds.push(nextRow.requestId);
      restoredQueue.push(nextRow);
      const entries = importedPlainByStream.get(oldRow.streamId) ?? [];
      entries.push(nextRow);
      importedPlainByStream.set(oldRow.streamId, entries);
    }

    const existingDocuments = documentsPayload
      ? new Map((await readDocuments(target.profileId)).map((row) => [row.id, row]))
      : new Map<string, StoredDocumentRecord>();
    const restoredDocuments: StoredDocumentRecord[] = [];
    const restoredDocumentIds = new Set<string>();
    for (const oldDocument of documentsPayload?.documents ?? []) {
      if (!sourceDocumentKey) throw new Error("La clave de documentos no está disponible; la recuperación solo puede restaurar la cola.");
      if (oldDocument.profileId !== profileId(backupPackage.userId, backupPackage.sourceDeviceId) || !oldDocument.id.startsWith(`${oldDocument.profileId}:`)) {
        throw new Error("Un documento del respaldo tiene una identidad distinta de su perfil.");
      }
      const documentId = oldDocument.id.slice(oldDocument.profileId.length + 1);
      const clearBytes = await decryptBytes(oldDocument.encrypted as CiphertextV1, sourceDocumentKey, aadFor(backupPackage.userId, backupPackage.sourceDeviceId, "document", documentId));
      if (clearBytes.byteLength !== oldDocument.byteLength) throw new Error("El tamaño de un documento no coincide con el contenido cifrado.");
      const targetId = `${target.profileId}:${documentId}`;
      const alreadyStored = existingDocuments.get(targetId);
      if (alreadyStored) {
        const existingClear = await decryptBytes(alreadyStored.encrypted as CiphertextV1, targetKeys.documents, aadFor(target.userId, target.deviceId, "document", documentId));
        const matches = equalBytes(clearBytes, existingClear);
        existingClear.fill(0);
        clearBytes.fill(0);
        if (!matches) throw new Error(`El documento ${documentId} ya existe con otro contenido. No se restauró nada.`);
        continue;
      }
      const encrypted = await encryptBytes(clearBytes, targetKeys.documents, aadFor(target.userId, target.deviceId, "document", documentId));
      clearBytes.fill(0);
      restoredDocuments.push({ ...oldDocument, id: targetId, profileId: target.profileId, encrypted });
      restoredDocumentIds.add(documentId);
    }

    const cursors: QueueCursor[] = [];
    for (const [streamId, entries] of importedPlainByStream) {
      const sourceCursor = sourcePayload.cursors.find((cursor) => cursor.targetId === streamId);
      if (!sourceCursor) throw new Error("Falta el cursor de secuencia de una entrega del respaldo.");
      const current = await readRecord<QueueCursor>(this.cursorRecordId(target.profileId, streamId));
      if (current && entries.some((entry) => entry.sequence <= current.sequence && !existingById.has(entry.requestId))) {
        throw new Error("La cola del dispositivo ya avanzó esta entrega; exportá una copia actualizada antes de restaurar.");
      }
      const orderedEntries = [...entries].sort((a, b) => a.sequence - b.sequence);
      const firstImported = orderedEntries[0];
      if (current && sourceCursor.sequence === current.sequence && sourceCursor.lastRequestId !== current.lastRequestId) {
        throw new Error("Las dos colas tienen cadenas distintas para la misma secuencia. No se mezclaron.");
      }
      if (current?.lastRequestId && firstImported && firstImported.sequence > current.sequence &&
        firstImported.dependsOn !== current.lastRequestId && !existingById.has(firstImported.dependsOn ?? "")) {
        throw new Error("El respaldo sigue otra cadena de eventos para esta entrega. No se mezclaron las colas.");
      }
      cursors.push({
        ...sourceCursor,
        id: this.cursorRecordId(target.profileId, streamId),
        profileId: target.profileId,
        sequence: Math.max(sourceCursor.sequence, current?.sequence ?? 0),
        lastRequestId: sourceCursor.sequence >= (current?.sequence ?? 0) ? sourceCursor.lastRequestId : current?.lastRequestId ?? null,
      });
    }

    const versionCursors: ObjectVersionCursor[] = [];
    for (const sourceVersion of sourcePayload.versions) {
      const current = await readRecord<ObjectVersionCursor>(this.versionCursorRecordId(target.profileId, sourceVersion.targetId));
      versionCursors.push({
        ...sourceVersion,
        id: this.versionCursorRecordId(target.profileId, sourceVersion.targetId),
        profileId: target.profileId,
        nextExpectedVersion: Math.max(sourceVersion.nextExpectedVersion, current?.nextExpectedVersion ?? 0),
      });
    }
    await commitRestoredData(restoredQueue, restoredDocuments, cursors, versionCursors);
    return {
      restoredRequestIds: restoredQueue.map((row) => row.requestId),
      quarantinedRequestIds,
      restoredDocumentIds: [...restoredDocumentIds],
      alreadyPresentRequestIds,
      verified: true,
    };
  }

  /** Wipes in-memory authority and local documents, while preserving every command. */
  async logoutAndForgetDocuments(): Promise<void> {
    const profile = this.profile ?? await this.getActiveProfile();
    if (profile) return this.withExclusiveWriter(profile.profileId, () => this.logoutAndForgetDocumentsExclusively(profile));
    this.forgetMemory();
  }

  private async logoutAndForgetDocumentsExclusively(profile: ActiveProfile): Promise<void> {
    await clearDocuments(profile.profileId);
    await deleteRecord(this.manifestRecordId(profile.profileId));
    this.keys = undefined;
    this.keyring = undefined;
    this.manifest = undefined;
    this.persistentStorageReady = false;
    this.profile = profile;
  }

  forgetMemory(): void {
    this.keys = undefined;
    this.keyring = undefined;
    this.manifest = undefined;
    this.persistentStorageReady = false;
    this.profile = undefined;
  }

  private async unwrapWithFailureTracking(keyring: KeyringV1, id: string, passphrase: string): Promise<UnlockedKeys> {
    try {
      const keys = await unlockKeyring(keyring, passphrase);
      await writeRecord(this.controlRecordId(id), { failedAttempts: 0, requiresOnline: false } satisfies UnlockControl);
      return keys;
    } catch (error) {
      const next = await updateRecord<UnlockControl>(this.controlRecordId(id), (current) => {
        const failedAttempts = (current?.failedAttempts ?? 0) + 1;
        return { failedAttempts, requiresOnline: failedAttempts >= 5 };
      });
      if (next.requiresOnline) throw new OfflineLockoutError();
      throw new InvalidPassphraseError();
    }
  }

  private async storeManifest(manifest: DeliveryManifestV1): Promise<void> {
    const { profile, keys } = this.requireUnlocked();
    if (manifest.userId !== profile.userId || manifest.deviceId !== profile.deviceId) throw new Error("No se puede mezclar el manifiesto de otra cuenta o dispositivo.");
    const encrypted = await encryptJson(manifest, keys.documents, aadFor(profile.userId, profile.deviceId, "manifest", manifest.leaseId));
    await writeRecord(this.manifestRecordId(profile.profileId), { leaseId: manifest.leaseId, encrypted });
    this.manifest = manifest;
  }

  private async readSavedManifest(profile: ActiveProfile, keys: UnlockedKeys): Promise<DeliveryManifestV1 | undefined> {
    const stored = await readRecord<{ leaseId: string; encrypted: CiphertextV1 }>(this.manifestRecordId(profile.profileId));
    if (!stored) return undefined;
    const manifest = await decryptJson<DeliveryManifestV1>(stored.encrypted, keys.documents, aadFor(profile.userId, profile.deviceId, "manifest", stored.leaseId));
    assertManifest(manifest);
    if (manifest.userId !== profile.userId || manifest.deviceId !== profile.deviceId) throw new Error("El manifiesto cifrado pertenece a otra identidad.");
    return manifest;
  }

  private async setQueueStatus(record: StoredQueueRecord, status: QueueStatus, errorCode?: string, result?: CommandResult): Promise<void> {
    const { profile, keys } = this.requireUnlocked();
    const clear = await decryptJson<EncryptedCommand>(record.encrypted as CiphertextV1, keys.queue, aadFor(profile.userId, profile.deviceId, "queue", record.requestId));
    const encrypted = await encryptJson({ ...clear, serverResult: result ?? clear.serverResult } satisfies EncryptedCommand, keys.queue, aadFor(profile.userId, profile.deviceId, "queue", record.requestId));
    await writeQueueRecord({ ...record, status, errorCode, encrypted });
  }

  private async rebaseUnattemptedDependents(accepted: StoredQueueRecord, acknowledgedVersion?: number): Promise<void> {
    if (accepted.versionScope !== "delivery") return;
    const { profile, keys } = this.requireUnlocked();
    const entries = (await readQueue(profile.profileId))
      .filter((entry) => entry.streamId === accepted.streamId && entry.sequence > accepted.sequence)
      .sort((a, b) => a.sequence - b.sequence);
    let nextVersion = acknowledgedVersion ?? accepted.expectedVersion + 1;
    let predecessor = accepted.requestId;
    let foundAttempted = false;
    let anyRebased = false;
    for (const row of entries) {
      if (row.dependsOn !== predecessor) break;
      if (row.status !== "pending") {
        if (["conflict", "rejected", "blocked", "quarantined"].includes(row.status)) break;
        predecessor = row.requestId;
        if (row.versionScope === "delivery") nextVersion = Math.max(nextVersion, row.expectedVersion + 1);
        continue;
      }
      if (row.attempted) { foundAttempted = true; break; }
      if (row.versionScope === "delivery") {
        const clear = await decryptJson<EncryptedCommand>(row.encrypted as CiphertextV1, keys.queue, aadFor(profile.userId, profile.deviceId, "queue", row.requestId));
        const command: CommandEnvelope = { ...clear.command, expectedVersion: nextVersion };
        const updated: StoredQueueRecord = { ...row, expectedVersion: nextVersion };
        updated.encrypted = await encryptJson({ ...clear, command } satisfies EncryptedCommand, keys.queue, aadFor(profile.userId, profile.deviceId, "queue", row.requestId));
        await writeQueueRecord(updated);
        nextVersion += 1;
        anyRebased = true;
      }
      // Collection reports participate in the delivery event sequence, but
      // never consume a delivery object's version.
      predecessor = row.requestId;
    }
    if (!foundAttempted) {
      const versionCursorId = this.versionCursorRecordId(profile.profileId, accepted.targetId);
      const versionCursor = await readRecord<ObjectVersionCursor>(versionCursorId);
      if (versionCursor || anyRebased || acknowledgedVersion !== undefined) {
        await writeRecord(versionCursorId, {
          id: versionCursorId,
          profileId: profile.profileId,
          targetId: accepted.targetId,
          nextExpectedVersion: nextVersion,
        } satisfies ObjectVersionCursor);
      }
    }
  }

  private toQueueView(row: StoredQueueRecord, clear: EncryptedCommand): QueueRecordView {
    return {
      requestId: row.requestId,
      targetId: row.targetId,
      streamId: row.streamId,
      orderId: row.orderId,
      sequence: row.sequence,
      dependsOn: row.dependsOn,
      expectedVersion: row.expectedVersion,
      versionScope: row.versionScope,
      status: row.status,
      attempted: row.attempted,
      createdAt: row.createdAt,
      command: clear.command,
      serverResult: clear.serverResult,
      errorCode: row.errorCode,
    };
  }

  private requireUnlocked(): { profile: ActiveProfile; keys: UnlockedKeys; manifest?: DeliveryManifestV1 } {
    if (!this.profile || !this.keys) throw new Error("Desbloqueá el turno para continuar.");
    return { profile: this.profile, keys: this.keys, manifest: this.manifest };
  }

  private async getActiveProfile(): Promise<ActiveProfile | undefined> {
    const active = await readRecord<ActiveProfile>(PROFILE_ID);
    if (active) this.profile = active;
    return active;
  }

  private async getActiveKeyring(): Promise<KeyringV1 | undefined> {
    const active = this.profile ?? await this.getActiveProfile();
    if (!active) return undefined;
    return readRecord<KeyringV1>(this.keyringRecordId(active.profileId));
  }

  private keyringRecordId(profileKey: string): string { return `keyring:${profileKey}`; }
  private controlRecordId(profileKey: string): string { return `unlock-control:${profileKey}`; }
  private manifestRecordId(profileKey: string): string { return `manifest:${profileKey}`; }
  private storageCertificationRecordId(profileKey: string): string { return `storage-certification:${profileKey}`; }
  private cursorRecordId(profileKey: string, targetId: string): string { return `cursor:${profileKey}:${targetId}`; }
  private versionCursorRecordId(profileKey: string, targetId: string): string { return `version-cursor:${profileKey}:${targetId}`; }

  private async resolveRecoveryConfig(manifest?: DeliveryManifestV1): Promise<RecoveryConfigResult> {
    const configured = manifest?.queueRecoveryPublicKeyPem ?? this.injectedRecoveryPublicKeyPem;
    if (configured) return { status: "available", publicKeyPem: configured };
    return fetchQueueRecoveryConfig(this.fetcher, this.recoveryConfigEndpoint);
  }

  private async hasPersistentStorageCertification(profileKey: string): Promise<boolean> {
    const certification = await readRecord<LocalStorageCertificationV1>(this.storageCertificationRecordId(profileKey));
    if (certification?.requested !== true || certification.persistent !== true) return false;
    return persistentStorageGranted();
  }
}

function profileId(userId: string, deviceId: string): string { return `${userId}:${deviceId}`; }

function validatedCommandReceipt(row: Record<string, unknown> | undefined, queue: StoredQueueRecord, status: "accepted" | "duplicate"): CommandResult | undefined {
  if (!row || row.requestId !== queue.requestId ||
    (row.targetId !== undefined && row.targetId !== queue.targetId) ||
    !isPlainObject(row.result) || typeof row.replay !== "boolean" || row.replay !== (status === "duplicate")) return undefined;
  const version = numberValue(row.version);
  if (version === undefined) return undefined;
  return { requestId: queue.requestId, targetId: queue.targetId, version, result: row.result, replay: row.replay };
}

function isValidatedQueueReceipt(row: StoredQueueRecord, receipt?: CommandResult): boolean {
  if (!receipt || receipt.requestId !== row.requestId || receipt.targetId !== row.targetId ||
    !Number.isSafeInteger(receipt.version) || receipt.version < 0 || !isPlainObject(receipt.result)) return false;
  if (row.status === "accepted") return receipt.replay === false;
  if (row.status === "duplicate") return receipt.replay === true;
  return false;
}

interface RecoveryConfigResult {
  status: QueueRecoveryStatus;
  publicKeyPem?: string;
}

async function fetchQueueRecoveryConfig(fetcher: typeof fetch, endpoint: string): Promise<RecoveryConfigResult> {
  try {
    const response = await fetcher(endpoint, { method: "GET", credentials: "same-origin", headers: { accept: "application/json" } });
    if (!response.ok) return { status: "unavailable" };
    const config = await readResponse(response) as Partial<QueueRecoveryConfigV1>;
    if (config.available === false && config.publicKey === null && config.scope === "queue_only") {
      return { status: "not-configured" };
    }
    if (config.available === true && config.algorithm === "RSA-OAEP-256" && config.scope === "queue_only" &&
      typeof config.publicKey === "string" && looksLikePublicKeyPem(config.publicKey)) {
      return { status: "available", publicKeyPem: config.publicKey };
    }
    return { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

function looksLikePublicKeyPem(value: string): boolean {
  return value.includes("-----BEGIN PUBLIC KEY-----") && value.includes("-----END PUBLIC KEY-----");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertCollectionReportedData(data: Record<string, unknown>, assignment: DeliveryAssignmentV1, userId: string): void {
  const allowed = new Set(["orderId", "deliveryId", "method", "currency", "amountMinor", "custodianId", "evidence", "accountId"]);
  const required = ["orderId", "deliveryId", "method", "currency", "amountMinor", "evidence"];
  for (const key of Object.keys(data)) if (!allowed.has(key)) throw new TypeError(`CollectionReported no admite el campo ${key}.`);
  for (const key of required) if (!(key in data)) throw new TypeError(`CollectionReported requiere el campo ${key}.`);
  if (data.orderId !== assignment.orderId || data.deliveryId !== assignment.id) {
    throw new TypeError("El cobro debe corresponder al pedido y entrega del manifiesto.");
  }
  if (data.method !== "cash" && data.method !== "transfer" && data.method !== "mercado_pago" && data.method !== "card") {
    throw new TypeError("El medio de cobro no es válido.");
  }
  if (data.currency !== "ARS" && data.currency !== "USD") throw new TypeError("La moneda del cobro no es válida.");
  if (!isMinorUnitString(data.amountMinor) || BigInt(data.amountMinor) <= 0n) {
    throw new TypeError("El importe del cobro debe ser positivo y estar en unidades menores exactas.");
  }
  if (!isPlainObject(data.evidence)) throw new TypeError("El cobro necesita evidencia en formato de objeto.");
  if (data.method === "cash" && data.custodianId !== userId) {
    throw new TypeError("El efectivo debe quedar a cargo del repartidor autenticado.");
  }
  if (data.custodianId !== undefined && typeof data.custodianId !== "string") throw new TypeError("La custodia del cobro no es válida.");
  if (data.accountId !== undefined && typeof data.accountId !== "string") throw new TypeError("La cuenta del cobro no es válida.");
}

function assertBackupIdentity(backup: EncryptedBackupPackageV1, expectedUserId: string): void {
  if (!isPlainObject(backup) || backup.schemaVersion !== 1 || !isUuid(backup.packageId) ||
    backup.userId !== expectedUserId || !isUuid(backup.sourceDeviceId)) {
    throw new TypeError("El respaldo pertenece a otra cuenta o usa una versión no admitida.");
  }
  assertCiphertext(backup.queuePayload, "cola");
  assertCiphertext(backup.documentsPayload, "documentos");
}

function validateBackupKeyring(backup: EncryptedBackupPackageV1): KeyringV1 {
  const keyring = backup.keyring;
  if (!isPlainObject(keyring) || keyring.schemaVersion !== 1 || keyring.userId !== backup.userId ||
    keyring.deviceId !== backup.sourceDeviceId || !isPlainObject(keyring.kdf) ||
    keyring.kdf.name !== "PBKDF2" || keyring.kdf.hash !== "SHA-256" || keyring.kdf.iterations !== 600_000 ||
    typeof keyring.kdf.salt !== "string" || !isBase64(keyring.kdf.salt)) {
    throw new TypeError("El anillo de llaves del respaldo no coincide con su dispositivo.");
  }
  assertCiphertext(keyring.queueKey, "llave de cola");
  assertCiphertext(keyring.documentKey, "llave de documentos");
  if (keyring.queueRecoveryWrappedKey !== undefined &&
    (typeof keyring.queueRecoveryWrappedKey !== "string" || !isBase64(keyring.queueRecoveryWrappedKey))) {
    throw new TypeError("La clave de recuperación de la cola tiene un formato inválido.");
  }
  return keyring as unknown as KeyringV1;
}

function validateQueueBackupPayload(value: unknown): asserts value is QueueBackupPayloadV1 {
  if (!isPlainObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.queue) ||
    !Array.isArray(value.cursors) || !Array.isArray(value.versions)) {
    throw new TypeError("El contenido de cola del respaldo no supera la validación de estructura.");
  }
  const ids = new Set<string>();
  for (const row of value.queue) {
    if (!isPlainObject(row) || !isUuid(row.requestId) || ids.has(row.requestId) || typeof row.profileId !== "string" ||
      !isUuid(row.targetId) || !isUuid(row.streamId) || typeof row.orderId !== "string" ||
      !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 ||
      !(row.dependsOn === null || isUuid(row.dependsOn)) || !Number.isSafeInteger(row.expectedVersion) || Number(row.expectedVersion) < 0 ||
      (row.versionScope !== "delivery" && row.versionScope !== "record") ||
      !["pending", "accepted", "duplicate", "conflict", "rejected", "blocked", "quarantined"].includes(String(row.status)) ||
      typeof row.attempted !== "boolean" || typeof row.createdAt !== "string") {
      throw new TypeError("Un evento del respaldo tiene metadatos inválidos.");
    }
    assertCiphertext(row.encrypted, "evento");
    ids.add(row.requestId);
  }
  for (const cursor of value.cursors) {
    if (!isPlainObject(cursor) || typeof cursor.id !== "string" || typeof cursor.profileId !== "string" ||
      !isUuid(cursor.targetId) || !Number.isSafeInteger(cursor.sequence) || Number(cursor.sequence) < 1 ||
      !(cursor.lastRequestId === null || isUuid(cursor.lastRequestId))) {
      throw new TypeError("Un cursor de secuencia del respaldo es inválido.");
    }
  }
  for (const cursor of value.versions) {
    if (!isPlainObject(cursor) || typeof cursor.id !== "string" || typeof cursor.profileId !== "string" ||
      !isUuid(cursor.targetId) || !Number.isSafeInteger(cursor.nextExpectedVersion) || Number(cursor.nextExpectedVersion) < 0) {
      throw new TypeError("Un cursor de versión del respaldo es inválido.");
    }
  }
}

function assertCiphertext(value: unknown, label: string): asserts value is CiphertextV1 {
  if (!isPlainObject(value) || value.algorithm !== "AES-256-GCM" || typeof value.iv !== "string" ||
    typeof value.ciphertext !== "string" || !isBase64(value.iv) || !isBase64(value.ciphertext)) {
    throw new TypeError(`El cifrado de ${label} no tiene formato admitido.`);
  }
}

function isBase64(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try { return await navigator.storage.persist(); } catch { return false; }
}

export async function persistentStorageGranted(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.storage?.persisted) return false;
  try { return await navigator.storage.persisted(); } catch { return false; }
}

export function amountToMinorUnits(input: string, fractionDigits = 2): MinorUnitString {
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 6) throw new RangeError("La precisión de la moneda no es válida.");
  const normalized = input.trim().replace(",", ".");
  const match = /^(0|[1-9]\d{0,18})(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new TypeError("Ingresá un importe decimal válido.");
  const fraction = match[2] ?? "";
  if (fraction.length > fractionDigits && /[1-9]/.test(fraction.slice(fractionDigits))) {
    throw new RangeError("El importe tiene más decimales de los que permite la moneda.");
  }
  const minor = BigInt(match[1]!) * (10n ** BigInt(fractionDigits)) + BigInt(fraction.slice(0, fractionDigits).padEnd(fractionDigits, "0") || "0");
  const value = minor.toString();
  if (!isMinorUnitString(value)) throw new RangeError("El importe supera el máximo permitido.");
  return value;
}

export function formatMinorUnits(value: string, currency: string, locale = "es-AR"): string {
  if (!isMinorUnitString(value)) throw new TypeError("El importe debe estar expresado como unidades menores exactas.");
  const fractionDigits = new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const power = 10n ** BigInt(fractionDigits);
  const amount = BigInt(value);
  const major = amount / power;
  const fraction = (amount % power).toString().padStart(fractionDigits, "0");
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).formatToParts(major);
  if (fractionDigits === 0) return parts.map((part) => part.type === "integer" ? part.value : part.value).join("");
  let replaced = false;
  return parts.map((part) => {
    if (part.type === "fraction") {
      replaced = true;
      return fraction;
    }
    if (part.type === "decimal" && !replaced) return part.value;
    return part.value;
  }).join("");
}

export function createOfflineDeliveryClient(options?: OfflineClientOptions): OfflineDeliveryClient {
  return new OfflineDeliveryClient(options);
}

export async function deleteOfflineDocumentsForActiveProfile(): Promise<void> {
  const profile = await readRecord<ActiveProfile>(PROFILE_ID);
  if (profile) await withOfflineWriter(profile.profileId, () => clearDocuments(profile.profileId));
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as unknown; } catch { return { message: text }; }
}

function normalizeResults(value: unknown): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (Array.isArray(value)) {
    for (const item of value) addResult(map, item);
    return map;
  }
  if (!value || typeof value !== "object") return map;
  const body = value as Record<string, unknown>;
  if (Array.isArray(body.results)) for (const item of body.results) addResult(map, item);
  else addResult(map, body);
  return map;
}

function addResult(map: Map<string, Record<string, unknown>>, value: unknown): void {
  if (!value || typeof value !== "object") return;
  const row = value as Record<string, unknown>;
  if (typeof row.requestId === "string") map.set(row.requestId, row);
}

function normalizeStatus(row: Record<string, unknown>): { status: QueueStatus; result?: CommandResult; version?: number } | undefined {
  const explicit = row.status;
  if (["accepted", "duplicate", "conflict", "rejected", "blocked", "quarantined"].includes(String(explicit))) {
    const status = explicit as QueueStatus;
    const result = commandResultFrom(row);
    const version = numberValue(row.version) ?? result?.version;
    return { status, result, version };
  }
  const commandResult = commandResultFrom(row);
  if (commandResult) return { status: commandResult.replay ? "duplicate" : "accepted", result: commandResult, version: commandResult.version };
  return undefined;
}

function commandResultFrom(value: Record<string, unknown>): CommandResult | undefined {
  if (typeof value.requestId !== "string" || typeof value.targetId !== "string" || !Number.isSafeInteger(value.version)) return undefined;
  return value as unknown as CommandResult;
}

function numberValue(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function isAuthorizationFailure(value: unknown): boolean {
  const code = errorCode(value) ?? "";
  return /AUTHORIZATION_REVOKED|CAPABILITY_REQUIRED|LEASE_(?:EXPIRED|REVOKED|INVALID)|SESSION_(?:EXPIRED|REVOKED)|DEVICE_REVOKED/i.test(code);
}

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const body = value as Record<string, unknown>;
  const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined;
  const code = body.code ?? error?.code;
  return typeof code === "string" ? code : undefined;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === "object") {
    const body = value as Record<string, unknown>;
    const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : undefined;
    const message = body.message ?? error?.message;
    if (typeof message === "string") return message;
  }
  return "";
}
