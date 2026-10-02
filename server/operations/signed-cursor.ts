import { createHmac, timingSafeEqual } from "node:crypto";

function signature(domain: string, payload: string) {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("El cursor requiere la clave de sesión configurada.");
  return createHmac("sha256", secret).update(`bombo.cursor/${domain}\0${payload}`).digest();
}
export function signCursor(domain: string, value: unknown) {
  const payload = JSON.stringify(value);
  return Buffer.from(JSON.stringify({ payload, signature: signature(domain, payload).toString("hex") })).toString("base64url");
}
export function verifyCursor(domain: string, token: string): unknown {
  const envelope: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Cursor inválido");
  const record = envelope as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.payload !== "string" || typeof record.signature !== "string" || !/^[a-f0-9]{64}$/.test(record.signature)) throw new Error("Cursor inválido");
  const actual = Buffer.from(record.signature, "hex"), expected = signature(domain, record.payload);
  if (!timingSafeEqual(actual, expected)) throw new Error("Cursor alterado");
  return JSON.parse(record.payload);
}
