import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  ArrowClockwise,
  CheckCircle,
  FileCsv,
  FileXls,
  Info,
  ShieldCheck,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { api, useClub } from "./lib";
import {
  dataImportColumns,
  dataImportKinds,
  type DataImportColumn,
  type DataImportBatchStatus,
  type DataImportCommitResult,
  type DataImportFileInput,
  type DataImportInput,
  type DataImportInspection,
  type DataImportKind,
  type DataImportMapping,
  type DataImportPreview,
} from "../shared/data-import";
import "./data-import-studio.css";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_WORKBOOK_CELLS = 500_000;
const MAX_WORKSHEET_ROWS = 100_000;
const MAPPING_VERSION = "1";

type BatchItem = {
  id: string;
  kind: DataImportKind;
  sourceSystem: string;
  cutoff: string;
  status: DataImportBatchStatus;
  committedByUserId: string | null;
  rowCount: number;
  acceptedCount: number;
  insertedCount: number;
  skippedCount: number;
  createdAt: string;
  reconciliation?: ReconciliationRecord | null;
};

type ReconciliationRecord = {
  id?: string;
  batchId?: string;
  asOf?: string;
  reference: string;
  notes?: string;
  varianceCents?: string | null;
  sourceRecordCount?: number | null;
  sourceTotalCents?: string | null;
  calculatedTotalCents?: string | null;
  coverageFrom?: string | null;
  coverageThrough?: string | null;
  coverageComplete?: boolean;
  confirmedAt?: string;
  status?: "reconciled";
};

type ReconciliationInput = {
  asOf: string;
  reference: string;
  notes: string;
  varianceCents: string | null;
  sourceRecordCount: number;
  sourceTotalCents: string | null;
  coverageFrom: string | null;
  coverageThrough: string | null;
  coverageComplete: boolean;
};

type PreparedUpload = DataImportFileInput & {
  format: "csv" | "xlsx";
  bytes: number;
  removedColumns: number;
};

type SafeInspection = Omit<DataImportInspection, "sampleRows"> & {
  sampleRows: Record<string, string>[];
};

const KIND_LABELS: Record<DataImportKind, string> = {
  delivery_sales: "Ventas de delivery",
  purchases: "Compras",
  stock: "Observaciones de stock",
  cash_reconciliation: "Arqueos históricos de caja",
  cash_movements: "Movimientos de caja",
  expenses: "Gastos",
  promotions: "Promociones",
  members: "Estado de permisos de socios",
};
const MONETARY_KINDS = new Set<DataImportKind>(["delivery_sales", "purchases", "cash_reconciliation", "cash_movements", "expenses"]);

const COLUMN_LABELS: Record<DataImportColumn, string> = {
  recordType: "Tipo de registro",
  sourceId: "ID de origen",
  date: "Fecha",
  orderDate: "Fecha del pedido",
  parentSourceId: "ID de la operación relacionada",
  total: "Total bruto antes de descuento (ventas) / total del comprobante (compras)",
  discount: "Descuento",
  itemLabel: "Artículo",
  productSourceId: "ID de producto de origen",
  quantity: "Cantidad",
  unit: "Unidad",
  unitPrice: "Precio unitario",
  lineTotal: "Total de línea",
  supplierSourceId: "ID de proveedor de origen",
  locationSourceId: "ID de ubicación de origen",
  lostQuantity: "Cantidad no disponible",
  category: "Categoría",
  label: "Etiqueta",
  endDate: "Fecha de fin",
  account: "Cuenta",
  expected: "Importe esperado",
  counted: "Importe contado",
  amount: "Importe",
  memberKey: "ID de socio de origen",
  permitStatus: "Estado del permiso",
  permitExpiryDate: "Vencimiento del permiso",
  permitCheckedAt: "Fecha de verificación del permiso",
};

const COLUMNS_BY_KIND: Record<DataImportKind, DataImportColumn[]> = {
  delivery_sales: [
    "recordType", "sourceId", "date", "parentSourceId", "total", "discount",
    "itemLabel", "productSourceId", "quantity", "unit", "unitPrice", "lineTotal",
  ],
  purchases: [
    "recordType", "sourceId", "date", "orderDate", "parentSourceId", "supplierSourceId", "total",
    "itemLabel", "productSourceId", "quantity", "unit", "unitPrice", "lineTotal",
  ],
  stock: [
    "recordType", "sourceId", "date", "itemLabel", "productSourceId", "locationSourceId",
    "quantity", "unit", "lostQuantity",
  ],
  cash_reconciliation: ["sourceId", "date", "account", "expected", "counted"],
  cash_movements: ["sourceId", "date", "account", "category", "amount"],
  expenses: ["sourceId", "date", "category", "amount"],
  promotions: ["sourceId", "date", "label", "endDate", "discount"],
  members: ["sourceId", "memberKey", "permitStatus", "permitExpiryDate", "permitCheckedAt"],
};

const HEADER_ALIASES: Partial<Record<DataImportColumn, string[]>> = {
  recordType: ["recordtype", "tipo", "tiporegistro", "tipooperacion"],
  sourceId: ["sourceid", "externalid", "legacyid", "idorigen", "idexterno", "idfuente", "id"],
  date: ["date", "fecha", "fechaoperacion", "fecharegistro"],
  orderDate: ["orderdate", "fechapedido", "fechaorden", "fechaordencompra"],
  parentSourceId: ["parentsourceid", "parentid", "idpadre", "idoperacion", "idventa", "idcompra"],
  total: ["total", "importe", "montototal"],
  discount: ["discount", "descuento"],
  itemLabel: ["itemlabel", "item", "producto", "articulo", "detalle"],
  productSourceId: ["productsourceid", "productid", "idproducto"],
  quantity: ["quantity", "cantidad", "unidades"],
  unit: ["unit", "unidad", "medida"],
  unitPrice: ["unitprice", "preciounitario", "costounitario"],
  lineTotal: ["linetotal", "totallinea", "importeitem"],
  supplierSourceId: ["suppliersourceid", "supplierid", "idproveedor"],
  locationSourceId: ["locationsourceid", "locationid", "idubicacion"],
  lostQuantity: ["lostquantity", "faltante", "cantidadperdida"],
  category: ["category", "categoria", "rubro"],
  label: ["label", "etiqueta", "nombrepromocion"],
  endDate: ["enddate", "fechafin", "vencimiento"],
  account: ["account", "cuenta", "caja"],
  expected: ["expected", "esperado", "importeesperado"],
  counted: ["counted", "contado", "import contado", "importecontado"],
  amount: ["amount", "importe", "monto"],
  memberKey: ["memberkey", "socioid", "idsocio", "key"],
  permitStatus: ["permitstatus", "estadopermiso", "permisoestado"],
  permitExpiryDate: ["permitexpirydate", "vencimientopermiso", "fechavencimientopermiso"],
  permitCheckedAt: ["permitcheckedat", "verificadoen", "fechaverificacion"],
};

const PRIVATE_VALUE_TOKENS = new Set([
  "name", "nombre", "apellido", "apellidos", "firstname", "lastname", "fullname",
  "email", "mail", "correo", "phone", "telephone", "telefono", "celular", "mobile",
  "whatsapp", "address", "direccion", "domicilio", "birth", "birthday", "nacimiento",
  "dni", "documento", "passport", "pasaporte", "notes", "note", "observacion",
  "observaciones", "comment", "comments", "comentario", "comentarios", "message",
  "mensaje", "recipient", "destinatario",
]);

const CONTACT_ENTITY_TOKENS = new Set([
  "contact", "contacts", "cliente", "clientes", "customer", "customers", "socio", "socios", "member", "members",
]);

const ISSUE_MESSAGES = [
  { pattern: /missing|required|obligatorio/i, text: "Falta un dato requerido" },
  { pattern: /duplicate|already.?exists|duplicado/i, text: "ID de origen duplicado" },
  { pattern: /conflict|conflicto/i, text: "Conflicto con un registro existente" },
  { pattern: /date|fecha/i, text: "Fecha no válida" },
  { pattern: /number|amount|quantity|decimal|importe|cantidad/i, text: "Número o importe no válido" },
  { pattern: /mapping|column|header|columna|mapeo/i, text: "Revisá el mapeo de columnas" },
];

function normalizeHeader(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function headerTokens(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasSourceIdHeader(value: string) {
  const tokens = headerTokens(value);
  return tokens.some((token) => ["id", "uuid", "key", "clave"].includes(token));
}

function isPrivateHeader(value: string) {
  const tokens = headerTokens(value);
  if (tokens.some((token) => PRIVATE_VALUE_TOKENS.has(token))) return true;
  const hasIdentifier = hasSourceIdHeader(value);
  return tokens.some((token) => CONTACT_ENTITY_TOKENS.has(token)) && !hasIdentifier;
}

function suggestedMapping(headers: string[], kind: DataImportKind) {
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  const result: Partial<Record<DataImportColumn, string>> = {};
  for (const column of COLUMNS_BY_KIND[kind]) {
    const aliases = new Set([normalizeHeader(column), ...(HEADER_ALIASES[column] || [])]);
    const matchIndex = normalizedHeaders.findIndex((header) => aliases.has(header));
    if (matchIndex >= 0) result[column] = headers[matchIndex];
  }
  return result;
}

function localDateValue() {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function decodeCsv(bytes: Uint8Array) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function detectCsvDelimiter(source: string) {
  const counts = new Map([[",", 0], [";", 0], ["\t", 0], ["|", 0]]);
  let inQuotes = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (inQuotes && source[index + 1] === '"') index++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (char === "\n" || char === "\r")) {
      break;
    } else if (!inQuotes && counts.has(char)) {
      counts.set(char, (counts.get(char) || 0) + 1);
    }
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] || ",";
}

function parseCsv(source: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let cellCount = 0;
  const input = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const pushField = () => {
    cellCount++;
    if (cellCount > MAX_WORKBOOK_CELLS) throw new Error("csv-large");
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    if (rows.length >= MAX_WORKSHEET_ROWS) throw new Error("csv-large");
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (char === '"') {
      if (inQuotes && input[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes && char === delimiter) {
      pushField();
    } else if (!inQuotes && (char === "\n" || char === "\r")) {
      pushField();
      pushRow();
      if (char === "\r" && input[index + 1] === "\n") index++;
    } else {
      field += char;
    }
  }
  if (inQuotes) throw new Error("csv-quote");
  if (field.length || row.length || !rows.length) {
    pushField();
    pushRow();
  }
  return rows;
}

function encodeCsvCell(value: string, delimiter: string) {
  if (value.includes('"') || value.includes("\n") || value.includes("\r") || value.includes(delimiter)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function sanitizeCsv(bytes: Uint8Array) {
  const source = decodeCsv(bytes);
  const delimiter = detectCsvDelimiter(source);
  const rows = parseCsv(source, delimiter);
  const headerRowIndex = rows.findIndex((row) => row.some((value) => value.trim().length > 0));
  if (headerRowIndex < 0) throw new Error("csv-empty");
  const headers = rows[headerRowIndex];
  const removed = new Set<number>();
  headers.forEach((header, index) => {
    if (isPrivateHeader(header)) removed.add(index);
  });
  if (removed.size >= headers.length) throw new Error("csv-private-only");
  const cleaned = rows.map((row) => row.filter((_, index) => !removed.has(index)));
  const output = cleaned
    .map((record) => record.map((value) => encodeCsvCell(value, delimiter)).join(delimiter))
    .join("\r\n");
  return { bytes: new TextEncoder().encode(output), removedColumns: removed.size };
}

type SafeCellValue = string | number | boolean | Date | null;

function safeCellValue(value: unknown, depth = 0): SafeCellValue {
  if (value == null || depth > 3) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return null;
  const candidate = value as {
    formula?: unknown;
    result?: unknown;
    text?: unknown;
    richText?: Array<{ text?: unknown }>;
  };
  if ("formula" in candidate || "sharedFormula" in candidate) {
    return safeCellValue(candidate.result, depth + 1);
  }
  if (Array.isArray(candidate.richText)) {
    return candidate.richText.map((part) => String(part.text ?? "")).join("");
  }
  if (typeof candidate.text === "string") return candidate.text;
  return null;
}

function headerValue(value: unknown) {
  const safe = safeCellValue(value);
  return typeof safe === "string" || typeof safe === "number" ? String(safe).trim() : "";
}

async function sanitizeXlsx(sourceBytes: Uint8Array) {
  const { Workbook } = await import("exceljs");
  const sourceBook = new Workbook();
  await sourceBook.xlsx.load(sourceBytes as never);
  if (!sourceBook.worksheets.length) throw new Error("xlsx-empty");

  const cellCount = sourceBook.worksheets.reduce((sum, sheet) => {
    if (sheet.rowCount > MAX_WORKSHEET_ROWS) throw new Error("xlsx-large");
    return sum + sheet.rowCount * Math.max(sheet.columnCount, 1);
  }, 0);
  if (cellCount > MAX_WORKBOOK_CELLS) throw new Error("xlsx-large");

  const safeBook = new Workbook();
  let removedColumns = 0;
  let includedSheets = 0;
  for (const sourceSheet of sourceBook.worksheets) {
    let headerRowNumber = 0;
    let headers: string[] = [];
    for (let rowNumber = 1; rowNumber <= sourceSheet.rowCount; rowNumber++) {
      const row = sourceSheet.getRow(rowNumber);
      const values = Array.from({ length: sourceSheet.columnCount }, (_, index) => headerValue(row.getCell(index + 1).value));
      if (values.some((value) => value.length > 0)) {
        headerRowNumber = rowNumber;
        headers = values;
        break;
      }
    }
    if (!headerRowNumber) continue;

    const keptColumns = headers
      .map((header, index) => ({ header, column: index + 1 }))
      .filter(({ header }) => !isPrivateHeader(header))
      .map(({ column }) => column);
    removedColumns += headers.length - keptColumns.length;
    if (!keptColumns.length) continue;

    includedSheets++;
    const targetSheet = safeBook.addWorksheet(`Hoja ${includedSheets}`);
    for (let rowNumber = 1; rowNumber <= sourceSheet.rowCount; rowNumber++) {
      const sourceRow = sourceSheet.getRow(rowNumber);
      const targetRow = targetSheet.getRow(rowNumber);
      keptColumns.forEach((sourceColumn, targetIndex) => {
        targetRow.getCell(targetIndex + 1).value = safeCellValue(sourceRow.getCell(sourceColumn).value);
      });
    }
  }
  if (!includedSheets) throw new Error("xlsx-private-only");
  const output = await safeBook.xlsx.writeBuffer();
  const outputBytes = new Uint8Array(output as ArrayBuffer);
  return { bytes: outputBytes, removedColumns };
}

async function prepareUpload(file: File): Promise<PreparedUpload> {
  if (!file.size) throw new Error("empty-file");
  if (file.size > MAX_FILE_BYTES) throw new Error("too-large");
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension !== "csv" && extension !== "xlsx") throw new Error("unsupported-file");

  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const cleaned = extension === "csv"
    ? sanitizeCsv(originalBytes)
    : await sanitizeXlsx(originalBytes);
  if (cleaned.bytes.length > MAX_FILE_BYTES) throw new Error("too-large-after-filter");
  return {
    filename: extension === "csv" ? "importacion-historica.csv" : "importacion-historica.xlsx",
    contentBase64: bytesToBase64(cleaned.bytes),
    format: extension,
    bytes: cleaned.bytes.length,
    removedColumns: cleaned.removedColumns,
  };
}

function safeInspection(inspection: DataImportInspection): SafeInspection {
  const headers = inspection.headers.filter((header) => !isPrivateHeader(header));
  const idHeaders = new Set(headers.filter(hasSourceIdHeader));
  return {
    sheets: inspection.sheets,
    headers,
    sampleRows: inspection.sampleRows.map((row) => Object.fromEntries(
      Object.entries(row).filter(([header]) => idHeaders.has(header)),
    )),
  };
}

function maskContactLikeId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "—";
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
  const digitCount = trimmed.replace(/\D/g, "").length;
  const isPhoneLike = digitCount >= 10 && /^[+()\d\s.-]+$/.test(trimmed);
  return isEmail || isPhoneLike ? "ID oculto por formato de contacto" : trimmed;
}

function kindLabel(kind: string) {
  return dataImportKinds.includes(kind as DataImportKind) ? KIND_LABELS[kind as DataImportKind] : "Otro lote";
}

function statusLabel(status: string) {
  const known: Record<string, string> = {
    ready: "Listo",
    rejected: "Rechazado",
    imported: "Importado",
    reconciled: "Conciliado",
  };
  return known[status] || "Registrado";
}

function statusTone(status: string) {
  if (status === "rejected") return "rejected";
  if (status === "ready") return "ready";
  if (["imported", "reconciled"].includes(status)) return "complete";
  return "neutral";
}

function formatDate(value: string) {
  if (!value) return "—";
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "short", year: "numeric" }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function issueDescription(code: string) {
  return ISSUE_MESSAGES.find(({ pattern }) => pattern.test(code))?.text || "Revisá este dato";
}

function issueFieldLabel(field: string) {
  return dataImportColumns.includes(field as DataImportColumn)
    ? COLUMN_LABELS[field as DataImportColumn]
    : "Campo importado";
}

function parseVarianceCents(value: string): string | null | undefined {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  const match = normalized.match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) return undefined;
  const sign = match[1] === "-" ? -1n : 1n;
  const whole = BigInt(match[2]);
  const fraction = BigInt((match[3] || "").padEnd(2, "0") || "0");
  const cents = sign * (whole * 100n + fraction);
  if (cents < -(2n ** 63n) || cents > 2n ** 63n - 1n) return undefined;
  return cents.toString();
}

function varianceInputValue(value: string | null | undefined) {
  if (value == null || !/^-?\d+$/.test(value)) return "";
  const cents = BigInt(value);
  const sign = cents < 0 ? "-" : "";
  const absolute = cents < 0 ? -cents : cents;
  return `${sign}${absolute / 100n},${String(absolute % 100n).padStart(2, "0")}`;
}

function formatVariance(value: string | null | undefined, currency: string) {
  if (value == null || !/^-?\d+$/.test(value)) return "Sin dato";
  const cents = BigInt(value);
  const sign = cents < 0 ? "−" : "";
  const absolute = cents < 0 ? -cents : cents;
  const whole = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(absolute / 100n);
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${sign}${currency} ${whole},${fraction}`;
}

function safeErrorForFile(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  const messages: Record<string, string> = {
    "empty-file": "El archivo está vacío.",
    "too-large": "El archivo supera el límite de 5 MiB.",
    "unsupported-file": "Elegí un archivo CSV o XLSX.",
    "too-large-after-filter": "El archivo procesado supera el límite de 5 MiB.",
    "csv-quote": "El CSV tiene comillas sin cerrar y no se pudo leer.",
    "csv-empty": "El CSV no tiene una fila de encabezados.",
    "csv-large": "El CSV supera el límite de 100.000 filas o 500.000 celdas.",
    "csv-private-only": "El CSV solo contiene columnas de contacto; no se envió.",
    "xlsx-empty": "El libro no contiene hojas legibles.",
    "xlsx-private-only": "El libro solo contiene columnas de contacto; no se envió.",
    "xlsx-large": "El libro supera el límite de filas o celdas admitido.",
  };
  return messages[message] || "No se pudo preparar el archivo. Revisá que sea un CSV o XLSX válido.";
}

export default function DataImportStudio() {
  const { user, state } = useClub();
  const canAccess = user.role === "owner" || user.role === "admin";
  const pickerRef = useRef<HTMLInputElement>(null);
  const operationId = useRef(0);
  const [kind, setKind] = useState<DataImportKind>(dataImportKinds[0]);
  const [stage, setStage] = useState<"file" | "columns" | "validation" | "history">("file");
  const [sourceSystem, setSourceSystem] = useState("");
  const [cutoff, setCutoff] = useState(localDateValue);
  const [decimalSeparator, setDecimalSeparator] = useState<"" | "." | ",">("");
  const [prepared, setPrepared] = useState<PreparedUpload | null>(null);
  const [inspection, setInspection] = useState<SafeInspection | null>(null);
  const [selectedSheet, setSelectedSheet] = useState("");
  const [mapping, setMapping] = useState<Partial<Record<DataImportColumn, string>>>({});
  const [preview, setPreview] = useState<DataImportPreview | null>(null);
  const [commitResult, setCommitResult] = useState<DataImportCommitResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [batchLoading, setBatchLoading] = useState(false);
  const [pageError, setPageError] = useState("");
  const [batchError, setBatchError] = useState("");
  const [batches, setBatches] = useState<BatchItem[]>([]);
  const [reconcileTarget, setReconcileTarget] = useState<BatchItem | null>(null);
  const [reconcileAsOf, setReconcileAsOf] = useState(localDateValue);
  const [reconcileReference, setReconcileReference] = useState("");
  const [reconcileNotes, setReconcileNotes] = useState("");
  const [reconcileVariance, setReconcileVariance] = useState("");
  const [reconcileSourceCount, setReconcileSourceCount] = useState("");
  const [reconcileSourceTotal, setReconcileSourceTotal] = useState("");
  const [reconcileCoverageFrom, setReconcileCoverageFrom] = useState("");
  const [reconcileCoverageThrough, setReconcileCoverageThrough] = useState("");
  const [reconcileCoverageComplete, setReconcileCoverageComplete] = useState(false);
  const [reconcileAcknowledged, setReconcileAcknowledged] = useState(false);
  const [reconcileError, setReconcileError] = useState("");
  const [reconcileBusy, setReconcileBusy] = useState(false);
  const [reconciliationReceipts, setReconciliationReceipts] = useState<Record<string, ReconciliationRecord>>({});

  const columnsForKind = COLUMNS_BY_KIND[kind];
  const selectedIdHeader = mapping.sourceId || mapping.memberKey || "";
  const sampleIds = useMemo(() => {
    if (!inspection || !selectedIdHeader) return [];
    return inspection.sampleRows
      .map((row) => row[selectedIdHeader])
      .filter((value): value is string => Boolean(value?.trim()))
      .slice(0, 4)
      .map(maskContactLikeId);
  }, [inspection, selectedIdHeader]);

  const refreshBatches = useCallback(async () => {
    if (!canAccess) return;
    setBatchLoading(true);
    setBatchError("");
    try {
      const response = await api<{ items: BatchItem[] }>("/data-import/batches");
      setBatches(Array.isArray(response.items) ? response.items : []);
    } catch {
      setBatchError("No se pudo cargar la lista de lotes. Volvé a intentar.");
    } finally {
      setBatchLoading(false);
    }
  }, [canAccess]);

  useEffect(() => {
    if (canAccess) void refreshBatches();
  }, [canAccess, refreshBatches]);

  function clearPreview() {
    setPreview(null);
    setCommitResult(null);
    setAcknowledged(false);
  }

  async function requestInspection(upload: PreparedUpload, sheetName?: string, currentOperation?: number) {
    const request: DataImportFileInput = {
      filename: upload.filename,
      contentBase64: upload.contentBase64,
      ...(sheetName ? { sheetName } : {}),
    };
    const result = await api<DataImportInspection>("/data-import/inspect", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (currentOperation != null && currentOperation !== operationId.current) return;
    const safeResult = safeInspection(result);
    setInspection(safeResult);
    const activeSheet = sheetName || safeResult.sheets[0] || "";
    setSelectedSheet(activeSheet);
    setMapping(suggestedMapping(safeResult.headers, kind));
    clearPreview();
    setPageError("");
    setStage("columns");
  }

  async function chooseFile(file?: File) {
    if (!file) return;
    const currentOperation = ++operationId.current;
    setIsBusy(true);
    setPageError("");
    setPrepared(null);
    setStage("file");
    setInspection(null);
    setSelectedSheet("");
    setMapping({});
    clearPreview();
    try {
      const upload = await prepareUpload(file);
      if (currentOperation !== operationId.current) return;
      setPrepared(upload);
      await requestInspection(upload, undefined, currentOperation);
    } catch (error) {
      if (currentOperation === operationId.current) setPageError(safeErrorForFile(error));
    } finally {
      if (currentOperation === operationId.current) setIsBusy(false);
    }
  }

  async function changeSheet(sheetName: string) {
    if (!prepared || isBusy) return;
    const currentOperation = ++operationId.current;
    setIsBusy(true);
    setPageError("");
    try {
      await requestInspection(prepared, sheetName, currentOperation);
    } catch {
      if (currentOperation === operationId.current) setPageError("No se pudo inspeccionar esa hoja. La selección anterior sigue disponible.");
    } finally {
      if (currentOperation === operationId.current) setIsBusy(false);
    }
  }

  function updateMapping(column: DataImportColumn, header: string) {
    setMapping((previous) => {
      const next = { ...previous };
      if (header) next[column] = header;
      else delete next[column];
      return next;
    });
    clearPreview();
  }

  function changeKind(nextKind: DataImportKind) {
    setKind(nextKind);
    setMapping(inspection ? suggestedMapping(inspection.headers, nextKind) : {});
    clearPreview();
  }

  async function createPreview() {
    if (!prepared || !inspection || !sourceSystem.trim() || !cutoff || isBusy) return;
    setIsBusy(true);
    setPageError("");
    clearPreview();
    const dataMapping: DataImportMapping = {
      version: MAPPING_VERSION,
      columns: mapping,
      ...(prepared.format === "xlsx" && selectedSheet ? { sheetName: selectedSheet } : {}),
      ...(decimalSeparator ? { decimalSeparator } : {}),
    };
    const input: DataImportInput = {
      kind,
      sourceSystem: sourceSystem.trim(),
      filename: prepared.filename,
      contentBase64: prepared.contentBase64,
      mapping: dataMapping,
      cutoff,
    };
    try {
      const result = await api<DataImportPreview>("/data-import/preview", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setPreview(result);
      setStage("validation");
    } catch {
      setPageError("No se pudo generar la vista previa. Revisá los campos y volvé a intentar.");
    } finally {
      setIsBusy(false);
    }
  }

  async function commitImport() {
    if (!preview || preview.status !== "ready" || preview.acceptedCount < 1 || !acknowledged || isBusy) return;
    setIsBusy(true);
    setPageError("");
    try {
      const result = await api<DataImportCommitResult>("/data-import/commit", {
        method: "POST",
        body: JSON.stringify({ batchId: preview.batchId }),
      });
      setCommitResult(result);
      setAcknowledged(false);
      await refreshBatches();
    } catch {
      setPageError("No se pudo confirmar el lote. La vista previa sigue disponible para reintentar.");
    } finally {
      setIsBusy(false);
    }
  }

  function beginReconciliation(batch: BatchItem) {
    setReconcileTarget(batch);
    setReconcileAsOf(localDateValue());
    setReconcileReference("");
    setReconcileNotes("");
    setReconcileVariance("");
    setReconcileSourceCount("");
    setReconcileSourceTotal("");
    setReconcileCoverageFrom("");
    setReconcileCoverageThrough("");
    setReconcileCoverageComplete(false);
    setReconcileAcknowledged(false);
    setReconcileError("");
  }

  function cancelReconciliation() {
    setReconcileTarget(null);
    setReconcileError("");
  }

  async function submitReconciliation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reconcileTarget || reconcileBusy || !reconcileAcknowledged) return;
    const varianceCents = parseVarianceCents(reconcileVariance);
    if (varianceCents === undefined) {
      setReconcileError("Ingresá una varianza válida con hasta dos decimales.");
      return;
    }
    if (varianceCents !== "0") {
      setReconcileError("Para registrar una conciliación, la varianza verificada debe ser 0,00.");
      return;
    }
    const sourceRecordCount = Number(reconcileSourceCount);
    if (!/^\d+$/.test(reconcileSourceCount.trim()) || !Number.isSafeInteger(sourceRecordCount)) {
      setReconcileError("Ingresá la cantidad de registros del reporte de origen.");
      return;
    }
    const sourceTotalCents = MONETARY_KINDS.has(reconcileTarget.kind) ? parseVarianceCents(reconcileSourceTotal) : null;
    if (MONETARY_KINDS.has(reconcileTarget.kind) && (sourceTotalCents == null)) {
      setReconcileError("Ingresá el total de control del reporte de origen en pesos, con hasta dos decimales.");
      return;
    }
    const hasCoverageFrom = Boolean(reconcileCoverageFrom);
    const hasCoverageThrough = Boolean(reconcileCoverageThrough);
    if (reconcileCoverageComplete && (!hasCoverageFrom || !hasCoverageThrough)) {
      setReconcileError("Para confirmar cobertura completa, ingresá las fechas Desde y Hasta.");
      return;
    }
    if (hasCoverageFrom !== hasCoverageThrough) {
      setReconcileError("Si declarás un rango de cobertura, completá ambas fechas.");
      return;
    }
    if (hasCoverageFrom && hasCoverageThrough && reconcileCoverageFrom > reconcileCoverageThrough) {
      setReconcileError("La fecha Desde no puede ser posterior a la fecha Hasta.");
      return;
    }
    if (hasCoverageThrough && reconcileCoverageThrough > reconcileTarget.cutoff) {
      setReconcileError("La cobertura no puede superar la fecha de corte del lote.");
      return;
    }
    if (hasCoverageThrough && reconcileCoverageThrough > reconcileAsOf) {
      setReconcileError("La cobertura no puede superar la fecha de conciliación.");
      return;
    }
    const payload: ReconciliationInput = {
      asOf: reconcileAsOf,
      reference: reconcileReference.trim(),
      notes: reconcileNotes.trim(),
      varianceCents,
      sourceRecordCount,
      sourceTotalCents: sourceTotalCents ?? null,
      coverageFrom: reconcileCoverageFrom || null,
      coverageThrough: reconcileCoverageThrough || null,
      coverageComplete: reconcileCoverageComplete,
    };
    setReconcileBusy(true);
    setReconcileError("");
    try {
      const result = await api<ReconciliationRecord>(`/data-import/${encodeURIComponent(reconcileTarget.id)}/reconcile`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const receipt = { ...result, batchId: reconcileTarget.id, status: "reconciled" as const };
      setReconciliationReceipts((current) => ({ ...current, [reconcileTarget.id]: receipt }));
      setBatches((current) => current.map((batch) => batch.id === reconcileTarget.id
        ? { ...batch, status: "reconciled", reconciliation: receipt }
        : batch));
      setReconcileTarget(null);
      setReconcileAcknowledged(false);
      await refreshBatches();
      setReconciliationReceipts((current) => ({ ...current, [receipt.batchId || reconcileTarget.id]: receipt }));
      setBatches((current) => current.map((batch) => batch.id === reconcileTarget.id
        ? { ...batch, status: "reconciled", reconciliation: receipt }
        : batch));
    } catch {
      setReconcileError("No se pudo registrar la conciliación. El lote conserva su estado actual; revisá los datos e intentá otra vez.");
    } finally {
      setReconcileBusy(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    if (!isBusy) void chooseFile(event.dataTransfer.files[0]);
  }

  if (!canAccess) {
    return (
      <section className="data-import-studio data-import-denied" role="status">
        <ShieldCheck size={26} aria-hidden="true" />
        <div>
          <h1>Importación de datos</h1>
          <p>Esta herramienta está disponible para owner y admin.</p>
        </div>
      </section>
    );
  }

  return (
    <main className="data-import-studio">
      <header className="data-import-heading">
        <div>
          <p className="data-import-eyebrow">HISTORIAL Y TRAZABILIDAD</p>
          <h1>Importación de datos</h1>
          <p className="data-import-intro">Revisá cada archivo y cada fila antes de incorporar registros históricos.</p>
        </div>
        <button type="button" className="button data-import-refresh" onClick={() => void refreshBatches()} disabled={batchLoading}>
          <ArrowClockwise size={17} aria-hidden="true" />
          {batchLoading ? "Actualizando…" : "Actualizar lotes"}
        </button>
      </header>

      <aside className="data-import-principle" aria-label="Alcance de la importación">
        <Info size={21} aria-hidden="true" />
        <div>
          <strong>Importar ≠ conciliar</strong>
          <p>Este flujo agrega registros históricos. No cierra saldos operativos ni envía mensajes a socios.</p>
        </div>
      </aside>

      {pageError && <div className="data-import-alert error" role="alert"><WarningCircle size={19} />{pageError}</div>}

      <nav className="data-import-stage-nav" aria-label="Pasos de importación">
        {([
          ["file", "1. Archivo", true],
          ["columns", "2. Columnas", Boolean(prepared && inspection)],
          ["validation", "3. Validación", Boolean(preview)],
          ["history", "4. Historial", true],
        ] as const).map(([id, label, available]) => <button key={id} type="button" className={stage === id ? "active" : ""} aria-current={stage === id ? "step" : undefined} disabled={!available} onClick={() => setStage(id)}>{label}</button>)}
      </nav>

      {stage === "file" &&
      <section className="data-import-workflow" aria-label="Preparar importación">
        <div className="data-import-section-head">
          <span className="data-import-step">01</span>
          <div>
            <h2>Archivo y alcance</h2>
            <p>Elegí el tipo de historial y revisá un CSV o libro XLSX de hasta 5 MiB.</p>
          </div>
        </div>

        <div className="data-import-config-grid">
          <label className="data-import-field">
            <span>Tipo de datos</span>
            <select value={kind} onChange={(event) => changeKind(event.target.value as DataImportKind)} disabled={isBusy}>
              {dataImportKinds.map((value) => <option key={value} value={value}>{KIND_LABELS[value]}</option>)}
            </select>
          </label>
          <label className="data-import-field">
            <span>Sistema de origen</span>
            <input
              type="text"
              value={sourceSystem}
              onChange={(event) => { setSourceSystem(event.target.value); clearPreview(); }}
              placeholder="Ej. sistema-contable-2023"
              maxLength={120}
              autoComplete="off"
              disabled={isBusy}
            />
          </label>
          <label className="data-import-field">
            <span>Fecha de corte</span>
            <input type="date" value={cutoff} onChange={(event) => { setCutoff(event.target.value); clearPreview(); }} disabled={isBusy} />
          </label>
        </div>

        <label
          className={`data-import-dropzone ${prepared ? "has-file" : ""} ${isBusy ? "is-busy" : ""}`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <input
            ref={pickerRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={isBusy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void chooseFile(file);
            }}
          />
          <span className="data-import-file-icon" aria-hidden="true">
            {prepared?.format === "xlsx" ? <FileXls size={26} /> : prepared?.format === "csv" ? <FileCsv size={26} /> : <UploadSimple size={26} />}
          </span>
          <span className="data-import-drop-copy">
            <strong>{isBusy ? "Procesando archivo…" : prepared ? `Archivo ${prepared.format.toUpperCase()} listo` : "Soltá el archivo aquí o elegilo"}</strong>
            <small>{prepared ? `${(prepared.bytes / (1024 * 1024)).toFixed(2)} MiB preparados · no se conserva el nombre original` : "CSV o XLSX · máximo 5 MiB"}</small>
          </span>
          <span className="button data-import-choose" aria-hidden="true">Elegir archivo</span>
        </label>

        <div className="data-import-privacy-note">
          <ShieldCheck size={18} aria-hidden="true" />
          <p>Antes del envío se quitan columnas identificables como nombre, correo, teléfono, dirección y notas. La pantalla solo muestra IDs de origen en las muestras.</p>
        </div>

        {prepared && inspection && (
          <div className="data-import-inspection">
            <div className="data-import-inspection-title">
              <div>
                <strong>Archivo inspeccionado</strong>
                <span>{inspection.headers.length} columnas disponibles · {inspection.sampleRows.length} filas de muestra</span>
              </div>
              {prepared.removedColumns > 0 && <span className="data-import-redacted">{prepared.removedColumns} columnas privadas excluidas</span>}
            </div>

            {prepared.format === "xlsx" && inspection.sheets.length > 0 && (
              <label className="data-import-field data-import-sheet-field">
                <span>Hoja de trabajo</span>
                <select value={selectedSheet} onChange={(event) => void changeSheet(event.target.value)} disabled={isBusy}>
                  {inspection.sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
                </select>
              </label>
            )}

            {inspection.headers.length > 0 ? (
              <div className="data-import-header-list" aria-label="Encabezados disponibles">
                {inspection.headers.slice(0, 12).map((header, index) => <span key={`${header}-${index}`}>{header}</span>)}
                {inspection.headers.length > 12 && <span className="data-import-more">+{inspection.headers.length - 12} más</span>}
              </div>
            ) : (
              <p className="data-import-inline-empty">No se encontraron encabezados importables en esta hoja.</p>
            )}

            {sampleIds.length > 0 && (
              <div className="data-import-safe-samples">
                <span>IDs de muestra</span>
                {sampleIds.map((value, index) => <code key={`${value}-${index}`}>{value}</code>)}
              </div>
            )}
          </div>
        )}
      </section>
      }

      {stage === "columns" && prepared && inspection && (
        <section className="data-import-workflow" aria-label="Asignar columnas">
          <div className="data-import-section-head">
            <span className="data-import-step">02</span>
            <div>
              <h2>Asignar columnas</h2>
              <p>Relacioná cada campo normalizado con un encabezado del archivo. El preview valida los requisitos del tipo elegido.</p>
            </div>
          </div>

          <div className="data-import-mapping-grid">
            {columnsForKind.map((column) => (
              <label className="data-import-map-row" key={column}>
                <span>{COLUMN_LABELS[column]}</span>
                <select
                  aria-label={`Columna de origen para ${COLUMN_LABELS[column]}`}
                  value={mapping[column] || ""}
                  onChange={(event) => updateMapping(column, event.target.value)}
                  disabled={isBusy || inspection.headers.length === 0}
                >
                  <option value="">Sin asignar</option>
                  {inspection.headers.map((header, index) => <option key={`${header}-${index}`} value={header}>{header}</option>)}
                </select>
              </label>
            ))}
          </div>

          <div className="data-import-mapping-footer">
            <label className="data-import-field data-import-decimal-field">
              <span>Separador decimal</span>
              <select value={decimalSeparator} onChange={(event) => { setDecimalSeparator(event.target.value as "" | "." | ","); clearPreview(); }} disabled={isBusy}>
                <option value="">Detectar en el archivo</option>
                <option value=",">Coma (12,50)</option>
                <option value=".">Punto (12.50)</option>
              </select>
            </label>
            <button
              type="button"
              className="button primary"
              onClick={() => void createPreview()}
              disabled={isBusy || !sourceSystem.trim() || !cutoff || !inspection.headers.length}
            >
              {isBusy ? "Preparando preview…" : "Generar vista previa"}
            </button>
          </div>
          {!sourceSystem.trim() && <p className="data-import-hint">Ingresá el sistema de origen para habilitar la vista previa.</p>}
        </section>
      )}

      {stage === "validation" && preview && (
        <section className="data-import-workflow data-import-preview" aria-label="Vista previa de importación">
          <div className="data-import-section-head">
            <span className="data-import-step">03</span>
            <div>
              <h2>Vista previa y validación</h2>
              <p>Revisá los conteos, errores y conflictos. Solo las filas aceptadas entrarán al lote.</p>
            </div>
            <span className={`data-import-status ${statusTone(preview.status)}`}>{statusLabel(preview.status)}</span>
          </div>

          <dl className="data-import-metrics">
            <div><dt>Filas leídas</dt><dd>{preview.rowCount}</dd></div>
            <div><dt>Aceptadas</dt><dd>{preview.acceptedCount}</dd></div>
            <div><dt>Con errores</dt><dd>{preview.errors.length}</dd></div>
            <div><dt>Conflictos</dt><dd>{preview.conflicts.length}</dd></div>
            <div><dt>Omitidas</dt><dd>{preview.skipped}</dd></div>
          </dl>

          {preview.errors.length > 0 && <IssueList title="Errores por fila" items={preview.errors} tone="error" />}
          {preview.conflicts.length > 0 && <IssueList title="Conflictos detectados" items={preview.conflicts} tone="conflict" />}

          <div className="data-import-preview-sample">
            <div className="data-import-subhead">
              <h3>Muestra segura</h3>
              <span>{preview.sample.length} registros · solo IDs de origen</span>
            </div>
            {preview.sample.length > 0 ? (
              <ul>
                {preview.sample.slice(0, 6).map((fact, index) => (
                  <li key={`${fact.kind}-${fact.sourceId}-${index}`}>
                    <span>{fact.kind.replaceAll("_", " ")}</span>
                    <code>{maskContactLikeId(fact.sourceId)}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="data-import-inline-empty">El servidor no devolvió filas de muestra.</p>
            )}
          </div>

          {preview.status === "rejected" && (
            <div className="data-import-alert error" role="status"><WarningCircle size={19} />Este lote fue rechazado por la validación. Corregí el mapeo o el archivo y generá otra vista previa.</div>
          )}

          {preview.status === "ready" && !commitResult && (
            <div className="data-import-commit-box">
              <label className="data-import-acknowledge">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  disabled={isBusy || preview.acceptedCount < 1}
                />
                <span>Revisé el resultado y confirmo importar las filas aceptadas. Los errores y conflictos no se resolverán automáticamente.</span>
              </label>
              <button
                type="button"
                className="button primary data-import-commit-button"
                onClick={() => void commitImport()}
                disabled={isBusy || !acknowledged || preview.acceptedCount < 1}
              >
                {isBusy ? "Confirmando…" : `Confirmar importación de ${preview.acceptedCount} filas`}
              </button>
              {preview.acceptedCount < 1 && <p className="data-import-hint">No hay filas aceptadas para confirmar.</p>}
            </div>
          )}

          {commitResult && (
            <div className="data-import-commit-result" role="status">
              <CheckCircle size={22} aria-hidden="true" />
              <div>
                <strong>{commitResult.status === "reconciled" ? "Lote importado y conciliado" : "Lote importado"}</strong>
                <p>{commitResult.inserted} registros incorporados · {commitResult.skipped} omitidos · lote {commitResult.batchId}</p>
                <small>El estado de conciliación se informa aparte; esta pantalla no concilia saldos operativos.</small>
              </div>
            </div>
          )}
        </section>
      )}

      {stage === "history" && <section className="data-import-workflow data-import-batches" aria-label="Lotes anteriores">
        <div className="data-import-section-head">
          <span className="data-import-step">04</span>
          <div>
            <h2>Lotes de importación</h2>
          <p>Procedencia, estado y conteos. Los lotes importados requieren una atestación humana para quedar conciliados.</p>
          </div>
        </div>
        {batchError && <div className="data-import-alert error" role="alert"><WarningCircle size={19} />{batchError}</div>}
        {batchLoading && batches.length === 0 ? (
          <p className="data-import-inline-empty" role="status">Cargando lotes…</p>
        ) : batches.length > 0 ? (
          <div className="data-import-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Lote</th><th>Tipo / origen</th><th>Corte</th><th>Estado</th>
                  <th>Filas</th><th>Aceptadas</th><th>Insertadas</th><th>Omitidas</th><th>Creado</th>
                  <th>Conciliación</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td><code title={batch.id}>{batch.id.length > 14 ? `${batch.id.slice(0, 8)}…${batch.id.slice(-4)}` : batch.id}</code></td>
                    <td><strong>{kindLabel(batch.kind)}</strong><small>{batch.sourceSystem}</small></td>
                    <td>{formatDate(batch.cutoff)}</td>
                    <td><span className={`data-import-status ${statusTone(batch.status)}`}>{statusLabel(batch.status)}</span></td>
                    <td>{batch.rowCount}</td><td>{batch.acceptedCount}</td><td>{batch.insertedCount}</td><td>{batch.skippedCount}</td>
                    <td>{formatDateTime(batch.createdAt)}</td>
                    <td>
                      {batch.status === "imported" && batch.committedByUserId === user.id ? (
                        <span className="data-import-no-action" title="Pedile a otra persona autorizada que coteje el lote">Requiere otro revisor</span>
                      ) : batch.status === "imported" ? (
                        <button type="button" className="data-import-reconcile-link" onClick={() => beginReconciliation(batch)} disabled={reconcileBusy}>
                          Registrar…
                        </button>
                      ) : batch.status === "reconciled" ? (
                        <details className="data-import-reconciliation-details" open={Boolean(reconciliationReceipts[batch.id])}>
                          <summary>Ver acta</summary>
                          <ReconciliationSummary
                            record={reconciliationReceipts[batch.id] || batch.reconciliation || null}
                            currency={state.settings.currency}
                          />
                        </details>
                      ) : <span className="data-import-no-action">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="data-import-batches-empty">
            <p>{batchLoading ? "Actualizando lotes…" : "Todavía no hay lotes de importación."}</p>
          </div>
        )}

        {reconcileTarget && (
          <section className="data-import-attestation" aria-labelledby="data-import-attestation-title">
            <div className="data-import-attestation-heading">
              <div>
                <span className="data-import-attestation-kicker">ATESTACIÓN HUMANA · LOTE IMPORTADO</span>
                <h3 id="data-import-attestation-title">Registrar conciliación</h3>
                <p>Cotejá el reporte original y anotá su cantidad de registros y total. Otra persona debe revisar el lote; la app verifica ambos controles antes de aceptar la conciliación.</p>
              </div>
              <button type="button" className="data-import-attestation-close" onClick={cancelReconciliation} disabled={reconcileBusy} aria-label="Cancelar conciliación">×</button>
            </div>

            <dl className="data-import-provenance">
              <div><dt>Batch ID</dt><dd><code>{reconcileTarget.id}</code></dd></div>
              <div><dt>Tipo</dt><dd>{kindLabel(reconcileTarget.kind)}</dd></div>
              <div><dt>Sistema de origen</dt><dd>{reconcileTarget.sourceSystem}</dd></div>
              <div><dt>Fecha de corte</dt><dd>{formatDate(reconcileTarget.cutoff)}</dd></div>
              <div><dt>Filas / aceptadas / insertadas</dt><dd>{reconcileTarget.rowCount} / {reconcileTarget.acceptedCount} / {reconcileTarget.insertedCount}</dd></div>
            </dl>

            <form className="data-import-reconciliation-form" onSubmit={(event) => void submitReconciliation(event)}>
              <label className="data-import-field">
                <span>Fecha de conciliación</span>
                <input type="date" value={reconcileAsOf} max={localDateValue()} onChange={(event) => setReconcileAsOf(event.target.value)} required />
              </label>
              <label className="data-import-field">
                <span>Referencia documental</span>
                <input type="text" value={reconcileReference} onChange={(event) => setReconcileReference(event.target.value)} minLength={2} maxLength={180} placeholder="Ej. cierre 2025-03 · caja principal" required />
              </label>
              <label className="data-import-field">
                <span>Registros según reporte de origen</span>
                <input type="number" min="0" max="10000" step="1" value={reconcileSourceCount} onChange={(event) => setReconcileSourceCount(event.target.value)} placeholder="Cantidad independiente" required />
                <small>Contá las filas de hechos aceptados, incluidas las líneas de ventas o compras. La app las compara con el lote.</small>
              </label>
              {MONETARY_KINDS.has(reconcileTarget.kind) && <label className="data-import-field">
                <span>Total monetario según reporte de origen ({state.settings.currency})</span>
                <input type="text" inputMode="decimal" value={reconcileSourceTotal} onChange={(event) => setReconcileSourceTotal(event.target.value)} placeholder="0,00" required />
                <small>Ventas y compras: total de cabeceras. Caja y gastos: suma firmada. Arqueos: suma de importes contados.</small>
              </label>}
              <label className="data-import-field data-import-variance-field">
                <span>Varianza verificada ({state.settings.currency})</span>
                <input type="text" inputMode="decimal" value={reconcileVariance} onChange={(event) => setReconcileVariance(event.target.value)} placeholder="0,00" aria-describedby="data-import-variance-help" required />
                <small id="data-import-variance-help">Ingresá la diferencia constatada. La app además compara los controles externos con las cifras importadas.</small>
              </label>
              <fieldset className="data-import-coverage">
                <legend>Cobertura revisada <span>(opcional)</span></legend>
                <p id="data-import-coverage-help">La cobertura es voluntaria. Podés importar y conciliar sin declararla, pero un lote sin cobertura completa no habilita pronóstico. Si informás un rango, completá ambas fechas.</p>
                <div className="data-import-coverage-range">
                  <label className="data-import-field">
                    <span>Desde</span>
                    <input type="date" value={reconcileCoverageFrom} max={reconcileCoverageThrough || (reconcileTarget.cutoff < reconcileAsOf ? reconcileTarget.cutoff : reconcileAsOf)} onChange={(event) => setReconcileCoverageFrom(event.target.value)} aria-describedby="data-import-coverage-help" />
                  </label>
                  <label className="data-import-field">
                    <span>Hasta</span>
                    <input type="date" value={reconcileCoverageThrough} min={reconcileCoverageFrom || undefined} max={reconcileTarget.cutoff < reconcileAsOf ? reconcileTarget.cutoff : reconcileAsOf} onChange={(event) => setReconcileCoverageThrough(event.target.value)} aria-describedby="data-import-coverage-help" />
                  </label>
                </div>
                <label className="data-import-coverage-complete">
                  <input type="checkbox" checked={reconcileCoverageComplete} onChange={(event) => setReconcileCoverageComplete(event.target.checked)} disabled={reconcileBusy} aria-describedby="data-import-coverage-complete-help" />
                  <span>Confirmo que este rango cubre completamente el período necesario para pronosticar.</span>
                </label>
                <small id="data-import-coverage-complete-help">Para marcarla completa se requieren ambas fechas y Hasta no puede superar el corte del lote. La varianza debe ser 0,00 para cualquier conciliación.</small>
              </fieldset>
              <label className="data-import-field data-import-notes-field">
                <span>Notas de revisión</span>
                <textarea value={reconcileNotes} onChange={(event) => setReconcileNotes(event.target.value)} minLength={10} maxLength={1000} rows={3} placeholder="Describí brevemente la evidencia revisada (mínimo 10 caracteres)" required />
                <small>No incluyas nombres, teléfonos, correos ni otros datos de contacto.</small>
              </label>

              {reconcileError && <div className="data-import-alert error" role="alert"><WarningCircle size={18} />{reconcileError}</div>}

              <label className="data-import-acknowledge data-import-reconcile-ack">
                <input type="checkbox" checked={reconcileAcknowledged} onChange={(event) => setReconcileAcknowledged(event.target.checked)} disabled={reconcileBusy} />
                <span>Confirmo que los controles provienen del reporte original, que revisé la procedencia y que la diferencia es cero.</span>
              </label>
              <div className="data-import-attestation-actions">
                <button type="button" className="button" onClick={cancelReconciliation} disabled={reconcileBusy}>Cancelar</button>
                <button type="submit" className="button primary" disabled={reconcileBusy || !reconcileAcknowledged}>
                  {reconcileBusy ? "Registrando…" : "Confirmar y registrar conciliación"}
                </button>
              </div>
            </form>
          </section>
        )}
      </section>
      }
    </main>
  );
}

function IssueList({
  title,
  items,
  tone,
}: {
  title: string;
  items: DataImportPreview["errors"];
  tone: "error" | "conflict";
}) {
  return (
    <section className={`data-import-issues ${tone}`} aria-label={title}>
      <h3>{title} <span>{items.length}</span></h3>
      <ul>
        {items.slice(0, 8).map((issue, index) => (
          <li key={`${issue.row}-${issue.field}-${issue.code}-${index}`}>
            <strong>Fila {issue.row}</strong>
            <span>{issueFieldLabel(issue.field)}</span>
            <small>{issueDescription(issue.code)}</small>
          </li>
        ))}
      </ul>
      {items.length > 8 && <p>Se muestran 8 de {items.length} incidencias.</p>}
    </section>
  );
}

function ReconciliationSummary({ record, currency }: { record: ReconciliationRecord | null; currency: string }) {
  if (!record) return <p className="data-import-reconciliation-unavailable">El resumen del servidor no incluyó el detalle de la atestación.</p>;
  return (
    <dl className="data-import-reconciliation-summary">
      <div><dt>Referencia</dt><dd>{record.reference}</dd></div>
      <div><dt>Fecha</dt><dd>{record.asOf ? formatDate(record.asOf) : "No incluida en el resumen"}</dd></div>
      <div><dt>Varianza</dt><dd>{record.varianceCents !== undefined ? formatVariance(record.varianceCents, currency) : "No incluida en el resumen"}</dd></div>
      <div><dt>Registros de control</dt><dd>{record.sourceRecordCount ?? "No incluidos en el resumen"}</dd></div>
      {record.sourceTotalCents != null && <div><dt>Total externo / importado</dt><dd>{formatVariance(record.sourceTotalCents, currency)} / {formatVariance(record.calculatedTotalCents, currency)}</dd></div>}
      <div><dt>Cobertura</dt><dd>{record.coverageComplete === undefined ? "No incluida en el resumen" : record.coverageComplete ? `${record.coverageFrom || "—"} → ${record.coverageThrough || "—"} · Completa` : record.coverageFrom && record.coverageThrough ? `${record.coverageFrom} → ${record.coverageThrough} · Parcial` : "No declarada"}</dd></div>
      <div><dt>Confirmada</dt><dd>{formatDateTime(record.confirmedAt || "")}</dd></div>
    </dl>
  );
}
