import type { IncomingMessage, ServerResponse } from "node:http";
import { waitUntil } from "@vercel/functions";
import { app } from "../server/app.js";
import { ensureServerReady } from "../server/startup.js";
import { processOperationOutbox } from "../server/operations/outbox.js";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try { await ensureServerReady(); }
  catch {
    res.statusCode = 503;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "30");
    res.end(JSON.stringify({ error: "El servicio requiere revisar su configuración o conexión.", code: "SERVICE_NOT_READY" }));
    return;
  }
  // Durable events were committed with their command. No persistent timer in serverless.
  if (req.method === "POST" && /^\/api\/(operations|delivery|legacy-imports)\//.test(req.url ?? ""))
    res.once("finish", () => { if(res.statusCode < 200 || res.statusCode >= 300) return;
      waitUntil(processOperationOutbox(25).catch(() => {
      console.error("La outbox requiere revisión; los hechos confirmados siguen conservados.");
    })); });
  app(req, res);
}
