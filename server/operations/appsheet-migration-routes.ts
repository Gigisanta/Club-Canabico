import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { OperationError, requireCapability } from "./core.js";
import { requireFullLegacySourceScope } from "./legacy-source-policy.js";
import { APPSHEET_HISTORY_SOURCE_SYSTEM } from "../../shared/operations/appsheet-history.js";
import type { AppSheetMigrationSummary } from "../../shared/operations/appsheet-migration.js";
import { appSheetPendingReconciliationSchema, APPSHEET_PENDING_SCHEMA_VERSION } from "../../shared/operations/appsheet-pending.js";

export const appSheetMigrationRoutes = Router();
appSheetMigrationRoutes.use(async (req, _res, next) => {
  await requireCapability(db, req.user, "imports.review");
  await requireFullLegacySourceScope(db, req.user);
  next();
});

appSheetMigrationRoutes.get("/", async (_req, res) => {
  const captures = await db.appSheetCaptureManifest.findMany({
    where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM },
    orderBy: [{ cutoffAt: "desc" }, { captureId: "desc" }], take: 10,
    include: { snapshots: { orderBy: { id: "asc" }, select: { id: true, importerVersion: true, status: true } } },
  });
  const preliminarySnapshots = await db.legacyImportSnapshot.findMany({
    where: { sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, captureManifestId: null },
    select: { id: true, importerVersion: true, status: true, createdAt: true, fileHash: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: 20,
  });
  const preliminary = await Promise.all(preliminarySnapshots.map(async snapshot => {
    const [tables, facts, openExceptions] = await Promise.all([
      db.legacySourceRecord.groupBy({ by: ["sourceTable"], where: { snapshotId: snapshot.id }, _count: { _all: true } }),
      db.legacyHistoricalFact.count({ where: { snapshotId: snapshot.id } }),
      db.legacyException.count({ where: { snapshotId: snapshot.id, status: "open" } }),
    ]);
    return { id: snapshot.id, importerVersion: snapshot.importerVersion, status: snapshot.status,
      createdAt: snapshot.createdAt.toISOString(), manifestHash: snapshot.fileHash,
      records: tables.reduce((sum, table) => sum + table._count._all, 0), facts, openExceptions,
      tables: tables.map(table => ({ name: table.sourceTable, records: table._count._all })).sort((a, b) => a.name.localeCompare(b.name)) };
  }));
  const summary: AppSheetMigrationSummary = { preliminary, captures: await Promise.all(captures.map(async capture => ({
    captureId: capture.captureId, manifestHash: capture.manifestHash, definitionHash: capture.definitionHash,
    cutoffAt: capture.cutoffAt.toISOString(), verifiedAt: capture.verificationCompletedAt.toISOString(),
    sheets: capture.dataSheetCount, pages: capture.dataPageCount, records: capture.dataRecordCount,
    formulas: capture.dataFormulaCount, unresolvedFormulas: capture.dataUnresolvedFormulaCount,
    inventory: { tables: capture.definitionTableCount, columns: capture.definitionColumnCount,
      slices: capture.definitionSliceCount, views: capture.definitionViewCount,
      actions: capture.definitionActionCount, bots: capture.definitionBotCount },
    snapshots: await Promise.all(capture.snapshots.map(async snapshot => {
      const [tables, facts, openExceptions] = await Promise.all([
        db.legacySourceRecord.groupBy({ by: ["sourceTable"], where: { snapshotId: snapshot.id }, _count: { _all: true } }),
        db.legacyHistoricalFact.count({ where: { snapshotId: snapshot.id } }),
        db.legacyException.count({ where: { snapshotId: snapshot.id, status: "open" } }),
      ]);
      return { ...snapshot, records: tables.reduce((sum, table) => sum + table._count._all, 0), facts, openExceptions,
        tables: tables.map(table => ({ name: table.sourceTable, records: table._count._all })).sort((a, b) => a.name.localeCompare(b.name)) };
    })),
  }))) };
  res.json(summary);
});

appSheetMigrationRoutes.get("/snapshots/:snapshotId/history", async (req, res) => {
  const snapshotId = z.string().min(1).max(100).parse(req.params.snapshotId);
  const snapshot = await db.legacyImportSnapshot.findFirst({ where: { id: snapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM }, select: { id: true } });
  if (!snapshot) throw new OperationError(404, "APPSHEET_SNAPSHOT_NOT_FOUND", "No se encontró este lote de AppSheet.");
  await historyPage(req, res, [snapshot.id]);
});

appSheetMigrationRoutes.get("/snapshots/:snapshotId/pending", async (req, res) => {
  const snapshotId = z.string().min(1).max(100).parse(req.params.snapshotId);
  const snapshot = await db.legacyImportSnapshot.findFirst({ where: { id: snapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM }, select: { id: true } });
  if (!snapshot) throw new OperationError(404, "APPSHEET_SNAPSHOT_NOT_FOUND", "No se encontró este lote de AppSheet.");
  await pendingPage(req, res, [snapshot.id]);
});

appSheetMigrationRoutes.get("/:captureId/pending", async (req, res) => {
  const captureId = z.string().min(1).max(100).parse(req.params.captureId);
  const capture = await db.appSheetCaptureManifest.findFirst({ where: { captureId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM },
    select: { snapshots: { select: { id: true } } } });
  if (!capture) throw new OperationError(404, "APPSHEET_CAPTURE_NOT_FOUND", "No se encontró esta captura de AppSheet.");
  await pendingPage(req, res, capture.snapshots.map(snapshot => snapshot.id));
});

async function pendingPage(req: Request, res: Response, snapshotIds: string[]) {
  const cursor = z.string().min(1).max(100).optional().parse(req.query.cursor);
  const table = z.string().max(200).optional().parse(req.query.table);
  const dimension = z.enum(["preSale", "receivable", "unpaidPurchase", "delivery"]).optional().parse(req.query.dimension);
  const status = z.enum(["confirmed_pending", "not_pending", "needs_review", "not_applicable"]).optional().parse(req.query.status);
  if (status && !dimension) throw new OperationError(400, "PENDING_FILTER", "Elegí una dimensión para filtrar su estado.");
  const limit = z.coerce.number().int().min(1).max(100).parse(req.query.limit ?? 50);
  const where: Prisma.LegacySourceRecordWhereInput = {
    snapshotId: { in: snapshotIds }, ...(table ? { sourceTable: table } : {}),
    AND: [
      { normalized: { path: ["pendingReconciliation", "schemaVersion"], equals: APPSHEET_PENDING_SCHEMA_VERSION } },
      ...(dimension && status ? [{ normalized: { path: ["pendingReconciliation", "dimensions", dimension, "status"], equals: status } }] : []),
    ],
  };
  if (cursor && !await db.legacySourceRecord.findFirst({ where: { ...where, id: cursor }, select: { id: true } }))
    throw new OperationError(400, "PAGE_CURSOR", "Reiniciá la página con sus filtros actuales.");
  const records = await db.legacySourceRecord.findMany({ where, orderBy: { id: "asc" }, take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, sourceTable: true, sourceRow: true, contentHash: true, normalized: true } });
  const items = records.slice(0, limit).map(record => {
    const normalized = record.normalized;
    const candidate = normalized && typeof normalized === "object" && !Array.isArray(normalized) ? normalized.pendingReconciliation : undefined;
    const parsed = appSheetPendingReconciliationSchema.safeParse(candidate);
    return { sourceRecordId: record.id, sourceTable: record.sourceTable, sourceRow: record.sourceRow,
      sourceHash: record.contentHash, integrity: parsed.success ? "valid" : "invalid",
      reconciliation: parsed.success ? parsed.data : null };
  });
  res.json({ items, nextCursor: records.length > limit ? items.at(-1)!.sourceRecordId : null });
}

appSheetMigrationRoutes.get("/:captureId/history", async (req, res) => {
  const captureId = z.string().max(100).parse(req.params.captureId);
  const capture = await db.appSheetCaptureManifest.findFirst({ where: { captureId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM },
    select: { snapshots: { select: { id: true } } } });
  if (!capture) throw new OperationError(404, "APPSHEET_CAPTURE_NOT_FOUND", "No se encontró esta captura de AppSheet.");
  await historyPage(req, res, capture.snapshots.map(snapshot => snapshot.id));
});

async function historyPage(req: Request, res: Response, snapshotIds: string[]) {
  const cursor = z.string().min(1).max(100).optional().parse(req.query.cursor);
  const table = z.string().max(200).optional().parse(req.query.table);
  const kind = z.enum(["invoice", "sale-line", "purchase", "stock", "cash", "expense", "fx", "delivery", "archive"]).optional().parse(req.query.kind);
  const limit = z.coerce.number().int().min(1).max(100).parse(req.query.limit ?? 50);
  const where = { snapshotId: { in: snapshotIds }, ...(table ? { sourceTable: table } : {}), ...(kind ? { kind } : {}) };
  if (cursor && !await db.legacyHistoricalFact.findFirst({ where: { ...where, id: cursor }, select: { id: true } }))
    throw new OperationError(400, "PAGE_CURSOR", "Reiniciá la página con sus filtros actuales.");
  const records = await db.legacyHistoricalFact.findMany({ where, orderBy: { id: "asc" }, take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: { id: true, sourceRecordId: true, sourceTable: true, sourceKey: true, sourceRow: true, sourceHash: true,
      kind: true, occurredOn: true, dateState: true, currency: true, currencyState: true, amountMinor: true, amountState: true,
      quantity: true, quantityState: true, unit: true } });
  const items = records.slice(0, limit);
  const exceptions = await db.legacyException.groupBy({ by: ["sourceRecordId"], where: { snapshotId: where.snapshotId,
    sourceRecordId: { in: items.map(item => item.sourceRecordId) }, status: "open" }, _count: { _all: true } });
  const byRecord = new Map(exceptions.map(item => [item.sourceRecordId, item._count._all]));
  res.json({ items: items.map(item => ({ ...item, amountMinor: item.amountMinor?.toString() ?? null,
    quantity: item.quantity?.toString() ?? null, openExceptions: byRecord.get(item.sourceRecordId) ?? 0 })),
    nextCursor: records.length > limit ? items.at(-1)!.id : null });
}
