import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { Router, type Request } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import {
  APPSHEET_HISTORY_IMPORTER_VERSION,
  APPSHEET_HISTORY_MAPPING_ID,
  APPSHEET_HISTORY_SOURCE_SYSTEM,
} from "../../shared/operations/appsheet-history.js";
import {
  APPSHEET_PENDING_MAPPING_ID,
  APPSHEET_PENDING_SCHEMA_VERSION,
  appSheetPendingReconciliationSchema,
  pendingMappingFingerprintPayload,
  type AppSheetPendingRelationship,
  type AppSheetPendingSourceReference,
} from "../../shared/operations/appsheet-pending.js";
import { sha256Canonical } from "../../shared/operations/appsheet-pending-import.js";
import { OperationError, requireCapability, type Tx, wire } from "./core.js";
import { requireBoundAppSheetHistoryStage } from "./appsheet-history-review.js";
import { requireFullLegacySourceScope } from "./legacy-source-policy.js";

const HEAD_TABLE = "Pre_Venta" as const;
const DETAIL_TABLE = "Pre_Detalle_Fact" as const;
const HEAD_KEY_FIELD = "Id_Preventa" as const;
const DETAIL_PARENT_FIELD = "Id_Pre_Venta" as const;
const MAX_PAGE_SIZE = 100;
const MAX_REFERENCED_DETAILS = 1_000;
const HASH = /^[a-f0-9]{64}$/;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

type Actor = NonNullable<Request["user"]>;
type SnapshotRecord = {
  id: string;
  snapshotId: string;
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  fileHash: string;
  contentHash: string;
  importerVersion: string;
  original: unknown;
  normalized: unknown;
  treatment: string;
};
type VerifiedRecord = SnapshotRecord & {
  reconciliation: z.infer<typeof appSheetPendingReconciliationSchema>;
};
type PageAnchor = { sourceRow: number; id: string };
type ListCursor = { version: 1; snapshotId: string; filterHash: string; after: PageAnchor };
type DetailCursor = {
  version: 1;
  snapshotId: string;
  parentRecordId: string;
  parentContentHash: string;
  relationshipHash: string;
  after: PageAnchor;
};
type LinkState = {
  status: AppSheetPendingRelationship["status"];
  matchCount: number | null;
  matchesHash: string | null;
  references: AppSheetPendingSourceReference[] | null;
  sourceValue: string | null;
};

const listCursorSchema = z.strictObject({
  version: z.literal(1),
  snapshotId: z.string().min(1).max(100),
  filterHash: z.string().regex(HASH),
  after: z.strictObject({ sourceRow: z.number().int().positive().max(100_000), id: z.string().min(1).max(100) }),
});
const detailCursorSchema = z.strictObject({
  version: z.literal(1),
  snapshotId: z.string().min(1).max(100),
  parentRecordId: z.string().min(1).max(100),
  parentContentHash: z.string().regex(HASH),
  relationshipHash: z.string().regex(HASH),
  after: z.strictObject({ sourceRow: z.number().int().positive().max(100_000), id: z.string().min(1).max(100) }),
});

const asObject = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function integrityFailure(blocker: string): never {
  throw new OperationError(423, "APPSHEET_PREORDER_SOURCE_INTEGRITY", "La captura archivada de preventas no conserva una prueba completa y vinculada.", { blockers: [blocker] });
}

function invalidCursor(): never {
  throw new OperationError(400, "APPSHEET_PREORDER_CURSOR", "Reiniciá la página: el cursor no pertenece a esta captura y a sus filtros actuales.");
}

function encodeCursor(value: ListCursor | DetailCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T>(raw: string | undefined, schema: z.ZodType<T>, expected: (value: T) => boolean): T | null {
  if (raw === undefined) return null;
  if (raw.length > 1_024) return invalidCursor();
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = schema.safeParse(JSON.parse(decoded));
    if (!parsed.success || !expected(parsed.data)) return invalidCursor();
    return parsed.data;
  } catch {
    return invalidCursor();
  }
}

function coverageSheets(coverageValue: unknown): Array<Record<string, unknown>> {
  const coverage = asObject(coverageValue);
  if (!coverage || !Array.isArray(coverage.sheets)) integrityFailure("history_table_coverage_missing");
  const sheets = coverage.sheets.map(asObject);
  if (sheets.some(sheet => !sheet)) integrityFailure("history_table_coverage_invalid");
  return sheets as Array<Record<string, unknown>>;
}

function sheetOrderFor(coverageValue: unknown): Map<string, number> {
  const order = new Map<string, number>();
  for (const [index, sheet] of coverageSheets(coverageValue).entries()) {
    if (typeof sheet.sourceTable !== "string" || !sheet.sourceTable || order.has(sheet.sourceTable))
      integrityFailure("history_table_order_invalid");
    order.set(sheet.sourceTable, index);
  }
  return order;
}

/**
 * requireBoundAppSheetHistoryStage verifies stage/review metadata and live counts. The
 * importer deliberately leaves per-row bytes to consumers, so this reader rechecks the
 * complete sealed record manifest before returning any source values.
 */
async function verifySnapshotRecordManifest(tx: Tx, proof: Awaited<ReturnType<typeof requireBoundAppSheetHistoryStage>>): Promise<void> {
  const rows = await tx.legacySourceRecord.findMany({
    where: { snapshotId: proof.snapshot.id },
    select: {
      id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true,
      fileHash: true, contentHash: true, importerVersion: true, original: true, normalized: true, treatment: true,
    },
  });
  if (rows.length !== proof.capture.dataRecordCount || rows.length > 100_000)
    integrityFailure("history_record_count_changed");
  const order = sheetOrderFor(proof.snapshot.coverage);
  if (rows.some(row => !order.has(row.sourceTable) || row.fileHash !== proof.snapshot.fileHash ||
      row.importerVersion !== APPSHEET_HISTORY_IMPORTER_VERSION || !HASH.test(row.contentHash)))
    integrityFailure("history_record_binding_changed");
  const sourceIdentities = new Set<string>();
  for (const row of rows) {
    const normalized = asObject(row.normalized);
    if (!normalized || !Object.prototype.hasOwnProperty.call(normalized, "pendingReconciliation")) continue;
    if (!row.sourceKey) integrityFailure("pending_source_key_binding_mismatch");
    const identity = `${row.sourceTable}\0${row.sourceKey}`;
    if (sourceIdentities.has(identity)) integrityFailure("pending_source_key_duplicated");
    sourceIdentities.add(identity);
  }
  rows.sort((left, right) => order.get(left.sourceTable)! - order.get(right.sourceTable)! ||
    left.sourceRow - right.sourceRow || left.id.localeCompare(right.id));
  const sealedRecords = rows.map(row => ({
    id: row.id,
    snapshotId: row.snapshotId,
    sourceTable: row.sourceTable,
    sourceKey: row.sourceKey,
    sourceRow: row.sourceRow,
    fileHash: row.fileHash,
    contentHash: row.contentHash,
    importerVersion: row.importerVersion,
    original: row.original,
    normalized: row.normalized,
    treatment: row.treatment,
  }));
  if (typeof proof.stage.recordsHash !== "string" || !HASH.test(proof.stage.recordsHash) ||
      sha256Canonical(sealedRecords, sha256) !== proof.stage.recordsHash)
    integrityFailure("history_source_projection_content_changed");
}

async function requireReviewedRead(tx: Tx, actor: Actor, snapshotId: string) {
  await requireCapability(tx, actor, "imports.review");
  await requireFullLegacySourceScope(tx, actor);
  const proof = await requireBoundAppSheetHistoryStage(tx, snapshotId, { requireReviewed: true });
  if (proof.snapshot.importerVersion !== APPSHEET_HISTORY_IMPORTER_VERSION || proof.snapshot.status !== "reviewed")
    integrityFailure("reviewed_history_snapshot_required");
  await verifySnapshotRecordManifest(tx, proof);
  return proof;
}

async function requireTableCoverage(tx: Tx, proof: Awaited<ReturnType<typeof requireBoundAppSheetHistoryStage>>, table: typeof HEAD_TABLE | typeof DETAIL_TABLE): Promise<number> {
  const tableEntries = coverageSheets(proof.snapshot.coverage).filter(sheet => sheet.sourceTable === table);
  if (tableEntries.length !== 1 || !Number.isSafeInteger(tableEntries[0]?.sourceRecordCount) ||
      (tableEntries[0]!.sourceRecordCount as number) < 0)
    integrityFailure(`coverage_missing_or_ambiguous_${table}`);
  const expected = tableEntries[0]!.sourceRecordCount as number;
  const actual = await tx.legacySourceRecord.count({ where: { snapshotId: proof.snapshot.id, sourceTable: table } });
  if (actual !== expected) integrityFailure(`record_coverage_changed_${table}`);
  return expected;
}

function normalizedColumns(record: Pick<SnapshotRecord, "normalized">): Array<Record<string, unknown>> {
  const normalized = asObject(record.normalized);
  if (!normalized || !Array.isArray(normalized.columns)) integrityFailure("normalized_source_columns_missing");
  const columns = normalized.columns.map(asObject);
  if (columns.some(column => !column)) integrityFailure("normalized_source_columns_invalid");
  return columns as Array<Record<string, unknown>>;
}

function normalizedFieldValue(record: Pick<SnapshotRecord, "normalized">, header: string): { valid: boolean; value: string | null } {
  const matches = normalizedColumns(record).filter(column => column.header === header);
  if (matches.length !== 1) return { valid: false, value: null };
  const value = matches[0]!.value;
  if (value !== null && typeof value !== "string") return { valid: false, value: null };
  return { valid: true, value: value as string | null };
}

function verifyRecord(record: SnapshotRecord, proof: Awaited<ReturnType<typeof requireBoundAppSheetHistoryStage>>, mappingHash: string): VerifiedRecord {
  if (record.snapshotId !== proof.snapshot.id || record.fileHash !== proof.snapshot.fileHash ||
      record.importerVersion !== APPSHEET_HISTORY_IMPORTER_VERSION || record.treatment !== "archive_only" ||
      !record.sourceKey || !HASH.test(record.contentHash))
    integrityFailure("preorder_source_record_binding_invalid");
  const normalized = asObject(record.normalized);
  const sourceColumns = normalized?.columns;
  const parsed = appSheetPendingReconciliationSchema.safeParse(normalized?.pendingReconciliation);
  if (!Array.isArray(sourceColumns) || !parsed.success) integrityFailure("preorder_pending_reconciliation_missing_or_invalid");
  const reconciliation = parsed.data;
  if (reconciliation.schemaVersion !== APPSHEET_PENDING_SCHEMA_VERSION || reconciliation.mappingId !== APPSHEET_PENDING_MAPPING_ID ||
      reconciliation.mappingHash !== mappingHash || reconciliation.capture.captureId !== proof.capture.captureId ||
      reconciliation.capture.manifestHash !== proof.capture.manifestHash || reconciliation.capture.mode !== "stable" ||
      reconciliation.capture.provisional || reconciliation.source.sourceTable !== record.sourceTable ||
      reconciliation.source.sourceRow !== record.sourceRow ||
      reconciliation.source.sourceKeyHash !== sha256Canonical(["appsheet-pending-key-v1", record.sourceTable, record.sourceKey], sha256))
    integrityFailure("preorder_pending_source_identity_changed");
  const expectedEvidenceHash = sha256Canonical({
    sourceTable: record.sourceTable,
    sourceRow: record.sourceRow,
    sourceKey: record.sourceKey,
    original: record.original,
    normalizedColumns: sourceColumns,
  }, sha256);
  if (reconciliation.source.sourceEvidenceHash !== expectedEvidenceHash)
    integrityFailure("preorder_pending_source_evidence_changed");
  return { ...record, reconciliation };
}

function sourceRowValue(record: Pick<SnapshotRecord, "normalized">, header: string): string | null {
  const result = normalizedFieldValue(record, header);
  return result.valid ? result.value : null;
}

function compareReferences(left: AppSheetPendingSourceReference, right: AppSheetPendingSourceReference): number {
  return left.sourceTable.localeCompare(right.sourceTable) || left.sourceRow - right.sourceRow ||
    left.sourceKeyHash.localeCompare(right.sourceKeyHash);
}

function detailsLink(record: VerifiedRecord): LinkState {
  const dimension = record.reconciliation.dimensions.preSale;
  const matches = dimension.relationships.filter(relationship => relationship.sourceField === HEAD_KEY_FIELD &&
    relationship.targetTable === DETAIL_TABLE && relationship.targetField === DETAIL_PARENT_FIELD);
  if (matches.length !== 1) integrityFailure("preorder_detail_relationship_missing_or_ambiguous");
  const relation = matches[0]!;
  const sourceValue = sourceRowValue(record, HEAD_KEY_FIELD);
  if (relation.status === "missing") {
    const hasSourceValue = sourceValue !== null && sourceValue.trim() !== "";
    const expectedValueHash = hasSourceValue
      ? sha256Canonical(["appsheet-pending-rel-v1", HEAD_TABLE, HEAD_KEY_FIELD, sourceValue], sha256)
      : null;
    if (relation.matchCount !== 0 || relation.target !== undefined || relation.targets !== undefined ||
        relation.matchesHash !== null || relation.valueHash !== expectedValueHash)
      integrityFailure("preorder_missing_relationship_binding_invalid");
    return { status: relation.status, matchCount: 0, matchesHash: null, references: [], sourceValue };
  }
  if (relation.status !== "unique" && relation.status !== "multiple")
    return { status: relation.status, matchCount: relation.matchCount, matchesHash: relation.matchesHash, references: null, sourceValue };
  if (sourceValue === null || sourceValue.trim() === "" ||
      relation.valueHash !== sha256Canonical(["appsheet-pending-rel-v1", HEAD_TABLE, HEAD_KEY_FIELD, sourceValue], sha256))
    integrityFailure("preorder_relationship_value_binding_invalid");
  const references = relation.status === "unique"
    ? relation.target && !relation.targets ? [relation.target] : null
    : relation.targets && relation.target === undefined ? relation.targets : null;
  if (!references || !references.length || references.length > MAX_REFERENCED_DETAILS ||
      relation.matchCount !== references.length || references.some(reference => reference.sourceTable !== DETAIL_TABLE ||
        !HASH.test(reference.sourceKeyHash) || !HASH.test(reference.sourceEvidenceHash) ||
        !Number.isSafeInteger(reference.sourceRow) || reference.sourceRow < 1 || reference.sourceRow > 100_000) ||
      new Set(references.map(reference => reference.sourceRow)).size !== references.length)
    integrityFailure("preorder_relationship_references_invalid");
  const sorted = [...references].sort(compareReferences);
  if (relation.matchesHash !== sha256Canonical(sorted, sha256)) integrityFailure("preorder_relationship_match_hash_invalid");
  return { status: relation.status, matchCount: references.length, matchesHash: relation.matchesHash,
    references: sorted, sourceValue };
}

async function responseContext(tx: Tx, actor: Actor, snapshotId: string) {
  const proof = await requireReviewedRead(tx, actor, snapshotId);
  const [preVentaCount, detailCount, publication, authority] = await Promise.all([
    requireTableCoverage(tx, proof, HEAD_TABLE),
    requireTableCoverage(tx, proof, DETAIL_TABLE),
    tx.legacyHistoryPublication.findUnique({ where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM }, select: {
      snapshotId: true, fileHash: true, mappingId: true, publishedAt: true,
    } }),
    tx.operationAuthority.findUnique({ where: { id: "operations" }, select: {
      mode: true, cutoverProfile: true, captureManifestId: true, epoch: true,
    } }),
  ]);
  const publicationStatus = !publication ? "not_published"
    : publication.snapshotId === proof.snapshot.id
      ? publication.fileHash === proof.snapshot.fileHash && publication.mappingId === APPSHEET_HISTORY_MAPPING_ID
        ? "published_snapshot" : "publication_binding_mismatch"
      : "another_snapshot_published";
  if (publicationStatus === "publication_binding_mismatch") integrityFailure("history_publication_binding_mismatch");
  return {
    proof,
    tableCounts: { [HEAD_TABLE]: preVentaCount, [DETAIL_TABLE]: detailCount },
    sourceStatus: {
      classification: "provisional_archive_only" as const,
      provisionalReasons: ["archived_capture_is_not_a_live_delta", "this_reader_does_not_activate_operations"],
      captureStability: "stable_at_capture" as const,
      reviewedAt: proof.snapshot.reviewedAt?.toISOString() ?? null,
      cutoffAt: proof.capture.cutoffAt.toISOString(),
      captureId: proof.capture.captureId,
      manifestHash: proof.capture.manifestHash,
      dataHash: proof.capture.dataHash,
      publication: { status: publicationStatus, publishedAt: publication?.publishedAt.toISOString() ?? null },
      currentBomboAuthority: authority ? {
        mode: authority.mode, cutoverProfile: authority.cutoverProfile,
        captureManifestId: authority.captureManifestId, epoch: authority.epoch,
      } : null,
      fullSnapshotRecordManifest: "verified" as const,
    },
  };
}

function paginationLimit(raw: unknown): number {
  return z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).parse(raw ?? 50);
}

function listFilterHash(snapshotId: string): string {
  return sha256Canonical({ version: 1, snapshotId, sourceTable: HEAD_TABLE }, sha256);
}

function sourceView(record: VerifiedRecord) {
  const preSale = record.sourceTable === HEAD_TABLE ? {
    status: record.reconciliation.dimensions.preSale.status,
    reasonCodes: record.reconciliation.dimensions.preSale.reasonCodes,
    evidenceFields: record.reconciliation.dimensions.preSale.evidenceFields,
    detailRelationship: (() => {
      const link = detailsLink(record);
      return {
        status: link.status,
        matchCount: link.matchCount,
        matchesHash: link.matchesHash,
        detailsAvailable: link.references !== null,
      };
    })(),
  } : null;
  return {
    sourceRecordId: record.id,
    sourceTable: record.sourceTable,
    sourceRow: record.sourceRow,
    sourceKey: record.sourceKey,
    sourceRecordHash: record.contentHash,
    original: record.original,
    normalized: record.normalized,
    treatment: record.treatment,
    provenance: {
      snapshotId: record.snapshotId,
      fileHash: record.fileHash,
      importerVersion: record.importerVersion,
      rowIntegrity: "sealed_snapshot_manifest_and_pending_evidence_verified" as const,
    },
    ...(preSale ? { preSale } : {}),
  };
}

export const appSheetPreorderSourceRoutes = Router();

appSheetPreorderSourceRoutes.get("/snapshots/:snapshotId/preventas", async (req, res) => {
  const snapshotId = z.string().min(1).max(100).parse(req.params.snapshotId);
  const limit = paginationLimit(req.query.limit);
  const filterHash = listFilterHash(snapshotId);
  const cursor = decodeCursor(req.query.cursor === undefined ? undefined : String(req.query.cursor), listCursorSchema,
    value => value.snapshotId === snapshotId && value.filterHash === filterHash);

  const result = await db.$transaction(async tx => {
    const context = await responseContext(tx, req.user, snapshotId);
    if (cursor) {
      const anchor = await tx.legacySourceRecord.findFirst({ where: {
        id: cursor.after.id, snapshotId, sourceTable: HEAD_TABLE,
      }, select: { sourceRow: true } });
      if (!anchor || anchor.sourceRow !== cursor.after.sourceRow) invalidCursor();
    }
    const rows = await tx.legacySourceRecord.findMany({
      where: {
        snapshotId,
        sourceTable: HEAD_TABLE,
        ...(cursor ? { OR: [
          { sourceRow: { gt: cursor.after.sourceRow } },
          { sourceRow: cursor.after.sourceRow, id: { gt: cursor.after.id } },
        ] } : {}),
      },
      orderBy: [{ sourceRow: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true, fileHash: true,
        contentHash: true, importerVersion: true, original: true, normalized: true, treatment: true,
      },
    });
    const items = rows.slice(0, limit).map(row => sourceView(verifyRecord(row, context.proof, sha256(pendingMappingFingerprintPayload()))));
    const last = rows.length > limit ? items.at(-1) : undefined;
    const lastRow = rows[limit - 1];
    const nextCursor = last && lastRow ? encodeCursor({ version: 1, snapshotId, filterHash,
      after: { sourceRow: lastRow.sourceRow, id: lastRow.id } }) : null;
    return {
      source: context.sourceStatus,
      coverage: { sourceTable: HEAD_TABLE, expectedRecords: context.tableCounts[HEAD_TABLE], pageSize: limit },
      items,
      nextCursor,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 60_000 });
  res.json(wire(result));
});

appSheetPreorderSourceRoutes.get("/snapshots/:snapshotId/preventas/:sourceRecordId/detalles", async (req, res) => {
  const snapshotId = z.string().min(1).max(100).parse(req.params.snapshotId);
  const sourceRecordId = z.string().min(1).max(100).parse(req.params.sourceRecordId);
  const limit = paginationLimit(req.query.limit);
  const rawCursor = req.query.cursor === undefined ? undefined : String(req.query.cursor);

  const result = await db.$transaction(async tx => {
    const context = await responseContext(tx, req.user, snapshotId);
    const mappingHash = sha256(pendingMappingFingerprintPayload());
    const parentRow = await tx.legacySourceRecord.findFirst({ where: {
      id: sourceRecordId, snapshotId, sourceTable: HEAD_TABLE,
    }, select: {
      id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true, fileHash: true,
      contentHash: true, importerVersion: true, original: true, normalized: true, treatment: true,
    } });
    if (!parentRow) throw new OperationError(404, "APPSHEET_PREORDER_NOT_FOUND", "No se encontró la preventa en esta captura revisada.");
    const parent = verifyRecord(parentRow, context.proof, mappingHash);
    const link = detailsLink(parent);
    if (link.status === "missing") {
      return {
        source: context.sourceStatus,
        parent: sourceView(parent),
        relationship: { status: link.status, matchCount: 0, matchesHash: null,
          detailsAvailable: true, unresolvedReason: null },
        coverage: { sourceTable: DETAIL_TABLE, expectedRecords: context.tableCounts[DETAIL_TABLE], linkedRecords: 0, pageSize: limit },
        items: [],
        nextCursor: null,
      };
    }
    if (link.status !== "unique" && link.status !== "multiple") {
      return {
        source: context.sourceStatus,
        parent: sourceView(parent),
        relationship: { status: link.status, matchCount: link.matchCount, matchesHash: link.matchesHash,
          detailsAvailable: false, unresolvedReason: "La relación del detalle no pudo verificarse con la evidencia archivada." },
        coverage: { sourceTable: DETAIL_TABLE, expectedRecords: context.tableCounts[DETAIL_TABLE], linkedRecords: null, pageSize: limit },
        items: [],
        nextCursor: null,
      };
    }
    const references = link.references;
    if (!references || references.length !== link.matchCount || references.length > MAX_REFERENCED_DETAILS || !link.matchesHash)
      integrityFailure("preorder_detail_link_cardinality_invalid");
    const cursor = decodeCursor(rawCursor, detailCursorSchema,
      value => value.snapshotId === snapshotId && value.parentRecordId === parent.id &&
        value.parentContentHash === parent.contentHash && value.relationshipHash === link.matchesHash);
    let startIndex = 0;
    if (cursor) {
      const anchorIndex = references.findIndex(reference => reference.sourceRow === cursor.after.sourceRow);
      if (anchorIndex < 0) invalidCursor();
      const referencedAnchor = references[anchorIndex]!;
      const anchor = await tx.legacySourceRecord.findFirst({ where: {
        id: cursor.after.id, snapshotId, sourceTable: DETAIL_TABLE, sourceRow: cursor.after.sourceRow,
      }, select: { id: true } });
      if (!anchor || referencedAnchor.sourceTable !== DETAIL_TABLE) invalidCursor();
      startIndex = anchorIndex + 1;
    }
    const childRows = await tx.legacySourceRecord.findMany({
      where: { snapshotId, sourceTable: DETAIL_TABLE, sourceRow: { in: references.map(reference => reference.sourceRow) } },
      orderBy: [{ sourceRow: "asc" }, { id: "asc" }],
      select: {
        id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true, fileHash: true,
        contentHash: true, importerVersion: true, original: true, normalized: true, treatment: true,
      },
    });
    if (childRows.length !== references.length) integrityFailure("preorder_linked_details_missing");
    const verifiedChildren = childRows.map(row => verifyRecord(row, context.proof, mappingHash));
    const byRow = new Map(verifiedChildren.map(row => [row.sourceRow, row]));
    for (const reference of references) {
      const detail = byRow.get(reference.sourceRow);
      if (!detail) integrityFailure("preorder_linked_detail_reference_missing");
      const expectedKeyHash = sha256Canonical(["appsheet-pending-key-v1", DETAIL_TABLE, detail.sourceKey], sha256);
      const expectedEvidenceHash = sha256Canonical({
        sourceTable: DETAIL_TABLE,
        sourceRow: detail.sourceRow,
        sourceKey: detail.sourceKey,
        original: detail.original,
        normalizedColumns: normalizedColumns(detail),
      }, sha256);
      const childParentValue = normalizedFieldValue(detail, DETAIL_PARENT_FIELD);
      if (reference.sourceTable !== DETAIL_TABLE || reference.sourceKeyHash !== expectedKeyHash ||
          reference.sourceEvidenceHash !== expectedEvidenceHash || !childParentValue.valid ||
          childParentValue.value !== link.sourceValue)
        integrityFailure("preorder_linked_detail_source_binding_changed");
    }
    const page = verifiedChildren.slice(startIndex, startIndex + limit + 1);
    const pageItems = page.slice(0, limit).map(sourceView);
    const hasMore = page.length > limit;
    const last = hasMore ? page[limit - 1] : undefined;
    const nextCursor = last && link.matchesHash ? encodeCursor({ version: 1, snapshotId,
      parentRecordId: parent.id, parentContentHash: parent.contentHash, relationshipHash: link.matchesHash,
      after: { sourceRow: last.sourceRow, id: last.id } }) : null;
    return {
      source: context.sourceStatus,
      parent: sourceView(parent),
      relationship: { status: link.status, matchCount: references.length, matchesHash: link.matchesHash, detailsAvailable: true },
      coverage: { sourceTable: DETAIL_TABLE, expectedRecords: context.tableCounts[DETAIL_TABLE], linkedRecords: references.length, pageSize: limit },
      items: pageItems,
      nextCursor,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5_000, timeout: 60_000 });
  res.json(wire(result));
});
