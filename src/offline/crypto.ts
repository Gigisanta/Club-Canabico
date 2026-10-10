import { PBKDF2_ITERATIONS } from "./contracts";
import { canonicalJson } from "../../shared/operations/exact";

export { canonicalJson } from "../../shared/operations/exact";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AES_GCM = { name: "AES-GCM", length: 256 } as const;

export interface CiphertextV1 {
  algorithm: "AES-256-GCM";
  iv: string;
  ciphertext: string;
}

export interface WrappedKeyV1 {
  algorithm: "AES-256-GCM";
  iv: string;
  ciphertext: string;
}

export interface KeyringV1 {
  schemaVersion: 1;
  userId: string;
  deviceId: string;
  kdf: {
    name: "PBKDF2";
    hash: "SHA-256";
    iterations: 600000;
    salt: string;
  };
  queueKey: WrappedKeyV1;
  documentKey: WrappedKeyV1;
  /** Server recovery escrow contains only this RSA-wrapped queue key. */
  queueRecoveryWrappedKey?: string;
}

export interface QueueRecoveryWrappedKeyV1 {
  algorithm: "RSA-OAEP-256";
  ciphertext: string;
}

export interface UnlockedKeys {
  queue: CryptoKey;
  documents: CryptoKey;
}

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error("Este navegador no ofrece cifrado seguro para el modo sin conexión.");
  }
  return globalThis.crypto;
}

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  cryptoApi().getRandomValues(bytes);
  return bytes;
}

export function stableUUID(): string {
  const source = randomBytes(16);
  source[6] = (source[6]! & 0x0f) | 0x40;
  source[8] = (source[8]! & 0x3f) | 0x80;
  const hex = [...source].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function aadFor(userId: string, deviceId: string, kind: string, objectId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`bombo-offline:v1|${userId}|${deviceId}|${kind}|${objectId}`);
}

export function encodeBytes(bytes: Uint8Array): string {
  return toBase64(bytes);
}

export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  return fromBase64(value);
}

export async function derivePassphraseKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const subtle = cryptoApi().subtle;
  const material = await subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: ownedBytes(salt), iterations: PBKDF2_ITERATIONS },
    material,
    AES_GCM,
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createKeyring(
  userId: string,
  deviceId: string,
  passphrase: string,
  recoveryPublicKeyPem?: string,
): Promise<{ keyring: KeyringV1; keys: UnlockedKeys }> {
  const salt = randomBytes(16);
  const queueRaw = randomBytes(32);
  const documentRaw = randomBytes(32);
  const wrappingKey = await derivePassphraseKey(passphrase, salt);
  const queue = await cryptoApi().subtle.importKey("raw", queueRaw, AES_GCM, false, ["encrypt", "decrypt"]);
  const documents = await cryptoApi().subtle.importKey("raw", documentRaw, AES_GCM, false, ["encrypt", "decrypt"]);
  const queueRecoveryWrappedKey = recoveryPublicKeyPem
    ? await wrapQueueKeyForRecovery(queueRaw, recoveryPublicKeyPem)
    : undefined;
  const keyring: KeyringV1 = {
    schemaVersion: 1,
    userId,
    deviceId,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    queueKey: await wrapRawKey(queueRaw, wrappingKey, aadFor(userId, deviceId, "keyring", "queue")),
    documentKey: await wrapRawKey(documentRaw, wrappingKey, aadFor(userId, deviceId, "keyring", "documents")),
    ...(queueRecoveryWrappedKey ? { queueRecoveryWrappedKey } : {}),
  };
  queueRaw.fill(0);
  documentRaw.fill(0);
  return { keyring, keys: { queue, documents } };
}

async function wrapRawKey(raw: Uint8Array, key: CryptoKey, additionalData: Uint8Array): Promise<WrappedKeyV1> {
  const iv = randomBytes(12);
  const clear = ownedBytes(raw);
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await cryptoApi().subtle.encrypt({ name: "AES-GCM", iv, additionalData: ownedBytes(additionalData), tagLength: 128 }, key, clear);
  } finally {
    clear.fill(0);
  }
  return { algorithm: "AES-256-GCM", iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

async function unwrapRawKey(wrapped: WrappedKeyV1, key: CryptoKey, additionalData: Uint8Array): Promise<CryptoKey> {
  const raw = new Uint8Array(await cryptoApi().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(wrapped.iv), additionalData: ownedBytes(additionalData), tagLength: 128 },
    key,
    fromBase64(wrapped.ciphertext),
  ));
  try {
    return await cryptoApi().subtle.importKey("raw", raw, AES_GCM, false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

export async function unlockKeyring(keyring: KeyringV1, passphrase: string): Promise<UnlockedKeys> {
  if (keyring.schemaVersion !== 1 || keyring.kdf.name !== "PBKDF2" || keyring.kdf.hash !== "SHA-256" || keyring.kdf.iterations !== PBKDF2_ITERATIONS) {
    throw new Error("El respaldo usa una configuración criptográfica no admitida.");
  }
  const wrappingKey = await derivePassphraseKey(passphrase, fromBase64(keyring.kdf.salt));
  const [queue, documents] = await Promise.all([
    unwrapRawKey(keyring.queueKey, wrappingKey, aadFor(keyring.userId, keyring.deviceId, "keyring", "queue")),
    unwrapRawKey(keyring.documentKey, wrappingKey, aadFor(keyring.userId, keyring.deviceId, "keyring", "documents")),
  ]);
  return { queue, documents };
}

function parsePublicKeyPem(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----/g, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new TypeError("La clave pública RSA de recuperación no tiene formato PEM válido.");
  return fromBase64(body);
}

async function wrapQueueKeyForRecovery(rawKey: Uint8Array, publicKeyPem: string): Promise<string> {
  const publicKey = await cryptoApi().subtle.importKey(
    "spki",
    parsePublicKeyPem(publicKeyPem),
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const clear = ownedBytes(rawKey);
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await cryptoApi().subtle.encrypt({ name: "RSA-OAEP" }, publicKey, clear);
  } finally {
    clear.fill(0);
  }
  return toBase64(new Uint8Array(ciphertext));
}

/** Rewraps only the queue key after the user supplies their passphrase again. */
export async function addQueueRecoveryWrap(
  keyring: KeyringV1,
  passphrase: string,
  publicKeyPem: string,
): Promise<KeyringV1> {
  const wrappingKey = await derivePassphraseKey(passphrase, fromBase64(keyring.kdf.salt));
  const rawQueueKey = new Uint8Array(await cryptoApi().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(keyring.queueKey.iv), additionalData: aadFor(keyring.userId, keyring.deviceId, "keyring", "queue"), tagLength: 128 },
    wrappingKey,
    fromBase64(keyring.queueKey.ciphertext),
  ));
  try {
    return { ...keyring, queueRecoveryWrappedKey: await wrapQueueKeyForRecovery(rawQueueKey, publicKeyPem) };
  } finally {
    rawQueueKey.fill(0);
  }
}

export interface QueueRecoverySessionV1 {
  publicKeyPem: string;
  /** Keep this key only in memory for one approved recovery operation. */
  privateKey: CryptoKey;
}

export async function createQueueRecoverySession(): Promise<QueueRecoverySessionV1> {
  const pair = await cryptoApi().subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    false,
    ["encrypt", "decrypt"],
  ) as CryptoKeyPair;
  const publicDer = new Uint8Array(await cryptoApi().subtle.exportKey("spki", pair.publicKey));
  const b64 = toBase64(publicDer).match(/.{1,64}/g)?.join("\n") ?? "";
  return { publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`, privateKey: pair.privateKey };
}

export async function unwrapRecoveredQueueKey(
  wrapped: QueueRecoveryWrappedKeyV1 | string,
  privateKey: CryptoKey,
): Promise<CryptoKey> {
  const ciphertext = typeof wrapped === "string" ? wrapped : wrapped.ciphertext;
  if (typeof wrapped !== "string" && wrapped.algorithm !== "RSA-OAEP-256") throw new Error("La clave de recuperación usa un algoritmo no admitido.");
  const raw = new Uint8Array(await cryptoApi().subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    fromBase64(ciphertext),
  ));
  try {
    if (raw.byteLength !== 32) throw new Error("La clave de recuperación de la cola no tiene 256 bits.");
    return await cryptoApi().subtle.importKey("raw", raw, AES_GCM, false, ["encrypt", "decrypt"]);
  } finally {
    raw.fill(0);
  }
}

export async function encryptBytes(bytes: Uint8Array, key: CryptoKey, additionalData: Uint8Array): Promise<CiphertextV1> {
  const iv = randomBytes(12);
  const clear = ownedBytes(bytes);
  let ciphertext: ArrayBuffer;
  try {
    ciphertext = await cryptoApi().subtle.encrypt({ name: "AES-GCM", iv, additionalData: ownedBytes(additionalData), tagLength: 128 }, key, clear);
  } finally {
    clear.fill(0);
  }
  return { algorithm: "AES-256-GCM", iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptBytes(encrypted: CiphertextV1, key: CryptoKey, additionalData: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (encrypted.algorithm !== "AES-256-GCM") throw new Error("Algoritmo de cifrado no admitido.");
  const decrypted = await cryptoApi().subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(encrypted.iv), additionalData: ownedBytes(additionalData), tagLength: 128 },
    key,
    fromBase64(encrypted.ciphertext),
  );
  return new Uint8Array(decrypted);
}

export async function encryptJson(value: unknown, key: CryptoKey, additionalData: Uint8Array): Promise<CiphertextV1> {
  return encryptBytes(encoder.encode(JSON.stringify(value)), key, additionalData);
}

export async function decryptJson<T>(encrypted: CiphertextV1, key: CryptoKey, additionalData: Uint8Array): Promise<T> {
  const bytes = await decryptBytes(encrypted, key, additionalData);
  try {
    return JSON.parse(decoder.decode(bytes)) as T;
  } finally {
    bytes.fill(0);
  }
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await cryptoApi().subtle.digest("SHA-256", ownedBytes(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
