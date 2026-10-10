import { db } from "./db.js";

let readiness: Promise<void> | undefined;
/** One validation per warm instance, shared by concurrent requests. Failed starts may retry. */
export function ensureServerReady(): Promise<void> {
  return readiness ??= validate().catch(error => { readiness = undefined; throw error; });
}
async function validate() {
  if (process.env.NODE_ENV === "production") {
    if (process.env.DEMO_MODE === "true" || process.env.OPERATIONAL_REHEARSAL === "true")
      throw new Error("El ensayo operativo no puede habilitarse en producción.");
    if (process.env.COOKIE_SECURE !== "true" || !process.env.ALLOWED_ORIGIN?.split(",").every(origin => /^https:\/\/[^/]+$/.test(origin)))
      throw new Error("Producción requiere cookies seguras y orígenes HTTPS exactos.");
    if (!process.env.PRIVATE_S3_BUCKET && process.env.PRIVATE_OBJECT_PROVIDER !== "vercel-blob")
      throw new Error("Producción requiere almacenamiento privado de versiones inmutables.");
    if (process.env.PRIVATE_OBJECT_PROVIDER === "vercel-blob" && !process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN)
      throw new Error("El almacén privado de Bombo no está conectado.");
  }
  if (process.env.DEMO_MODE !== "true" && /demo/i.test(new URL(process.env.DATABASE_URL || "").pathname))
    throw new Error("La conexión apunta a una base de demostración.");
  await db.$connect();
  if (process.env.DEMO_MODE !== "true" && await db.user.count({ where: { email: { endsWith: "@demo.bombo.local" } } }))
    throw new Error("Base de demostración detectada. Usá una base real separada.");
}
