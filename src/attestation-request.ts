import type { DecisionInputAttestationInput } from "../shared/operations/decision-inputs";

export type AttestationRequestScope = "decision-inputs" | "finance-payables";

export interface PendingAttestationRequest {
  requestId: string;
  fingerprint: string;
}

export type PendingAttestationRead =
  | { ok: true; record: PendingAttestationRequest | null }
  | { ok: false; record: null };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fingerprintPattern = /^[0-9a-f]{64}$/;

async function sha256(value: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle || typeof TextEncoder === "undefined") return null;
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

async function storageKey(scope: AttestationRequestScope, userId: string): Promise<string | null> {
  const userFingerprint = await sha256(userId);
  return userFingerprint ? `bombo:pending-attestation:${scope}:${userFingerprint}` : null;
}

export async function fingerprintAttestationPayload(input: DecisionInputAttestationInput, userId: string): Promise<string | null> {
  const { requestId: _requestId, ...payload } = input;
  return sha256(JSON.stringify({ userId, payload }));
}

export async function readPendingAttestationRequest(scope: AttestationRequestScope, userId: string): Promise<PendingAttestationRead> {
  const key = await storageKey(scope, userId);
  if (!key || typeof window === "undefined") return { ok: false, record: null };
  try {
    const raw = window.sessionStorage.getItem(key);
    if (raw === null) return { ok: true, record: null };
    const value = JSON.parse(raw) as Partial<PendingAttestationRequest>;
    if (typeof value.requestId !== "string" || !uuidPattern.test(value.requestId) || typeof value.fingerprint !== "string" || !fingerprintPattern.test(value.fingerprint)) {
      // Corrupt recovery metadata could represent a request whose response was
      // lost. Treat it as unavailable instead of clearing it and allowing a new
      // write with a different id.
      return { ok: false, record: null };
    }
    return { ok: true, record: { requestId: value.requestId, fingerprint: value.fingerprint } };
  } catch {
    return { ok: false, record: null };
  }
}

export async function writePendingAttestationRequest(scope: AttestationRequestScope, userId: string, record: PendingAttestationRequest): Promise<boolean> {
  const key = await storageKey(scope, userId);
  if (!key || typeof window === "undefined" || !uuidPattern.test(record.requestId) || !fingerprintPattern.test(record.fingerprint)) return false;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(record));
    const stored = window.sessionStorage.getItem(key);
    if (!stored) return false;
    const value = JSON.parse(stored) as Partial<PendingAttestationRequest>;
    return value.requestId === record.requestId && value.fingerprint === record.fingerprint;
  } catch {
    return false;
  }
}

export async function clearPendingAttestationRequest(scope: AttestationRequestScope, userId: string, requestId: string): Promise<void> {
  const key = await storageKey(scope, userId);
  if (!key || typeof window === "undefined") return;
  try {
    const current = await readPendingAttestationRequest(scope, userId);
    if (current.ok && current.record?.requestId === requestId) window.sessionStorage.removeItem(key);
  } catch {
    // Recovery metadata is best-effort and contains no source text.
  }
}
