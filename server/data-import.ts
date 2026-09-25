import { createHash, createHmac, randomUUID } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { db } from "./db.js";
import {
  dataImportColumns,
  dataImportKinds,
  type DataImportBatchStatus,
  type DataImportColumn,
  type DataImportCommitResult,
  type DataImportFact,
  type DataImportFileInput,
  type DataImportInput,
  type DataImportInspection,
  type DataImportIssue,
  type DataImportKind,
  type DataImportMapping,
  type DataImportPreview,
  type HistoricalImportFact,
} from "../shared/data-import.js";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_PREVIEW_ROWS = 8;
const MAX_ERRORS = 250;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MIN_INT64 = -9_223_372_036_854_775_808n;
const SENSITIVE_HEADER = /health|medical|diagnos|patient|document|permit\s*(?:#|no\.?|number|document|copy|image|full)|(?:license|licence)\s*(?:#|no\.?|number|document)/i;
const EMAIL_VALUE = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/u;
const EXTERNAL_ID_FIELDS = new Set<DataImportColumn>([
  "sourceId", "parentSourceId", "productSourceId", "supplierSourceId", "locationSourceId",
]);
const INFLOW_CASH_CATEGORIES = new Set(["opening_balance", "sale", "capital_contribution", "delivery_receipt", "other_income"]);
const OUTFLOW_CASH_CATEGORIES = new Set(["operating_expense", "stock_purchase", "local_investment", "owner_draw", "other_outflow"]);

export class DataImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly row = 1,
    readonly field = "file",
  ) {
    super(message);
    this.name = "DataImportError";
  }
}

export class DataImportRejectedError extends DataImportError {
  constructor(readonly errors: DataImportIssue[], readonly conflicts: DataImportIssue[]) {
    super("La vista previa contiene errores o conflictos; no se importaron hechos.", "import_rejected");
    this.name = "DataImportRejectedError";
  }
}

export class DataImportConflictError extends DataImportError {
  constructor(readonly conflicts: DataImportIssue[]) {
    super("Hay IDs de origen existentes con datos diferentes; el lote se revirtió.", "source_conflict");
    this.name = "DataImportConflictError";
  }
}

interface SourceRow {
  row: number;
  values: Record<string, string>;
}

interface LoadedFile {
  sheets: string[];
  headers: string[];
  rows: SourceRow[];
}

export interface StoredDataImportFact {
  id: string;
  kind: DataImportFact["kind"];
  sourceId: string;
  factHash: string;
}

export interface StoredDataImportProvenance {
  id: string;
  batchId: string;
  factKind: DataImportFact["kind"];
  sourceSystem: string;
  sourceId: string;
  factHash: string;
  disposition: "inserted" | "skipped";
}

export interface StoredDataImportBatch {
  id: string;
  idempotencyKey: string;
  kind: DataImportKind;
  sourceSystem: string;
  fileHash: string;
  mappingVersion: string;
  cutoff: string;
  status: DataImportBatchStatus;
  mapping: DataImportMapping;
  facts: DataImportFact[];
  factsHash: string;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  errors: DataImportIssue[];
  conflicts: DataImportIssue[];
  insertedCount: number;
  skippedCount: number;
  importedAt: string | null;
}

export interface DataImportTransaction {
  getBatchForUpdate(batchId: string): Promise<StoredDataImportBatch | null>;
  findFacts(sourceSystem: string, facts: DataImportFact[]): Promise<Map<string, StoredDataImportFact>>;
  findParentIds(
    parentKind: "delivery_sale" | "purchase_receipt",
    sourceSystem: string,
    sourceIds: string[],
  ): Promise<Map<string, string>>;
  insertFact(
    sourceSystem: string,
    fact: DataImportFact,
    factHash: string,
    parentId?: string,
  ): Promise<void>;
  insertProvenance(
    batchId: string,
    sourceSystem: string,
    fact: DataImportFact,
    factHash: string,
    disposition: StoredDataImportProvenance["disposition"],
  ): Promise<void>;
  markImported(batchId: string, actorId: string, inserted: number, skipped: number): Promise<void>;
}

export interface DataImportRepository {
  findBatchByIdempotencyKey(key: string): Promise<StoredDataImportBatch | null>;
  createBatch(batch: StoredDataImportBatch): Promise<StoredDataImportBatch>;
  findFacts(sourceSystem: string, facts: DataImportFact[]): Promise<Map<string, StoredDataImportFact>>;
  transaction<T>(work: (tx: DataImportTransaction) => Promise<T>): Promise<T>;
}

class RowIssue extends Error {
  constructor(readonly field: string, readonly code: string) {
    super(code);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function factKey(kind: DataImportFact["kind"], sourceId: string): string {
  return `${kind}\u0000${sourceId}`;
}

function factDigest(fact: DataImportFact): string {
  return sha256(stableStringify(fact));
}

function dateOnly(value: string, field: string): string {
  if (typeof value !== "string") throw new RowIssue(field, "invalid_date");
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new RowIssue(field, "invalid_date");
  const [year, month, day] = text.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day)
    throw new RowIssue(field, "invalid_date");
  return text;
}

function decimalInteger(value: string, scale: number, decimalSeparator: "." | ",", field: string): bigint {
  let text = value.trim().replace(/[\s\u00a0]/g, "");
  if (!text || text.length > 80) throw new RowIssue(field, "invalid_number");
  const groupSeparator = decimalSeparator === "." ? "," : ".";
  const pieces = text.split(decimalSeparator);
  if (pieces.length > 2) throw new RowIssue(field, "invalid_number");
  let whole = pieces[0]!;
  if (whole.includes(groupSeparator)) {
    const grouped = new RegExp(`^-?\\d{1,3}(?:${groupSeparator === "." ? "\\." : ","}\\d{3})+$`);
    if (!grouped.test(whole)) throw new RowIssue(field, "invalid_number");
    whole = whole.replaceAll(groupSeparator, "");
  }
  const fraction = pieces[1] ?? "";
  if (!/^-?\d+$/.test(whole) || (fraction && !/^\d+$/.test(fraction)) || fraction.length > scale)
    throw new RowIssue(field, "invalid_number");
  const negative = whole.startsWith("-");
  const digits = negative ? whole.slice(1) : whole;
  const multiplier = 10n ** BigInt(scale);
  const frac = BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  const result = BigInt(digits) * multiplier + frac;
  return negative ? -result : result;
}

function ensureInt64(value: bigint, field: string): string {
  if (value < MIN_INT64 || value > MAX_INT64) throw new RowIssue(field, "out_of_range");
  return value.toString();
}

function money(value: string, mapping: DataImportMapping, field: string, signed = false): string {
  const result = decimalInteger(value, 2, mapping.decimalSeparator ?? ".", field);
  if (!signed && result < 0n) throw new RowIssue(field, "must_be_nonnegative");
  return ensureInt64(result, field);
}

function milliunits(value: string, mapping: DataImportMapping, field: string, allowZero = false): string {
  const result = decimalInteger(value, 3, mapping.decimalSeparator ?? ".", field);
  if (result < 0n || (!allowZero && result === 0n))
    throw new RowIssue(field, allowZero ? "must_be_nonnegative" : "must_be_positive");
  return ensureInt64(result, field);
}

function base64Bytes(contentBase64: string): Buffer {
  if (typeof contentBase64 !== "string" || !contentBase64 || contentBase64.length > Math.ceil(MAX_FILE_BYTES * 1.4))
    throw new DataImportError("El archivo está vacío o supera el límite permitido.", "invalid_file_size");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64))
    throw new DataImportError("El contenido base64 no es válido.", "invalid_base64");
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES)
    throw new DataImportError("El archivo está vacío o supera el límite de 5 MiB.", "invalid_file_size");
  return bytes;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    if ("formula" in object || "sharedFormula" in object)
      throw new DataImportError("No se aceptan fórmulas en archivos XLSX.", "formula_not_allowed");
    if (Array.isArray(object.richText))
      return object.richText.map((part) => String((part as { text?: unknown }).text ?? "")).join("").trim();
    if ("text" in object && typeof object.text === "string") return object.text.trim();
    return "";
  }
  return String(value).trim();
}

function isSensitiveHeader(header: string): boolean {
  return SENSITIVE_HEADER.test(header.replaceAll("_", " ").replaceAll("-", " "));
}

function normalizedHeader(header: string): string {
  return header
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isPersonalIdentifierHeader(header: string): boolean {
  const normalized = normalizedHeader(header);
  return /(?:^| )(?:e ?mail|mail|correo(?: electronico)?|phone|telephone|telefono|celular|mobile|contact|address|direccion|domicilio|dni|passport|document(?:o)?(?: id| number| no)?|identification|identity|name|nombre)(?: |$)/.test(normalized) ||
    /(?:^| )(?:member|socio) (?:id|key|number|no)(?: |$)/.test(normalized);
}

function isExternalIdField(field: string): boolean {
  return EXTERNAL_ID_FIELDS.has(field as DataImportColumn);
}

function emailLike(value: string): boolean {
  return EMAIL_VALUE.test(value);
}

function memberPseudonymSecret(): string {
  const secret = process.env.DATA_IMPORT_PII_SECRET?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret || secret.length < 32)
    throw new DataImportError("La seudonimización de socios requiere DATA_IMPORT_PII_SECRET o JWT_SECRET de al menos 32 caracteres.", "member_pseudonym_key_required");
  return secret;
}

function csvDelimiter(bytes: Buffer): string {
  const firstLine = bytes.toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  return firstLine.includes(";") ? ";" : ",";
}

async function loadFile(file: DataImportFileInput): Promise<LoadedFile> {
  const bytes = base64Bytes(file.contentBase64);
  const extension = file.filename.toLowerCase().split(".").pop();
  if (extension === "csv") {
    if (file.sheetName) throw new DataImportError("sheetName sólo aplica a archivos XLSX.", "unexpected_sheet_name");
    try {
      const parsed = parseCsv(bytes, {
        columns: false,
        skip_empty_lines: true,
        bom: true,
        trim: true,
        delimiter: csvDelimiter(bytes),
        max_record_size: 256 * 1024,
      }) as string[][];
      const allHeaders = (parsed[0] ?? []).map((header) => String(header).trim());
      if (!allHeaders.length) throw new DataImportError("El CSV debe incluir una fila de encabezados.", "missing_headers");
      if (new Set(allHeaders).size !== allHeaders.length)
        throw new DataImportError("Hay encabezados duplicados.", "duplicate_headers");
      if (parsed.slice(1).some((row) => row.length !== allHeaders.length))
        throw new DataImportError("Las filas CSV no tienen la misma cantidad de columnas que el encabezado.", "column_count_mismatch");
      const headers = allHeaders.filter((header) => !isSensitiveHeader(header));
      const rows = parsed.slice(1, MAX_ROWS + 2).map((row, index) => {
        const values: Record<string, string> = {};
        for (const header of headers) {
          const column = allHeaders.indexOf(header);
          values[header] = String(row[column] ?? "").trim();
        }
        return { row: index + 2, values };
      });
      return { sheets: [], headers, rows };
    } catch (error) {
      if (error instanceof DataImportError) throw error;
      const parserError = error as { code?: unknown; records?: unknown; lines?: unknown };
      if (parserError.code === "CSV_RECORD_INCONSISTENT_FIELDS_LENGTH" || parserError.code === "CSV_RECORD_INCONSISTENT_COLUMNS") {
        const completedRecords = typeof parserError.records === "number" ? parserError.records : 1;
        const row = Math.max(2, completedRecords + 1);
        throw new DataImportError(
          "La fila CSV tiene una cantidad de columnas distinta al encabezado.",
          "column_count_mismatch",
          row,
          "row",
        );
      }
      throw new DataImportError("CSV inválido; verificá encabezados, comillas y separadores.", "invalid_csv");
    }
  }
  if (extension !== "xlsx")
    throw new DataImportError("Sólo se aceptan archivos CSV o XLSX.", "unsupported_file_type");
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS declares an ArrayBuffer-shaped Buffer that conflicts with the
    // generic Node Buffer types. Runtime input remains the validated Node Buffer.
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new DataImportError("No se pudo leer el archivo XLSX.", "invalid_xlsx");
  }
  const sheets = workbook.worksheets.map((worksheet) => worksheet.name);
  const worksheet = file.sheetName
    ? workbook.getWorksheet(file.sheetName)
    : workbook.worksheets[0];
  if (!worksheet) throw new DataImportError("La hoja solicitada no existe.", "sheet_not_found");
  const headerRow = worksheet.getRow(1);
  const allHeaders: { index: number; name: string }[] = [];
  for (let column = 1; column <= worksheet.columnCount; column++) {
    const header = cellText(headerRow.getCell(column).value);
    if (header) allHeaders.push({ index: column, name: header });
  }
  const seen = new Set<string>();
  for (const header of allHeaders) {
    if (seen.has(header.name)) throw new DataImportError("Hay encabezados duplicados.", "duplicate_headers");
    seen.add(header.name);
  }
  const visibleHeaders = allHeaders.filter(({ name }) => !isSensitiveHeader(name));
  const rows: SourceRow[] = [];
  // Visit populated rows by their actual positions; a row-number cutoff can hide sparse data.
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || rows.length > MAX_ROWS) return;
    const values: Record<string, string> = {};
    for (const header of visibleHeaders) values[header.name] = cellText(row.getCell(header.index).value);
    if (Object.values(values).some((value) => value !== "")) rows.push({ row: rowNumber, values });
  });
  return { sheets, headers: visibleHeaders.map(({ name }) => name), rows };
}

export async function inspectDataImportFile(input: DataImportFileInput): Promise<DataImportInspection> {
  const file = await loadFile(input);
  return {
    sheets: file.sheets,
    headers: file.headers,
    sampleRows: file.rows.slice(0, 5).map(({ values }) => Object.fromEntries(
      Object.entries(values).map(([header, value]) => [header, isSensitiveSampleHeader(header) || emailLike(value) ? "[redacted]" : value]),
    )),
  };
}

function isSensitiveSampleHeader(header: string): boolean {
  return /member.?key|member.?id|socio|email|phone|telephone|contact|address|direccion|dni|passport|medical|health|permit|name|nombre/i.test(header);
}

function validateInput(input: DataImportInput): { bytes: Buffer; cutoff: string; mapping: DataImportMapping; pseudonymSecret: string | null } {
  if (!input || typeof input !== "object") throw new DataImportError("La solicitud de importación no es válida.", "invalid_input");
  if (typeof input.kind !== "string" || !dataImportKinds.includes(input.kind as DataImportKind)) throw new DataImportError("Tipo de importación desconocido.", "invalid_kind");
  const pseudonymSecret = input.kind === "members" ? memberPseudonymSecret() : null;
  if (typeof input.sourceSystem !== "string" || !input.sourceSystem.trim() || input.sourceSystem.length > 120 || input.sourceSystem.includes("\u0000"))
    throw new DataImportError("sourceSystem debe tener entre 1 y 120 caracteres.", "invalid_source_system");
  if (typeof input.filename !== "string" || !input.filename.trim() || input.filename.length > 255)
    throw new DataImportError("filename debe tener entre 1 y 255 caracteres.", "invalid_filename");
  if (!input.mapping || typeof input.mapping !== "object" || !input.mapping.columns || typeof input.mapping.columns !== "object" || Array.isArray(input.mapping.columns))
    throw new DataImportError("El mapeo de columnas no es válido.", "invalid_mapping");
  if (typeof input.mapping.version !== "string" || !input.mapping.version.trim() || input.mapping.version.length > 120)
    throw new DataImportError("mapping.version es obligatorio y admite hasta 120 caracteres.", "invalid_mapping_version");
  if (input.mapping.decimalSeparator && ![".", ","].includes(input.mapping.decimalSeparator))
    throw new DataImportError("decimalSeparator debe ser punto o coma.", "invalid_decimal_separator");
  for (const [field, column] of Object.entries(input.mapping.columns)) {
    const supportedField = dataImportColumns.includes(field as DataImportColumn)
      ? field as DataImportColumn
      : field === "orderDate" ? "orderDate" : null;
    if (!supportedField || typeof column !== "string" || !column.trim())
      throw new DataImportError("El mapeo contiene una columna no reconocida.", "invalid_mapping_column");
    if (isSensitiveHeader(column))
      throw new DataImportError("No se permite mapear números de permiso ni documentos médicos.", "sensitive_mapping_blocked");
    if (supportedField !== "orderDate" && isExternalIdField(supportedField) && isPersonalIdentifierHeader(column))
      throw new DataImportError("No se permite usar columnas de contacto o identificadores personales como IDs históricos.",
        supportedField === "sourceId" ? "sensitive_source_id_mapping_blocked" : "sensitive_identifier_mapping_blocked");
  }
  const cutoff = dateOnly(input.cutoff, "cutoff");
  return { bytes: base64Bytes(input.contentBase64), cutoff, mapping: input.mapping, pseudonymSecret };
}

function stableMapping(mapping: DataImportMapping): DataImportMapping {
  return {
    version: mapping.version.trim(),
    columns: Object.fromEntries(Object.entries(mapping.columns).map(([field, column]) => [field, column!.trim()])) as DataImportMapping["columns"],
    ...(mapping.sheetName ? { sheetName: mapping.sheetName } : {}),
    ...(mapping.decimalSeparator ? { decimalSeparator: mapping.decimalSeparator } : {}),
  };
}

type DataImportMappingField = DataImportColumn | "orderDate";

function valueAt(row: SourceRow, mapping: DataImportMapping, field: DataImportMappingField): string {
  const column = mapping.columns[field];
  return column ? (row.values[column] ?? "").trim() : "";
}

function requiredText(row: SourceRow, mapping: DataImportMapping, field: DataImportColumn, max = 160): string {
  if (!mapping.columns[field]) throw new RowIssue(field, "mapping_missing");
  const value = valueAt(row, mapping, field);
  if (!value) throw new RowIssue(field, "required");
  if (value.length > max || /[\r\n\u0000]/.test(value)) throw new RowIssue(field, "invalid_text");
  if (isExternalIdField(field) && emailLike(value)) throw new RowIssue(field, "sensitive_value_blocked");
  if (/health\s*(?:record|document|file)|medical\s*(?:record|document)|diagnos|patient|permit\s*(?:number|no\.?|#|copy|image|document)|full\s*permit/i.test(value))
    throw new RowIssue(field, "sensitive_value_blocked");
  return value;
}

function validateCashMovementDirection(category: string, amountCents: string): void {
  const normalizedCategory = category.toLowerCase().replace(/[\s-]+/g, "_");
  const amount = BigInt(amountCents);
  if ((OUTFLOW_CASH_CATEGORIES.has(normalizedCategory) && amount > 0n) ||
      (INFLOW_CASH_CATEGORIES.has(normalizedCategory) && amount < 0n))
    throw new RowIssue("amount", "invalid_cash_direction");
}

function optionalText(
  row: SourceRow,
  mapping: DataImportMapping,
  field: DataImportMappingField,
  max = 160,
): string | null {
  if (!mapping.columns[field]) return null;
  const value = valueAt(row, mapping, field);
  if (!value) return null;
  if (value.length > max || /[\r\n\u0000]/.test(value)) throw new RowIssue(field, "invalid_text");
  if (isExternalIdField(field) && emailLike(value)) throw new RowIssue(field, "sensitive_value_blocked");
  if (/health\s*(?:record|document|file)|medical\s*(?:record|document)|diagnos|patient|permit\s*(?:number|no\.?|#|copy|image|document)|full\s*permit/i.test(value))
    throw new RowIssue(field, "sensitive_value_blocked");
  return value;
}

function rowKind(inputKind: DataImportKind, row: SourceRow, mapping: DataImportMapping): DataImportFact["kind"] {
  const type = valueAt(row, mapping, "recordType").toLowerCase().replaceAll("-", "_").trim();
  switch (inputKind) {
    case "delivery_sales":
      if (["line", "delivery_sale_line", "sale_line"].includes(type)) return "delivery_sale_line";
      if (["", "header", "sale", "delivery_sale"].includes(type)) return "delivery_sale";
      break;
    case "purchases":
      if (["line", "purchase_receipt_line", "receipt_line"].includes(type)) return "purchase_receipt_line";
      if (["", "header", "purchase", "purchase_receipt", "receipt"].includes(type)) return "purchase_receipt";
      break;
    case "stock":
      if (["stockout", "outage"].includes(type)) return "stockout";
      if (["", "observation", "stock_observation"].includes(type)) return "stock_observation";
      break;
    case "cash_reconciliation":
      if (!type || type === "cash_reconciliation") return "cash_reconciliation";
      break;
    case "cash_movements":
      if (!type || type === "cash_movement") return "cash_movement";
      break;
    case "expenses":
      if (!type || type === "expense") return "expense";
      break;
    case "promotions":
      if (!type || type === "promotion") return "promotion";
      break;
    case "members":
      if (!type || type === "member") return "member";
      break;
  }
  throw new RowIssue("recordType", "unsupported_record_type");
}

function sourceDate(row: SourceRow, mapping: DataImportMapping, cutoff: string): string {
  const date = dateOnly(requiredText(row, mapping, "date", 10), "date");
  if (date > cutoff) throw new RowIssue("date", "after_cutoff");
  return date;
}

function buildFact(
  input: DataImportInput,
  row: SourceRow,
  mapping: DataImportMapping,
  cutoff: string,
  pseudonymSecret: string | null,
): DataImportFact {
  const kind = rowKind(input.kind, row, mapping);
  const sourceId = requiredText(row, mapping, "sourceId", 200);
  if (kind === "member") {
    const memberToken = requiredText(row, mapping, "memberKey", 200);
    const statusValue = requiredText(row, mapping, "permitStatus", 40).toLowerCase();
    const permitStatuses: Record<string, string> = {
      active: "active", valid: "valid", expired: "expired", pending: "pending",
      revoked: "revoked", unknown: "unknown", missing: "missing",
      vigente: "valid", vencido: "expired", pendiente: "pending",
      revocado: "revoked", desconocido: "unknown", "sin datos": "missing",
    };
    const permitStatus = permitStatuses[statusValue];
    if (!permitStatus) throw new RowIssue("permitStatus", "invalid_permit_status");
    const expiryValue = optionalText(row, mapping, "permitExpiryDate", 10);
    const checkedValue = optionalText(row, mapping, "permitCheckedAt", 10);
    const permitExpiryDate = expiryValue ? dateOnly(expiryValue, "permitExpiryDate") : null;
    const permitCheckedAt = checkedValue ? dateOnly(checkedValue, "permitCheckedAt") : null;
    if (permitCheckedAt && permitCheckedAt > cutoff)
      throw new RowIssue("permitCheckedAt", "after_cutoff");
    if (!pseudonymSecret) throw new DataImportError("Falta la clave para seudonimizar socios.", "member_pseudonym_key_required");
    const pseudonym = (purpose: string, token: string) => createHmac("sha256", pseudonymSecret)
      .update(`${purpose}\u0000${input.sourceSystem}\u0000${token}`)
      .digest("hex");
    return {
      kind,
      sourceId: pseudonym("member-source-id", sourceId),
      memberKey: pseudonym("member-key", memberToken),
      permitStatus,
      permitExpiryDate,
      permitCheckedAt,
    };
  }

  const date = sourceDate(row, mapping, cutoff);
  switch (kind) {
    case "delivery_sale": {
      const totalCents = money(requiredText(row, mapping, "total", 80), mapping, "total");
      const discountRaw = optionalText(row, mapping, "discount", 80);
      const discountCents = discountRaw ? money(discountRaw, mapping, "discount") : "0";
      if (BigInt(totalCents) < 0n || BigInt(discountCents) < 0n || BigInt(discountCents) > BigInt(totalCents))
        throw new RowIssue("discount", "discount_exceeds_gross_total");
      return {
        kind,
        sourceId,
        date,
        totalCents,
        discountCents,
      };
    }
    case "delivery_sale_line": {
      const parentSourceId = requiredText(row, mapping, "parentSourceId", 200);
      const itemLabel = requiredText(row, mapping, "itemLabel");
      const quantityUnit = requiredText(row, mapping, "unit", 32);
      const unitPriceRaw = optionalText(row, mapping, "unitPrice", 80);
      return {
        kind,
        sourceId,
        date,
        parentSourceId,
        itemLabel,
        productSourceId: optionalText(row, mapping, "productSourceId", 200),
        quantityMilliunits: milliunits(requiredText(row, mapping, "quantity", 80), mapping, "quantity"),
        quantityUnit,
        unitPriceCents: unitPriceRaw ? money(unitPriceRaw, mapping, "unitPrice") : null,
        lineTotalCents: money(requiredText(row, mapping, "lineTotal", 80), mapping, "lineTotal"),
      };
    }
    case "purchase_receipt": {
      const orderDateRaw = optionalText(row, mapping, "orderDate", 10);
      const orderDate = orderDateRaw ? dateOnly(orderDateRaw, "orderDate") : null;
      if (orderDate && orderDate > cutoff) throw new RowIssue("orderDate", "after_cutoff");
      if (orderDate && orderDate > date) throw new RowIssue("orderDate", "after_receipt_date");
      return {
        kind,
        sourceId,
        date,
        orderDate,
        supplierSourceId: optionalText(row, mapping, "supplierSourceId", 200),
        totalCents: money(requiredText(row, mapping, "total", 80), mapping, "total"),
      };
    }
    case "purchase_receipt_line": {
      const unitCostRaw = optionalText(row, mapping, "unitPrice", 80);
      return {
        kind,
        sourceId,
        date,
        parentSourceId: requiredText(row, mapping, "parentSourceId", 200),
        itemLabel: requiredText(row, mapping, "itemLabel"),
        productSourceId: optionalText(row, mapping, "productSourceId", 200),
        quantityMilliunits: milliunits(requiredText(row, mapping, "quantity", 80), mapping, "quantity"),
        quantityUnit: requiredText(row, mapping, "unit", 32),
        unitCostCents: unitCostRaw ? money(unitCostRaw, mapping, "unitPrice") : null,
        lineTotalCents: money(requiredText(row, mapping, "lineTotal", 80), mapping, "lineTotal"),
      };
    }
    case "stock_observation":
      return {
        kind,
        sourceId,
        date,
        productSourceId: optionalText(row, mapping, "productSourceId", 200),
        itemLabel: requiredText(row, mapping, "itemLabel"),
        locationSourceId: optionalText(row, mapping, "locationSourceId", 200),
        quantityMilliunits: milliunits(requiredText(row, mapping, "quantity", 80), mapping, "quantity", true),
        quantityUnit: requiredText(row, mapping, "unit", 32),
      };
    case "stockout": {
      const lost = optionalText(row, mapping, "lostQuantity", 80);
      return {
        kind,
        sourceId,
        date,
        productSourceId: optionalText(row, mapping, "productSourceId", 200),
        itemLabel: requiredText(row, mapping, "itemLabel"),
        locationSourceId: optionalText(row, mapping, "locationSourceId", 200),
        lostQuantityMilliunits: lost ? milliunits(lost, mapping, "lostQuantity", true) : null,
        quantityUnit: lost ? requiredText(row, mapping, "unit", 32) : optionalText(row, mapping, "unit", 32),
      };
    }
    case "expense":
      return {
        kind,
        sourceId,
        date,
        category: requiredText(row, mapping, "category", 80),
        amountCents: money(requiredText(row, mapping, "amount", 80), mapping, "amount"),
      };
    case "promotion": {
      const endRaw = optionalText(row, mapping, "endDate", 10);
      const endDate = endRaw ? dateOnly(endRaw, "endDate") : null;
      if (endDate && endDate < date) throw new RowIssue("endDate", "before_start_date");
      const discountRaw = optionalText(row, mapping, "discount", 80);
      return {
        kind,
        sourceId,
        date,
        label: requiredText(row, mapping, "label"),
        endDate,
        discountCents: discountRaw ? money(discountRaw, mapping, "discount") : null,
      };
    }
    case "cash_reconciliation": {
      const expectedCents = money(requiredText(row, mapping, "expected", 80), mapping, "expected");
      const countedCents = money(requiredText(row, mapping, "counted", 80), mapping, "counted");
      return {
        kind,
        sourceId,
        date,
        account: requiredText(row, mapping, "account", 80),
        expectedCents,
        countedCents,
        varianceCents: ensureInt64(BigInt(countedCents) - BigInt(expectedCents), "variance"),
      };
    }
    case "cash_movement": {
      const amountCents = money(requiredText(row, mapping, "amount", 80), mapping, "amount", true);
      if (amountCents === "0") throw new RowIssue("amount", "must_be_nonzero");
      const category = requiredText(row, mapping, "category", 80);
      validateCashMovementDirection(category, amountCents);
      return {
        kind,
        sourceId,
        date,
        account: requiredText(row, mapping, "account", 80),
        category,
        amountCents,
      };
    }
  }
  throw new RowIssue("recordType", "unsupported_record_type");
}

function previewShape(batch: StoredDataImportBatch): DataImportPreview {
  return {
    batchId: batch.id,
    status: batch.status,
    kind: batch.kind,
    sourceSystem: batch.sourceSystem,
    fileHash: batch.fileHash,
    mappingVersion: batch.mappingVersion,
    cutoff: batch.cutoff,
    rowCount: batch.rowCount,
    acceptedCount: batch.acceptedCount,
    skipped: batch.skippedCount,
    errors: batch.errors,
    conflicts: batch.conflicts,
    sample: batch.facts.slice(0, MAX_PREVIEW_ROWS),
  };
}

function idempotencyKey(
  input: DataImportInput,
  fileHash: string,
  mapping: DataImportMapping,
  cutoff: string,
  pseudonymSecret: string | null,
): string {
  const canonicalInput = stableStringify({
    sourceSystem: input.sourceSystem.trim(),
    kind: input.kind,
    fileHash,
    cutoff,
    mapping,
    ...(input.kind === "members" ? { pseudonymizationVersion: "hmac-sha256-v1" } : {}),
  });
  return input.kind === "members" && pseudonymSecret
    ? createHmac("sha256", pseudonymSecret).update(canonicalInput).digest("hex")
    : sha256(canonicalInput);
}

function makeIssue(row: number, field: string, code: string): DataImportIssue {
  return { row, field, code };
}

export async function previewDataImport(
  input: DataImportInput,
  repository: DataImportRepository = prismaDataImportRepository,
): Promise<DataImportPreview> {
  const validated = validateInput(input);
  const mapping = stableMapping(validated.mapping);
  const fileHash = sha256(validated.bytes);
  const key = idempotencyKey(input, fileHash, mapping, validated.cutoff, validated.pseudonymSecret);
  const previous = await repository.findBatchByIdempotencyKey(key);
  if (previous) return previewShape(previous);

  const errors: DataImportIssue[] = [];
  let loaded: LoadedFile = { sheets: [], headers: [], rows: [] };
  try {
    loaded = await loadFile({ filename: input.filename, contentBase64: input.contentBase64, sheetName: mapping.sheetName });
  } catch (error) {
    const code = error instanceof DataImportError ? error.code : "invalid_file";
    errors.push(makeIssue(
      error instanceof DataImportError ? error.row : 1,
      error instanceof DataImportError ? error.field : "file",
      code,
    ));
  }
  if (!errors.length && loaded.rows.length > MAX_ROWS)
    errors.push(makeIssue(MAX_ROWS + 1, "file", "row_limit_exceeded"));
  if (!errors.length && !loaded.rows.length) errors.push(makeIssue(1, "file", "no_data_rows"));
  if (!errors.length) {
    for (const column of Object.values(mapping.columns)) {
      if (column && !loaded.headers.includes(column)) {
        errors.push(makeIssue(1, "mapping", "mapped_header_missing"));
        break;
      }
    }
  }

  const rowFacts: { row: number; fact: DataImportFact }[] = [];
  const seen = new Set<string>();
  if (!errors.length) {
    for (const row of loaded.rows) {
      try {
        const fact = buildFact(input, row, mapping, validated.cutoff, validated.pseudonymSecret);
        const uniqueKey = factKey(fact.kind, fact.sourceId);
        if (seen.has(uniqueKey)) throw new RowIssue("sourceId", "duplicate_source_id_in_file");
        seen.add(uniqueKey);
        rowFacts.push({ row: row.row, fact });
      } catch (error) {
        if (error instanceof RowIssue) errors.push(makeIssue(row.row, error.field, error.code));
        else errors.push(makeIssue(row.row, "row", "invalid_row"));
        if (errors.length >= MAX_ERRORS) break;
      }
    }
  }

  const facts = rowFacts.map(({ fact }) => fact);
  const conflicts: DataImportIssue[] = [];
  let skipped = 0;
  if (facts.length) {
    const existing = await repository.findFacts(input.sourceSystem.trim(), facts);
    for (const item of rowFacts) {
      const prior = existing.get(factKey(item.fact.kind, item.fact.sourceId));
      if (!prior) continue;
      if (prior.factHash === factDigest(item.fact)) skipped++;
      else conflicts.push(makeIssue(item.row, "sourceId", "source_conflict"));
    }
  }
  if (conflicts.length >= MAX_ERRORS) conflicts.length = MAX_ERRORS;

  const rejectedCount = errors.length + conflicts.length;
  const factsHash = sha256(stableStringify(facts));
  const batch: StoredDataImportBatch = {
    id: randomUUID(),
    idempotencyKey: key,
    kind: input.kind,
    sourceSystem: input.sourceSystem.trim(),
    fileHash,
    mappingVersion: mapping.version,
    cutoff: validated.cutoff,
    status: rejectedCount ? "rejected" : "ready",
    mapping,
    facts,
    factsHash,
    rowCount: loaded.rows.length,
    acceptedCount: facts.length,
    rejectedCount,
    errors,
    conflicts,
    insertedCount: 0,
    skippedCount: skipped,
    importedAt: null,
  };
  return previewShape(await repository.createBatch(batch));
}

export async function commitDataImport(
  input: { batchId: string },
  actorId: string,
  repository: DataImportRepository = prismaDataImportRepository,
): Promise<DataImportCommitResult> {
  if (!input || typeof input.batchId !== "string" || !input.batchId.trim())
    throw new DataImportError("batchId es obligatorio.", "invalid_batch_id");
  if (typeof actorId !== "string" || !actorId.trim())
    throw new DataImportError("actorId es obligatorio.", "invalid_actor_id");
  return repository.transaction(async (tx) => {
    const batch = await tx.getBatchForUpdate(input.batchId);
    if (!batch) throw new DataImportError("No existe la vista previa solicitada.", "batch_not_found");
    if (batch.status === "imported" || batch.status === "reconciled")
      return { batchId: batch.id, status: batch.status, inserted: batch.insertedCount, skipped: batch.skippedCount };
    if (batch.status !== "ready" || batch.errors.length || batch.conflicts.length)
      throw new DataImportRejectedError(batch.errors, batch.conflicts);
    if (sha256(stableStringify(batch.facts)) !== batch.factsHash)
      throw new DataImportError("La vista previa fue alterada; generá otra vista previa.", "preview_integrity_error");

    const existing = await tx.findFacts(batch.sourceSystem, batch.facts);
    const pending: DataImportFact[] = [];
    const insertedKeys = new Set<string>();
    let skipped = 0;
    const conflicts: DataImportIssue[] = [];
    for (let index = 0; index < batch.facts.length; index++) {
      const fact = batch.facts[index]!;
      const prior = existing.get(factKey(fact.kind, fact.sourceId));
      if (!prior) {
        pending.push(fact);
      } else if (prior.factHash === factDigest(fact)) {
        skipped++;
      } else {
        conflicts.push(makeIssue(index + 2, "sourceId", "source_conflict"));
      }
    }
    if (conflicts.length) throw new DataImportConflictError(conflicts);

    const pendingHeaders = pending.filter((fact) => fact.kind === "delivery_sale" || fact.kind === "purchase_receipt");
    const pendingOther = pending.filter((fact) => fact.kind !== "delivery_sale_line" && fact.kind !== "purchase_receipt_line" && fact.kind !== "delivery_sale" && fact.kind !== "purchase_receipt");
    let inserted = 0;
    for (const fact of [...pendingHeaders, ...pendingOther]) {
      await tx.insertFact(batch.sourceSystem, fact, factDigest(fact));
      insertedKeys.add(factKey(fact.kind, fact.sourceId));
      inserted++;
    }
    for (const { parentKind, lines } of [
      {
        parentKind: "delivery_sale" as const,
        lines: pending.filter((fact): fact is Extract<DataImportFact, { kind: "delivery_sale_line" }> => fact.kind === "delivery_sale_line"),
      },
      {
        parentKind: "purchase_receipt" as const,
        lines: pending.filter((fact): fact is Extract<DataImportFact, { kind: "purchase_receipt_line" }> => fact.kind === "purchase_receipt_line"),
      },
    ]) {
      const parentSourceIds = [...new Set(lines.map((fact) => fact.parentSourceId))];
      if (!lines.length) continue;
      const parents = await tx.findParentIds(parentKind, batch.sourceSystem, parentSourceIds);
      for (const fact of lines) {
        const parentId = parents.get(fact.parentSourceId);
        if (!parentId) throw new DataImportError("Falta el encabezado asociado a una línea histórica.", "parent_fact_missing");
        await tx.insertFact(batch.sourceSystem, fact, factDigest(fact), parentId);
        insertedKeys.add(factKey(fact.kind, fact.sourceId));
        inserted++;
      }
    }
    for (const fact of batch.facts) {
      await tx.insertProvenance(
        batch.id,
        batch.sourceSystem,
        fact,
        factDigest(fact),
        insertedKeys.has(factKey(fact.kind, fact.sourceId)) ? "inserted" : "skipped",
      );
    }
    await tx.markImported(batch.id, actorId, inserted, skipped);
    return { batchId: batch.id, status: "imported", inserted, skipped };
  });
}

interface RawBatchRow {
  id: string;
  idempotencyKey: string;
  kind: string;
  sourceSystem: string;
  fileHash: string;
  mappingVersion: string;
  cutoffDate: Date | string;
  status: string;
  mapping: unknown;
  facts: unknown;
  factsHash: string;
  rowCount: number;
  acceptedCount: number;
  rejectedCount: number;
  errors: unknown;
  conflicts: unknown;
  insertedCount: number;
  skippedCount: number;
  importedAt: Date | null;
}

const BATCH_SELECT = Prisma.sql`
  SELECT "id", "idempotencyKey", "kind", "sourceSystem", "fileHash", "mappingVersion",
    "cutoffDate", "status", "mapping", "facts", "factsHash", "rowCount", "acceptedCount",
    "rejectedCount", "errors", "conflicts", "insertedCount", "skippedCount", "importedAt"
  FROM "HistoricalImportBatch"
`;

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function jsonArray<T>(value: unknown): T[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value as T[] : [];
}

function toStoredBatch(row: RawBatchRow): StoredDataImportBatch {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    kind: row.kind as DataImportKind,
    sourceSystem: row.sourceSystem,
    fileHash: row.fileHash,
    mappingVersion: row.mappingVersion,
    cutoff: isoDate(row.cutoffDate),
    status: row.status as DataImportBatchStatus,
    mapping: row.mapping as DataImportMapping,
    facts: jsonArray<DataImportFact>(row.facts),
    factsHash: row.factsHash,
    rowCount: row.rowCount,
    acceptedCount: row.acceptedCount,
    rejectedCount: row.rejectedCount,
    errors: jsonArray<DataImportIssue>(row.errors),
    conflicts: jsonArray<DataImportIssue>(row.conflicts),
    insertedCount: row.insertedCount,
    skippedCount: row.skippedCount,
    importedAt: row.importedAt?.toISOString() ?? null,
  };
}

const FACT_TABLE: Record<DataImportFact["kind"], string> = {
  delivery_sale: '"HistoricalDeliverySale"',
  delivery_sale_line: '"HistoricalDeliverySaleLine"',
  purchase_receipt: '"HistoricalPurchaseReceipt"',
  purchase_receipt_line: '"HistoricalPurchaseReceiptLine"',
  stock_observation: '"HistoricalStockObservation"',
  stockout: '"HistoricalStockout"',
  expense: '"HistoricalExpense"',
  promotion: '"HistoricalPromotion"',
  cash_reconciliation: '"HistoricalCashReconciliation"',
  cash_movement: '"HistoricalCashMovement"',
  member: '"HistoricalMember"',
};

function factKeyParts(key: string): [DataImportFact["kind"], string] {
  const splitAt = key.indexOf("\u0000");
  return [key.slice(0, splitAt) as DataImportFact["kind"], key.slice(splitAt + 1)];
}

async function selectFacts(
  client: Prisma.TransactionClient | typeof db,
  sourceSystem: string,
  facts: DataImportFact[],
): Promise<Map<string, StoredDataImportFact>> {
  const groups = new Map<DataImportFact["kind"], Set<string>>();
  for (const fact of facts) {
    const ids = groups.get(fact.kind) ?? new Set<string>();
    ids.add(fact.sourceId);
    groups.set(fact.kind, ids);
  }
  const result = new Map<string, StoredDataImportFact>();
  for (const [kind, idSet] of groups) {
    const ids = [...idSet];
    if (!ids.length) continue;
    const table = FACT_TABLE[kind];
    const rows = await client.$queryRaw<Array<{ id: string; sourceId: string; factHash: string }>>(Prisma.sql`
      SELECT "id", "sourceId", "factHash" FROM ${Prisma.raw(table)}
      WHERE "sourceSystem" = ${sourceSystem} AND "sourceId" = ANY(${ids}::text[])
    `);
    for (const row of rows)
      result.set(factKey(kind, row.sourceId), { id: row.id, kind, sourceId: row.sourceId, factHash: row.factHash });
  }
  return result;
}

class PrismaImportTransaction implements DataImportTransaction {
  constructor(private readonly tx: Prisma.TransactionClient) {}

  async getBatchForUpdate(batchId: string): Promise<StoredDataImportBatch | null> {
    const rows = await this.tx.$queryRaw<RawBatchRow[]>(Prisma.sql`
      ${BATCH_SELECT} WHERE "id" = ${batchId} FOR UPDATE
    `);
    return rows[0] ? toStoredBatch(rows[0]) : null;
  }

  findFacts(sourceSystem: string, facts: DataImportFact[]): Promise<Map<string, StoredDataImportFact>> {
    return selectFacts(this.tx, sourceSystem, facts);
  }

  async findParentIds(
    parentKind: "delivery_sale" | "purchase_receipt",
    sourceSystem: string,
    sourceIds: string[],
  ): Promise<Map<string, string>> {
    if (!sourceIds.length) return new Map();
    const table = parentKind === "delivery_sale"
      ? '"HistoricalDeliverySale"'
      : '"HistoricalPurchaseReceipt"';
    const rows = await this.tx.$queryRaw<Array<{ id: string; sourceId: string }>>(Prisma.sql`
      SELECT "id", "sourceId" FROM ${Prisma.raw(table)}
      WHERE "sourceSystem" = ${sourceSystem} AND "sourceId" = ANY(${sourceIds}::text[])
    `);
    return new Map(rows.map((row) => [row.sourceId, row.id]));
  }

  async insertFact(
    sourceSystem: string,
    fact: DataImportFact,
    factHash: string,
    parentId?: string,
  ): Promise<void> {
    const id = randomUUID();
    switch (fact.kind) {
      case "delivery_sale":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalDeliverySale"
          ("id","sourceSystem","sourceId","factHash","saleDate","totalCents","discountCents")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${new Date(`${fact.date}T00:00:00.000Z`)},${BigInt(fact.totalCents)},${BigInt(fact.discountCents)})`);
        return;
      case "delivery_sale_line":
        if (!parentId) throw new DataImportError("Falta saleId para la línea histórica.", "parent_fact_missing");
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalDeliverySaleLine"
          ("id","sourceSystem","sourceId","factHash","saleId","itemLabel","productSourceId","quantityMilliunits","quantityUnit","unitPriceCents","lineTotalCents")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${parentId},${fact.itemLabel},${fact.productSourceId},${BigInt(fact.quantityMilliunits)},${fact.quantityUnit},${fact.unitPriceCents === null ? null : BigInt(fact.unitPriceCents)},${BigInt(fact.lineTotalCents)})`);
        return;
      case "purchase_receipt":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalPurchaseReceipt"
          ("id","sourceSystem","sourceId","factHash","receivedDate","orderDate","supplierSourceId","totalCents")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${new Date(`${fact.date}T00:00:00.000Z`)},${fact.orderDate ? new Date(`${fact.orderDate}T00:00:00.000Z`) : null},${fact.supplierSourceId},${BigInt(fact.totalCents)})`);
        return;
      case "purchase_receipt_line":
        if (!parentId) throw new DataImportError("Falta receiptId para la línea histórica.", "parent_fact_missing");
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalPurchaseReceiptLine"
          ("id","sourceSystem","sourceId","factHash","receiptId","itemLabel","productSourceId","quantityMilliunits","quantityUnit","unitCostCents","lineTotalCents")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${parentId},${fact.itemLabel},${fact.productSourceId},${BigInt(fact.quantityMilliunits)},${fact.quantityUnit},${fact.unitCostCents === null ? null : BigInt(fact.unitCostCents)},${BigInt(fact.lineTotalCents)})`);
        return;
      case "stock_observation":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalStockObservation"
          ("id","sourceSystem","sourceId","factHash","observedDate","productSourceId","itemLabel","locationSourceId","quantityMilliunits","quantityUnit")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${new Date(`${fact.date}T00:00:00.000Z`)},${fact.productSourceId},${fact.itemLabel},${fact.locationSourceId},${BigInt(fact.quantityMilliunits)},${fact.quantityUnit})`);
        return;
      case "stockout":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalStockout"
          ("id","sourceSystem","sourceId","factHash","stockoutDate","productSourceId","itemLabel","locationSourceId","lostQuantityMilliunits","quantityUnit")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${new Date(`${fact.date}T00:00:00.000Z`)},${fact.productSourceId},${fact.itemLabel},${fact.locationSourceId},${fact.lostQuantityMilliunits === null ? null : BigInt(fact.lostQuantityMilliunits)},${fact.quantityUnit})`);
        return;
      case "expense":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalExpense"
          ("id","sourceSystem","sourceId","factHash","expenseDate","category","amountCents")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${new Date(`${fact.date}T00:00:00.000Z`)},${fact.category},${BigInt(fact.amountCents)})`);
        return;
      case "promotion":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalPromotion"
          ("id","sourceSystem","sourceId","factHash","label","startsOn","endsOn","discountCents")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${fact.label},${new Date(`${fact.date}T00:00:00.000Z`)},${fact.endDate ? new Date(`${fact.endDate}T00:00:00.000Z`) : null},${fact.discountCents === null ? null : BigInt(fact.discountCents)})`);
        return;
      case "cash_reconciliation":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalCashReconciliation"
          ("id","sourceSystem","sourceId","factHash","reconciledDate","account","expectedCents","countedCents","varianceCents")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${new Date(`${fact.date}T00:00:00.000Z`)},${fact.account},${BigInt(fact.expectedCents)},${BigInt(fact.countedCents)},${BigInt(fact.varianceCents)})`);
        return;
      case "cash_movement":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalCashMovement"
          ("id","sourceSystem","sourceId","factHash","movementDate","account","category","amountCents")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${new Date(`${fact.date}T00:00:00.000Z`)},${fact.account},${fact.category},${BigInt(fact.amountCents)})`);
        return;
      case "member":
        await this.tx.$executeRaw(Prisma.sql`INSERT INTO "HistoricalMember"
          ("id","sourceSystem","sourceId","factHash","memberKey","permitStatus","permitExpiryDate","permitCheckedAt")
          VALUES (${id},${sourceSystem},${fact.sourceId},${factHash},${fact.memberKey},${fact.permitStatus},${fact.permitExpiryDate ? new Date(`${fact.permitExpiryDate}T00:00:00.000Z`) : null},${fact.permitCheckedAt ? new Date(`${fact.permitCheckedAt}T00:00:00.000Z`) : null})`);
        return;
    }
  }

  async insertProvenance(
    batchId: string,
    sourceSystem: string,
    fact: DataImportFact,
    factHash: string,
    disposition: StoredDataImportProvenance["disposition"],
  ): Promise<void> {
    await this.tx.$executeRaw(Prisma.sql`
      INSERT INTO "HistoricalImportProvenance"
        ("id", "batchId", "factKind", "sourceSystem", "sourceId", "factHash", "disposition")
      VALUES (${randomUUID()}, ${batchId}, ${fact.kind}, ${sourceSystem}, ${fact.sourceId}, ${factHash}, ${disposition})
    `);
  }

  async markImported(batchId: string, actorId: string, inserted: number, skipped: number): Promise<void> {
    const updated = await this.tx.$executeRaw(Prisma.sql`
      UPDATE "HistoricalImportBatch"
      SET "status" = 'imported', "importedAt" = CURRENT_TIMESTAMP,
          "committedByUserId" = ${actorId}, "insertedCount" = ${inserted}, "skippedCount" = ${skipped}
      WHERE "id" = ${batchId} AND "status" = 'ready'
    `);
    if (updated !== 1) throw new DataImportError("El lote cambió de estado durante la importación.", "batch_state_conflict");
  }
}

class PrismaDataImportRepository implements DataImportRepository {
  async findBatchByIdempotencyKey(key: string): Promise<StoredDataImportBatch | null> {
    const rows = await db.$queryRaw<RawBatchRow[]>(Prisma.sql`${BATCH_SELECT} WHERE "idempotencyKey" = ${key} LIMIT 1`);
    return rows[0] ? toStoredBatch(rows[0]) : null;
  }

  async createBatch(batch: StoredDataImportBatch): Promise<StoredDataImportBatch> {
    const inserted = await db.$queryRaw<RawBatchRow[]>(Prisma.sql`
      INSERT INTO "HistoricalImportBatch" (
        "id","idempotencyKey","kind","sourceSystem","fileHash","mappingVersion","cutoffDate","status",
        "mapping","facts","factsHash","rowCount","acceptedCount","rejectedCount","errors","conflicts",
        "insertedCount","skippedCount","createdByUserId","committedByUserId"
      ) VALUES (
        ${batch.id},${batch.idempotencyKey},${batch.kind},${batch.sourceSystem},${batch.fileHash},${batch.mappingVersion},
        ${new Date(`${batch.cutoff}T00:00:00.000Z`)},${batch.status}::"HistoricalImportStatus",
        ${stableStringify(batch.mapping)}::jsonb,${stableStringify(batch.facts)}::jsonb,${batch.factsHash},
        ${batch.rowCount},${batch.acceptedCount},${batch.rejectedCount},${stableStringify(batch.errors)}::jsonb,
        ${stableStringify(batch.conflicts)}::jsonb,${batch.insertedCount},${batch.skippedCount},NULL,NULL
      ) ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING "id","idempotencyKey","kind","sourceSystem","fileHash","mappingVersion","cutoffDate","status",
        "mapping","facts","factsHash","rowCount","acceptedCount","rejectedCount","errors","conflicts",
        "insertedCount","skippedCount","importedAt"
    `);
    if (inserted[0]) return toStoredBatch(inserted[0]);
    const prior = await this.findBatchByIdempotencyKey(batch.idempotencyKey);
    if (!prior) throw new DataImportError("No se pudo guardar la vista previa.", "preview_persistence_error");
    return prior;
  }

  findFacts(sourceSystem: string, facts: DataImportFact[]): Promise<Map<string, StoredDataImportFact>> {
    return selectFacts(db, sourceSystem, facts);
  }

  async transaction<T>(work: (tx: DataImportTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.$transaction(
          (tx) => work(new PrismaImportTransaction(tx)),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 },
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034" && attempt < 3)
          continue;
        throw error;
      }
    }
  }
}

export const prismaDataImportRepository: DataImportRepository = new PrismaDataImportRepository();
