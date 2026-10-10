import type { CommandEnvelopeV1, JsonRecord, OperationsContext } from "./types";

export class OperationsApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = "OperationsApiError";
  }
}

type OperationsSessionExpiryListener = (error: OperationsApiError) => void;
const operationsSessionExpiryListeners = new Set<OperationsSessionExpiryListener>();

export function onOperationsSessionExpired(listener: OperationsSessionExpiryListener) {
  operationsSessionExpiryListeners.add(listener);
  return () => { operationsSessionExpiryListeners.delete(listener); };
}

function notifyOperationsSessionExpired(error: OperationsApiError) {
  for (const listener of operationsSessionExpiryListeners) {
    try {
      listener(error);
    } catch {
      // A UI observer must not replace the API's original authentication error.
    }
  }
}

export function isUncertainCommandOutcome(error: unknown) {
  return error instanceof OperationsApiError && (error.status === 0 || error.status >= 500 || error.code === "INVALID_RESPONSE");
}

function safeMessage(payload: unknown, status: number): { message: string; code?: string } {
  const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const code = typeof value.code === "string" ? value.code : undefined;
  const raw = typeof value.message === "string" ? value.message : typeof value.error === "string" ? value.error : "";
  const known: Record<string, string> = {
    OPERATION_AUTHORITY_PENDING: "El circuito sigue en sombra y esta escritura necesita una habilitación explícita.",
    CAPABILITY_REQUIRED: "Tu perfil no tiene permiso para esta acción.",
    AUTHORIZATION_REVOKED: "La autorización cambió. Actualizá la sesión para continuar.",
    VERSION_CONFLICT: "El registro cambió en otra sesión. Actualizá la vista y revisalo antes de reintentar.",
    IDEMPOTENCY_KEY_REUSED: "El servidor detectó un UUID repetido con otro contenido. Actualizá la vista y volvé a preparar la acción.",
    DOCUMENT_INTEGRITY: "El archivo no coincide con su checksum o tipo declarado.",
    IMPORT_RECORD_LIMIT: "El archivo supera el máximo de registros admitido para esta vista previa.",
    LEGACY_TECHNICAL_SOURCE_BLOCKED: "Esta fuente se consulta en Datos cargados y conciliación. Su archivo original no se aprueba ni se publica como operación.",
  };
  if (code && known[code]) return { message: known[code], code };
  if (raw && raw.length <= 240 && !raw.startsWith("{")) return { message: raw, code };
  if (status === 401) return { message: "Iniciá sesión para consultar Operaciones.", code };
  if (status === 403) return { message: "Tu perfil o alcance actual no permite consultar estos datos.", code };
  if (status === 404) return { message: "Esta ruta todavía no está disponible en el servidor conectado.", code };
    if (status === 423) return { message: "La operación está bloqueada por una habilitación pendiente.", code };
  return { message: "No se pudo completar la solicitud. Revisá la conexión y el estado antes de reintentar.", code };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: "include",
      cache: "no-store",
      ...init,
      headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    });
  } catch (cause) {
    if (init?.signal?.aborted || (cause instanceof Error && cause.name === "AbortError")) throw cause;
    throw new OperationsApiError("No hay conexión con Bombo. Conservá los datos del formulario e intentá otra vez.", 0, "NETWORK_ERROR");
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = safeMessage(payload, response.status);
    const error = new OperationsApiError(detail.message, response.status, detail.code);
    if (response.status === 401) notifyOperationsSessionExpired(error);
    throw error;
  }
  if (!payload || typeof payload !== "object") {
    throw new OperationsApiError("La respuesta no permite confirmar el registro. Reintentá la misma acción para recuperar su comprobante.", response.status, "INVALID_RESPONSE");
  }
  return payload as T;
}

export const apiGet = <T,>(path: string, init?: RequestInit) => request<T>(path, init);
export const apiPost = <T,>(path: string, data: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(data) });

export async function loadOperationsContext() {
  return apiGet<OperationsContext>("/api/operations/context");
}

export function hasCapability(context: OperationsContext | null, capability: string) {
  return Boolean(context?.capabilities.includes(capability));
}

export function hasCommand(context: OperationsContext | null, command: string) {
  return Boolean(context?.commands.some(item => item.command === command));
}

export class CommandRunner {
  private pending = new Map<string, CommandEnvelopeV1>();

  async run(command: string, targetId: string, expectedVersion: number, data: JsonRecord, requestIdIsTarget = false) {
    const fingerprint = JSON.stringify([command, targetId, expectedVersion, data]);
    let envelope = this.pending.get(fingerprint);
    if (!envelope) {
      const requestId = requestIdIsTarget ? targetId : crypto.randomUUID();
      envelope = {
        schemaVersion: 1,
        requestId,
        targetId,
        expectedVersion,
        occurredAt: new Date().toISOString(),
        command,
        data,
      };
      this.pending.set(fingerprint, envelope);
    }
    try {
      const result = await apiPost("/api/operations/commands", envelope);
      const receipt = result as Record<string, unknown> | null;
      if (!receipt || receipt.requestId !== envelope.requestId || receipt.targetId !== envelope.targetId || receipt.version !== envelope.expectedVersion + 1 || !Number.isSafeInteger(receipt.version) || !Object.hasOwn(receipt, "result")) {
        throw new OperationsApiError("El comprobante recibido no permite confirmar esta acción. Recuperalo con el mismo comando.", 200, "INVALID_RESPONSE");
      }
      this.pending.delete(fingerprint);
      return result;
    } catch (error) {
      // Repeated submit with identical data reuses the same UUID after an uncertain network result.
      throw error;
    }
  }
}

export function responseItems<T>(response: unknown): T[] {
  if (!response || typeof response !== "object") return [];
  const items = (response as Record<string, unknown>).items;
  return Array.isArray(items) ? items as T[] : [];
}

export function responseVersion(response: unknown, id: string, fallback = 0): number {
  if (!response || typeof response !== "object") return fallback;
  const versions = (response as Record<string, unknown>).versions;
  if (!versions || typeof versions !== "object") return fallback;
  const value = (versions as Record<string, unknown>)[id];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

export function recordValue(record: unknown, key: string): unknown {
  return record && typeof record === "object" ? (record as Record<string, unknown>)[key] : undefined;
}

export function textValue(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.length) return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return value.toString();
  return fallback;
}

export function recordLabel(record: unknown, keys: string[] = ["name", "label", "title", "id"]): string {
  for (const key of keys) {
    const value = recordValue(record, key);
    if (typeof value === "string" && value.length) return value;
  }
  return "Registro sin nombre";
}
