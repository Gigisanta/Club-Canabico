import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Prisma, type LegacyHistoricalFact, type LegacySourceRecord, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  APPSHEET_HISTORY_IMPORTER_VERSION,
  APPSHEET_HISTORY_MAPPING_ID,
  APPSHEET_HISTORY_MAX_CAPTURE_BYTES,
  APPSHEET_HISTORY_MAX_PAGE_BYTES,
  APPSHEET_HISTORY_MAX_RECORDS,
  APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS,
  APPSHEET_HISTORY_SOURCE_SYSTEM,
  APPSHEET_HISTORY_TABLE_NAMES,
  appSheetHistoryRule,
  normalizeAppSheetHistoryHeader,
} from "../../shared/operations/appsheet-history.js";
import { canonicalJson, parseMoney } from "../../shared/operations/exact.js";
import { appSheetTechnicalReviewSchema, requireAppSheetTechnicalReview } from "../../shared/operations/appsheet-review.js";
import { APPSHEET_MASTER_KEY_FIELDS, appSheetCellEffectiveValue, appSheetCellFormula, prepareAppSheetCaptureManifest,
  prepareAppSheetProjectionCaptureManifest, type PreparedAppSheetCaptureManifest } from "../../shared/operations/appsheet-canonical.js";
import { appSheetPendingReconciliationSchema, APPSHEET_PENDING_TABLES, pendingMappingFingerprintPayload,
  reconcileAppSheetPendingRows, type AppSheetPendingSourceRecord } from "../../shared/operations/appsheet-pending.js";
import type { AppSheetDefinitionInventory } from "../../shared/operations/appsheet-definition.js";
import { APPSHEET_EXPECTED_LIVE_APP_ID, appSheetAppliedDefinitionHash, ensureAppSheetCaptureManifest,
  prepareAppSheetDefinitionInventory } from "./appsheet-canonical.js";
import { legacyPayloadHash } from "./legacy-upload-contract.js";
import { containsRecognizableCredential, isCredentialBearingHeader } from "./legacy-reader.js";
import { sourceRecordSchema } from "./legacy-source-contract.js";
import { verifyBackupReference } from "./financial-source-stage.js";
import { capabilitiesFromGrant } from "./access-snapshot.js";

const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_HEADERS_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_CELL_COUNT = 512;
const MAX_SAFE_ROW_NUMBER = 100_000;
const ACTOR = "codex:appsheet-history-stage";
const STAGE_ACTION = "legacy.appsheet_history_staged";
const PAGE_SCHEMA = "appsheet-sheet-page/v1";
const HEADER_SCHEMA = "appsheet-sheet-headers/v1";
const MANIFEST_SCHEMA = "appsheet-capture-manifest/v1";

type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
type EffectiveValue =
  | { kind: "missing" }
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; value: { type: string; message: string } };
type CellData = {
  columnIndex: number;
  userEnteredValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; formulaValue?: string };
  effectiveValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; errorValue?: { type: string; message: string } };
  userEnteredFormat?: { numberFormat?: { type?: string; pattern?: string } };
  dataValidation?: JSONValue;
};
type HeaderColumn = { columnIndex: number; header: string | null; sensitive: boolean };
type CapturePage = {
  schemaVersion: typeof PAGE_SCHEMA;
  spreadsheetId: string;
  sourceSystem: string;
  sheet: { sheetId: number; title: string; mode: string; hidden?: boolean; headerRow: number | null; gridRows: number; gridColumns: number };
  page: { index: number; startRow: number; endRow: number; a1Ranges: string[]; safeColumnIndexes: number[]; omittedColumnIndexes: number[]; cellFields: string };
  rows: { sourceRow: number; cells: CellData[]; unresolvedFormulaCells: (string | number)[]; rowHash: string }[];
  counts: Record<string, number>;
  pageHash: string;
};
type PageRef = { path: string; sheetId: number; title: string; pageIndex: number; startRow: number; endRow: number;
  pageHash: string; verifiedPageHash: string; stable: boolean; counts: Record<string, number>; [key: string]: unknown };
type CaptureManifest = {
  schemaVersion: typeof MANIFEST_SCHEMA;
  captureId: string;
  sourceSystem: string;
  sourceId: string;
  spreadsheetId: string;
  manifestHash: string;
  dataHash: string;
  metadataHash: string;
  headersHash: string;
  definitionHash: string | null;
  timestamps: { firstReadAt: string | null; verificationStartedAt: string | null; verificationCompletedAt: string | null; cutoffAt: string | null; [key: string]: unknown };
  firstReadAt: string;
  verificationStartedAt: string | null;
  verificationCompletedAt: string | null;
  cutoffAt: string | null;
  timestampGaps: string[];
  stability: Record<string, JSONValue>;
  coverage: { sheets: Record<string, JSONValue>[]; [key: string]: JSONValue };
  pages: PageRef[];
  evidence: { verificationPass2: { path: string; sha256: string }; deltaAnalysis?: { path: string; sha256: string }; [key: string]: unknown };
  hashContract: Record<string, unknown>;
  captureNotes?: string[];
  dataSheetCount: number;
  dataPageCount: number;
  dataRecordCount: number;
  dataFormulaCount: number;
  dataUnresolvedFormulaCount: number;
  definitionCoverage: JSONValue | null;
  definitionTableCount: number | null;
  definitionColumnCount: number | null;
  definitionSliceCount: number | null;
  definitionViewCount: number | null;
  definitionActionCount: number | null;
  definitionBotCount: number | null;
  definitionWorkflowRuleCount: number | null;
  definitionFormatRuleCount: number | null;
};
type HeadersFile = {
  schemaVersion: typeof HEADER_SCHEMA;
  spreadsheetId: string;
  sheets: { sheetId: number; title: string; mode: string; hidden: boolean; headerRow: number | null; gridRows: number; gridColumns: number;
    columns: HeaderColumn[]; pageCount?: number; safeColumnIndexes?: number[]; omittedColumnIndexes?: number[]; bodyExcluded?: boolean;
    [key: string]: unknown }[];
};
type MetadataFile = { schemaVersion: string; sourceSystem: string; spreadsheet: Record<string, JSONValue> };
type NormalizedColumn = { coordinate: string; header: string | null; value: string | null; exactDecimal?: string; moneyMinorUnits?: string };
type FormattedCell = { coordinate: string; original: JSONValue; normalized: NormalizedColumn; effective: EffectiveValue; formula: string | null };
type SourceException = { kind: string; severity: "review" | "blocking"; evidence: Record<string, string | number | boolean | null> };
type PreparedRecord = {
  id: string; snapshotId: string; sourceTable: string; sourceKey: string; sourceRow: number; fileHash: string; contentHash: string;
  importerVersion: string; original: { columns: { coordinate: string; header: string | null; numberFormat?: string | null; value: JSONValue }[] };
  normalized: { columns: NormalizedColumn[]; overlapEvidence?: { targetTable: "Movimiento_Nueva"; targetSourceRow: number | null;
    status: "exact_legacy_fields" | "different_legacy_fields" | "missing_reference" | "ambiguous_reference" | "comparison_incomplete"; comparedFields: number };
    pendingReconciliation?: Record<string, unknown> };
  treatment: "fact_candidate" | "archive_only" | "overlap_evidence"; exceptions: SourceException[];
  formatted: Map<string, FormattedCell[]>; unresolvedFormulaFields: string[]; ruleKind: string; relationshipData: Record<string, JSONValue>[];
};
type PreparedFact = {
  id: string; snapshotId: string; sourceRecordId: string; sourceTable: string; sourceKey: string; sourceRow: number; sourceHash: string;
  mappingId: string; kind: string; occurredOn: string | null; dateState: "known" | "absent" | "invalid" | "not-applicable";
  currency: string | null; currencyState: "known" | "absent" | "invalid" | "not-applicable"; unit: string | null;
  unitState: "known" | "absent" | "invalid" | "not-applicable"; amountMinor: bigint | null;
  amountState: "known" | "absent" | "invalid" | "not-applicable"; quantity: Prisma.Decimal | null;
  quantityState: "known" | "absent" | "invalid" | "not-applicable"; attributes: Prisma.InputJsonValue; createdBy: string;
};
type PersistedException = { id: string; sourceRecordId: string | null; kind: string; severity: "review" | "blocking"; description: string; resolution: Prisma.InputJsonValue | null };
type DeltaPageEvidence = {
  sheetId: number; title: string; pageIndex: number; startRow: number; endRow: number; pass1Path: string;
  pass1Hash: string; pass2Hash: string; pass3Hash: string; pass3EqualsPass2Hash: boolean;
  changedRows: number; changedCells: number; userEnteredValueChangedCells: number; effectiveValueChangedCells: number;
  numberFormatChangedCells: number; dataValidationChangedCells: number;
};

const headerColumnSchema = z.object({ columnIndex: z.number().int().positive().max(MAX_SOURCE_CELL_COUNT), header: z.string().nullable(), sensitive: z.boolean() }).passthrough();
const countsSchema = z.record(z.string(), z.number().int().min(0).max(10_000_000));
const pageRefSchema = z.object({ path: z.string().regex(/^pages\/[0-9]+-[0-9]+-[0-9]+\.json$/), sheetId: z.number().int().nonnegative(),
  title: z.string().min(1), pageIndex: z.number().int().nonnegative(), startRow: z.number().int().positive(), endRow: z.number().int().positive(),
  pageHash: HASH, verifiedPageHash: HASH, stable: z.boolean(), counts: countsSchema }).passthrough();
const manifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA), captureId: z.string().min(1).max(128), sourceSystem: z.string().min(1).max(120), sourceId: z.string().min(1).max(180),
  spreadsheetId: z.string().min(1).max(256), manifestHash: HASH, dataHash: HASH, metadataHash: HASH, headersHash: HASH,
  definitionHash: HASH.nullable(), timestamps: z.object({ firstReadAt: z.iso.datetime({ offset: true }).nullable(),
    verificationStartedAt: z.iso.datetime({ offset: true }).nullable(), verificationCompletedAt: z.iso.datetime({ offset: true }).nullable(),
    cutoffAt: z.iso.datetime({ offset: true }).nullable() }).passthrough(), timestampGaps: z.array(z.string().max(2_000)),
  stability: z.record(z.string(), z.unknown()), coverage: z.strictObject({ sheets: z.array(z.record(z.string(), z.unknown())) }).passthrough(),
  pages: z.array(pageRefSchema).max(2_000), evidence: z.object({ verificationPass2: z.object({ path: z.string(), sha256: HASH }).passthrough(),
    deltaAnalysis: z.object({ path: z.string(), sha256: HASH }).passthrough().optional() }).passthrough(),
  hashContract: z.record(z.string(), z.unknown()), captureNotes: z.array(z.string()).optional(),
}).passthrough();
const headersSchema = z.object({ schemaVersion: z.literal(HEADER_SCHEMA), spreadsheetId: z.string().min(1), sheets: z.array(z.object({
  sheetId: z.number().int().nonnegative(), title: z.string().min(1), mode: z.string().min(1), hidden: z.boolean(), headerRow: z.number().int().positive().nullable(),
  gridRows: z.number().int().nonnegative(), gridColumns: z.number().int().nonnegative(), columns: z.array(headerColumnSchema).max(MAX_SOURCE_CELL_COUNT),
  pageCount: z.number().int().nonnegative().optional(), safeColumnIndexes: z.array(z.number().int().positive()).optional(),
  omittedColumnIndexes: z.array(z.number().int().positive()).optional(),
}).passthrough()).max(64) }).passthrough();
const cellSchema = z.object({ columnIndex: z.number().int().positive().max(MAX_SOURCE_CELL_COUNT),
  userEnteredValue: z.object({ stringValue: z.string().optional(), numberValue: z.number().finite().optional(), boolValue: z.boolean().optional(), formulaValue: z.string().optional() }).passthrough().optional(),
  effectiveValue: z.object({ stringValue: z.string().optional(), numberValue: z.number().finite().optional(), boolValue: z.boolean().optional(),
    errorValue: z.object({ type: z.string().max(120), message: z.string().max(4_096) }).passthrough().optional() }).passthrough().optional(),
  userEnteredFormat: z.object({ numberFormat: z.object({ type: z.string().optional(), pattern: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
  dataValidation: z.unknown().optional() }).passthrough();
const pageSchema = z.object({ schemaVersion: z.literal(PAGE_SCHEMA), spreadsheetId: z.string(), sourceSystem: z.string(),
  sheet: z.object({ sheetId: z.number().int().nonnegative(), title: z.string(), mode: z.string(), hidden: z.boolean().optional(), headerRow: z.number().int().positive().nullable(),
    gridRows: z.number().int().nonnegative(), gridColumns: z.number().int().nonnegative() }).passthrough(),
  page: z.object({ index: z.number().int().nonnegative(), startRow: z.number().int().positive(), endRow: z.number().int().positive(),
    a1Ranges: z.array(z.string()), safeColumnIndexes: z.array(z.number().int().positive()), omittedColumnIndexes: z.array(z.number().int().positive()), cellFields: z.string() }).passthrough(),
  rows: z.array(z.object({ sourceRow: z.number().int().positive().max(MAX_SAFE_ROW_NUMBER), cells: z.array(cellSchema).max(MAX_SOURCE_CELL_COUNT),
    unresolvedFormulaCells: z.array(z.union([z.string(), z.number().int().positive().max(MAX_SOURCE_CELL_COUNT)])).max(MAX_SOURCE_CELL_COUNT),
    rowHash: HASH }).passthrough()), counts: countsSchema, pageHash: HASH }).passthrough();

export class AppSheetHistoryStageError extends Error {
  constructor(readonly code: string, readonly metrics?: Record<string, string | number | boolean | null>) {
    super(code);
    this.name = "AppSheetHistoryStageError";
  }
}

function fail(code: string, metrics?: Record<string, string | number | boolean | null>): never {
  throw new AppSheetHistoryStageError(code, metrics);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Hash coverage counters without letting the exact-money serializer mistake counts for currency. */
export function appSheetHistoryCoverageFingerprint(coverage: Record<string, unknown>): string {
  const { exceptionTotal, ...rest } = coverage;
  if (typeof exceptionTotal !== "number" || !Number.isSafeInteger(exceptionTotal) || exceptionTotal < 0)
    fail("coverage_exception_count_invalid");
  // `canonicalJson` treats keys ending in "total" as exact monetary values.
  // Keep the public coverage contract intact and rename these counts only in the
  // fingerprint payload; no amount or exception data is discarded.
  const totals = rest.totals as Record<string, unknown> | undefined;
  const kindCounts = totals?.kindCounts as Record<string, unknown> | undefined;
  const { cash: rawCash, ...otherKinds } = kindCounts ?? {};
  const cash = rawCash === undefined ? 0 : rawCash;
  if (typeof cash !== "number" || !Number.isSafeInteger(cash) || cash < 0) fail("coverage_cash_fact_count_invalid");
  return digest({
    ...rest,
    totals: { ...totals, kindCounts: { ...otherKinds, cashFactCount: cash } },
    exceptionCount: exceptionTotal,
  });
}

function jsonValue(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function deterministicUuid(value: unknown): string {
  const bytes = Buffer.from(digest(value).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function columnName(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_SOURCE_CELL_COUNT) fail("capture_column_index_invalid");
  let current = index, result = "";
  while (current > 0) {
    current--;
    result = String.fromCharCode(65 + current % 26) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function columnIndexFromCoordinate(coordinate: string): number | null {
  const match = /^\$?([A-Z]+)\$?[1-9][0-9]*$/i.exec(coordinate);
  if (!match) return null;
  let index = 0;
  for (const character of match[1]!.toUpperCase()) index = index * 26 + character.charCodeAt(0) - 64;
  return Number.isInteger(index) && index > 0 && index <= MAX_SOURCE_CELL_COUNT ? index : null;
}

/** Convert a finite JS number to a plain decimal without rounding. */
function numberToExactDecimal(value: number): string | null {
  if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) return null;
  const lexeme = value.toString().toLowerCase();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(lexeme);
  if (!match) return null;
  const integer = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;
  const digits = integer + fraction;
  const point = integer.length + exponent;
  let expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (expanded.includes(".")) expanded = expanded.replace(/0+$/, "").replace(/\.$/, "");
  const [whole, decimal = ""] = expanded.split(".");
  const normalizedWhole = (whole || "0").replace(/^0+(?=\d)/, "");
  const normalized = `${match[1]}${normalizedWhole}${decimal ? `.${decimal}` : ""}`;
  return normalized === "-0" ? "0" : normalized;
}

function effectiveText(value: EffectiveValue): { text: string | null; exactDecimal?: string } {
  if (value.kind === "missing" || value.kind === "error") return { text: null };
  if (value.kind === "string") return { text: value.value };
  if (value.kind === "boolean") return { text: value.value ? "true" : "false" };
  const exactDecimal = numberToExactDecimal(value.value as number);
  return exactDecimal === null ? { text: null } : { text: exactDecimal, exactDecimal };
}

/**
 * Preserve the complete Sheets cell evidence while normalizing only the
 * captured effective result. Formula text is never evaluated or substituted.
 */
export function formatCellData(cell: CellData, sourceRow: number, header: string | null): FormattedCell {
  const effective = appSheetCellEffectiveValue(cell as never) as EffectiveValue;
  const formula = appSheetCellFormula(cell as never);
  const coordinate = `${columnName(cell.columnIndex)}${sourceRow}`;
  const text = effectiveText(effective);
  const original: JSONValue = {
    kind: "appsheet_cell",
    formula,
    userEnteredValue: cell.userEnteredValue ? jsonValue(cell.userEnteredValue) : null,
    effectiveValue: cell.effectiveValue ? jsonValue(cell.effectiveValue) : null,
    userEnteredFormat: cell.userEnteredFormat ? jsonValue(cell.userEnteredFormat) : null,
    dataValidation: cell.dataValidation === undefined ? null : jsonValue(cell.dataValidation),
  };
  const normalized: NormalizedColumn = { coordinate, header, value: text.text };
  if (text.exactDecimal !== undefined) normalized.exactDecimal = text.exactDecimal;
  return { coordinate, original, normalized, effective, formula };
}

function cellsByHeader(record: PreparedRecord, name: string | null): FormattedCell[] {
  if (name === null) return [];
  const wanted = normalizeAppSheetHistoryHeader(name);
  return [...record.formatted.entries()].filter(([header]) => normalizeAppSheetHistoryHeader(header) === wanted).flatMap(([, cells]) => cells);
}

function uniqueCell(record: PreparedRecord, name: string | null): FormattedCell | null {
  if (name === null) return null;
  const found = cellsByHeader(record, name);
  return found.length === 1 ? found[0]! : null;
}

function headerMatches(columns: readonly HeaderColumn[], name: string | null): HeaderColumn[] {
  if (name === null) return [];
  const wanted = normalizeAppSheetHistoryHeader(name);
  return columns.filter((column) => column.header !== null && normalizeAppSheetHistoryHeader(column.header) === wanted);
}

function effectiveCellValue(cell: FormattedCell | null): string | null {
  if (!cell || cell.effective.kind !== "string" && cell.effective.kind !== "number" && cell.effective.kind !== "boolean") return null;
  const value = effectiveText(cell.effective);
  return value.text === null ? null : value.text;
}

function a1DateFromSerial(serial: number): string | null {
  if (!Number.isFinite(serial) || Math.abs(serial) > 2_958_465) return null;
  const days = Math.floor(serial);
  const millis = Date.UTC(1899, 11, 30) + days * 86_400_000;
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseDateCell(cell: FormattedCell | null): { value: string | null; state: "known" | "absent" | "invalid" | "not-applicable" } {
  if (!cell) return { value: null, state: "absent" };
  const { effective } = cell;
  if (effective.kind === "missing") return { value: null, state: cell.formula ? "invalid" : "absent" };
  if (effective.kind === "error") return { value: null, state: "invalid" };
  if (effective.kind === "string") {
    const match = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(effective.value);
    if (!match || Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1])
      return { value: null, state: "invalid" };
    return { value: match[1]!, state: "known" };
  }
  const formatType = cell.original && typeof cell.original === "object" && !Array.isArray(cell.original)
    ? ((cell.original as { userEnteredFormat?: { numberFormat?: { type?: string } } }).userEnteredFormat?.numberFormat?.type ?? null) : null;
  if (effective.kind === "number" && (formatType === "DATE" || formatType === "DATE_TIME" || formatType === "DATE_TIME")) {
    const serialDate = a1DateFromSerial(effective.value as number);
    return serialDate ? { value: serialDate, state: "known" } : { value: null, state: "invalid" };
  }
  return { value: null, state: "invalid" };
}

function parseMoneyCell(cell: FormattedCell | null): { value: bigint | null; state: "known" | "absent" | "invalid" | "not-applicable" } {
  if (!cell) return { value: null, state: "absent" };
  if (cell.effective.kind === "missing") return { value: null, state: cell.formula ? "invalid" : "absent" };
  if (cell.effective.kind !== "number") return { value: null, state: "invalid" };
  const decimal = numberToExactDecimal(cell.effective.value as number);
  if (decimal === null) return { value: null, state: "invalid" };
  try {
    const minor = parseMoney(decimal);
    if (minor < -9_223_372_036_854_775_808n || minor > 9_223_372_036_854_775_807n) return { value: null, state: "invalid" };
    const normalized = cell.normalized;
    if (normalized.value === null) return { value: null, state: "invalid" };
    normalized.moneyMinorUnits = minor.toString();
    return { value: minor, state: "known" };
  } catch { return { value: null, state: "invalid" }; }
}

function parseQuantityCell(cell: FormattedCell | null): { value: Prisma.Decimal | null; state: "known" | "absent" | "invalid" | "not-applicable" } {
  if (!cell) return { value: null, state: "absent" };
  if (cell.effective.kind === "missing") return { value: null, state: cell.formula ? "invalid" : "absent" };
  if (cell.effective.kind !== "number") return { value: null, state: "invalid" };
  const decimal = numberToExactDecimal(cell.effective.value as number);
  if (decimal === null || !/^-?\d{1,26}(?:\.\d{1,12})?$/.test(decimal)) return { value: null, state: "invalid" };
  try { return { value: new Prisma.Decimal(decimal), state: "known" }; } catch { return { value: null, state: "invalid" }; }
}

function parseCurrencyCell(cell: FormattedCell | null): { value: string | null; state: "known" | "absent" | "invalid" | "not-applicable" } {
  if (!cell) return { value: null, state: "absent" };
  if (cell.effective.kind === "missing") return { value: null, state: cell.formula ? "invalid" : "absent" };
  if (cell.effective.kind !== "string") return { value: null, state: "invalid" };
  const value = cell.effective.value.trim().toUpperCase();
  return value === "ARS" || value === "USD" ? { value, state: "known" } : { value: null, state: "invalid" };
}

async function readPrivateJson(path: string, maxBytes: number, expectedName: string): Promise<unknown> {
  try {
    if (basename(path) !== expectedName) fail("capture_file_name_invalid");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || (info.mode & 0o077) !== 0) fail("capture_file_permissions_invalid");
    const bytes = await readFile(path);
    if (bytes.length > maxBytes) fail("capture_file_too_large");
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof AppSheetHistoryStageError) throw error;
    fail("capture_file_unavailable");
  }
}

function parseManifest(value: unknown): CaptureManifest {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) fail("capture_manifest_invalid");
  const raw = parsed.data;
  const coverage = raw.coverage as Record<string, unknown>;
  const sheets = Array.isArray(coverage.sheets) ? coverage.sheets as Record<string, JSONValue>[] : [];
  const timestampValues = raw.timestamps as CaptureManifest["timestamps"];
  const count = (value: unknown): number => Number.isSafeInteger(value) && typeof value === "number" && value >= 0 ? value : -1;
  const result = {
    ...raw,
    timestamps: timestampValues,
    firstReadAt: timestampValues.firstReadAt,
    verificationStartedAt: timestampValues.verificationStartedAt,
    verificationCompletedAt: timestampValues.verificationCompletedAt,
    cutoffAt: timestampValues.cutoffAt,
    timestampGaps: raw.timestampGaps,
    coverage: raw.coverage as CaptureManifest["coverage"],
    dataSheetCount: count(coverage.bodySheetsCaptured),
    dataPageCount: count(coverage.totalPages),
    dataRecordCount: 0,
    dataFormulaCount: count(coverage.formulaCellCount),
    dataUnresolvedFormulaCount: count(coverage.unresolvedFormulaCount),
    definitionCoverage: null,
    definitionTableCount: null,
    definitionColumnCount: null,
    definitionSliceCount: null,
    definitionViewCount: null,
    definitionActionCount: null,
    definitionBotCount: null,
    definitionWorkflowRuleCount: null,
    definitionFormatRuleCount: null,
  } as CaptureManifest;
  if (result.sourceId !== result.spreadsheetId || !result.firstReadAt || result.dataSheetCount < 0 || result.dataPageCount < 0 ||
      result.dataFormulaCount < 0 || result.dataUnresolvedFormulaCount < 0 || sheets.length === 0) fail("capture_manifest_aggregate_invalid");
  return result;
}

async function readCaptureArtifact(directory: string, relativePath: string, expectedHash: string | null, maxBytes: number): Promise<unknown> {
  const parts = relativePath.split("/");
  if (relativePath.startsWith("/") || parts.some((part) => !part || part === "." || part === "..") ||
      !["verification-pass2.json", "verification-pass3/delta-analysis.json"].includes(relativePath) &&
      !/^verification-pass3\/pages\/[0-9]+-[0-9]+-[0-9]+\.json$/.test(relativePath)) fail("capture_evidence_path_invalid");
  let parent = directory;
  for (const segment of parts.slice(0, -1)) {
    parent = join(parent, segment);
    const info = await lstat(parent).catch(() => null);
    if (!info || !info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail("capture_evidence_permissions_invalid");
  }
  const path = join(directory, relativePath);
  const info = await lstat(path).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.size > maxBytes || (info.mode & 0o077) !== 0)
    fail("capture_evidence_permissions_invalid");
  const bytes = await readFile(path);
  if (bytes.length !== info.size || bytes.length > maxBytes || (expectedHash !== null && createHash("sha256").update(bytes).digest("hex") !== expectedHash))
    fail("capture_evidence_hash_mismatch");
  try { return JSON.parse(bytes.toString("utf8")) as unknown; }
  catch { fail("capture_evidence_json_invalid"); }
}

function parseHeaders(value: unknown): HeadersFile {
  const parsed = headersSchema.safeParse(value);
  if (!parsed.success) fail("capture_headers_invalid", {
    issueCount: parsed.error.issues.length,
    firstIssuePath: parsed.error.issues[0]?.path.map(String).join(".").slice(0, 160) ?? "",
  });
  return parsed.data as HeadersFile;
}

function parsePage(value: unknown): CapturePage {
  const parsed = pageSchema.safeParse(value);
  if (!parsed.success) fail("capture_page_invalid", {
    issueCount: parsed.error.issues.length,
    firstIssues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.map(String).join(".")}:${issue.code}`).join("|").slice(0, 800),
  });
  return parsed.data as CapturePage;
}

function stableManifestHashInput(manifest: CaptureManifest): unknown {
  return {
    schemaVersion: MANIFEST_SCHEMA,
    sourceSystem: manifest.sourceSystem,
    sourceId: manifest.sourceId,
    spreadsheetId: manifest.spreadsheetId,
    metadataHash: manifest.metadataHash,
    headersHash: manifest.headersHash,
    dataHash: manifest.dataHash,
    definitionHash: manifest.definitionHash,
    stability: manifest.stability,
    coverage: manifest.coverage,
    pages: manifest.pages,
    evidence: manifest.evidence,
    hashContract: manifest.hashContract,
  };
}

const verificationEvidenceSchema = z.object({
  schemaVersion: z.literal("appsheet-sheet-verification/v1"),
  verifiedPages: z.number().int().nonnegative(),
  totalPagesExpected: z.number().int().nonnegative(),
  bodyPersisted: z.literal(false),
  pages: z.array(z.object({
    sheetId: z.number().int().nonnegative(), title: z.string(), pageIndex: z.number().int().nonnegative(), path: z.string(),
    pageHashFirst: HASH, pageHashVerified: HASH, stable: z.boolean(), counts: countsSchema,
  }).passthrough()),
  mismatches: z.array(z.object({ sheetId: z.number().int().nonnegative(), title: z.string(), pageIndex: z.number().int().nonnegative(),
    path: z.string(), pageHashFirst: HASH, pageHashVerified: HASH }).passthrough()),
}).passthrough();
const deltaEvidenceSchema = z.object({
  schemaVersion: z.literal("appsheet-sheet-delta-analysis/v1"),
  comparison: z.literal("pass1-page-cells-to-targeted-pass3-page-cells"),
  bodyPersistedForPass2: z.literal(false),
  pass2CellLevelComparisonPossible: z.literal(false),
  coverage: z.object({ pass1Pages: z.number().int().nonnegative(), pass2Pages: z.number().int().nonnegative(),
    pass2MismatchedPages: z.number().int().nonnegative(), pass3Pages: z.number().int().nonnegative(), missingPass2Pages: z.number().int().nonnegative() }).passthrough(),
  aggregate: z.object({ pageCount: z.number().int().nonnegative(), changedRows: z.number().int().nonnegative(), changedCells: z.number().int().nonnegative(),
    userEnteredValueChangedPages: z.number().int().nonnegative(), userEnteredValueChangedCells: z.number().int().nonnegative(),
    userEnteredValueChangedRows: z.number().int().nonnegative(), effectiveValueChangedCells: z.number().int().nonnegative(),
    effectiveValueOnlyPages: z.number().int().nonnegative(), effectiveValueOnlyCells: z.number().int().nonnegative(),
    effectiveValueOnlyRows: z.number().int().nonnegative(), numberFormatChangedCells: z.number().int().nonnegative(),
    dataValidationChangedCells: z.number().int().nonnegative(), pagesMatchingPass2Hash: z.number().int().nonnegative(),
    pagesChangedAgainAfterPass2: z.number().int().nonnegative(), pass3PagesMissingFromPass2: z.number().int().nonnegative() }).passthrough(),
  pages: z.array(z.object({ sheetId: z.number().int().nonnegative(), title: z.string(), pageIndex: z.number().int().nonnegative(),
    startRow: z.number().int().positive(), endRow: z.number().int().positive(), pass1Path: z.string(), pass1Hash: HASH, pass2Hash: HASH,
    pass3Path: z.string(), pass3Hash: HASH, pass3EqualsPass2Hash: z.boolean(), diffCounts: z.object({ changedRows: z.number().int().nonnegative(),
      changedCells: z.number().int().nonnegative(), userEnteredValueChangedCells: z.number().int().nonnegative(),
      effectiveValueChangedCells: z.number().int().nonnegative(), numberFormatChangedCells: z.number().int().nonnegative(),
      dataValidationChangedCells: z.number().int().nonnegative() }).passthrough() }).passthrough()),
}).passthrough();

async function validateCaptureEvidence(capture: LoadedAppSheetHistoryCapture): Promise<DeltaPageEvidence[]> {
  const { manifest, mode, directory } = capture;
  const rawVerification = await readCaptureArtifact(directory, manifest.evidence.verificationPass2.path, manifest.evidence.verificationPass2.sha256, MAX_MANIFEST_BYTES);
  const verificationParsed = verificationEvidenceSchema.safeParse(rawVerification);
  if (!verificationParsed.success) fail("capture_pass2_evidence_invalid");
  const verification = verificationParsed.data;
  const pass2ByPath = new Map(verification.pages.map((page) => [page.path, page]));
  const mismatchPaths: string[] = [];
  if (verification.verifiedPages !== manifest.pages.length || verification.totalPagesExpected !== manifest.pages.length ||
      verification.pages.length !== manifest.pages.length || verification.bodyPersisted !== false) fail("capture_pass2_coverage_incomplete");
  for (const ref of manifest.pages) {
    const pass2 = pass2ByPath.get(ref.path);
    if (!pass2 || pass2.sheetId !== ref.sheetId || pass2.title !== ref.title || pass2.pageIndex !== ref.pageIndex ||
        pass2.pageHashFirst !== ref.pageHash || pass2.pageHashVerified !== ref.verifiedPageHash || pass2.stable !== ref.stable)
      fail("capture_pass2_page_mismatch");
    if (!ref.stable) mismatchPaths.push(ref.path);
  }
  if (verification.mismatches.length !== mismatchPaths.length ||
      verification.mismatches.some((item) => !mismatchPaths.includes(item.path)) || new Set(verification.mismatches.map((item) => item.path)).size !== mismatchPaths.length)
    fail("capture_pass2_delta_set_mismatch");

  if (mode === "stable") {
    if (mismatchPaths.length !== 0 || manifest.evidence.deltaAnalysis) fail("capture_stable_evidence_conflict");
    return [];
  }
  const evidence = manifest.evidence.deltaAnalysis;
  if (!evidence) fail("capture_delta_analysis_missing");
  const rawDelta = await readCaptureArtifact(directory, evidence.path, evidence.sha256, MAX_MANIFEST_BYTES);
  const deltaParsed = deltaEvidenceSchema.safeParse(rawDelta);
  if (!deltaParsed.success) fail("capture_delta_analysis_invalid");
  const delta = deltaParsed.data;
  const changedRefs = manifest.pages.filter((page) => !page.stable);
  const deltaPages = new Map(delta.pages.map((page) => [page.pass1Path, page]));
  if (delta.coverage.pass1Pages !== manifest.pages.length || delta.coverage.pass2Pages !== manifest.pages.length ||
      delta.coverage.pass2MismatchedPages !== changedRefs.length || delta.coverage.pass3Pages !== changedRefs.length ||
      delta.coverage.missingPass2Pages !== 0 || delta.pages.length !== changedRefs.length || delta.aggregate.pageCount !== changedRefs.length ||
      delta.aggregate.pagesMatchingPass2Hash + delta.aggregate.pagesChangedAgainAfterPass2 !== changedRefs.length ||
      delta.aggregate.pass3PagesMissingFromPass2 !== 0 || delta.aggregate.effectiveValueChangedCells > delta.aggregate.changedCells)
    fail("capture_delta_analysis_coverage_mismatch");
  const summaries: DeltaPageEvidence[] = [];
  for (const ref of changedRefs) {
    const page = deltaPages.get(ref.path);
    const pass2 = pass2ByPath.get(ref.path)!;
    if (!page || page.sheetId !== ref.sheetId || page.title !== ref.title || page.pageIndex !== ref.pageIndex ||
        page.startRow !== ref.startRow || page.endRow !== ref.endRow || page.pass1Hash !== ref.pageHash || page.pass2Hash !== ref.verifiedPageHash ||
        page.pass3EqualsPass2Hash !== (page.pass3Hash === page.pass2Hash) || page.pass2Hash !== pass2.pageHashVerified ||
        !/^verification-pass3\/pages\/[0-9]+-[0-9]+-[0-9]+\.json$/.test(page.pass3Path)) fail("capture_delta_page_mismatch");
    const pass3Raw = await readCaptureArtifact(directory, page.pass3Path, null, APPSHEET_HISTORY_MAX_PAGE_BYTES).catch((error) => {
      if (error instanceof AppSheetHistoryStageError) throw error;
      fail("capture_pass3_page_unavailable");
    });
    const pass3 = parsePage(pass3Raw);
    if (pass3.page.index !== ref.pageIndex || pass3.sheet.sheetId !== ref.sheetId || pass3.page.startRow !== ref.startRow ||
        pass3.page.endRow !== ref.endRow || digest(pageHashInput(pass3)) !== page.pass3Hash)
      fail("capture_pass3_page_hash_mismatch");
    summaries.push({
      sheetId: page.sheetId, title: page.title, pageIndex: page.pageIndex, startRow: page.startRow, endRow: page.endRow,
      pass1Path: page.pass1Path, pass1Hash: page.pass1Hash, pass2Hash: page.pass2Hash, pass3Hash: page.pass3Hash,
      pass3EqualsPass2Hash: page.pass3EqualsPass2Hash, changedRows: page.diffCounts.changedRows, changedCells: page.diffCounts.changedCells,
      userEnteredValueChangedCells: page.diffCounts.userEnteredValueChangedCells, effectiveValueChangedCells: page.diffCounts.effectiveValueChangedCells,
      numberFormatChangedCells: page.diffCounts.numberFormatChangedCells, dataValidationChangedCells: page.diffCounts.dataValidationChangedCells,
    });
  }
  return summaries;
}

function pageHashInput(page: CapturePage): unknown {
  const { pageHash: _pageHash, ...body } = page;
  return body;
}

export type CaptureMode = "stable" | "preliminary-delta";

function numericStabilityField(stability: Record<string, JSONValue>, name: string): number | null {
  const value = stability[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function validateCaptureStability(manifest: CaptureManifest, allowStagedDelta: boolean): CaptureMode {
  const stability = manifest.stability;
  const stablePageCount = manifest.pages.filter((page) => page.stable && page.pageHash === page.verifiedPageHash).length;
  const changedPageCount = manifest.pages.length - stablePageCount;
  const firstRead = Date.parse(manifest.firstReadAt);
  const verificationStarted = manifest.verificationStartedAt === null ? null : Date.parse(manifest.verificationStartedAt);
  const verificationCompleted = manifest.verificationCompletedAt === null ? null : Date.parse(manifest.verificationCompletedAt);
  if (!Number.isFinite(firstRead) || (verificationStarted !== null && (!Number.isFinite(verificationStarted) || verificationStarted < firstRead)) ||
      (verificationCompleted !== null && (verificationStarted === null || !Number.isFinite(verificationCompleted) || verificationCompleted < verificationStarted)))
    fail("capture_stability_timestamps_invalid");

  if (stability.stable === true) {
    const cutoff = manifest.cutoffAt ? Date.parse(manifest.cutoffAt) : Number.NaN;
    if (!Number.isFinite(cutoff) || verificationCompleted === null || cutoff < verificationCompleted || stability.metadataStable !== true ||
        stability.headersStable !== true || stability.pageHashesStable !== true || stability.scanComplete !== true || changedPageCount !== 0 ||
        manifest.pages.some((page) => !page.stable || page.pageHash !== page.verifiedPageHash))
      fail("capture_stability_incomplete");
    return "stable";
  }

  if (!allowStagedDelta) fail("capture_stability_incomplete");
  if (manifest.cutoffAt !== null || stability.stable !== false || stability.metadataStable !== true || stability.headersStable !== true ||
      stability.pageHashesStable !== false || stability.scanComplete !== true || changedPageCount === 0 ||
      manifest.timestampGaps.length === 0 ||
      numericStabilityField(stability, "firstPassPages") !== manifest.pages.length ||
      numericStabilityField(stability, "verifiedPages") !== manifest.pages.length ||
      numericStabilityField(stability, "matchedPages") !== stablePageCount ||
      numericStabilityField(stability, "changedPages") !== changedPageCount ||
      numericStabilityField(stability, "failedPages") !== 0 ||
      manifest.pages.some((page) => page.stable !== (page.pageHash === page.verifiedPageHash)))
    fail("capture_delta_evidence_incomplete");
  return "preliminary-delta";
}

function validateManifestHashes(manifest: CaptureManifest, metadata: MetadataFile, headers: HeadersFile, pages: readonly CapturePage[], mode: CaptureMode): void {
  if (metadata.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || manifest.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM ||
      headers.spreadsheetId !== manifest.spreadsheetId || metadata.spreadsheet?.spreadsheetId !== manifest.spreadsheetId ||
      manifest.sourceId !== manifest.spreadsheetId)
    fail("capture_identity_mismatch");
  if (digest(metadata.spreadsheet) !== manifest.metadataHash ||
      digest({ schemaVersion: HEADER_SCHEMA, spreadsheetId: headers.spreadsheetId, sheets: headers.sheets }) !== manifest.headersHash)
    fail("capture_metadata_hash_mismatch");

  if (pages.length !== manifest.pages.length) fail("capture_page_set_mismatch");
  const orderedHeaderSheets = headers.sheets;
  const sheetOrder = new Map(orderedHeaderSheets.map((sheet, index) => [sheet.sheetId, index]));
  const orderedRefs = [...manifest.pages].sort((a, b) => (sheetOrder.get(a.sheetId) ?? Number.MAX_SAFE_INTEGER) - (sheetOrder.get(b.sheetId) ?? Number.MAX_SAFE_INTEGER) || a.pageIndex - b.pageIndex);
  if (canonicalJson(orderedRefs) !== canonicalJson(manifest.pages)) fail("capture_page_order_invalid");

  const actualRefs: PageRef[] = [];
  let observedFormulaCount = 0;
  let observedUnresolvedFormulaCount = 0;
  let observedPopulatedRowCount = 0;
  let observedSourceRecordCount = 0;
  let populatedHeaderRowCount = 0;
  for (const ref of manifest.pages) {
    const page = pages.find((candidate) => candidate.page.index === ref.pageIndex && candidate.sheet.sheetId === ref.sheetId &&
      `${candidate.page.startRow}-${candidate.page.endRow}` === `${ref.startRow}-${ref.endRow}`);
    if (!page || page.sheet.title !== ref.title || page.pageHash !== ref.pageHash || page.sheet.sheetId !== ref.sheetId || page.spreadsheetId !== manifest.spreadsheetId ||
        page.sourceSystem !== manifest.sourceSystem || digest(pageHashInput(page)) !== page.pageHash)
      fail("capture_page_hash_mismatch");
    const headerSheet = headers.sheets.find((sheet) => sheet.sheetId === page.sheet.sheetId);
    if (!headerSheet || headerSheet.bodyExcluded === true || headerSheet.title !== page.sheet.title || headerSheet.mode !== page.sheet.mode ||
        headerSheet.headerRow !== page.sheet.headerRow || headerSheet.gridRows !== page.sheet.gridRows || headerSheet.gridColumns !== page.sheet.gridColumns)
      fail("capture_sheet_metadata_mismatch");
    if (page.sheet.hidden !== undefined && page.sheet.hidden !== headerSheet.hidden) fail("capture_sheet_metadata_mismatch");
    if (ref.stable !== (ref.pageHash === ref.verifiedPageHash) || (mode === "stable" && !ref.stable)) fail("capture_page_stability_mismatch");
    if (page.rows.length !== page.counts.rowsSerialized || page.rows.length !== page.page.endRow - page.page.startRow + 1 ||
        page.page.startRow !== ref.startRow || page.page.endRow !== ref.endRow)
      fail("capture_page_row_coverage_mismatch");
    const rowNumbers = new Set<number>();
    for (const row of page.rows) {
      if (row.sourceRow < page.page.startRow || row.sourceRow > page.page.endRow || rowNumbers.has(row.sourceRow)) fail("capture_page_row_identity_invalid");
      rowNumbers.add(row.sourceRow);
      if (digest({ sourceRow: row.sourceRow, cells: row.cells, unresolvedFormulaCells: row.unresolvedFormulaCells, safeColumnIndexes: page.page.safeColumnIndexes }) !== row.rowHash)
        fail("capture_row_hash_mismatch");
      if (new Set(row.cells.map((cell) => cell.columnIndex)).size !== row.cells.length) fail("capture_duplicate_cell_index");
      const safeColumns = new Set(page.page.safeColumnIndexes);
      if (row.cells.some((cell) => !safeColumns.has(cell.columnIndex))) fail("capture_unsafe_cell_column");
      if (row.cells.some(populatedCell)) {
        observedPopulatedRowCount++;
        if (row.sourceRow === headerSheet.headerRow) populatedHeaderRowCount++;
        else observedSourceRecordCount++;
      }
    }
    if (rowNumbers.size !== page.page.endRow - page.page.startRow + 1) fail("capture_page_row_coverage_mismatch");
    observedFormulaCount += page.counts.formulaCellCount ?? 0;
    observedUnresolvedFormulaCount += page.counts.unresolvedFormulaCount ?? 0;
    actualRefs.push({ path: ref.path, sheetId: ref.sheetId, pageIndex: ref.pageIndex, startRow: ref.startRow, endRow: ref.endRow, pageHash: page.pageHash, counts: page.counts } as PageRef);
  }
  const dataHash = digest(actualRefs.map(({ path, sheetId, pageIndex, startRow, endRow, pageHash, counts }) => ({ path, sheetId, pageIndex, startRow, endRow, pageHash, counts })));
  const coveredSheets = manifest.coverage.sheets;
  const bodySheets = headers.sheets.filter((sheet) => sheet.bodyExcluded !== true);
  const coveredBySheet = new Map(coveredSheets.map((item) => [item.sheetId, item]));
  for (const sheet of bodySheets) {
    const count = coveredBySheet.get(sheet.sheetId);
    const pagesForSheet = manifest.pages.filter((ref) => ref.sheetId === sheet.sheetId);
    if (!count || sheet.pageCount === undefined || sheet.safeColumnIndexes === undefined || sheet.omittedColumnIndexes === undefined ||
        count.title !== sheet.title || count.hidden !== sheet.hidden || count.mode !== sheet.mode ||
        count.pageCount !== sheet.pageCount || pagesForSheet.length !== sheet.pageCount) fail("capture_sheet_coverage_mismatch");
  }
  const coverage = manifest.coverage as Record<string, unknown>;
  if (dataHash !== manifest.dataHash || observedFormulaCount !== manifest.dataFormulaCount ||
      observedUnresolvedFormulaCount !== manifest.dataUnresolvedFormulaCount || manifest.dataPageCount !== pages.length ||
      manifest.dataSheetCount !== bodySheets.length || observedPopulatedRowCount !== coverage.rowsWithValues ||
      observedSourceRecordCount !== observedPopulatedRowCount - populatedHeaderRowCount)
    fail("capture_data_aggregate_mismatch");
  manifest.dataRecordCount = observedSourceRecordCount;
  if (digest(stableManifestHashInput(manifest)) !== manifest.manifestHash || manifest.captureId !== `appsreal-${manifest.manifestHash.slice(0, 16)}`)
    fail("capture_manifest_hash_mismatch");

  if (validateCaptureStability(manifest, mode === "preliminary-delta") !== mode) fail("capture_stability_incomplete");
}

export interface LoadedAppSheetHistoryCapture {
  directory: string;
  mode: CaptureMode;
  manifest: CaptureManifest;
  headers: HeadersFile;
  pages: CapturePage[];
  pagesBySheet: Map<string, CapturePage[]>;
  deltaEvidence: DeltaPageEvidence[];
}

export async function loadAppSheetHistoryCapture(directoryValue: string, options: { allowStagedDelta?: boolean } = {}): Promise<LoadedAppSheetHistoryCapture> {
  const directory = resolve(directoryValue);
  try {
    const dir = await lstat(directory);
    const pagesDir = await lstat(join(directory, "pages"));
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0 || !pagesDir.isDirectory() || pagesDir.isSymbolicLink() || (pagesDir.mode & 0o077) !== 0)
      fail("capture_directory_permissions_invalid");
  } catch (error) {
    if (error instanceof AppSheetHistoryStageError) throw error;
    fail("capture_directory_unavailable");
  }
  const [manifestValue, headersValue, metadataValue, pageEntries] = await Promise.all([
    readPrivateJson(join(directory, "manifest.json"), MAX_MANIFEST_BYTES, "manifest.json"),
    readPrivateJson(join(directory, "headers.json"), MAX_HEADERS_BYTES, "headers.json"),
    readPrivateJson(join(directory, "metadata.json"), MAX_MANIFEST_BYTES, "metadata.json"),
    readdir(join(directory, "pages"), { withFileTypes: true }),
  ]);
  const manifest = parseManifest(manifestValue);
  const headers = parseHeaders(headersValue);
  const mode = validateCaptureStability(manifest, options.allowStagedDelta === true);
  const metadataParsed = z.object({ schemaVersion: z.string(), sourceSystem: z.string(), spreadsheet: z.record(z.string(), z.unknown()) }).passthrough().safeParse(metadataValue);
  if (!metadataParsed.success) fail("capture_metadata_invalid");
  const metadata = metadataParsed.data as MetadataFile;
  if (manifest.pages.length === 0 || manifest.pages.length > 2_000 || manifest.pages.length !== pageEntries.length) fail("capture_page_set_mismatch");
  let totalBytes = 0;
  const pages = await Promise.all(manifest.pages.map(async (ref) => {
    if (basename(ref.path) !== ref.path.replace(/^pages\//, "") || !/^pages\/[0-9]+-[0-9]+-[0-9]+\.json$/.test(ref.path)) fail("capture_page_path_invalid");
    const filePath = join(directory, ref.path);
    const info = await lstat(filePath).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size > APPSHEET_HISTORY_MAX_PAGE_BYTES || (info.mode & 0o077) !== 0)
      fail("capture_page_permissions_invalid");
    totalBytes += info.size;
    if (totalBytes > APPSHEET_HISTORY_MAX_CAPTURE_BYTES) fail("capture_too_large");
    const value = await readPrivateJson(filePath, APPSHEET_HISTORY_MAX_PAGE_BYTES, basename(ref.path));
    const page = parsePage(value);
    if (page.page.index !== ref.pageIndex || page.sheet.sheetId !== ref.sheetId || page.page.startRow !== ref.startRow || page.page.endRow !== ref.endRow)
      fail("capture_page_manifest_mismatch");
    return page;
  }));
  const actualNames = pageEntries.map((entry) => entry.name).sort();
  const expectedNames = manifest.pages.map((ref) => basename(ref.path)).sort();
  if (pageEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink()) || canonicalJson(actualNames) !== canonicalJson(expectedNames))
    fail("capture_page_set_mismatch");
  validateManifestHashes(manifest, metadata, headers, pages, mode);
  const bySheet = new Map<string, CapturePage[]>();
  for (const page of pages) {
    const found = bySheet.get(page.sheet.title) ?? [];
    found.push(page);
    bySheet.set(page.sheet.title, found);
  }
  for (const list of bySheet.values()) list.sort((a, b) => a.page.index - b.page.index);
  const initial: LoadedAppSheetHistoryCapture = { directory, mode, manifest, headers, pages, pagesBySheet: bySheet, deltaEvidence: [] };
  const deltaEvidence = await validateCaptureEvidence(initial);
  const loaded = { ...initial, deltaEvidence };
  return loaded;
}

function populatedCell(cell: CellData): boolean {
  const entered = cell.userEnteredValue;
  if (entered?.formulaValue) return true;
  if (entered?.stringValue !== undefined && entered.stringValue.trim() !== "") return true;
  if (entered?.numberValue !== undefined || entered?.boolValue !== undefined) return true;
  const effective = cell.effectiveValue;
  if (effective?.errorValue || effective?.numberValue !== undefined || effective?.boolValue !== undefined) return true;
  return effective?.stringValue !== undefined && effective.stringValue.trim() !== "";
}

function fieldMap(columns: readonly HeaderColumn[]): Map<string, HeaderColumn[]> {
  const result = new Map<string, HeaderColumn[]>();
  for (const column of columns) {
    if (column.header === null || column.header.trim() === "") continue;
    const key = normalizeAppSheetHistoryHeader(column.header);
    const matches = result.get(key) ?? [];
    matches.push(column);
    result.set(key, matches);
  }
  return result;
}

function sourceKeyForRow(ruleKey: string | null, formatted: readonly FormattedCell[], sourceTable: string, sourceRow: number): { key: string; keyed: boolean; error: string | null } {
  if (ruleKey === null) return { key: `synthetic:${sourceTable}:${sourceRow}`, keyed: false, error: "source_key_not_declared" };
  const wanted = normalizeAppSheetHistoryHeader(ruleKey);
  const candidates = formatted.filter((cell) => cell.normalized.header !== null && normalizeAppSheetHistoryHeader(cell.normalized.header) === wanted);
  if (candidates.length > 1) return { key: `synthetic:${sourceTable}:${sourceRow}`, keyed: false, error: "source_key_header_ambiguous" };
  const value = candidates.length === 1 ? effectiveCellValue(candidates[0]!) : null;
  if (value === null || value.trim() === "") return { key: `synthetic:${sourceTable}:${sourceRow}`, keyed: false, error: "source_key_missing" };
  if (value.length > 65_536) return { key: `synthetic:${sourceTable}:${sourceRow}`, keyed: false, error: "source_key_too_long" };
  return { key: value, keyed: true, error: null };
}

function appendSourceException(record: PreparedRecord, kind: string, severity: "review" | "blocking", evidence: Record<string, string | number | boolean | null> = {}): void {
  if (record.exceptions.some((item) => item.kind === kind && canonicalJson(item.evidence) === canonicalJson(evidence))) return;
  record.exceptions.push({ kind, severity, evidence });
}

function rowRecord(input: { page: CapturePage; row: CapturePage["rows"][number]; headerSheet: HeadersFile["sheets"][number]; snapshotId: string; manifestHash: string; deltaEvidence?: DeltaPageEvidence }): PreparedRecord {
  const { page, row, headerSheet, snapshotId, manifestHash } = input;
  const sourceTable = page.sheet.title;
  const rule = appSheetHistoryRule(sourceTable);
  const headersByIndex = new Map(headerSheet.columns.map((column) => [column.columnIndex, column.header]));
  const formatted = row.cells.map((cell) => formatCellData(cell, row.sourceRow, headersByIndex.get(cell.columnIndex) ?? null));
  const grouped = new Map<string, FormattedCell[]>();
  for (const cell of formatted) {
    if (cell.normalized.header === null) continue;
    const items = grouped.get(cell.normalized.header) ?? [];
    items.push(cell);
    grouped.set(cell.normalized.header, items);
  }
  const masterKey = (APPSHEET_MASTER_KEY_FIELDS as Readonly<Record<string, string>>)[sourceTable] ?? null;
  const sourceKey = sourceKeyForRow(rule?.keyField ?? masterKey, formatted, sourceTable, row.sourceRow);
  const original = { columns: formatted.map((cell) => {
    const numberFormat = cell.original && typeof cell.original === "object" && !Array.isArray(cell.original)
      ? (cell.original as { userEnteredFormat?: { numberFormat?: { pattern?: string } } }).userEnteredFormat?.numberFormat?.pattern ?? null : null;
    return { coordinate: cell.coordinate, header: cell.normalized.header, numberFormat, value: cell.original };
  }) };
  const normalized = { columns: formatted.map((cell) => cell.normalized) };
  const headerByIndex = new Map(headerSheet.columns.map((column) => [column.columnIndex, column.header]));
  const unresolvedFormulaFields = [...new Set(row.unresolvedFormulaCells.flatMap((reference) => {
    const columnIndex = typeof reference === "number" ? reference : columnIndexFromCoordinate(reference);
    const header = columnIndex === null ? null : headerByIndex.get(columnIndex) ?? null;
    return header === null ? [] : [header];
  }))].sort();
  const projection = {
    sourceTable, sourceKey: sourceKey.key, sourceRow: row.sourceRow, fileHash: manifestHash,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, original, normalized,
    treatment: rule ? (rule.kind === "archive" ? "archive_only" as const : "fact_candidate" as const) : "archive_only" as const,
    exceptions: [] as SourceException[],
  };
  const sourceRecord = { ...projection, contentHash: legacyPayloadHash(projection) };
  let parsed;
  try { parsed = sourceRecordSchema.parse(sourceRecord); }
  catch (error) {
    if (error instanceof Error && error.message.includes("IMPORT_CREDENTIAL")) fail("capture_credential_material_detected");
    fail("capture_source_record_invalid");
  }
  const record: PreparedRecord = {
    id: digest({ snapshotId, sourceTable, sourceRow: row.sourceRow }),
    snapshotId,
    sourceTable,
    sourceKey: sourceKey.key,
    sourceRow: row.sourceRow,
    fileHash: manifestHash,
    contentHash: parsed.contentHash,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    original,
    normalized,
    treatment: projection.treatment,
    exceptions: [],
    formatted: grouped,
    unresolvedFormulaFields,
    ruleKind: rule?.kind ?? "archive",
    relationshipData: [],
  };
  if (sourceKey.error) appendSourceException(record, sourceKey.error, sourceKey.error === "source_key_not_declared" ? "review" : "blocking");
  if (headerSheet.columns.some((column) => column.sensitive && column.header !== null && isCredentialBearingHeader(column.header, sourceTable)))
    fail("capture_credential_header_detected");
  for (const field of row.unresolvedFormulaCells) {
    const coordinate = typeof field === "number" ? `${columnName(field)}${row.sourceRow}` : field;
    appendSourceException(record, "formula_result_unresolved", "blocking", { coordinate });
  }
  if (input.deltaEvidence) {
    const delta = input.deltaEvidence;
    appendSourceException(record, "capture_page_delta_unstable", "blocking", {
      pageIndex: delta.pageIndex, startRow: delta.startRow, endRow: delta.endRow, pass1Hash: delta.pass1Hash, pass2Hash: delta.pass2Hash,
      pass3Hash: delta.pass3Hash, pass3EqualsPass2Hash: delta.pass3EqualsPass2Hash,
      changedRows: delta.changedRows, changedCells: delta.changedCells,
      userEnteredValueChangedCells: delta.userEnteredValueChangedCells, effectiveValueChangedCells: delta.effectiveValueChangedCells,
      numberFormatChangedCells: delta.numberFormatChangedCells, dataValidationChangedCells: delta.dataValidationChangedCells,
      pass2CellLevelComparisonPossible: false,
    });
  }
  if (row.cells.some((cell) => cell.effectiveValue?.errorValue))
    appendSourceException(record, "formula_or_source_cell_error", "blocking", { count: row.cells.filter((cell) => cell.effectiveValue?.errorValue).length });
  if (containsRecognizableCredential(record)) fail("capture_credential_material_detected");

  if (rule) {
    const fieldDefinitions = [rule.keyField, rule.dateField, rule.amountField, rule.quantityField, rule.currencyField].filter((value): value is string => value !== null);
    for (const fieldName of new Set(fieldDefinitions)) {
      if (headerMatches(headerSheet.columns, fieldName).length > 1)
        appendSourceException(record, "source_header_ambiguous", "blocking", { field: fieldName });
    }
    const unverifiedFields = rule.nonAuthoritativeStatusFields.filter((name) => {
      const cells = cellsByHeader(record, name);
      return cells.length > 0 && cells.some((cell) => {
        const text = effectiveCellValue(cell);
        return text !== null && text.trim() !== "";
      });
    });
    if (unverifiedFields.length)
      appendSourceException(record, "source_status_unverified", "review", { fieldCount: unverifiedFields.length });
  }
  return record;
}

function addDuplicateKeyExceptions(records: PreparedRecord[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.sourceKey.startsWith("synthetic:")) continue;
    const key = `${record.sourceTable}\0${record.sourceKey}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const record of records) {
    if (!record.sourceKey.startsWith("synthetic:") && (counts.get(`${record.sourceTable}\0${record.sourceKey}`) ?? 0) > 1)
      appendSourceException(record, "duplicate_source_key", "blocking");
  }
  return counts;
}

function sealSourceRecord(record: PreparedRecord): void {
  const projection = {
    sourceTable: record.sourceTable,
    sourceKey: record.sourceKey,
    sourceRow: record.sourceRow,
    fileHash: record.fileHash,
    importerVersion: record.importerVersion,
    original: record.original,
    normalized: record.normalized,
    treatment: record.treatment,
    exceptions: record.exceptions,
  };
  const parsed = sourceRecordSchema.parse({ ...projection, contentHash: legacyPayloadHash(projection) });
  record.contentHash = parsed.contentHash;
}

function resolveRelationships(records: PreparedRecord[]): void {
  const sourceIndex = new Map<string, Map<string, PreparedRecord[]>>();
  for (const record of records) {
    const tableIndex = sourceIndex.get(record.sourceTable) ?? new Map<string, PreparedRecord[]>();
    sourceIndex.set(record.sourceTable, tableIndex);
    for (const cell of record.formatted.values()) for (const candidate of cell) {
      if (candidate.effective.kind !== "string" && candidate.effective.kind !== "number" && candidate.effective.kind !== "boolean") continue;
      const value = effectiveCellValue(candidate);
      if (value === null || value.trim() === "") continue;
      const normalizedHeader = candidate.normalized.header === null ? "" : normalizeAppSheetHistoryHeader(candidate.normalized.header);
      const key = `${normalizedHeader}\0${value}`;
      const matches = tableIndex.get(key) ?? [];
      matches.push(record);
      tableIndex.set(key, matches);
    }
  }

  for (const record of records) {
    const rule = appSheetHistoryRule(record.sourceTable);
    if (!rule) continue;
    const identityGroups = new Map<string, { sourceField: string; targetSourceRecordId: string }[]>();
    for (const relationship of rule.relationships) {
      const foreignCells = cellsByHeader(record, relationship.sourceField);
      const foreign = foreignCells.length === 1 ? effectiveCellValue(foreignCells[0]!) : null;
      const targetKey = normalizeAppSheetHistoryHeader(relationship.targetField);
      const targetIndex = sourceIndex.get(relationship.targetTable);
      const matches = foreign !== null ? targetIndex?.get(`${targetKey}\0${foreign}`) ?? [] : [];
      const uniqueMatches = [...new Map(matches.map((item) => [item.id, item])).values()];
      const sourceFieldAmbiguous = foreignCells.length > 1;
      const sourceValueProvided = foreign !== null && foreign.trim() !== "";
      const status = sourceFieldAmbiguous ? "ambiguous"
        : !sourceValueProvided ? relationship.required === false ? "not_provided" : "missing"
        : uniqueMatches.length === 1 ? "unique" : uniqueMatches.length === 0 ? "missing" : "ambiguous";
      const relationshipEntry: Record<string, JSONValue> = {
        sourceField: relationship.sourceField,
        targetTable: relationship.targetTable,
        targetField: relationship.targetField,
        sourceValue: foreign,
        status,
        matchCount: uniqueMatches.length,
        targetSourceKey: uniqueMatches.length === 1 ? uniqueMatches[0]!.sourceKey : null,
        targetSourceRecordId: uniqueMatches.length === 1 ? uniqueMatches[0]!.id : null,
      };
      record.relationshipData.push(relationshipEntry);
      if (status === "unique" && relationship.identityGroup) {
        const links = identityGroups.get(relationship.identityGroup) ?? [];
        links.push({ sourceField: relationship.sourceField, targetSourceRecordId: uniqueMatches[0]!.id });
        identityGroups.set(relationship.identityGroup, links);
      }
      if (status !== "unique" && status !== "not_provided")
        appendSourceException(record, status === "ambiguous" ? "foreign_relationship_ambiguous" : "foreign_relationship_missing", "blocking", {
          targetTable: relationship.targetTable, sourceField: relationship.sourceField,
        });
    }
    for (const [identityGroup, links] of identityGroups) {
      if (links.length < 2 || new Set(links.map((link) => link.targetSourceRecordId)).size < 2) continue;
      appendSourceException(record, "foreign_relationship_conflict", "blocking", {
        identityGroup, sourceFields: links.map((link) => link.sourceField).sort().join(","),
      });
    }
  }
}

function normalizedMovementValues(record: PreparedRecord): (string | null)[] {
  return APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS.map((name) => {
    const found = cellsByHeader(record, name);
    return found.length === 1 ? effectiveCellValue(found[0]!) : null;
  });
}

function quarantineMovementCandidate(record: PreparedRecord, kind: string, severity: "review" | "blocking", evidence: Record<string, string | number | boolean | null>): void {
  record.treatment = "overlap_evidence";
  record.ruleKind = "archive";
  appendSourceException(record, kind, severity, evidence);
}

type MovementOverlapMetrics = {
  legacyRecordCount: number;
  candidateRecordCount: number;
  exactCompositeMatches: number;
  exactIdMatches: number;
  differentCompositeMatches: number;
  ambiguousLegacyIds: number;
  unmatchedLegacyRecords: number;
  unmatchedCandidateRecords: number;
  incompleteLegacyRecords: number;
  ambiguousLegacyCompositeGroups: number;
  duplicateCandidateCompositeGroups: number;
  duplicateCandidateIdGroups: number;
  blockedRecordCount: number;
};

export interface AppSheetHistoryMovementMatchInput {
  id: string;
  sourceTable: "Movimiento" | "Movimiento_Nueva";
  sourceRow: number;
  legacyId: string | null;
  compositeValues: readonly (string | null)[];
  /** False for source rows that are retained only as archive evidence. */
  isFactCandidate?: boolean;
}

export interface AppSheetHistoryMovementMatchDecision {
  sourceRecordId: string;
  sourceRow: number;
  status: "ambiguous_reference" | "exact_legacy_fields" | "different_legacy_fields" | "comparison_incomplete";
  comparedFields: number;
  targetSourceRecordIds: string[];
  idHash: string | null;
  compositeHash: string | null;
  legacyCompositeMultiplicity: number;
  exactIdMatch: boolean;
}

export interface AppSheetHistoryMovementMatchAnalysis {
  decisions: AppSheetHistoryMovementMatchDecision[];
  duplicateCandidateIds: string[];
  duplicateCandidateCompositeIds: string[];
  duplicateCandidateIdGroups: number;
  duplicateCandidateCompositeGroups: number;
  ambiguousLegacyCompositeGroups: number;
  unmatchedCandidateRecords: number;
}

/** Classify movement-table overlap by exact ID and seven-field composite evidence. */
export function analyzeAppSheetHistoryMovementMatches(rows: readonly AppSheetHistoryMovementMatchInput[]): AppSheetHistoryMovementMatchAnalysis {
  const newRows = rows.filter((row) => row.sourceTable === "Movimiento_Nueva");
  const oldRows = rows.filter((row) => row.sourceTable === "Movimiento");
  const byId = new Map<string, AppSheetHistoryMovementMatchInput[]>();
  const byComposite = new Map<string, AppSheetHistoryMovementMatchInput[]>();
  const oldByComposite = new Map<string, AppSheetHistoryMovementMatchInput[]>();
  const complete = (values: readonly (string | null)[]) => values.length === APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS.length && values.every((value) => value !== null);
  const compositeKey = (values: readonly (string | null)[]) => canonicalJson(values);
  for (const row of newRows) {
    if (row.legacyId !== null && row.legacyId.trim() !== "") {
      const matches = byId.get(row.legacyId) ?? [];
      matches.push(row);
      byId.set(row.legacyId, matches);
    }
    if (complete(row.compositeValues)) {
      const key = compositeKey(row.compositeValues);
      const matches = byComposite.get(key) ?? [];
      matches.push(row);
      byComposite.set(key, matches);
    }
  }
  for (const row of oldRows) {
    if (!complete(row.compositeValues)) continue;
    const key = compositeKey(row.compositeValues);
    const matches = oldByComposite.get(key) ?? [];
    matches.push(row);
    oldByComposite.set(key, matches);
  }
  const duplicateCandidateIds = new Set<string>();
  let duplicateCandidateIdGroups = 0;
  for (const [id, matches] of byId) {
    if (matches.length < 2) continue;
    duplicateCandidateIdGroups++;
    for (const match of matches) duplicateCandidateIds.add(match.id);
  }
  const duplicateCandidateCompositeIds = new Set<string>();
  let duplicateCandidateCompositeGroups = 0;
  for (const matches of byComposite.values()) {
    if (matches.length < 2) continue;
    duplicateCandidateCompositeGroups++;
    for (const match of matches) duplicateCandidateCompositeIds.add(match.id);
  }
  let ambiguousLegacyCompositeGroups = 0;
  for (const matches of oldByComposite.values()) if (matches.length > 1) ambiguousLegacyCompositeGroups++;

  const decisions = oldRows.map((old) => {
    const values = old.compositeValues;
    const comparedFields = values.filter((value) => value !== null).length;
    const isComplete = complete(values);
    const idMatches = old.legacyId === null ? [] : byId.get(old.legacyId) ?? [];
    const compositeMatches = isComplete ? byComposite.get(compositeKey(values)) ?? [] : [];
    const legacyMatches = isComplete ? oldByComposite.get(compositeKey(values)) ?? [] : [];
    const oneComposite = compositeMatches.length === 1 ? compositeMatches[0]! : null;
    const oneId = idMatches.length === 1 ? idMatches[0]! : null;
    const identityConflict = oneComposite !== null && oneId !== null && oneComposite.id !== oneId.id;
    const ambiguous = idMatches.length > 1 || compositeMatches.length > 1 || legacyMatches.length > 1 || identityConflict;
    let status: AppSheetHistoryMovementMatchDecision["status"];
    if (ambiguous) status = "ambiguous_reference";
    else if (oneComposite) status = "exact_legacy_fields";
    else if (oneId) status = isComplete ? "different_legacy_fields" : "comparison_incomplete";
    else if (!isComplete) status = "comparison_incomplete";
    else status = "different_legacy_fields";
    return {
      sourceRecordId: old.id,
      sourceRow: old.sourceRow,
      status,
      comparedFields,
      targetSourceRecordIds: [...new Set([...idMatches, ...compositeMatches].map((match) => match.id))],
      idHash: old.legacyId === null ? null : digest({ legacyMovementId: old.legacyId }),
      compositeHash: isComplete ? digest({ fields: APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS, values }) : null,
      legacyCompositeMultiplicity: legacyMatches.length,
      exactIdMatch: oneComposite !== null && oneId?.id === oneComposite.id,
    };
  });
  const linkedCandidateIds = new Set(decisions.flatMap((decision) => decision.targetSourceRecordIds));
  const unmatchedCandidateRecords = newRows.filter((row) => row.isFactCandidate !== false &&
    !duplicateCandidateIds.has(row.id) && !duplicateCandidateCompositeIds.has(row.id) && !linkedCandidateIds.has(row.id)).length;
  return {
    decisions,
    duplicateCandidateIds: [...duplicateCandidateIds],
    duplicateCandidateCompositeIds: [...duplicateCandidateCompositeIds],
    duplicateCandidateIdGroups,
    duplicateCandidateCompositeGroups,
    ambiguousLegacyCompositeGroups,
    unmatchedCandidateRecords,
  };
}

function compareMovements(records: PreparedRecord[]): MovementOverlapMetrics {
  const newRows = records.filter((record) => record.sourceTable === "Movimiento_Nueva");
  const oldRows = records.filter((record) => record.sourceTable === "Movimiento");
  const byId = new Map<string, PreparedRecord[]>();
  for (const candidate of newRows) {
    const ids = cellsByHeader(candidate, "ID_Movimiento");
    const id = ids.length === 1 ? effectiveCellValue(ids[0]!) : null;
    if (id === null || id.trim() === "") continue;
    const matches = byId.get(id) ?? [];
    matches.push(candidate);
    byId.set(id, matches);
  }
  const byRecordId = new Map(records.map((record) => [record.id, record]));
  const analysis = analyzeAppSheetHistoryMovementMatches(records
    .filter((record): record is PreparedRecord & { sourceTable: "Movimiento" | "Movimiento_Nueva" } =>
      record.sourceTable === "Movimiento" || record.sourceTable === "Movimiento_Nueva")
    .map((record) => {
      const ids = record.sourceTable === "Movimiento_Nueva" ? cellsByHeader(record, "ID_Movimiento") : cellsByHeader(record, "ID_Movimiento");
      return { id: record.id, sourceTable: record.sourceTable, sourceRow: record.sourceRow,
        legacyId: ids.length === 1 ? effectiveCellValue(ids[0]!) : null, compositeValues: normalizedMovementValues(record),
        isFactCandidate: record.treatment === "fact_candidate" };
    }));
  for (const [id, matches] of byId) {
    if (matches.length < 2) continue;
    const idHash = digest({ legacyMovementId: id });
    for (const candidate of matches)
      quarantineMovementCandidate(candidate, "cash_new_table_reused_legacy_id", "blocking", { idHash, matchCount: matches.length });
  }
  const byComposite = new Map<string, PreparedRecord[]>();
  for (const candidate of newRows) {
    const values = normalizedMovementValues(candidate);
    if (values.some((value) => value === null)) continue;
    const key = canonicalJson(values);
    const matches = byComposite.get(key) ?? [];
    matches.push(candidate);
    byComposite.set(key, matches);
  }
  for (const matches of byComposite.values()) {
    if (matches.length < 2) continue;
    const compositeHash = digest({ fields: APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS, values: normalizedMovementValues(matches[0]!) });
    for (const candidate of matches)
      quarantineMovementCandidate(candidate, "cash_new_table_duplicate_composite", "blocking", { compositeHash, matchCount: matches.length });
  }

  let exactCompositeMatches = 0, exactIdMatches = 0, differentCompositeMatches = 0;
  let ambiguousLegacyIds = 0, unmatchedLegacyRecords = 0, incompleteLegacyRecords = 0;
  const decisionsByRecordId = new Map(analysis.decisions.map((decision) => [decision.sourceRecordId, decision]));
  for (const oldRow of oldRows) {
    const values = normalizedMovementValues(oldRow);
    const decision = decisionsByRecordId.get(oldRow.id);
    if (!decision) fail("movement_overlap_decision_missing");
    const { status, comparedFields, compositeHash, idHash } = decision;
    const complete = comparedFields === APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS.length;
    const targetRecords = decision.targetSourceRecordIds.map((id) => byRecordId.get(id)).filter((record): record is PreparedRecord => record !== undefined);
    const oneComposite = status === "exact_legacy_fields" ? targetRecords.find((record) => record.sourceTable === "Movimiento_Nueva") ?? null : null;
    const oneId = status === "different_legacy_fields" || status === "comparison_incomplete"
      ? targetRecords.find((record) => record.sourceTable === "Movimiento_Nueva") ?? null : null;
    let target: PreparedRecord | null = null;
    if (status === "ambiguous_reference") {
      ambiguousLegacyIds++;
      for (const candidate of targetRecords)
        quarantineMovementCandidate(candidate, "cash_new_table_overlap_ambiguous", "blocking", { sourceRecordId: oldRow.id, sourceRow: oldRow.sourceRow });
      appendSourceException(oldRow, "cash_overlap_ambiguous_reference", "blocking", {
        comparedFields, idHash, compositeHash, legacyCompositeMultiplicity: decision.legacyCompositeMultiplicity,
      });
      oldRow.treatment = "overlap_evidence";
      oldRow.ruleKind = "archive";
    } else if (status === "exact_legacy_fields" && oneComposite !== null) {
      target = oneComposite;
      exactCompositeMatches++;
      if (decision.exactIdMatch) exactIdMatches++;
      // Keep the new-table row as the sole cash candidate. The old row remains
      // immutable source lineage, but its projected fact is archive-only.
      oldRow.treatment = "archive_only";
      oldRow.ruleKind = "archive";
      appendSourceException(oldRow, "cash_overlap_exact_legacy_fields", "review", {
        comparedFields, matchStrategy: "legacy-composite", compositeHash, targetSourceRecordId: target.id,
      });
    } else if (oneId !== null) {
      target = oneId;
      if (status !== "different_legacy_fields" && status !== "comparison_incomplete") fail("movement_overlap_status_invalid");
      if (complete) differentCompositeMatches++;
      else incompleteLegacyRecords++;
      quarantineMovementCandidate(target, complete ? "cash_new_table_overlap_conflict" : "cash_new_table_overlap_comparison_incomplete", "blocking", {
        sourceRecordId: oldRow.id, sourceRow: oldRow.sourceRow,
        idHash, compositeHash,
      });
      appendSourceException(oldRow, complete ? "cash_overlap_id_composite_conflict" : "cash_overlap_comparison_incomplete", "blocking", {
        comparedFields, matchStrategy: "legacy-id", idHash, compositeHash, targetSourceRecordId: target.id,
      });
      oldRow.treatment = "overlap_evidence";
      oldRow.ruleKind = "archive";
    } else if (!complete) {
      if (status !== "comparison_incomplete") fail("movement_overlap_status_invalid");
      incompleteLegacyRecords++;
      appendSourceException(oldRow, "cash_overlap_comparison_incomplete", "blocking", {
        comparedFields, idHash,
      });
    } else {
      if (status !== "different_legacy_fields") fail("movement_overlap_status_invalid");
      unmatchedLegacyRecords++;
      appendSourceException(oldRow, "cash_overlap_no_exact_match", "blocking", {
        comparedFields, matchStrategy: "no-exact-id-or-composite", idHash, compositeHash,
      });
    }
    oldRow.normalized.overlapEvidence = {
      targetTable: "Movimiento_Nueva", targetSourceRow: target?.sourceRow ?? null, status, comparedFields,
    };
  }
  return {
    legacyRecordCount: oldRows.length,
    candidateRecordCount: newRows.filter((record) => record.treatment === "fact_candidate").length,
    exactCompositeMatches,
    exactIdMatches,
    differentCompositeMatches,
    ambiguousLegacyIds,
    unmatchedLegacyRecords,
    unmatchedCandidateRecords: analysis.unmatchedCandidateRecords,
    incompleteLegacyRecords,
    duplicateCandidateCompositeGroups: analysis.duplicateCandidateCompositeGroups,
    duplicateCandidateIdGroups: analysis.duplicateCandidateIdGroups,
    ambiguousLegacyCompositeGroups: analysis.ambiguousLegacyCompositeGroups,
    blockedRecordCount: [...newRows, ...oldRows].filter((record) => record.exceptions.some((item) => item.severity === "blocking" && item.kind.startsWith("cash_"))).length,
  };
}

function relationshipLinks(record: PreparedRecord): JSONValue[] {
  return record.relationshipData.map((item) => item);
}

function makeHistoricalFact(record: PreparedRecord): PreparedFact {
  const rule = appSheetHistoryRule(record.sourceTable);
  if (!rule || record.ruleKind === "archive") {
    const attributes = {
      sourceTreatment: record.treatment,
      sourceKind: rule?.kind ?? "unmapped-table",
      financialEffect: "archive-only",
      relationships: relationshipLinks(record),
      sourceFormulaCells: [...record.formatted.values()].flat().filter((item) => item.formula !== null).length,
      ...(record.normalized.pendingReconciliation ? { pendingReconciliation: record.normalized.pendingReconciliation } : {}),
    };
    return {
      id: digest({ sourceRecordId: record.id, mappingId: APPSHEET_HISTORY_MAPPING_ID }), snapshotId: record.snapshotId,
      sourceRecordId: record.id, sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow,
      sourceHash: record.contentHash, mappingId: APPSHEET_HISTORY_MAPPING_ID, kind: "archive", occurredOn: null, dateState: "not-applicable",
      currency: null, currencyState: "not-applicable", unit: null, unitState: "not-applicable", amountMinor: null, amountState: "not-applicable",
      quantity: null, quantityState: "not-applicable", attributes: asInputJson(attributes), createdBy: ACTOR,
    };
  }

  const date = rule.dateField === null ? { value: null, state: "not-applicable" as const } : parseDateCell(uniqueCell(record, rule.dateField));
  const amount = rule.amountField === null ? { value: null, state: "not-applicable" as const } : parseMoneyCell(uniqueCell(record, rule.amountField));
  const quantity = rule.quantityField === null ? { value: null, state: "not-applicable" as const } : parseQuantityCell(uniqueCell(record, rule.quantityField));
  const currency = rule.currencyField === null ? { value: null, state: "absent" as const } : parseCurrencyCell(uniqueCell(record, rule.currencyField));
  const unit = rule.quantityField === null ? { value: null, state: "not-applicable" as const } : rule.defaultUnit
    ? { value: rule.defaultUnit, state: "known" as const } : { value: null, state: "absent" as const };
  const unverified = rule.nonAuthoritativeStatusFields.filter((field) => cellsByHeader(record, field).some((cell) => {
    const text = effectiveCellValue(cell);
    return text !== null && text.trim() !== "";
  }));
  const classificationCells = rule.classificationField === undefined ? [] : cellsByHeader(record, rule.classificationField);
  const classificationValue = classificationCells.length === 1 ? effectiveCellValue(classificationCells[0]!) : null;
  const classificationState = classificationCells.length > 1 ? "ambiguous"
    : classificationValue === null || classificationValue.trim() === "" ? "absent"
    : rule.classificationValues && !rule.classificationValues.includes(classificationValue) ? "unrecognized" : "known";
  if (rule.classificationField && classificationState !== "known")
    appendSourceException(record, "source_classification_unresolved", "blocking", { field: rule.classificationField });
  const sourceAmounts: { field: string; currency: "ARS" | "USD"; amountMinor: string | null; state: "known" | "invalid" | "absent" }[] = [];
  if (record.sourceTable === "C_OperacionUSD") {
    for (const [field, currencyName] of [["MontoARS", "ARS"], ["MontoUSD", "USD"]] as const) {
      const parsed = parseMoneyCell(uniqueCell(record, field));
      sourceAmounts.push({ field, currency: currencyName, amountMinor: parsed.value?.toString() ?? null,
        state: parsed.state === "known" ? "known" : parsed.state === "absent" ? "absent" : "invalid" });
      if (parsed.state !== "known") appendSourceException(record, "fx_source_amount_unresolved", "blocking", { field });
    }
    appendSourceException(record, "fx_multi_currency_not_collapsed", "review", { amountCount: sourceAmounts.length });
  }
  const states = [date, amount, quantity, currency, unit];
  for (const [index, value] of states.entries()) {
    const field = [rule.dateField, rule.amountField, rule.quantityField, rule.currencyField, rule.quantityField ? "unit" : null][index];
    if (value.state === "invalid") appendSourceException(record, "source_value_invalid", "blocking", { field: field ?? "unknown" });
    else if (value.state === "absent" && (index === 0 && rule.dateField || index === 1 && rule.amountField || index === 2 && rule.quantityField || index === 3 && rule.currencyField))
      appendSourceException(record, "source_value_missing", "blocking", { field: field ?? "unknown" });
  }
  const attributes = {
    sourceTreatment: record.treatment,
    sourceKind: rule.kind,
    sourceFields: rule,
    financialEffect: record.ruleKind === "archive" ? "archive-only" : "historical-fact-only",
    relationships: relationshipLinks(record),
    unverifiedStatusFields: unverified,
    ...(rule.classificationField ? { sourceClassification: { field: rule.classificationField, value: classificationValue,
      state: classificationState } } : {}),
    ...(record.normalized.pendingReconciliation ? { pendingReconciliation: record.normalized.pendingReconciliation } : {}),
    ...(sourceAmounts.length ? { sourceAmounts } : {}),
    ...(record.sourceTable === "C_OperacionUSD" ? { exchangeRateField: "Tipo_Cambio", exchangeRate: effectiveCellValue(uniqueCell(record, "Tipo_Cambio")) } : {}),
  };
  return {
    id: digest({ sourceRecordId: record.id, mappingId: APPSHEET_HISTORY_MAPPING_ID }), snapshotId: record.snapshotId,
    sourceRecordId: record.id, sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow,
    sourceHash: record.contentHash, mappingId: APPSHEET_HISTORY_MAPPING_ID, kind: record.ruleKind, occurredOn: date.value,
    dateState: date.state, currency: currency.value, currencyState: currency.state, unit: unit.value, unitState: unit.state,
    amountMinor: amount.value, amountState: amount.state, quantity: quantity.value, quantityState: quantity.state,
    attributes: asInputJson(attributes), createdBy: ACTOR,
  };
}

function snapshotExceptions(snapshotId: string, records: readonly PreparedRecord[], global: readonly PersistedException[] = []): PersistedException[] {
  const exceptions: PersistedException[] = [];
  exceptions.push(...global);
  for (const record of records) for (const item of record.exceptions) {
    const id = digest({ snapshotId, sourceRecordId: record.id, kind: item.kind, severity: item.severity, evidence: item.evidence });
    exceptions.push({ id, sourceRecordId: record.id, kind: item.kind, severity: item.severity, description: `Fuente AppSheet: ${item.kind}.`, resolution: asInputJson(item.evidence) });
  }
  return exceptions;
}

export type AppSheetHistoryDefinition = {
  inventory: AppSheetDefinitionInventory;
  fileSha256: string;
  sourceSha256: string;
  descriptorSha256: string;
  appliedDefinitionHash: string;
  identityState: "verified" | "missing-in-source-inventory";
};

export type AppSheetHistoryProjectionReport = {
  status: "preview" | "staged";
  projectionKind: "history";
  sourceSystem: typeof APPSHEET_HISTORY_SOURCE_SYSTEM;
  importerVersion: typeof APPSHEET_HISTORY_IMPORTER_VERSION;
  captureId: string;
  mode: CaptureMode;
  manifestHash: string;
  dataHash: string;
  captureDefinitionHash: null;
  appliedDefinitionHash: string;
  definitionSourceSha256: string;
  definitionDescriptorSha256: string;
  definitionFileSha256: string;
  definitionIdentityState: AppSheetHistoryDefinition["identityState"];
  snapshotId: string;
  projectionHash: string;
  coverage: Record<string, unknown>;
  metrics: Record<string, unknown>;
  cutoverEligible: false;
};

export type PreparedAppSheetHistoryProjection = {
  snapshotId: string;
  capture: LoadedAppSheetHistoryCapture;
  definition: AppSheetHistoryDefinition;
  projectionHash: string;
  coverage: Record<string, unknown>;
  controls: Record<string, unknown>;
  persistedRecords: Prisma.LegacySourceRecordCreateManyInput[];
  persistedFacts: Prisma.LegacyHistoricalFactCreateManyInput[];
  exceptions: PersistedException[];
  metrics: {
    recordCount: number;
    factCount: number;
    exceptionCount: number;
    reviewExceptionCount: number;
    blockingExceptionCount: number;
    archiveOnlyRecordCount: number;
    overlapEvidenceRecordCount: number;
    tableCounts: Record<string, number>;
    kindCounts: Record<string, number>;
    severityCounts: Record<string, number>;
    pendingStatusCounts: Record<string, number>;
    movementOverlap: MovementOverlapMetrics;
    globalDeltaBlockingCount: number;
    formulaCount: number;
    unresolvedFormulaCount: number;
  };
};

const MAX_DEFINITION_BYTES = 32 * 1024 * 1024;

/** Read and validate the private, sanitized definition inventory without filling absent identity fields. */
export async function loadAppSheetHistoryDefinition(pathValue: string): Promise<AppSheetHistoryDefinition> {
  const path = resolve(pathValue);
  try {
    const info = await lstat(path);
    const directory = await lstat(resolve(path, ".."));
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_DEFINITION_BYTES ||
        (info.mode & 0o077) !== 0 || !directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0)
      fail("definition_file_permissions_invalid");
    const bytes = await readFile(path);
    const after = await lstat(path);
    if (bytes.length !== info.size || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail("definition_file_changed_during_read");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const inventory = prepareAppSheetDefinitionInventory(parsed, APPSHEET_EXPECTED_LIVE_APP_ID);
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      inventory,
      fileSha256,
      sourceSha256: inventory.source.sha256,
      descriptorSha256: inventory.descriptorSha256,
      appliedDefinitionHash: appSheetAppliedDefinitionHash(inventory),
      identityState: inventory.app.id === null ? "missing-in-source-inventory" : "verified",
    };
  } catch (error) {
    if (error instanceof AppSheetHistoryStageError) throw error;
    fail(error instanceof SyntaxError ? "definition_json_invalid" : "definition_inventory_invalid");
  }
}

function sheetDefinitionMatch(inventory: AppSheetDefinitionInventory, title: string): "unique" | "missing" | "ambiguous" {
  const names = inventory.sections.filter((section) => section.category === "tables")
    .flatMap((section) => section.records).map((record) => record.name).filter((name): name is string => name !== null);
  const matches = names.filter((name) => name === title).length;
  return matches === 1 ? "unique" : matches === 0 ? "missing" : "ambiguous";
}

export function buildAppSheetPendingSourceRecord(input: {
  sourceTable: string;
  sourceRow: number;
  sourceKey: string;
  original: PreparedRecord["original"];
  normalizedColumns: NormalizedColumn[];
  formatted: ReadonlyMap<string, readonly FormattedCell[]>;
  headerColumns: readonly HeaderColumn[];
  unresolvedFormulaFields?: readonly string[];
}): AppSheetPendingSourceRecord {
  const values: Record<string, string | null> = {};
  const headerCounts = new Map<string, number>();
  for (const column of input.headerColumns) {
    if (column.header === null) continue;
    values[column.header] = null;
    headerCounts.set(column.header, (headerCounts.get(column.header) ?? 0) + 1);
  }
  const duplicateFields = new Set([...headerCounts].filter(([, count]) => count > 1).map(([header]) => header));
  const unresolvedFields = new Set(input.unresolvedFormulaFields ?? []);
  for (const [header, cells] of input.formatted) {
    if ((headerCounts.get(header) ?? 0) > 1 || cells.length > 1) duplicateFields.add(header);
    if (!duplicateFields.has(header) && cells.length === 1) values[header] = effectiveCellValue(cells[0]!);
    if (cells.some((cell) => cell.formula !== null && (cell.effective.kind === "missing" || cell.effective.kind === "error")))
      unresolvedFields.add(header);
  }
  const sourceEvidenceHash = digest({
    sourceTable: input.sourceTable,
    sourceRow: input.sourceRow,
    sourceKey: input.sourceKey,
    original: input.original,
    normalizedColumns: input.normalizedColumns,
  });
  return {
    sourceTable: input.sourceTable,
    sourceRow: input.sourceRow,
    sourceKey: input.sourceKey,
    sourceEvidenceHash,
    values,
    duplicateFields: [...duplicateFields].sort(),
    unresolvedFields: [...unresolvedFields].sort(),
  };
}

function pendingSourceRecord(record: PreparedRecord, headerColumns: readonly HeaderColumn[]): AppSheetPendingSourceRecord {
  return buildAppSheetPendingSourceRecord({
    sourceTable: record.sourceTable,
    sourceRow: record.sourceRow,
    sourceKey: record.sourceKey,
    original: record.original,
    normalizedColumns: record.normalized.columns,
    formatted: record.formatted,
    headerColumns,
    unresolvedFormulaFields: record.unresolvedFormulaFields,
  });
}

function attachPendingReconciliation(records: PreparedRecord[], capture: LoadedAppSheetHistoryCapture): void {
  const columnsByTable = new Map(capture.headers.sheets.map((sheet) => [sheet.title, sheet.columns]));
  const sourceRows = records.filter((record) => APPSHEET_PENDING_TABLES.includes(record.sourceTable as (typeof APPSHEET_PENDING_TABLES)[number]))
    .map((record) => pendingSourceRecord(record, columnsByTable.get(record.sourceTable) ?? []));
  if (sourceRows.length === 0) return;
  const mappingHash = digest(JSON.parse(pendingMappingFingerprintPayload()) as unknown);
  let reconciled: ReturnType<typeof reconcileAppSheetPendingRows>;
  try {
    reconciled = reconcileAppSheetPendingRows(sourceRows, {
      captureId: capture.manifest.captureId,
      manifestHash: capture.manifest.manifestHash,
      mode: capture.mode,
      mappingHash,
    }, (value) => createHash("sha256").update(value, "utf8").digest("hex"));
  } catch { fail("pending_reconciliation_failed"); }
  const bySourceRow = new Map(reconciled.map((entry) => [`${entry.sourceTable}\0${entry.sourceRow}`, entry.reconciliation]));
  for (const record of records) {
    const item = bySourceRow.get(`${record.sourceTable}\0${record.sourceRow}`);
    if (!item) continue;
    const reconciliation = appSheetPendingReconciliationSchema.parse(item);
    record.normalized.pendingReconciliation = jsonValue(reconciliation) as Record<string, unknown>;
    for (const [dimension, result] of Object.entries(reconciliation.dimensions)) {
      if (result.status === "needs_review") appendSourceException(record, `pending_${dimension}_needs_review`, "blocking", {
        reasonCount: result.reasonCodes.length, reasonCodesHash: digest(result.reasonCodes), provisional: reconciliation.capture.provisional,
      });
      else if (result.status === "confirmed_pending") appendSourceException(record, `pending_${dimension}_confirmed`, "review", {
        reasonCount: result.reasonCodes.length, reasonCodesHash: digest(result.reasonCodes), provisional: reconciliation.capture.provisional,
      });
    }
  }
}

function globalDeltaExceptions(snapshotId: string, capture: LoadedAppSheetHistoryCapture): PersistedException[] {
  return capture.deltaEvidence.map((page) => {
    const evidence = {
      captureId: capture.manifest.captureId, manifestHash: capture.manifest.manifestHash,
      sheetId: page.sheetId, title: page.title, pageIndex: page.pageIndex, startRow: page.startRow, endRow: page.endRow,
      pass1Hash: page.pass1Hash, pass2Hash: page.pass2Hash, pass3Hash: page.pass3Hash,
      pass3EqualsPass2Hash: page.pass3EqualsPass2Hash, changedRows: page.changedRows, changedCells: page.changedCells,
      userEnteredValueChangedCells: page.userEnteredValueChangedCells, effectiveValueChangedCells: page.effectiveValueChangedCells,
      numberFormatChangedCells: page.numberFormatChangedCells, dataValidationChangedCells: page.dataValidationChangedCells,
      pass2CellLevelComparisonPossible: false,
    };
    return {
      id: digest({ snapshotId, kind: "capture_page_delta_unstable", evidence }),
      sourceRecordId: null,
      kind: "capture_page_delta_unstable",
      severity: "blocking" as const,
      description: `Captura preliminar con página variable: ${page.title}, página ${page.pageIndex}.`,
      resolution: asInputJson(evidence),
    };
  });
}

function omitNullExactHashFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitNullExactHashFields);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // exactJson requires amountMinor/quantity to be decimal strings. Their
    // corresponding *State fields preserve absence, so null is omitted only
    // from the hash representation and remains unchanged in persisted JSON.
    if ((key === "amountMinor" || key === "quantity") && child === null) continue;
    result[key] = omitNullExactHashFields(child);
  }
  return result;
}

function compactFact(fact: PreparedFact): Record<string, unknown> {
  const { amountMinor, ...withoutAmount } = fact;
  const { quantity, ...withoutQuantity } = withoutAmount;
  return {
    ...withoutQuantity,
    // exactJson deliberately rejects null for amountMinor. Absence remains
    // represented by amountState on the fact, so omit only the hash field.
    ...(amountMinor === null ? {} : { amountMinor: amountMinor.toString() }),
    ...(quantity === null ? {} : { quantity: quantity.toString() }),
    attributes: omitNullExactHashFields(JSON.parse(JSON.stringify(fact.attributes)) as unknown),
  };
}

function stageMetrics(records: readonly PreparedRecord[], facts: readonly PreparedFact[], exceptions: readonly PersistedException[],
  movementOverlap: MovementOverlapMetrics, capture: LoadedAppSheetHistoryCapture): PreparedAppSheetHistoryProjection["metrics"] {
  const tableCounts: Record<string, number> = {};
  const kindCounts: Record<string, number> = {};
  const severityCounts: Record<string, number> = {};
  const pendingStatusCounts: Record<string, number> = {};
  for (const record of records) tableCounts[record.sourceTable] = (tableCounts[record.sourceTable] ?? 0) + 1;
  for (const fact of facts) kindCounts[fact.kind] = (kindCounts[fact.kind] ?? 0) + 1;
  for (const exception of exceptions) severityCounts[exception.severity] = (severityCounts[exception.severity] ?? 0) + 1;
  for (const record of records) {
    const pending = record.normalized.pendingReconciliation;
    if (!pending || typeof pending !== "object") continue;
    const dimensions = (pending as { dimensions?: Record<string, { status?: string }> }).dimensions;
    if (!dimensions) continue;
    for (const [name, dimension] of Object.entries(dimensions)) {
      const key = `${name}:${dimension.status ?? "unknown"}`;
      pendingStatusCounts[key] = (pendingStatusCounts[key] ?? 0) + 1;
    }
  }
  const formulaCount = records.reduce((sum, record) => sum + [...record.formatted.values()].flat().filter((cell) => cell.formula !== null).length, 0);
  const unresolvedFormulaCount = records.reduce((sum, record) => sum + record.exceptions.filter((item) => item.kind === "formula_result_unresolved").length, 0);
  return {
    recordCount: records.length,
    factCount: facts.length,
    exceptionCount: exceptions.length,
    reviewExceptionCount: exceptions.filter((item) => item.severity === "review").length,
    blockingExceptionCount: exceptions.filter((item) => item.severity === "blocking").length,
    archiveOnlyRecordCount: records.filter((record) => record.treatment === "archive_only").length,
    overlapEvidenceRecordCount: records.filter((record) => record.treatment === "overlap_evidence").length,
    tableCounts,
    kindCounts,
    severityCounts,
    pendingStatusCounts,
    movementOverlap,
    globalDeltaBlockingCount: capture.deltaEvidence.length,
    formulaCount,
    unresolvedFormulaCount,
  };
}

function buildHistoryCoverage(capture: LoadedAppSheetHistoryCapture, definition: AppSheetHistoryDefinition,
  records: readonly PreparedRecord[], facts: readonly PreparedFact[], exceptions: readonly PersistedException[], metrics: PreparedAppSheetHistoryProjection["metrics"]): Record<string, unknown> {
  const recordCounts = new Map<string, number>();
  const archiveCounts = new Map<string, number>();
  const overlapCounts = new Map<string, number>();
  const exceptionCounts = new Map<string, { blocking: number; review: number }>();
  const formulaCounts = new Map<string, { formula: number; unresolved: number }>();
  for (const record of records) {
    recordCounts.set(record.sourceTable, (recordCounts.get(record.sourceTable) ?? 0) + 1);
    if (record.treatment === "archive_only") archiveCounts.set(record.sourceTable, (archiveCounts.get(record.sourceTable) ?? 0) + 1);
    if (record.treatment === "overlap_evidence") overlapCounts.set(record.sourceTable, (overlapCounts.get(record.sourceTable) ?? 0) + 1);
    const c = formulaCounts.get(record.sourceTable) ?? { formula: 0, unresolved: 0 };
    c.formula += [...record.formatted.values()].flat().filter((cell) => cell.formula !== null).length;
    c.unresolved += record.exceptions.filter((item) => item.kind === "formula_result_unresolved").length;
    formulaCounts.set(record.sourceTable, c);
    for (const item of record.exceptions) {
      const counts = exceptionCounts.get(record.sourceTable) ?? { blocking: 0, review: 0 };
      counts[item.severity]++;
      exceptionCounts.set(record.sourceTable, counts);
    }
  }
  const factCounts = new Map<string, number>();
  for (const fact of facts) factCounts.set(fact.sourceTable, (factCounts.get(fact.sourceTable) ?? 0) + 1);
  const pageBySheet = new Map<number, PageRef[]>();
  for (const page of capture.manifest.pages) {
    const items = pageBySheet.get(page.sheetId) ?? [];
    items.push(page);
    pageBySheet.set(page.sheetId, items);
  }
  const tableCoverage = capture.headers.sheets.map((sheet) => {
    const count = capture.manifest.coverage.sheets.find((entry) => entry.sheetId === sheet.sheetId);
    const pages = pageBySheet.get(sheet.sheetId) ?? [];
    const formula = formulaCounts.get(sheet.title) ?? { formula: 0, unresolved: 0 };
    const exception = exceptionCounts.get(sheet.title) ?? { blocking: 0, review: 0 };
    const safeCount = (value: unknown, fallback: number, errorCode: string): number => {
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(errorCode);
      return value;
    };
    const totalFormulaCount = safeCount(count?.formulaCellCount, formula.formula, "coverage_formula_count_invalid");
    const totalUnresolvedFormulaCount = safeCount(count?.unresolvedFormulaCount, formula.unresolved, "coverage_unresolved_formula_count_invalid");
    return {
      sourceTable: sheet.title,
      sheetId: sheet.sheetId,
      hidden: sheet.hidden,
      mode: sheet.mode,
      bodyExcluded: sheet.bodyExcluded === true,
      headerRow: sheet.headerRow,
      pageCount: pages.length,
      populatedSourceRows: recordCounts.get(sheet.title) ?? 0,
      sourceRecordCount: recordCounts.get(sheet.title) ?? 0,
      factCount: factCounts.get(sheet.title) ?? 0,
      archiveOnlyCount: archiveCounts.get(sheet.title) ?? 0,
      overlapEvidenceCount: overlapCounts.get(sheet.title) ?? 0,
      blockingExceptionCount: exception.blocking,
      reviewExceptionCount: exception.review,
      formulaCount: totalFormulaCount,
      sourceRecordFormulaCount: formula.formula,
      headerFormulaCount: Math.max(0, totalFormulaCount - formula.formula),
      unresolvedFormulaCount: totalUnresolvedFormulaCount,
      sourceRecordUnresolvedFormulaCount: formula.unresolved,
      headerUnresolvedFormulaCount: Math.max(0, totalUnresolvedFormulaCount - formula.unresolved),
      changedPageIndexes: pages.filter((page) => !page.stable).map((page) => page.pageIndex),
      definitionTableMatch: sheetDefinitionMatch(definition.inventory, sheet.title),
    };
  });
  return {
    schemaVersion: "appsheet-history-coverage/v1",
    projectionKind: "history",
    sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    captureId: capture.manifest.captureId,
    manifestHash: capture.manifest.manifestHash,
    dataHash: capture.manifest.dataHash,
    captureDefinitionHash: capture.manifest.definitionHash,
    appliedDefinitionHash: definition.appliedDefinitionHash,
    mode: capture.mode,
    window: {
      firstReadAt: capture.manifest.firstReadAt,
      verificationStartedAt: capture.manifest.verificationStartedAt,
      verificationCompletedAt: capture.manifest.verificationCompletedAt,
      cutoffAt: capture.manifest.cutoffAt,
      timestampGaps: capture.manifest.timestampGaps,
    },
    stability: capture.manifest.stability,
    source: {
      spreadsheetId: capture.manifest.spreadsheetId,
      metadataHash: capture.manifest.metadataHash,
      headersHash: capture.manifest.headersHash,
      dataSheetCount: capture.manifest.dataSheetCount,
      dataPageCount: capture.manifest.dataPageCount,
      dataRecordCount: capture.manifest.dataRecordCount,
      dataFormulaCount: capture.manifest.dataFormulaCount,
      dataUnresolvedFormulaCount: capture.manifest.dataUnresolvedFormulaCount,
      sourceRecordFormulaCount: metrics.formulaCount,
      sourceRecordUnresolvedFormulaCount: metrics.unresolvedFormulaCount,
      headerFormulaCount: Math.max(0, capture.manifest.dataFormulaCount - metrics.formulaCount),
      headerUnresolvedFormulaCount: Math.max(0, capture.manifest.dataUnresolvedFormulaCount - metrics.unresolvedFormulaCount),
    },
    definition: {
      fileSha256: definition.fileSha256,
      sourceSha256: definition.sourceSha256,
      descriptorSha256: definition.descriptorSha256,
      appliedDefinitionHash: definition.appliedDefinitionHash,
      identityState: definition.identityState,
      counts: definition.inventory.observedCounts,
      inventory: definition.inventory,
    },
    sheets: tableCoverage,
    pages: capture.manifest.pages.map((page) => ({ sheetId: page.sheetId, title: page.title, pageIndex: page.pageIndex,
      startRow: page.startRow, endRow: page.endRow, pageHash: page.pageHash, verifiedPageHash: page.verifiedPageHash, stable: page.stable })),
    deltaEvidence: capture.deltaEvidence,
    totals: metrics,
    exceptionTotal: exceptions.length,
  };
}

/** Build complete traceable source records and historical facts without touching a database. */
export function prepareAppSheetHistoryProjection(capture: LoadedAppSheetHistoryCapture, definition: AppSheetHistoryDefinition): PreparedAppSheetHistoryProjection {
  if (capture.manifest.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || definition.appliedDefinitionHash !== digest({
    sourceSha256: definition.inventory.source.sha256, descriptorSha256: definition.inventory.descriptorSha256,
  }) || definition.inventory.app.id !== null && definition.inventory.app.id !== APPSHEET_EXPECTED_LIVE_APP_ID)
    fail("projection_identity_invalid");
  const snapshotId = deterministicUuid({ sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, fileHash: capture.manifest.manifestHash,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION });
  const deltaByPage = new Map(capture.deltaEvidence.map((page) => [`${page.sheetId}\0${page.pageIndex}`, page]));
  const records: PreparedRecord[] = [];
  for (const page of capture.pages) {
    const headerSheet = capture.headers.sheets.find((sheet) => sheet.sheetId === page.sheet.sheetId);
    if (!headerSheet || headerSheet.bodyExcluded === true || headerSheet.title !== page.sheet.title) fail("projection_sheet_header_missing");
    const delta = deltaByPage.get(`${page.sheet.sheetId}\0${page.page.index}`);
    for (const row of page.rows) {
      if (row.sourceRow === headerSheet.headerRow || !row.cells.some(populatedCell)) continue;
      records.push(rowRecord({ page, row, headerSheet, snapshotId, manifestHash: capture.manifest.manifestHash, deltaEvidence: delta }));
      if (records.length > APPSHEET_HISTORY_MAX_RECORDS) fail("projection_record_limit_exceeded");
    }
  }
  if (records.length !== capture.manifest.dataRecordCount) fail("projection_record_coverage_mismatch");
  addDuplicateKeyExceptions(records);
  resolveRelationships(records);
  const movementOverlap = compareMovements(records);
  attachPendingReconciliation(records, capture);
  // The first pass records parse and semantic exceptions; then the source hash
  // is sealed and facts are regenerated against that exact immutable hash.
  for (const record of records) makeHistoricalFact(record);
  for (const record of records) sealSourceRecord(record);
  const facts = records.map(makeHistoricalFact);
  const globalExceptions = globalDeltaExceptions(snapshotId, capture);
  const exceptions = snapshotExceptions(snapshotId, records, globalExceptions);
  const metrics = stageMetrics(records, facts, exceptions, movementOverlap, capture);
  const coverage = buildHistoryCoverage(capture, definition, records, facts, exceptions, metrics);
  const persistedRecords: Prisma.LegacySourceRecordCreateManyInput[] = records.map((record) => ({
    id: record.id, snapshotId, sourceTable: record.sourceTable, sourceKey: record.sourceKey, sourceRow: record.sourceRow,
    fileHash: record.fileHash, contentHash: record.contentHash, importerVersion: record.importerVersion,
    original: asInputJson(record.original), normalized: asInputJson(record.normalized), treatment: record.treatment,
  }));
  const persistedFacts: Prisma.LegacyHistoricalFactCreateManyInput[] = facts.map((fact) => ({
    id: fact.id, snapshotId, sourceRecordId: fact.sourceRecordId, sourceTable: fact.sourceTable, sourceKey: fact.sourceKey,
    sourceRow: fact.sourceRow, sourceHash: fact.sourceHash, mappingId: fact.mappingId, kind: fact.kind,
    occurredOn: fact.occurredOn, dateState: fact.dateState, currency: fact.currency, currencyState: fact.currencyState,
    unit: fact.unit, unitState: fact.unitState, amountMinor: fact.amountMinor, amountState: fact.amountState,
    quantity: fact.quantity, quantityState: fact.quantityState, attributes: fact.attributes, createdBy: fact.createdBy,
  }));
  const recordsHash = digest(persistedRecords.map((record) => ({ id: record.id, sourceTable: record.sourceTable, sourceKey: record.sourceKey,
    sourceRow: record.sourceRow, fileHash: record.fileHash, contentHash: record.contentHash, importerVersion: record.importerVersion,
    original: record.original, normalized: record.normalized, treatment: record.treatment })));
  const factsHash = digest(facts.map(compactFact));
  const exceptionsHash = digest(exceptions);
  const projectionHash = digest({
    schemaVersion: "appsheet-history-projection/v1", sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, mappingId: APPSHEET_HISTORY_MAPPING_ID,
    captureId: capture.manifest.captureId, manifestHash: capture.manifest.manifestHash, dataHash: capture.manifest.dataHash,
    captureDefinitionHash: capture.manifest.definitionHash, appliedDefinitionHash: definition.appliedDefinitionHash,
    definitionSourceSha256: definition.sourceSha256, definitionDescriptorSha256: definition.descriptorSha256,
    definitionFileSha256: definition.fileSha256, definitionIdentityState: definition.identityState,
    recordsHash, factsHash, exceptionsHash, coverageHash: appSheetHistoryCoverageFingerprint(coverage),
  });
  return {
    snapshotId, capture, definition, projectionHash, coverage, controls: {}, persistedRecords, persistedFacts, exceptions,
    metrics,
  };
}

function buildStageControls(prepared: PreparedAppSheetHistoryProjection, backup: { manifestHash: string; snapshotAt: string }, review: z.infer<typeof appSheetTechnicalReviewSchema>, commitSha: string,
  actorId: string, recordsHash: string, factsHash: string, exceptionsHash: string): Record<string, unknown> {
  return {
    appSheetHistoryStage: {
      schemaVersion: "appsheet-history-stage/v1",
      projectionKind: "history",
      sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
      mappingId: APPSHEET_HISTORY_MAPPING_ID,
      importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
      captureId: prepared.capture.manifest.captureId,
      manifestHash: prepared.capture.manifest.manifestHash,
      dataHash: prepared.capture.manifest.dataHash,
      captureDefinitionHash: prepared.capture.manifest.definitionHash,
      definitionHash: prepared.definition.appliedDefinitionHash,
      definitionSourceSha256: prepared.definition.sourceSha256,
      definitionDescriptorSha256: prepared.definition.descriptorSha256,
      definitionFileSha256: prepared.definition.fileSha256,
      definitionIdentityState: prepared.definition.identityState,
      definitionInventory: prepared.definition.inventory,
      mode: prepared.capture.mode,
      projectionHash: prepared.projectionHash,
      recordsHash,
      factsHash,
      exceptionsHash,
      technicalReview: {
        reviewKind: review.reviewKind,
        reviewer: review.reviewer,
        reviewedAt: review.reviewedAt,
        approved: review.approved,
        findingsCount: review.findings.length,
        findingsHash: digest(review.findings),
        commitSha,
      },
      humanReview: { status: "pending" },
      operationalAuthority: { status: "unchanged" },
      backupManifestHash: backup.manifestHash,
      backupSnapshotAt: backup.snapshotAt,
      actor: ACTOR,
      actorUserId: actorId,
      authorizationContext: "user-authorized-plan",
      reviewedBy: null,
      reviewedAt: null,
      status: "staged",
      effects: {
        stock: false, cashLedger: false, payments: false, deliveries: false, messages: false, documents: false,
        numbering: "not-generated",
      },
      metrics: prepared.metrics,
    },
  };
}

type AppSheetHistoryStageOptions = {
  actorId: string;
  technicalReview: unknown;
  commitSha: string;
  allowStagedDelta?: boolean;
  target: "isolated-test" | "production";
  backupEvidence: { manifestHash: string; snapshotAt: string };
};

function validateAppSheetHistoryReview(
  prepared: PreparedAppSheetHistoryProjection,
  input: unknown,
  commitSha: string,
  actorId?: string,
): z.infer<typeof appSheetTechnicalReviewSchema> {
  if (!/^[a-f0-9]{40}$/.test(commitSha)) fail("commit_sha_invalid");
  let review: z.infer<typeof appSheetTechnicalReviewSchema>;
  try {
    review = requireAppSheetTechnicalReview(input, {
      captureId: prepared.capture.manifest.captureId,
      manifestHash: prepared.capture.manifest.manifestHash,
      definitionHash: prepared.definition.appliedDefinitionHash,
      projectionKind: "history",
      projectionHash: prepared.projectionHash,
      commitSha,
      importer: APPSHEET_HISTORY_IMPORTER_VERSION,
    });
  } catch {
    fail("technical_review_invalid");
  }
  if (actorId && review.reviewer.trim().toLowerCase() === actorId.trim().toLowerCase())
    fail("independent_technical_reviewer_required");
  return review;
}

function stableCaptureManifest(prepared: PreparedAppSheetHistoryProjection): PreparedAppSheetCaptureManifest {
  if (prepared.capture.mode !== "stable") fail("preliminary_capture_cannot_be_registered");
  try {
    const projection = prepareAppSheetProjectionCaptureManifest(prepared.capture.manifest, { mode: "stable" });
    return prepareAppSheetCaptureManifest({
      schemaVersion: "appsheet-capture-manifest/v1",
      ...projection,
      coverage: projection.dataCoverage,
      pages: projection.pageManifest,
    });
  } catch {
    fail("stable_capture_manifest_invalid");
  }
}

async function assertHistoryStageActor(tx: Prisma.TransactionClient, actorId: string): Promise<{ id: string }> {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, active: true } });
  if (!actor?.active || (actor.role !== "owner" && actor.role !== "admin")) fail("active_admin_actor_required");
  const grant = await tx.operationAccess.findUnique({ where: { userId: actorId }, select: { enabled: true, capabilities: true } });
  if (!capabilitiesFromGrant(actor, grant).includes("imports.write")) fail("imports_write_capability_required");
  return actor;
}

function compactPersistedFact(fact: Record<string, unknown>): Record<string, unknown> {
  const { amountMinor, ...withoutAmount } = fact;
  if (amountMinor !== null && amountMinor !== undefined && typeof amountMinor !== "bigint" && typeof amountMinor !== "string")
    fail("history_fact_amount_hash_invalid");
  const { quantity, ...withoutQuantity } = withoutAmount;
  return {
    ...withoutQuantity,
    // Mirror compactFact: null is already distinguished by amountState and
    // cannot be passed to canonicalJson under its exact-money contract.
    ...(amountMinor === null || amountMinor === undefined ? {} : { amountMinor: String(amountMinor) }),
    ...(quantity === null || quantity === undefined ? {} : { quantity: String(quantity) }),
    attributes: omitNullExactHashFields(fact.attributes),
  };
}

function stageAuditDetails(prepared: PreparedAppSheetHistoryProjection, options: AppSheetHistoryStageOptions,
  review: z.infer<typeof appSheetTechnicalReviewSchema>): Record<string, unknown> {
  return {
    sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    captureId: prepared.capture.manifest.captureId,
    manifestHash: prepared.capture.manifest.manifestHash,
    dataHash: prepared.capture.manifest.dataHash,
    projectionHash: prepared.projectionHash,
    mode: prepared.capture.mode,
    recordCount: prepared.persistedRecords.length,
    factCount: prepared.persistedFacts.length,
    exceptionCount: prepared.exceptions.length,
    reviewer: review.reviewer,
    technicalReviewAt: review.reviewedAt,
    commitSha: options.commitSha,
    target: options.target,
    backupManifestHash: options.backupEvidence.manifestHash,
    backupSnapshotAt: options.backupEvidence.snapshotAt,
    authorizationContext: "user-authorized-plan",
    reviewedBy: null,
    status: "staged",
  };
}

function expectedSnapshotControls(prepared: PreparedAppSheetHistoryProjection, options: AppSheetHistoryStageOptions,
  review: z.infer<typeof appSheetTechnicalReviewSchema>): Record<string, unknown> {
  const backup = options.backupEvidence;
  const recordsHash = digest(prepared.persistedRecords);
  const factsHash = digest(prepared.persistedFacts.map((fact) => compactPersistedFact(fact as unknown as Record<string, unknown>)));
  const exceptionsHash = digest(prepared.exceptions);
  return buildStageControls(prepared, backup, review, options.commitSha, options.actorId, recordsHash, factsHash, exceptionsHash);
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return stableComparableJson(left) === stableComparableJson(right);
}

function compareHistoryRowId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Compare persisted JSON structurally; exactJson is reserved for validated financial payloads. */
function stableComparableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("json_comparison_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(stableComparableJson).join(",") + "]";
  if (typeof value !== "object") fail("json_comparison_invalid");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("json_comparison_invalid");
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).sort().map((key) => JSON.stringify(key) + ":" + stableComparableJson(object[key])).join(",") + "}";
}

async function existingHistorySnapshotMatches(
  tx: Prisma.TransactionClient,
  prepared: PreparedAppSheetHistoryProjection,
  options: AppSheetHistoryStageOptions,
  actorId: string,
  review: z.infer<typeof appSheetTechnicalReviewSchema>,
  captureManifestId: string | null,
  controls: Record<string, unknown>,
  coverage: Record<string, unknown>,
): Promise<boolean> {
  const snapshot = await tx.legacyImportSnapshot.findUnique({ where: { id: prepared.snapshotId } });
  if (!snapshot) return false;
  if (snapshot.sourceSystem !== APPSHEET_HISTORY_SOURCE_SYSTEM || snapshot.filename !== "appsheet-live-capture" ||
      snapshot.fileHash !== prepared.capture.manifest.manifestHash || snapshot.importerVersion !== APPSHEET_HISTORY_IMPORTER_VERSION ||
      snapshot.captureManifestId !== captureManifestId || snapshot.status !== "staged" || snapshot.reviewedBy !== null ||
      snapshot.reviewedAt !== null || snapshot.createdBy !== actorId || !sameCanonical(snapshot.controls, controls) ||
      !sameCanonical(snapshot.coverage, coverage)) fail("existing_history_snapshot_conflict");

  const [storedRecords, storedFacts, storedExceptions, object, audit] = await Promise.all([
    tx.$queryRaw<Array<{
      id: string; snapshotId: string; sourceTable: string; sourceKey: string; sourceRow: number; fileHash: string;
      contentHash: string; importerVersion: string; originalText: string; normalizedText: string; treatment: string;
    }>>(Prisma.sql`
      SELECT "id", "snapshotId", "sourceTable", "sourceKey", "sourceRow", "fileHash", "contentHash", "importerVersion",
        "original"::text AS "originalText", "normalized"::text AS "normalizedText", "treatment"
      FROM "LegacySourceRecord"
      WHERE "snapshotId" = ${snapshot.id}
    `),
    tx.legacyHistoricalFact.findMany({ where: { snapshotId: snapshot.id } }),
    tx.legacyException.findMany({ where: { snapshotId: snapshot.id } }),
    tx.operationObject.findUnique({ where: { id: snapshot.id }, select: { id: true, kind: true, version: true, createdBy: true } }),
    tx.operationAudit.findFirst({ where: { objectId: snapshot.id, action: STAGE_ACTION }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
  ]);
  const expectedRecords = [...prepared.persistedRecords].sort(compareHistoryRowId);
  const expectedFacts = [...prepared.persistedFacts].sort(compareHistoryRowId);
  const expectedExceptions = [...prepared.exceptions].sort(compareHistoryRowId);
  const actualRecords = storedRecords.map((record) => ({
    id: record.id, snapshotId: record.snapshotId, sourceTable: record.sourceTable, sourceKey: record.sourceKey,
    sourceRow: record.sourceRow, fileHash: record.fileHash, contentHash: record.contentHash, importerVersion: record.importerVersion,
    original: JSON.parse(record.originalText), normalized: JSON.parse(record.normalizedText), treatment: record.treatment,
  })).sort(compareHistoryRowId);
  const actualFacts = storedFacts.map((fact) => compactPersistedFact({
    id: fact.id, snapshotId: fact.snapshotId, sourceRecordId: fact.sourceRecordId, sourceTable: fact.sourceTable, sourceKey: fact.sourceKey,
    sourceRow: fact.sourceRow, sourceHash: fact.sourceHash, mappingId: fact.mappingId, kind: fact.kind, occurredOn: fact.occurredOn,
    dateState: fact.dateState, currency: fact.currency, currencyState: fact.currencyState, unit: fact.unit, unitState: fact.unitState,
    amountMinor: fact.amountMinor, amountState: fact.amountState, quantity: fact.quantity, quantityState: fact.quantityState,
    attributes: fact.attributes, createdBy: fact.createdBy,
  })).sort(compareHistoryRowId);
  const actualExceptions = storedExceptions.map((exception) => ({
    id: exception.id, sourceRecordId: exception.sourceRecordId, kind: exception.kind, severity: exception.severity,
    description: exception.description, resolution: exception.resolution, status: exception.status,
    resolvedBy: exception.resolvedBy, resolvedAt: exception.resolvedAt,
  })).sort(compareHistoryRowId);
  const expectedFactsCanonical = expectedFacts.map((fact) => compactPersistedFact(fact as unknown as Record<string, unknown>));
  const expectedExceptionsCanonical = expectedExceptions.map((exception) => ({ ...exception, status: "open", resolvedBy: null, resolvedAt: null }));
  const auditDetails = stageAuditDetails(prepared, options, review);
  if (actualRecords.length !== expectedRecords.length || !sameCanonical(actualRecords, expectedRecords) ||
      actualFacts.length !== expectedFactsCanonical.length || !sameCanonical(actualFacts, expectedFactsCanonical) ||
      actualExceptions.length !== expectedExceptionsCanonical.length || !sameCanonical(actualExceptions, expectedExceptionsCanonical) ||
      !object || object.kind !== "legacyImport" || object.version !== 0 || object.createdBy !== actorId ||
      !audit || audit.actorId !== actorId || !sameCanonical(audit.details, auditDetails))
    fail("existing_history_snapshot_incomplete_or_changed");
  return true;
}

async function persistHistoryProjection(
  tx: Prisma.TransactionClient,
  prepared: PreparedAppSheetHistoryProjection,
  options: AppSheetHistoryStageOptions,
  review: z.infer<typeof appSheetTechnicalReviewSchema>,
): Promise<{ snapshotId: string; captureManifestId: string | null; status: "staged"; replay: boolean; metrics: PreparedAppSheetHistoryProjection["metrics"] }> {
  if (prepared.capture.mode === "preliminary-delta" && options.allowStagedDelta !== true) fail("staged_delta_requires_explicit_flag");
  if (!/^[a-f0-9]{64}$/.test(options.backupEvidence.manifestHash) || !Number.isFinite(Date.parse(options.backupEvidence.snapshotAt)))
    fail("verified_backup_required");
  const actor = await assertHistoryStageActor(tx, options.actorId);
  const currentReview = validateAppSheetHistoryReview(prepared, review, options.commitSha, actor.id);
  const captureManifestId = prepared.capture.mode === "stable"
    ? await ensureAppSheetCaptureManifest(tx, stableCaptureManifest(prepared)) : null;
  const controls = expectedSnapshotControls(prepared, options, currentReview);
  const coverage = prepared.coverage;
  const replay = await existingHistorySnapshotMatches(tx, prepared, options, actor.id, currentReview, captureManifestId, controls, coverage);
  if (replay) return { snapshotId: prepared.snapshotId, captureManifestId, status: "staged", replay: true, metrics: prepared.metrics };
  const duplicate = await tx.legacyImportSnapshot.findUnique({ where: { sourceSystem_fileHash_importerVersion: {
    sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, fileHash: prepared.capture.manifest.manifestHash,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
  } } });
  if (duplicate) fail("history_snapshot_unique_conflict");

  await tx.legacyImportSnapshot.create({ data: {
    id: prepared.snapshotId, sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM, filename: "appsheet-live-capture",
    fileHash: prepared.capture.manifest.manifestHash, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    status: "staged", createdBy: actor.id, reviewedBy: null, reviewedAt: null, captureManifestId,
    controls: asInputJson(controls), coverage: asInputJson(coverage),
  } });
  for (let start = 0; start < prepared.persistedRecords.length; start += 500) {
    const batch = prepared.persistedRecords.slice(start, start + 500);
    const inserted = await tx.$executeRaw(Prisma.sql`
      INSERT INTO "LegacySourceRecord" (
        "id", "snapshotId", "sourceTable", "sourceKey", "sourceRow", "fileHash", "contentHash", "importerVersion",
        "original", "normalized", "treatment"
      )
      SELECT incoming."id", incoming."snapshotId", incoming."sourceTable", incoming."sourceKey", incoming."sourceRow",
        incoming."fileHash", incoming."contentHash", incoming."importerVersion", incoming."original", incoming."normalized",
        incoming."treatment"
      FROM jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) AS incoming(
        "id" text, "snapshotId" text, "sourceTable" text, "sourceKey" text, "sourceRow" integer, "fileHash" text,
        "contentHash" text, "importerVersion" text, "original" jsonb, "normalized" jsonb, "treatment" text
      )
    `);
    if (inserted !== batch.length) fail("history_source_record_batch_count_mismatch");
  }
  for (let start = 0; start < prepared.persistedFacts.length; start += 500)
    await tx.legacyHistoricalFact.createMany({ data: prepared.persistedFacts.slice(start, start + 500) });
  for (let start = 0; start < prepared.exceptions.length; start += 500) {
    const batch = prepared.exceptions.slice(start, start + 500).map((exception) => ({
      ...exception, snapshotId: prepared.snapshotId, resolution: exception.resolution ?? Prisma.DbNull,
    }));
    await tx.legacyException.createMany({ data: batch });
  }
  await tx.operationObject.create({ data: { id: prepared.snapshotId, kind: "legacyImport", version: 0, createdBy: actor.id } });
  const auditDetails = stageAuditDetails(prepared, options, currentReview);
  await tx.operationAudit.create({ data: {
    actorId: actor.id,
    action: STAGE_ACTION,
    objectId: prepared.snapshotId,
    details: asInputJson(auditDetails),
  } });
  return { snapshotId: prepared.snapshotId, captureManifestId, status: "staged", replay: false, metrics: prepared.metrics };
}

/** Persist a reviewed technical projection as a staged, re-runnable history snapshot only. */
export async function stageAppSheetHistoryProjection(
  prepared: PreparedAppSheetHistoryProjection,
  options: AppSheetHistoryStageOptions,
  client?: PrismaClient,
): Promise<{ snapshotId: string; captureManifestId: string | null; status: "staged"; replay: boolean; metrics: PreparedAppSheetHistoryProjection["metrics"] }> {
  if (prepared.capture.mode === "preliminary-delta" && options.allowStagedDelta !== true) fail("staged_delta_requires_explicit_flag");
  if (!options.backupEvidence || !/^[a-f0-9]{64}$/.test(options.backupEvidence.manifestHash) ||
      !Number.isFinite(Date.parse(options.backupEvidence.snapshotAt))) fail("verified_backup_required");
  const review = validateAppSheetHistoryReview(prepared, options.technicalReview, options.commitSha, options.actorId);
  const db = client ?? (await import("../db.js")).db;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(
        (tx) => persistHistoryProjection(tx, prepared, options, review),
        { isolationLevel: "Serializable", timeout: 120_000, maxWait: 15_000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
        continue;
      }
      if (error instanceof AppSheetHistoryStageError) throw error;
      throw error;
    }
  }
}

export function appSheetHistoryProjectionReport(prepared: PreparedAppSheetHistoryProjection, status: "preview" | "staged" = "preview"):
  AppSheetHistoryProjectionReport {
  const coverage = prepared.coverage as {
    schemaVersion?: unknown; captureId?: unknown; manifestHash?: unknown; dataHash?: unknown; captureDefinitionHash?: unknown;
    appliedDefinitionHash?: unknown; mode?: unknown; window?: unknown; stability?: unknown; source?: unknown; sheets?: unknown;
    pages?: unknown; deltaEvidence?: unknown; totals?: unknown; exceptionTotal?: unknown; definition?: Record<string, unknown>;
  };
  const { inventory: _privateDefinitionInventory, ...definitionSummary } = coverage.definition ?? {};
  const safeCoverage = {
    schemaVersion: coverage.schemaVersion,
    captureId: coverage.captureId,
    manifestHash: coverage.manifestHash,
    dataHash: coverage.dataHash,
    captureDefinitionHash: coverage.captureDefinitionHash,
    appliedDefinitionHash: coverage.appliedDefinitionHash,
    mode: coverage.mode,
    window: coverage.window,
    stability: coverage.stability,
    source: coverage.source,
    definition: definitionSummary,
    sheets: coverage.sheets,
    pages: coverage.pages,
    deltaEvidence: coverage.deltaEvidence,
    totals: coverage.totals,
    exceptionTotal: coverage.exceptionTotal,
  };
  return {
    status,
    projectionKind: "history",
    sourceSystem: APPSHEET_HISTORY_SOURCE_SYSTEM,
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION,
    captureId: prepared.capture.manifest.captureId,
    mode: prepared.capture.mode,
    manifestHash: prepared.capture.manifest.manifestHash,
    dataHash: prepared.capture.manifest.dataHash,
    captureDefinitionHash: null,
    appliedDefinitionHash: prepared.definition.appliedDefinitionHash,
    definitionSourceSha256: prepared.definition.sourceSha256,
    definitionDescriptorSha256: prepared.definition.descriptorSha256,
    definitionFileSha256: prepared.definition.fileSha256,
    definitionIdentityState: prepared.definition.identityState,
    snapshotId: prepared.snapshotId,
    projectionHash: prepared.projectionHash,
    coverage: safeCoverage,
    metrics: prepared.metrics,
    cutoverEligible: false,
  };
}
