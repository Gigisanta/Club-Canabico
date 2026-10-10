import { z } from "zod";
import { OperationError } from "./core.js";
import { containsRecognizableCredential, isCredentialBearingHeader } from "./legacy-reader.js";
import { appSheetPendingReconciliationSchema } from "../../shared/operations/appsheet-pending.js";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const exceptionSchema = z.strictObject({
  kind: z.string().min(1).max(120),
  severity: z.enum(["review", "blocking"]),
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
const columnSchema = z.strictObject({
  coordinate: z.string().min(1).max(20),
  header: z.string().nullable(),
  value: z.unknown(),
  numberFormat: z.string().nullable().optional(),
  exactDecimal: z.string().optional(),
  moneyMinorUnits: z.string().optional(),
});
export const sourceRecordSchema = z.strictObject({
  sourceTable: z.string().min(1).max(120),
  sourceKey: z.string().min(1).max(65_536),
  sourceRow: z.number().int().positive().max(100_000),
  fileHash: hash,
  contentHash: hash,
  importerVersion: z.string().min(1).max(120),
  original: z.strictObject({ columns: z.array(columnSchema).max(512) }),
  normalized: z.strictObject({
    columns: z.array(columnSchema).max(512),
    overlapEvidence: z.object({
      targetTable: z.literal("Movimiento_Nueva"),
      targetSourceRow: z.number().int().nullable(),
      status: z.enum(["exact_legacy_fields", "different_legacy_fields", "missing_reference", "ambiguous_reference", "comparison_incomplete"]),
      comparedFields: z.number().int().min(0).max(7),
    }).optional(),
    pendingReconciliation: appSheetPendingReconciliationSchema.optional(),
  }),
  treatment: z.enum(["fact_candidate", "archive_only", "overlap_evidence"]),
  exceptions: z.array(exceptionSchema).max(10_000),
}).transform((record) => {
  if (containsRecognizableCredential(record)) throw new OperationError(422, "IMPORT_CREDENTIAL_VALUE_REJECTED", "El lote contiene material de autenticación que no se puede importar.");
  if ([...record.original.columns, ...record.normalized.columns].some((column) => isCredentialBearingHeader(column.header, record.sourceTable)))
    throw new OperationError(422, "IMPORT_CREDENTIAL_HEADER_REJECTED", "El lote contiene encabezados de credenciales que no se pueden importar.");
  return record;
});
