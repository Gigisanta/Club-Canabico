import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  APPSHEET_PENDING_MAPPING_ID,
  APPSHEET_PENDING_MAPPING_SPEC,
  APPSHEET_PENDING_SCHEMA_VERSION,
  APPSHEET_PENDING_TABLES,
  pendingMappingFingerprintPayload,
  reconcileAppSheetPendingRows,
  type AppSheetPendingDimension,
  type AppSheetPendingReconciliation,
  type AppSheetPendingSourceRecord,
} from "../../shared/operations/appsheet-pending.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { formatCellData, loadAppSheetHistoryCapture } from "./appsheet-history.js";

const PRIMARY_KEYS: Readonly<Record<string, string>> = {
  Pre_Venta: "Id_Preventa",
  Pre_Detalle_Fact: "Id_Pre_Detalle",
  C_Facturacion: "Id_Factura",
  C_Detalle_Fact: "Id_Detalle",
  C_Moto: "Id_Moto",
  C_Mercaderia: "ID_Mercaderia",
  Movimiento_Nueva: "ID_Movimiento_Unique",
  Movimiento: "ID_Movimiento",
  O_Ruta: "Ruta_ID",
};

export class AppSheetPendingPreviewError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AppSheetPendingPreviewError";
  }
}

export interface AppSheetPendingPreviewRecord {
  sourceTable: string;
  sourceRow: number;
  reconciliation: AppSheetPendingReconciliation;
}

export interface AppSheetPendingPreviewSummary {
  schemaVersion: typeof APPSHEET_PENDING_SCHEMA_VERSION;
  mappingId: typeof APPSHEET_PENDING_MAPPING_ID;
  mappingHash: string;
  capture: {
    captureId: string;
    manifestHash: string;
    mode: "stable" | "preliminary-delta";
    provisional: boolean;
    pages: number;
    sheets: number;
    sourceRows: number;
  };
  rowCount: number;
  candidateRowCount: number;
  needsReviewRowCount: number;
  statusCounts: Record<string, Record<string, number>>;
  tableCounts: Record<string, number>;
}

export interface AppSheetPendingPreview {
  summary: AppSheetPendingPreviewSummary;
  records: AppSheetPendingPreviewRecord[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseNumberFormat(original: unknown): string | null {
  if (!original || typeof original !== "object" || Array.isArray(original)) return null;
  const value = original as { userEnteredFormat?: { numberFormat?: { pattern?: unknown } } };
  return typeof value.userEnteredFormat?.numberFormat?.pattern === "string" ? value.userEnteredFormat.numberFormat.pattern : null;
}

function sourceKey(table: string, values: Record<string, string | null>, duplicateFields: readonly string[], sourceRow: number): string {
  const field = PRIMARY_KEYS[table];
  if (!field || duplicateFields.includes(field)) return `synthetic:${table}:${sourceRow}`;
  const value = values[field];
  return value && value.trim() ? value : `synthetic:${table}:${sourceRow}`;
}

type PendingCaptureRow = {
  sourceRow: number;
  cells: Array<Parameters<typeof formatCellData>[0]>;
  unresolvedFormulaCells: Array<string | number>;
};

function hasSourceEvidence(row: PendingCaptureRow): boolean {
  if (row.unresolvedFormulaCells.length > 0) return true;
  return row.cells.some(cell => {
    const entered = cell.userEnteredValue;
    const effective = cell.effectiveValue;
    const enteredText = entered?.stringValue;
    const effectiveText = effective?.stringValue;
    return (typeof entered?.formulaValue === "string" && entered.formulaValue !== "") ||
      (typeof enteredText === "string" && enteredText.trim() !== "") ||
      entered?.numberValue !== undefined || entered?.boolValue !== undefined ||
      Boolean(effective?.errorValue) || effective?.numberValue !== undefined || effective?.boolValue !== undefined ||
      (typeof effectiveText === "string" && effectiveText.trim() !== "");
  });
}

function sourceRecordFromCapture(input: {
  table: string;
  row: PendingCaptureRow;
  headerColumns: Array<{ columnIndex: number; header: string | null }>;
}): AppSheetPendingSourceRecord | null {
  const { table, row, headerColumns } = input;
  if (!hasSourceEvidence(row)) return null;
  const headersByIndex = new Map(headerColumns.map(column => [column.columnIndex, column.header]));
  const formatted = row.cells.map(cell => formatCellData(cell, row.sourceRow, headersByIndex.get(cell.columnIndex) ?? null));
  const grouped = new Map<string, typeof formatted>();
  const unresolved = new Set<string>();
  const unresolvedCoordinates = new Set(row.unresolvedFormulaCells.map(String));
  const columnIndexByCoordinate = new Map(formatted.map((cell, index) => [cell.coordinate, row.cells[index]!.columnIndex]));
  const headerCounts = new Map<string, number>();
  const values: Record<string, string | null> = {};
  for (const column of headerColumns) {
    if (column.header === null) continue;
    headerCounts.set(column.header, (headerCounts.get(column.header) ?? 0) + 1);
    values[column.header] = null;
  }
  const duplicateFields = [...headerCounts].filter(([, count]) => count > 1).map(([header]) => header);
  for (const cell of formatted) {
    const header = cell.normalized.header;
    if (header === null) continue;
    const group = grouped.get(header) ?? [];
    group.push(cell);
    grouped.set(header, group);
    const columnIndex = columnIndexByCoordinate.get(cell.coordinate);
    if (unresolvedCoordinates.has(cell.coordinate) || (columnIndex !== undefined && unresolvedCoordinates.has(String(columnIndex))) ||
        cell.effective.kind === "error" || (cell.formula !== null && cell.effective.kind === "missing"))
      unresolved.add(header);
  }
  for (const [header, cells] of grouped) {
    if (cells.length !== 1 || duplicateFields.includes(header)) {
      if (!duplicateFields.includes(header)) duplicateFields.push(header);
      values[header] = null;
    } else values[header] = cells[0]!.normalized.value;
  }
  const key = sourceKey(table, values, duplicateFields, row.sourceRow);
  const original = { columns: formatted.map(cell => ({
    coordinate: cell.coordinate,
    header: cell.normalized.header,
    numberFormat: parseNumberFormat(cell.original),
    value: cell.original,
  })) };
  const normalizedColumns = formatted.map(cell => cell.normalized);
  const sourceEvidenceHash = sha256(canonicalJson({ sourceTable: table, sourceRow: row.sourceRow, sourceKey: key, original, normalizedColumns }));
  return {
    sourceTable: table,
    sourceRow: row.sourceRow,
    sourceKey: key,
    sourceEvidenceHash,
    values,
    duplicateFields,
    unresolvedFields: [...unresolved],
  };
}

function makeSummary(input: {
  records: AppSheetPendingPreviewRecord[];
  capture: AppSheetPendingPreviewSummary["capture"];
  mappingHash: string;
}): AppSheetPendingPreviewSummary {
  const statusCounts: Record<string, Record<string, number>> = {
    preSale: {}, receivable: {}, unpaidPurchase: {}, delivery: {},
  };
  const tableCounts: Record<string, number> = {};
  let candidateRowCount = 0;
  let needsReviewRowCount = 0;
  for (const record of input.records) {
    tableCounts[record.sourceTable] = (tableCounts[record.sourceTable] ?? 0) + 1;
    let hasCandidate = false;
    let hasReview = false;
    for (const [name, classification] of Object.entries(record.reconciliation.dimensions)) {
      const counts = statusCounts[name] ?? (statusCounts[name] = {});
      counts[classification.status] = (counts[classification.status] ?? 0) + 1;
      hasCandidate ||= classification.status === "confirmed_pending";
      hasReview ||= classification.status === "needs_review";
    }
    if (hasCandidate) candidateRowCount++;
    if (hasReview) needsReviewRowCount++;
  }
  return {
    schemaVersion: APPSHEET_PENDING_SCHEMA_VERSION,
    mappingId: APPSHEET_PENDING_MAPPING_ID,
    mappingHash: input.mappingHash,
    capture: input.capture,
    rowCount: input.records.length,
    candidateRowCount,
    needsReviewRowCount,
    statusCounts,
    tableCounts,
  };
}

/**
 * Builds a read-only, database-free preview from a validated private capture.
 * It does not post, stage, settle, dispatch, or approve any operation.
 */
export async function prepareAppSheetPendingPreview(
  directory: string,
  options: { allowStagedDelta?: boolean } = {},
): Promise<AppSheetPendingPreview> {
  const capture = await loadAppSheetHistoryCapture(directory, { allowStagedDelta: options.allowStagedDelta === true });
  const headerSheets = new Map(capture.headers.sheets.map(sheet => [sheet.title, sheet]));
  const rawRows: AppSheetPendingSourceRecord[] = [];
  for (const page of capture.pages) {
    if (!APPSHEET_PENDING_TABLES.includes(page.sheet.title as (typeof APPSHEET_PENDING_TABLES)[number])) continue;
    const headerSheet = headerSheets.get(page.sheet.title);
    if (!headerSheet) throw new AppSheetPendingPreviewError("capture_headers_missing_for_table");
    for (const row of page.rows) {
      const sourceRecord = sourceRecordFromCapture({ table: page.sheet.title, row, headerColumns: headerSheet.columns });
      if (sourceRecord !== null) rawRows.push(sourceRecord);
    }
  }
  const mappingHash = sha256(pendingMappingFingerprintPayload());
  const classified = reconcileAppSheetPendingRows(rawRows, {
    captureId: capture.manifest.captureId,
    manifestHash: capture.manifest.manifestHash,
    mode: capture.mode,
    mappingHash,
  }, sha256);
  const records = classified.map(({ sourceTable, sourceRow, reconciliation }) => ({ sourceTable, sourceRow, reconciliation }));
  const summary = makeSummary({
    records,
    mappingHash,
    capture: {
      captureId: capture.manifest.captureId,
      manifestHash: capture.manifest.manifestHash,
      mode: capture.mode,
      provisional: capture.mode !== "stable",
      pages: capture.manifest.dataPageCount,
      sheets: capture.manifest.dataSheetCount,
      sourceRows: capture.manifest.dataRecordCount,
    },
  });
  return { summary, records };
}

/** Save only hashed reconciliation evidence inside a private capture directory. */
export async function writeAppSheetPendingPreviewPrivate(preview: AppSheetPendingPreview, outputPath: string, captureDirectory: string): Promise<void> {
  const output = resolve(outputPath);
  const captureRoot = resolve(captureDirectory);
  const relativePath = relative(captureRoot, output);
  if (!isAbsolute(outputPath) || relativePath === "" || relativePath.startsWith("..") || relativePath.includes("/") || relativePath.includes("\\"))
    throw new AppSheetPendingPreviewError("preview_output_must_be_inside_capture_directory");
  const temporaryPath = `${output}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(output), { recursive: false, mode: 0o700 }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ mapping: APPSHEET_PENDING_MAPPING_SPEC, ...preview }, null, 2)}\n`, "utf8");
    await file.sync();
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    await file.close();
    await rename(temporaryPath, output);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
