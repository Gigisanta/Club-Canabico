import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { canonicalJson } from "../../shared/operations/exact.js";
import {
  LEGACY_CHUNK_BYTES,
  LEGACY_CHUNK_RECORDS,
  LEGACY_UPLOAD_BYTES,
  legacyPayloadHash,
} from "./legacy-upload-contract.js";
import {
  containsRecognizableCredential,
  isCredentialBearingHeader,
  readLegacyWorkbook,
  type LegacySheetCoverage,
  type LegacySourceSnapshotRecord,
  type LegacyWorkbookSnapshot,
} from "./legacy-reader.js";
import { sourceRecordSchema } from "./legacy-source-contract.js";
import { verifyBackupReference } from "./financial-source-stage.js";

export const APPSHEET_ARCHIVE_SOURCE_SYSTEM = "appsheet-business-archive";
export const APPSHEET_ARCHIVE_IMPORTER_VERSION = "codex:appsheet-business-archive";
export const APPSHEET_ARCHIVE_ACTOR = "codex:appsheet-business-archive";

export const APPSHEET_ARCHIVE_SHEETS = [
  "C_Cliente",
  "Campaña_WhatsApp",
  "Destinatarios_Campaña",
  "Plantillas_WhatsApp",
  "Log_WhatsApp",
  "Cliente_Segmentado",
  "D_Catalogo_Mercaderia",
  "C_Detalle_Fact",
  "C_Facturacion",
  "Pre_Venta",
  "Pre_Detalle_Fact",
  "C_Moto",
  "C_OperacionUSD",
  "Movimiento_Nueva",
  "C_gastos_operacion",
  "C_Mercaderia",
  "Mov_Stock1",
  "O_Ruta",
  "Auditoria_General",
  "Auditoria_Stock_Detalle_Mercade",
  "Auditoria_Movimiento_Factura_ga",
  "Estado_Stock",
  "Template_Estado_Stocl",
  "Estado_Resultado_Template",
  "Caja_Resultado_Template",
  "Reporte_Movimiento",
  "Estado_Resultado",
  "Caja_Resultado",
  "Movimiento",
  "Stock_Resumen",
  "D_Articulo",
  "Movimientos_Stock",
] as const;

export const APPSHEET_COORDINATE_ONLY_SHEETS = [
  "Form_Stockxdíavariedad",
  "Array",
  "Movimiento_Diario",
  "stc",
  "Hoja 18",
  "Extras",
] as const;

const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_STAGED_JSON_BYTES = LEGACY_UPLOAD_BYTES;
const hashPattern = /^[a-f0-9]{64}$/;
const countSchema = z.number().int().min(0).max(100_000);

const archiveSheetSchema = z.strictObject({
  name: z.enum(APPSHEET_ARCHIVE_SHEETS),
  recordCount: countSchema,
  keyedRecordCount: countSchema.nullable(),
  duplicateKeyCount: countSchema.nullable(),
  missingKeyCount: countSchema.nullable(),
  primaryKeyHeader: z.string().min(1).max(120).nullable(),
  archiveOnly: z.boolean(),
});

const archiveManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  fileHash: z.string().regex(hashPattern),
  sourceSystem: z.literal(APPSHEET_ARCHIVE_SOURCE_SYSTEM),
  sheets: z.array(archiveSheetSchema).length(APPSHEET_ARCHIVE_SHEETS.length),
});

const coordinateCoverageSchema = z.strictObject({
  name: z.enum(APPSHEET_COORDINATE_ONLY_SHEETS),
  extracted: z.literal(false),
  dimension: z.string().max(120).regex(/^[A-Z]{1,3}\$?[1-9]\d*(?::[A-Z]{1,3}\$?[1-9]\d*)?$/i).nullable(),
});

const coordinateManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  fileHash: z.string().regex(hashPattern),
  sourceSystem: z.literal(APPSHEET_ARCHIVE_SOURCE_SYSTEM),
  sheets: z.array(coordinateCoverageSchema).length(APPSHEET_COORDINATE_ONLY_SHEETS.length),
});

export type AppSheetArchiveManifest = z.infer<typeof archiveManifestSchema>;
export type AppSheetCoordinateCoverage = z.infer<typeof coordinateManifestSchema>;

interface PersistedException {
  id: string;
  sourceRecordId: string | null;
  kind: string;
  severity: "review" | "blocking";
  description: string;
}

interface PersistedRecord extends Prisma.LegacySourceRecordCreateManyInput {
  id: string;
}

export interface PreparedAppSheetArchiveStage {
  filename: string;
  snapshotId: string;
  fileHash: string;
  snapshot: LegacyWorkbookSnapshot;
  records: LegacySourceSnapshotRecord[];
  persistedRecords: PersistedRecord[];
  exceptions: PersistedException[];
  manifest: AppSheetArchiveManifest;
  coordinateCoverage: AppSheetCoordinateCoverage;
  controlManifestHash: string;
  coordinateCoverageHash: string;
  rowManifestHash: string;
  coverage: Record<string, unknown>;
  controls: Record<string, unknown>;
  metrics: {
    recordCount: number;
    exceptionCount: number;
    quarantinedRecordCount: number;
    unlabeledRowsOmitted: number;
    formulaOnlyRows: number;
    formulaWithoutCachedResultCells: number;
  };
}

export interface AppSheetArchivePreview {
  snapshotId: string;
  fileHash: string;
  sourceSystem: typeof APPSHEET_ARCHIVE_SOURCE_SYSTEM;
  importerVersion: typeof APPSHEET_ARCHIVE_IMPORTER_VERSION;
  sheetCount: number;
  recordCount: number;
  exceptionCount: number;
  quarantinedRecordCount: number;
  unlabeledRowsOmitted: number;
  formulaOnlyRows: number;
  formulaWithoutCachedResultCells: number;
  controlManifestHash: string;
  coordinateCoverageHash: string;
  rowManifestHash: string;
  status: "preview" | "staged" | "already-staged";
  backupManifestHash?: string;
}

export class AppSheetArchiveStageError extends Error {
  constructor(readonly code: string, readonly metrics?: Record<string, string | number | boolean | null>) {
    super(code);
    this.name = "AppSheetArchiveStageError";
  }
}

function fail(code: string, metrics?: Record<string, string | number | boolean | null>): never {
  throw new AppSheetArchiveStageError(code, metrics);
}

export function parseAppSheetArchiveManifest(value: unknown): AppSheetArchiveManifest {
  const parsed = archiveManifestSchema.safeParse(value);
  if (!parsed.success) fail("control_manifest_invalid");
  const names = parsed.data.sheets.map((sheet) => sheet.name);
  if (new Set(names).size !== APPSHEET_ARCHIVE_SHEETS.length ||
      APPSHEET_ARCHIVE_SHEETS.some((name) => !names.includes(name)))
    fail("control_manifest_sheet_set_mismatch");
  for (const sheet of parsed.data.sheets) {
    const hasKeyStats = sheet.keyedRecordCount !== null && sheet.duplicateKeyCount !== null && sheet.missingKeyCount !== null;
    if ((sheet.primaryKeyHeader === null && hasKeyStats) || (sheet.primaryKeyHeader !== null && !hasKeyStats))
      fail("control_manifest_key_stats_invalid");
    if (sheet.primaryKeyHeader === null &&
        (sheet.keyedRecordCount !== null || sheet.duplicateKeyCount !== null || sheet.missingKeyCount !== null))
      fail("control_manifest_key_stats_invalid");
    if (sheet.primaryKeyHeader !== null && isCredentialBearingHeader(sheet.primaryKeyHeader, sheet.name))
      fail("control_manifest_key_header_rejected");
  }
  return parsed.data;
}

export function parseAppSheetCoordinateCoverage(value: unknown): AppSheetCoordinateCoverage {
  const parsed = coordinateManifestSchema.safeParse(value);
  if (!parsed.success) fail("coordinate_coverage_invalid");
  const names = parsed.data.sheets.map((sheet) => sheet.name);
  if (new Set(names).size !== APPSHEET_COORDINATE_ONLY_SHEETS.length ||
      APPSHEET_COORDINATE_ONLY_SHEETS.some((name) => !names.includes(name)))
    fail("coordinate_coverage_sheet_set_mismatch");
  return parsed.data;
}

export async function readPrivateControlFile(path: string, expectedBasename: string): Promise<unknown> {
  try {
    if (basename(path) !== expectedBasename) fail("control_file_name_invalid");
    const info = await lstat(path);
    const directory = await stat(dirname(path));
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONTROL_BYTES || (info.mode & 0o077) !== 0 ||
        !directory.isDirectory() || (directory.mode & 0o077) !== 0)
      fail("control_file_permissions_invalid");
    const bytes = await readFile(path);
    if (bytes.length > MAX_CONTROL_BYTES) fail("control_file_too_large");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof AppSheetArchiveStageError) throw error;
    fail("control_file_unavailable");
  }
}

function safeNonempty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "object" && !Array.isArray(value) && "kind" in value) {
    const cell = value as { kind?: unknown; value?: unknown; formula?: unknown; sharedFormula?: unknown; xml?: { formula?: unknown } };
    if (cell.kind === "excluded_credential_value") return false;
    if (cell.kind === "source_xml_cell") return Boolean(cell.xml?.formula) || safeNonempty(cell.value);
    if (cell.kind === "formula") return typeof cell.formula === "string" || typeof cell.sharedFormula === "string";
  }
  return true;
}

function formulaInfo(value: unknown): { isFormula: boolean; hasCachedResult: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { isFormula: false, hasCachedResult: true };
  const cell = value as {
    kind?: unknown;
    value?: unknown;
    formula?: unknown;
    sharedFormula?: unknown;
    cachedResult?: unknown;
    xml?: { formula?: unknown; valuePresent?: unknown };
  };
  if (cell.kind === "source_xml_cell") {
    if (cell.xml?.formula) return { isFormula: true, hasCachedResult: cell.xml.valuePresent === true };
    return formulaInfo(cell.value);
  }
  if (cell.kind === "formula") {
    const isFormula = typeof cell.formula === "string" || typeof cell.sharedFormula === "string";
    return { isFormula, hasCachedResult: !isFormula || (cell.cachedResult !== null && cell.cachedResult !== undefined) };
  }
  return { isFormula: false, hasCachedResult: true };
}

function formulaMetrics(records: LegacySourceSnapshotRecord[]): { formulaOnlyRows: number; formulaWithoutCachedResultCells: number } {
  let formulaOnlyRows = 0;
  let formulaWithoutCachedResultCells = 0;
  for (const record of records) {
    const safeCoordinates = new Set(record.normalized.columns
      .filter((column) => column.header !== null && column.header.trim().length > 0 && !isCredentialBearingHeader(column.header, record.sourceTable))
      .map((column) => column.coordinate));
    let rowHasFormula = false;
    let rowHasLiteral = false;
    for (const column of record.original.columns) {
      if (!safeCoordinates.has(column.coordinate)) continue;
      const formula = formulaInfo(column.value);
      if (formula.isFormula) {
        rowHasFormula = true;
        if (!formula.hasCachedResult) formulaWithoutCachedResultCells++;
      } else if (safeNonempty(column.value)) {
        rowHasLiteral = true;
      }
    }
    if (rowHasFormula && !rowHasLiteral) formulaOnlyRows++;
  }
  return { formulaOnlyRows, formulaWithoutCachedResultCells };
}

function archiveOnlyRecord(record: LegacySourceSnapshotRecord): LegacySourceSnapshotRecord {
  const { contentHash: _previousHash, ...source } = record;
  const exceptions = source.exceptions.filter((exception) => !exception.kind.startsWith("cash_overlap_"));
  const projection = {
    ...source,
    normalized: { columns: source.normalized.columns },
    treatment: "archive_only" as const,
    exceptions,
  };
  return sourceRecordSchema.parse({ ...projection, contentHash: legacyPayloadHash(projection) }) as LegacySourceSnapshotRecord;
}

function rowHasSafeLabeledValue(record: LegacySourceSnapshotRecord): boolean {
  const safeCoordinates = new Set(record.normalized.columns
    .filter((column) => column.header !== null && column.header.trim().length > 0 && !isCredentialBearingHeader(column.header, record.sourceTable))
    .map((column) => column.coordinate));
  return record.original.columns.some((column) => safeCoordinates.has(column.coordinate) && safeNonempty(column.value));
}

function rowHasSafeLabel(record: LegacySourceSnapshotRecord): boolean {
  return record.normalized.columns.some((column) =>
    column.header !== null && column.header.trim().length > 0 && !isCredentialBearingHeader(column.header, record.sourceTable));
}

function rowHasSafeFormula(record: LegacySourceSnapshotRecord): boolean {
  const safeCoordinates = new Set(record.normalized.columns
    .filter((column) => column.header !== null && column.header.trim().length > 0 && !isCredentialBearingHeader(column.header, record.sourceTable))
    .map((column) => column.coordinate));
  return record.original.columns.some((column) => {
    if (!safeCoordinates.has(column.coordinate) || !column.value || typeof column.value !== "object" || Array.isArray(column.value)) return false;
    const cell = column.value as { kind?: unknown; value?: unknown };
    if (cell.kind === "source_xml_cell" && cell.value && typeof cell.value === "object" && !Array.isArray(cell.value))
      return (cell.value as { kind?: unknown }).kind === "formula";
    return cell.kind === "formula";
  });
}

function recordHasCredentialSignal(record: LegacySourceSnapshotRecord): boolean {
  return record.exceptions.some((exception) => exception.kind === "credential_value_excluded") || containsRecognizableCredential(record);
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${legacyPayloadHash(value)}`;
}

function persistedRecord(snapshotId: string, record: LegacySourceSnapshotRecord): PersistedRecord {
  return {
    id: stableId("apprec", { snapshotId, sourceTable: record.sourceTable, sourceRow: record.sourceRow }),
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

function exceptionDescription(kind: string, sourceTable: string, sourceRow: number): string {
  return `Excepción técnica ${kind} en hoja ${sourceTable}, fila ${sourceRow}.`;
}

function metadataException(snapshotId: string, kind: string, severity: "review" | "blocking", description: string): PersistedException {
  return {
    id: stableId("appexc", { snapshotId, kind, description }),
    sourceRecordId: null,
    kind,
    severity,
    description,
  };
}

function recordExceptions(
  snapshotId: string,
  record: LegacySourceSnapshotRecord,
  sourceRecordId: string,
): PersistedException[] {
  return record.exceptions.map((exception) => ({
    id: stableId("appexc", { snapshotId, sourceRecordId, kind: exception.kind, evidence: exception.evidence }),
    sourceRecordId,
    kind: exception.kind,
    severity: exception.severity,
    description: exceptionDescription(exception.kind, record.sourceTable, record.sourceRow),
  }));
}

function compareControlCounts(
  manifest: AppSheetArchiveManifest,
  records: LegacySourceSnapshotRecord[],
  sheets: LegacySheetCoverage[],
): void {
  const sheetByName = new Map(sheets.map((sheet) => [sheet.name, sheet]));
  for (const expected of manifest.sheets) {
    const actualSheet = sheetByName.get(expected.name);
    if (!actualSheet || (actualSheet.role === "archive_only") !== expected.archiveOnly)
      fail("control_sheet_role_mismatch", {
        sheetName: expected.name,
        expectedArchiveOnly: expected.archiveOnly,
        actualRole: actualSheet?.role ?? "missing",
      });
    if (actualSheet.excludedCredentialColumns > 0) fail("credential_header_detected");
    const rows = records.filter((record) => record.sourceTable === expected.name);
    if (rows.length !== expected.recordCount) fail("control_record_count_mismatch", {
      sheetName: expected.name,
      expectedRecordCount: expected.recordCount,
      actualRecordCount: rows.length,
    });
    if (expected.primaryKeyHeader === null) {
      if (expected.keyedRecordCount !== null || expected.duplicateKeyCount !== null || expected.missingKeyCount !== null)
        fail("control_manifest_key_stats_invalid");
      continue;
    }
    const keyed = rows.filter((record) => !record.sourceKey.startsWith("synthetic:"));
    const keyCounts = new Map<string, number>();
    for (const record of keyed) keyCounts.set(record.sourceKey, (keyCounts.get(record.sourceKey) ?? 0) + 1);
    const duplicates = [...keyCounts.values()].filter((count) => count > 1).length;
    const missing = rows.length - keyed.length;
    if (expected.keyedRecordCount !== keyed.length || expected.duplicateKeyCount !== duplicates || expected.missingKeyCount !== missing)
      fail("control_key_count_mismatch", {
        sheetName: expected.name,
        expectedKeyedRecordCount: expected.keyedRecordCount,
        actualKeyedRecordCount: keyed.length,
        expectedDuplicateKeyCount: expected.duplicateKeyCount,
        actualDuplicateKeyCount: duplicates,
        expectedMissingKeyCount: expected.missingKeyCount,
        actualMissingKeyCount: missing,
      });
  }
}

function buildCoverage(
  sheets: LegacySheetCoverage[],
  records: LegacySourceSnapshotRecord[],
  credentialRows: Set<string>,
  unlabeledRows: Set<string>,
  coordinateCoverage: AppSheetCoordinateCoverage,
) {
  const counts = new Map<string, { recordCount: number; keyedRecordCount: number }>();
  for (const record of records) {
    const value = counts.get(record.sourceTable) ?? { recordCount: 0, keyedRecordCount: 0 };
    value.recordCount++;
    if (!record.sourceKey.startsWith("synthetic:")) value.keyedRecordCount++;
    counts.set(record.sourceTable, value);
  }
  return {
    selectedSheets: sheets.map((sheet) => ({
      name: sheet.name,
      state: sheet.state,
      fieldCount: sheet.fieldCount,
      recordCount: counts.get(sheet.name)?.recordCount ?? 0,
      keyedRecordCount: counts.get(sheet.name)?.keyedRecordCount ?? 0,
      headerRow: sheet.headerRow,
      coordinateOnly: false,
      excludedCredentialColumns: sheet.excludedCredentialColumns,
      quarantinedRecordCount: [...credentialRows].filter((value) => value.startsWith(`${sheet.name}\u0000`)).length,
      unlabeledRowsOmitted: [...unlabeledRows].filter((value) => value.startsWith(`${sheet.name}\u0000`)).length,
    })),
    coordinateOnlyCoverage: coordinateCoverage.sheets,
    workbookCoverageComplete: false,
  };
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function prepareAppSheetArchiveStage(input: {
  filePath: string;
  manifestValue: unknown;
  coordinateCoverageValue: unknown;
}): Promise<PreparedAppSheetArchiveStage> {
  const manifest = parseAppSheetArchiveManifest(input.manifestValue);
  const coordinateCoverage = parseAppSheetCoordinateCoverage(input.coordinateCoverageValue);
  let bytes: Buffer;
  let filename: string;
  try {
    const info = await stat(input.filePath);
    if (!info.isFile() || info.size <= 0 || info.size > LEGACY_UPLOAD_BYTES) fail("source_file_size_invalid");
    bytes = await readFile(input.filePath);
    filename = basename(input.filePath);
    if (bytes.length <= 0 || bytes.length > LEGACY_UPLOAD_BYTES || !/^[A-Za-z0-9._ ()-]{1,255}$/.test(filename))
      fail("source_file_invalid");
  } catch (error) {
    if (error instanceof AppSheetArchiveStageError) throw error;
    fail("source_file_unavailable");
  }

  const fileHash = createHash("sha256").update(bytes).digest("hex");
  if (fileHash !== manifest.fileHash || fileHash !== coordinateCoverage.fileHash)
    fail("source_hash_mismatch");

  const primaryKeyHeaders = Object.fromEntries(manifest.sheets
    .filter((sheet) => sheet.primaryKeyHeader !== null)
    .map((sheet) => [sheet.name, sheet.primaryKeyHeader!]));
  let snapshot: LegacyWorkbookSnapshot;
  try {
    snapshot = await readLegacyWorkbook(bytes, {
      sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
      importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
      allowedSheets: APPSHEET_ARCHIVE_SHEETS,
      primaryKeyHeaders,
    });
  } catch {
    fail("source_reader_rejected");
  }
  if (snapshot.sourceSystem !== APPSHEET_ARCHIVE_SOURCE_SYSTEM ||
      snapshot.importerVersion !== APPSHEET_ARCHIVE_IMPORTER_VERSION || snapshot.fileHash !== fileHash ||
      snapshot.sheets.length !== APPSHEET_ARCHIVE_SHEETS.length ||
      new Set(snapshot.sheets.map((sheet) => sheet.name)).size !== APPSHEET_ARCHIVE_SHEETS.length ||
      APPSHEET_ARCHIVE_SHEETS.some((name) => !snapshot.sheets.some((sheet) => sheet.name === name)))
    fail("reader_scope_mismatch");

  const credentialRows = new Set<string>();
  const unlabeledRows = new Set<string>();
  const records: LegacySourceSnapshotRecord[] = [];
  const exceptions: PersistedException[] = [];
  for (const record of snapshot.records) {
    const rowKey = `${record.sourceTable}\u0000${record.sourceRow}`;
    if (recordHasCredentialSignal(record)) {
      credentialRows.add(rowKey);
      exceptions.push(metadataException(snapshotIdFor(fileHash), "credential_record_quarantined", "blocking",
        `Registro con señal de credencial puesto en cuarentena en hoja ${record.sourceTable}, fila ${record.sourceRow}.`));
      continue;
    }
    if (!rowHasSafeLabeledValue(record)) {
      unlabeledRows.add(rowKey);
      const kind = rowHasSafeLabel(record)
        ? rowHasSafeFormula(record) ? "empty_formula_result_row_omitted" : "empty_safe_row_omitted"
        : "unlabeled_row_omitted";
      exceptions.push(metadataException(snapshotIdFor(fileHash), kind, "review",
        `Fila omitida por carecer de valores no vacíos en columnas con etiqueta segura en hoja ${record.sourceTable}, fila ${record.sourceRow}.`));
      continue;
    }
    try {
      records.push(archiveOnlyRecord(record));
    } catch {
      fail("source_record_rejected");
    }
  }

  compareControlCounts(manifest, records, snapshot.sheets);
  const snapshotId = snapshotIdFor(fileHash);
  const persistedBySourceRow = new Map<string, PersistedRecord>();
  const persistedRecords = records.map((record) => {
    const persisted = persistedRecord(snapshotId, record);
    persistedBySourceRow.set(`${record.sourceTable}\u0000${record.sourceRow}`, persisted);
    return persisted;
  });
  for (const record of records) {
    const persisted = persistedBySourceRow.get(`${record.sourceTable}\u0000${record.sourceRow}`)!;
    exceptions.push(...recordExceptions(snapshotId, record, persisted.id));
  }

  const controlManifestHash = legacyPayloadHash(manifest);
  const coordinateCoverageHash = legacyPayloadHash(coordinateCoverage);
  const formulas = formulaMetrics(records);
  const coverage = buildCoverage(snapshot.sheets, records, credentialRows, unlabeledRows, coordinateCoverage);
  const controls = {
    appSheetBusinessArchive: {
      sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
      importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
      actor: APPSHEET_ARCHIVE_ACTOR,
      status: "staged",
      reviewedBy: null,
      reviewedAt: null,
      controlManifestHash,
      controlManifest: manifest,
      coordinateCoverageHash,
      rowManifestHash: legacyPayloadHash({ records: persistedRecords, exceptions }),
      recordCount: persistedRecords.length,
      exceptionCount: exceptions.length,
      quarantinedRecordCount: credentialRows.size,
      unlabeledRowsOmitted: unlabeledRows.size,
      formulaOnlyRows: formulas.formulaOnlyRows,
      formulaWithoutCachedResultCells: formulas.formulaWithoutCachedResultCells,
    },
  };
  const rowManifestHash = (controls.appSheetBusinessArchive as { rowManifestHash: string }).rowManifestHash;
  const serializedBytes = Buffer.byteLength(JSON.stringify({ persistedRecords, exceptions, controls, coverage }), "utf8");
  if (serializedBytes > MAX_STAGED_JSON_BYTES) fail("source_payload_too_large");

  return {
    filename,
    snapshotId,
    fileHash,
    snapshot: {
      ...snapshot,
      records,
      exceptions: snapshot.exceptions.filter((exception) => !exception.kind.startsWith("cash_overlap_")),
      summary: {
        ...snapshot.summary,
        recordCount: records.length,
        keyedRecordCount: records.filter((record) => !record.sourceKey.startsWith("synthetic:")).length,
        syntheticKeyCount: records.filter((record) => record.sourceKey.startsWith("synthetic:")).length,
        recordsByTreatment: { fact_candidate: 0, archive_only: records.length, overlap_evidence: 0 },
        exceptionCount: records.reduce((count, record) => count + record.exceptions.length, 0),
        cashOverlap: {},
      },
    },
    records,
    persistedRecords,
    exceptions,
    manifest,
    coordinateCoverage,
    controlManifestHash,
    coordinateCoverageHash,
    rowManifestHash,
    coverage,
    controls,
    metrics: {
      recordCount: persistedRecords.length,
      exceptionCount: exceptions.length,
      quarantinedRecordCount: credentialRows.size,
      unlabeledRowsOmitted: unlabeledRows.size,
      formulaOnlyRows: formulas.formulaOnlyRows,
      formulaWithoutCachedResultCells: formulas.formulaWithoutCachedResultCells,
    },
  };
}

function snapshotIdFor(fileHash: string): string {
  return stableId("appstage", {
    sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
    fileHash,
    importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
  });
}

function chunks<T>(values: T[]): T[][] {
  const result: T[][] = [];
  let current: T[] = [];
  let currentBytes = 2;
  for (const value of values) {
    const size = Buffer.byteLength(JSON.stringify(value), "utf8") + (current.length ? 1 : 0);
    if (size > LEGACY_CHUNK_BYTES) fail("source_record_chunk_too_large");
    if (current.length >= LEGACY_CHUNK_RECORDS || currentBytes + size > LEGACY_CHUNK_BYTES) {
      result.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(value);
    currentBytes += size;
  }
  if (current.length) result.push(current);
  return result;
}

function snapshotControlsForReplay(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outer = value as Record<string, unknown>;
  if (canonicalJson(Object.keys(outer).sort()) !== canonicalJson(["appSheetBusinessArchive"])) return null;
  const stage = outer.appSheetBusinessArchive;
  if (!stage || typeof stage !== "object" || Array.isArray(stage)) return null;
  const fields = stage as Record<string, unknown>;
  const expectedFields = [
    "actor", "backupManifestHash", "backupSnapshotAt", "controlManifest", "controlManifestHash",
    "coordinateCoverageHash", "exceptionCount", "formulaOnlyRows", "formulaWithoutCachedResultCells",
    "importerVersion", "quarantinedRecordCount", "recordCount", "rowManifestHash", "sourceSystem",
    "status", "unlabeledRowsOmitted", "reviewedAt", "reviewedBy",
  ].sort();
  if (canonicalJson(Object.keys(fields).sort()) !== canonicalJson(expectedFields)) return null;
  if (fields.sourceSystem !== APPSHEET_ARCHIVE_SOURCE_SYSTEM ||
      fields.importerVersion !== APPSHEET_ARCHIVE_IMPORTER_VERSION || fields.actor !== APPSHEET_ARCHIVE_ACTOR ||
      fields.status !== "staged" || fields.reviewedBy !== null || fields.reviewedAt !== null ||
      typeof fields.controlManifestHash !== "string" || !hashPattern.test(fields.controlManifestHash) ||
      typeof fields.coordinateCoverageHash !== "string" || !hashPattern.test(fields.coordinateCoverageHash) ||
      typeof fields.rowManifestHash !== "string" || !hashPattern.test(fields.rowManifestHash) ||
      !Number.isSafeInteger(fields.formulaOnlyRows) || !Number.isSafeInteger(fields.formulaWithoutCachedResultCells)) return null;
  try {
    const manifest = parseAppSheetArchiveManifest(fields.controlManifest);
    if (legacyPayloadHash(manifest) !== fields.controlManifestHash) return null;
  } catch {
    return null;
  }
  return fields;
}

function coordinateCoverageFromSnapshot(value: unknown, fileHash: string): AppSheetCoordinateCoverage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return parseAppSheetCoordinateCoverage({
      schemaVersion: 1,
      fileHash,
      sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
      sheets: (value as Record<string, unknown>).coordinateOnlyCoverage,
    });
  } catch {
    return null;
  }
}

async function verifyExistingSnapshot(tx: Prisma.TransactionClient, prepared: PreparedAppSheetArchiveStage): Promise<AppSheetArchivePreview> {
  const snapshot = await tx.legacyImportSnapshot.findUnique({
    where: { sourceSystem_fileHash_importerVersion: {
      sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
      fileHash: prepared.fileHash,
      importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
    } },
    select: { id: true, sourceSystem: true, filename: true, fileHash: true, importerVersion: true, status: true,
      createdBy: true, reviewedBy: true, reviewedAt: true, controls: true, coverage: true },
  });
  if (!snapshot) fail("existing_snapshot_missing");
  const controls = snapshotControlsForReplay(snapshot.controls);
  const storedCoordinateCoverage = coordinateCoverageFromSnapshot(snapshot.coverage, snapshot.fileHash);
  const storedControls = controls ? { ...controls } : null;
  if (storedControls) {
    delete storedControls.backupManifestHash;
    delete storedControls.backupSnapshotAt;
  }
  if (snapshot.id !== prepared.snapshotId || snapshot.sourceSystem !== APPSHEET_ARCHIVE_SOURCE_SYSTEM ||
      snapshot.filename !== prepared.filename || snapshot.fileHash !== prepared.fileHash ||
      snapshot.importerVersion !== APPSHEET_ARCHIVE_IMPORTER_VERSION || snapshot.status !== "staged" ||
      snapshot.createdBy !== APPSHEET_ARCHIVE_ACTOR || snapshot.reviewedBy !== null || snapshot.reviewedAt !== null ||
      !controls || controls.controlManifestHash !== prepared.controlManifestHash ||
      canonicalJson(controls.controlManifest) !== canonicalJson(prepared.manifest) ||
      canonicalJson(storedControls) !== canonicalJson(prepared.controls.appSheetBusinessArchive) ||
      controls.coordinateCoverageHash !== prepared.coordinateCoverageHash || controls.rowManifestHash !== prepared.rowManifestHash ||
      !storedCoordinateCoverage || legacyPayloadHash(storedCoordinateCoverage) !== controls.coordinateCoverageHash ||
      canonicalJson(storedCoordinateCoverage) !== canonicalJson(prepared.coordinateCoverage) ||
      controls.recordCount !== prepared.metrics.recordCount || controls.exceptionCount !== prepared.metrics.exceptionCount ||
      controls.formulaOnlyRows !== prepared.metrics.formulaOnlyRows ||
      controls.formulaWithoutCachedResultCells !== prepared.metrics.formulaWithoutCachedResultCells ||
      canonicalJson(snapshot.coverage) !== canonicalJson(prepared.coverage))
    fail("existing_snapshot_mismatch");

  const [storedRecords, storedExceptions, operationObject, audits] = await Promise.all([
    tx.legacySourceRecord.findMany({
      where: { snapshotId: snapshot.id },
      orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }],
      select: { id: true, snapshotId: true, sourceTable: true, sourceKey: true, sourceRow: true, fileHash: true,
        contentHash: true, importerVersion: true, original: true, normalized: true, treatment: true },
    }),
    tx.legacyException.findMany({
      where: { snapshotId: snapshot.id },
      orderBy: [{ sourceRecordId: "asc" }, { kind: "asc" }, { id: "asc" }],
      select: { id: true, sourceRecordId: true, kind: true, severity: true, description: true },
    }),
    tx.operationObject.findUnique({ where: { id: snapshot.id }, select: { id: true, kind: true, version: true, createdBy: true } }),
    tx.operationAudit.findMany({ where: { objectId: snapshot.id, action: "legacy.appsheet_business_archive_staged" },
      orderBy: { createdAt: "asc" }, select: { actorId: true, action: true, objectId: true, details: true } }),
  ]);
  const compareRecords = (a: { sourceTable: string; sourceRow: number }, b: { sourceTable: string; sourceRow: number }) =>
    a.sourceTable.localeCompare(b.sourceTable) || a.sourceRow - b.sourceRow;
  const actualRecords = [...storedRecords].sort(compareRecords);
  const expectedRecords = [...prepared.persistedRecords].sort(compareRecords);
  const expectedExceptions = [...prepared.exceptions].sort((a, b) =>
    (a.sourceRecordId ?? "").localeCompare(b.sourceRecordId ?? "") || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const actualExceptions = [...storedExceptions].sort((a, b) =>
    (a.sourceRecordId ?? "").localeCompare(b.sourceRecordId ?? "") || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  if (actualRecords.length !== expectedRecords.length || canonicalJson(actualRecords) !== canonicalJson(expectedRecords) ||
      storedExceptions.length !== expectedExceptions.length || canonicalJson(actualExceptions) !== canonicalJson(expectedExceptions) ||
      !operationObject || operationObject.kind !== "legacyImport" || operationObject.version !== 0 ||
      operationObject.createdBy !== APPSHEET_ARCHIVE_ACTOR || audits.length !== 1 || audits[0]!.actorId !== APPSHEET_ARCHIVE_ACTOR ||
      canonicalJson(audits[0]!.details) !== canonicalJson(auditDetails(prepared, readBackupEvidence(controls))))
    fail("existing_snapshot_record_mismatch");

  return previewResult(prepared, "already-staged", readBackupEvidence(controls));
}

function readBackupEvidence(controls: Record<string, unknown>): { manifestHash: string; snapshotAt: string } {
  const hash = controls.backupManifestHash;
  const snapshotAt = controls.backupSnapshotAt;
  if (typeof hash !== "string" || !hashPattern.test(hash) || typeof snapshotAt !== "string" || Number.isNaN(Date.parse(snapshotAt)))
    fail("existing_snapshot_backup_evidence_missing");
  return { manifestHash: hash, snapshotAt };
}

function auditDetails(prepared: PreparedAppSheetArchiveStage, backup: { manifestHash: string; snapshotAt: string }) {
  return {
    sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
    importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
    fileHash: prepared.fileHash,
    controlManifestHash: prepared.controlManifestHash,
    coordinateCoverageHash: prepared.coordinateCoverageHash,
    rowManifestHash: prepared.rowManifestHash,
    backupManifestHash: backup.manifestHash,
    backupSnapshotAt: backup.snapshotAt,
    recordCount: prepared.metrics.recordCount,
    exceptionCount: prepared.metrics.exceptionCount,
    quarantinedRecordCount: prepared.metrics.quarantinedRecordCount,
    unlabeledRowsOmitted: prepared.metrics.unlabeledRowsOmitted,
    formulaOnlyRows: prepared.metrics.formulaOnlyRows,
    formulaWithoutCachedResultCells: prepared.metrics.formulaWithoutCachedResultCells,
    status: "staged",
    reviewedBy: null,
  };
}

function previewResult(
  prepared: PreparedAppSheetArchiveStage,
  status: AppSheetArchivePreview["status"],
  backup?: { manifestHash: string; snapshotAt: string },
): AppSheetArchivePreview {
  return {
    snapshotId: prepared.snapshotId,
    fileHash: prepared.fileHash,
    sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
    importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
    sheetCount: prepared.snapshot.sheets.length,
    recordCount: prepared.metrics.recordCount,
    exceptionCount: prepared.metrics.exceptionCount,
    quarantinedRecordCount: prepared.metrics.quarantinedRecordCount,
    unlabeledRowsOmitted: prepared.metrics.unlabeledRowsOmitted,
    formulaOnlyRows: prepared.metrics.formulaOnlyRows,
    formulaWithoutCachedResultCells: prepared.metrics.formulaWithoutCachedResultCells,
    controlManifestHash: prepared.controlManifestHash,
    coordinateCoverageHash: prepared.coordinateCoverageHash,
    rowManifestHash: prepared.rowManifestHash,
    status,
    ...(backup ? { backupManifestHash: backup.manifestHash } : {}),
  };
}

async function persistPreparedStage(
  tx: Prisma.TransactionClient,
  prepared: PreparedAppSheetArchiveStage,
  backup: { manifestHash: string; snapshotAt: string },
): Promise<AppSheetArchivePreview> {
  const existing = await tx.legacyImportSnapshot.findUnique({
    where: { sourceSystem_fileHash_importerVersion: {
      sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
      fileHash: prepared.fileHash,
      importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
    } },
    select: { id: true },
  });
  if (existing) return verifyExistingSnapshot(tx, prepared);
  if (await tx.operationObject.findUnique({ where: { id: prepared.snapshotId }, select: { id: true } }))
    fail("operation_object_conflict");

  await tx.legacyImportSnapshot.create({ data: {
    id: prepared.snapshotId,
    sourceSystem: APPSHEET_ARCHIVE_SOURCE_SYSTEM,
    filename: prepared.filename,
    fileHash: prepared.fileHash,
    importerVersion: APPSHEET_ARCHIVE_IMPORTER_VERSION,
    status: "staged",
    createdBy: APPSHEET_ARCHIVE_ACTOR,
    reviewedBy: null,
    reviewedAt: null,
    controls: asInputJson({
      ...prepared.controls,
      appSheetBusinessArchive: {
        ...(prepared.controls.appSheetBusinessArchive as Record<string, unknown>),
        backupManifestHash: backup.manifestHash,
        backupSnapshotAt: backup.snapshotAt,
      },
    }),
    coverage: asInputJson(prepared.coverage),
  } });
  for (const batch of chunks(prepared.persistedRecords))
    await tx.legacySourceRecord.createMany({ data: batch });
  for (const batch of chunks(prepared.exceptions))
    await tx.legacyException.createMany({
      data: batch.map((exception) => ({ ...exception, snapshotId: prepared.snapshotId })),
    });
  await tx.operationObject.create({ data: {
    id: prepared.snapshotId,
    kind: "legacyImport",
    version: 0,
    createdBy: APPSHEET_ARCHIVE_ACTOR,
  } });
  await tx.operationAudit.create({ data: {
    actorId: APPSHEET_ARCHIVE_ACTOR,
    action: "legacy.appsheet_business_archive_staged",
    objectId: prepared.snapshotId,
    details: asInputJson(auditDetails(prepared, backup)),
  } });
  return previewResult(prepared, "staged", backup);
}

export async function stageAppSheetArchive(
  prepared: PreparedAppSheetArchiveStage,
  options: { backupReference: string },
): Promise<AppSheetArchivePreview> {
  if (!prepared.fileHash || !prepared.snapshotId || prepared.metrics.recordCount !== prepared.persistedRecords.length ||
      prepared.records.length !== prepared.persistedRecords.length || prepared.metrics.exceptionCount !== prepared.exceptions.length)
    fail("prepared_stage_invalid");
  let backup: { manifestHash: string; snapshotAt: string };
  try {
    backup = await verifyBackupReference(options.backupReference);
  } catch {
    fail("backup_verification_failed");
  }
  const { db } = await import("../db.js");
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.$transaction(
          (tx) => persistPreparedStage(tx, prepared, backup),
          { isolationLevel: "Serializable", timeout: 120_000, maxWait: 15_000 },
        );
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
        if ((code === "P2002" || code === "P2034") && attempt < 3) continue;
        if (error instanceof AppSheetArchiveStageError) throw error;
        fail("stage_transaction_failed");
      }
    }
  } finally {
    await db.$disconnect();
  }
}

export function previewAppSheetArchive(prepared: PreparedAppSheetArchiveStage): AppSheetArchivePreview {
  return previewResult(prepared, "preview");
}
