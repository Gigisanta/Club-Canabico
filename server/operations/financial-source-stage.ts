import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildFinancialSourceReconciliationReport,
  financialSourceControlSchema,
  type FinancialSourceControl,
  type FinancialSourceExclusionCounts,
  type FinancialSourceExclusionReason,
  type FinancialSourceObservationRow,
} from "../../shared/operations/financial-source-report.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import {
  readLegacyWorkbook,
  type LegacyReaderException,
  type LegacySourceSnapshotRecord,
  type LegacyWorkbookSnapshot,
} from "./legacy-reader.js";

export const FINANCIAL_SOURCE_SYSTEM = "appsheet-finance-observations";
export const FINANCIAL_SOURCE_TABLE = "Movimiento_Nueva";
export const FINANCIAL_SOURCE_PRIMARY_KEY = "ID_Movimiento_Unique";
export const FINANCIAL_SOURCE_IMPORTER_VERSION = "bombo-financial-source-stage/1.0.0";
export const FINANCIAL_SOURCE_CUTOFF = "2026-10-08";
export const FINANCIAL_SOURCE_STAGE_ACTOR = "codex:financial-source-stage";

const MAX_STAGED_JSON_BYTES = 128 * 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const isoDateSchema = z.iso.date();
const isoDateTimeSchema = z.iso.datetime({ offset: true });

const reviewManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  technicalReviewComplete: z.literal(true),
  source: z.strictObject({
    fileHash: z.string().regex(hashPattern),
    sourceSystem: z.literal(FINANCIAL_SOURCE_SYSTEM),
    sourceTable: z.literal(FINANCIAL_SOURCE_TABLE),
    primaryKeyHeader: z.literal(FINANCIAL_SOURCE_PRIMARY_KEY),
    importerVersion: z.literal(FINANCIAL_SOURCE_IMPORTER_VERSION),
  }),
  financialSourceReconciliation: z.strictObject({ manifest: financialSourceControlSchema }),
});

export type FinancialSourceReviewManifest = z.infer<typeof reviewManifestSchema>;

interface PersistedException {
  id: string;
  sourceRecordId: string;
  kind: string;
  severity: string;
  description: string;
}

export interface PreparedFinancialSourceStage {
  snapshot: LegacyWorkbookSnapshot;
  filename: string;
  snapshotId: string;
  reconciliationManifest: FinancialSourceControl;
  rowManifestHash: string;
  observationRows: FinancialSourceObservationRow[];
  exceptions: PersistedException[];
  metrics: {
    rawCount: number;
    eligibleCount: number;
    excludedCount: number;
    keyedRecordCount: number;
    duplicateKeyCount: number;
    exceptionCount: number;
    readerExceptionCount: number;
    periodCount: number;
    exceptionCounts: FinancialSourceExclusionCounts;
  };
}

export interface StageFinancialSourceOptions {
  filename: string;
  reviewManifest: unknown;
  backupReference: string;
}

export interface StageFinancialSourceResult {
  snapshotId: string;
  fileHash: string;
  status: "staged" | "already-staged" | "already-reviewed";
  alreadyStaged: boolean;
  recordCount: number;
  exceptionCount: number;
  eligibleCount: number;
  excludedCount: number;
  rowManifestHash: string;
  reviewManifestHash: string;
  backupManifestHash: string;
}

export class FinancialSourceStageError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FinancialSourceStageError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function stableRowId(snapshotId: string, record: LegacySourceSnapshotRecord): string {
  return digest({ snapshotId, sourceTable: record.sourceTable, sourceRow: record.sourceRow });
}

function normalizedColumnValues(record: LegacySourceSnapshotRecord, header: string) {
  return record.normalized.columns.filter((column) => column.header?.trim() === header);
}

function numericAmountCell(record: LegacySourceSnapshotRecord): boolean {
  const columns = record.original.columns.filter((column) => column.header?.trim() === "Monto");
  if (columns.length !== 1) return false;
  const original = columns[0]!.value;
  if (!original || typeof original !== "object" || Array.isArray(original) || original.kind !== "source_xml_cell") return false;
  const xml = (original as { xml?: { cellType?: unknown } }).xml;
  return xml?.cellType === "n";
}

function enforceNumericAmountType(record: LegacySourceSnapshotRecord): void {
  if (numericAmountCell(record)) return;
  for (const column of record.normalized.columns) {
    if (column.header?.trim() === "Monto") delete column.moneyMinorUnits;
  }
  const { contentHash: _previous, ...content } = record;
  record.contentHash = digest(content);
}

function makeObservation(record: LegacySourceSnapshotRecord, duplicateIdentity: boolean): FinancialSourceObservationRow {
  const date = normalizedColumnValues(record, "Fecha");
  const movementType = normalizedColumnValues(record, "Tipo_Movimiento");
  const currency = normalizedColumnValues(record, "Tipo_Moneda");
  const amount = normalizedColumnValues(record, "Monto");
  const cashBox = normalizedColumnValues(record, "Caja");
  return {
    date: date.length === 1 ? date[0]!.value : null,
    dateFieldAmbiguous: date.length > 1,
    movementType: movementType.length === 1 ? movementType[0]!.value : null,
    currency: currency.length === 1 ? currency[0]!.value : null,
    amountMinor: numericAmountCell(record) && amount.length === 1 ? amount[0]!.moneyMinorUnits ?? null : null,
    hasCashBox: cashBox.length === 1 && cashBox[0]!.value !== null && cashBox[0]!.value.trim() !== "",
    duplicateIdentity,
  };
}

const exclusionDescription: Record<FinancialSourceExclusionReason, string> = {
  missingDate: "La fila no tiene una fecha de movimiento.",
  invalidDate: "La fecha de movimiento está ausente, ambigua o no es válida.",
  futureDate: "La fecha de movimiento queda después del corte técnico.",
  nonNumericAmount: "El monto no tiene unidades menores exactas o queda fuera del rango admitido.",
  negativeAmount: "El monto de origen es negativo; requiere revisión de fuente.",
  invalidMovementType: "El tipo de movimiento no es Ingreso ni Egreso.",
  invalidCurrency: "La moneda no está identificada como ARS o USD.",
  blankCashBox: "La fila no identifica una caja.",
  duplicateIdentity: "La clave de origen está duplicada.",
};

function exclusionsForObservation(row: FinancialSourceObservationRow): FinancialSourceExclusionReason[] {
  const reasons: FinancialSourceExclusionReason[] = [];
  const rawDate = row.date;
  let date: string | null = null;
  if (!row.dateFieldAmbiguous && rawDate !== null && rawDate.trim() !== "") {
    const candidate = rawDate.trim();
    if (isoDateSchema.safeParse(candidate).success) date = candidate;
    else if (isoDateTimeSchema.safeParse(candidate).success) date = candidate.slice(0, 10);
  }
  if (row.dateFieldAmbiguous) reasons.push("invalidDate");
  else if (rawDate === null || rawDate.trim() === "") reasons.push("missingDate");
  else if (date === null) reasons.push("invalidDate");
  else if (date > FINANCIAL_SOURCE_CUTOFF) reasons.push("futureDate");

  let amount: bigint | null = null;
  if (row.amountMinor !== null && /^-?(0|[1-9]\d*)$/.test(row.amountMinor)) {
    try {
      const parsed = BigInt(row.amountMinor);
      if (parsed >= -9_223_372_036_854_775_808n && parsed <= 9_223_372_036_854_775_807n) amount = parsed;
    } catch { /* The value remains an invalid amount. */ }
  }
  if (amount === null) reasons.push("nonNumericAmount");
  else if (amount < 0n) reasons.push("negativeAmount");

  if (row.movementType !== "Ingreso" && row.movementType !== "Egreso") reasons.push("invalidMovementType");
  if (row.currency !== "ARS" && row.currency !== "USD") reasons.push("invalidCurrency");
  if (!row.hasCashBox) reasons.push("blankCashBox");
  if (row.duplicateIdentity) reasons.push("duplicateIdentity");
  return reasons;
}

function readerExceptionDescription(exception: LegacyReaderException): string {
  return `La lectura de origen registró la excepción técnica ${exception.kind}.`;
}

function persistedExceptions(
  snapshotId: string,
  records: readonly LegacySourceSnapshotRecord[],
  observations: readonly FinancialSourceObservationRow[],
): PersistedException[] {
  const result: PersistedException[] = [];
  const append = (sourceRecordId: string, kind: string, severity: string, description: string) => {
    const id = digest({ snapshotId, sourceRecordId, kind, severity, description, ordinal: result.length });
    result.push({ id, sourceRecordId, kind, severity, description });
  };

  records.forEach((record, index) => {
    const sourceRecordId = stableRowId(snapshotId, record);
    for (const exception of record.exceptions) append(sourceRecordId, exception.kind, exception.severity, readerExceptionDescription(exception));
    for (const reason of exclusionsForObservation(observations[index]!))
      append(sourceRecordId, reason, reason === "duplicateIdentity" ? "blocking" : "review", exclusionDescription[reason]);
  });
  return result;
}

function rowManifestHash(snapshotId: string, records: readonly LegacySourceSnapshotRecord[], exceptions: readonly PersistedException[]): string {
  const rows = records.map((record) => ({
    id: stableRowId(snapshotId, record),
    sourceTable: record.sourceTable,
    sourceKey: record.sourceKey,
    sourceRow: record.sourceRow,
    fileHash: record.fileHash,
    contentHash: record.contentHash,
    importerVersion: record.importerVersion,
    treatment: record.treatment,
  }));
  const sortedExceptions = [...exceptions].sort((a, b) =>
    a.sourceRecordId.localeCompare(b.sourceRecordId) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return digest({ rows, exceptions: sortedExceptions });
}

function reviewWrapper(control: FinancialSourceControl): FinancialSourceReviewManifest {
  return {
    schemaVersion: 1,
    technicalReviewComplete: true,
    source: {
      fileHash: control.fileHash,
      sourceSystem: FINANCIAL_SOURCE_SYSTEM,
      sourceTable: FINANCIAL_SOURCE_TABLE,
      primaryKeyHeader: FINANCIAL_SOURCE_PRIMARY_KEY,
      importerVersion: FINANCIAL_SOURCE_IMPORTER_VERSION,
    },
    financialSourceReconciliation: { manifest: control },
  };
}

export async function prepareFinancialSourceStage(
  bytes: Buffer | Uint8Array,
  inputFilename = "financial-source.xlsx",
): Promise<PreparedFinancialSourceStage> {
  const filename = basename(inputFilename);
  if (!filename || filename.length > 180) throw new FinancialSourceStageError("invalid_filename");

  const snapshot = await readLegacyWorkbook(bytes, {
    sourceSystem: FINANCIAL_SOURCE_SYSTEM,
    importerVersion: FINANCIAL_SOURCE_IMPORTER_VERSION,
    allowedSheets: [FINANCIAL_SOURCE_TABLE],
    primaryKeyHeaders: { [FINANCIAL_SOURCE_TABLE]: FINANCIAL_SOURCE_PRIMARY_KEY },
  });
  if (snapshot.sheets.length !== 1 || snapshot.sheets[0]?.name !== FINANCIAL_SOURCE_TABLE ||
      snapshot.records.some((record) => record.sourceTable !== FINANCIAL_SOURCE_TABLE))
    throw new FinancialSourceStageError("source_scope_mismatch");

  for (const record of snapshot.records) enforceNumericAmountType(record);

  const identityCounts = new Map<string, number>();
  for (const record of snapshot.records) {
    if (!record.sourceKey.startsWith("synthetic:")) identityCounts.set(record.sourceKey, (identityCounts.get(record.sourceKey) ?? 0) + 1);
  }
  const duplicateKeys = new Set([...identityCounts].filter(([, count]) => count > 1).map(([key]) => key));
  const observationRows = snapshot.records.map((record) => makeObservation(
    record,
    record.sourceKey.startsWith("synthetic:") || duplicateKeys.has(record.sourceKey),
  ));
  const reconciliation = buildFinancialSourceReconciliationReport({
    cutoffDate: FINANCIAL_SOURCE_CUTOFF,
    sources: [{
      snapshotId: digest({ sourceSystem: FINANCIAL_SOURCE_SYSTEM, fileHash: snapshot.fileHash, importerVersion: FINANCIAL_SOURCE_IMPORTER_VERSION }),
      filename,
      fileHash: snapshot.fileHash,
      status: "staged",
      scopeVerified: true,
      expectedControl: null,
      rows: observationRows,
    }],
  });
  const control = reconciliation.sources[0]?.observedControl;
  if (!control) throw new FinancialSourceStageError("reconciliation_failed");
  const reconciliationManifest = financialSourceControlSchema.parse(control);
  const snapshotId = `financial-${digest({ sourceSystem: FINANCIAL_SOURCE_SYSTEM, fileHash: snapshot.fileHash, importerVersion: FINANCIAL_SOURCE_IMPORTER_VERSION })}`;
  const exceptions = persistedExceptions(snapshotId, snapshot.records, observationRows);
  const rowHash = rowManifestHash(snapshotId, snapshot.records, exceptions);
  const metrics = {
    rawCount: reconciliationManifest.rawCount,
    eligibleCount: reconciliationManifest.eligibleCount,
    excludedCount: reconciliationManifest.excludedCount,
    keyedRecordCount: snapshot.summary.keyedRecordCount,
    duplicateKeyCount: duplicateKeys.size,
    exceptionCount: exceptions.length,
    readerExceptionCount: snapshot.summary.exceptionCount,
    periodCount: reconciliationManifest.periods.length,
    exceptionCounts: reconciliation.sources[0]!.exclusionCounts,
  };
  if (metrics.rawCount !== snapshot.records.length || metrics.eligibleCount + metrics.excludedCount !== metrics.rawCount)
    throw new FinancialSourceStageError("source_partition_mismatch");
  return {
    snapshot,
    filename,
    snapshotId,
    reconciliationManifest,
    rowManifestHash: rowHash,
    observationRows,
    exceptions,
    metrics,
  };
}

function validateReviewManifest(prepared: PreparedFinancialSourceStage, value: unknown) {
  const parsed = reviewManifestSchema.safeParse(value);
  if (!parsed.success) throw new FinancialSourceStageError("review_manifest_invalid");
  const expected = reviewWrapper(prepared.reconciliationManifest);
  if (canonicalJson(parsed.data) !== canonicalJson(expected))
    throw new FinancialSourceStageError("review_manifest_mismatch");
  return { reviewManifest: parsed.data, reviewManifestHash: digest(parsed.data) };
}

interface VerifiedBackup {
  manifestHash: string;
  snapshotAt: string;
}

function runBackupVerifier(scriptPath: string, backupPath: string): Promise<{ mode: string; integrity: boolean; migrationsValid: boolean; scope: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath, "verify", backupPath], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let outputBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) child.kill("SIGTERM");
      else stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) child.kill("SIGTERM");
    });
    child.on("error", () => rejectPromise(new FinancialSourceStageError("backup_verifier_unavailable")));
    child.on("exit", (code) => {
      if (code !== 0 || outputBytes > 64 * 1024) return rejectPromise(new FinancialSourceStageError("backup_verification_failed"));
      try {
        const result = JSON.parse(stdout.trim()) as { mode: string; integrity: boolean; migrationsValid: boolean; scope: string };
        resolvePromise(result);
      } catch {
        rejectPromise(new FinancialSourceStageError("backup_verifier_output_invalid"));
      }
    });
  });
}

interface BackupManifestRead {
  bytes: Buffer;
  sha256: string;
}

async function readBackupManifest(backupPath: string): Promise<BackupManifestRead> {
  try {
    const manifestPath = resolve(backupPath, "manifest.json");
    const hashPath = resolve(backupPath, "manifest.sha256");
    const info = await stat(manifestPath);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new FinancialSourceStageError("backup_manifest_unavailable");
    const [bytes, sha256] = await Promise.all([readFile(manifestPath), readFile(hashPath, "utf8")]);
    return { bytes, sha256: sha256.trim() };
  } catch (error) {
    if (error instanceof FinancialSourceStageError) throw error;
    throw new FinancialSourceStageError("backup_manifest_unavailable");
  }
}

async function verifyBackupReference(value: string): Promise<VerifiedBackup> {
  const backupPath = resolve(value);
  if (!value.trim()) throw new FinancialSourceStageError("backup_reference_required");
  await import("dotenv/config");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new FinancialSourceStageError("database_url_missing");
  const beforeVerification = await readBackupManifest(backupPath);
  const beforeDigest = createHash("sha256").update(beforeVerification.bytes).digest("hex");
  if (!hashPattern.test(beforeVerification.sha256) || beforeDigest !== beforeVerification.sha256)
    throw new FinancialSourceStageError("backup_manifest_invalid");
  const scriptPath = fileURLToPath(new URL("../../scripts/operations-backup.mjs", import.meta.url));
  const verification = await runBackupVerifier(scriptPath, backupPath);
  if (verification.mode !== "verify" || verification.integrity !== true || verification.migrationsValid !== true ||
      verification.scope !== "confirmed-server-state-only")
    throw new FinancialSourceStageError("backup_verification_failed");

  const afterVerification = await readBackupManifest(backupPath);
  if (!beforeVerification.bytes.equals(afterVerification.bytes) || beforeVerification.sha256 !== afterVerification.sha256)
    throw new FinancialSourceStageError("backup_manifest_changed_during_verification");
  const manifestBytes = afterVerification.bytes;
  const manifestHashFile = afterVerification.sha256;
  const actualHash = createHash("sha256").update(manifestBytes).digest("hex");
  let manifest: { databaseMajor?: unknown; encrypted?: unknown; snapshotAt?: unknown; scope?: unknown };
  try { manifest = JSON.parse(manifestBytes.toString("utf8")) as typeof manifest; }
  catch { throw new FinancialSourceStageError("backup_manifest_invalid"); }
  if (!hashPattern.test(manifestHashFile) || actualHash !== manifestHashFile || manifest.databaseMajor !== 18 ||
      manifest.encrypted !== true || manifest.scope !== "confirmed-server-state-only" ||
      typeof manifest.snapshotAt !== "string" || Number.isNaN(Date.parse(manifest.snapshotAt)))
    throw new FinancialSourceStageError("backup_manifest_invalid");
  return { manifestHash: manifestHashFile, snapshotAt: manifest.snapshotAt };
}

function persistedRecord(snapshotId: string, record: LegacySourceSnapshotRecord): Prisma.LegacySourceRecordCreateManyInput {
  return {
    id: stableRowId(snapshotId, record),
    snapshotId,
    sourceTable: record.sourceTable,
    sourceKey: record.sourceKey,
    sourceRow: record.sourceRow,
    fileHash: record.fileHash,
    contentHash: record.contentHash,
    importerVersion: record.importerVersion,
    original: record.original as unknown as Prisma.InputJsonValue,
    normalized: record.normalized as unknown as Prisma.InputJsonValue,
    treatment: record.treatment,
  };
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sameSourceControl(snapshotControls: unknown, prepared: PreparedFinancialSourceStage, reviewManifestHash: string): boolean {
  if (!snapshotControls || typeof snapshotControls !== "object" || Array.isArray(snapshotControls)) return false;
  const controls = snapshotControls as Record<string, unknown>;
  const stage = controls.financialSourceStage;
  const reconciliation = controls.financialSourceReconciliation;
  if (!stage || typeof stage !== "object" || Array.isArray(stage) || !reconciliation || typeof reconciliation !== "object" || Array.isArray(reconciliation)) return false;
  const stageControls = stage as Record<string, unknown>;
  const reconControls = reconciliation as Record<string, unknown>;
  return stageControls.sourceSystem === FINANCIAL_SOURCE_SYSTEM &&
    stageControls.sourceTable === FINANCIAL_SOURCE_TABLE &&
    stageControls.primaryKeyHeader === FINANCIAL_SOURCE_PRIMARY_KEY &&
    stageControls.cutoffDate === FINANCIAL_SOURCE_CUTOFF &&
    stageControls.importerVersion === FINANCIAL_SOURCE_IMPORTER_VERSION &&
    stageControls.technicalReviewComplete === true &&
    stageControls.reviewManifestHash === reviewManifestHash &&
    stageControls.rowManifestHash === prepared.rowManifestHash &&
    canonicalJson(reconControls.manifest) === canonicalJson(prepared.reconciliationManifest);
}

function expectedCoverage(prepared: PreparedFinancialSourceStage) {
  return prepared.snapshot.sheets.map((sheet) => ({
    ...sheet,
    scopeState: "selected-sheet-only",
    workbookCoverageComplete: false,
    rowManifestHash: prepared.rowManifestHash,
  }));
}

async function verifyExistingSnapshot(
  tx: Prisma.TransactionClient,
  snapshot: {
    id: string;
    sourceSystem: string;
    filename: string;
    fileHash: string;
    importerVersion: string;
    status: string;
    createdBy: string;
    controls: Prisma.JsonValue;
    coverage: Prisma.JsonValue;
  },
  prepared: PreparedFinancialSourceStage,
  reviewManifestHash: string,
): Promise<StageFinancialSourceResult> {
  if (snapshot.id !== prepared.snapshotId || snapshot.sourceSystem !== FINANCIAL_SOURCE_SYSTEM ||
      snapshot.filename !== prepared.filename || snapshot.fileHash !== prepared.snapshot.fileHash ||
      snapshot.importerVersion !== FINANCIAL_SOURCE_IMPORTER_VERSION || snapshot.createdBy !== FINANCIAL_SOURCE_STAGE_ACTOR ||
      !["staged", "reviewed"].includes(snapshot.status) ||
      !sameSourceControl(snapshot.controls, prepared, reviewManifestHash) ||
      canonicalJson(snapshot.coverage) !== canonicalJson(expectedCoverage(prepared)))
    throw new FinancialSourceStageError("existing_snapshot_mismatch");

  const [storedRecords, storedExceptions, operationObject] = await Promise.all([
    tx.legacySourceRecord.findMany({
      where: { snapshotId: snapshot.id },
      orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }],
      select: { id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true, fileHash: true, contentHash: true,
        importerVersion: true, original: true, normalized: true, treatment: true },
    }),
    tx.legacyException.findMany({
      where: { snapshotId: snapshot.id },
      orderBy: [{ sourceRecordId: "asc" }, { kind: "asc" }, { id: "asc" }],
      select: { id: true, sourceRecordId: true, kind: true, severity: true, description: true },
    }),
    tx.operationObject.findUnique({ where: { id: snapshot.id }, select: { id: true, kind: true, version: true, createdBy: true } }),
  ]);
  if (storedRecords.length !== prepared.metrics.rawCount || storedExceptions.length !== prepared.metrics.exceptionCount ||
      !operationObject || operationObject.kind !== "legacyImport" || operationObject.createdBy !== FINANCIAL_SOURCE_STAGE_ACTOR || operationObject.version < 0)
    throw new FinancialSourceStageError("existing_snapshot_incomplete");

  // `contentHash` covers reader exceptions too, while LegacySourceRecord stores
  // those in LegacyException rows. Recomputing it from the record projection
  // drops part of its original input and rejects every faithful replay. Compare
  // the complete persisted projection to the newly prepared source instead.
  const expectedRecords = prepared.snapshot.records.map((record) => persistedRecord(snapshot.id, record));
  const expectedRecordsById = new Map(expectedRecords.map((record) => [record.id, record]));
  if (expectedRecordsById.size !== expectedRecords.length || storedRecords.some((record) => {
    const expected = expectedRecordsById.get(record.id);
    return !expected || canonicalJson(record) !== canonicalJson(expected);
  })) throw new FinancialSourceStageError("existing_snapshot_record_mismatch");

  const expectedExceptions = [...prepared.exceptions].sort((a, b) =>
    a.sourceRecordId.localeCompare(b.sourceRecordId) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const actualExceptions = [...storedExceptions].sort((a, b) =>
    (a.sourceRecordId ?? "").localeCompare(b.sourceRecordId ?? "") || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  if (actualExceptions.some((exception) => exception.sourceRecordId === null) ||
      canonicalJson(actualExceptions) !== canonicalJson(expectedExceptions) ||
      rowManifestHash(snapshot.id, prepared.snapshot.records, prepared.exceptions) !== prepared.rowManifestHash)
    throw new FinancialSourceStageError("existing_snapshot_exception_mismatch");

  const snapshotControl = snapshot.controls as { financialSourceStage?: { backupManifestHash?: unknown } };
  const originalBackupHash = snapshotControl.financialSourceStage?.backupManifestHash;
  if (typeof originalBackupHash !== "string" || !hashPattern.test(originalBackupHash))
    throw new FinancialSourceStageError("existing_snapshot_backup_evidence_missing");

  return {
    snapshotId: snapshot.id,
    fileHash: snapshot.fileHash,
    status: snapshot.status === "reviewed" ? "already-reviewed" : "already-staged",
    alreadyStaged: true,
    recordCount: storedRecords.length,
    exceptionCount: storedExceptions.length,
    eligibleCount: prepared.metrics.eligibleCount,
    excludedCount: prepared.metrics.excludedCount,
    rowManifestHash: prepared.rowManifestHash,
    reviewManifestHash,
    backupManifestHash: originalBackupHash,
  };
}

async function persistPreparedStage(
  tx: Prisma.TransactionClient,
  prepared: PreparedFinancialSourceStage,
  reviewManifestHash: string,
  backup: VerifiedBackup,
): Promise<StageFinancialSourceResult> {
  const existing = await tx.legacyImportSnapshot.findUnique({
    where: { sourceSystem_fileHash_importerVersion: {
      sourceSystem: FINANCIAL_SOURCE_SYSTEM,
      fileHash: prepared.snapshot.fileHash,
      importerVersion: FINANCIAL_SOURCE_IMPORTER_VERSION,
    } },
    select: { id: true, sourceSystem: true, filename: true, fileHash: true, importerVersion: true,
      status: true, createdBy: true, controls: true, coverage: true },
  });
  if (existing) return verifyExistingSnapshot(tx, existing, prepared, reviewManifestHash);

  const operationObject = await tx.operationObject.findUnique({ where: { id: prepared.snapshotId }, select: { id: true } });
  if (operationObject) throw new FinancialSourceStageError("operation_object_conflict");
  const records = prepared.snapshot.records.map((record) => persistedRecord(prepared.snapshotId, record));
  const serializedBytes = Buffer.byteLength(JSON.stringify(records), "utf8");
  if (serializedBytes > MAX_STAGED_JSON_BYTES) throw new FinancialSourceStageError("source_payload_too_large");

  const controls = {
    financialSourceStage: {
      sourceSystem: FINANCIAL_SOURCE_SYSTEM,
      sourceTable: FINANCIAL_SOURCE_TABLE,
      primaryKeyHeader: FINANCIAL_SOURCE_PRIMARY_KEY,
      cutoffDate: FINANCIAL_SOURCE_CUTOFF,
      importerVersion: FINANCIAL_SOURCE_IMPORTER_VERSION,
      technicalReviewComplete: true,
      reviewManifestHash,
      rowManifestHash: prepared.rowManifestHash,
      backupManifestHash: backup.manifestHash,
      backupSnapshotAt: backup.snapshotAt,
    },
    financialSourceReconciliation: { manifest: prepared.reconciliationManifest },
  };
  const coverage = expectedCoverage(prepared);

  await tx.legacyImportSnapshot.create({ data: {
    id: prepared.snapshotId,
    sourceSystem: FINANCIAL_SOURCE_SYSTEM,
    filename: prepared.filename,
    fileHash: prepared.snapshot.fileHash,
    importerVersion: FINANCIAL_SOURCE_IMPORTER_VERSION,
    status: "staged",
    createdBy: FINANCIAL_SOURCE_STAGE_ACTOR,
    reviewedBy: null,
    reviewedAt: null,
    controls: asInputJson(controls),
    coverage: asInputJson(coverage),
  } });
  for (let start = 0; start < records.length; start += 500)
    await tx.legacySourceRecord.createMany({ data: records.slice(start, start + 500) });
  for (let start = 0; start < prepared.exceptions.length; start += 500)
    await tx.legacyException.createMany({
      data: prepared.exceptions.slice(start, start + 500).map((exception) => ({
        ...exception,
        snapshotId: prepared.snapshotId,
        sourceRecordId: exception.sourceRecordId,
      })),
    });
  await tx.operationObject.create({ data: {
    id: prepared.snapshotId,
    kind: "legacyImport",
    version: 0,
    createdBy: FINANCIAL_SOURCE_STAGE_ACTOR,
  } });
  await tx.operationAudit.create({ data: {
    actorId: FINANCIAL_SOURCE_STAGE_ACTOR,
    action: "legacy.financial_source_staged",
    objectId: prepared.snapshotId,
    details: asInputJson({
      sourceSystem: FINANCIAL_SOURCE_SYSTEM,
      sourceTable: FINANCIAL_SOURCE_TABLE,
      fileHash: prepared.snapshot.fileHash,
      importerVersion: FINANCIAL_SOURCE_IMPORTER_VERSION,
      rowManifestHash: prepared.rowManifestHash,
      reviewManifestHash,
      backupManifestHash: backup.manifestHash,
      rawCount: prepared.metrics.rawCount,
      eligibleCount: prepared.metrics.eligibleCount,
      excludedCount: prepared.metrics.excludedCount,
      exceptionCount: prepared.metrics.exceptionCount,
      status: "staged",
      reviewedBy: null,
    }),
  } });

  return {
    snapshotId: prepared.snapshotId,
    fileHash: prepared.snapshot.fileHash,
    status: "staged",
    alreadyStaged: false,
    recordCount: records.length,
    exceptionCount: prepared.exceptions.length,
    eligibleCount: prepared.metrics.eligibleCount,
    excludedCount: prepared.metrics.excludedCount,
    rowManifestHash: prepared.rowManifestHash,
    reviewManifestHash,
    backupManifestHash: backup.manifestHash,
  };
}

export async function stageFinancialSource(
  prepared: PreparedFinancialSourceStage,
  options: StageFinancialSourceOptions,
): Promise<StageFinancialSourceResult> {
  const filename = basename(options.filename);
  if (filename !== prepared.filename) throw new FinancialSourceStageError("filename_mismatch");
  if (prepared.metrics.rawCount === 0 || prepared.metrics.keyedRecordCount !== prepared.metrics.rawCount ||
      prepared.snapshot.records.some((record) => record.sourceKey.startsWith("synthetic:")))
    throw new FinancialSourceStageError("source_identity_incomplete");
  const { reviewManifestHash } = validateReviewManifest(prepared, options.reviewManifest);
  const backup = await verifyBackupReference(options.backupReference);
  const { db } = await import("../db.js");
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.$transaction(
          (tx) => persistPreparedStage(tx, prepared, reviewManifestHash, backup),
          { isolationLevel: "Serializable", timeout: 120_000, maxWait: 15_000 },
        );
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
        if ((code === "P2002" || code === "P2034") && attempt < 3) continue;
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof FinancialSourceStageError) throw error;
    throw new FinancialSourceStageError("stage_transaction_failed");
  } finally {
    await db.$disconnect();
  }
}

export async function readReviewManifest(path: string): Promise<unknown> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 256 * 1024) throw new FinancialSourceStageError("review_manifest_unavailable");
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof FinancialSourceStageError) throw error;
    throw new FinancialSourceStageError("review_manifest_unavailable");
  }
}

export function createFinancialSourceReviewManifest(control: FinancialSourceControl): FinancialSourceReviewManifest {
  return reviewWrapper(financialSourceControlSchema.parse(control));
}
