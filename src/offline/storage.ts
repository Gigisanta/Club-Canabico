import {
  DOCUMENT_STORE,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  QUEUE_STORE,
  RECORD_STORE,
  type QueueStatus,
} from "./contracts";

export interface StoredCiphertext {
  algorithm: "AES-256-GCM";
  iv: string;
  ciphertext: string;
}

export interface StoredQueueRecord {
  requestId: string;
  profileId: string;
  /** Lease and authorization epoch that actually authorized this capture. */
  leaseId?: string;
  authorizationEpoch?: number;
  targetId: string;
  streamId: string;
  orderId: string;
  sequence: number;
  dependsOn: string | null;
  expectedVersion: number;
  versionScope: "delivery" | "record";
  status: QueueStatus;
  attempted: boolean;
  createdAt: string;
  encrypted: StoredCiphertext;
  errorCode?: string;
}

export interface StoredDocumentRecord {
  id: string;
  profileId: string;
  encrypted: StoredCiphertext;
  mimeType: string;
  byteLength: number;
  sha256?: string;
  version?: string;
}

export interface QueueCursor {
  id: string;
  profileId: string;
  /** Delivery assignment ID; the stream can include commands with separate record targets. */
  targetId: string;
  sequence: number;
  lastRequestId: string | null;
}

export interface ObjectVersionCursor {
  id: string;
  profileId: string;
  targetId: string;
  nextExpectedVersion: number;
}

export interface StoredRecord<T = unknown> {
  id: string;
  value: T;
}

let opening: Promise<IDBDatabase> | undefined;

export function openOfflineDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Este navegador no ofrece almacenamiento local compatible."));
  if (opening) return opening;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORD_STORE)) db.createObjectStore(RECORD_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        const queue = db.createObjectStore(QUEUE_STORE, { keyPath: "requestId" });
        queue.createIndex("byProfile", "profileId", { unique: false });
        queue.createIndex("byProfileSequence", ["profileId", "sequence"], { unique: false });
      }
      if (!db.objectStoreNames.contains(DOCUMENT_STORE)) {
        const documents = db.createObjectStore(DOCUMENT_STORE, { keyPath: "id" });
        documents.createIndex("byProfile", "profileId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        opening = undefined;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error("No se pudo abrir el almacenamiento cifrado."));
    request.onblocked = () => reject(new Error("Otra pestaña mantiene abierto el almacenamiento sin conexión."));
  }).catch((error) => {
    opening = undefined;
    throw error;
  });
  opening = pending;
  return pending;
}

function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("La transacción local se canceló."));
    tx.onerror = () => reject(tx.error ?? new Error("Falló la transacción local."));
  });
}

export async function readRecord<T>(id: string): Promise<T | undefined> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(RECORD_STORE, "readonly");
  const done = transactionComplete(tx);
  const request = tx.objectStore(RECORD_STORE).get(id);
  const row = await new Promise<StoredRecord<T> | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredRecord<T> | undefined);
    request.onerror = () => reject(request.error ?? new Error("No se pudo leer el registro local."));
  });
  await done;
  return row?.value;
}

export async function writeRecord<T>(id: string, value: T): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(RECORD_STORE, "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  tx.objectStore(RECORD_STORE).put({ id, value } satisfies StoredRecord<T>);
  await done;
}

export async function writeRecords(entries: Array<StoredRecord>): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(RECORD_STORE, "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  const store = tx.objectStore(RECORD_STORE);
  for (const entry of entries) store.put(entry);
  await done;
}

export async function readRecordsWithPrefix<T = unknown>(prefix: string): Promise<Array<StoredRecord<T>>> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(RECORD_STORE, "readonly");
  const done = transactionComplete(tx);
  const request = tx.objectStore(RECORD_STORE).openCursor();
  const entries: Array<StoredRecord<T>> = [];
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const row = cursor.value as StoredRecord<T>;
      if (row.id.startsWith(prefix)) entries.push(row);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error("No se pudieron leer los registros locales."));
  });
  await done;
  return entries;
}

export async function deleteRecord(id: string): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(RECORD_STORE, "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  tx.objectStore(RECORD_STORE).delete(id);
  await done;
}

export async function readQueue(profileId: string): Promise<StoredQueueRecord[]> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(QUEUE_STORE, "readonly");
  const done = transactionComplete(tx);
  const request = tx.objectStore(QUEUE_STORE).index("byProfile").getAll(IDBKeyRange.only(profileId));
  const rows = await new Promise<StoredQueueRecord[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredQueueRecord[]);
    request.onerror = () => reject(request.error ?? new Error("No se pudo leer la cola local."));
  });
  await done;
  return rows.sort((a, b) => a.streamId.localeCompare(b.streamId) || a.sequence - b.sequence);
}

export async function readQueueById(requestId: string): Promise<StoredQueueRecord | undefined> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(QUEUE_STORE, "readonly");
  const done = transactionComplete(tx);
  const request = tx.objectStore(QUEUE_STORE).get(requestId);
  const row = await new Promise<StoredQueueRecord | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredQueueRecord | undefined);
    request.onerror = () => reject(request.error ?? new Error("No se pudo leer el comando local."));
  });
  await done;
  return row;
}

export async function writeQueueRecord(record: StoredQueueRecord): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(QUEUE_STORE, "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  tx.objectStore(QUEUE_STORE).put(record);
  await done;
}

/**
 * Commits a command and its updated sequence cursor atomically. A changed cursor
 * returns false so the caller can re-encrypt against the latest predecessor.
 */
export async function commitQueuedCommand(
  record: StoredQueueRecord,
  expectedCursor: QueueCursor | undefined,
  nextCursor: QueueCursor,
  versionChange?: { expected?: ObjectVersionCursor; next: ObjectVersionCursor },
): Promise<boolean> {
  const db = await openOfflineDatabase();
  const tx = db.transaction([QUEUE_STORE, RECORD_STORE], "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  const cursorStore = tx.objectStore(RECORD_STORE);
  const gets: IDBRequest[] = [cursorStore.get(nextCursor.id)];
  if (versionChange) gets.push(cursorStore.get(versionChange.next.id));
  const values: Array<StoredRecord<QueueCursor | ObjectVersionCursor> | undefined> = [];
  let remaining = gets.length;
  let stale = false;
  const maybeCommit = () => {
    remaining -= 1;
    if (remaining !== 0) return;
    const current = (values[0] as StoredRecord<QueueCursor> | undefined)?.value;
    const currentVersion = (values[1] as StoredRecord<ObjectVersionCursor> | undefined)?.value;
    if (!sameCursor(current, expectedCursor) || (versionChange && !sameVersionCursor(currentVersion, versionChange.expected))) {
      stale = true;
      tx.abort();
      return;
    }
    tx.objectStore(QUEUE_STORE).add(record);
    cursorStore.put({ id: nextCursor.id, value: nextCursor } satisfies StoredRecord<QueueCursor>);
    if (versionChange) cursorStore.put({ id: versionChange.next.id, value: versionChange.next } satisfies StoredRecord<ObjectVersionCursor>);
  };
  gets.forEach((get, index) => {
    get.onsuccess = () => {
      values[index] = get.result as StoredRecord<QueueCursor | ObjectVersionCursor> | undefined;
      maybeCommit();
    };
    get.onerror = () => tx.abort();
  });
  try {
    await done;
    return true;
  } catch (error) {
    if (stale) return false;
    throw error;
  }
}

function sameCursor(left: QueueCursor | undefined, right: QueueCursor | undefined): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id && left.profileId === right.profileId && left.targetId === right.targetId &&
    left.sequence === right.sequence && left.lastRequestId === right.lastRequestId;
}

function sameVersionCursor(left: ObjectVersionCursor | undefined, right: ObjectVersionCursor | undefined): boolean {
  if (!left || !right) return left === right;
  return left.id === right.id && left.profileId === right.profileId && left.targetId === right.targetId && left.nextExpectedVersion === right.nextExpectedVersion;
}

export async function readDocuments(profileId: string): Promise<StoredDocumentRecord[]> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(DOCUMENT_STORE, "readonly");
  const done = transactionComplete(tx);
  const request = tx.objectStore(DOCUMENT_STORE).index("byProfile").getAll(IDBKeyRange.only(profileId));
  const rows = await new Promise<StoredDocumentRecord[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as StoredDocumentRecord[]);
    request.onerror = () => reject(request.error ?? new Error("No se pudieron leer los documentos locales."));
  });
  await done;
  return rows;
}

export async function writeDocument(record: StoredDocumentRecord): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(DOCUMENT_STORE, "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  tx.objectStore(DOCUMENT_STORE).put(record);
  await done;
}

export async function clearDocuments(profileId: string): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(DOCUMENT_STORE, "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  const cursor = tx.objectStore(DOCUMENT_STORE).index("byProfile").openCursor(IDBKeyRange.only(profileId));
  cursor.onsuccess = () => {
    const current = cursor.result;
    if (!current) return;
    current.delete();
    current.continue();
  };
  cursor.onerror = () => tx.abort();
  await done;
}

export async function commitRestoredData(
  queue: StoredQueueRecord[],
  documents: StoredDocumentRecord[],
  cursors: QueueCursor[],
  versionCursors: ObjectVersionCursor[],
): Promise<void> {
  const db = await openOfflineDatabase();
  const tx = db.transaction([QUEUE_STORE, DOCUMENT_STORE, RECORD_STORE], "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  const queueStore = tx.objectStore(QUEUE_STORE);
  const documentStore = tx.objectStore(DOCUMENT_STORE);
  const recordStore = tx.objectStore(RECORD_STORE);
  for (const row of queue) queueStore.add(row);
  for (const row of documents) documentStore.add(row);
  for (const cursor of cursors) recordStore.put({ id: cursor.id, value: cursor } satisfies StoredRecord<QueueCursor>);
  for (const cursor of versionCursors) recordStore.put({ id: cursor.id, value: cursor } satisfies StoredRecord<ObjectVersionCursor>);
  await done;
}

export async function readAllQueueRecords(profileId: string): Promise<StoredQueueRecord[]> {
  return readQueue(profileId);
}

export async function updateRecord<T>(id: string, update: (current: T | undefined) => T): Promise<T> {
  const db = await openOfflineDatabase();
  const tx = db.transaction(RECORD_STORE, "readwrite", { durability: "strict" });
  const done = transactionComplete(tx);
  const store = tx.objectStore(RECORD_STORE);
  const request = store.get(id);
  let next!: T;
  request.onsuccess = () => {
    const current = (request.result as StoredRecord<T> | undefined)?.value;
    next = update(current);
    store.put({ id, value: next } satisfies StoredRecord<T>);
  };
  request.onerror = () => tx.abort();
  await done;
  return next;
}
