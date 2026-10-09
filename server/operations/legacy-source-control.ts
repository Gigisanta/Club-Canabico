import { Prisma } from "@prisma/client";
import { Router } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { financialSourceExclusionReasons } from "../../shared/operations/financial-source-report.js";
import { isTechnicalLegacySource, legacySourceFollowUpObjectId, type LegacySourceExceptionPage, type LegacySourceExceptionView, type LegacySourceFollowUpStatus, type LegacySourceRecordView, type LegacySourceSummary, type LegacySourceTableSummary } from "../../shared/operations/source-control.js";
import { APPSHEET_ARCHIVE_SOURCE_SYSTEM, APPSHEET_COORDINATE_ONLY_SHEETS } from "./appsheet-archive-stage.js";
import { capabilities, json, OperationError, registerCommand, requireCapability, wire } from "./core.js";
import { containsRecognizableCredential, isCompositeLegacyKeyHeader, isCredentialBearingHeader, isCredentialMetadataKey, isRestrictedLegacyReferenceHeader } from "./legacy-reader.js";
import { requireFullLegacySourceScope } from "./legacy-source-policy.js";

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;
const EXCEPTION_PAGE_SIZE_DEFAULT = 50;
const EXCEPTION_PAGE_SIZE_MAX = 100;
const SEARCH_CHUNK_SIZE = 500;
const MAX_SOURCE_ROWS = 100_000;
const MAX_SOURCE_SNAPSHOTS = 20_000;
const RESTRICTED_SOURCE_TABLE = "[restricted source table]";
const FOLLOW_UP_KIND = "legacySourceFollowUp";
const FOLLOW_UP_COMMAND = "LegacySourceFollowUpRecorded";
const followUpStatusSchema = z.enum(["pending", "reviewing", "explained"]);
const safeTreatments = new Set(["fact_candidate", "archive_only", "overlap_evidence"]);
const coordinateOnlySheetSchema = z.strictObject({
  name: z.enum(APPSHEET_COORDINATE_ONLY_SHEETS),
  extracted: z.literal(false),
  dimension: z.string().max(120).regex(/^[A-Z]{1,3}\$?[1-9]\d*(?::[A-Z]{1,3}\$?[1-9]\d*)?$/i).nullable(),
});
const coordinateOnlySheetsSchema = z.array(coordinateOnlySheetSchema).length(APPSHEET_COORDINATE_ONLY_SHEETS.length);
const legacyExceptionCodes = new Set<string>([
  "ambiguous_source_key_header",
  "array_formula_preserved",
  "cash_overlap_ambiguous_reference",
  "cash_overlap_comparison_incomplete",
  "cash_overlap_different_legacy_fields",
  "cash_overlap_missing_reference",
  "credential_record_quarantined",
  "credential_value_excluded",
  "cutover_epoch",
  "duplicate_source_key",
  "empty_formula_result_row_omitted",
  "empty_safe_row_omitted",
  "excel_error_value",
  "formula_without_cached_result",
  "inexact_excel_number",
  "invalid_excel_date",
  "missing_source_key",
  "money_minor_out_of_range",
  "money_precision_exceeds_minor_unit",
  "source_key_formula_without_cache",
  "source_key_header_missing",
  "source_key_surrounding_whitespace",
  "unlabeled_row_omitted",
  ...financialSourceExclusionReasons,
]);

function safeExceptionCode(value: unknown): string {
  return typeof value === "string" && legacyExceptionCodes.has(value) ? value : "other_technical_exception";
}

function safeExceptionSeverity(value: unknown): string {
  return value === "review" || value === "blocking" ? value : "unknown";
}

function safeExceptionStatus(value: unknown): string {
  return value === "open" || value === "resolved" ? value : "unknown";
}

function safeTreatment(value: unknown): string {
  return typeof value === "string" && safeTreatments.has(value) ? value : "unknown";
}

function normalizeFieldName(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function clinicalField(name: string): boolean {
  return /(clinical|salud|medic|diagnos|tratamiento|consumo|sustanc|droga|alerg|patolog|enfermedad|sintom|antecedente|dosis|terapeut|psiquiatr|adiccion|psicolog|farmac|terapia|paciente|internacion|hospital|clinica|consulta|historia|evolucion|embaraz|discapacidad|presion arterial|glucem|estado emocional|suicid|lesion|rehabilitacion|reprocam|vigenci|caduc|vencim|validity|valid from|valid until|valid through|expiry|expiration|document.{0,32}(clinical|medic|salud)|(?:clinical|medic|salud).{0,32}document|observacion|comentario|nota|descripcion|detalle)/i.test(normalizeFieldName(name));
}

function hasRestrictedClinicalColumn(columns: Array<Record<string, unknown>> | undefined, sourceTable?: string): boolean {
  return Boolean(columns?.some((column) => typeof column.header === "string"
    && (clinicalField(column.header) || isRestrictedLegacyReferenceHeader(column.header, sourceTable))));
}

function stagedColumns(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const columns = (value as Record<string, unknown>).columns;
  return Array.isArray(columns) ? columns.filter((column): column is Record<string, unknown> => Boolean(column && typeof column === "object" && !Array.isArray(column))) : undefined;
}

function hasRestrictedClinicalRecord(record: { sourceTable: string; original: unknown; normalized: unknown }): boolean {
  return hasRestrictedClinicalColumn(stagedColumns(record.original), record.sourceTable)
    || hasRestrictedClinicalColumn(stagedColumns(record.normalized), record.sourceTable)
    || clinicalField(record.sourceTable);
}

export function redactAuthenticationValues(value: unknown): unknown {
  if (typeof value === "string") return containsRecognizableCredential(value) ? "[excluded authentication material]" : value;
  if (Array.isArray(value)) return value.map(redactAuthenticationValues);
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isCredentialMetadataKey(key) && !containsRecognizableCredential(key))
    .map(([key, item]) => [key, redactAuthenticationValues(item)]));
  return value;
}

type StagedColumn = Record<string, unknown> & { header?: unknown };
type StagedRecord = {
  id: string;
  snapshotId: string;
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  contentHash: string;
  original: { columns?: StagedColumn[] };
  normalized: { columns?: StagedColumn[] };
  treatment: string;
  resolution?: Record<string, unknown> | null;
};

export function redactStagedRecord(value: unknown, options: { includeClinical?: boolean } = {}): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const original = record.original as { columns?: Array<Record<string, unknown>> } | undefined;
  const normalized = record.normalized as { columns?: Array<Record<string, unknown>>; overlapEvidence?: unknown } | undefined;
  const resolution = record.resolution as Record<string, unknown> | null | undefined;
  const sourceTable = typeof record.sourceTable === "string" ? record.sourceTable : undefined;
  const restrictedClinical = hasRestrictedClinicalColumn(original?.columns, sourceTable) || hasRestrictedClinicalColumn(normalized?.columns, sourceTable)
    || (typeof record.sourceTable === "string" && clinicalField(record.sourceTable));
  const projectColumns = (columns: Array<Record<string, unknown>> | undefined) => columns?.flatMap((column) => {
    const header = typeof column.header === "string" ? column.header.trim() : "";
    if (!header || isCredentialBearingHeader(header, sourceTable) || containsRecognizableCredential(column)) return [];
    if (!options.includeClinical && (clinicalField(header)
      || isRestrictedLegacyReferenceHeader(header, sourceTable)
      || (restrictedClinical && isCompositeLegacyKeyHeader(header)))) return [];
    return [column];
  });
  const projected: Record<string, unknown> = {
    ...record,
    original: original ? { ...original, columns: projectColumns(original.columns) } : original,
    normalized: normalized ? { ...normalized, columns: projectColumns(normalized.columns) } : normalized,
    resolution: resolution ? {
      ...resolution,
      ...(resolution.evidence === undefined ? {} : { evidence: "[review evidence stored privately]" }),
    } : resolution,
  };
  if (restrictedClinical && !options.includeClinical) {
    delete projected.sourceKey;
    delete projected.contentHash;
    if (typeof projected.sourceTable === "string" && clinicalField(projected.sourceTable))
      projected.sourceTable = RESTRICTED_SOURCE_TABLE;
  }
  if (containsRecognizableCredential(projected.sourceKey)) delete projected.sourceKey;
  return redactAuthenticationValues(projected);
}

export function redactStagedException(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const exception = value as Record<string, unknown>;
  const projected = { ...exception };
  projected.kind = safeExceptionCode(exception.kind);
  if (exception.description !== undefined) projected.description = safeExceptionCode(exception.description);
  projected.severity = safeExceptionSeverity(exception.severity);
  projected.status = safeExceptionStatus(exception.status);
  if (containsRecognizableCredential(projected.sourceKey)) delete projected.sourceKey;
  if (exception.resolution !== null && exception.resolution !== undefined) projected.resolution = "[private exception evidence stored privately]";
  return redactAuthenticationValues(projected);
}

function isCredentialSafeNote(value: string): boolean {
  return !containsRecognizableCredential(value);
}

const safeNote = z.string().trim().min(1).max(2_000).refine(isCredentialSafeNote, "No incluyas credenciales ni tokens en la nota.");
const safeEvidence = z.string().trim().max(2_000).refine(isCredentialSafeNote, "No incluyas credenciales ni tokens en la referencia.");

registerCommand(FOLLOW_UP_COMMAND, {
  kind: FOLLOW_UP_KIND,
  capability: "imports.review",
  create: true,
  administrative: true,
  schema: z.strictObject({
    snapshotId: z.string().min(1).max(100),
    recordId: z.string().regex(/^[a-f0-9]{64}$/),
    status: followUpStatusSchema,
    note: safeNote,
    evidence: safeEvidence,
  }),
  authorize: async (ctx) => {
    await requireFullLegacySourceScope(ctx.tx, ctx.actor);
    const data = ctx.envelope.data as { snapshotId: string; recordId: string };
    if (ctx.envelope.targetId !== legacySourceFollowUpObjectId(data.recordId))
      throw new OperationError(400, "SOURCE_FOLLOW_UP_TARGET", "El seguimiento debe apuntar a la identidad de esa fila.");
    const snapshot = await ctx.tx.legacyImportSnapshot.findUnique({ where: { id: data.snapshotId }, select: {
      id: true, status: true, upload: { select: { completedAt: true } },
    } });
    assertCompleteSnapshot(snapshot);
    const record = await ctx.tx.legacySourceRecord.findFirst({ where: { id: data.recordId, snapshotId: data.snapshotId }, select: {
      id: true, snapshotId: true, sourceTable: true, original: true, normalized: true,
    } });
    if (!record) throw new OperationError(404, "IMPORT_RECORD_NOT_FOUND", "No se encontró la fila en este lote.");
    const clinicalAccess = (await capabilities(ctx.tx, ctx.actor)).includes("clinical.read");
    if (hasRestrictedClinicalRecord(record) && !clinicalAccess)
      throw new OperationError(403, "CLINICAL_CAPABILITY_REQUIRED", "El seguimiento de esta fila requiere permiso clínico.");
  },
  execute: async (ctx) => {
    const data = ctx.envelope.data as { snapshotId: string; recordId: string; status: LegacySourceFollowUpStatus; note: string; evidence: string };
    const followUp = {
      status: data.status,
      note: data.note,
      evidence: data.evidence,
      version: ctx.envelope.expectedVersion + 1,
      updatedAt: ctx.now.toISOString(),
      updatedBy: ctx.actor.id,
    };
    return { snapshotId: data.snapshotId, recordId: data.recordId, followUp };
  },
});

type SnapshotState = {
  id: string;
  sourceSystem: string;
  filename: string;
  fileHash: string;
  importerVersion: string;
  status: string;
  reviewedAt: Date | null;
  createdAt: Date;
  coverage?: unknown;
  upload?: { completedAt: Date | null } | null;
};

type CompleteSnapshotState = Pick<SnapshotState, "id" | "status" | "upload">;

function assertCompleteSnapshot<T extends CompleteSnapshotState>(snapshot: T | null): asserts snapshot is T {
  if (!snapshot) throw new OperationError(404, "IMPORT_NOT_FOUND", "No se encontró el lote legado.");
  if (snapshot.status === "uploading" || (snapshot.upload && !snapshot.upload.completedAt))
    throw new OperationError(423, "IMPORT_INCOMPLETE", "El lote debe finalizar y comprobarse antes de consultar o seguir sus filas.");
}

function safeDisplayTableName(tableName: string, includeClinical: boolean): string {
  if (!includeClinical && clinicalField(tableName)) return RESTRICTED_SOURCE_TABLE;
  const safe = redactAuthenticationValues(tableName);
  return typeof safe === "string" && !safe.startsWith("[excluded") ? safe : RESTRICTED_SOURCE_TABLE;
}

function coordinateOnlySheetsFor(snapshot: SnapshotState): LegacySourceSummary["coordinateOnlySheets"] {
  if (snapshot.sourceSystem !== APPSHEET_ARCHIVE_SOURCE_SYSTEM ||
      snapshot.coverage === null || typeof snapshot.coverage !== "object" || Array.isArray(snapshot.coverage)) return undefined;
  const raw = (snapshot.coverage as Record<string, unknown>).coordinateOnlyCoverage;
  const parsed = coordinateOnlySheetsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const names = parsed.data.map((sheet) => sheet.name);
  if (new Set(names).size !== APPSHEET_COORDINATE_ONLY_SHEETS.length ||
      APPSHEET_COORDINATE_ONLY_SHEETS.some((name) => !names.includes(name))) return undefined;
  return parsed.data.map((sheet) => ({
    name: safeDisplayTableName(sheet.name, false),
    extracted: false,
    dimension: sheet.dimension,
  }));
}

type AggregateRow = { snapshotId: string; tableName: string; rowCount: number; exceptionCount: number };
type UnattachedExceptionCount = { snapshotId: string; exceptionCount: number };

async function summariesFor(snapshots: SnapshotState[], includeClinical: boolean): Promise<LegacySourceSummary[]> {
  if (!snapshots.length) return [];
  const ids = snapshots.map((snapshot) => snapshot.id);
  const [aggregates, unattached] = await Promise.all([
    db.$queryRaw<AggregateRow[]>`
      SELECT r."snapshotId" AS "snapshotId", r."sourceTable" AS "tableName",
        COUNT(DISTINCT r."id")::int AS "rowCount", COUNT(DISTINCT e."id")::int AS "exceptionCount"
      FROM "LegacySourceRecord" r
      LEFT JOIN "LegacyException" e ON e."snapshotId" = r."snapshotId" AND e."sourceRecordId" = r."id"
      WHERE r."snapshotId" IN (${Prisma.join(ids)})
      GROUP BY r."snapshotId", r."sourceTable"
      ORDER BY r."snapshotId", r."sourceTable"`,
    db.$queryRaw<UnattachedExceptionCount[]>`
      SELECT "snapshotId", COUNT(*)::int AS "exceptionCount"
      FROM "LegacyException"
      WHERE "snapshotId" IN (${Prisma.join(ids)}) AND "sourceRecordId" IS NULL
      GROUP BY "snapshotId"`,
  ]);
  const bySnapshot = new Map<string, Map<string, LegacySourceTableSummary>>(
    snapshots.map((snapshot) => [snapshot.id, new Map<string, LegacySourceTableSummary>()] as const),
  );
  for (const row of aggregates) {
    const target = bySnapshot.get(row.snapshotId);
    if (!target) continue;
    const display = safeDisplayTableName(row.tableName, includeClinical);
    const table = target.get(display) ?? { tableName: display, rowCount: 0, exceptionCount: 0 };
    table.rowCount += row.rowCount;
    table.exceptionCount += row.exceptionCount;
    target.set(display, table);
  }
  const unattachedBySnapshot = new Map(unattached.map((row) => [row.snapshotId, row.exceptionCount] as const));
  return snapshots.map((snapshot) => {
    const tables = [...(bySnapshot.get(snapshot.id)?.values() ?? [])].sort((a, b) => a.tableName.localeCompare(b.tableName));
    const rowCount = tables.reduce((total, table) => total + table.rowCount, 0);
    const unattachedExceptionCount = unattachedBySnapshot.get(snapshot.id) ?? 0;
    const exceptionCount = tables.reduce((total, table) => total + table.exceptionCount, 0) + unattachedExceptionCount;
    const technicalSource = isTechnicalLegacySource(snapshot.sourceSystem);
    const coordinateOnlySheets = coordinateOnlySheetsFor(snapshot);
    const safe = redactAuthenticationValues({
      snapshotId: snapshot.id,
      ...sourceMetadataFor(snapshot, includeClinical),
      fileHash: snapshot.fileHash,
      status: snapshot.status,
      createdAt: snapshot.createdAt,
      reviewedAt: snapshot.reviewedAt,
      rowCount,
      exceptionCount,
      unattachedExceptionCount,
      tables,
      ...(coordinateOnlySheets ? { coordinateOnlySheets } : {}),
      technicalSource,
      allowedActions: { recordFollowUp: true as const, genericLegacyWorkflow: !technicalSource },
    });
    return wire(safe) as LegacySourceSummary;
  });
}

const listCursorSchema = z.strictObject({ version: z.literal(1), queryHash: z.string().regex(/^[a-f0-9]{64}$/), snapshotId: z.string().min(1).max(100) });
const rowCursorSchema = z.strictObject({ version: z.literal(1), queryHash: z.string().regex(/^[a-f0-9]{64}$/), recordId: z.string().regex(/^[a-f0-9]{64}$/) });
function encodeCursor(value: z.infer<typeof listCursorSchema> | z.infer<typeof rowCursorSchema>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function decodeCursor<T extends z.ZodType<{ queryHash: string }>>(cursor: string | undefined, schema: T, queryHash: string, message: string): z.infer<T> | null {
  if (!cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error("invalid cursor bytes");
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (Buffer.from(decoded).toString("base64url") !== cursor) throw new Error("noncanonical cursor");
    const parsed = schema.parse(JSON.parse(decoded));
    if (parsed.queryHash !== queryHash) throw new Error("cursor filter mismatch");
    return parsed as z.infer<T>;
  } catch {
    throw new OperationError(400, "INVALID_SOURCE_CURSOR", message);
  }
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sourceWhere(): Prisma.LegacyImportSnapshotWhereInput {
  return {
    status: { not: "uploading" },
    OR: [{ upload: { is: null } }, { upload: { is: { completedAt: { not: null } } } }],
  };
}

function sourceMetadataFor(snapshot: Pick<SnapshotState, "filename" | "sourceSystem" | "importerVersion">, includeClinical: boolean) {
  const project = (value: string) => !includeClinical && clinicalField(value) ? "[restricted source metadata]" : value;
  return { filename: project(snapshot.filename), sourceSystem: project(snapshot.sourceSystem), importerVersion: project(snapshot.importerVersion) };
}

function matchesVisibleSourceSearch(snapshot: SnapshotState, query: string, includeClinical: boolean): boolean {
  const safe = redactAuthenticationValues(sourceMetadataFor(snapshot, includeClinical)) as Record<string, unknown>;
  const values = [safe.filename, safe.sourceSystem].filter((value): value is string => typeof value === "string" && !value.startsWith("[excluded") && !value.startsWith("[restricted"));
  return foldSearchText(values.join(" ")).includes(foldSearchText(query));
}

const snapshotSelect = { id: true, sourceSystem: true, filename: true, fileHash: true, importerVersion: true, status: true, reviewedAt: true, createdAt: true, coverage: true, upload: { select: { completedAt: true } } } as const;
type SnapshotRow = Prisma.LegacyImportSnapshotGetPayload<{ select: typeof snapshotSelect }>;

async function requireSourceRead(actor: Parameters<typeof requireCapability>[1]): Promise<void> {
  await requireCapability(db, actor, "imports.review");
  await requireFullLegacySourceScope(db, actor);
}

async function loadLatestFollowUps(records: StagedRecord[]): Promise<Map<string, { value: Record<string, unknown>; version: number; actorId: string; committedAt: Date }>> {
  if (!records.length) return new Map();
  const targets = records.map((record) => legacySourceFollowUpObjectId(record.id));
  const receipts = await db.commandReceipt.findMany({
    where: { targetId: { in: targets }, command: FOLLOW_UP_COMMAND },
    orderBy: [{ targetId: "asc" }, { resultingVersion: "desc" }],
    select: { targetId: true, response: true, resultingVersion: true, actorId: true, committedAt: true },
  });
  const byTarget = new Map<string, { value: Record<string, unknown>; version: number; actorId: string; committedAt: Date }>();
  for (const receipt of receipts) {
    if (byTarget.has(receipt.targetId)) continue;
    const response = receipt.response as { result?: { followUp?: unknown } };
    const value = response?.result?.followUp;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    byTarget.set(receipt.targetId, { value: value as Record<string, unknown>, version: receipt.resultingVersion, actorId: receipt.actorId, committedAt: receipt.committedAt });
  }
  return byTarget;
}

function followUpFor(record: StagedRecord, latest: Map<string, { value: Record<string, unknown>; version: number; actorId: string; committedAt: Date }>, includeClinical: boolean) {
  if (!includeClinical && hasRestrictedClinicalRecord(record)) return null;
  const entry = latest.get(legacySourceFollowUpObjectId(record.id));
  if (!entry) return null;
  const status = followUpStatusSchema.safeParse(entry.value.status);
  const note = typeof entry.value.note === "string" ? redactAuthenticationValues(entry.value.note) : "";
  const evidence = typeof entry.value.evidence === "string" ? redactAuthenticationValues(entry.value.evidence) : "";
  const updatedAt = z.iso.datetime().safeParse(entry.value.updatedAt);
  return {
    status: status.success ? status.data : "pending",
    note: typeof note === "string" ? note : "[excluded authentication material]",
    evidence: typeof evidence === "string" ? evidence : "[excluded authentication material]",
    version: entry.version,
    updatedAt: updatedAt.success ? updatedAt.data : entry.committedAt.toISOString(),
    updatedBy: entry.actorId,
  } as const;
}

function foldSearchText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-AR");
}

function appendSearchableValue(output: string[], value: unknown): void {
  if (typeof value === "string") {
    if (value.startsWith("[excluded") || value.startsWith("[private") || containsRecognizableCredential(value)) return;
    output.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") { output.push(String(value)); return; }
  if (Array.isArray(value)) { for (const item of value) appendSearchableValue(output, item); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (isCredentialMetadataKey(key) || containsRecognizableCredential(key)) continue;
      appendSearchableValue(output, item);
    }
  }
}

function matchesVisibleSearch(record: StagedRecord, query: string, includeClinical: boolean): boolean {
  const redacted = redactStagedRecord(record, { includeClinical }) as Record<string, unknown>;
  const tokens: string[] = [];
  appendSearchableValue(tokens, redacted.sourceTable);
  appendSearchableValue(tokens, redacted.sourceRow);
  appendSearchableValue(tokens, safeTreatment(redacted.treatment));
  for (const part of [redacted.original, redacted.normalized]) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const columns = (part as { columns?: unknown }).columns;
    if (!Array.isArray(columns)) continue;
    for (const column of columns) {
      if (!column || typeof column !== "object" || Array.isArray(column)) continue;
      const projected = column as Record<string, unknown>;
      appendSearchableValue(tokens, projected.header);
      appendSearchableValue(tokens, projected.value);
      appendSearchableValue(tokens, projected.exactDecimal);
      appendSearchableValue(tokens, projected.moneyMinorUnits);
    }
  }
  return foldSearchText(tokens.join(" ")).includes(foldSearchText(query));
}

type ExceptionAggregate = { sourceRecordId: string; count: number };
type ExceptionRow = { id: string; sourceRecordId: string; kind: string; severity: string; status: string; ordinal: number };

async function exceptionCounts(snapshotId: string, recordIds: string[]): Promise<Map<string, number>> {
  if (!recordIds.length) return new Map();
  const groups = await db.legacyException.groupBy({
    by: ["sourceRecordId"],
    where: { snapshotId, sourceRecordId: { in: recordIds } },
    _count: { _all: true },
  });
  return new Map(groups.flatMap((group) => group.sourceRecordId ? [[group.sourceRecordId, group._count._all] as const] : []));
}

async function exceptionPageForRecords(snapshotId: string, recordIds: string[]): Promise<Map<string, LegacySourceExceptionView[]>> {
  if (!recordIds.length) return new Map();
  const rows = await db.$queryRaw<ExceptionRow[]>`
    SELECT "id", "sourceRecordId", "kind", "severity", "status", "ordinal"
    FROM (
      SELECT e."id", e."sourceRecordId", e."kind", e."severity", e."status",
        ROW_NUMBER() OVER (PARTITION BY e."sourceRecordId" ORDER BY e."id" ASC) AS "ordinal"
      FROM "LegacyException" e
      WHERE e."snapshotId" = ${snapshotId} AND e."sourceRecordId" IN (${Prisma.join(recordIds)})
    ) limited
    WHERE "ordinal" <= ${EXCEPTION_PAGE_SIZE_DEFAULT}
    ORDER BY "sourceRecordId" ASC, "id" ASC`;
  const result = new Map<string, LegacySourceExceptionView[]>();
  for (const row of rows) {
    const items = result.get(row.sourceRecordId) ?? [];
    items.push({ exceptionId: row.id, code: safeExceptionCode(row.kind), severity: safeExceptionSeverity(row.severity), status: safeExceptionStatus(row.status) });
    result.set(row.sourceRecordId, items);
  }
  return result;
}

function recordView(record: StagedRecord, exceptionCount: number, exceptions: LegacySourceExceptionView[], latest: Map<string, { value: Record<string, unknown>; version: number; actorId: string; committedAt: Date }>, includeClinical: boolean, mayRecordFollowUp: boolean): LegacySourceRecordView {
  const safe = redactStagedRecord(record, { includeClinical }) as Record<string, unknown>;
  return {
    recordId: record.id,
    tableName: typeof safe.sourceTable === "string" ? safe.sourceTable : RESTRICTED_SOURCE_TABLE,
    rowNumber: record.sourceRow,
    treatment: safeTreatment(safe.treatment),
    original: safe.original,
    normalized: safe.normalized,
    exceptionCount,
    exceptions,
    exceptionsTruncated: exceptionCount > exceptions.length,
    exceptionsNextCursor: exceptionCount > exceptions.length ? exceptions.at(-1)?.exceptionId ?? null : null,
    canRecordFollowUp: mayRecordFollowUp,
    followUp: followUpFor(record, latest, includeClinical),
  };
}

const followUpCursorSchema = z.string().max(100);
const sourceQuerySchema = z.strictObject({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT), q: z.string().trim().max(120).optional() });
const rowQuerySchema = z.strictObject({
  snapshotTable: z.string().trim().min(1).max(120).optional(),
  q: z.string().trim().max(120).optional(),
  exceptionOnly: z.enum(["true", "false"]).transform((value) => value === "true").optional().default(false),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

export const legacySourceControlRoutes = Router();

legacySourceControlRoutes.get("/", async (req, res) => {
  await requireSourceRead(req.user);
  const query = sourceQuerySchema.parse(req.query);
  const queryHash = fingerprint([query.q ?? "", query.limit]);
  const cursor = decodeCursor(query.cursor, listCursorSchema, queryHash, "Reiniciá la lista; cambió su filtro o cursor.");
  const where = sourceWhere();
  if (cursor && !await db.legacyImportSnapshot.findFirst({ where: { AND: [where, { id: cursor.snapshotId }] }, select: { id: true } }))
    throw new OperationError(400, "INVALID_SOURCE_CURSOR", "El cursor no pertenece a esta lista de fuentes.");
  const includeClinical = (await capabilities(db, req.user)).includes("clinical.read");
  if (query.q && cursor) {
    const boundary = await db.legacyImportSnapshot.findUnique({ where: { id: cursor.snapshotId }, select: snapshotSelect });
    if (!boundary || !matchesVisibleSourceSearch(boundary, query.q, includeClinical))
      throw new OperationError(400, "INVALID_SOURCE_CURSOR", "El cursor no pertenece a esta búsqueda visible.");
  }

  let page: SnapshotRow[];
  let hasMore: boolean;
  if (!query.q) {
    const snapshots = await db.legacyImportSnapshot.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      ...(cursor ? { cursor: { id: cursor.snapshotId }, skip: 1 } : {}),
      take: query.limit + 1,
      select: snapshotSelect,
    });
    hasMore = snapshots.length > query.limit;
    page = snapshots.slice(0, query.limit);
  } else {
    const matching: SnapshotRow[] = [];
    let scanCursor = cursor?.snapshotId;
    let scanned = 0;
    let exhausted = false;
    while (matching.length <= query.limit && scanned < MAX_SOURCE_SNAPSHOTS && !exhausted) {
      const take = Math.min(SEARCH_CHUNK_SIZE, MAX_SOURCE_SNAPSHOTS - scanned);
      const batch = await db.legacyImportSnapshot.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
        take,
        select: snapshotSelect,
      });
      if (!batch.length) { exhausted = true; break; }
      scanned += batch.length;
      scanCursor = batch.at(-1)!.id;
      exhausted = batch.length < take;
      matching.push(...batch.filter((snapshot) => matchesVisibleSourceSearch(snapshot, query.q!, includeClinical)));
    }
    if (matching.length <= query.limit && !exhausted && scanned >= MAX_SOURCE_SNAPSHOTS && scanCursor) {
      const beyondLimit = await db.legacyImportSnapshot.findFirst({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        cursor: { id: scanCursor },
        skip: 1,
        select: { id: true },
      });
      if (beyondLimit) throw new OperationError(422, "SOURCE_SEARCH_LIMIT", "Acotá la búsqueda para recorrer más de 20.000 fuentes.");
      exhausted = true;
    }
    hasMore = matching.length > query.limit;
    page = matching.slice(0, query.limit);
  }
  const items = await summariesFor(page, includeClinical);
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ version: 1, queryHash, snapshotId: last.id }) : null;
  res.json(wire({ items, nextCursor }));
});

legacySourceControlRoutes.get("/:snapshotId/records/:recordId/exceptions", async (req, res) => {
  await requireSourceRead(req.user);
  const params = z.strictObject({ snapshotId: z.string().min(1).max(100), recordId: followUpCursorSchema }).parse(req.params);
  const query = z.strictObject({ cursor: followUpCursorSchema.optional(), limit: z.coerce.number().int().min(1).max(EXCEPTION_PAGE_SIZE_MAX).default(EXCEPTION_PAGE_SIZE_DEFAULT) }).parse(req.query);
  const snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: params.snapshotId }, select: { id: true, status: true, upload: { select: { completedAt: true } } } });
  assertCompleteSnapshot(snapshot);
  const record = await db.legacySourceRecord.findFirst({ where: { id: params.recordId, snapshotId: params.snapshotId }, select: { id: true } });
  if (!record) throw new OperationError(404, "IMPORT_RECORD_NOT_FOUND", "No se encontró la fila en este lote.");
  const cursor = query.cursor;
  if (cursor && !await db.legacyException.findFirst({ where: { id: cursor, snapshotId: params.snapshotId, sourceRecordId: record.id }, select: { id: true } }))
    throw new OperationError(400, "INVALID_EXCEPTION_CURSOR", "El cursor no pertenece a las excepciones de esta fila.");
  const items = await db.legacyException.findMany({
    where: { snapshotId: params.snapshotId, sourceRecordId: record.id },
    orderBy: { id: "asc" },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: query.limit + 1,
    select: { id: true, kind: true, severity: true, status: true },
  });
  const hasMore = items.length > query.limit;
  const page = items.slice(0, query.limit).map((item): LegacySourceExceptionView => ({ exceptionId: item.id, code: safeExceptionCode(item.kind), severity: safeExceptionSeverity(item.severity), status: safeExceptionStatus(item.status) }));
  res.json(wire({ items: page, nextCursor: hasMore ? page.at(-1)?.exceptionId ?? null : null }));
});

legacySourceControlRoutes.get("/:snapshotId/exceptions", async (req, res) => {
  await requireSourceRead(req.user);
  const params = z.strictObject({ snapshotId: z.string().min(1).max(100) }).parse(req.params);
  const query = z.strictObject({ cursor: followUpCursorSchema.optional(), limit: z.coerce.number().int().min(1).max(EXCEPTION_PAGE_SIZE_MAX).default(EXCEPTION_PAGE_SIZE_DEFAULT) }).parse(req.query);
  const snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: params.snapshotId }, select: { id: true, status: true, upload: { select: { completedAt: true } } } });
  assertCompleteSnapshot(snapshot);
  const cursor = query.cursor;
  if (cursor && !await db.legacyException.findFirst({ where: { id: cursor, snapshotId: params.snapshotId, sourceRecordId: null }, select: { id: true } }))
    throw new OperationError(400, "INVALID_EXCEPTION_CURSOR", "El cursor no pertenece a las excepciones generales de este lote.");
  const rows = await db.legacyException.findMany({
    where: { snapshotId: params.snapshotId, sourceRecordId: null },
    orderBy: { id: "asc" },
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: query.limit + 1,
    select: { id: true, kind: true, severity: true, status: true },
  });
  const hasMore = rows.length > query.limit;
  const items = rows.slice(0, query.limit).map((row): LegacySourceExceptionView => ({
    exceptionId: row.id,
    code: safeExceptionCode(row.kind),
    severity: safeExceptionSeverity(row.severity),
    status: safeExceptionStatus(row.status),
  }));
  const page: LegacySourceExceptionPage = { items, nextCursor: hasMore ? items.at(-1)?.exceptionId ?? null : null };
  res.json(wire(page));
});

legacySourceControlRoutes.get("/:snapshotId/records", async (req, res) => {
  await requireSourceRead(req.user);
  const params = z.strictObject({ snapshotId: z.string().min(1).max(100) }).parse(req.params);
  const query = rowQuerySchema.parse(req.query);
  const snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: params.snapshotId }, select: { id: true, status: true, upload: { select: { completedAt: true } } } });
  assertCompleteSnapshot(snapshot);
  const includeClinical = (await capabilities(db, req.user)).includes("clinical.read");
  if (query.snapshotTable && !includeClinical && clinicalField(query.snapshotTable))
    throw new OperationError(403, "CLINICAL_CAPABILITY_REQUIRED", "El filtro de esta tabla requiere permiso clínico.");
  const queryHash = fingerprint([params.snapshotId, query.snapshotTable ?? "", query.q ?? "", query.exceptionOnly, query.limit]);
  const cursor = decodeCursor(query.cursor, rowCursorSchema, queryHash, "Reiniciá las filas; cambió el lote, filtro o cursor.");
  if (cursor && !await db.legacySourceRecord.findFirst({ where: { id: cursor.recordId, snapshotId: params.snapshotId }, select: { id: true } }))
    throw new OperationError(400, "INVALID_SOURCE_CURSOR", "El cursor no pertenece a las filas de este lote.");
  const restrictedTableFilter = query.snapshotTable === RESTRICTED_SOURCE_TABLE && !includeClinical;
  const realTableFilter = query.snapshotTable && !restrictedTableFilter && (includeClinical || !clinicalField(query.snapshotTable)) ? query.snapshotTable : undefined;
  const where: Prisma.LegacySourceRecordWhereInput = {
    snapshotId: params.snapshotId,
    ...(realTableFilter ? { sourceTable: realTableFilter } : {}),
  };
  const matching: StagedRecord[] = [];
  let scanCursor = cursor?.recordId;
  let scanned = 0;
  let exhausted = false;
  while (matching.length <= query.limit && scanned < MAX_SOURCE_ROWS && !exhausted) {
    const take = Math.min(SEARCH_CHUNK_SIZE, MAX_SOURCE_ROWS - scanned);
    const batch = await db.legacySourceRecord.findMany({
      where,
      orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }, { id: "asc" }],
      ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
      take,
      select: { id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true, contentHash: true, original: true, normalized: true, treatment: true, resolution: true },
    }) as StagedRecord[];
    if (!batch.length) { exhausted = true; break; }
    scanned += batch.length;
    scanCursor = batch.at(-1)!.id;
    exhausted = batch.length < take;
    const counts = await exceptionCounts(params.snapshotId, batch.map((record) => record.id));
    for (const record of batch) {
      if (query.snapshotTable && (restrictedTableFilter ? safeDisplayTableName(record.sourceTable, includeClinical) !== RESTRICTED_SOURCE_TABLE : record.sourceTable !== query.snapshotTable)) continue;
      if (query.exceptionOnly && !(counts.get(record.id) ?? 0)) continue;
      if (query.q && !matchesVisibleSearch(record, query.q, includeClinical)) continue;
      matching.push(record);
      if (matching.length > query.limit) break;
    }
  }
  if (matching.length <= query.limit && !exhausted && scanned >= MAX_SOURCE_ROWS && scanCursor) {
    const beyondLimit = await db.legacySourceRecord.findFirst({
      where,
      orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }, { id: "asc" }],
      cursor: { id: scanCursor },
      skip: 1,
      select: { id: true },
    });
    if (beyondLimit) throw new OperationError(422, "SOURCE_ROW_SCAN_LIMIT", "Acotá los filtros para recorrer más de 100.000 filas.");
    exhausted = true;
  }
  const hasMore = matching.length > query.limit;
  const page = matching.slice(0, query.limit);
  const pageIds = page.map((record) => record.id);
  const [counts, exceptions, latest] = await Promise.all([
    exceptionCounts(params.snapshotId, pageIds),
    exceptionPageForRecords(params.snapshotId, pageIds),
    loadLatestFollowUps(page),
  ]);
  const items = page.map((record) => recordView(record, counts.get(record.id) ?? 0, exceptions.get(record.id) ?? [], latest, includeClinical, includeClinical || !hasRestrictedClinicalRecord(record)));
  const last = page.at(-1);
  const nextCursor = hasMore && last ? encodeCursor({ version: 1, queryHash, recordId: last.id }) : null;
  res.json(wire({ items, nextCursor }));
});

legacySourceControlRoutes.get("/:snapshotId", async (req, res) => {
  await requireSourceRead(req.user);
  const params = z.strictObject({ snapshotId: z.string().min(1).max(100) }).parse(req.params);
  const snapshot = await db.legacyImportSnapshot.findUnique({ where: { id: params.snapshotId }, select: snapshotSelect });
  assertCompleteSnapshot(snapshot);
  const includeClinical = (await capabilities(db, req.user)).includes("clinical.read");
  const [source] = await summariesFor([snapshot as SnapshotRow], includeClinical);
  res.json(wire({ source }));
});
