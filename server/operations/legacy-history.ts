import { createHash } from "node:crypto";
import { Prisma, type LegacySourceRecord } from "@prisma/client";
import { z } from "zod";
import { Router } from "express";
import { db } from "../db.js";
import { registerCommand, requireCapability, objectId, evidence, json, wire, OperationError, type Tx } from "./core.js";
import { legacyPayloadHash } from "./legacy-upload-contract.js";
import { isCredentialBearingHeader } from "./legacy-reader.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const state = z.enum(["known", "absent", "invalid", "not-applicable"]);
const field = z.string().min(1).max(120).nullable();
export const historicalMappingSchema = z.strictObject({
  tables: z.array(z.strictObject({ table: z.string().min(1).max(120), kind: z.enum(["invoice", "sale-line", "purchase", "stock", "cash", "expense", "fx", "delivery", "archive"]),
    dateField: field, amountField: field, quantityField: field, currencyField: field, unitField: field,
    defaultCurrency: z.enum(["ARS", "USD"]).nullable(), defaultUnit: z.enum(["g", "ud"]).nullable(),
  })).max(64),
}).superRefine((v, ctx) => { if (new Set(v.tables.map(t => t.table)).size !== v.tables.length) ctx.addIssue({ code: "custom", message: "La regla repite una tabla." }); });
type Mapping = z.infer<typeof historicalMappingSchema>;
type ValueState = z.infer<typeof state>;
type Value<T> = { value: T | null; state: ValueState };
const unknown = <T>(applicable: boolean): Value<T> => ({ value: null, state: applicable ? "absent" : "not-applicable" });
const parse = <T>(text: string | null | undefined, applicable: boolean, parser: (text: string) => T | null): Value<T> => {
  if (!applicable || text == null || text.trim() === "") return unknown<T>(applicable);
  const value = parser(text); return { value, state: value === null ? "invalid" : "known" };
};
function dateOnly(text: string): string | null {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) ? text.slice(0, 10) : null;
  return date && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date ? date : null;
}
export function projectHistoricalRecord(record: LegacySourceRecord, mapping: Mapping, mappingId: string, actorId: string) {
  const rule = mapping.tables.find(t => t.table === record.sourceTable);
  if (!rule) throw new OperationError(422, "HISTORY_TABLE_UNMAPPED", "Cada tabla requiere un tratamiento explícito aprobado.");
  type Column = { header: string | null; value: string | null; exactDecimal?: string; moneyMinorUnits?: string };
  const raw = record.normalized && typeof record.normalized === "object" && !Array.isArray(record.normalized) ? (record.normalized as { columns?: unknown }).columns : undefined;
  const columns: Column[] = Array.isArray(raw) ? raw.filter((item): item is Column => Boolean(item && typeof item === "object" && !Array.isArray(item) &&
    (typeof item.header === "string" || item.header === null) && (typeof item.value === "string" || item.value === null) &&
    (item.exactDecimal === undefined || typeof item.exactDecimal === "string") && (item.moneyMinorUnits === undefined || typeof item.moneyMinorUnits === "string"))) : [];
  const payloadMalformed = !Array.isArray(raw) || columns.length !== raw.length;
  const column = (name: string | null | undefined) => name ? columns.find(c => c.header === name) : undefined;
  const date = parse(column(rule?.dateField)?.value, Boolean(rule?.dateField), dateOnly);
  const amountColumn = column(rule?.amountField);
  const amount = parse(amountColumn?.value, Boolean(rule?.amountField), () => {
    const exact = amountColumn?.moneyMinorUnits;
    if (!exact || !/^-?\d+$/.test(exact)) return null;
    const minor = BigInt(exact); return minor >= -9223372036854775808n && minor <= 9223372036854775807n ? minor : null;
  });
  const quantityColumn = column(rule?.quantityField);
  const quantity = parse(quantityColumn?.value, Boolean(rule?.quantityField), () => {
    const exact = quantityColumn?.exactDecimal;
    if (!exact || !/^-?\d{1,26}(?:\.\d{1,12})?$/.test(exact)) return null;
    return new Prisma.Decimal(exact);
  });
  const currency = rule?.defaultCurrency && !rule.currencyField ? { value: rule.defaultCurrency, state: "known" as const } : parse(column(rule?.currencyField)?.value, Boolean(rule?.currencyField), text => ["ARS", "USD"].includes(text.trim()) ? text.trim() : null);
  const unit = rule?.defaultUnit && !rule.unitField ? { value: rule.defaultUnit, state: "known" as const } : parse(column(rule?.unitField)?.value, Boolean(rule?.unitField), text => ["g", "ud"].includes(text.trim()) ? text.trim() : null);
  for (const item of [date, amount, quantity, currency, unit]) if (payloadMalformed && item.state === "absent") item.state = "invalid";
  return { id: createHash("sha256").update(`${record.id}\0${mappingId}`).digest("hex"), snapshotId: record.snapshotId, sourceRecordId: record.id,
    sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow, sourceHash: record.contentHash, mappingId,
    kind: record.treatment === "overlap_evidence" ? "archive" : rule.kind, occurredOn: date.value, dateState: date.state,
    amountMinor: amount.value, amountState: amount.state, quantity: quantity.value, quantityState: quantity.state,
    currency: currency.value, currencyState: currency.state, unit: unit.value, unitState: unit.state,
    attributes: json({ sourceTreatment: record.treatment, payloadMalformed, mapped: Boolean(rule), fields: rule ?? null, financialEffect: "history-only", links: columns.filter(c => ["Cliente", "Id_Factura", "Artículo", "Codigo_Detalle", "Origen_ID", "N_Factura", "ID_Mercaderia"].includes(c.header ?? "")) }), createdBy: actorId };
}
async function approvedSource(tx: Tx, snapshotId: string, actorId: string, fileHash: string) {
  const snapshot = await tx.legacyImportSnapshot.findUnique({ where: { id: snapshotId }, include: { upload: true } });
  if (!snapshot || snapshot.status !== "reviewed" || !snapshot.reviewedBy || snapshot.reviewedBy === snapshot.createdBy || snapshot.upload && !snapshot.upload.completedAt)
    throw new OperationError(423, "HISTORY_SOURCE_PENDING", "La historia requiere un lote completo y revisado de forma independiente.");
  if (snapshot.createdBy === actorId) throw new OperationError(403, "INDEPENDENT_REVIEW_REQUIRED", "El importador no puede publicar su propia fuente.");
  if (snapshot.fileHash !== fileHash) throw new OperationError(409, "IMPORT_CONTENT_CHANGED", "Cambió la identidad del archivo.");
  return snapshot;
}
async function approvedMapping(tx: Tx, id: string) {
  const config = await tx.operationalConfiguration.findUnique({ where: { id } });
  if (!config || config.kind !== "legacy_history_mapping" || config.state !== "approved" || !config.approvedBy)
    throw new OperationError(423, "HISTORY_MAPPING_PENDING", "El propietario debe aprobar la interpretación histórica antes de proyectarla.");
  if ((await tx.user.findUnique({ where: { id: config.approvedBy }, select: { role: true } }))?.role !== "owner") throw new OperationError(423, "OWNER_APPROVAL_REQUIRED", "La interpretación histórica requiere aprobación del propietario.");
  const { evidence: _evidence, ...definition } = config.definition as Record<string, unknown>;
  return historicalMappingSchema.parse(definition);
}
async function replacementEvidence(tx: Tx, sourceSystem: string, snapshotId: string) {
  const previous = await tx.legacyHistoryPublication.findUnique({ where: { sourceSystem } });
  if (!previous || previous.snapshotId === snapshotId) return null;
  const missing = await tx.$queryRaw<Array<{ sourceTable: string; sourceKey: string }>>`
    SELECT DISTINCT old."sourceTable", old."sourceKey" FROM "LegacySourceRecord" old
    WHERE old."snapshotId" = ${previous.snapshotId} AND NOT EXISTS (
      SELECT 1 FROM "LegacySourceRecord" next WHERE next."snapshotId" = ${snapshotId} AND next."sourceTable" = old."sourceTable" AND next."sourceKey" = old."sourceKey")
    ORDER BY old."sourceTable", old."sourceKey"`;
  return { previousFingerprint: previous.fingerprint, previousSnapshotId: previous.snapshotId, missingRecordCount: missing.length, missingRecordHash: legacyPayloadHash(missing) };
}
registerCommand("LegacyHistoryProjected", { kind: "legacyImport", capability: "imports.review", administrative: true,
  schema: z.strictObject({ fileHash: hash, mappingId: objectId, records: z.array(z.strictObject({ id: z.string().max(100), contentHash: hash })).min(1).max(500) }),
  execute: async ctx => {
    const data = ctx.envelope.data as { fileHash: string; mappingId: string; records: Array<{ id: string; contentHash: string }> };
    await approvedSource(ctx.tx, ctx.envelope.targetId, ctx.actor.id, data.fileHash);
    const mapping = await approvedMapping(ctx.tx, data.mappingId);
    if (new Set(data.records.map(r => r.id)).size !== data.records.length) throw new OperationError(400, "HISTORY_DUPLICATE_ROW", "La proyección repite una fila.");
    const records = await ctx.tx.legacySourceRecord.findMany({ where: { snapshotId: ctx.envelope.targetId, id: { in: data.records.map(r => r.id) } } });
    if (records.length !== data.records.length || records.some(r => data.records.find(v => v.id === r.id)!.contentHash !== r.contentHash)) throw new OperationError(409, "HISTORY_SOURCE_CHANGED", "Las filas no corresponden al contenido revisado.");
    const existing = await ctx.tx.legacyHistoricalFact.findMany({ where: { snapshotId: ctx.envelope.targetId, mappingId: data.mappingId, correctionOf: null, sourceRecordId: { in: data.records.map(r => r.id) } }, select: { sourceRecordId: true, sourceHash: true } });
    if (existing.some(f => records.find(r => r.id === f.sourceRecordId)!.contentHash !== f.sourceHash)) throw new OperationError(409, "HISTORY_SOURCE_CHANGED", "Una proyección previa corresponde a otro contenido; requiere una nueva revisión.");
    const projected = await ctx.tx.legacyHistoricalFact.createMany({ data: records.map(r => projectHistoricalRecord(r, mapping, data.mappingId, ctx.actor.id)), skipDuplicates: true });
    return { projected: projected.count, historyCreatesBalances: false };
  },
});
registerCommand("LegacyHistoryPublished", { kind: "legacyImport", capability: "access.manage", administrative: true,
  schema: z.strictObject({ fileHash: hash, mappingId: objectId, evidence,
    replacementReview: z.strictObject({ previousFingerprint: hash, missingRecordHash: hash, reason: z.string().trim().min(10).max(1000) }).optional() }),
  execute: async ctx => {
    if ((await ctx.tx.user.findUnique({ where: { id: ctx.actor.id }, select: { role: true } }))?.role !== "owner")
      throw new OperationError(403, "OWNER_APPROVAL_REQUIRED", "El propietario debe aprobar la publicación histórica.");
    const data = ctx.envelope.data as { fileHash: string; mappingId: string; evidence: Record<string, unknown>; replacementReview?: { previousFingerprint: string; missingRecordHash: string; reason: string } };
    const snapshot = await approvedSource(ctx.tx, ctx.envelope.targetId, ctx.actor.id, data.fileHash);
    await approvedMapping(ctx.tx, data.mappingId);
    const [rows, facts] = await Promise.all([ctx.tx.legacySourceRecord.count({ where: { snapshotId: snapshot.id } }), ctx.tx.legacyHistoricalFact.count({ where: { snapshotId: snapshot.id, mappingId: data.mappingId, correctionOf: null } })]);
    if (rows !== facts) throw new OperationError(423, "HISTORY_PROJECTION_INCOMPLETE", "La fuente aún tiene filas sin tratamiento histórico.");
    const previous = await ctx.tx.legacyHistoryPublication.findUnique({ where: { sourceSystem: snapshot.sourceSystem } });
    const replacement = await replacementEvidence(ctx.tx, snapshot.sourceSystem, snapshot.id);
    if (replacement && (data.replacementReview?.previousFingerprint !== replacement.previousFingerprint || data.replacementReview.missingRecordHash !== replacement.missingRecordHash))
      throw new OperationError(409, "HISTORY_REPLACEMENT_REVIEW_REQUIRED", "La sustitución requiere revisar la publicación anterior y las identidades que deja fuera.", replacement);
    const corrections = await ctx.tx.legacyHistoricalFact.findMany({ where: { snapshotId: snapshot.id, mappingId: data.mappingId, correctionOf: { not: null } }, orderBy: { id: "asc" }, select: { id: true, correctionOf: true } });
    const fingerprint = legacyPayloadHash({ snapshotId: snapshot.id, fileHash: snapshot.fileHash, mappingId: data.mappingId, rows, corrections });
    const publicationEvidence = json({ ...data.evidence, replacementReview: data.replacementReview ?? null, replacement });
    await ctx.tx.legacyHistoryPublication.upsert({ where: { sourceSystem: snapshot.sourceSystem }, create: { sourceSystem: snapshot.sourceSystem, snapshotId: snapshot.id, fileHash: snapshot.fileHash, mappingId: data.mappingId, fingerprint, publishedBy: ctx.actor.id, evidence: publicationEvidence }, update: { snapshotId: snapshot.id, fileHash: snapshot.fileHash, mappingId: data.mappingId, fingerprint, publishedBy: ctx.actor.id, evidence: publicationEvidence, publishedAt: ctx.now } });
    return { sourceSystem: snapshot.sourceSystem, snapshotId: snapshot.id, fingerprint, previousSnapshotId: previous?.snapshotId ?? null, rows, historyCreatesBalances: false };
  },
});
const replacementSchema = z.strictObject({ occurredOn: z.iso.date().nullable(), dateState: state, currency: z.enum(["ARS", "USD"]).nullable(), currencyState: state,
  unit: z.enum(["g", "ud"]).nullable(), unitState: state, amountValue: z.string().regex(/^-?\d{1,19}$/).refine(v => BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n).nullable(), amountState: state,
  quantityValue: z.string().regex(/^-?\d{1,26}(?:\.\d{1,12})?$/).nullable(), quantityState: state,
}).superRefine((v, ctx) => { for (const [key, status] of [["occurredOn", "dateState"], ["currency", "currencyState"], ["unit", "unitState"], ["amountValue", "amountState"], ["quantityValue", "quantityState"]] as const)
  if ((v[status] === "known") !== (v[key] !== null)) ctx.addIssue({ code: "custom", message: `Estado y valor de ${key} no coinciden.` }); });
registerCommand("LegacyHistoryCorrected", { kind: "legacyImport", capability: "imports.review", administrative: true,
  schema: z.strictObject({ factId: z.string().max(100), replacement: replacementSchema, evidence }),
  execute: async ctx => {
    const data = ctx.envelope.data as { factId: string; replacement: z.infer<typeof replacementSchema>; evidence: Record<string, unknown> };
    const fact = await ctx.tx.legacyHistoricalFact.findUnique({ where: { id: data.factId } });
    if (!fact || fact.snapshotId !== ctx.envelope.targetId) throw new OperationError(404, "HISTORY_FACT_NOT_FOUND", "Hecho histórico no encontrado.");
    const snapshot = await approvedSource(ctx.tx, fact.snapshotId, ctx.actor.id, (await ctx.tx.legacyImportSnapshot.findUniqueOrThrow({ where: { id: fact.snapshotId } })).fileHash);
    if (fact.createdBy === ctx.actor.id) throw new OperationError(409, "INDEPENDENT_CORRECTION_REQUIRED", "La corrección requiere otro revisor.");
    if (await ctx.tx.legacyHistoricalFact.findFirst({ where: { correctionOf: fact.id } })) throw new OperationError(409, "HISTORY_ALREADY_CORRECTED", "Corregí la versión más reciente del hecho.");
    const { amountValue, quantityValue, ...replacement } = data.replacement;
    const corrected = await ctx.tx.legacyHistoricalFact.create({ data: { ...fact, ...replacement, id: ctx.envelope.requestId, correctionOf: fact.id, amountMinor: amountValue == null ? null : BigInt(amountValue), quantity: quantityValue == null ? null : new Prisma.Decimal(quantityValue), attributes: json({ ...fact.attributes as Record<string, unknown>, correctionEvidence: data.evidence }), createdBy: ctx.actor.id, createdAt: ctx.now } });
    const publication = await ctx.tx.legacyHistoryPublication.findUnique({ where: { sourceSystem: snapshot.sourceSystem } });
    if (publication?.snapshotId === snapshot.id && publication.mappingId === fact.mappingId) await ctx.tx.legacyHistoryPublication.update({ where: { sourceSystem: snapshot.sourceSystem }, data: { fingerprint: legacyPayloadHash({ previous: publication.fingerprint, correctionId: corrected.id }) } });
    return { factId: corrected.id, correctionOf: fact.id, historyCreatesBalances: false };
  },
});
export const legacyHistoryRoutes = Router();
legacyHistoryRoutes.get("/publications", async (req, res) => { await requireCapability(db, req.user, "imports.review"); res.json(wire({ items: await db.legacyHistoryPublication.findMany({ orderBy: { sourceSystem: "asc" } }) })); });
legacyHistoryRoutes.get("/publication-preview", async (req, res) => {
  await requireCapability(db, req.user, "imports.review");
  const snapshotId = objectId.parse(req.query.snapshotId), snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: snapshotId }, select: { sourceSystem: true, fileHash: true, status: true } });
  if (!snapshot || snapshot.status !== "reviewed") throw new OperationError(423, "HISTORY_SOURCE_PENDING", "La fuente requiere una revisión independiente.");
  res.json(wire({ snapshotId, fileHash: snapshot.fileHash, replacement: await replacementEvidence(db, snapshot.sourceSystem, snapshotId) }));
});
legacyHistoryRoutes.get("/projection-status", async (req, res) => {
  await requireCapability(db, req.user, "imports.review");
  const query = z.strictObject({ snapshotId: objectId, mappingId: objectId.optional() }).parse(req.query);
  const result = await db.$transaction(async tx => {
    const snapshot = await tx.legacyImportSnapshot.findUnique({ where: { id: query.snapshotId }, include: { upload: { select: { completedAt: true } } } });
    if (!snapshot || snapshot.status !== "reviewed" || snapshot.upload && !snapshot.upload.completedAt)
      throw new OperationError(423, "HISTORY_SOURCE_PENDING", "La fuente requiere una revisión independiente.");
    if (query.mappingId) await approvedMapping(tx, query.mappingId);
    const [headers, count, version] = await Promise.all([
      tx.$queryRaw<Array<{ table: string; header: string | null }>>`SELECT DISTINCT r."sourceTable" AS "table", c->>'header' AS header
        FROM "LegacySourceRecord" r LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.normalized->'columns') = 'array' THEN r.normalized->'columns' ELSE '[]'::jsonb END) c ON true
        WHERE r."snapshotId" = ${snapshot.id} ORDER BY "table", header`,
      tx.legacySourceRecord.count({ where: { snapshotId: snapshot.id } }),
      tx.operationObject.findUnique({ where: { id: snapshot.id }, select: { version: true } }),
    ]);
    const projected = query.mappingId ? await tx.legacyHistoricalFact.count({ where: { snapshotId: snapshot.id, mappingId: query.mappingId, correctionOf: null } }) : 0;
    const nextRecords = query.mappingId ? await tx.$queryRaw<Array<{ id: string; contentHash: string }>>`
      SELECT r.id, r."contentHash" FROM "LegacySourceRecord" r WHERE r."snapshotId" = ${snapshot.id} AND NOT EXISTS (
        SELECT 1 FROM "LegacyHistoricalFact" f WHERE f."sourceRecordId" = r.id AND f."mappingId" = ${query.mappingId} AND f."correctionOf" IS NULL)
      ORDER BY r."sourceTable", r."sourceRow" LIMIT 500` : [];
    const states = query.mappingId ? await tx.legacyHistoricalFact.groupBy({ by: ["kind", "amountState", "currencyState", "dateState"], where: { snapshotId: snapshot.id, mappingId: query.mappingId, correctionOf: null }, _count: { _all: true } }) : [];
    const tableMetadata = new Map<string, { name: string; coordinateOnly: boolean; headers: string[] }>();
    for (const item of Array.isArray(snapshot.coverage) ? snapshot.coverage : []) {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.name !== "string" || !item.name) continue;
      tableMetadata.set(item.name, { name: item.name, coordinateOnly: item.coordinateOnly === true, headers: [] });
    }
    for (const item of headers) {
      const table = tableMetadata.get(item.table) ?? { name: item.table, coordinateOnly: false, headers: [] };
      if (item.header && !isCredentialBearingHeader(item.header, item.table)) table.headers.push(item.header);
      tableMetadata.set(item.table, table);
    }
    return { snapshotId: snapshot.id, fileHash: snapshot.fileHash, sourceSystem: snapshot.sourceSystem, version: version?.version ?? 0,
      tables: [...tableMetadata.values()],
      expectedRecords: count, projectedRecords: projected, remainingRecords: count - projected, nextRecords, states, historyCreatesBalances: false };
  }, { isolationLevel: "RepeatableRead", timeout: 15000 });
  res.json(wire(result));
});
