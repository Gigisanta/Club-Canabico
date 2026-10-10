#!/usr/bin/env node
import { readFile, open, rename, mkdir, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { readLegacyWorkbook } from "../server/operations/legacy-reader.js";
import { legacyPayloadHash, LEGACY_CHUNK_BYTES, LEGACY_CHUNK_RECORDS, LEGACY_UPLOAD_BYTES } from "../server/operations/legacy-upload-contract.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

// Only safe provenance/checkpoints are written. Workbook, rows and authentication stay in memory.
process.umask(0o077);
const args = process.argv.slice(2);
function option(name: string) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
if (args.includes("--help") || !option("--file")) {
  console.log("Uso: npm run ops:import -- --file /ruta/original.xlsx [--preview] [--url https://bombo.maat.work] [--source appsheet] [--checkpoint /ruta/privada.json]\nEl preview lee y filtra localmente. Para importar se autentica en memoria; --cookie-stdin admite una sesión por stdin sin guardarla.");
  process.exit(args.includes("--help") ? 0 : 1);
}
const sourceSystem = option("--source") ?? "appsheet";
if (!/^[a-zA-Z0-9._-]{1,120}$/.test(sourceSystem)) throw new Error("Identificador de fuente inválido.");
const base = new URL(option("--url") ?? "https://bombo.maat.work");
if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || !(base.protocol === "https:" || base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)))
  throw new Error("El destino debe ser un origen HTTPS, o loopback HTTP para ensayo.");
const original = await readFile(resolve(option("--file")!));
const snapshot = await readLegacyWorkbook(original, { sourceSystem });
const chunks: Array<{ index: number; records: typeof snapshot.records; contentHash: string }> = [];
let current: typeof snapshot.records = [];
let currentBytes = 2; // JSON array brackets; each record is serialized once for sizing.
function flush() { if (current.length) { chunks.push({ index: chunks.length, records: current, contentHash: legacyPayloadHash(current) }); current = []; currentBytes = 2; } }
for (const record of snapshot.records) {
  const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
  if (recordBytes + 2 > LEGACY_CHUNK_BYTES - 2048) throw new Error("Una fila excede el límite de transporte; requiere resolución, sin truncarla.");
  if (current.length === LEGACY_CHUNK_RECORDS || currentBytes + recordBytes + (current.length ? 1 : 0) > LEGACY_CHUNK_BYTES - 2048) flush();
  currentBytes += recordBytes + (current.length ? 1 : 0);
  current.push(record);
}
flush();
if (chunks.reduce((sum, chunk) => sum + Buffer.byteLength(JSON.stringify(chunk)) + 2048, 0) > LEGACY_UPLOAD_BYTES) throw new Error("La fuente filtrada supera 128 MiB; requiere partición explícita, sin truncarla.");
const manifest = { chunks: chunks.map(chunk => ({ index: chunk.index, contentHash: chunk.contentHash, recordCount: chunk.records.length })), recordsByTable: Object.fromEntries(snapshot.sheets.filter(sheet => sheet.recordCount).map(sheet => [sheet.name, sheet.recordCount])) };
const manifestHash = legacyPayloadHash(manifest);
console.log(JSON.stringify({ mode: args.includes("--preview") ? "local-preview" : "local-filtered-import", fileHash: snapshot.fileHash, importerVersion: snapshot.importerVersion, sheets: snapshot.summary.sheetCount, records: snapshot.records.length, chunks: chunks.length, excludedCredentialColumns: snapshot.sheets.reduce((count, sheet) => count + sheet.excludedCredentialColumns, 0), manifestHash }));
if (args.includes("--preview")) process.exit(0);
const checkpointPath = resolve(option("--checkpoint") ?? `.local/import-checkpoints/${legacyPayloadHash({ sourceSystem, fileHash: snapshot.fileHash, importerVersion: snapshot.importerVersion })}.json`);
type ReceiptMetadata = Pick<CommandEnvelope, "requestId" | "expectedVersion" | "occurredAt">;
type Checkpoint = { origin: string; targetId: string; manifestHash: string; requests: Record<string, ReceiptMetadata> };
let checkpoint: Checkpoint;
try { checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")); if (checkpoint.manifestHash !== manifestHash || !checkpoint.targetId || !checkpoint.requests || checkpoint.origin && checkpoint.origin !== base.origin) throw new Error("Checkpoint de otra fuente o versión."); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; checkpoint = { origin: base.origin, targetId: `legacy-${legacyPayloadHash({ sourceSystem, fileHash: snapshot.fileHash, importerVersion: snapshot.importerVersion })}`, manifestHash, requests: {} }; }
checkpoint.origin = base.origin;
async function saveCheckpoint() {
  await mkdir(dirname(checkpointPath), { recursive: true, mode: 0o700 });
  const temporary = `${checkpointPath}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(checkpoint)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, checkpointPath);
    const parent = await open(dirname(checkpointPath), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
}
let cookie: string;
if (args.includes("--cookie-stdin")) { let input = ""; for await (const part of process.stdin) { input += part.toString(); if (input.length > 8192) throw new Error("Sesión demasiado larga."); } cookie = input.trim(); }
else {
  if (!process.stdin.isTTY) throw new Error("Autenticación interactiva requiere TTY; la sesión puede recibirse por stdin.");
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stderr.write(chunk); done(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const email = await rl.question("Email: "); process.stderr.write("Clave (no se guarda): "); muted = true;
  const password = await rl.question(""); muted = false; process.stderr.write("\n"); rl.close();
  const response = await fetch(new URL("/api/auth/login", base), { method: "POST", redirect: "error", headers: { Origin: option("--origin") ?? base.origin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Autenticación rechazada (${response.status}).`);
  cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
}
if (!cookie || /[\r\n]/.test(cookie)) throw new Error("Sesión inválida.");
async function request(path: string, body?: unknown) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(new URL(`/api/legacy-imports${path}`, base), { method: body ? "POST" : "GET", redirect: "error", headers: { Cookie: cookie, Origin: option("--origin") ?? base.origin, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
      if ([408, 429, 500, 502, 503, 504].includes(response.status) && attempt < 4) { await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt)); continue; }
      return response;
    } catch (error) { if (attempt >= 4) throw new Error("No se pudo confirmar la solicitud. Retomá con el mismo checkpoint.", { cause: error }); await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt)); }
  }
}
async function command(key: string, suffix: string, name: string, data: Record<string, unknown>, version: number) {
  checkpoint.requests[key] ??= { requestId: randomUUID(), expectedVersion: version, occurredAt: new Date().toISOString() }; await saveCheckpoint();
  const envelope: CommandEnvelope = { schemaVersion: 1, targetId: checkpoint.targetId, command: name, data, ...checkpoint.requests[key]! };
  if (Buffer.byteLength(JSON.stringify(envelope)) > LEGACY_CHUNK_BYTES) throw new Error("El cuerpo supera 512 KiB; no se envió.");
  const response = await request(suffix, envelope);
  if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(`Importación rechazada (${response.status}, ${typeof failure.code === "string" ? failure.code : "API_ERROR"}); checkpoint conservado.`); }
  const result = await response.json(); if (result.result?.status === "quarantined") throw new Error("La carga quedó en cuarentena; no se puede activar ni continuar automáticamente.");
  return result.version as number;
}
let status = await request(`/batches/${checkpoint.targetId}`), version = 0, received: Array<{ index: number; contentHash: string }> = [];
if (status.status === 404) {
  version = await command("begin", "/batches", "LegacyUploadBegun", { sourceSystem, filename: basename(option("--file")!), fileHash: snapshot.fileHash, importerVersion: snapshot.importerVersion, manifest, manifestHash, controls: snapshot.summary, coverage: snapshot.sheets }, 0);
} else {
  if (!status.ok) throw new Error(`No se pudo consultar el lote (${status.status}).`);
  const stored = await status.json(); if (stored.manifestHash !== manifestHash || stored.fileHash !== snapshot.fileHash || stored.importerVersion !== snapshot.importerVersion) throw new Error("El lote remoto no corresponde a la fuente local.");
  if (stored.status === "quarantined") throw new Error("Lote en cuarentena; requiere revisión autorizada.");
  if (["staged", "reviewed"].includes(stored.status)) { console.log(JSON.stringify({ snapshotId: checkpoint.targetId, status: stored.status, alreadyCompleted: true })); process.exit(0); }
  version = stored.version; received = stored.chunks;
}
for (const chunk of chunks) {
  const existing = received.find(stored => stored.index === chunk.index);
  if (existing) { if (existing.contentHash !== chunk.contentHash) throw new Error("El fragmento remoto difiere del local."); continue; }
  version = await command(`chunk:${chunk.index}`, `/batches/${checkpoint.targetId}/chunks`, "LegacyUploadChunkStored", chunk, version);
  console.log(JSON.stringify({ snapshotId: checkpoint.targetId, receivedChunk: chunk.index + 1, totalChunks: chunks.length }));
}
await command("finalize", `/batches/${checkpoint.targetId}/finalize`, "LegacyUploadFinalized", { manifestHash }, version);
console.log(JSON.stringify({ snapshotId: checkpoint.targetId, status: "staged", requiresIndependentReview: true }));
