import type { CommandEnvelope, CommandResult, Currency } from "../../shared/operations/contracts";

export type { CommandEnvelope, CommandResult, Currency };

export type DecimalString = string & { readonly __decimalString: unique symbol };
export type MinorUnitString = string & { readonly __minorUnitString: unique symbol };

export interface DeliveryLineV1 {
  id: string;
  name?: string;
  productName?: string;
  skuId?: string;
  unit?: string;
  quantity?: DecimalString | string;
  requested?: DecimalString | string;
  prepared?: DecimalString | string;
  delivered?: DecimalString | string;
  remaining?: DecimalString | string;
  unitPriceMinor?: MinorUnitString | string;
  totalMinor?: MinorUnitString | string;
  [key: string]: unknown;
}

export interface DeliveryAssignmentV1 {
  /** Stable UUID of the delivery assignment and targetId for driver commands. */
  id: string;
  orderId: string;
  version: number;
  customerName: string;
  address: string | Record<string, unknown>;
  window: string;
  /** Route details are included only when the assigned route belongs to this driver. */
  route?: {
    date: string;
    /** One-based stop number for display. */
    stop: number;
    eta?: string;
    etaIsEstimate: boolean;
  };
  lines: DeliveryLineV1[];
  documents: DeliveryDocumentV1[];
  totalMinor: MinorUnitString | string;
  currency: Currency;
  [key: string]: unknown;
}

export interface DeliveryDocumentV1 {
  id: string;
  name?: string;
  url: string;
  /** SHA-256 of the exact downloadable bytes, lowercase hexadecimal. */
  sha256: string;
  byteLength: number;
  mimeType: string;
  version: string;
}

export interface StorageCertificationV1 {
  persistent: boolean;
  requested?: boolean;
  storageCertifiedAt?: string;
  evidence?: Record<string, unknown>;
}

/** The server-issued offline lease. Client timestamps are display hints only. */
export interface DeliveryManifestV1 {
  version: 1;
  userId: string;
  deviceId: string;
  leaseId: string;
  authorizationEpoch: number;
  expiresAt: string;
  /** Public key is safe to distribute; it only wraps the queue key for a dual-approved recovery. */
  queueRecoveryPublicKeyPem?: string;
  assignments: DeliveryAssignmentV1[];
  storageCertification: StorageCertificationV1 | boolean;
}

export type DriverCommandName = "DeliveryRecorded" | "DeliveryIncident" | "CollectionReported";
export type QueueStatus = "pending" | "accepted" | "duplicate" | "conflict" | "rejected" | "blocked" | "quarantined";

export interface QueueRecordView {
  requestId: string;
  targetId: string;
  /** Delivery assignment that orders this event stream, even when targetId is a new report UUID. */
  streamId: string;
  orderId: string;
  sequence: number;
  dependsOn: string | null;
  expectedVersion: number;
  versionScope: "delivery" | "record";
  status: QueueStatus;
  attempted: boolean;
  createdAt: string;
  command: CommandEnvelope;
  serverResult?: CommandResult;
  errorCode?: string;
}

export interface SyncResultV1 {
  requestId: string;
  status?: QueueStatus;
  result?: Record<string, unknown>;
  version?: number;
  replay?: boolean;
  code?: string;
  message?: string;
}

export interface SyncResponseV1 {
  results: SyncResultV1[];
}

export interface CollectionReportedDataV1 {
  orderId: string;
  deliveryId: string;
  method: "cash" | "transfer" | "mercado_pago" | "card";
  currency: Currency;
  amountMinor: MinorUnitString | string;
  custodianId?: string;
  evidence: Record<string, unknown>;
  accountId?: string;
}

export interface EncryptedBackupPackageV1 {
  schemaVersion: 1;
  packageId: string;
  userId: string;
  sourceDeviceId: string;
  keyring: unknown;
  /** Independently decryptable with the queue key, including recovery-wrapped queue keys. */
  queuePayload: {
    algorithm: "AES-256-GCM";
    iv: string;
    ciphertext: string;
  };
  /** Always stays encrypted under the document key, which is never escrowed for queue recovery. */
  documentsPayload: {
    algorithm: "AES-256-GCM";
    iv: string;
    ciphertext: string;
  };
}

export interface BackupAcknowledgementV1 {
  backupId: string;
  sha256: string;
  durable: true;
}

export interface OfflineClientOptions {
  fetcher?: typeof fetch;
  syncEndpoint?: string;
  backupEndpoint?: string;
  readinessEndpointBase?: string;
  recoveryConfigEndpoint?: string;
  recoveryEndpointBase?: string;
  /** Optional deployment-injected public key; the matching private key never belongs in the client. */
  recoveryPublicKeyPem?: string;
}

export type QueueRecoveryConfigV1 =
  | { available: true; algorithm: "RSA-OAEP-256"; scope: "queue_only"; publicKey: string }
  | { available: false; algorithm: "RSA-OAEP-256"; scope: "queue_only"; publicKey: null };
export type QueueRecoveryStatus = "available" | "not-configured" | "unavailable";

export const OFFLINE_DB_NAME = "bombo-delivery-offline-v1";
export const OFFLINE_DB_VERSION = 1;
export const QUEUE_STORE = "outbox";
export const RECORD_STORE = "records";
export const DOCUMENT_STORE = "documents";
export const REQUIRED_PASSPHRASE_CODEPOINTS = 15;
export const PBKDF2_ITERATIONS = 600_000;

export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === "string" && /^(0|[1-9]\d{0,25})(\.\d{1,12})?$/.test(value);
}

export function isMinorUnitString(value: unknown): value is MinorUnitString {
  return typeof value === "string" && /^(0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
}

export function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || [...passphrase].length < REQUIRED_PASSPHRASE_CODEPOINTS) {
    throw new Error("La frase de acceso debe tener al menos 15 caracteres.");
  }
}

export function assertManifest(value: DeliveryManifestV1): void {
  if (!value || value.version !== 1 || !value.userId || !value.deviceId || !value.leaseId) {
    throw new TypeError("El manifiesto de entrega no corresponde al contrato v1.");
  }
  if (!Number.isSafeInteger(value.authorizationEpoch) || value.authorizationEpoch < 1) {
    throw new TypeError("La época de autorización del manifiesto no es válida.");
  }
  const certification = value.storageCertification;
  if (!certification || typeof certification !== "object" || certification.persistent !== true ||
    typeof certification.storageCertifiedAt !== "string" || !Number.isFinite(Date.parse(certification.storageCertifiedAt))) {
    throw new TypeError("El dispositivo no tiene una certificación vigente de almacenamiento persistente.");
  }
  if (!Array.isArray(value.assignments)) throw new TypeError("El manifiesto no incluye entregas.");
  const seen = new Set<string>();
  for (const assignment of value.assignments) {
    if (!assignment.id || !assignment.orderId || !Number.isSafeInteger(assignment.version) || assignment.version < 0) {
      throw new TypeError("Una entrega del manifiesto tiene identidad o versión inválida.");
    }
    if (seen.has(assignment.id)) throw new TypeError("El manifiesto repite una identidad de entrega.");
    seen.add(assignment.id);
    if (assignment.route !== undefined && (!assignment.route || typeof assignment.route.date !== "string" || !assignment.route.date ||
      !Number.isSafeInteger(assignment.route.stop) || assignment.route.stop < 1 ||
      (assignment.route.eta !== undefined && typeof assignment.route.eta !== "string") ||
      typeof assignment.route.etaIsEstimate !== "boolean")) {
      throw new TypeError("El contexto de ruta del manifiesto no es válido.");
    }
    if (!Array.isArray(assignment.lines) || !Array.isArray(assignment.documents)) {
      throw new TypeError("Una entrega no incluye líneas o documentos en formato de lista.");
    }
    const documentIds = new Set<string>();
    for (const document of assignment.documents) {
      if (!document || typeof document.id !== "string" || !document.id || documentIds.has(document.id) ||
        typeof document.url !== "string" || !document.url ||
        typeof document.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(document.sha256) ||
        !Number.isSafeInteger(document.byteLength) || document.byteLength < 1 || document.byteLength > 3_000_000 ||
        typeof document.mimeType !== "string" || !["application/pdf", "image/png", "image/jpeg"].includes(document.mimeType) ||
        typeof document.version !== "string" || !document.version) {
        throw new TypeError("Un documento del turno no incluye versión, checksum, tamaño o tipo verificables.");
      }
      documentIds.add(document.id);
    }
    if (!isMinorUnitString(assignment.totalMinor)) throw new TypeError("El total del manifiesto debe expresarse en unidades menores exactas.");
    if (assignment.currency !== "ARS" && assignment.currency !== "USD") throw new TypeError("Moneda no admitida.");
    for (const line of assignment.lines) {
      if (!line.id) throw new TypeError("Una línea de entrega no tiene identidad.");
      for (const [key, field] of Object.entries(line)) {
        if (/(?:Minor|minor)$/.test(key) && !isMinorUnitString(field)) {
          throw new TypeError(`El campo ${key} debe expresarse en unidades menores como texto entero.`);
        }
        if (/(?:quantity|requested|prepared|delivered|remaining|returned)$/i.test(key) && field != null && !isDecimalString(field)) {
          throw new TypeError(`El campo ${key} debe expresarse como decimal exacto en texto.`);
        }
      }
    }
  }
}

export function assertExactCommandData(value: unknown, path = "data"): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Los datos del comando deben ser un objeto.");
  const visit = (node: unknown, currentPath: string): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      const fieldPath = `${currentPath}.${key}`;
      if (/(?:Minor|minor)$/.test(key) && !isMinorUnitString(child)) {
        throw new TypeError(`${fieldPath} debe ser un texto entero de unidades menores.`);
      }
      if (/(?:quantity|requested|prepared|delivered|remaining|returned)$/i.test(key) && child != null && !isDecimalString(child)) {
        throw new TypeError(`${fieldPath} debe ser un decimal exacto en texto.`);
      }
      if (typeof child === "number" && /(?:amount|monto|importe|price|precio|total|quantity|cantidad|minor|decimal)/i.test(key)) {
        throw new TypeError(`${fieldPath} no puede usar un número binario de JavaScript.`);
      }
      visit(child, fieldPath);
    }
  };
  visit(value, path);
}
