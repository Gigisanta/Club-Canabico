import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { executeCommand, registerCommand, requireCapability, OperationError, envelopeSchema, json, wire, type CommandContext } from "./core.js";
import { sourceRecordSchema } from "./legacy-source-contract.js";
import { containsRecognizableCredential } from "./legacy-reader.js";
import { LEGACY_CHUNK_BYTES, LEGACY_CHUNK_RECORDS, LEGACY_UPLOAD_BYTES, legacyPayloadHash } from "./legacy-upload-contract.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(100);
const tableCounts = z.record(z.string().min(1).max(120), z.number().int().min(0).max(100_000));
const manifestSchema = z.strictObject({
  chunks: z.array(z.strictObject({ index: z.number().int().min(0).max(99_999), contentHash: hash, recordCount: z.number().int().min(1).max(500) })).max(100_000),
  recordsByTable: tableCounts,
}).superRefine((manifest, ctx) => {
  if (manifest.chunks.some((chunk, index) => chunk.index !== index))
    ctx.addIssue({ code: "custom", message: "Los índices del manifiesto deben ser consecutivos desde cero." });
  const total = manifest.chunks.reduce((sum, chunk) => sum + chunk.recordCount, 0);
  if (total > 100_000 || total !== Object.values(manifest.recordsByTable).reduce((sum, count) => sum + count, 0))
    ctx.addIssue({ code: "custom", message: "Los conteos del manifiesto deben coincidir y no superar 100.000 registros." });
});
const beginSchema = z.strictObject({
  sourceSystem: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
  filename: z.string().min(1).max(180), fileHash: hash,
  importerVersion: z.string().min(1).max(120), manifestHash: hash, manifest: manifestSchema,
  controls: z.record(z.string(), z.unknown()), coverage: z.array(z.unknown()).max(64),
}).superRefine((value, ctx) => {
  if (containsRecognizableCredential(value)) ctx.addIssue({ code: "custom", message: "Los metadatos no pueden contener material de autenticación." });
  if (legacyPayloadHash(value.manifest) !== value.manifestHash) ctx.addIssue({ code: "custom", message: "El hash del manifiesto no coincide." });
});
const chunkSchema = z.strictObject({ index: z.number().int().min(0).max(99_999), contentHash: hash, records: z.array(sourceRecordSchema).min(1).max(LEGACY_CHUNK_RECORDS) });

async function ownedUpload(ctx: CommandContext) {
  const snapshot = await ctx.tx.legacyImportSnapshot.findUnique({ where: { id: ctx.envelope.targetId }, include: { upload: true } });
  if (!snapshot?.upload) throw new OperationError(404, "IMPORT_BATCH_NOT_FOUND", "Lote reanudable no encontrado.");
  if (snapshot.createdBy !== ctx.actor.id) throw new OperationError(403, "IMPORT_ACTOR_MISMATCH", "La carga pertenece a otro importador.");
  return snapshot;
}
async function quarantineOnAuthorityChange(ctx: CommandContext, snapshot: Awaited<ReturnType<typeof ownedUpload>>) {
  const authority = await ctx.tx.operationAuthority.findUnique({ where: { id: "operations" }, select: { mode: true, epoch: true } });
  if ((authority?.epoch ?? 1) === snapshot.upload!.cutoverEpoch && (authority?.mode ?? "shadow") === snapshot.upload!.cutoverMode) return false;
  await ctx.tx.legacyImportSnapshot.update({ where: { id: snapshot.id }, data: { status: "quarantined" } });
  await ctx.tx.legacyImportUpload.update({ where: { snapshotId: snapshot.id }, data: { quarantinedAt: ctx.now } });
  await ctx.tx.legacyException.upsert({ where: { id: `${snapshot.id}:authority` }, create: {
    id: `${snapshot.id}:authority`, snapshotId: snapshot.id, kind: "cutover_epoch", severity: "blocking", description: "La autoridad cambió durante la carga.",
    resolution: json({ startedEpoch: snapshot.upload!.cutoverEpoch, currentEpoch: authority?.epoch ?? 1 }),
  }, update: {} });
  return true;
}
registerCommand("LegacyUploadBegun", {
  kind: "legacyImport", capability: "imports.write", create: true, administrative: true, internal: true, schema: beginSchema,
  execute: async ctx => {
    const data = beginSchema.parse(ctx.envelope.data);
    const existing = await ctx.tx.legacyImportSnapshot.findUnique({ where: { sourceSystem_fileHash_importerVersion: { sourceSystem: data.sourceSystem, fileHash: data.fileHash, importerVersion: data.importerVersion } } });
    if (existing) throw new OperationError(409, "IMPORT_ALREADY_STAGED", "Esta fuente y versión ya tienen un lote; retomá su identidad original.", { snapshotId: existing.id });
    const previous = await ctx.tx.legacyImportSnapshot.findFirst({ where: { sourceSystem: data.sourceSystem }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, fileHash: true } });
    const authority = await ctx.tx.operationAuthority.findUnique({ where: { id: "operations" }, select: { mode: true, epoch: true } });
    const mode = authority?.mode ?? "shadow", epoch = authority?.epoch ?? 1;
    const count = data.manifest.chunks.reduce((sum, chunk) => sum + chunk.recordCount, 0);
    await ctx.tx.legacyImportSnapshot.create({ data: {
      id: ctx.envelope.targetId, sourceSystem: data.sourceSystem, filename: data.filename, fileHash: data.fileHash, importerVersion: data.importerVersion,
      status: "uploading", createdBy: ctx.actor.id, coverage: json(data.coverage),
      controls: json({ ...data.controls, requiresChangedContentReview: Boolean(previous && previous.fileHash !== data.fileHash), previousSnapshotId: previous?.id ?? null,
        previousFileHash: previous?.fileHash ?? null, authorityAtStage: { mode, epoch }, cutoverQuarantined: mode === "active", cutoverEpoch: epoch }),
      upload: { create: { manifestHash: data.manifestHash, manifest: json(data.manifest), expectedRecords: count, expectedChunks: data.manifest.chunks.length, cutoverEpoch: epoch, cutoverMode: mode } },
    } });
    return { snapshotId: ctx.envelope.targetId, status: "uploading", expectedRecords: count, expectedChunks: data.manifest.chunks.length };
  },
});
registerCommand("LegacyUploadChunkStored", {
  kind: "legacyImport", capability: "imports.write", administrative: true, internal: true, schema: chunkSchema,
  authorize: async ctx => { await ownedUpload(ctx); },
  execute: async ctx => {
    const snapshot = await ownedUpload(ctx), upload = snapshot.upload!, data = chunkSchema.parse(ctx.envelope.data);
    if (upload.quarantinedAt || await quarantineOnAuthorityChange(ctx, snapshot)) return { snapshotId: snapshot.id, status: "quarantined", accepted: false };
    const manifest = manifestSchema.parse(upload.manifest), expected = manifest.chunks[data.index];
    if (!expected || expected.contentHash !== data.contentHash || expected.recordCount !== data.records.length || legacyPayloadHash(data.records) !== data.contentHash)
      throw new OperationError(409, "IMPORT_CHUNK_HASH_MISMATCH", "El fragmento no coincide con el manifiesto.");
    const old = await ctx.tx.legacyImportChunk.findUnique({ where: { snapshotId_index: { snapshotId: snapshot.id, index: data.index } } });
    if (old) return { snapshotId: snapshot.id, status: snapshot.status, index: data.index, alreadyReceived: true, receivedRecords: upload.receivedRecords };
    if (snapshot.status !== "uploading" || upload.completedAt) throw new OperationError(409, "IMPORT_BATCH_SEALED", "La carga ya está cerrada.");
    const byteCount = ctx.requestBytes ?? Buffer.byteLength(JSON.stringify(ctx.envelope), "utf8");
    if (byteCount > LEGACY_CHUNK_BYTES) throw new OperationError(413, "IMPORT_CHUNK_LIMIT", "El cuerpo del fragmento supera 512 KiB.");
    if (upload.receivedBytes + BigInt(byteCount) > BigInt(LEGACY_UPLOAD_BYTES)) throw new OperationError(413, "IMPORT_BATCH_LIMIT", "El lote supera 128 MiB; requiere una partición explícita de la fuente.");
    for (const record of data.records) {
      const { contentHash, ...content } = record;
      if (record.fileHash !== snapshot.fileHash || record.importerVersion !== snapshot.importerVersion)
        throw new OperationError(409, "IMPORT_SOURCE_MISMATCH", "El fragmento contiene registros de otra fuente o versión.");
      if (legacyPayloadHash(content) !== contentHash) throw new OperationError(409, "IMPORT_RECORD_HASH_MISMATCH", "El contenido de una fila no coincide con su hash.");
    }
    const coordinates = data.records.map(record => ({ sourceTable: record.sourceTable, sourceRow: record.sourceRow }));
    if (new Set(coordinates.map(value => JSON.stringify(value))).size !== coordinates.length || await ctx.tx.legacySourceRecord.findFirst({ where: { snapshotId: snapshot.id, OR: coordinates }, select: { id: true } }))
      throw new OperationError(409, "IMPORT_COORDINATE_REUSED", "Una fila de origen aparece en más de un fragmento.");
    const recordId = (table: string, row: number) => createHash("sha256").update(`${snapshot.id}\0${table}\0${row}`).digest("hex");
    await ctx.tx.legacySourceRecord.createMany({ data: data.records.map(record => ({
      id: recordId(record.sourceTable, record.sourceRow), snapshotId: snapshot.id, sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow,
      fileHash: record.fileHash, contentHash: record.contentHash, importerVersion: record.importerVersion, original: json(record.original), normalized: json(record.normalized), treatment: record.treatment,
    })) });
    const exceptions: Prisma.LegacyExceptionCreateManyInput[] = data.records.flatMap(record => record.exceptions.map((exception, index) => ({
      id: createHash("sha256").update(`${recordId(record.sourceTable, record.sourceRow)}\0${index}\0${exception.kind}`).digest("hex"),
      snapshotId: snapshot.id, sourceRecordId: recordId(record.sourceTable, record.sourceRow), kind: exception.kind, severity: exception.severity, description: exception.kind, resolution: json(exception.evidence),
    })));
    for (let offset = 0; offset < exceptions.length; offset += 500) await ctx.tx.legacyException.createMany({ data: exceptions.slice(offset, offset + 500) });
    await ctx.tx.legacyImportChunk.create({ data: { snapshotId: snapshot.id, index: data.index, contentHash: data.contentHash, recordCount: data.records.length, byteCount } });
    const updated = await ctx.tx.legacyImportUpload.update({ where: { snapshotId: snapshot.id }, data: { receivedRecords: { increment: data.records.length }, receivedBytes: { increment: byteCount } } });
    return { snapshotId: snapshot.id, status: "uploading", index: data.index, receivedRecords: updated.receivedRecords };
  },
});
registerCommand("LegacyUploadFinalized", {
  kind: "legacyImport", capability: "imports.write", administrative: true, internal: true, schema: z.strictObject({ manifestHash: hash }),
  authorize: async ctx => { await ownedUpload(ctx); },
  execute: async ctx => {
    const snapshot = await ownedUpload(ctx), upload = snapshot.upload!;
    if (upload.quarantinedAt || await quarantineOnAuthorityChange(ctx, snapshot)) return { snapshotId: snapshot.id, status: "quarantined", accepted: false };
    if (ctx.envelope.data.manifestHash !== upload.manifestHash) throw new OperationError(409, "IMPORT_MANIFEST_CHANGED", "El manifiesto cambió.");
    if (upload.completedAt) return { snapshotId: snapshot.id, status: snapshot.status, alreadyFinalized: true };
    const chunks = await ctx.tx.legacyImportChunk.findMany({ where: { snapshotId: snapshot.id }, orderBy: { index: "asc" }, select: { index: true, contentHash: true, recordCount: true } });
    const counts = await ctx.tx.legacySourceRecord.groupBy({ by: ["sourceTable"], where: { snapshotId: snapshot.id }, _count: { _all: true } });
    const manifest = manifestSchema.parse(upload.manifest), counted = new Map(counts.map(row => [row.sourceTable, row._count._all]));
    const tables = new Set([...Object.keys(manifest.recordsByTable), ...counted.keys()]);
    const actual = { chunks, recordsByTable: Object.fromEntries([...tables].map(table => [table, counted.get(table) ?? 0])) };
    if (chunks.length !== upload.expectedChunks || upload.receivedRecords !== upload.expectedRecords || legacyPayloadHash(actual) !== upload.manifestHash)
      throw new OperationError(409, "IMPORT_INCOMPLETE", "Faltan fragmentos o los conteos y hashes no coinciden.");
    const status = upload.cutoverMode === "active" ? "quarantined" : "staged";
    await ctx.tx.legacyImportSnapshot.update({ where: { id: snapshot.id }, data: { status } });
    await ctx.tx.legacyImportUpload.update({ where: { snapshotId: snapshot.id }, data: { completedAt: ctx.now } });
    if (status === "quarantined") await ctx.tx.legacyException.create({ data: { id: `${snapshot.id}:authority`, snapshotId: snapshot.id, kind: "cutover_epoch", severity: "blocking", description: "Carga heredada posterior al cambio de autoridad.", resolution: json({ cutoverEpoch: upload.cutoverEpoch }) } });
    return { snapshotId: snapshot.id, status, recordCount: upload.receivedRecords, manifestHash: upload.manifestHash };
  },
});
export const legacyBatchRoutes = Router();
function limitBody(body: unknown) {
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > LEGACY_CHUNK_BYTES) throw new OperationError(413, "IMPORT_CHUNK_LIMIT", "El cuerpo supera 512 KiB.");
}
legacyBatchRoutes.post("/", async (req, res) => {
  limitBody(req.body);
  const envelope = envelopeSchema.parse(req.body);
  if (envelope.command !== "LegacyUploadBegun") throw new OperationError(400, "IMPORT_COMMAND", "Comando de inicio inválido.");
  res.status(201).json(await executeCommand(req.user, envelope, async ctx => { ctx.requestBytes = req.rawBodyBytes; }));
});
for (const [suffix, command] of [["chunks", "LegacyUploadChunkStored"], ["finalize", "LegacyUploadFinalized"]] as const) legacyBatchRoutes.post(`/:id/${suffix}`, async (req, res) => {
  limitBody(req.body);
  const envelope = envelopeSchema.parse(req.body);
  if (envelope.targetId !== id.parse(req.params.id) || envelope.command !== command) throw new OperationError(400, "IMPORT_COMMAND", "La ruta y el comando no coinciden.");
  res.json(await executeCommand(req.user, envelope, async ctx => { ctx.requestBytes = req.rawBodyBytes; }));
});
legacyBatchRoutes.get("/:id", async (req, res) => {
  await requireCapability(db, req.user, "imports.write").catch(async () => requireCapability(db, req.user, "imports.review"));
  const snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: id.parse(req.params.id) }, include: { upload: { include: { chunks: { select: { index: true, contentHash: true, recordCount: true }, orderBy: { index: "asc" } } } } } });
  if (!snapshot?.upload) throw new OperationError(404, "IMPORT_BATCH_NOT_FOUND", "Lote no encontrado.");
  if (snapshot.createdBy !== req.user.id) await requireCapability(db, req.user, "imports.review");
  const object = await db.operationObject.findUnique({ where: { id: snapshot.id }, select: { version: true } });
  res.json(wire({ ...snapshot.upload, fileHash: snapshot.fileHash, importerVersion: snapshot.importerVersion, status: snapshot.status, version: object?.version ?? 0 }));
});
