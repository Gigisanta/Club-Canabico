import { createHash } from "node:crypto";
import { posix as posixPath } from "node:path";
import { inflateRawSync } from "node:zlib";
import type ExcelJS from "exceljs";
import { canonicalJson } from "../../shared/operations/exact.js";

export const legacyReaderVersion = "bombo-legacy-reader/1.0.4";

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;
const MAX_COMPRESSION_RATIO = 200;
const MAX_WORKSHEETS = 64;
const MAX_ROWS_PER_SHEET = 100_000;
const MAX_COLUMNS_PER_SHEET = 512;
const MAX_RECORDS = 100_000;
const MAX_SERIALIZED_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_CELL_TEXT_LENGTH = 64 * 1024;
const MAX_MINOR = 9_223_372_036_854_775_807n;

const CREDENTIAL_HEADER = /\b(?:password|passwd|pass phrase|pass code|pass hash|token|jwt|secret|credential|credencial|api key|access key|private key|refresh token|refresh key|auth key|authentication key|authorization|contrasena|salt|cookie|session(?: id| key| token)?)\b/i;
const CREDENTIAL_METADATA_KEY_TERMS = [
  "password", "passwd", "pass phrase", "passphrase", "pass code", "passcode", "pass hash", "passhash",
  "token", "jwt", "secret", "api key", "access key", "private key", "refresh token", "refresh key",
  "auth key", "authentication key", "authorization", "contrasena", "salt", "cookie", "session id", "session key", "session token",
];
const EXACT_CREDENTIAL_METADATA_KEYS = new Set(["credential", "credentials", "credencial", "credenciales"]);
const COMPOSITE_KEY_HEADER = /\b(?:(?:double|doble) key|clave compuesta)\b/i;
const AUTH_CONTEXT = /\b(?:auth|authentication|authorization|access|api|private|security|session|users?|usuarios?|login|credential|password)\b/i;
// Recognizable authentication material is excluded even in ordinary or coordinate-only cells.
// Arbitrary prose cannot prove absence of a secret; source classification still needs review.
const CREDENTIAL_VALUES = [
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+\/=\-]{12,}/i,
  /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16,}/,
  /\b(?:password|passwd|contrase(?:ña|na)|api[_ -]?key|secret|(?:access[_ -]?|auth[_ -]?)?token)\s*[:=]\s*["']?[^"\s';,&]{4,}/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/,
  /\b(?:gh[pousr]_|github_pat_|sk-proj-|sk_(?:live|test)_)[A-Za-z0-9_-]{20,}/,
];
export function containsRecognizableCredential(value: unknown): boolean {
  if(typeof value === "string") return CREDENTIAL_VALUES.some(pattern=>pattern.test(value));
  if(Array.isArray(value)) return value.some(containsRecognizableCredential);
  if(value && typeof value === "object" && !(value instanceof Date))
    return Object.entries(value).some(([key,item]) => isCredentialMetadataKey(key) || CREDENTIAL_VALUES.some(pattern => pattern.test(key)) || containsRecognizableCredential(item));
  return false;
}
export function isCredentialMetadataKey(key: string): boolean {
  const normalized = key.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
  return EXACT_CREDENTIAL_METADATA_KEYS.has(normalized) || CREDENTIAL_METADATA_KEY_TERMS.some((term) =>
    normalized === term || normalized.startsWith(`${term} `) || normalized.endsWith(` ${term}`));
}
const SOURCE_KEY_HEADERS: Record<string, string> = {
  C_Cliente: "Id_Cliente",
  D_Catalogo_Mercaderia: "Codigo_Detalle",
  C_Facturacion: "Id_Factura",
  C_Detalle_Fact: "Id_Detalle",
  C_Moto: "Id_Moto",
  C_Mercaderia: "ID_Mercaderia",
  Mov_Stock1: "ID_Mov_Stock_Total",
  C_gastos_operacion: "Id_gastos",
  C_OperacionUSD: "ID_OPUSD",
  Movimiento_Nueva: "ID_Movimiento_Unique",
  Pre_Venta: "Id_Preventa",
  Pre_Detalle_Fact: "Id_Pre_Detalle",
  Movimiento: "ID_Movimiento",
  T_Usuarios: "ID_Usuarios",
};
const COORDINATE_ONLY_SHEETS = new Set([
  "Form_Stockxdíavariedad", "Array", "Movimiento_Diario", "stc", "Hoja 18", "Extras",
]);
const HEADER_ROW: Record<string, number> = { Auditoria_General: 2 };
const OVERLAP_FIELDS = [
  "Fecha", "Tipo_Movimiento", "Concepto", "Caja", "Monto", "Tipo_Moneda", "Afecta_Resultado",
];
const MONEY_HEADER = /(?:^|[_\s])(?:monto|importe|precio|total|subtotal|tarifa|transferencia|valor|cobrad[oa]?|abonad[oa]?|pagad[oa]?|pago|costo|coste|ganancia|descuento|capital|saldo|ars|usd)(?:$|[_\s])/i;
const NOT_MONEY_HEADER = /(?:gramo|cantidad|unidad|porcentaje|tasa|cambio|rate|factor|escala|(?:^|[_\s])(?:id|identifier|estado|status|fecha|date|tipo|type|codigo|code)(?:$|[_\s]))/i;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type LegacyTreatment = "fact_candidate" | "archive_only" | "overlap_evidence";
export type LegacyExceptionSeverity = "review" | "blocking";

export interface LegacyReaderException {
  kind: string;
  severity: LegacyExceptionSeverity;
  evidence: Record<string, string | number | boolean | null>;
}

export interface LegacyOriginalColumn {
  coordinate: string;
  header: string | null;
  numberFormat: string | null;
  value: JsonValue;
}

export interface LegacyNormalizedColumn {
  coordinate: string;
  header: string | null;
  value: string | null;
  exactDecimal?: string;
  moneyMinorUnits?: string;
}

export interface LegacySourceSnapshotRecord {
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  fileHash: string;
  contentHash: string;
  importerVersion: string;
  original: { columns: LegacyOriginalColumn[] };
  normalized: {
    columns: LegacyNormalizedColumn[];
    overlapEvidence?: {
      targetTable: "Movimiento_Nueva";
      targetSourceRow: number | null;
      status: "exact_legacy_fields" | "different_legacy_fields" | "missing_reference" | "ambiguous_reference" | "comparison_incomplete";
      comparedFields: number;
    };
  };
  treatment: LegacyTreatment;
  exceptions: LegacyReaderException[];
}

export interface LegacySheetCoverage {
  name: string;
  state: string;
  fieldCount: number;
  recordCount: number;
  keyedRecordCount: number;
  headerRow: number | null;
  coordinateOnly: boolean;
  coordinateRange: string | null;
  role: LegacyTreatment;
  excludedCredentialColumns: number;
}

export interface LegacyWorkbookSnapshot {
  sourceSystem: string;
  fileHash: string;
  importerVersion: string;
  sheets: LegacySheetCoverage[];
  records: LegacySourceSnapshotRecord[];
  exceptions: Array<LegacyReaderException & { sourceTable: string; sourceKey: string; sourceRow: number }>;
  summary: {
    sheetCount: number;
    hiddenSheetCount: number;
    recordCount: number;
    keyedRecordCount: number;
    syntheticKeyCount: number;
    recordsByTreatment: Record<LegacyTreatment, number>;
    exceptionCount: number;
    cashOverlap: Record<string, number>;
  };
}

export interface ReadLegacyWorkbookOptions {
  sourceSystem?: string;
  importerVersion?: string;
  /** Restricts record extraction to these sheets. Unselected sheets remain unprocessed. */
  allowedSheets?: readonly string[];
  /** Explicit source key header overrides by sheet name. */
  primaryKeyHeaders?: Readonly<Record<string, string>>;
}

export class LegacyWorkbookReadError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LegacyWorkbookReadError";
  }
}

function fail(code: string, message: string): never {
  throw new LegacyWorkbookReadError(code, message);
}

function safeZipName(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (normalized.endsWith("/")) segments.pop();
  return !normalized.startsWith("/") && !/^[a-z]:/i.test(normalized) &&
    !segments.some((part) => part === ".." || part === "");
}

interface ZipEntryMetadata {
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localOffset: number;
}

interface SourceCellXml {
  cellType: string | null;
  storedValue: string | null;
  valuePresent: boolean;
  formula: { type?: string; ref?: string; sharedIndex?: string } | null;
}

interface SourceSheetXml {
  path: string;
}

interface SourceWorksheetXml {
  dimension: string | null;
  cells: Map<string, SourceCellXml>;
}

function columnIndexFromName(name: string): number {
  let result = 0;
  for (const character of name) result = result * 26 + character.charCodeAt(0) - 64;
  return result;
}

function columnNameFromIndex(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function rangeFromCells(cells: Map<string, SourceCellXml>): string | null {
  let minColumn = Infinity;
  let maxColumn = 0;
  let minRow = Infinity;
  let maxRow = 0;
  for (const coordinate of cells.keys()) {
    const match = /^([A-Z]{1,3})(\d+)$/.exec(coordinate);
    if (!match) continue;
    const column = columnIndexFromName(match[1]);
    const row = Number(match[2]);
    minColumn = Math.min(minColumn, column);
    maxColumn = Math.max(maxColumn, column);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
  }
  if (!Number.isFinite(minColumn) || !Number.isFinite(minRow)) return null;
  const start = `${columnNameFromIndex(minColumn)}${minRow}`;
  const end = `${columnNameFromIndex(maxColumn)}${maxRow}`;
  return start === end ? start : `${start}:${end}`;
}

function validateXlsxArchive(bytes: Buffer): Map<string, ZipEntryMetadata> {
  if (bytes.length < 22 || bytes.length > MAX_COMPRESSED_BYTES)
    fail("xlsx_size_limit", "El XLSX está vacío o supera el límite de tamaño.");

  const minimum = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) fail("invalid_zip", "El XLSX no contiene un directorio ZIP válido.");

  const diskNumber = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  const commentLength = bytes.readUInt16LE(eocd + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff || eocd + 22 + commentLength !== bytes.length)
    fail("unsupported_zip_layout", "El XLSX usa una variante ZIP no admitida.");
  if (entryCount > MAX_ZIP_ENTRIES || centralOffset + centralSize > eocd)
    fail("xlsx_archive_limits", "El XLSX supera los límites del archivo.");

  const seen = new Set<string>();
  const entries = new Map<string, ZipEntryMetadata>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  let hasWorkbook = false;
  let hasContentTypes = false;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize || bytes.readUInt32LE(cursor) !== 0x02014b50)
      fail("invalid_zip_directory", "El XLSX tiene un directorio ZIP incompleto.");
    const flags = bytes.readUInt16LE(cursor + 8);
    const compressionMethod = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const entryCommentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (end > centralOffset + centralSize || startDisk !== 0 || (flags & 1) !== 0 ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff)
      fail("unsupported_zip_entry", "El XLSX contiene una entrada ZIP no admitida.");
    if (compressionMethod !== 0 && compressionMethod !== 8)
      fail("unsupported_zip_compression", "El XLSX usa un método de compresión no admitido.");

    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if (!safeZipName(name) || seen.has(name)) fail("unsafe_zip_path", "El XLSX contiene una ruta ZIP inválida o repetida.");
    seen.add(name);
    entries.set(name, { compressionMethod, compressedSize, uncompressedSize, crc32, localOffset });
    if (name === "xl/workbook.xml") hasWorkbook = true;
    if (name === "[Content_Types].xml") hasContentTypes = true;
    if (uncompressedSize > MAX_ENTRY_BYTES || (uncompressedSize > 0 && compressedSize === 0) ||
        (compressedSize > 0 && uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO))
      fail("xlsx_entry_limits", "El XLSX contiene una entrada demasiado grande.");
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES)
      fail("xlsx_expanded_size_limit", "El XLSX supera el límite de tamaño expandido.");
    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50)
      fail("invalid_zip_entry", "El XLSX contiene una entrada ZIP inválida.");
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize || !hasWorkbook || !hasContentTypes)
    fail("invalid_xlsx_package", "El archivo no contiene una estructura XLSX válida.");
  return entries;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function readZipEntry(bytes: Buffer, name: string, entries: Map<string, ZipEntryMetadata>): Buffer {
  const entry = entries.get(name);
  if (!entry) fail("xlsx_metadata_missing", "Falta metadato requerido del libro XLSX.");
  const local = entry.localOffset;
  if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50)
    fail("invalid_xlsx_metadata", "El XLSX contiene una entrada de metadatos inválida.");
  const nameLength = bytes.readUInt16LE(local + 26);
  const extraLength = bytes.readUInt16LE(local + 28);
  const localName = bytes.toString("utf8", local + 30, local + 30 + nameLength);
  const start = local + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (localName !== name || end > bytes.length)
    fail("invalid_xlsx_metadata", "El XLSX contiene una entrada de metadatos incompleta.");
  let output: Buffer;
  try {
    const compressed = bytes.subarray(start, end);
    output = entry.compressionMethod === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch {
    fail("invalid_xlsx_metadata", "No se pudieron leer los metadatos XML del XLSX.");
  }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.crc32)
    fail("invalid_xlsx_metadata", "Los metadatos XML del XLSX no superaron la comprobación de integridad.");
  return output;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, token: string) => {
    const normalizedToken = token.toLowerCase();
    if (normalizedToken === "amp") return "&";
    if (normalizedToken === "lt") return "<";
    if (normalizedToken === "gt") return ">";
    if (normalizedToken === "quot") return "\"";
    if (normalizedToken === "apos") return "'";
    const codePoint = token[1]?.toLowerCase() === "x" ? Number.parseInt(token.slice(2), 16) : Number.parseInt(token.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return entity;
    return String.fromCodePoint(codePoint);
  });
}

function xmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const matcher = /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of source.matchAll(matcher)) attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  return attributes;
}

function readTagContent(source: string, tag: string): string | null {
  const matcher = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i");
  const match = matcher.exec(source);
  return match ? decodeXmlEntities(match[1]) : null;
}

function readWorkbookSheetXml(bytes: Buffer, entries: Map<string, ZipEntryMetadata>): Map<string, SourceSheetXml> {
  const workbookPath = "xl/workbook.xml";
  const relationshipsPath = "xl/_rels/workbook.xml.rels";
  const workbookXml = readZipEntry(bytes, workbookPath, entries).toString("utf8");
  const relationshipsXml = readZipEntry(bytes, relationshipsPath, entries).toString("utf8");
  const relationships = new Map<string, string>();
  for (const match of relationshipsXml.matchAll(/<(?:[A-Za-z0-9_.-]+:)?Relationship\b([^>]*)\/?\s*>/g)) {
    const attributes = xmlAttributes(match[1]);
    if (!attributes.Id || !attributes.Target || relationships.has(attributes.Id))
      fail("invalid_xlsx_metadata", "Las relaciones del libro XLSX son ambiguas.");
    relationships.set(attributes.Id, attributes.Target);
  }

  const sheets = new Map<string, SourceSheetXml>();
  for (const match of workbookXml.matchAll(/<(?:[A-Za-z0-9_.-]+:)?sheet\b([^>]*)\/?\s*>/g)) {
    const attributes = xmlAttributes(match[1]);
    const id = attributes["r:id"];
    const name = attributes.name;
    const target = id ? relationships.get(id) : undefined;
    if (!name || !target || sheets.has(name) || target.includes("\\") || target.includes("?") || target.includes("#"))
      fail("invalid_xlsx_metadata", "El XLSX contiene una hoja o relación no válida.");
    const joined = target.startsWith("/") ? target.replace(/^\/+/, "") : posixPath.join(posixPath.dirname(workbookPath), target);
    const path = posixPath.normalize(joined);
    if (path === ".." || path.startsWith("../") || path.startsWith("/") || !entries.has(path))
      fail("invalid_xlsx_metadata", "La relación de una hoja XLSX apunta fuera del libro.");
    sheets.set(name, { path });
  }
  if (!sheets.size) fail("invalid_xlsx_metadata", "El XLSX no declara hojas legibles.");
  return sheets;
}

function readWorksheetCellXml(bytes: Buffer, path: string, entries: Map<string, ZipEntryMetadata>): SourceWorksheetXml {
  const xml = readZipEntry(bytes, path, entries).toString("utf8");
  const dimensionTag = /<(?:[A-Za-z0-9_.-]+:)?dimension\b([^>]*)\/?\s*>/i.exec(xml);
  const declaredDimension = dimensionTag ? xmlAttributes(dimensionTag[1]).ref ?? null : null;
  const cells = new Map<string, SourceCellXml>();
  const cellMatcher = /<(?:[A-Za-z0-9_.-]+:)?c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?c\s*>)/g;
  for (const match of xml.matchAll(cellMatcher)) {
    const attributes = xmlAttributes(match[1]);
    const coordinate = attributes.r;
    if (!coordinate || !/^[A-Z]{1,3}\d+$/.test(coordinate) || cells.has(coordinate))
      fail("invalid_xlsx_metadata", "Una coordenada de celda del XLSX no es válida.");
    const body = match[2] ?? "";
    const value = readTagContent(body, "(?:[A-Za-z0-9_.-]+:)?v");
    const formulaTag = /<(?:[A-Za-z0-9_.-]+:)?f\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?f\s*>)/.exec(body);
    const formulaAttributes = formulaTag ? xmlAttributes(formulaTag[1]) : null;
    const formula = formulaTag ? {
      ...(formulaAttributes?.t ? { type: formulaAttributes.t } : {}),
      ...(formulaAttributes?.ref ? { ref: formulaAttributes.ref } : {}),
      ...(formulaAttributes?.si ? { sharedIndex: formulaAttributes.si } : {}),
    } : null;
    let storedValue = value;
    let valuePresent = /<(?:[A-Za-z0-9_.-]+:)?v\b/.test(body);
    if (!valuePresent && attributes.t === "inlineStr") {
      const inline = /<(?:[A-Za-z0-9_.-]+:)?is\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?is\s*>/.exec(body)?.[1];
      if (inline !== undefined) {
        storedValue = [...inline.matchAll(/<(?:[A-Za-z0-9_.-]+:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?t\s*>/g)]
          .map((item) => decodeXmlEntities(item[1])).join("");
        valuePresent = true;
      }
    }
    cells.set(coordinate, {
      cellType: attributes.t ?? (valuePresent ? "n" : null),
      storedValue: valuePresent ? storedValue ?? "" : null,
      valuePresent,
      formula,
    });
  }
  return { dimension: declaredDimension ?? rangeFromCells(cells), cells };
}

function canonicalDecimalLexeme(value: string): string | null {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) return null;
  const digits = match[2] + fraction;
  const point = match[2].length + exponent;
  const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}`
    : point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}`
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  const canonical = strictDecimalString(`${match[1]}${expanded}`);
  return canonical;
}

function inexactInteger(value: string): boolean {
  const normalized = strictDecimalString(value);
  return normalized !== null && !normalized.includes(".") && !Number.isSafeInteger(Number(normalized));
}

function withSourceXmlValue(value: JsonValue, sourceCell: SourceCellXml | undefined): JsonValue {
  const sourceTypeNeedsPreservation = sourceCell &&
    (sourceCell.cellType === "n" || sourceCell.cellType === "str" || sourceCell.cellType === "inlineStr");
  if (!sourceCell || (!sourceCell.formula && (!sourceCell.valuePresent || !sourceTypeNeedsPreservation))) return value;
  return {
    kind: "source_xml_cell",
    value,
    xml: {
      cellType: sourceCell.cellType,
      valuePresent: sourceCell.valuePresent,
      storedValue: sourceCell.storedValue,
      formula: sourceCell.formula,
    },
  };
}

function excelColumnName(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    value--;
    result = String.fromCharCode(65 + value % 26) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

export type LegacyHeaderClassification = "credential" | "restricted_reference" | "composite_key" | "ordinary";

function normalizedHeaderName(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return normalizeLabel(value).replace(/[^a-z0-9]+/g, " ").trim();
}

export function classifyLegacyHeader(header: string | null | undefined, sourceTable?: string): LegacyHeaderClassification {
  if (typeof header !== "string") return "ordinary";
  const normalized = normalizedHeaderName(header);
  const normalizedTable = normalizedHeaderName(sourceTable);
  if (normalizedTable === "c cliente" && normalized === "credencial") return "restricted_reference";
  if (CREDENTIAL_HEADER.test(normalized)) return "credential";
  if (COMPOSITE_KEY_HEADER.test(normalized)) return "composite_key";
  if (/\bclave\b/.test(normalized) && (AUTH_CONTEXT.test(normalized) || AUTH_CONTEXT.test(normalizedTable))) return "credential";
  return "ordinary";
}

export function isCredentialBearingHeader(header: string | null | undefined, sourceTable?: string): boolean {
  return classifyLegacyHeader(header, sourceTable) === "credential";
}

export function isRestrictedLegacyReferenceHeader(header: string | null | undefined, sourceTable?: string): boolean {
  return classifyLegacyHeader(header, sourceTable) === "restricted_reference";
}

export function isCompositeLegacyKeyHeader(header: string | null | undefined): boolean {
  return classifyLegacyHeader(header) === "composite_key";
}

function canonicalDecimal(value: number): string {
  if (!Number.isFinite(value)) fail("invalid_numeric_cell", "El XLSX contiene un valor numérico no finito.");
  if (Number.isInteger(value) && !Number.isSafeInteger(value))
    fail("inexact_numeric_cell", "Un identificador o importe excede la precisión numérica segura.");
  const source = value.toString().toLowerCase();
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(source);
  if (!match) fail("invalid_numeric_cell", "El XLSX contiene un valor numérico inválido.");
  const sign = match[1];
  const integer = match[2];
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  const digits = integer + fraction;
  const point = integer.length + exponent;
  let expanded: string;
  if (point <= 0) expanded = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) expanded = `${digits}${"0".repeat(point - digits.length)}`;
  else expanded = `${digits.slice(0, point)}.${digits.slice(point)}`;
  const [whole, fractional = ""] = expanded.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fractional.replace(/0+$/, "");
  const result = normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
  return result === "0" ? "0" : `${sign}${result}`;
}

function strictDecimalString(value: string): string | null {
  const trimmed = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) return null;
  const whole = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const sign = match[1] === "-" && (whole !== "0" || fraction) ? "-" : "";
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

function minorUnits(decimal: string): { minor: string | null; tooPrecise: boolean; outOfRange: boolean } {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (!match) return { minor: null, tooPrecise: false, outOfRange: false };
  const fraction = match[3] ?? "";
  if (fraction.length > 2 && /[^0]/.test(fraction.slice(2)))
    return { minor: null, tooPrecise: true, outOfRange: false };
  const cents = fraction.slice(0, 2).padEnd(2, "0");
  const absolute = BigInt(match[2]) * 100n + BigInt(cents || "0");
  const signed = match[1] === "-" ? -absolute : absolute;
  return { minor: signed.toString(), tooPrecise: false, outOfRange: absolute > MAX_MINOR };
}

function isMoneyHeader(header: string | null): boolean {
  if (!header) return false;
  const normalized = normalizeLabel(header).replace(/[^a-z0-9]+/g, "_");
  return MONEY_HEADER.test(normalized) && !NOT_MONEY_HEADER.test(normalized);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function rawScalar(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return canonicalDecimal(value);
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : { kind: "invalid_date" };
  if (Array.isArray(value)) return value.map(rawScalar);
  if (isPlainRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === "formula" || key === "sharedFormula" || key === "result" || key === "text" || key === "hyperlink" || key === "tooltip" || key === "error" || key === "richText")
        result[key] = rawScalar(nested);
    }
    return result;
  }
  return String(value);
}

interface NormalizedValue { value: string | null; exactDecimal?: string }

function normalizedValue(value: unknown): NormalizedValue {
  if (value === null || value === undefined) return { value: null };
  if (value instanceof Date) return { value: Number.isFinite(value.getTime()) ? value.toISOString() : null };
  if (typeof value === "number") {
    const exactDecimal = canonicalDecimal(value);
    return { value: exactDecimal, exactDecimal };
  }
  if (typeof value === "boolean") return { value: value ? "true" : "false" };
  if (typeof value === "string") {
    const text = value.normalize("NFC");
    const exactDecimal = strictDecimalString(text);
    return exactDecimal ? { value: text, exactDecimal } : { value: text };
  }
  if (Array.isArray(value)) {
    const rich = value.map((part) => isPlainRecord(part) && typeof part.text === "string" ? part.text : "").join("");
    return { value: rich.normalize("NFC") };
  }
  if (isPlainRecord(value)) {
    if (typeof value.error === "string") return { value: `#${value.error.replace(/^#/, "")}` };
    if (typeof value.text === "string") return { value: value.text.normalize("NFC") };
    if (Array.isArray(value.richText)) {
      const rich = value.richText.map((part) => isPlainRecord(part) && typeof part.text === "string" ? part.text : "").join("");
      return { value: rich.normalize("NFC") };
    }
    return { value: null };
  }
  return { value: String(value).normalize("NFC") };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function rowTreatment(sheetName: string): LegacyTreatment {
  if (sheetName === "Movimiento") return "overlap_evidence";
  if (sheetName === "Movimiento_Nueva") return "archive_only";
  return Object.hasOwn(SOURCE_KEY_HEADERS, sheetName) ? "fact_candidate" : "archive_only";
}

function normalizedColumn(record: LegacySourceSnapshotRecord, header: string): LegacyNormalizedColumn[] {
  return record.normalized.columns.filter((column) => column.header?.trim() === header);
}

function cashComparableValue(header: string, column: LegacyNormalizedColumn): string | null {
  if (column.exactDecimal !== undefined) return column.exactDecimal;
  if (header === "Afecta_Resultado" && column.value !== null)
    return column.value.normalize("NFKC").trim().toLowerCase();
  return column.value;
}

function addException(record: LegacySourceSnapshotRecord, kind: string, severity: LegacyExceptionSeverity, evidence: LegacyReaderException["evidence"]): void {
  record.exceptions.push({ kind, severity, evidence });
}

function refreshContentHash(record: LegacySourceSnapshotRecord): void {
  const { contentHash: _previous, ...content } = record;
  record.contentHash = hashJson(content);
}

function compareCashOverlap(records: LegacySourceSnapshotRecord[]): Record<string, number> {
  const currentCash = records.filter((record) => record.sourceTable === "Movimiento_Nueva");
  const legacyCash = records.filter((record) => record.sourceTable === "Movimiento");
  const byLegacyId = new Map<string, LegacySourceSnapshotRecord[]>();
  for (const record of currentCash) {
    for (const id of normalizedColumn(record, "ID_Movimiento").map((column) => column.value).filter((value): value is string => value !== null && value !== "")) {
      const rows = byLegacyId.get(id) ?? [];
      rows.push(record);
      byLegacyId.set(id, rows);
    }
  }

  const counts: Record<string, number> = {
    records: legacyCash.length,
    exact_legacy_fields: 0,
    different_legacy_fields: 0,
    missing_reference: 0,
    ambiguous_reference: 0,
    comparison_incomplete: 0,
  };
  for (const legacy of legacyCash) {
    const reference = normalizedColumn(legacy, "ID_Movimiento").find((column) => column.value !== null)?.value;
    const matches = reference ? byLegacyId.get(reference) ?? [] : [];
    let status: NonNullable<LegacySourceSnapshotRecord["normalized"]["overlapEvidence"]>["status"];
    let target: LegacySourceSnapshotRecord | undefined;
    let comparedFields = 0;
    if (!reference || matches.length === 0) status = "missing_reference";
    else if (matches.length > 1) status = "ambiguous_reference";
    else {
      target = matches[0];
    const equal = OVERLAP_FIELDS.map((header) => {
        const left = normalizedColumn(legacy, header);
        const right = normalizedColumn(target!, header);
        if (left.length !== 1 || right.length !== 1 || left[0].value === null || right[0].value === null) return null;
        comparedFields++;
        return cashComparableValue(header, left[0]) === cashComparableValue(header, right[0]);
      });
      status = equal.every((same) => same === true) && comparedFields === OVERLAP_FIELDS.length
        ? "exact_legacy_fields"
        : equal.some((same) => same === false) ? "different_legacy_fields" : "comparison_incomplete";
    }
    counts[status]++;
    legacy.normalized.overlapEvidence = {
      targetTable: "Movimiento_Nueva",
      targetSourceRow: target?.sourceRow ?? null,
      status,
      comparedFields,
    };
    if (status === "missing_reference" || status === "ambiguous_reference" || status === "different_legacy_fields" || status === "comparison_incomplete")
      addException(legacy, `cash_overlap_${status}`, status === "different_legacy_fields" ? "blocking" : "review", {
        referenceCoordinate: normalizedColumn(legacy, "ID_Movimiento")[0]?.coordinate ?? null,
        matchedRows: matches.length,
        comparedFields,
      });
    refreshContentHash(legacy);
  }
  return counts;
}

function buildRecord(
  worksheet: ExcelJS.Worksheet,
  row: ExcelJS.Row,
  rowNumber: number,
  fileHash: string,
  importerVersion: string,
  headerRow: number | null,
  safeColumns: Array<{ index: number; header: string | null; originalHeader: string | null }>,
  sourceCells: Map<string, SourceCellXml>,
  primaryKeyHeaders: Readonly<Record<string, string>>,
): LegacySourceSnapshotRecord | null {
  const originalColumns: LegacyOriginalColumn[] = [];
  const normalizedColumns: LegacyNormalizedColumn[] = [];
  const exceptions: LegacyReaderException[] = [];
  const sourceKeyHeader = primaryKeyHeaders[worksheet.name] ?? SOURCE_KEY_HEADERS[worksheet.name];
  const sourceKeyMatches = safeColumns.filter((column) => column.header?.trim() === sourceKeyHeader);
  const sourceKeyColumn = sourceKeyMatches.length === 1 ? sourceKeyMatches[0] : null;
  let nonempty = false;

  for (const column of safeColumns) {
    const cell = row.getCell(column.index);
    const cellValue = cell.value as unknown;
    const formula = isPlainRecord(cellValue) && (typeof cellValue.formula === "string" || typeof cellValue.sharedFormula === "string");
    const coordinate = cell.address;
    const sourceCell = sourceCells.get(coordinate);
    const cacheExists = !formula || Object.hasOwn(cellValue as object, "result") || sourceCell?.valuePresent === true;
    const excelCachedValue = formula && isPlainRecord(cellValue) ? cellValue.result : cellValue;
    const rawNumeric = sourceCell?.valuePresent === true &&
      (sourceCell.cellType === null || sourceCell.cellType === "n") && sourceCell.storedValue !== null
      ? canonicalDecimalLexeme(sourceCell.storedValue)
      : null;
    const stringFormulaCache = formula && sourceCell?.cellType === "str" && sourceCell.valuePresent
      ? sourceCell.storedValue
      : null;
    const cachedValue = stringFormulaCache !== null
      ? stringFormulaCache
      : rawNumeric !== null && !(excelCachedValue instanceof Date)
        ? rawNumeric
        : excelCachedValue;
    if (cachedValue !== null && cachedValue !== undefined || formula) nonempty = true;
    if (containsRecognizableCredential(cellValue) || containsRecognizableCredential(cell.numFmt) ||
        containsRecognizableCredential(sourceCell?.storedValue)) {
      originalColumns.push({ coordinate, header: column.originalHeader, numberFormat: null, value: { kind: "excluded_credential_value" } });
      normalizedColumns.push({ coordinate, header: column.header, value: null });
      exceptions.push({ kind: "credential_value_excluded", severity: "blocking", evidence: { coordinate, field: column.header?.trim() ?? null } });
      continue;
    }
    if (cachedValue instanceof Date && !Number.isFinite(cachedValue.getTime()))
      exceptions.push({ kind: "invalid_excel_date", severity: "blocking", evidence: { coordinate, field: column.header?.trim() ?? null } });

    const serializedValue: JsonValue = formula
      ? {
          kind: "formula",
          formula: typeof (cellValue as Record<string, unknown>).formula === "string" ? String((cellValue as Record<string, unknown>).formula) : null,
          sharedFormula: typeof (cellValue as Record<string, unknown>).sharedFormula === "string" ? String((cellValue as Record<string, unknown>).sharedFormula) : null,
          cachedResult: cacheExists ? rawScalar(cachedValue) : null,
        }
      : rawScalar(cellValue);
    originalColumns.push({
      coordinate,
      header: column.originalHeader,
      numberFormat: typeof cell.numFmt === "string" ? cell.numFmt : null,
      value: withSourceXmlValue(serializedValue, sourceCell),
    });

    const normalized = cacheExists ? normalizedValue(cachedValue) : { value: null };
    const normalizedColumnValue: LegacyNormalizedColumn = {
      coordinate,
      header: column.header,
      value: normalized.value,
      ...(normalized.exactDecimal === undefined ? {} : { exactDecimal: normalized.exactDecimal }),
    };
    if (isMoneyHeader(column.header) && normalized.exactDecimal !== undefined) {
      const conversion = minorUnits(normalized.exactDecimal);
      if (conversion.minor === null) {
        exceptions.push({ kind: "money_precision_exceeds_minor_unit", severity: "review", evidence: { coordinate, field: column.header?.trim() ?? null } });
      } else {
        normalizedColumnValue.moneyMinorUnits = conversion.minor;
        if (conversion.outOfRange) exceptions.push({ kind: "money_minor_out_of_range", severity: "blocking", evidence: { coordinate, field: column.header?.trim() ?? null } });
      }
    }
    normalizedColumns.push(normalizedColumnValue);
    if (Buffer.byteLength(String(column.header ?? "")) + Buffer.byteLength(String(normalized.value ?? "")) > MAX_CELL_TEXT_LENGTH)
      fail("cell_text_limit", "Una celda XLSX supera el límite de texto.");
    if (formula && !cacheExists) exceptions.push({ kind: "formula_without_cached_result", severity: "review", evidence: { coordinate, field: column.header?.trim() ?? null } });
    if (rawNumeric !== null && inexactInteger(rawNumeric))
      exceptions.push({ kind: "inexact_excel_number", severity: "blocking", evidence: { coordinate, field: column.header?.trim() ?? null } });
    if (isPlainRecord(cachedValue) && typeof cachedValue.error === "string")
      exceptions.push({ kind: "excel_error_value", severity: "review", evidence: { coordinate, field: column.header?.trim() ?? null } });
    if (sourceCell?.formula?.type === "array")
      exceptions.push({ kind: "array_formula_preserved", severity: "review", evidence: {
        coordinate,
        formulaType: "array",
        range: sourceCell.formula.ref ?? null,
        cachedResultType: sourceCell.cellType,
        cachedResultPresent: sourceCell.valuePresent,
      } });
  }
  if (!nonempty) return null;

  const treatment = rowTreatment(worksheet.name);
  let sourceKey: string;
  const keyColumnCell = sourceKeyColumn ? row.getCell(sourceKeyColumn.index) : null;
  const keyNormalized = sourceKeyColumn ? normalizedColumns.find(column=>column.coordinate===keyColumnCell?.address)?.value ?? null : null;
  if (sourceKeyMatches.length > 1) {
    sourceKey = `synthetic:${worksheet.name}!row:${rowNumber}`;
    exceptions.push({ kind: "ambiguous_source_key_header", severity: "blocking", evidence: { columns: sourceKeyMatches.map((item) => excelColumnName(item.index)).join(",") } });
  } else if (!sourceKeyHeader) {
    sourceKey = `synthetic:${worksheet.name}!row:${rowNumber}`;
    exceptions.push({ kind: "missing_source_key", severity: "review", evidence: { expectedField: null, coordinate: `row:${rowNumber}` } });
  } else if (keyNormalized === null || keyNormalized.trim() === "") {
    const coordinate = sourceKeyColumn ? `${excelColumnName(sourceKeyColumn.index)}${rowNumber}` : `row:${rowNumber}`;
    sourceKey = `synthetic:${worksheet.name}!${coordinate}`;
    exceptions.push({ kind: "missing_source_key", severity: "review", evidence: { expectedField: sourceKeyHeader, coordinate } });
  } else {
    sourceKey = keyNormalized.normalize("NFC").trim();
    if (sourceKey !== keyNormalized.normalize("NFC"))
      exceptions.push({ kind: "source_key_surrounding_whitespace", severity: "review", evidence: { field: sourceKeyHeader, coordinate: keyColumnCell?.address ?? null } });
  }
  if (sourceKeyColumn && isPlainRecord(keyColumnCell?.value) &&
      (typeof keyColumnCell.value.formula === "string" || typeof keyColumnCell.value.sharedFormula === "string") &&
      !Object.hasOwn(keyColumnCell.value, "result"))
    exceptions.push({ kind: "source_key_formula_without_cache", severity: "blocking", evidence: { coordinate: keyColumnCell.address, expectedField: sourceKeyHeader } });

  const record: LegacySourceSnapshotRecord = {
    sourceTable: worksheet.name,
    sourceKey,
    sourceRow: rowNumber,
    fileHash,
    contentHash: "",
    importerVersion,
    original: { columns: originalColumns },
    normalized: { columns: normalizedColumns },
    treatment,
    exceptions,
  };
  if (sourceKeyHeader && !sourceKeyColumn && sourceKeyMatches.length === 0)
    addException(record, "source_key_header_missing", "blocking", { expectedField: sourceKeyHeader, headerRow: headerRow ?? 1 });
  refreshContentHash(record);
  return record;
}

export async function readLegacyWorkbook(
  input: Buffer | Uint8Array,
  options: ReadLegacyWorkbookOptions = {},
): Promise<LegacyWorkbookSnapshot> {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const zipEntries = validateXlsxArchive(bytes);
  const sourceSheetFiles = readWorkbookSheetXml(bytes, zipEntries);
  let allowedSheets: Set<string> | null = null;
  if (options.allowedSheets !== undefined) {
    if (!Array.isArray(options.allowedSheets) || options.allowedSheets.length === 0 || options.allowedSheets.length > MAX_WORKSHEETS ||
        options.allowedSheets.some((name) => typeof name !== "string" || !name.trim() || name.length > 120))
      fail("invalid_reader_options", "La allowlist de hojas XLSX no es válida.");
    allowedSheets = new Set(options.allowedSheets);
    if (allowedSheets.size !== options.allowedSheets.length || [...allowedSheets].some((name) => !sourceSheetFiles.has(name)))
      fail("invalid_reader_options", "La allowlist contiene hojas repetidas o ausentes.");
  }
  const primaryKeyHeaders = options.primaryKeyHeaders ?? {};
  for (const [sheet, header] of Object.entries(primaryKeyHeaders)) {
    if (!sheet.trim() || !header.trim() || sheet.length > 120 || header.length > 120 || !sourceSheetFiles.has(sheet) ||
        allowedSheets && !allowedSheets.has(sheet))
      fail("invalid_reader_options", "La clave primaria explícita no coincide con las hojas permitidas.");
  }
  const importerVersion = options.importerVersion?.trim() || legacyReaderVersion;
  const sourceSystem = options.sourceSystem?.trim() || "appsheet";
  if (importerVersion.length > 120 || sourceSystem.length > 120)
    fail("invalid_reader_options", "La identificación del lector o la fuente supera el límite.");
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const { default: ExcelJS } = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    fail("invalid_xlsx", "No se pudo leer el XLSX.");
  }
  if (!workbook.worksheets.length || workbook.worksheets.length > MAX_WORKSHEETS)
    fail("worksheet_count_limit", "El XLSX no contiene hojas o supera el límite de hojas.");

  const sheets: LegacySheetCoverage[] = [];
  const records: LegacySourceSnapshotRecord[] = [];
  let totalSerializedBytes = 0;
  for (const worksheet of workbook.worksheets) {
    if (allowedSheets && !allowedSheets.has(worksheet.name)) continue;
    if(containsRecognizableCredential(worksheet.name))fail("credential_metadata_excluded","Una hoja contiene material de autenticación en su identificador; corregí la fuente antes de importarla.");
    const sourceSheetRef = sourceSheetFiles.get(worksheet.name);
    if (!sourceSheetRef) fail("invalid_xlsx_metadata", "No se encontró la relación XML de una hoja del XLSX.");
    const sourceSheetXml = readWorksheetCellXml(bytes, sourceSheetRef.path, zipEntries);
    const rowCount = worksheet.rowCount;
    const columnCount = worksheet.columnCount;
    if (rowCount > MAX_ROWS_PER_SHEET || columnCount > MAX_COLUMNS_PER_SHEET)
      fail("worksheet_dimension_limit", "Una hoja XLSX supera los límites de filas o columnas.");

    const coordinateOnly = COORDINATE_ONLY_SHEETS.has(worksheet.name);
    const headerRow = coordinateOnly ? null : HEADER_ROW[worksheet.name] ?? 1;
    const headerCells: ExcelJS.Row | null = headerRow === null ? null : worksheet.getRow(headerRow);
    const safeColumns: Array<{ index: number; header: string | null; originalHeader: string | null }> = [];
    let excludedCredentialColumns = 0;
    for (let index = 1; index <= columnCount; index++) {
      const headerValue = headerCells?.getCell(index).value;
      const headerText = normalizedValue(
        isPlainRecord(headerValue) && (typeof headerValue.formula === "string" || typeof headerValue.sharedFormula === "string")
          ? headerValue.result
          : headerValue,
      ).value;
      const originalHeader = headerText?.normalize("NFC") ?? null;
      const header = originalHeader?.trim() || null;
      if (isCredentialBearingHeader(header, worksheet.name) || containsRecognizableCredential(originalHeader)) {
        excludedCredentialColumns++;
        continue;
      }
      safeColumns.push({ index, header, originalHeader });
    }

    const firstSheetRecordIndex = records.length;
    const firstDataRow = headerRow === null ? 1 : headerRow + 1;
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber < firstDataRow) return;
      if (rowNumber > MAX_ROWS_PER_SHEET) fail("worksheet_row_limit", "Una hoja XLSX supera el límite de filas.");
      const record = buildRecord(worksheet, row, rowNumber, fileHash, importerVersion, headerRow, safeColumns, sourceSheetXml.cells, primaryKeyHeaders);
      if (!record) return;
      records.push(record);
      if (records.length > MAX_RECORDS) fail("record_count_limit", "El XLSX supera el límite de registros.");
      for (const column of record.original.columns) {
        totalSerializedBytes += Buffer.byteLength(JSON.stringify(column.value)) + Buffer.byteLength(column.header ?? "");
        if (totalSerializedBytes > MAX_SERIALIZED_TEXT_BYTES)
          fail("snapshot_size_limit", "El XLSX supera el límite de contenido serializado.");
      }
    });
    const sheetRecords = records.slice(firstSheetRecordIndex);
    sheets.push({
      name: worksheet.name,
      state: worksheet.state,
      fieldCount: safeColumns.filter((column) => column.header !== null).length,
      recordCount: sheetRecords.length,
      keyedRecordCount: sheetRecords.filter((record) => !record.sourceKey.startsWith("synthetic:")).length,
      headerRow,
      coordinateOnly,
      coordinateRange: coordinateOnly ? sourceSheetXml.dimension : null,
      role: rowTreatment(worksheet.name),
      excludedCredentialColumns,
    });
  }

  const keyCounts = new Map<string, number>();
  for (const record of records) {
    if (record.treatment !== "fact_candidate" || record.sourceKey.startsWith("synthetic:")) continue;
    const key = `${record.sourceTable}\u0000${record.sourceKey}`;
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }
  for (const record of records) {
    if (record.treatment !== "fact_candidate" || record.sourceKey.startsWith("synthetic:")) continue;
    if ((keyCounts.get(`${record.sourceTable}\u0000${record.sourceKey}`) ?? 0) > 1) {
      addException(record, "duplicate_source_key", "blocking", { field: primaryKeyHeaders[record.sourceTable] ?? SOURCE_KEY_HEADERS[record.sourceTable] ?? null });
      refreshContentHash(record);
    }
  }

  const cashOverlap = compareCashOverlap(records);
  const exceptions = records.flatMap((record) => record.exceptions.map((exception) => ({
    ...exception,
    sourceTable: record.sourceTable,
    sourceKey: record.sourceKey,
    sourceRow: record.sourceRow,
  })));
  const recordsByTreatment: Record<LegacyTreatment, number> = {
    fact_candidate: 0,
    archive_only: 0,
    overlap_evidence: 0,
  };
  for (const record of records) recordsByTreatment[record.treatment]++;
  const keyedRecordCount = records.filter((record) => !record.sourceKey.startsWith("synthetic:")).length;
  return {
    sourceSystem,
    fileHash,
    importerVersion,
    sheets,
    records,
    exceptions,
    summary: {
      sheetCount: sheets.length,
      hiddenSheetCount: sheets.filter((sheet) => sheet.state !== "visible").length,
      recordCount: records.length,
      keyedRecordCount,
      syntheticKeyCount: records.length - keyedRecordCount,
      recordsByTreatment,
      exceptionCount: exceptions.length,
      cashOverlap,
    },
  };
}
