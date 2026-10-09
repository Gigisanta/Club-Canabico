import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { capabilities, executeCommand, json, OperationError, registerCommand, requireCapability, wire } from "./core.js";
import { containsRecognizableCredential, LegacyWorkbookReadError, readLegacyWorkbook } from "./legacy-reader.js";
import { commercialAddress, commercialPreferences } from "./member-fields.js";

import { sourceRecordSchema } from "./legacy-source-contract.js";
import { legacyBatchRoutes } from "./legacy-batches.js";
import { legacyHistoryRoutes } from "./legacy-history.js";
import { assertLegacyHistorySourceAllowed, requireFullLegacySourceScope } from "./legacy-source-policy.js";
import { legacySourceControlRoutes, redactAuthenticationValues, redactStagedException, redactStagedRecord } from "./legacy-source-control.js";

export { redactAuthenticationValues, redactStagedException, redactStagedRecord };

const MAX_BASE64_BYTES = 8 * 1024 * 1024 - 1024;
const MAX_STAGED_RECORDS = 100_000;
const MAX_STAGED_JSON_BYTES = 128 * 1024 * 1024;
const PAGE_SIZE_MAX = 200;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
function hasReviewEvidence(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasReviewEvidence);
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(([key, item]) => key.trim().length > 0 && hasReviewEvidence(item));
  return false;
}
const reviewEvidence = z.record(z.string(), z.unknown()).refine(hasReviewEvidence, "Se requiere evidencia de revisión no vacía.");

const stageSnapshotSchema = z.strictObject({
  sourceSystem: z.string().min(1).max(120),
  filename: z.string().min(1).max(180),
  fileHash: hash,
  importerVersion: z.string().min(1).max(120),
  controls: z.record(z.string(), z.unknown()),
  coverage: z.array(z.unknown()).max(64),
  records: z.array(sourceRecordSchema).max(MAX_STAGED_RECORDS),
});
function stableStageControls(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new OperationError(409, "IMPORT_REPLAY_UNAVAILABLE", "No se encontró el control original del lote.");
  const {
    requiresChangedContentReview: _review,
    previousSnapshotId: _previous,
    previousFileHash: _hash,
    authorityAtStage: _authority,
    cutoverQuarantined: _quarantined,
    cutoverEpoch: _epoch,
    quarantinePriorSnapshotId: _priorId,
    quarantinePriorStatus: _priorStatus,
    ...controls
  } = value as Record<string, unknown>;
  return controls;
}

function quarantineAttemptSourceSystem(sourceSystem: string, requestId: string): string {
  return `quarantine-${createHash("sha256").update(`${sourceSystem}\0${requestId}`).digest("hex")}`;
}

function cutoverFields(status: string, controls: unknown): Record<string, unknown> {
  const values = controls && typeof controls === "object" && !Array.isArray(controls)
    ? controls as Record<string, unknown>
    : {};
  const epoch = typeof values.cutoverEpoch === "number" ? values.cutoverEpoch : null;
  return status === "quarantined"
    ? { quarantined: true, quarantineReason: "cutover_epoch", cutoverEpoch: epoch }
    : { quarantined: false };
}

registerCommand("LegacySnapshotStaged", {
  kind: "legacyImport",
  capability: "imports.write",
  create: true,
  administrative: true,
  internal: true,
  transactionTimeoutMs: 120_000,
  schema: stageSnapshotSchema,
  execute: async (ctx) => {
    const value = ctx.envelope.data as z.infer<typeof stageSnapshotSchema>;
    assertLegacyHistorySourceAllowed(value.sourceSystem);
    const authority = await ctx.tx.operationAuthority.findUnique({ where: { id: "operations" }, select: { mode: true, epoch: true } });
    const authorityMode = authority?.mode ?? "shadow";
    const authorityEpoch = authority?.epoch ?? 1;
    const cutoverQuarantined = authorityMode === "active";
    const serializedBytes = Buffer.byteLength(JSON.stringify(value.records));
    if (serializedBytes > MAX_STAGED_JSON_BYTES)
      throw new OperationError(413, "IMPORT_SNAPSHOT_LIMIT", "El contenido expandido supera 128 MiB para staging atómico.");
    if (value.records.some((record) => record.fileHash !== value.fileHash || record.importerVersion !== value.importerVersion))
      throw new OperationError(409, "IMPORT_SOURCE_MISMATCH", "El snapshot contiene registros de otro archivo o versión.");

    const duplicate = await ctx.tx.legacyImportSnapshot.findUnique({
      where: { sourceSystem_fileHash_importerVersion: {
        sourceSystem: value.sourceSystem,
        fileHash: value.fileHash,
        importerVersion: value.importerVersion,
      } },
      select: { id: true, filename: true, status: true, createdBy: true },
    });
    if (duplicate) {
      if (cutoverQuarantined && duplicate.id === ctx.envelope.targetId && !value.controls.quarantineAttemptRequestId)
        throw new OperationError(409, "IMPORT_CUTOVER_RETRY", "La autoridad cambió durante la carga; se conservará un intento separado en cuarentena.");
      if (duplicate.id !== ctx.envelope.targetId || !["staged", "reviewed", "quarantined"].includes(duplicate.status))
        throw new OperationError(409, "IMPORT_ALREADY_STAGED", "El mismo archivo ya está en staging y requiere revisión.");
      if (duplicate.createdBy !== ctx.actor.id)
        throw new OperationError(403, "COMMAND_ACTOR_MISMATCH", "El lote pertenece a otra autorización");
      if (duplicate.filename !== value.filename)
        throw new OperationError(409, "IDEMPOTENCY_KEY_REUSED", "El mismo archivo ya fue registrado con otros metadatos.");
      return { snapshotId: duplicate.id, fileHash: value.fileHash, status: duplicate.status, alreadyStaged: true };
    }

    const originSourceSystem = typeof value.controls.originSourceSystem === "string" ? value.controls.originSourceSystem : value.sourceSystem;
    const previous = await ctx.tx.legacyImportSnapshot.findFirst({
      where: { sourceSystem: originSourceSystem },
      orderBy: { createdAt: "desc" },
      select: { id: true, fileHash: true, status: true },
    });
    const requiresChangedContentReview = Boolean(previous && previous.fileHash !== value.fileHash);
    const snapshotId = ctx.envelope.targetId;
    await ctx.tx.legacyImportSnapshot.create({ data: {
      id: snapshotId,
      sourceSystem: value.sourceSystem,
      filename: value.filename,
      fileHash: value.fileHash,
      importerVersion: value.importerVersion,
      status: cutoverQuarantined ? "quarantined" : "staged",
      createdBy: ctx.actor.id,
      controls: json({
        ...value.controls,
        expandedRecordsBytes: serializedBytes,
        requiresChangedContentReview,
        previousSnapshotId: requiresChangedContentReview ? previous?.id : null,
        previousFileHash: requiresChangedContentReview ? previous?.fileHash : null,
        authorityAtStage: { mode: authorityMode, epoch: authorityEpoch },
        cutoverQuarantined,
        ...(cutoverQuarantined ? {
          cutoverEpoch: authorityEpoch,
          quarantinePriorSnapshotId: previous?.id ?? null,
          quarantinePriorStatus: previous?.status ?? null,
        } : {}),
      }),
      coverage: json(value.coverage),
    } });

    const rows = value.records.map((record) => {
      const id = createHash("sha256").update(`${snapshotId}\0${record.sourceTable}\0${record.sourceRow}`).digest("hex");
      return {
        id, snapshotId, sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow,
        fileHash: record.fileHash, contentHash: record.contentHash, importerVersion: record.importerVersion,
        original: json(record.original), normalized: json(record.normalized), treatment: record.treatment,
      };
    });
    for (let start = 0; start < rows.length; start += 500)
      await ctx.tx.legacySourceRecord.createMany({ data: rows.slice(start, start + 500) });

    const exceptions: Prisma.LegacyExceptionCreateManyInput[] = value.records.flatMap((record) => record.exceptions.map((exception, index) => {
      const sourceRecordId = createHash("sha256").update(`${snapshotId}\0${record.sourceTable}\0${record.sourceRow}`).digest("hex");
      return {
        id: createHash("sha256").update(`${sourceRecordId}\0${index}\0${exception.kind}`).digest("hex"),
        snapshotId,
        sourceRecordId,
        kind: exception.kind,
        severity: exception.severity,
        description: exception.kind,
        resolution: json(exception.evidence),
      };
    }));
    if (cutoverQuarantined) exceptions.push({
      id: createHash("sha256").update(`${snapshotId}\0cutover_epoch\0${ctx.envelope.requestId}`).digest("hex"),
      snapshotId,
      sourceRecordId: null,
      kind: "cutover_epoch",
      severity: "blocking",
      description: "cutover_epoch",
      resolution: json({
        authorityMode,
        authorityEpoch,
        requestId: ctx.envelope.requestId,
        originSourceSystem,
        priorSnapshotId: previous?.id ?? null,
        priorFileHash: previous?.fileHash ?? null,
      }),
    });
    for (let start = 0; start < exceptions.length; start += 500)
      await ctx.tx.legacyException.createMany({ data: exceptions.slice(start, start + 500) });

    return {
      snapshotId,
      fileHash: value.fileHash,
      status: cutoverQuarantined ? "quarantined" : "staged",
      recordCount: rows.length,
      exceptionCount: exceptions.length,
      expandedRecordsBytes: serializedBytes,
      requiresChangedContentReview,
      ...cutoverFields(cutoverQuarantined ? "quarantined" : "staged", { cutoverEpoch: authorityEpoch }),
    };
  },
});

registerCommand("LegacySnapshotReviewed", {
  kind: "legacyImport",
  capability: "imports.review",
  administrative: true,
  schema: z.strictObject({ fileHash: hash, changedContentReviewed: z.boolean(), evidence: reviewEvidence }),
  execute: async (ctx) => {
    const snapshot = await ctx.tx.legacyImportSnapshot.findUnique({ where: { id: ctx.envelope.targetId } });
    if (!snapshot) throw new OperationError(404, "IMPORT_NOT_FOUND", "No se encontró el lote legado.");
    assertLegacyHistorySourceAllowed(snapshot.sourceSystem);
    if (snapshot.createdBy === ctx.actor.id) throw new OperationError(409, "INDEPENDENT_REVIEW_REQUIRED", "Quien importó el lote no puede revisarlo.");
    if (snapshot.fileHash !== ctx.envelope.data.fileHash) throw new OperationError(409, "IMPORT_CONTENT_CHANGED", "El contenido cambió desde que se preparó la revisión.");
    if (snapshot.status !== "staged") throw new OperationError(409, "IMPORT_NOT_REVIEWABLE", "El lote ya no está pendiente de revisión.");
    const controls = snapshot.controls as { requiresChangedContentReview?: boolean; previousFileHash?: string | null };
    const reviewData = ctx.envelope.data as { fileHash: string; changedContentReviewed: boolean; evidence: Record<string, unknown> };
    if (controls.requiresChangedContentReview && !reviewData.changedContentReviewed)
      throw new OperationError(422, "CHANGED_CONTENT_REVIEW_REQUIRED", "La revisión debe confirmar que comparó el contenido nuevo con la versión anterior.");
    if (controls.requiresChangedContentReview && reviewData.evidence.previousFileHash !== controls.previousFileHash)
      throw new OperationError(422, "PREVIOUS_CONTENT_EVIDENCE_REQUIRED", "La revisión requiere identificar el hash de la versión anterior.");
    await ctx.tx.legacyImportSnapshot.update({ where: { id: snapshot.id }, data: { status: "reviewed", reviewedBy: ctx.actor.id, reviewedAt: ctx.now } });
    return { snapshotId: snapshot.id, status: "reviewed", reviewedBy: ctx.actor.id };
  },
});

registerCommand("LegacyExceptionResolved", {
  kind: "legacyImport",
  capability: "imports.review",
  administrative: true,
  schema: z.strictObject({
    snapshotId: z.string().min(1).max(100),
    exceptionId: z.string().min(1).max(100),
    treatment: z.string().trim().min(1).max(500),
    evidence: reviewEvidence,
  }),
  execute: async (ctx) => {
    const data = ctx.envelope.data as { snapshotId: string; exceptionId: string; treatment: string; evidence: Record<string, unknown> };
    const snapshot = await ctx.tx.legacyImportSnapshot.findUnique({ where: { id: data.snapshotId } });
    if (!snapshot || snapshot.id !== ctx.envelope.targetId)
      throw new OperationError(404, "IMPORT_NOT_FOUND", "No se encontró el lote legado.");
    assertLegacyHistorySourceAllowed(snapshot.sourceSystem);
    if (snapshot.status !== "reviewed" || !snapshot.reviewedBy || snapshot.createdBy === snapshot.reviewedBy)
      throw new OperationError(423, "IMPORT_REVIEW_REQUIRED", "El lote requiere una revisión independiente antes de resolver excepciones.");
    if (snapshot.createdBy === ctx.actor.id || snapshot.reviewedBy === ctx.actor.id)
      throw new OperationError(409, "INDEPENDENT_EXCEPTION_REVIEW_REQUIRED", "La resolución debe hacerla alguien distinto de quien importó y de quien revisó el lote.");

    const exception = await ctx.tx.legacyException.findFirst({ where: { id: data.exceptionId, snapshotId: snapshot.id } });
    if (!exception) throw new OperationError(404, "IMPORT_EXCEPTION_NOT_FOUND", "No se encontró la excepción en el lote.");
    if (exception.status !== "open")
      throw new OperationError(409, "IMPORT_EXCEPTION_ALREADY_RESOLVED", "La excepción ya fue resuelta.");
    await ctx.tx.legacyException.update({ where: { id: exception.id }, data: {
      status: "resolved",
      resolution: json({ treatment: data.treatment, evidence: data.evidence }),
      resolvedBy: ctx.actor.id,
      resolvedAt: ctx.now,
    } });
    return { snapshotId: snapshot.id, exceptionId: exception.id, status: "resolved", resolvedBy: ctx.actor.id };
  },
});

registerCommand("LegacyRecordsMapped", {
  kind: "legacyImport",
  capability: "imports.review",
  administrative: true,
  schema: z.strictObject({
    snapshotId: z.string().min(1).max(100),
    mappings: z.array(z.strictObject({
      sourceRecordId: z.string().regex(/^[a-f0-9]{64}$/),
      destinationType: z.enum(["member", "sku"]),
      destinationId: z.string().min(1).max(100),
      evidence: z.string().trim().min(1).max(500),
    })).min(1).max(100),
  }),
  execute: async (ctx) => {
    const snapshot = await ctx.tx.legacyImportSnapshot.findUnique({ where: { id: ctx.envelope.targetId } });
    if (!snapshot || snapshot.id !== ctx.envelope.data.snapshotId) throw new OperationError(404, "IMPORT_NOT_FOUND", "No se encontró el lote legado.");
    assertLegacyHistorySourceAllowed(snapshot.sourceSystem);
    if (snapshot.status !== "reviewed" || !snapshot.reviewedBy || snapshot.createdBy === snapshot.reviewedBy)
      throw new OperationError(423, "IMPORT_REVIEW_REQUIRED", "El lote requiere una revisión independiente antes de mapear maestros.");
    if (snapshot.createdBy === ctx.actor.id) throw new OperationError(403, "INDEPENDENT_REVIEW_REQUIRED", "Quien importó el lote no puede promover ni mapear sus registros.");

    const mappings = ctx.envelope.data.mappings as Array<{ sourceRecordId: string; destinationType: "member" | "sku"; destinationId: string; evidence: string }>;
    if (new Set(mappings.map((mapping) => mapping.sourceRecordId)).size !== mappings.length)
      throw new OperationError(400, "DUPLICATE_SOURCE_MAPPING", "Cada registro debe aparecer una sola vez en el lote.");
    const records = await ctx.tx.legacySourceRecord.findMany({ where: { id: { in: mappings.map((mapping) => mapping.sourceRecordId) }, snapshotId: snapshot.id } });
    if (records.length !== mappings.length) throw new OperationError(404, "SOURCE_RECORD_NOT_FOUND", "Uno o más registros no pertenecen al lote.");

    for (const mapping of mappings) {
      const record = records.find((row) => row.id === mapping.sourceRecordId)!;
      const tableAllows = mapping.destinationType === "member"
        ? record.sourceTable === "C_Cliente"
        : record.sourceTable === "C_Mercaderia" || record.sourceTable === "D_Catalogo_Mercaderia";
      if (!tableAllows || record.treatment !== "fact_candidate" || record.sourceKey.startsWith("synthetic:"))
        throw new OperationError(422, "MASTER_MAPPING_NOT_ALLOWED", "Sólo se pueden mapear claves estables de maestros de socios o catálogo.");
      const openExceptions = await ctx.tx.legacyException.count({ where: { snapshotId: snapshot.id, sourceRecordId: record.id, status: "open" } });
      if (openExceptions) throw new OperationError(422, "MASTER_RECORD_HAS_EXCEPTIONS", "El registro debe tener todas sus excepciones revisadas y resueltas antes de mapearse.");
      if (mapping.destinationType === "member") {
        const member = await ctx.tx.operationMember.findUnique({ where: { id: mapping.destinationId }, select: { id: true, legacyCustomerId: true } });
        if (!member)
          throw new OperationError(422, "DESTINATION_MASTER_NOT_FOUND", "El socio destino debe existir como maestro canónico.");
        if (member.legacyCustomerId && member.legacyCustomerId !== record.sourceKey)
          throw new OperationError(409, "DESTINATION_MASTER_CONFLICT", "El socio destino ya está vinculado a otra clave legado.");
      } else if (!await ctx.tx.catalogSku.findFirst({ where: { id: mapping.destinationId, active: true }, select: { id: true } })) {
        throw new OperationError(422, "DESTINATION_MASTER_NOT_FOUND", "El artículo destino debe existir y estar activo en el catálogo canónico.");
      }
      const existing = await ctx.tx.legacyIdentity.findUnique({ where: { sourceSystem_sourceTable_sourceKey_destinationType: {
        sourceSystem: snapshot.sourceSystem,
        sourceTable: record.sourceTable,
        sourceKey: record.sourceKey,
        destinationType: mapping.destinationType,
      } } });
      if (existing && existing.destinationId !== mapping.destinationId)
        throw new OperationError(409, "LEGACY_IDENTITY_CONFLICT", "La clave legado ya está vinculada a otro maestro.");
      if (!existing) await ctx.tx.legacyIdentity.create({ data: {
        id: createHash("sha256").update(`${snapshot.sourceSystem}\0${record.sourceTable}\0${record.sourceKey}\0${mapping.destinationType}`).digest("hex"),
        sourceSystem: snapshot.sourceSystem,
        sourceTable: record.sourceTable,
        sourceKey: record.sourceKey,
        destinationType: mapping.destinationType,
        destinationId: mapping.destinationId,
        approvedBy: ctx.actor.id,
      } });
      await ctx.tx.legacySourceRecord.update({ where: { id: record.id }, data: { resolution: json({
        status: "mapped-to-existing-master",
        destinationType: mapping.destinationType,
        destinationId: mapping.destinationId,
        evidence: mapping.evidence,
        approvedBy: ctx.actor.id,
        approvedAt: ctx.now.toISOString(),
      }) } });
    }
    return { snapshotId: snapshot.id, mappedCount: mappings.length, destinations: [...new Set(mappings.map((mapping) => mapping.destinationType))] };
  },
});

const memberActivationSchema = z.strictObject({
  snapshotId: z.string().min(1).max(100),
  sourceRecordId: z.string().regex(/^[a-f0-9]{64}$/),
  destinationType: z.literal("member"),
  approvedData: z.strictObject({
    name: z.string().trim().min(1).max(180),
    email: z.string().trim().max(254),
    phone: z.string().trim().max(80),
    address: commercialAddress,
    preferences: commercialPreferences,
  }),
  evidence: reviewEvidence,
});
const skuActivationSchema = z.strictObject({
  snapshotId: z.string().min(1).max(100),
  sourceRecordId: z.string().regex(/^[a-f0-9]{64}$/),
  destinationType: z.literal("sku"),
  approvedData: z.strictObject({
    code: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(180),
    variety: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(120),
    unit: z.string().trim().min(1).max(40),
    minQuantity: z.string().regex(/^\d+(?:\.\d{1,12})?$/),
    minVarieties: z.number().int().min(0).max(1_000_000),
    active: z.boolean(),
  }),
  evidence: reviewEvidence,
});
const masterActivationSchema = z.discriminatedUnion("destinationType", [memberActivationSchema, skuActivationSchema]);
const masterActivationRequestSchema = z.discriminatedUnion("destinationType", [
  memberActivationSchema.extend({ requestId: z.uuid() }),
  skuActivationSchema.extend({ requestId: z.uuid() }),
]);

registerCommand("LegacyMasterActivated", {
  kind: "legacyImport",
  capability: "imports.review",
  administrative: true,
  schema: masterActivationSchema,
  execute: async (ctx) => {
    const input = ctx.envelope.data as z.infer<typeof masterActivationSchema>;
    const snapshot = await ctx.tx.legacyImportSnapshot.findUnique({ where: { id: ctx.envelope.targetId } });
    if (!snapshot || snapshot.id !== input.snapshotId)
      throw new OperationError(404, "IMPORT_NOT_FOUND", "No se encontró el lote legado.");
    assertLegacyHistorySourceAllowed(snapshot.sourceSystem);
    if (snapshot.status !== "reviewed" || !snapshot.reviewedBy || snapshot.createdBy === snapshot.reviewedBy)
      throw new OperationError(423, "IMPORT_REVIEW_REQUIRED", "La activación requiere una revisión independiente del lote.");
    if (snapshot.createdBy === ctx.actor.id || snapshot.reviewedBy === ctx.actor.id)
      throw new OperationError(403, "INDEPENDENT_MASTER_ACTIVATION_REQUIRED", "La activación debe hacerla alguien distinto de quien importó y de quien revisó el lote.");
    const record = await ctx.tx.legacySourceRecord.findFirst({ where: { id: input.sourceRecordId, snapshotId: snapshot.id } });
    if (!record) throw new OperationError(404, "SOURCE_RECORD_NOT_FOUND", "El registro no pertenece a este lote.");
    const tableAllows = input.destinationType === "member"
      ? record.sourceTable === "C_Cliente"
      : record.sourceTable === "C_Mercaderia" || record.sourceTable === "D_Catalogo_Mercaderia";
    if (!tableAllows || record.treatment !== "fact_candidate" || record.sourceKey.startsWith("synthetic:"))
      throw new OperationError(422, "MASTER_ACTIVATION_NOT_ALLOWED", "Sólo se pueden activar candidatos verificables de socios o catálogo.");
    if (await ctx.tx.legacyException.count({ where: { snapshotId: snapshot.id, sourceRecordId: record.id, status: "open" } }))
      throw new OperationError(422, "MASTER_RECORD_HAS_EXCEPTIONS", "Resuelve las excepciones del registro antes de activar un maestro.");
    const identityWhere = { sourceSystem_sourceTable_sourceKey_destinationType: {
      sourceSystem: snapshot.sourceSystem, sourceTable: record.sourceTable, sourceKey: record.sourceKey, destinationType: input.destinationType,
    } };
    if (await ctx.tx.legacyIdentity.findUnique({ where: identityWhere }))
      throw new OperationError(409, "LEGACY_IDENTITY_EXISTS", "La clave legado ya está vinculada; usá el flujo de mapeo al maestro existente.");

    const masterId = randomUUID();
    if (input.destinationType === "member") {
      if (await ctx.tx.operationMember.findFirst({ where: { OR: [
        { legacyCustomerId: record.sourceKey }, { sourceSystem: snapshot.sourceSystem, sourceId: record.sourceKey },
      ] }, select: { id: true } }))
        throw new OperationError(409, "DESTINATION_MASTER_EXISTS", "Ya hay un socio canónico con esta clave; usá el flujo de mapeo.");
      const data = input.approvedData;
      await ctx.tx.operationMember.create({ data: {
        id: masterId, legacyCustomerId: record.sourceKey, name: data.name, email: data.email, phone: data.phone,
        address: json(data.address), preferences: json(data.preferences), sourceSystem: snapshot.sourceSystem, sourceId: record.sourceKey,
      } });
    } else {
      if (await ctx.tx.catalogSku.findFirst({ where: { OR: [
        { code: input.approvedData.code }, { sourceSystem: snapshot.sourceSystem, sourceId: record.sourceKey },
      ] }, select: { id: true } }))
        throw new OperationError(409, "DESTINATION_MASTER_EXISTS", "Ya hay un artículo canónico con este código o clave; usá el flujo de mapeo.");
      await ctx.tx.catalogSku.create({ data: {
        id: masterId, ...input.approvedData, sourceSystem: snapshot.sourceSystem, sourceId: record.sourceKey,
      } });
    }
    await ctx.tx.legacyIdentity.create({ data: {
      id: createHash("sha256").update(`${snapshot.sourceSystem}\0${record.sourceTable}\0${record.sourceKey}\0${input.destinationType}`).digest("hex"),
      sourceSystem: snapshot.sourceSystem, sourceTable: record.sourceTable, sourceKey: record.sourceKey,
      destinationType: input.destinationType, destinationId: masterId, approvedBy: ctx.actor.id,
    } });
    await ctx.tx.legacySourceRecord.update({ where: { id: record.id }, data: { resolution: json({
      status: "activated-as-new-master", destinationType: input.destinationType, destinationId: masterId,
      evidence: input.evidence, approvedBy: ctx.actor.id, approvedAt: ctx.now.toISOString(),
    }) } });
    return { snapshotId: snapshot.id, sourceRecordId: record.id, destinationType: input.destinationType, destinationId: masterId, status: "activated" };
  },
});

export const legacyImportRoutes = Router();
legacyImportRoutes.use("/batches", legacyBatchRoutes);
legacyImportRoutes.use("/history", legacyHistoryRoutes);

function snapshotTargetId(sourceSystem: string, fileHash: string, importerVersion: string): string {
  const digest = createHash("sha256").update(`${sourceSystem}\0${fileHash}\0${importerVersion}`).digest("hex");
  return `legacy-${digest}`;
}

function cleanFilename(filename: string): string {
  const cleaned = filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, "").trim() ?? "legacy.xlsx";
  return cleaned.slice(0, 180) || "legacy.xlsx";
}

function toEnvelope(actorId: string, targetId: string, expectedVersion: number, requestId: string, command: string, data: Record<string, unknown>) {
  return { schemaVersion: 1, requestId, targetId, expectedVersion, occurredAt: new Date().toISOString(), command, data };
}

legacyImportRoutes.post("/preview", async (req, res) => {
  await requireCapability(db, req.user, "imports.write");
  if (process.env.NODE_ENV === "production")
    throw new OperationError(410, "LOCAL_PREVIEW_REQUIRED", "Leé y filtrá el Excel localmente con ops:import; el archivo original no se recibe en producción.");
  const input = z.strictObject({
    requestId: z.uuid(),
    filename: z.string().min(1).max(255),
    sourceSystem: z.string().min(1).max(120).regex(/^[a-zA-Z0-9._-]+$/).default("appsheet"),
    xlsxBase64: z.string().min(1).max(MAX_BASE64_BYTES),
  }).parse(req.body);
  if(containsRecognizableCredential(input.filename)||containsRecognizableCredential(input.sourceSystem))throw new OperationError(400,"CREDENTIAL_METADATA_EXCLUDED","Los identificadores del archivo no pueden contener material de autenticación.");
  const decoded = Buffer.from(input.xlsxBase64, "base64");
  if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/, "") !== input.xlsxBase64.replace(/=+$/, ""))
    throw new OperationError(400, "INVALID_BASE64", "El contenido XLSX debe ser Base64 válido.");

  let snapshot;
  try {
    snapshot = await readLegacyWorkbook(decoded, { sourceSystem: input.sourceSystem });
  } catch (error) {
    if (error instanceof LegacyWorkbookReadError) throw new OperationError(422, error.code.toUpperCase(), error.message);
    throw error;
  }
  if (snapshot.records.length > MAX_STAGED_RECORDS)
    throw new OperationError(413, "IMPORT_RECORD_LIMIT", "El lote supera el máximo de 100.000 registros para staging.");
  const expandedRecordsBytes = Buffer.byteLength(JSON.stringify(snapshot.records));
  if (expandedRecordsBytes > MAX_STAGED_JSON_BYTES)
    throw new OperationError(413, "IMPORT_SNAPSHOT_LIMIT", "El contenido expandido supera el límite de 128 MiB para staging atómico.");

  const controls = {
    sheetCount: snapshot.summary.sheetCount,
    hiddenSheetCount: snapshot.summary.hiddenSheetCount,
    sourceFieldCount: snapshot.sheets.reduce((count, sheet) => count + sheet.fieldCount + sheet.excludedCredentialColumns, 0),
    stagedFieldCount: snapshot.sheets.reduce((count, sheet) => count + sheet.fieldCount, 0),
    excludedCredentialColumns: snapshot.sheets.reduce((count, sheet) => count + sheet.excludedCredentialColumns, 0),
    recordCount: snapshot.summary.recordCount,
    keyedRecordCount: snapshot.summary.keyedRecordCount,
    syntheticKeyCount: snapshot.summary.syntheticKeyCount,
    recordsByTreatment: snapshot.summary.recordsByTreatment,
    exceptionCount: snapshot.summary.exceptionCount,
    cashOverlap: snapshot.summary.cashOverlap,
    expandedRecordsBytes,
  };
  res.json(redactAuthenticationValues(wire({
    filename: cleanFilename(input.filename), fileHash: snapshot.fileHash, importerVersion: snapshot.importerVersion,
    status: "preview", persisted: false, coverage: snapshot.sheets, controls,
    importMethod: "sanitized-resumable-batches",
  })));
});

legacyImportRoutes.get("/coverage", async (req, res) => {
  await requireFullLegacySourceScope(db, req.user);
  await requireCapability(db, req.user, "imports.review");
  const query = z.strictObject({ sourceSystem: z.string().max(120).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
  const items = await db.legacyImportSnapshot.findMany({
    where: { AND: [
      { status: { not: "uploading" } },
      { OR: [{ upload: { is: null } }, { upload: { is: { completedAt: { not: null } } } }] },
      ...(query.sourceSystem ? [{ OR: [
        { sourceSystem: query.sourceSystem },
        { controls: { path: ["originSourceSystem"], equals: query.sourceSystem } },
      ] }] : []),
    ] },
    orderBy: { createdAt: "desc" },
    take: query.limit,
    select: { id: true, sourceSystem: true, filename: true, fileHash: true, importerVersion: true, status: true, createdBy: true, reviewedBy: true, reviewedAt: true, controls: true, coverage: true, createdAt: true },
  });
  const versions = await db.operationObject.findMany({ where: { id: { in: items.map((item) => item.id) } }, select: { id: true, version: true } });
  const versionById = new Map(versions.map((item) => [item.id, item.version]));
  res.json(redactAuthenticationValues(wire({ items: items.map((item) => ({ ...item, ...cutoverFields(item.status, item.controls), version: versionById.get(item.id) ?? 0 })) })));
});

legacyImportRoutes.get("/staged-records", async (req, res) => {
  await requireFullLegacySourceScope(db, req.user);
  await requireCapability(db, req.user, "imports.review");
  const query = z.strictObject({ snapshotId: z.string().min(1).max(100), cursor: z.string().regex(/^[a-f0-9]{64}$/).optional(), limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(100) }).parse(req.query);
  const snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: query.snapshotId }, select: { id: true, status: true, controls: true } });
  if (!snapshot) throw new OperationError(404, "IMPORT_NOT_FOUND", "No se encontró el lote legado.");
  const upload = await db.legacyImportUpload.findUnique({ where: { snapshotId: snapshot.id }, select: { completedAt: true } });
  if (snapshot.status === "uploading" || (upload && !upload.completedAt))
    throw new OperationError(423, "IMPORT_INCOMPLETE", "El lote debe finalizar y comprobarse antes de consultar sus registros.");
  if (query.cursor && !await db.legacySourceRecord.findFirst({ where: { id: query.cursor, snapshotId: snapshot.id }, select: { id: true } }))
    throw new OperationError(400, "INVALID_RECORD_CURSOR", "El cursor no pertenece al lote solicitado.");
  const items = await db.legacySourceRecord.findMany({
    where: { snapshotId: snapshot.id },
    orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }],
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    take: query.limit + 1,
    select: { id: true, sourceTable: true, sourceKey: true, sourceRow: true, contentHash: true, importerVersion: true, original: true, normalized: true, treatment: true, resolution: true },
  });
  const hasMore = items.length > query.limit;
  const page = items.slice(0, query.limit);
  const exceptions = await db.legacyException.findMany({ where: { snapshotId: snapshot.id, OR: [
    { sourceRecordId: { in: page.map((record) => record.id) } },
    { sourceRecordId: null },
  ] }, select: { id: true, sourceRecordId: true, kind: true, severity: true, status: true, resolution: true, resolvedBy: true, resolvedAt: true } });
  const safeExceptions = exceptions.map(redactStagedException);
  const includeClinical = (await capabilities(db, req.user)).includes("clinical.read");
  res.json(redactAuthenticationValues(wire({ status: snapshot.status, ...cutoverFields(snapshot.status, snapshot.controls), items: page.map((record) => redactStagedRecord(record, { includeClinical })), exceptions: safeExceptions, nextCursor: hasMore ? page.at(-1)?.id ?? null : null })));
});

legacyImportRoutes.post("/:snapshotId/review", async (req, res) => {
  await requireCapability(db, req.user, "imports.review");
  const params = z.strictObject({ snapshotId: z.string().min(1).max(100) }).parse(req.params);
  const body = z.strictObject({ requestId: z.uuid(), fileHash: hash, changedContentReviewed: z.boolean(), evidence: reviewEvidence }).parse(req.body);
  const version = await db.operationObject.findUnique({ where: { id: params.snapshotId }, select: { version: true } });
  const result = await executeCommand(req.user, toEnvelope(req.user.id, params.snapshotId, version?.version ?? 0, body.requestId, "LegacySnapshotReviewed", {
    fileHash: body.fileHash, changedContentReviewed: body.changedContentReviewed, evidence: body.evidence,
  }));
  res.json(redactAuthenticationValues(wire({ ...result.result, version: result.version, replay: Boolean(result.replay) })));
});

legacyImportRoutes.post("/:snapshotId/mappings", async (req, res) => {
  await requireCapability(db, req.user, "imports.review");
  const params = z.strictObject({ snapshotId: z.string().min(1).max(100) }).parse(req.params);
  const body = z.strictObject({ requestId: z.uuid(), mappings: z.array(z.strictObject({
    sourceRecordId: z.string().regex(/^[a-f0-9]{64}$/),
    destinationType: z.enum(["member", "sku"]),
    destinationId: z.string().min(1).max(100),
    evidence: z.string().trim().min(1).max(500),
  })).min(1).max(100) }).parse(req.body);
  const version = await db.operationObject.findUnique({ where: { id: params.snapshotId }, select: { version: true } });
  const result = await executeCommand(req.user, toEnvelope(req.user.id, params.snapshotId, version?.version ?? 0, body.requestId, "LegacyRecordsMapped", {
    snapshotId: params.snapshotId, mappings: body.mappings,
  }));
  res.json(redactAuthenticationValues(wire({ ...result.result, version: result.version, replay: Boolean(result.replay) })));
});

legacyImportRoutes.post("/:snapshotId/exceptions/:exceptionId/resolve", async (req, res) => {
  await requireCapability(db, req.user, "imports.review");
  const params = z.strictObject({ snapshotId: z.string().min(1).max(100), exceptionId: z.string().min(1).max(100) }).parse(req.params);
  const body = z.strictObject({
    requestId: z.uuid(),
    treatment: z.string().trim().min(1).max(500),
    evidence: reviewEvidence,
  }).parse(req.body);
  const version = await db.operationObject.findUnique({ where: { id: params.snapshotId }, select: { version: true } });
  const result = await executeCommand(req.user, toEnvelope(req.user.id, params.snapshotId, version?.version ?? 0, body.requestId, "LegacyExceptionResolved", {
    snapshotId: params.snapshotId,
    exceptionId: params.exceptionId,
    treatment: body.treatment,
    evidence: body.evidence,
  }));
  res.json(redactAuthenticationValues(wire({ ...result.result, version: result.version, replay: Boolean(result.replay) })));
});

legacyImportRoutes.post("/:snapshotId/activate-master", async (req, res) => {
  await requireCapability(db, req.user, "imports.review");
  const params = z.strictObject({ snapshotId: z.string().min(1).max(100) }).parse(req.params);
  const body = masterActivationRequestSchema.parse(req.body);
  if (body.snapshotId !== params.snapshotId)
    throw new OperationError(400, "IMPORT_TARGET_MISMATCH", "El lote del cuerpo y la ruta deben coincidir.");
  const { requestId, ...data } = body;
  const version = await db.operationObject.findUnique({ where: { id: params.snapshotId }, select: { version: true } });
  const result = await executeCommand(req.user, toEnvelope(req.user.id, params.snapshotId, version?.version ?? 0, requestId, "LegacyMasterActivated", data));
  res.status(201).json(redactAuthenticationValues(wire({ ...result.result, version: result.version, replay: Boolean(result.replay) })));
});

legacyImportRoutes.use("/source-control", legacySourceControlRoutes);
