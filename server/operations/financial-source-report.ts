import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { financialSourceControlSchema, buildFinancialSourceReconciliationReport, type FinancialSourceControl, type FinancialSourceObservationRow } from "../../shared/operations/financial-source-report.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { db } from "../db.js";
import { OperationError } from "./core.js";

const SOURCE_SYSTEM = "appsheet-finance-observations";
const SOURCE_TABLE = "Movimiento_Nueva";
const PRIMARY_KEY_HEADER = "ID_Movimiento_Unique";
const IMPORTER_VERSION = "bombo-financial-source-stage/1.0.0";
const sourceHash = z.string().regex(/^[a-f0-9]{64}$/);

const querySchema = z.strictObject({ cutoffDate: z.iso.date().optional() });

const stageControlsSchema = z.strictObject({
  sourceSystem: z.literal(SOURCE_SYSTEM),
  sourceTable: z.literal(SOURCE_TABLE),
  primaryKeyHeader: z.literal(PRIMARY_KEY_HEADER),
  cutoffDate: z.iso.date(),
  importerVersion: z.literal(IMPORTER_VERSION),
  technicalReviewComplete: z.literal(true),
  reviewManifestHash: sourceHash,
  rowManifestHash: sourceHash,
  backupManifestHash: sourceHash,
  backupSnapshotAt: z.string().min(1),
});

interface StagedSnapshotRow {
  id: string;
  filename: string;
  fileHash: string;
  status: string;
  controls: unknown;
}

interface ProjectedRecordRow {
  date: string | null;
  dateCount: number;
  movementType: string | null;
  movementTypeCount: number;
  currency: string | null;
  currencyCount: number;
  amountMinor: string | null;
  amountCount: number;
  originalAmountCount: number;
  numericOriginalAmount: boolean;
  hasCashBox: boolean;
  cashBoxCount: number;
  duplicateIdentity: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function expectedControl(controlsValue: unknown): FinancialSourceControl | null {
  const controls = record(controlsValue);
  const reconciliation = record(controls?.financialSourceReconciliation);
  const parsed = financialSourceControlSchema.safeParse(reconciliation?.manifest);
  return parsed.success ? parsed.data : null;
}

function hasVerifiedStageScope(
  controlsValue: unknown,
  snapshotFileHash: string,
  control: FinancialSourceControl | null,
): boolean {
  if (control === null || control.fileHash !== snapshotFileHash) return false;
  const controls = record(controlsValue);
  const stage = stageControlsSchema.safeParse(controls?.financialSourceStage);
  if (!stage.success || stage.data.cutoffDate !== control.cutoffDate) return false;

  const wrapper = {
    schemaVersion: 1,
    technicalReviewComplete: true,
    source: {
      fileHash: control.fileHash,
      sourceSystem: stage.data.sourceSystem,
      sourceTable: stage.data.sourceTable,
      primaryKeyHeader: stage.data.primaryKeyHeader,
      importerVersion: stage.data.importerVersion,
    },
    financialSourceReconciliation: { manifest: control },
  };
  const digest = createHash("sha256").update(canonicalJson(wrapper), "utf8").digest("hex");
  return digest === stage.data.reviewManifestHash;
}

function observationRows(rows: readonly ProjectedRecordRow[]): FinancialSourceObservationRow[] {
  return rows.map(row => ({
    date: row.dateCount === 1 ? row.date : null,
    dateFieldAmbiguous: row.dateCount > 1,
    movementType: row.movementTypeCount === 1 ? row.movementType : null,
    currency: row.currencyCount === 1 ? row.currency : null,
    amountMinor: row.amountCount === 1 && row.originalAmountCount === 1 && row.numericOriginalAmount ? row.amountMinor : null,
    hasCashBox: row.cashBoxCount === 1 && row.hasCashBox,
    duplicateIdentity: row.duplicateIdentity,
  }));
}

async function projectMovimientoNueva(tx: Prisma.TransactionClient, snapshotId: string): Promise<ProjectedRecordRow[]> {
  return tx.$queryRaw<ProjectedRecordRow[]>(Prisma.sql`
    WITH scoped_records AS (
      SELECT
        source."id",
        source."sourceKey",
        source."sourceRow",
        source.normalized,
        source.original,
        (source."sourceKey" LIKE 'synthetic:%' OR COUNT(*) OVER (PARTITION BY source."sourceKey") > 1) AS "duplicateIdentity"
      FROM "LegacySourceRecord" source
      WHERE source."snapshotId" = ${snapshotId}
        AND source."sourceTable" = ${SOURCE_TABLE}
    )
    SELECT
      MAX(column_value->>'value') FILTER (WHERE column_value->>'header' = 'Fecha') AS date,
      COUNT(*) FILTER (WHERE column_value->>'header' = 'Fecha')::integer AS "dateCount",
      MAX(column_value->>'value') FILTER (WHERE column_value->>'header' = 'Tipo_Movimiento') AS "movementType",
      COUNT(*) FILTER (WHERE column_value->>'header' = 'Tipo_Movimiento')::integer AS "movementTypeCount",
      MAX(column_value->>'value') FILTER (WHERE column_value->>'header' = 'Tipo_Moneda') AS currency,
      COUNT(*) FILTER (WHERE column_value->>'header' = 'Tipo_Moneda')::integer AS "currencyCount",
      MAX(column_value->>'moneyMinorUnits') FILTER (WHERE column_value->>'header' = 'Monto') AS "amountMinor",
      COUNT(*) FILTER (WHERE column_value->>'header' = 'Monto')::integer AS "amountCount",
      source_amount."originalAmountCount" AS "originalAmountCount",
      source_amount."numericOriginalAmount" AS "numericOriginalAmount",
      COALESCE(BOOL_OR(NULLIF(BTRIM(column_value->>'value'), '') IS NOT NULL) FILTER (WHERE column_value->>'header' = 'Caja'), FALSE) AS "hasCashBox",
      COUNT(*) FILTER (WHERE column_value->>'header' = 'Caja')::integer AS "cashBoxCount",
      source."duplicateIdentity" AS "duplicateIdentity"
    FROM scoped_records source
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(source.normalized->'columns') = 'array'
        THEN source.normalized->'columns' ELSE '[]'::jsonb END
    ) AS normalized_column(column_value) ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) FILTER (WHERE original_value->>'header' = 'Monto')::integer AS "originalAmountCount",
        COALESCE(BOOL_OR(
          jsonb_typeof(original_value->'value') = 'object'
          AND original_value->'value'->>'kind' = 'source_xml_cell'
          AND original_value->'value'->'xml'->>'cellType' = 'n'
        ) FILTER (WHERE original_value->>'header' = 'Monto'), FALSE) AS "numericOriginalAmount"
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(source.original->'columns') = 'array'
          THEN source.original->'columns' ELSE '[]'::jsonb END
      ) AS original_column(original_value)
    ) AS source_amount ON TRUE
    GROUP BY source."id", source."sourceKey", source."sourceRow", source."duplicateIdentity",
      source_amount."originalAmountCount", source_amount."numericOriginalAmount"
    ORDER BY source."sourceRow" ASC
  `);
}

/** Parses one strict optional civil-date query. A future cutoff is never accepted. */
export function parseFinancialSourceReportParams(value: unknown, today: string): { cutoffDate?: string } {
  const parsed = querySchema.safeParse(value);
  if (!parsed.success) {
    throw new OperationError(400, "INVALID_REPORT_QUERY", "Indicá una fecha de corte civil válida");
  }
  const cutoffDate = parsed.data.cutoffDate;
  if (!z.iso.date().safeParse(today).success || (cutoffDate !== undefined && cutoffDate > today)) {
    throw new OperationError(400, "INVALID_REPORT_QUERY", "La fecha de corte no puede ser futura");
  }
  return cutoffDate === undefined ? {} : { cutoffDate };
}

/** Loads staged source observations from one read-only, repeatable database snapshot. */
export async function queryFinancialSourceReconciliationReport(requestedCutoffDate: string | undefined, today: string) {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const snapshots = await tx.legacyImportSnapshot.findMany({
      where: { sourceSystem: SOURCE_SYSTEM, status: "staged" },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: { id: true, filename: true, fileHash: true, status: true, controls: true },
    });
    const sources = await Promise.all(snapshots.map(async (snapshot: StagedSnapshotRow) => {
      const control = expectedControl(snapshot.controls);
      const rows = await projectMovimientoNueva(tx, snapshot.id);
      return {
        snapshotId: snapshot.id,
        filename: snapshot.filename,
        fileHash: snapshot.fileHash,
        status: "staged" as const,
        scopeVerified: hasVerifiedStageScope(snapshot.controls, snapshot.fileHash, control),
        expectedControl: control,
        rows: observationRows(rows),
      };
    }));
    const manifestCutoff = sources.find(source => source.scopeVerified
      && source.expectedControl !== null
      && source.expectedControl.cutoffDate <= today)?.expectedControl?.cutoffDate;
    const cutoffDate = requestedCutoffDate ?? manifestCutoff ?? today;
    return buildFinancialSourceReconciliationReport({ cutoffDate, sources });
  }, { isolationLevel: "RepeatableRead", timeout: 30000 });
}
