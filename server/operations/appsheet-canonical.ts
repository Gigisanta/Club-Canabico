import { createHash } from "node:crypto";
import { Prisma, type PrismaClient, type Prisma as PrismaNamespace } from "@prisma/client";
import { z } from "zod";
import {
  APPSHEET_CANONICAL_IMPORTER_VERSION,
  APPSHEET_CANONICAL_MAPPING_ID,
  APPSHEET_CANONICAL_SOURCE_SYSTEM,
  APPSHEET_MASTER_KEY_FIELDS,
  APPSHEET_MASTER_TABLES,
  appSheetCellEffectiveValue,
  appSheetCellFormula,
  prepareAppSheetCaptureManifest,
  prepareAppSheetProjectionCaptureManifest,
  type AppSheetMasterTable,
  type AppSheetEffectiveValue,
  type AppSheetProjectionCaptureManifest,
  type PreparedAppSheetCaptureManifest,
} from "../../shared/operations/appsheet-canonical.js";
import { appSheetDefinitionInventorySchema, type AppSheetDefinitionInventory } from "../../shared/operations/appsheet-definition.js";
import { canonicalJson } from "../../shared/operations/exact.js";
import { requireAppSheetTechnicalReview } from "../../shared/operations/appsheet-review.js";
import type { AppSheetReviewTarget } from "../../shared/operations/appsheet-review.js";
import { commercialAddress } from "./member-fields.js";
import { capabilitiesFromGrant } from "./access-snapshot.js";
import { sourceRecordSchema } from "./legacy-source-contract.js";
import { legacyPayloadHash } from "./legacy-upload-contract.js";

const HASH = /^[a-f0-9]{64}$/;
const MAX_ROWS = 100_000;
const MAX_CELL_COUNT = 512;
const PAGE_SCHEMA = "appsheet-sheet-page/v1";
const HEADER_SCHEMA = "appsheet-sheet-headers/v1";
const MASTER_SOURCE_FIELDS: Record<keyof typeof APPSHEET_MASTER_KEY_FIELDS, readonly string[]> = {
  C_Cliente: ["Id_Cliente", "Nombre_Cliente", "Apellido_Cliente", "Telefono", "Telefono_Normalizado", "Domicilio", "Zona", "Email"],
  D_Catalogo_Mercaderia: [
    "CatalogoID", "Codigo_Detalle", "Variedad_Cann", "Descripcion", "Estado", "Segmento_Descuento",
    "Precio_5_Gramos", "Precio_10_Gramos", "Precio_15_Gramos", "Precio_20_Gramos", "Precio_25_Gramos", "Precio_30_Gramos",
    "Promo_A", "Promo_B", "Promo_C", "Tarifa_Cliente", "Tarifa_Administración", "Total",
  ],
};
const memberInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  email: z.string().max(254),
  phone: z.string().max(80),
  address: commercialAddress,
});
const catalogueInputSchema = z.strictObject({
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  variety: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(100),
  unit: z.enum(["g", "ud"]),
  active: z.boolean(),
});

type JSONValue = null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
type Severity = "review" | "blocking";
type ProjectionException = { kind: string; severity: Severity; evidence: Record<string, string | number | boolean | null> };
type CellData = {
  columnIndex: number;
  userEnteredValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; formulaValue?: string };
  effectiveValue?: { stringValue?: string; numberValue?: number; boolValue?: boolean; errorValue?: { type: string; message: string } };
  userEnteredFormat?: { numberFormat?: { type?: string; pattern?: string } };
  dataValidation?: unknown;
};
type SourceRow = { sourceRow: number; cells: CellData[]; unresolvedFormulaCells: (string | number)[]; rowHash: string };
type CapturePage = {
  schemaVersion: typeof PAGE_SCHEMA;
  spreadsheetId: string;
  sourceSystem: string;
  sheet: { sheetId: number; title: string; mode: string; hidden?: boolean; headerRow: number | null; gridRows: number; gridColumns: number };
  page: { index: number; startRow: number; endRow: number; a1Ranges: string[]; safeColumnIndexes: number[]; omittedColumnIndexes: number[]; cellFields: string };
  rows: SourceRow[];
  counts: Record<string, number>;
  pageHash: string;
};
type HeaderFile = {
  schemaVersion: typeof HEADER_SCHEMA;
  spreadsheetId: string;
  sheets: Array<{
    sheetId: number; title: string; mode: string; hidden: boolean; headerRow: number | null;
    gridRows: number; gridColumns: number; columns: Array<{ columnIndex: number; header: string | null; sensitive: boolean }>;
    pageCount?: number; safeColumnIndexes?: number[]; omittedColumnIndexes?: number[];
  }>;
};
export interface AppSheetCanonicalCaptureInput {
  manifest: unknown;
  headers: HeaderFile;
  pages: readonly CapturePage[];
  definitionInventory: unknown;
  mode: "stable" | "preliminary-delta";
}
type Destination =
  | { type: "member"; id: string; sourceTable: "C_Cliente"; sourceKey: string; sourceRow: number; data: {
      legacyCustomerId: string; sourceSystem: string; sourceId: string; name: string; email: string; phone: string;
      address: Prisma.InputJsonValue; preferences: Prisma.InputJsonValue;
    } }
  | { type: "sku"; id: string; sourceTable: "D_Catalogo_Mercaderia"; sourceKey: string; sourceRow: number; data: {
      code: string; name: string; variety: string; category: string; unit: "g" | "ud"; active: boolean;
      sourceSystem: string; sourceId: string; appSheet: Record<string, JSONValue>;
    } };
type PreparedSourceRecord = {
  id: string; sourceTable: string; sourceKey: string; sourceRow: number; fileHash: string; contentHash: string;
  importerVersion: string; original: { columns: Array<{ coordinate: string; header: string | null; numberFormat: string | null; value: JSONValue }> };
  normalized: { columns: Array<{ coordinate: string; header: string | null; value: string | null }> };
  treatment: "fact_candidate"; exceptions: ProjectionException[]; destination: Destination | null; keyMissing: boolean;
};
export interface AppSheetCanonicalTableCoverage {
  sourceTable: string;
  sourceKeyField: string;
  rowCount: number;
  sourceRecordCount: number;
  canonicalTargetCount: number;
  blockingExceptionCount: number;
  reviewExceptionCount: number;
  blankRowsSkipped: number;
}
export interface AppSheetCanonicalProjection {
  schemaVersion: 1;
  projectionKind: "masters";
  mappingId: string;
  importerVersion: string;
  capture: AppSheetProjectionCaptureManifest;
  expectedAppId: string;
  definitionIdentityState: "verified" | "missing-in-source-inventory";
  appliedDefinitionHash: string;
  definitionInventory: AppSheetDefinitionInventory;
  snapshotId: string;
  projectionHash: string;
  records: PreparedSourceRecord[];
  destinations: Destination[];
  exceptions: Array<{ id: string; sourceRecordId: string | null; kind: string; severity: Severity; description: string; resolution: null }>;
  tableCoverage: AppSheetCanonicalTableCoverage[];
  verifiedMasterPages: Array<{ sheetId: number; sheetTitle: string; pageIndex: number; startRow: number; endRow: number; pageHash: string; rowCount: number }>;
  summary: {
    recordCount: number;
    memberTargetCount: number;
    catalogueTargetCount: number;
    exceptionCount: number;
    blockingExceptionCount: number;
    reviewExceptionCount: number;
    globalDeltaBlockingCount: number;
  };
}

export class AppSheetCanonicalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AppSheetCanonicalError";
  }
}

export const APPSHEET_EXPECTED_LIVE_APP_ID = "5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0" as const;

/** Older inventories can be archived in isolation, but production needs the parser that captures app identity metadata. */
export function appSheetDefinitionParserSupportsProduction(parserVersion: string): boolean {
  const match = /^bombo-appsheet-definition\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(parserVersion);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 1 || (major === 1 && minor >= 2);
}

export function appSheetDefinitionProductionReadiness(inventory: AppSheetDefinitionInventory, expectedAppId = APPSHEET_EXPECTED_LIVE_APP_ID) {
  const parserSupported = appSheetDefinitionParserSupportsProduction(inventory.parserVersion);
  const appMetadataComplete = inventory.app.id === expectedAppId &&
    typeof inventory.app.name === "string" && inventory.app.name.trim().length > 0 &&
    typeof inventory.app.version === "string" && inventory.app.version.trim().length > 0;
  return {
    parserVersion: inventory.parserVersion,
    parserSupported,
    appMetadataComplete,
    state: parserSupported && appMetadataComplete ? "production-compatible" as const : "isolated-archive-only" as const,
  };
}

function assertProductionDefinitionReady(projection: AppSheetCanonicalProjection): void {
  const readiness = appSheetDefinitionProductionReadiness(projection.definitionInventory, projection.expectedAppId);
  if (!readiness.parserSupported) fail("definition_parser_version_unsupported");
  if (!readiness.appMetadataComplete) fail("definition_app_metadata_incomplete");
}

/** Validate the sanitized editor inventory and its content-addressed descriptor. */
export function prepareAppSheetDefinitionInventory(value: unknown, expectedAppId: string): AppSheetDefinitionInventory {
  const inventory = appSheetDefinitionInventorySchema.parse(value);
  if (!expectedAppId || (inventory.app.id !== null && inventory.app.id !== expectedAppId)) fail("definition_app_identity_mismatch");
  const descriptorBasis = { ...inventory, descriptorSha256: "" };
  if (digest(descriptorBasis) !== inventory.descriptorSha256) fail("definition_descriptor_hash_mismatch");
  return inventory;
}

/** Bind the captured HTML source hash and complete sanitized descriptor. */
export function appSheetAppliedDefinitionHash(inventory: AppSheetDefinitionInventory): string {
  const validated = appSheetDefinitionInventorySchema.parse(inventory);
  if (digest({ ...validated, descriptorSha256: "" }) !== validated.descriptorSha256) fail("definition_descriptor_hash_mismatch");
  return digest({ sourceSha256: validated.source.sha256, descriptorSha256: validated.descriptorSha256 });
}

function fail(code: string): never {
  throw new AppSheetCanonicalError(code);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function jsonValue(value: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(value)) as JSONValue;
  } catch {
    fail("source_cell_not_json_safe");
  }
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sourceRecordId(snapshotId: string, sourceTable: string, sourceRow: number): string {
  return digest(`${snapshotId}\0${sourceTable}\0${sourceRow}`);
}

function identityId(sourceTable: string, sourceKey: string, destinationType: string): string {
  return createHash("sha256").update(`${APPSHEET_CANONICAL_SOURCE_SYSTEM}\0${sourceTable}\0${sourceKey}\0${destinationType}`).digest("hex");
}

function destinationId(sourceTable: string, sourceKey: string, destinationType: string): string {
  return `appsheet-${destinationType}-${createHash("sha256").update(`${sourceTable}\0${sourceKey}`).digest("hex").slice(0, 32)}`;
}

function columnName(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > MAX_CELL_COUNT) fail("source_column_index_invalid");
  let number = index;
  let output = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    number = Math.floor((number - 1) / 26);
  }
  return output;
}

function effectiveText(value: AppSheetEffectiveValue): string | null {
  if (value.kind === "missing" || value.kind === "error") return null;
  return typeof value.value === "string" ? value.value : String(value.value);
}

function meaningful(row: SourceRow): boolean {
  return row.cells.some((cell) => appSheetCellFormula(cell) !== null || appSheetCellEffectiveValue(cell).kind !== "missing");
}

function normalizedHeader(value: string): string {
  return value.normalize("NFC").trim();
}

function sourceCellOriginal(cell: CellData | undefined, coordinate: string): JSONValue {
  if (!cell) return { kind: "appsheet_cell", formula: null, userEnteredValue: null, effectiveValue: null, userEnteredFormat: null, dataValidation: null };
  return jsonValue({
    kind: "appsheet_cell",
    coordinate,
    formula: appSheetCellFormula(cell),
    userEnteredValue: cell.userEnteredValue ?? null,
    effectiveValue: cell.effectiveValue ?? null,
    userEnteredFormat: cell.userEnteredFormat ?? null,
    dataValidation: cell.dataValidation ?? null,
  });
}

function sourceNumberFormat(cell: CellData | undefined): string | null {
  return typeof cell?.userEnteredFormat?.numberFormat?.pattern === "string" ? cell.userEnteredFormat.numberFormat.pattern : null;
}

function unresolvedCellMatches(markers: readonly (string | number)[], columnIndex: number | undefined, coordinate: string): boolean {
  const wantedCoordinate = coordinate.toUpperCase();
  return markers.some((marker) => {
    if (typeof marker === "number") return marker === columnIndex;
    const normalized = marker.trim().toUpperCase().replace(/\$/g, "");
    if (normalized === wantedCoordinate) return true;
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(normalized);
    if (!match || Number(match[2]) !== Number(coordinate.match(/[0-9]+$/)?.[0])) return false;
    let index = 0;
    for (const letter of match[1]!) index = index * 26 + letter.charCodeAt(0) - 64;
    return index === columnIndex;
  });
}

function exception(kind: string, severity: Severity, evidence: Record<string, string | number | boolean | null> = {}): ProjectionException {
  return { kind, severity, evidence };
}

function selectedColumns(table: AppSheetMasterTable, headers: HeaderFile["sheets"][number]): Map<string, number> {
  const found = new Map<string, number>();
  for (const column of headers.columns) {
    if (column.header === null) continue;
    const header = normalizedHeader(column.header);
    if (!MASTER_SOURCE_FIELDS[table].includes(header)) continue;
    if (found.has(header)) fail("duplicate_appsheet_master_header");
    if (column.sensitive) fail("sensitive_appsheet_master_header");
    found.set(header, column.columnIndex);
  }
  const required = table === APPSHEET_MASTER_TABLES.members
    ? ["Id_Cliente", "Nombre_Cliente", "Apellido_Cliente"]
    : ["CatalogoID", "Codigo_Detalle", "Variedad_Cann", "Descripcion", "Estado"];
  if (required.some((header) => !found.has(header))) fail("required_appsheet_master_header_missing");
  return found;
}

function fieldCell(cellsByIndex: Map<number, CellData>, index: number | undefined): CellData | undefined {
  return index === undefined ? undefined : cellsByIndex.get(index);
}

function parseAvailability(value: AppSheetEffectiveValue): { value: boolean | null; sourceText: string | null } {
  if (value.kind === "boolean") return { value: value.value, sourceText: value.value ? "Sí" : "NO" };
  if (value.kind !== "string") return { value: null, sourceText: null };
  const key = value.value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
  if (["si", "yes", "true"].includes(key)) return { value: true, sourceText: "Sí" };
  if (["no", "false"].includes(key)) return { value: false, sourceText: "NO" };
  return { value: null, sourceText: value.value };
}

function prepareRecord(
  table: AppSheetMasterTable,
  row: SourceRow,
  page: CapturePage,
  columnsByHeader: Map<string, number>,
  snapshotId: string,
  fileHash: string,
): PreparedSourceRecord {
  const cellsByIndex = new Map(row.cells.map((cell) => [cell.columnIndex, cell]));
  const exceptions: ProjectionException[] = [];
  const selected = MASTER_SOURCE_FIELDS[table].map((header) => {
    const index = columnsByHeader.get(header);
    const cell = fieldCell(cellsByIndex, index);
    const coordinate = `${index ? columnName(index) : "?"}${row.sourceRow}`;
    const value = appSheetCellEffectiveValue(cell);
    const formula = appSheetCellFormula(cell);
    if (unresolvedCellMatches(row.unresolvedFormulaCells, index, coordinate))
      exceptions.push(exception("unresolved_formula_value", "blocking", { field: header, coordinate }));
    else if (formula !== null && value.kind === "missing")
      exceptions.push(exception("unresolved_formula_value", "blocking", { field: header, coordinate }));
    else if (formula !== null && value.kind === "error")
      exceptions.push(exception("formula_calculation_error", "blocking", { field: header, coordinate, errorType: value.value.type }));
    return { header, index, cell, coordinate, value, text: effectiveText(value) };
  });

  const keyField = APPSHEET_MASTER_KEY_FIELDS[table];
  const key = selected.find((field) => field.header === keyField)!;
  const keyMissing = key.text === null || key.text.trim().length === 0;
  const sourceKey = keyMissing ? `unkeyed:${row.sourceRow}` : key.text!;
  if (keyMissing) exceptions.push(exception("missing_source_key", "blocking", { field: keyField, sourceRow: row.sourceRow }));
  else if (sourceKey.trim() !== sourceKey) exceptions.push(exception("source_key_whitespace", "blocking", { field: keyField, sourceRow: row.sourceRow }));

  const original = selected.map((field) => ({
    coordinate: field.coordinate,
    header: field.header,
    numberFormat: sourceNumberFormat(field.cell),
    value: sourceCellOriginal(field.cell, field.coordinate),
  }));
  const normalized = selected.map((field) => ({ coordinate: field.coordinate, header: field.header, value: field.text }));
  const targetBaseId = keyMissing ? null : sourceKey;
  let destination: Destination | null = null;

  if (table === APPSHEET_MASTER_TABLES.members) {
    const firstName = selected.find((field) => field.header === "Nombre_Cliente")?.text?.trim() ?? "";
    const lastName = selected.find((field) => field.header === "Apellido_Cliente")?.text?.trim() ?? "";
    const name = [firstName, lastName].filter(Boolean).join(" ");
    const emailField = selected.find((field) => field.header === "Email");
    const rawEmail = emailField?.text?.trim() ?? "";
    const email = rawEmail && z.email().safeParse(rawEmail).success ? rawEmail : "";
    if (rawEmail && !email) exceptions.push(exception("invalid_email_not_projected", "review", { field: "Email" }));

    const normalizedPhone = selected.find((field) => field.header === "Telefono_Normalizado")?.text?.trim() ?? "";
    const originalPhone = selected.find((field) => field.header === "Telefono")?.text?.trim() ?? "";
    const candidatePhone = normalizedPhone || originalPhone;
    const phone = candidatePhone.length <= 80 ? candidatePhone : "";
    if (candidatePhone && !phone) exceptions.push(exception("phone_length_not_projected", "review", { field: normalizedPhone ? "Telefono_Normalizado" : "Telefono" }));

    const street = selected.find((field) => field.header === "Domicilio")?.text?.trim() ?? "";
    const zone = selected.find((field) => field.header === "Zona")?.text?.trim() ?? "";
    let address: Record<string, unknown> = {};
    try {
      address = commercialAddress.parse({ ...(street ? { address: street } : {}), ...(zone ? { zone } : {}) }) as Record<string, unknown>;
    } catch {
      exceptions.push(exception("address_not_projected", "review", { fields: "Domicilio,Zona" }));
    }
    if (!name) exceptions.push(exception("member_name_missing", "blocking", { fields: "Nombre_Cliente,Apellido_Cliente" }));
    if (targetBaseId && name) {
      const parsed = memberInputSchema.safeParse({ name, email, phone, address });
      if (!parsed.success) exceptions.push(exception("member_payload_invalid", "blocking", { sourceRow: row.sourceRow }));
      else {
        destination = {
          type: "member",
          id: destinationId(table, targetBaseId, "member"),
          sourceTable: table,
          sourceKey: targetBaseId,
          sourceRow: row.sourceRow,
          data: {
            legacyCustomerId: targetBaseId,
            sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
            sourceId: targetBaseId,
            name: parsed.data.name,
            email: parsed.data.email,
            phone: parsed.data.phone,
            address: asInputJson(parsed.data.address),
            preferences: asInputJson({}),
          },
        };
      }
    }
  } else {
    const codeField = selected.find((field) => field.header === "Codigo_Detalle");
    const rawCode = codeField?.text ?? "";
    const variety = selected.find((field) => field.header === "Variedad_Cann")?.text ?? "";
    const description = selected.find((field) => field.header === "Descripcion")?.text ?? "";
    const availabilityField = selected.find((field) => field.header === "Estado")!;
    const availability = parseAvailability(availabilityField.value);
    if (!availabilityField.text && availability.value === null)
      exceptions.push(exception("catalogue_availability_missing", "blocking", { field: "Estado" }));
    else if (availability.value === null)
      exceptions.push(exception("catalogue_availability_unrecognized", "review", { field: "Estado" }));
    if (!description.trim() && !variety.trim())
      exceptions.push(exception("catalogue_name_missing", "blocking", { fields: "Descripcion,Variedad_Cann" }));
    if (!variety.trim()) exceptions.push(exception("catalogue_variety_missing", "blocking", { field: "Variedad_Cann" }));
    if (!rawCode.trim()) exceptions.push(exception("catalogue_business_code_missing", "blocking", { field: "Codigo_Detalle" }));
    if (rawCode && rawCode.trim() !== rawCode)
      exceptions.push(exception("catalogue_business_code_whitespace", "blocking", { field: "Codigo_Detalle" }));

    const sourcePriceSchedule = selected
      .filter((field) => /^(Precio_|Promo_|Tarifa_|Total$)/.test(field.header))
      .map((field) => ({
        field: field.header,
        coordinate: field.coordinate,
        formula: appSheetCellFormula(field.cell),
        userEnteredValue: field.cell?.userEnteredValue ?? null,
        effectiveValue: field.cell?.effectiveValue ?? null,
        numberFormat: field.cell?.userEnteredFormat?.numberFormat ?? null,
      }));
    const rawSegment = selected.find((field) => field.header === "Segmento_Descuento")?.text ?? null;
    const mappedSegment = rawSegment === "Premium" ? "Premium"
      : rawSegment === "Estandar" || rawSegment === "Estándar" ? "Estandar" : null;

    if (targetBaseId && !exceptions.some((entry) => entry.severity === "blocking")) {
      const data = {
        code: rawCode.trim(),
        name: (description.trim() || variety.trim()),
        variety: variety.trim(),
        category: "Cannabis",
        unit: "g" as const,
        // Source availability is evidence only. `active` opens /catalog and order-draft flows.
        active: false,
      };
      const parsed = catalogueInputSchema.safeParse(data);
      if (!parsed.success) exceptions.push(exception("catalogue_payload_invalid", "blocking", { sourceRow: row.sourceRow }));
      else {
        const appSheet: Record<string, JSONValue> = {
          catalogId: targetBaseId,
          availability: availability.value === null ? "NO" : availability.value ? "Sí" : "NO",
          sourceAvailability: availabilityField.text ?? "",
          description: description || variety,
          sourcePriceSchedule: jsonValue(sourcePriceSchedule),
          sourceSegment: rawSegment,
          sourceTable: table,
          sourceRow: row.sourceRow,
          sourceContentHash: row.rowHash,
          projectionRule: "category=Cannabis from club catalogue; unit=g from source price-break headers",
        };
        if (mappedSegment) appSheet.segment = mappedSegment;
        destination = {
          type: "sku", id: destinationId(table, targetBaseId, "sku"), sourceTable: table, sourceKey: targetBaseId, sourceRow: row.sourceRow,
          data: { ...parsed.data, sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: targetBaseId, appSheet },
        };
      }
    }
  }

  if (exceptions.some((entry) => entry.severity === "blocking")) destination = null;
  const content = {
    sourceTable: table,
    sourceKey,
    sourceRow: row.sourceRow,
    fileHash,
    importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
    original: { columns: original },
    normalized: { columns: normalized },
    treatment: "fact_candidate" as const,
    exceptions,
  };
  const parsedSourceRecord = sourceRecordSchema.parse({ ...content, contentHash: legacyPayloadHash(content) });
  const sourceRecord = {
    ...parsedSourceRecord,
    treatment: "fact_candidate" as const,
    original: {
      columns: parsedSourceRecord.original.columns.map((column) => ({
        coordinate: column.coordinate,
        header: column.header,
        numberFormat: column.numberFormat ?? null,
        value: jsonValue(column.value),
      })),
    },
    normalized: {
      columns: normalized,
    },
  };
  return { ...sourceRecord, id: sourceRecordId(snapshotId, table, row.sourceRow), exceptions, destination, keyMissing } satisfies PreparedSourceRecord;
}

function addDuplicateExceptions(records: PreparedSourceRecord[]): void {
  for (const table of [APPSHEET_MASTER_TABLES.members, APPSHEET_MASTER_TABLES.catalogue] as const) {
    const rows = records.filter((record) => record.sourceTable === table);
    const byKey = new Map<string, PreparedSourceRecord[]>();
    for (const record of rows) {
      if (record.keyMissing) continue;
      const group = byKey.get(record.sourceKey) ?? [];
      group.push(record);
      byKey.set(record.sourceKey, group);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      for (const record of group) {
        record.exceptions.push(exception("duplicate_source_key", "blocking", { sourceRow: record.sourceRow, sourceKeyField: APPSHEET_MASTER_KEY_FIELDS[table] }));
        record.destination = null;
      }
    }
  }
  const catalogueByCode = new Map<string, PreparedSourceRecord[]>();
  for (const record of records.filter((candidate) => candidate.sourceTable === APPSHEET_MASTER_TABLES.catalogue)) {
    const code = record.normalized.columns.find((column) => column.header === "Codigo_Detalle")?.value?.trim();
    if (!code) continue;
    const group = catalogueByCode.get(code) ?? [];
    group.push(record);
    catalogueByCode.set(code, group);
  }
  for (const group of catalogueByCode.values()) {
    if (group.length < 2) continue;
    for (const record of group) {
      record.exceptions.push(exception("duplicate_catalogue_business_code", "blocking", { sourceRow: record.sourceRow, sourceColumn: "Codigo_Detalle" }));
      record.destination = null;
    }
  }
  for (const record of records) {
    const content = {
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
    record.contentHash = legacyPayloadHash(content);
  }
}

function recordToPersisted(record: PreparedSourceRecord) {
  const { destination: _destination, exceptions: _exceptions, keyMissing: _keyMissing, ...source } = record;
  return { ...source, original: source.original, normalized: source.normalized };
}

function coverageFor(table: AppSheetMasterTable, records: PreparedSourceRecord[], blankRowsSkipped: number): AppSheetCanonicalTableCoverage {
  const forTable = records.filter((record) => record.sourceTable === table);
  return {
    sourceTable: table,
    sourceKeyField: APPSHEET_MASTER_KEY_FIELDS[table],
    rowCount: forTable.length,
    sourceRecordCount: forTable.length,
    canonicalTargetCount: forTable.filter((record) => record.destination !== null).length,
    blockingExceptionCount: forTable.reduce((count, record) => count + record.exceptions.filter((entry) => entry.severity === "blocking").length, 0),
    reviewExceptionCount: forTable.reduce((count, record) => count + record.exceptions.filter((entry) => entry.severity === "review").length, 0),
    blankRowsSkipped,
  };
}

function pageMatchesManifest(page: CapturePage, pageRef: Record<string, unknown>): boolean {
  if (page.pageHash !== pageRef.pageHash || pageRef.stable !== true || pageRef.pageHash !== pageRef.verifiedPageHash) return false;
  const { pageHash: _pageHash, ...body } = page;
  if (digest(body) !== page.pageHash) return false;
  if (page.rows.length !== page.page.endRow - page.page.startRow + 1) return false;
  const safeColumns = new Set(page.page.safeColumnIndexes);
  if (safeColumns.size !== page.page.safeColumnIndexes.length ||
      page.page.omittedColumnIndexes.some((index) => safeColumns.has(index))) return false;
  const expectedRows = new Set<number>();
  for (const row of page.rows) {
    if (row.sourceRow < page.page.startRow || row.sourceRow > page.page.endRow || expectedRows.has(row.sourceRow) ||
        new Set(row.cells.map((cell) => cell.columnIndex)).size !== row.cells.length ||
        row.cells.some((cell) => !safeColumns.has(cell.columnIndex))) return false;
    expectedRows.add(row.sourceRow);
  }
  return page.rows.every((row) => digest({
    sourceRow: row.sourceRow,
    cells: row.cells,
    unresolvedFormulaCells: row.unresolvedFormulaCells,
    safeColumnIndexes: page.page.safeColumnIndexes,
  }) === row.rowHash);
}

function verifiedMasterPageEvidence(input: { capture: AppSheetProjectionCaptureManifest; inputPages: readonly CapturePage[]; table: AppSheetMasterTable; sheet: HeaderFile["sheets"][number] }) {
  const expectedPageCount = input.sheet.pageCount;
  if (expectedPageCount === undefined || !Number.isSafeInteger(expectedPageCount) || expectedPageCount < 1)
    fail("appsheet_master_page_coverage_mismatch");
  const refs = input.capture.pageManifest.filter((ref) => ref.title === input.table && ref.sheetId === input.sheet.sheetId);
  const pages = input.inputPages.filter((page) => page.sheet.title === input.table && page.sheet.sheetId === input.sheet.sheetId);
  if (refs.length !== expectedPageCount || pages.length !== refs.length) fail("appsheet_master_page_coverage_mismatch");
  const sortedRefs = [...refs].sort((a, b) => Number(a.pageIndex) - Number(b.pageIndex));
  const sortedPages = [...pages].sort((a, b) => a.page.index - b.page.index);
  const evidence: AppSheetCanonicalProjection["verifiedMasterPages"] = [];
  for (let index = 0; index < sortedRefs.length; index++) {
    const ref = sortedRefs[index]!;
    const page = sortedPages[index]!;
    if (typeof ref.pageIndex !== "number" || typeof ref.startRow !== "number" || typeof ref.endRow !== "number" ||
        !pageMatchesManifest(page, ref) || page.page.index !== ref.pageIndex || page.page.startRow !== ref.startRow ||
        page.page.endRow !== ref.endRow || page.schemaVersion !== PAGE_SCHEMA ||
        page.sheet.mode !== "table" || page.sheet.headerRow !== input.sheet.headerRow || page.sheet.title !== input.sheet.title ||
        page.sheet.hidden !== undefined && page.sheet.hidden !== input.sheet.hidden ||
        page.spreadsheetId !== input.capture.spreadsheetId || page.sourceSystem !== input.capture.sourceSystem ||
        page.sheet.sheetId !== input.sheet.sheetId) fail("appsheet_master_page_unverified");
    evidence.push({
      sheetId: page.sheet.sheetId,
      sheetTitle: page.sheet.title,
      pageIndex: page.page.index,
      startRow: page.page.startRow,
      endRow: page.page.endRow,
      pageHash: page.pageHash,
      rowCount: page.rows.filter((row) => row.sourceRow > (input.sheet.headerRow ?? 0) && meaningful(row)).length,
    });
  }
  return { pages: sortedPages, evidence };
}

export function prepareAppSheetMasterProjection(
  input: AppSheetCanonicalCaptureInput,
  options: { allowStagedDelta?: boolean; expectedAppId?: string } = {},
): AppSheetCanonicalProjection {
  let capture: AppSheetProjectionCaptureManifest;
  try {
    capture = prepareAppSheetProjectionCaptureManifest(input.manifest, { mode: input.mode, allowStagedDelta: options.allowStagedDelta });
  } catch (error) {
    if (error instanceof AppSheetCanonicalError) throw error;
    if (error instanceof Error && error.message.includes("autorización explícita")) fail("staged_delta_requires_explicit_flag");
    fail("capture_manifest_invalid");
  }
  let definitionInventory: AppSheetDefinitionInventory;
  try {
    definitionInventory = prepareAppSheetDefinitionInventory(input.definitionInventory, options.expectedAppId ?? APPSHEET_EXPECTED_LIVE_APP_ID);
  } catch (error) {
    if (error instanceof AppSheetCanonicalError) throw error;
    fail("definition_inventory_invalid");
  }
  const appliedDefinitionHash = appSheetAppliedDefinitionHash(definitionInventory);
  const expectedAppId = options.expectedAppId ?? APPSHEET_EXPECTED_LIVE_APP_ID;
  const definitionIdentityState = definitionInventory.app.id === expectedAppId ? "verified" : "missing-in-source-inventory";
  if (input.headers.schemaVersion !== HEADER_SCHEMA || input.headers.spreadsheetId !== capture.spreadsheetId ||
      capture.sourceSystem !== APPSHEET_CANONICAL_SOURCE_SYSTEM || !Array.isArray(input.headers.sheets)) fail("capture_headers_invalid");
  if (capture.stabilityMode === "staged-delta" && (capture.stability.metadataStable !== true || capture.stability.headersStable !== true))
    fail("capture_delta_metadata_or_headers_unstable");

  const snapshotId = snapshotIdFor({ capture, appliedDefinitionHash });
  const records: PreparedSourceRecord[] = [];
  const verifiedMasterPages: AppSheetCanonicalProjection["verifiedMasterPages"] = [];
  const blankRowsSkipped = new Map<AppSheetMasterTable, number>([[APPSHEET_MASTER_TABLES.members, 0], [APPSHEET_MASTER_TABLES.catalogue, 0]]);
  for (const table of [APPSHEET_MASTER_TABLES.members, APPSHEET_MASTER_TABLES.catalogue] as const) {
    const matches = input.headers.sheets.filter((sheet) => sheet.title === table);
    if (matches.length !== 1) fail("appsheet_master_sheet_missing_or_ambiguous");
    const sheet = matches[0]!;
    if (sheet.mode !== "table" || sheet.hidden || sheet.headerRow === null) fail("appsheet_master_sheet_not_projectable");
    const columnsByHeader = selectedColumns(table, sheet);
    const verified = verifiedMasterPageEvidence({ capture, inputPages: input.pages, table, sheet });
    const pages = verified.pages;
    verifiedMasterPages.push(...verified.evidence);
    const seenRows = new Set<number>();
    for (const page of [...pages].sort((a, b) => a.page.index - b.page.index)) {
      for (const row of page.rows) {
        if (row.sourceRow <= sheet.headerRow) continue;
        if (row.sourceRow > MAX_ROWS || seenRows.has(row.sourceRow)) fail("appsheet_master_row_coverage_mismatch");
        seenRows.add(row.sourceRow);
        if (!meaningful(row)) {
          blankRowsSkipped.set(table, blankRowsSkipped.get(table)! + 1);
          continue;
        }
        if (row.cells.length > MAX_CELL_COUNT || !HASH.test(row.rowHash)) fail("appsheet_master_row_invalid");
        records.push(prepareRecord(table, row, page, columnsByHeader, snapshotId, capture.manifestHash));
      }
    }
    const coverageSheet = (capture.dataCoverage as { sheets?: Array<Record<string, unknown>> }).sheets?.find((candidate) =>
      candidate.title === table || candidate.name === table);
    if (!coverageSheet || coverageSheet.sheetId !== sheet.sheetId) fail("appsheet_master_coverage_missing");
  }
  addDuplicateExceptions(records);

  const destinations = records.flatMap((record) => record.destination ? [record.destination] : []);
  const exceptions: AppSheetCanonicalProjection["exceptions"] = records.flatMap((record) => record.exceptions.map((entry, index) => ({
    id: digest(`${snapshotId}\0${record.id}\0${entry.kind}\0${index}`),
    sourceRecordId: record.id,
    kind: entry.kind,
    severity: entry.severity,
    description: `AppSheet ${record.sourceTable} fila ${record.sourceRow}: ${entry.kind}.`,
    resolution: null,
  })));
  const changedPages = capture.pageManifest.filter((page) => page.stable === false);
  if (capture.stabilityMode === "staged-delta") {
    for (const page of changedPages) {
      const title = typeof page.title === "string" ? page.title : "desconocida";
      const sheetId = typeof page.sheetId === "number" ? page.sheetId : -1;
      const pageIndex = typeof page.pageIndex === "number" ? page.pageIndex : -1;
      if (APPSHEET_MASTER_TABLES.members === title || APPSHEET_MASTER_TABLES.catalogue === title)
        fail("appsheet_master_page_changed_during_capture");
      exceptions.push({
        id: digest(`${snapshotId}\0delta\0${sheetId}\0${pageIndex}`),
        sourceRecordId: null,
        kind: "non_master_source_page_delta_unresolved",
        severity: "blocking",
        description: `AppSheet ${title} página ${pageIndex}: variación global fuera del subconjunto de maestros verificados; requiere captura y conciliación.`,
        resolution: null,
      });
    }
  }
  const tableCoverage = [
    coverageFor(APPSHEET_MASTER_TABLES.members, records, blankRowsSkipped.get(APPSHEET_MASTER_TABLES.members)! ),
    coverageFor(APPSHEET_MASTER_TABLES.catalogue, records, blankRowsSkipped.get(APPSHEET_MASTER_TABLES.catalogue)! ),
  ];
  const projectionHash = digest({
    schemaVersion: 1,
    projectionKind: "masters",
    mappingId: APPSHEET_CANONICAL_MAPPING_ID,
    importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
    captureId: capture.captureId,
    manifestHash: capture.manifestHash,
    dataHash: capture.dataHash,
    captureDefinitionHash: capture.definitionHash,
    appliedDefinitionHash,
    expectedAppId,
    definitionIdentityState,
    definitionDescriptorSha256: definitionInventory.descriptorSha256,
    definitionSourceSha256: definitionInventory.source.sha256,
    stabilityMode: capture.stabilityMode,
    verifiedMasterPages,
    deltaPageHashes: changedPages.map((page) => ({
      sheetId: page.sheetId,
      title: page.title,
      pageIndex: page.pageIndex,
      startRow: page.startRow,
      endRow: page.endRow,
      pageHash: page.pageHash,
      verifiedPageHash: page.verifiedPageHash,
      stable: page.stable,
      ...(page.pass3Evidence === undefined ? {} : { pass3Evidence: page.pass3Evidence }),
    })),
    tables: tableCoverage,
    records: records.map((record) => ({
      sourceTable: record.sourceTable,
      sourceKey: record.sourceKey,
      sourceRow: record.sourceRow,
      contentHash: record.contentHash,
      normalizedHash: digest(record.normalized),
      treatment: record.treatment,
      exceptions: record.exceptions,
      destination: record.destination ? { type: record.destination.type, id: record.destination.id, payloadHash: digest(record.destination.data) } : null,
    })),
  });
  return {
    schemaVersion: 1,
    projectionKind: "masters",
    mappingId: APPSHEET_CANONICAL_MAPPING_ID,
    importerVersion: APPSHEET_CANONICAL_IMPORTER_VERSION,
    capture,
    appliedDefinitionHash,
    expectedAppId,
    definitionIdentityState,
    definitionInventory,
    snapshotId,
    projectionHash,
    records,
    destinations,
    exceptions,
    tableCoverage,
    verifiedMasterPages,
    summary: {
      recordCount: records.length,
      memberTargetCount: destinations.filter((destination) => destination.type === "member").length,
      catalogueTargetCount: destinations.filter((destination) => destination.type === "sku").length,
      exceptionCount: exceptions.length,
      blockingExceptionCount: exceptions.filter((entry) => entry.severity === "blocking").length,
      reviewExceptionCount: exceptions.filter((entry) => entry.severity === "review").length,
      globalDeltaBlockingCount: exceptions.filter((entry) => entry.kind === "non_master_source_page_delta_unresolved").length,
    },
  };
}

function jsonForPrisma(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function timestamp(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) fail("capture_timestamp_invalid");
  return result;
}

function dateISO(value: Date): string {
  return value.toISOString();
}

function compareCapture(existing: Record<string, unknown>, prepared: PreparedAppSheetCaptureManifest): void {
  const fields: Array<keyof PreparedAppSheetCaptureManifest> = [
    "captureId", "sourceSystem", "sourceId", "spreadsheetId", "metadataHash", "headersHash", "manifestHash", "dataHash", "definitionHash",
    "stability", "firstReadAt", "verificationStartedAt", "verificationCompletedAt", "cutoffAt", "dataCoverage", "pageManifest", "definitionCoverage",
    "dataSheetCount", "dataPageCount", "dataRecordCount", "dataFormulaCount", "dataUnresolvedFormulaCount", "definitionTableCount",
    "definitionColumnCount", "definitionSliceCount", "definitionViewCount", "definitionActionCount", "definitionBotCount",
    "definitionWorkflowRuleCount", "definitionFormatRuleCount",
  ];
  for (const field of fields) {
    const actual = existing[field];
    const expected = prepared[field];
    const normalizedActual = actual instanceof Date ? dateISO(actual) : actual;
    if (!sameJson(normalizedActual, expected)) fail("capture_manifest_immutable_conflict");
  }
}

/** Ensure an exact immutable capture row. It never sets an approval or verified state. */
export async function ensureAppSheetCaptureManifest(
  tx: PrismaNamespace.TransactionClient,
  prepared: PreparedAppSheetCaptureManifest,
): Promise<string> {
  const valid = prepareAppSheetCaptureManifest({
    schemaVersion: "appsheet-capture-manifest/v1",
    ...prepared,
    coverage: prepared.dataCoverage,
    pages: prepared.pageManifest,
  });
  let existing = await tx.appSheetCaptureManifest.findUnique({ where: { captureId: valid.captureId } });
  if (!existing) {
    const values = {
      captureId: valid.captureId,
      sourceSystem: valid.sourceSystem,
      sourceId: valid.sourceId,
      spreadsheetId: valid.spreadsheetId,
      metadataHash: valid.metadataHash,
      headersHash: valid.headersHash,
      manifestHash: valid.manifestHash,
      dataHash: valid.dataHash,
      definitionHash: valid.definitionHash,
      stability: jsonForPrisma(valid.stability),
      firstReadAt: timestamp(valid.firstReadAt),
      verificationStartedAt: timestamp(valid.verificationStartedAt),
      verificationCompletedAt: timestamp(valid.verificationCompletedAt),
      cutoffAt: timestamp(valid.cutoffAt),
      dataCoverage: jsonForPrisma(valid.dataCoverage),
      pageManifest: jsonForPrisma(valid.pageManifest),
      definitionCoverage: valid.definitionCoverage === null ? Prisma.DbNull : jsonForPrisma(valid.definitionCoverage),
      dataSheetCount: valid.dataSheetCount,
      dataPageCount: valid.dataPageCount,
      dataRecordCount: valid.dataRecordCount,
      dataFormulaCount: valid.dataFormulaCount,
      dataUnresolvedFormulaCount: valid.dataUnresolvedFormulaCount,
      definitionTableCount: valid.definitionTableCount,
      definitionColumnCount: valid.definitionColumnCount,
      definitionSliceCount: valid.definitionSliceCount,
      definitionViewCount: valid.definitionViewCount,
      definitionActionCount: valid.definitionActionCount,
      definitionBotCount: valid.definitionBotCount,
      definitionWorkflowRuleCount: valid.definitionWorkflowRuleCount,
      definitionFormatRuleCount: valid.definitionFormatRuleCount,
    };
    await tx.appSheetCaptureManifest.createMany({ data: [values], skipDuplicates: true });
    existing = await tx.appSheetCaptureManifest.findUnique({ where: { captureId: valid.captureId } });
  }
  if (!existing) fail("capture_manifest_create_failed");
  compareCapture(existing as unknown as Record<string, unknown>, valid);
  return valid.captureId;
}

function stableCaptureForDatabase(capture: AppSheetProjectionCaptureManifest): PreparedAppSheetCaptureManifest {
  if (capture.stabilityMode !== "stable" || !capture.cutoffAt) fail("preliminary_capture_cannot_be_registered");
  return prepareAppSheetCaptureManifest({
    schemaVersion: "appsheet-capture-manifest/v1",
    ...capture,
    coverage: capture.dataCoverage,
    pages: capture.pageManifest,
  });
}

function snapshotCoverage(projection: AppSheetCanonicalProjection): Record<string, unknown> {
  const deltaPages = projection.capture.pageManifest
    .filter((page) => page.stable === false)
    .map((page) => ({
      sheetId: page.sheetId,
      title: page.title,
      pageIndex: page.pageIndex,
      startRow: page.startRow,
      endRow: page.endRow,
      pass1Hash: page.pageHash,
      pass2Hash: page.verifiedPageHash,
      pass3Evidence: page.pass3Evidence ?? null,
    }));
  return {
    schemaVersion: 1,
    appSheetCanonical: {
      captureId: projection.capture.captureId,
      sourceSystem: projection.capture.sourceSystem,
      sourceId: projection.capture.sourceId,
      manifestHash: projection.capture.manifestHash,
      dataHash: projection.capture.dataHash,
      captureDefinitionHash: projection.capture.definitionHash,
      appliedDefinitionHash: projection.appliedDefinitionHash,
      definitionReadiness: appSheetDefinitionProductionReadiness(projection.definitionInventory, projection.expectedAppId),
      expectedAppId: projection.expectedAppId,
      identityState: projection.definitionIdentityState,
      projectionHash: projection.projectionHash,
      stabilityMode: projection.capture.stabilityMode,
      cutoffAt: projection.capture.cutoffAt,
      timestampGaps: projection.capture.timestampGaps,
      verifiedMasterPages: projection.verifiedMasterPages,
      delta: {
        globallyStable: projection.capture.stabilityMode === "stable",
        unresolvedChangedPageCount: deltaPages.length,
        changedPages: deltaPages,
      },
      tables: projection.tableCoverage,
      counts: projection.summary,
      definition: {
        sourceSha256: projection.definitionInventory.source.sha256,
        descriptorSha256: projection.definitionInventory.descriptorSha256,
        appliedDefinitionHash: projection.appliedDefinitionHash,
        appId: projection.definitionInventory.app.id,
        expectedAppId: projection.expectedAppId,
        identityState: projection.definitionIdentityState,
        parserVersion: projection.definitionInventory.parserVersion,
        declaredCounts: projection.definitionInventory.declaredCounts,
        observedCounts: projection.definitionInventory.observedCounts,
        coverage: projection.definitionInventory.coverage,
      },
      botInventory: {
        state: "unsupported-in-generated-documentation",
        observedCount: null,
        uiEvidenceState: "pending-verifiable-editor-capture",
      },
    },
  };
}

type BackupEvidence = { manifestHash: string; snapshotAt: string };
type StageContext = { target: AppSheetReviewTarget; destinationIdentity: string; backupEvidence?: BackupEvidence };

type DestinationFingerprint = {
  destinationType: "member" | "sku";
  sourceTable: string;
  sourceKey: string;
  destinationId: string;
  dataHash: string;
  operationVersion: number;
};

type MasterStagePlan = {
  mode: "create" | "reuse" | "refresh";
  destination: Destination;
  beforeHash: string | null;
  afterHash: string;
  operationVersion: number;
  nextOperationVersion: number;
  previousSnapshotId: string | null;
  previousOperationVersion: number | null;
  existingCatalogueCode: string | null;
  existingTarget: unknown | null;
};

function snapshotControls(
  projection: AppSheetCanonicalProjection,
  review: ReturnType<typeof requireAppSheetTechnicalReview>,
  context: StageContext,
  destinationFingerprints: DestinationFingerprint[],
) {
  return {
    appSheetCanonical: {
      schemaVersion: 1,
      projectionKind: "masters",
      mappingId: projection.mappingId,
      importerVersion: projection.importerVersion,
      captureId: projection.capture.captureId,
      manifestHash: projection.capture.manifestHash,
      dataHash: projection.capture.dataHash,
      captureDefinitionHash: projection.capture.definitionHash,
      appliedDefinitionHash: projection.appliedDefinitionHash,
      definitionReadiness: appSheetDefinitionProductionReadiness(projection.definitionInventory, projection.expectedAppId),
      expectedAppId: projection.expectedAppId,
      definitionIdentityState: projection.definitionIdentityState,
      definitionInventory: projection.definitionInventory,
      projectionHash: projection.projectionHash,
      stabilityMode: projection.capture.stabilityMode,
      cutoffAt: projection.capture.cutoffAt,
      timestampGaps: projection.capture.timestampGaps,
      verifiedMasterPages: projection.verifiedMasterPages,
      destinationFingerprints,
      globalDelta: {
        globallyStable: projection.capture.stabilityMode === "stable",
        unresolvedChangedPageCount: projection.summary.globalDeltaBlockingCount,
        changedPages: projection.capture.pageManifest.filter((page) => page.stable === false).map((page) => ({
          sheetId: page.sheetId, title: page.title, pageIndex: page.pageIndex, startRow: page.startRow, endRow: page.endRow,
          pass1Hash: page.pageHash, pass2Hash: page.verifiedPageHash, pass3Evidence: page.pass3Evidence ?? null,
        })),
      },
      technicalReview: {
        schemaVersion: review.schemaVersion,
        reviewKind: review.reviewKind,
        importer: review.importer,
        reviewer: review.reviewer,
        reviewedAt: review.reviewedAt,
        approved: review.approved,
        findingsCount: review.findings.length,
        projectionHash: review.projectionHash,
        captureId: review.captureId,
        manifestHash: review.manifestHash,
        definitionHash: review.definitionHash ?? null,
        commitSha: review.commitSha,
        bindingSource: review.schemaVersion === 1 ? "legacy-isolated-only" : "explicit-target-and-destination",
        ...(review.schemaVersion === 2 ? { target: review.target, destinationIdentity: review.destinationIdentity } : {}),
      },
      botInventory: {
        state: "unsupported-in-generated-documentation",
        observedCount: null,
        uiEvidenceState: "pending-verifiable-editor-capture",
      },
      stageContext: {
        target: context.target,
        destinationIdentity: context.destinationIdentity,
        backupEvidence: context.backupEvidence ?? null,
      },
      humanReview: { status: "pending" },
      operationalAuthority: { status: "unchanged" },
      effects: { stock: false, cash: false, orders: false, deliveries: false, messaging: false, priceApproval: false },
      projectionRules: {
        memberName: "Nombre_Cliente + Apellido_Cliente; only commercial address, contact and identity fields",
        memberContactConsent: "not projected into preferences; messaging is not triggered",
        catalogueKey: "CatalogoID; Codigo_Detalle remains the unique business code",
        catalogueCategory: "Cannabis, inferred from the club catalogue source context",
        catalogueUnit: "g, from the six source price headers explicitly named Gramos",
        cataloguePrices: "retained verbatim in LegacySourceRecord; not applied as approved prices",
        catalogueAvailability: "source Estado is retained in appSheet.availability; CatalogSku.active=false until separate operational approval because active exposes /catalog and order drafts",
        definitionIdentity: "expected live app id is separately supplied; if the inventory omits app.id, identity remains unverified and cutover stays blocked; source data manifest definitionHash remains unchanged",
        definitionReadiness: "production staging requires parser 1.2.0 or newer plus app id, name, and version; older or incomplete inventories remain isolated archives",
      },
    },
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableComparableJson(left) === stableComparableJson(right);
}

/** Structural comparison for persisted JSON. Unlike canonicalJson's domain-aware
 * amount validator, this must allow semantic flags such as `effects.cash: false`.
 */
function stableComparableJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("json_comparison_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableComparableJson).join(",")}]`;
  const object = objectValue(value);
  if (!object) fail("json_comparison_invalid");
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableComparableJson(object[key])}`).join(",")}}`;
}

function memberMatches(existing: { id: string; legacyCustomerId: string | null; name: string; email: string; phone: string; address: unknown; preferences: unknown; sourceSystem: string | null; sourceId: string | null }, destination: Extract<Destination, { type: "member" }>): boolean {
  return existing.id === destination.id && existing.legacyCustomerId === destination.data.legacyCustomerId &&
    existing.name === destination.data.name && existing.email === destination.data.email && existing.phone === destination.data.phone &&
    existing.sourceSystem === destination.data.sourceSystem && existing.sourceId === destination.data.sourceId &&
    sameJson(existing.address, destination.data.address) && sameJson(existing.preferences, destination.data.preferences);
}

function skuMatches(existing: { id: string; code: string; name: string; variety: string; category: string; unit: string; active: boolean; sourceSystem: string | null; sourceId: string | null; appSheet: unknown }, destination: Extract<Destination, { type: "sku" }>): boolean {
  return existing.id === destination.id && existing.code === destination.data.code && existing.name === destination.data.name &&
    existing.variety === destination.data.variety && existing.category === destination.data.category && existing.unit === destination.data.unit &&
    existing.active === destination.data.active && existing.sourceSystem === destination.data.sourceSystem && existing.sourceId === destination.data.sourceId &&
    sameJson(existing.appSheet, destination.data.appSheet);
}

async function assertActorCanStage(tx: PrismaNamespace.TransactionClient, actorId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { id: true, role: true, active: true } });
  if (!actor?.active || (actor.role !== "owner" && actor.role !== "admin")) fail("active_admin_actor_required");
  const grant = await tx.operationAccess.findUnique({ where: { userId: actorId }, select: { enabled: true, capabilities: true } });
  if (!capabilitiesFromGrant(actor, grant).includes("imports.write")) fail("imports_write_capability_required");
  return actor;
}

function prepareReview(projection: AppSheetCanonicalProjection, actorId: string, input: unknown, commitSha: string, context: StageContext) {
  const review = requireAppSheetTechnicalReview(input, {
    captureId: projection.capture.captureId,
    manifestHash: projection.capture.manifestHash,
    definitionHash: projection.appliedDefinitionHash,
    projectionKind: "masters",
    projectionHash: projection.projectionHash,
    commitSha,
    importer: APPSHEET_CANONICAL_IMPORTER_VERSION,
    target: context.target,
    destinationIdentity: context.destinationIdentity,
  });
  if (review.reviewer.trim().toLowerCase() === actorId.trim().toLowerCase()) fail("independent_technical_reviewer_required");
  return review;
}

function snapshotIdFor(input: { capture: AppSheetProjectionCaptureManifest; appliedDefinitionHash: string; importerVersion?: string }): string {
  return `legacy-${legacyPayloadHash({
    sourceSystem: input.capture.sourceSystem,
    fileHash: input.capture.manifestHash,
    appliedDefinitionHash: input.appliedDefinitionHash,
    importerVersion: input.importerVersion ?? APPSHEET_CANONICAL_IMPORTER_VERSION,
  })}`;
}

async function validateExistingSnapshot(tx: PrismaNamespace.TransactionClient, projection: AppSheetCanonicalProjection, actorId: string, controls: unknown, coverage: unknown): Promise<boolean> {
  const snapshot = await tx.legacyImportSnapshot.findUnique({ where: { id: projection.snapshotId } });
  if (!snapshot) return false;
  const expectedCaptureManifestId = projection.capture.stabilityMode === "stable" ? projection.capture.captureId : null;
  if (snapshot.sourceSystem !== APPSHEET_CANONICAL_SOURCE_SYSTEM || snapshot.fileHash !== projection.capture.manifestHash ||
      snapshot.importerVersion !== projection.importerVersion || snapshot.captureManifestId !== expectedCaptureManifestId ||
      snapshot.status !== "staged" || snapshot.reviewedBy !== null || snapshot.reviewedAt !== null || snapshot.createdBy !== actorId ||
      !sameJson(snapshot.controls, controls) || !sameJson(snapshot.coverage, coverage)) fail("existing_snapshot_conflict");

  const persistedRecords = await tx.legacySourceRecord.findMany({ where: { snapshotId: snapshot.id }, orderBy: [{ sourceTable: "asc" }, { sourceRow: "asc" }] });
  const expectedRecords = [...projection.records].sort((a, b) => a.sourceTable.localeCompare(b.sourceTable) || a.sourceRow - b.sourceRow);
  if (persistedRecords.length !== expectedRecords.length) fail("existing_snapshot_record_count_conflict");
  for (let index = 0; index < expectedRecords.length; index++) {
    const current = persistedRecords[index]!;
    const expected = expectedRecords[index]!;
    if (current.id !== expected.id || current.sourceTable !== expected.sourceTable || current.sourceKey !== expected.sourceKey ||
        current.sourceRow !== expected.sourceRow || current.fileHash !== expected.fileHash || current.contentHash !== expected.contentHash ||
        current.importerVersion !== expected.importerVersion || current.treatment !== expected.treatment ||
        !sameJson(current.original, expected.original) || !sameJson(current.normalized, expected.normalized)) fail("existing_snapshot_record_conflict");
  }
  const persistedExceptions = await tx.legacyException.findMany({ where: { snapshotId: snapshot.id }, orderBy: [{ sourceRecordId: "asc" }, { kind: "asc" }, { id: "asc" }] });
  // PostgreSQL ASC orders NULLs last by default. Match the database ordering
  // without dereferencing null global-delta exception identities.
  const expectedExceptions = [...projection.exceptions].sort((a, b) => {
    if (a.sourceRecordId === null && b.sourceRecordId !== null) return 1;
    if (a.sourceRecordId !== null && b.sourceRecordId === null) return -1;
    return (a.sourceRecordId ?? "").localeCompare(b.sourceRecordId ?? "") || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);
  });
  if (persistedExceptions.length !== expectedExceptions.length) fail("existing_snapshot_exception_count_conflict");
  for (let index = 0; index < expectedExceptions.length; index++) {
    const current = persistedExceptions[index]!;
    const expected = expectedExceptions[index]!;
    if (current.id !== expected.id || current.sourceRecordId !== expected.sourceRecordId || current.kind !== expected.kind ||
        current.severity !== expected.severity || current.description !== expected.description || current.status !== "open") fail("existing_snapshot_exception_conflict");
  }
  for (const destination of projection.destinations) {
    if (destination.type === "member") {
      const member = await tx.operationMember.findUnique({ where: { id: destination.id } });
      if (!member || !memberMatches(member, destination)) fail("existing_member_projection_conflict");
    } else {
      const sku = await tx.catalogSku.findUnique({ where: { id: destination.id } });
      if (!sku || !skuMatches(sku, destination)) fail("existing_catalogue_projection_conflict");
    }
    const identity = await tx.legacyIdentity.findUnique({ where: { sourceSystem_sourceTable_sourceKey_destinationType: {
      sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceTable: destination.sourceTable, sourceKey: destination.sourceKey, destinationType: destination.type,
    } } });
    if (!identity || identity.destinationId !== destination.id) fail("existing_identity_projection_conflict");
    const object = await tx.operationObject.findUnique({ where: { id: destination.id }, select: { id: true, kind: true } });
    if (!object || object.kind !== destination.type) fail("existing_master_operation_object_conflict");
  }
  const snapshotObject = await tx.operationObject.findUnique({ where: { id: snapshot.id }, select: { kind: true } });
  if (!snapshotObject || snapshotObject.kind !== "legacyImport") fail("existing_snapshot_operation_object_conflict");
  return true;
}

type PriorMasterBaseline = {
  snapshotId: string;
  status: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  stabilityMode: string | null;
  fingerprint: DestinationFingerprint | null;
};

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function fingerprintFrom(value: unknown, destination: Destination): DestinationFingerprint | null {
  const row = objectValue(value);
  if (!row || row.destinationType !== destination.type || row.sourceTable !== destination.sourceTable ||
      row.sourceKey !== destination.sourceKey || row.destinationId !== destination.id ||
      typeof row.dataHash !== "string" || !HASH.test(row.dataHash) ||
      typeof row.operationVersion !== "number" || !Number.isSafeInteger(row.operationVersion) || row.operationVersion < 0)
    return null;
  return {
    destinationType: destination.type,
    sourceTable: destination.sourceTable,
    sourceKey: destination.sourceKey,
    destinationId: destination.id,
    dataHash: row.dataHash,
    operationVersion: row.operationVersion,
  };
}

async function findPriorMasterBaseline(
  tx: PrismaNamespace.TransactionClient,
  destination: Destination,
): Promise<PriorMasterBaseline | null> {
  const snapshots = await tx.legacyImportSnapshot.findMany({
    where: { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, status: true, reviewedBy: true, reviewedAt: true, controls: true },
  });
  for (const snapshot of snapshots) {
    const controls = objectValue(snapshot.controls);
    const canonical = objectValue(controls?.appSheetCanonical);
    if (canonical?.projectionKind !== "masters" || canonical.mappingId !== APPSHEET_CANONICAL_MAPPING_ID) continue;
    const sourceRecord = await tx.legacySourceRecord.findFirst({
      where: { snapshotId: snapshot.id, sourceTable: destination.sourceTable, sourceKey: destination.sourceKey },
      select: { id: true },
    });
    if (!sourceRecord) continue;
    const fingerprints = Array.isArray(canonical.destinationFingerprints) ? canonical.destinationFingerprints : [];
    const fingerprint = fingerprints.map((entry) => fingerprintFrom(entry, destination)).find(Boolean) ?? null;
    return {
      snapshotId: snapshot.id,
      status: snapshot.status,
      reviewedBy: snapshot.reviewedBy,
      reviewedAt: snapshot.reviewedAt,
      stabilityMode: canonical.stabilityMode === "stable" || canonical.stabilityMode === "staged-delta" ? canonical.stabilityMode : null,
      fingerprint,
    };
  }
  return null;
}

function currentDestinationHash(existing: unknown, destinationType: "member" | "sku"): string {
  if (destinationType === "member") {
    const member = existing as { legacyCustomerId: string | null; sourceSystem: string | null; sourceId: string | null; name: string; email: string; phone: string; address: unknown; preferences: unknown };
    return digest({
      legacyCustomerId: member.legacyCustomerId,
      sourceSystem: member.sourceSystem,
      sourceId: member.sourceId,
      name: member.name,
      email: member.email,
      phone: member.phone,
      address: jsonValue(member.address),
      preferences: jsonValue(member.preferences),
    });
  }
  const sku = existing as { code: string; name: string; variety: string; category: string; unit: string; active: boolean; sourceSystem: string | null; sourceId: string | null; appSheet: unknown };
  return digest({
    code: sku.code,
    name: sku.name,
    variety: sku.variety,
    category: sku.category,
    unit: sku.unit,
    active: sku.active,
    sourceSystem: sku.sourceSystem,
    sourceId: sku.sourceId,
    appSheet: sku.appSheet === null ? null : jsonValue(sku.appSheet),
  });
}

/** Hash the current canonical master fields with the exact shape used by staging. */
export function appSheetCanonicalCurrentDestinationHash(existing: unknown, destinationType: "member" | "sku"): string {
  return currentDestinationHash(existing, destinationType);
}

async function prepareMasterStagePlan(
  tx: PrismaNamespace.TransactionClient,
  projection: AppSheetCanonicalProjection,
  refreshPreliminary: boolean,
): Promise<MasterStagePlan[]> {
  const plans: MasterStagePlan[] = [];
  for (const destination of projection.destinations) {
    const identity = await tx.legacyIdentity.findUnique({ where: { sourceSystem_sourceTable_sourceKey_destinationType: {
      sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceTable: destination.sourceTable, sourceKey: destination.sourceKey, destinationType: destination.type,
    } } });
    const object = await tx.operationObject.findUnique({ where: { id: destination.id }, select: { id: true, kind: true, version: true } });
    let existing: unknown;
    if (destination.type === "member") {
      const [byId, byLegacyKey, bySource] = await Promise.all([
        tx.operationMember.findUnique({ where: { id: destination.id } }),
        tx.operationMember.findUnique({ where: { legacyCustomerId: destination.sourceKey } }),
        tx.operationMember.findUnique({ where: { sourceSystem_sourceId: { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: destination.sourceKey } } }),
      ]);
      if ([byId, byLegacyKey, bySource].some((row) => row && row.id !== destination.id)) fail("member_source_or_identity_collision");
      existing = byId ?? byLegacyKey ?? bySource;
    } else {
      const [byId, byCode, bySource] = await Promise.all([
        tx.catalogSku.findUnique({ where: { id: destination.id } }),
        tx.catalogSku.findUnique({ where: { code: destination.data.code } }),
        tx.catalogSku.findUnique({ where: { sourceSystem_sourceId: { sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM, sourceId: destination.sourceKey } } }),
      ]);
      if ([byId, byCode, bySource].some((row) => row && row.id !== destination.id)) fail("catalogue_source_code_or_identity_collision");
      existing = byId ?? byCode ?? bySource;
    }

    const afterHash = digest(destination.data);
    if (!identity && !object && !existing) {
      plans.push({ mode: "create", destination, beforeHash: null, afterHash, operationVersion: 0,
        nextOperationVersion: 0, previousSnapshotId: null, previousOperationVersion: null, existingCatalogueCode: null, existingTarget: null });
      continue;
    }
    if (!identity || identity.destinationId !== destination.id || !object || object.kind !== destination.type || !existing)
      fail("master_source_or_identity_collision");

    const expectedSourceId = destination.data.sourceId;
    if (destination.type === "member") {
      const member = existing as { id: string; legacyCustomerId: string | null; name: string; email: string; phone: string; address: unknown; preferences: unknown; sourceSystem: string | null; sourceId: string | null };
      if (!memberMatches(member, destination)) {
        if (!refreshPreliminary) fail("preliminary_master_refresh_requires_explicit_flag");
        if (projection.capture.stabilityMode !== "stable") fail("preliminary_master_refresh_requires_stable_capture");
      } else {
        plans.push({ mode: "reuse", destination, beforeHash: afterHash, afterHash, operationVersion: object.version,
          nextOperationVersion: object.version, previousSnapshotId: null, previousOperationVersion: null, existingCatalogueCode: null, existingTarget: existing });
        continue;
      }
    } else {
      const sku = existing as { id: string; code: string; name: string; variety: string; category: string; unit: string; active: boolean; sourceSystem: string | null; sourceId: string | null; appSheet: unknown };
      if (!skuMatches(sku, destination)) {
        if (!refreshPreliminary) fail("preliminary_master_refresh_requires_explicit_flag");
        if (projection.capture.stabilityMode !== "stable") fail("preliminary_master_refresh_requires_stable_capture");
      } else {
        plans.push({ mode: "reuse", destination, beforeHash: afterHash, afterHash, operationVersion: object.version,
          nextOperationVersion: object.version, previousSnapshotId: null, previousOperationVersion: null, existingCatalogueCode: null, existingTarget: existing });
        continue;
      }
    }

    if (identity.approvedBy !== null) fail("preliminary_master_refresh_identity_approved");
    if (object.version < 0 || object.version >= 2_147_483_646) fail("preliminary_master_refresh_version_invalid");
    const prior = await findPriorMasterBaseline(tx, destination);
    if (!prior || !prior.fingerprint) fail("preliminary_master_refresh_baseline_missing");
    if (prior.status !== "staged" || prior.reviewedBy !== null || prior.reviewedAt !== null)
      fail("preliminary_master_refresh_snapshot_not_pending");
    if (prior.stabilityMode === null) fail("preliminary_master_refresh_baseline_missing");
    if (prior.fingerprint.destinationType !== destination.type || prior.fingerprint.sourceTable !== destination.sourceTable ||
        prior.fingerprint.sourceKey !== destination.sourceKey || prior.fingerprint.destinationId !== destination.id)
      fail("preliminary_master_refresh_lineage_mismatch");
    const beforeHash = currentDestinationHash(existing, destination.type);
    if (beforeHash !== prior.fingerprint.dataHash || object.version !== prior.fingerprint.operationVersion)
      fail("preliminary_master_refresh_manual_change_detected");
    if (destination.type === "member") {
      const member = existing as { sourceSystem: string | null; sourceId: string | null; legacyCustomerId: string | null };
      if (member.sourceSystem !== APPSHEET_CANONICAL_SOURCE_SYSTEM || member.legacyCustomerId !== destination.sourceKey)
        fail("preliminary_master_refresh_lineage_mismatch");
    } else {
      const sku = existing as { sourceSystem: string | null; sourceId: string | null };
      if (sku.sourceSystem !== APPSHEET_CANONICAL_SOURCE_SYSTEM) fail("preliminary_master_refresh_lineage_mismatch");
    }
    if (existing && (existing as { sourceId: string | null }).sourceId !== expectedSourceId) fail("preliminary_master_refresh_lineage_mismatch");
    plans.push({ mode: "refresh", destination, beforeHash, afterHash, operationVersion: object.version,
      nextOperationVersion: object.version + 1, previousSnapshotId: prior.snapshotId,
      previousOperationVersion: prior.fingerprint.operationVersion,
      existingCatalogueCode: destination.type === "sku" ? (existing as { code: string }).code : null,
      existingTarget: existing });
  }
  return plans;
}

async function persistProjection(
  tx: PrismaNamespace.TransactionClient,
  projection: AppSheetCanonicalProjection,
  actorId: string,
  reviewInput: unknown,
  allowStagedDelta: boolean,
  refreshPreliminary: boolean,
  commitSha: string,
  context: StageContext,
): Promise<{ snapshotId: string; captureId: string; status: "staged"; replay: boolean; counts: AppSheetCanonicalProjection["summary"] }> {
  if (projection.capture.stabilityMode === "staged-delta" && !allowStagedDelta) fail("staged_delta_requires_explicit_flag");
  if (context.target === "production" && projection.capture.stabilityMode !== "stable") fail("production_requires_stable_capture");
  if (context.target === "production") assertProductionDefinitionReady(projection);
  const actor = await assertActorCanStage(tx, actorId);
  if (!/^[a-f0-9]{40}$/.test(commitSha)) fail("commit_sha_invalid");
  if (context.target === "production" && (!context.backupEvidence || !HASH.test(context.backupEvidence.manifestHash) ||
      !Number.isFinite(Date.parse(context.backupEvidence.snapshotAt)))) fail("verified_backup_required");
  if (!/^appsheet-db-v1:[a-f0-9]{64}$/.test(context.destinationIdentity)) fail("database_destination_identity_invalid");
  const review = prepareReview(projection, actor.id, reviewInput, commitSha, context);
  const snapshotId = snapshotIdFor(projection);
  if (snapshotId !== projection.snapshotId) fail("snapshot_id_invalid");

  const masterPlan = await prepareMasterStagePlan(tx, projection, refreshPreliminary);
  const destinationFingerprints: DestinationFingerprint[] = masterPlan.map((plan) => ({
    destinationType: plan.destination.type,
    sourceTable: plan.destination.sourceTable,
    sourceKey: plan.destination.sourceKey,
    destinationId: plan.destination.id,
    dataHash: plan.afterHash,
    operationVersion: plan.nextOperationVersion,
  }));
  const controls = snapshotControls(projection, review, context, destinationFingerprints);
  const coverage = snapshotCoverage(projection);
  const replay = await validateExistingSnapshot(tx, projection, actor.id, controls, coverage);
  if (replay) return { snapshotId, captureId: projection.capture.captureId, status: "staged", replay: true, counts: projection.summary };

  // Canonical source staging may create operational masters and identities. Only
  // a pristine shadow authority may stage new data; suspension does not erase the
  // evidence that this authority was active. Exact validated replays returned above.
  const authority = await tx.operationAuthority.findUnique({ where: { id: "operations" },
    select: { mode: true, epoch: true, approvedBy: true, firstRealWriteAt: true } });
  if (authority && (authority.mode !== "shadow" || authority.epoch !== 1 || authority.approvedBy !== null || authority.firstRealWriteAt !== null))
    fail("canonical_master_stage_requires_shadow_authority");

  const captureId = projection.capture.stabilityMode === "stable"
    ? await ensureAppSheetCaptureManifest(tx, stableCaptureForDatabase(projection.capture))
    : projection.capture.captureId;

  await tx.legacyImportSnapshot.create({ data: {
    id: snapshotId,
    sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
    filename: "appsheet-live-capture",
    fileHash: projection.capture.manifestHash,
    importerVersion: projection.importerVersion,
    status: "staged",
    createdBy: actor.id,
    reviewedBy: null,
    reviewedAt: null,
    captureManifestId: projection.capture.stabilityMode === "stable" ? captureId : null,
    controls: asInputJson(controls),
    coverage: asInputJson(coverage),
  } });

  const sourceRecords = projection.records.map((record) => ({ ...recordToPersisted(record), snapshotId }));
  for (let start = 0; start < sourceRecords.length; start += 500)
    await tx.legacySourceRecord.createMany({ data: sourceRecords.slice(start, start + 500) });
  for (let start = 0; start < projection.exceptions.length; start += 500)
    await tx.legacyException.createMany({ data: projection.exceptions.slice(start, start + 500).map((exception) => ({
      ...exception,
      resolution: Prisma.DbNull,
      snapshotId,
    })) });

  const memberData = masterPlan.filter((plan): plan is MasterStagePlan & { destination: Extract<Destination, { type: "member" }> } =>
    plan.mode === "create" && plan.destination.type === "member").map((plan) => plan.destination);
  const skuData = masterPlan.filter((plan): plan is MasterStagePlan & { destination: Extract<Destination, { type: "sku" }> } =>
    plan.mode === "create" && plan.destination.type === "sku").map((plan) => plan.destination);
  for (let start = 0; start < memberData.length; start += 500)
    await tx.operationMember.createMany({ data: memberData.slice(start, start + 500).map(({ id, data }) => ({ id, ...data })) });
  for (let start = 0; start < skuData.length; start += 500)
    await tx.catalogSku.createMany({ data: skuData.slice(start, start + 500).map(({ id, data }) => ({ id, ...data })) });

  const identities = masterPlan.filter((plan) => plan.mode === "create").map(({ destination }) => ({
    id: identityId(destination.sourceTable, destination.sourceKey, destination.type),
    sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
    sourceTable: destination.sourceTable,
    sourceKey: destination.sourceKey,
    destinationType: destination.type,
    destinationId: destination.id,
    approvedBy: null,
  }));
  for (let start = 0; start < identities.length; start += 500)
    await tx.legacyIdentity.createMany({ data: identities.slice(start, start + 500) });

  const operationObjects = [
    { id: snapshotId, kind: "legacyImport", version: 0, createdBy: actor.id },
    ...masterPlan.filter((plan) => plan.mode === "create").map(({ destination }) => ({ id: destination.id, kind: destination.type, version: 0, createdBy: actor.id })),
  ];
  for (let start = 0; start < operationObjects.length; start += 500)
    await tx.operationObject.createMany({ data: operationObjects.slice(start, start + 500) });

  const refreshAudits: Array<{ actorId: string; action: string; objectId: string; details: Prisma.InputJsonValue }> = [];
  for (const plan of masterPlan.filter((candidate) => candidate.mode === "refresh")) {
    const { destination } = plan;
    const objectUpdate = await tx.operationObject.updateMany({
      where: { id: destination.id, kind: destination.type, version: plan.operationVersion },
      data: { version: { increment: 1 } },
    });
    if (objectUpdate.count !== 1) fail("preliminary_master_refresh_version_conflict");
    let targetUpdate: { count: number };
    if (destination.type === "member") {
      const existing = plan.existingTarget as { name: string; email: string; phone: string };
      targetUpdate = await tx.operationMember.updateMany({
        where: {
          id: destination.id,
          legacyCustomerId: destination.sourceKey,
          sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
          sourceId: destination.sourceKey,
          name: existing.name,
          email: existing.email,
          phone: existing.phone,
        },
        data: {
          name: destination.data.name,
          email: destination.data.email,
          phone: destination.data.phone,
          address: destination.data.address,
          preferences: destination.data.preferences,
        },
      });
    } else {
      const existing = plan.existingTarget as { name: string; variety: string; category: string; unit: string };
      targetUpdate = await tx.catalogSku.updateMany({
        where: {
          id: destination.id,
          code: plan.existingCatalogueCode!,
          sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
          sourceId: destination.sourceKey,
          active: false,
          name: existing.name,
          variety: existing.variety,
          category: existing.category,
          unit: existing.unit,
        },
        data: {
          code: destination.data.code,
          name: destination.data.name,
          variety: destination.data.variety,
          category: destination.data.category,
          unit: destination.data.unit,
          appSheet: asInputJson(destination.data.appSheet),
        },
      });
    }
    if (targetUpdate.count !== 1) fail("preliminary_master_refresh_manual_change_detected");
    refreshAudits.push({
      actorId: actor.id,
      action: "appsheet.canonical_master_refreshed",
      objectId: destination.id,
      details: asInputJson({
        sourceSystem: APPSHEET_CANONICAL_SOURCE_SYSTEM,
        sourceTable: destination.sourceTable,
        sourceKey: destination.sourceKey,
        destinationType: destination.type,
        previousSnapshotId: plan.previousSnapshotId,
        nextSnapshotId: snapshotId,
        beforeHash: plan.beforeHash,
        afterHash: plan.afterHash,
        expectedOperationVersion: plan.operationVersion,
        resultingOperationVersion: plan.nextOperationVersion,
      }),
    });
  }
  for (let start = 0; start < refreshAudits.length; start += 500)
    await tx.operationAudit.createMany({ data: refreshAudits.slice(start, start + 500) });

  await tx.operationAudit.create({ data: {
    actorId: actor.id,
    action: "appsheet.canonical_masters_staged",
    objectId: snapshotId,
    details: asInputJson({
      captureId, manifestHash: projection.capture.manifestHash, projectionHash: projection.projectionHash,
      importerVersion: projection.importerVersion, reviewer: review.reviewer, reviewedAt: review.reviewedAt,
      commitSha,
      target: context.target,
      backupManifestHash: context.backupEvidence?.manifestHash ?? null,
      backupSnapshotAt: context.backupEvidence?.snapshotAt ?? null,
      destinationIdentity: context.destinationIdentity,
      recordCount: projection.summary.recordCount, destinationCount: projection.destinations.length,
      exceptionCount: projection.summary.exceptionCount,
    }),
  } });
  return { snapshotId, captureId, status: "staged", replay: false, counts: projection.summary };
}

/** Apply one exact master projection atomically; no operational side-effect tables are written. */
export async function stageAppSheetCanonicalMasters(
  projection: AppSheetCanonicalProjection,
  options: {
    actorId: string;
    technicalReview: unknown;
    allowStagedDelta?: boolean;
    refreshPreliminary?: boolean;
    commitSha: string;
    target: "isolated-test" | "production";
    destinationIdentity: string;
    backupEvidence?: BackupEvidence;
  },
  client?: PrismaClient,
): Promise<{ snapshotId: string; captureId: string; status: "staged"; replay: boolean; counts: AppSheetCanonicalProjection["summary"] }> {
  if (projection.capture.stabilityMode === "staged-delta" && options.allowStagedDelta !== true)
    fail("staged_delta_requires_explicit_flag");
  if (options.target === "production") assertProductionDefinitionReady(projection);
  const db = client ?? (await import("../db.js")).db;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(
        (tx) => persistProjection(tx, projection, options.actorId, options.technicalReview, options.allowStagedDelta === true,
          options.refreshPreliminary === true, options.commitSha, {
            target: options.target, destinationIdentity: options.destinationIdentity, backupEvidence: options.backupEvidence,
          }),
        { isolationLevel: "Serializable", timeout: 120_000, maxWait: 15_000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2034", "P2002"].includes(error.code) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
        continue;
      }
      if (error instanceof AppSheetCanonicalError) throw error;
      throw error;
    }
  }
}

export function appSheetCanonicalProjectionReport(projection: AppSheetCanonicalProjection) {
  const definitionReadiness = appSheetDefinitionProductionReadiness(projection.definitionInventory, projection.expectedAppId);
  return {
    status: "preview",
    sourceSystem: projection.capture.sourceSystem,
    captureId: projection.capture.captureId,
    manifestHash: projection.capture.manifestHash,
    dataHash: projection.capture.dataHash,
    captureDefinitionHash: projection.capture.definitionHash,
    appliedDefinitionHash: projection.appliedDefinitionHash,
    definitionParserVersion: definitionReadiness.parserVersion,
    definitionReadinessState: definitionReadiness.state,
    definitionSourceSha256: projection.definitionInventory.source.sha256,
    definitionDescriptorSha256: projection.definitionInventory.descriptorSha256,
    projectionKind: projection.projectionKind,
    importerVersion: projection.importerVersion,
    projectionHash: projection.projectionHash,
    snapshotId: projection.snapshotId,
    tables: projection.tableCoverage,
    summary: projection.summary,
    exceptionKinds: [...new Set(projection.exceptions.map((entry) => entry.kind))].sort(),
  };
}
