import { Router } from "express";
import { z } from "zod";
import { db, atomic } from "./db.js";
import { getSettings } from "./db.js";
import { businessDate } from "../shared/domain.js";
import { dataImportKinds, type DataImportFact, type DataImportInput } from "../shared/data-import.js";
import {
  inspectDataImportFile,
  previewDataImport,
  commitDataImport,
  DataImportError,
  DataImportRejectedError,
  DataImportConflictError,
} from "./data-import.js";
import { HttpError } from "./validation.js";

export const dataImportRoutes = Router();
const CENTS64_MIN = -(2n ** 63n);
const CENTS64_MAX = 2n ** 63n - 1n;
const monetaryKinds = new Set(["delivery_sales", "purchases", "cash_reconciliation", "cash_movements", "expenses"]);

function batchControlTotal(kind: string, facts: DataImportFact[]): bigint | null {
  if (!monetaryKinds.has(kind)) return null;
  return facts.reduce((sum, fact) => {
    if (kind === "delivery_sales" && fact.kind === "delivery_sale") return sum + BigInt(fact.totalCents);
    if (kind === "purchases" && fact.kind === "purchase_receipt") return sum + BigInt(fact.totalCents);
    if (kind === "cash_reconciliation" && fact.kind === "cash_reconciliation") return sum + BigInt(fact.countedCents);
    if (kind === "cash_movements" && fact.kind === "cash_movement") return sum + BigInt(fact.amountCents);
    if (kind === "expenses" && fact.kind === "expense") return sum + BigInt(fact.amountCents);
    return sum;
  }, 0n);
}
const file = z.object({
  filename: z.string().trim().min(1).max(255),
  contentBase64: z.string().min(1).max(7_000_000),
  sheetName: z.string().max(120).optional(),
}).strict();
const input = z.object({
  kind: z.enum(dataImportKinds),
  sourceSystem: z.string().trim().min(1).max(120),
  filename: file.shape.filename,
  contentBase64: file.shape.contentBase64,
  mapping: z.object({
    version: z.string().trim().min(1).max(120),
    columns: z.record(z.string(), z.string()),
    sheetName: z.string().max(120).optional(),
    decimalSeparator: z.enum([".", ","]).optional(),
  }).strict(),
  cutoff: z.iso.date(),
}).strict();

function manager(role: string) {
  if (role !== "owner" && role !== "admin") throw new HttpError(403, "No tenés acceso a la importación de datos");
}

async function audit(userId: string, action: string) {
  await db.sensitiveAccessAudit.create({ data: { userId, area: "data_import", action } });
}

function importFailure(res: import("express").Response, error: unknown) {
  if (error instanceof DataImportConflictError)
    return res.status(409).json({ error: error.message, conflicts: error.conflicts });
  if (error instanceof DataImportRejectedError)
    return res.status(422).json({ error: error.message, errors: error.errors, conflicts: error.conflicts });
  if (error instanceof DataImportError)
    return res.status(400).json({ error: error.message, code: error.code });
  throw error;
}

dataImportRoutes.post("/data-import/inspect", async (req, res) => {
  manager(req.user.role);
  const value = file.parse(req.body);
  try {
    const result = await inspectDataImportFile(value);
    await audit(req.user.id, "inspect");
    res.json(result);
  } catch (error) { importFailure(res, error); }
});

dataImportRoutes.post("/data-import/preview", async (req, res) => {
  manager(req.user.role);
  const value = input.parse(req.body) as DataImportInput;
  try {
    const result = await previewDataImport(value);
    await db.historicalImportBatch.updateMany({
      where: { id: result.batchId, createdByUserId: null },
      data: { createdByUserId: req.user.id },
    });
    await audit(req.user.id, "preview");
    res.json(result);
  } catch (error) { importFailure(res, error); }
});

dataImportRoutes.post("/data-import/commit", async (req, res) => {
  manager(req.user.role);
  const value = z.object({ batchId: z.uuid() }).strict().parse(req.body);
  try {
    const result = await commitDataImport(value, req.user.id);
    await audit(req.user.id, "commit");
    res.json(result);
  } catch (error) { importFailure(res, error); }
});

dataImportRoutes.get("/data-import/batches", async (req, res) => {
  manager(req.user.role);
  await audit(req.user.id, "list");
  const rows = await db.historicalImportBatch.findMany({
    take: 100,
    orderBy: { createdAt: "desc" },
    select: {
      id: true, kind: true, sourceSystem: true, cutoffDate: true, status: true, committedByUserId: true,
      rowCount: true, acceptedCount: true, insertedCount: true, skippedCount: true,
      createdAt: true, reconciliation: { select: { id: true, asOf: true, reference: true, notes: true,
        varianceCents: true, sourceRecordCount: true, sourceTotalCents: true, calculatedTotalCents: true,
        coverageFrom: true, coverageThrough: true, coverageComplete: true, confirmedAt: true } },
    },
  });
  res.json({ items: rows.map((row) => ({
    id: row.id, kind: row.kind, sourceSystem: row.sourceSystem, committedByUserId: row.committedByUserId,
    cutoff: row.cutoffDate.toISOString().slice(0, 10), status: row.status,
    rowCount: row.rowCount, acceptedCount: row.acceptedCount,
    insertedCount: row.insertedCount, skippedCount: row.skippedCount,
    createdAt: row.createdAt.toISOString(), reconciliation: row.reconciliation ? {
      id: row.reconciliation.id,
      asOf: row.reconciliation.asOf.toISOString().slice(0, 10),
      reference: row.reconciliation.reference, notes: row.reconciliation.notes,
      varianceCents: row.reconciliation.varianceCents?.toString() ?? null,
      sourceRecordCount: row.reconciliation.sourceRecordCount,
      sourceTotalCents: row.reconciliation.sourceTotalCents?.toString() ?? null,
      calculatedTotalCents: row.reconciliation.calculatedTotalCents?.toString() ?? null,
      coverageFrom: row.reconciliation.coverageFrom?.toISOString().slice(0, 10) ?? null,
      coverageThrough: row.reconciliation.coverageThrough?.toISOString().slice(0, 10) ?? null,
      coverageComplete: row.reconciliation.coverageComplete,
      confirmedAt: row.reconciliation.confirmedAt.toISOString(),
    } : null,
  })) });
});

dataImportRoutes.post("/data-import/:id/reconcile", async (req, res) => {
  manager(req.user.role);
  const value = z.object({
    asOf: z.iso.date(),
    reference: z.string().trim().min(2).max(180),
    notes: z.string().trim().min(10).max(1000),
    varianceCents: z.string().regex(/^-?(?:0|[1-9]\d*)$/).nullable(),
    sourceRecordCount: z.number().int().min(0).max(10_000),
    sourceTotalCents: z.string().regex(/^-?(?:0|[1-9]\d*)$/).nullable(),
    coverageFrom: z.iso.date().nullable().optional(),
    coverageThrough: z.iso.date().nullable().optional(),
    coverageComplete: z.boolean().optional(),
  }).strict().parse(req.body);
  const today = businessDate(await getSettings());
  if (value.asOf > today) throw new HttpError(400, "La conciliación no puede tener fecha futura");
  const variance = value.varianceCents === null ? null : BigInt(value.varianceCents);
  const sourceTotal = value.sourceTotalCents === null ? null : BigInt(value.sourceTotalCents);
  const coverageFrom = value.coverageFrom ?? null;
  const coverageThrough = value.coverageThrough ?? null;
  const coverageComplete = value.coverageComplete ?? false;
  if (variance !== null && (variance < -(2n ** 63n) || variance > 2n ** 63n - 1n))
    throw new HttpError(400, "Variación fuera del rango de 64 bits");
  if (sourceTotal !== null && (sourceTotal < CENTS64_MIN || sourceTotal > CENTS64_MAX))
    throw new HttpError(400, "Importe de control fuera del rango de 64 bits");
  if (variance !== 0n)
    throw new HttpError(400, "Para marcar un lote conciliado, la diferencia comprobada debe ser cero");
  if ((coverageFrom === null) !== (coverageThrough === null))
    throw new HttpError(400, "La cobertura necesita fecha inicial y final");
  if (coverageFrom && coverageThrough && (coverageFrom > coverageThrough || coverageThrough > value.asOf))
    throw new HttpError(400, "El rango de cobertura es inválido");
  if (coverageComplete && (!coverageFrom || !coverageThrough || variance !== 0n))
    throw new HttpError(400, "La cobertura completa requiere fechas y diferencia cero");
  const reconciliation = await atomic(async (tx) => {
    const batch = await tx.historicalImportBatch.findUnique({
      where: { id: String(req.params.id) }, include: { reconciliation: true },
    });
    if (!batch) throw new HttpError(404, "Lote de importación no encontrado");
    if (!batch.committedByUserId || batch.committedByUserId === req.user.id)
      throw new HttpError(400, "La conciliación requiere un revisor distinto de quien importó el lote");
    if (coverageComplete && batch.rejectedCount > 0)
      throw new HttpError(400, "La cobertura completa exige resolver todas las filas rechazadas del archivo");
    if (value.sourceRecordCount !== batch.acceptedCount)
      throw new HttpError(400, "La cantidad de control externa no coincide con los registros aceptados");
    const facts = batch.facts as DataImportFact[];
    if (!Array.isArray(facts) || facts.length !== batch.acceptedCount)
      throw new HttpError(409, "El lote no conserva el detalle íntegro de hechos para la comparación");
    const calculatedTotal = batchControlTotal(batch.kind, facts);
    if (calculatedTotal !== null && (calculatedTotal < CENTS64_MIN || calculatedTotal > CENTS64_MAX))
      throw new HttpError(400, "El total del lote excede el rango de 64 bits");
    if (calculatedTotal === null ? sourceTotal !== null : sourceTotal === null || calculatedTotal !== sourceTotal)
      throw new HttpError(400, "El total de control externo no coincide con el total importado");
    if (coverageThrough && coverageThrough > batch.cutoffDate.toISOString().slice(0, 10))
      throw new HttpError(400, "La cobertura no puede superar el corte del archivo");
    if (batch.reconciliation) {
      if (batch.reconciliation.reference !== value.reference || batch.reconciliation.asOf.toISOString().slice(0, 10) !== value.asOf ||
          batch.reconciliation.notes !== value.notes || batch.reconciliation.varianceCents !== variance ||
          batch.reconciliation.sourceRecordCount !== value.sourceRecordCount ||
          batch.reconciliation.sourceTotalCents !== sourceTotal ||
          batch.reconciliation.calculatedTotalCents !== calculatedTotal ||
          batch.reconciliation.coverageFrom?.toISOString().slice(0, 10) !== (coverageFrom ?? undefined) ||
          batch.reconciliation.coverageThrough?.toISOString().slice(0, 10) !== (coverageThrough ?? undefined) ||
          batch.reconciliation.coverageComplete !== coverageComplete)
        throw new HttpError(409, "El lote ya tiene una conciliación diferente");
      return batch.reconciliation;
    }
    if (batch.status !== "imported") throw new HttpError(409, "Importá el lote antes de conciliarlo");
    const result = await tx.historicalReconciliation.create({ data: {
      batchId: batch.id, asOf: new Date(`${value.asOf}T00:00:00.000Z`),
      reference: value.reference, notes: value.notes,
      varianceCents: variance, confirmedByUserId: req.user.id,
      sourceRecordCount: value.sourceRecordCount,
      sourceTotalCents: sourceTotal, calculatedTotalCents: calculatedTotal,
      coverageFrom: coverageFrom ? new Date(`${coverageFrom}T00:00:00.000Z`) : null,
      coverageThrough: coverageThrough ? new Date(`${coverageThrough}T00:00:00.000Z`) : null,
      coverageComplete,
    } });
    await tx.historicalImportBatch.update({ where: { id: batch.id }, data: { status: "reconciled" } });
    return result;
  });
  await audit(req.user.id, "reconcile");
  res.status(201).json({
    id: reconciliation.id, batchId: reconciliation.batchId,
    asOf: reconciliation.asOf.toISOString().slice(0, 10), reference: reconciliation.reference,
    notes: reconciliation.notes, varianceCents: reconciliation.varianceCents?.toString() ?? null,
    sourceRecordCount: reconciliation.sourceRecordCount,
    sourceTotalCents: reconciliation.sourceTotalCents?.toString() ?? null,
    calculatedTotalCents: reconciliation.calculatedTotalCents?.toString() ?? null,
    coverageFrom: reconciliation.coverageFrom?.toISOString().slice(0, 10) ?? null,
    coverageThrough: reconciliation.coverageThrough?.toISOString().slice(0, 10) ?? null,
    coverageComplete: reconciliation.coverageComplete,
    confirmedAt: reconciliation.confirmedAt.toISOString(), status: "reconciled",
  });
});
