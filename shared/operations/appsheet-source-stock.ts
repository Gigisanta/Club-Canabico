import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_MAPPING_ID } from "./appsheet-history.js";
import {
  appSheetDefinitionInventorySchema,
  type AppSheetDefinitionInventory,
  type AppSheetDefinitionRecord,
} from "./appsheet-definition.js";
import { formatDecimal, parseDecimal } from "./exact.js";

export const APPSHEET_SOURCE_STOCK_APP_ID = "5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0" as const;
export const APPSHEET_SOURCE_STOCK_FORMULA = `=SUM(
  SELECT(
    Mov_Stock1[Cantidad_Gr],
    AND(
      [Codigo_Detalle] = [_THISROW].[Codigo_Detalle],
      [Id_Lote] = [_THISROW].[Id_Compra_Lote],
      [Tipo_Registro_Mercaderia] = "Entrada"
    )
  )
)
-
SUM(
  SELECT(
    Mov_Stock1[Cantidad_Gr],
    AND(
      [Codigo_Detalle] = [_THISROW].[Codigo_Detalle],
      [Id_Lote] = [_THISROW].[Id_Compra_Lote],
      [Tipo_Registro_Mercaderia] = "Venta"
    )
  )
)
-
SUM(
  SELECT(
    Mov_Stock1[Cantidad_Gr],
    AND(
      [Codigo_Detalle] = [_THISROW].[Codigo_Detalle],
      [Id_Lote] = [_THISROW].[Id_Compra_Lote],
      [Tipo_Registro_Mercaderia] = "Merma"
    )
  )
)`;

const HASH = /^[a-f0-9]{64}$/;
const DECIMAL_SCALE = 12;
const SHEETS_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export type AppSheetSourceStockColumn = {
  coordinate: string;
  header: string | null;
  value: string | null;
  exactDecimal?: string;
};

export type AppSheetSourceStockRecord = {
  id: string;
  snapshotId: string;
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  fileHash: string;
  contentHash: string;
  importerVersion: string;
  treatment: string;
  normalized: { columns: AppSheetSourceStockColumn[] };
  original?: { columns: Array<{ coordinate: string; header: string | null; value: unknown }> };
};

export type AppSheetSourceStockFact = {
  id: string;
  snapshotId: string;
  sourceRecordId: string;
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  sourceHash: string;
  mappingId: string;
  kind: string;
  quantity: string | null;
  quantityState: string;
  unit: string | null;
  unitState: string;
  attributes: unknown;
  correctionOf?: string | null;
};

export type AppSheetSourceStockSheetCoverage = {
  sourceRecordCount: number;
  factCount: number;
  blockingExceptionCount: number;
  reviewExceptionCount: number;
  sourceRecordUnresolvedFormulaCount: number;
  changedPageIndexes: number[];
  stable: boolean;
};

export type AppSheetSourceStockInput = {
  capture: {
    captureId: string;
    manifestHash: string;
    dataHash: string;
    stableAndComplete: boolean;
  };
  definitionInventory: unknown;
  appliedDefinitionHash: string;
  lot: AppSheetSourceStockRecord;
  lotRows: readonly AppSheetSourceStockRecord[];
  lotFacts: readonly AppSheetSourceStockFact[];
  lotCoverage: AppSheetSourceStockSheetCoverage;
  movementRows: readonly AppSheetSourceStockRecord[];
  movementFacts: readonly AppSheetSourceStockFact[];
  movementCoverage: AppSheetSourceStockSheetCoverage;
};

export type AppSheetSourceStockMovementBinding = {
  sourceRecordId: string;
  sourceKey: string;
  sourceHash: string;
  factId: string;
  factHash: string;
  classification: "Entrada" | "Venta" | "Merma";
  quantity: string;
};

export type AppSheetSourceStockDefinitionBinding = {
  appId: string;
  table: "C_Mercaderia";
  column: "Stock_Actual";
  type: "Decimal";
  virtual: true;
  readOnly: true;
  expression: string;
  expressionHash: string;
  appliedDefinitionHash: string;
  descriptorSha256: string;
  sourceSha256: string;
  recordEvidenceId: string;
  expressionEvidenceId: string;
  bindingHash: string;
};

export type AppSheetSourceStockProof = {
  status: "derived";
  captureId: string;
  manifestHash: string;
  dataHash: string;
  sourceRecordId: string;
  sourceKey: string;
  sourceContentHash: string;
  sourceRowHash: string;
  sourceDeliveryDate: string;
  definition: AppSheetSourceStockDefinitionBinding;
  movementCount: number;
  selectedMovementCount: number;
  movementRowsetHash: string;
  selectionHash: string;
  movements: AppSheetSourceStockMovementBinding[];
  sourceStockActual: string;
  derivationHash: string;
};

export type AppSheetSourceStockBlocked = { status: "blocked"; code: AppSheetSourceStockBlockCode };
export type AppSheetSourceStockResult = AppSheetSourceStockProof | AppSheetSourceStockBlocked;

export type AppSheetSourceStockBlockCode =
  | "capture_not_stable"
  | "definition_invalid"
  | "definition_binding_missing"
  | "definition_binding_ambiguous"
  | "definition_formula_mismatch"
  | "applied_definition_hash_mismatch"
  | "lot_rowset_incomplete"
  | "lot_source_invalid"
  | "lot_source_ambiguous"
  | "lot_fact_invalid"
  | "movement_rowset_incomplete"
  | "movement_source_invalid"
  | "movement_source_ambiguous"
  | "movement_fact_invalid"
  | "movement_quantity_invalid"
  | "movement_classification_invalid"
  | "movement_join_case_ambiguous"
  | "delivery_date_invalid"
  | "derivation_hash_invalid";

export type AppSheetSourceStockHash = (value: unknown) => string;

type DefinitionColumn = {
  record: AppSheetDefinitionRecord;
  type: string;
  virtual: string;
  readOnly: string | null;
  appFormula: string | null;
  typeEvidenceId: string;
  virtualEvidenceId: string;
  readOnlyEvidenceId: string | null;
  appFormulaEvidenceId: string | null;
};

type ParsedMovement = {
  binding: AppSheetSourceStockMovementBinding;
  code: string;
  lot: string;
  scaledQuantity: bigint;
  sourceRow: number;
};

function blocked(code: AppSheetSourceStockBlockCode): AppSheetSourceStockBlocked {
  return { status: "blocked", code };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function foldedJoinPair(code: string, lot: string): string {
  return `${code.toLocaleLowerCase("en-US")}\u0000${lot.toLocaleLowerCase("en-US")}`;
}

function normalizedColumns(record: AppSheetSourceStockRecord): readonly AppSheetSourceStockColumn[] | null {
  return isObject(record.normalized) && Array.isArray(record.normalized.columns)
    ? record.normalized.columns as AppSheetSourceStockColumn[]
    : null;
}

function uniqueColumn(record: AppSheetSourceStockRecord, header: string): AppSheetSourceStockColumn | null {
  const columns = normalizedColumns(record);
  if (!columns) return null;
  const found = columns.filter((column) => column?.header === header);
  return found.length === 1 ? found[0]! : null;
}

function fieldsFor(record: AppSheetDefinitionRecord, key: string, label?: string) {
  return record.fields.filter((field) => field.semanticKey === key || (label !== undefined && field.label === label));
}

function oneObservedField(record: AppSheetDefinitionRecord, key: string, label?: string): { value: string; evidenceId: string } | null {
  const found = fieldsFor(record, key, label);
  return found.length === 1 && found[0]!.state === "observed" && typeof found[0]!.value === "string"
    ? { value: found[0]!.value, evidenceId: found[0]!.evidenceId }
    : null;
}

function definitionColumns(inventory: AppSheetDefinitionInventory, table: string, column: string): AppSheetDefinitionRecord[] {
  const expectedSchema = `Schema Name ${table}_Schema`;
  const matches: AppSheetDefinitionRecord[] = [];
  const visit = (record: AppSheetDefinitionRecord, parentNames: readonly string[]) => {
    const names = record.name ? [...parentNames, record.name] : parentNames;
    if (record.category === "columns" && record.name === column && names.includes(expectedSchema)) matches.push(record);
    for (const child of record.children) visit(child, names);
  };
  for (const section of inventory.sections) if (section.category === "columns")
    for (const record of section.records) visit(record, []);
  return matches;
}

function bindDefinitionColumn(
  inventoryValue: unknown,
  appliedDefinitionHash: string,
  table: "C_Mercaderia",
  columnName: "Stock_Actual" | "Fecha_Entrega",
  hash: AppSheetSourceStockHash,
): { status: "bound"; inventory: AppSheetDefinitionInventory; binding: DefinitionColumn; appliedDefinitionHash: string } | AppSheetSourceStockBlocked {
  const parsed = appSheetDefinitionInventorySchema.safeParse(inventoryValue);
  if (!parsed.success || parsed.data.app.id !== APPSHEET_SOURCE_STOCK_APP_ID || !HASH.test(appliedDefinitionHash))
    return blocked("definition_invalid");
  const inventory = parsed.data;
  const descriptorHash = hash({ ...inventory, descriptorSha256: "" });
  if (descriptorHash !== inventory.descriptorSha256 ||
      hash({ sourceSha256: inventory.source.sha256, descriptorSha256: inventory.descriptorSha256 }) !== appliedDefinitionHash)
    return blocked("applied_definition_hash_mismatch");
  const found = definitionColumns(inventory, table, columnName);
  if (found.length === 0) return blocked("definition_binding_missing");
  if (found.length !== 1) return blocked("definition_binding_ambiguous");
  const record = found[0]!;
  const type = oneObservedField(record, "type", "Type");
  const virtual = oneObservedField(record, "virtual", "Virtual?");
  const readOnly = oneObservedField(record, "readOnly", "Read-Only");
  const appFormula = oneObservedField(record, "appFormula", "App formula");
  if (!type || !virtual ||
      columnName === "Stock_Actual" && (!readOnly || !appFormula))
    return blocked("definition_binding_missing");
  return {
    status: "bound",
    inventory,
    appliedDefinitionHash,
    binding: {
      record,
      type: type.value,
      virtual: virtual.value,
      readOnly: readOnly?.value ?? null,
      appFormula: appFormula?.value ?? null,
      typeEvidenceId: type.evidenceId,
      virtualEvidenceId: virtual.evidenceId,
      readOnlyEvidenceId: readOnly?.evidenceId ?? null,
      appFormulaEvidenceId: appFormula?.evidenceId ?? null,
    },
  };
}

function assertSheetCoverage(coverage: AppSheetSourceStockSheetCoverage, rows: readonly AppSheetSourceStockRecord[], facts: readonly AppSheetSourceStockFact[]): boolean {
  return coverage.stable === true && coverage.sourceRecordCount === rows.length && coverage.factCount === facts.length &&
    coverage.blockingExceptionCount === 0 && coverage.reviewExceptionCount === 0 &&
    coverage.sourceRecordUnresolvedFormulaCount === 0 && Array.isArray(coverage.changedPageIndexes) && coverage.changedPageIndexes.length === 0;
}

function compareIdentityFields(
  record: AppSheetSourceStockRecord,
  expected: { snapshotId: string; manifestHash: string; importerVersion: string; sourceTable: string },
): boolean {
  return record.snapshotId === expected.snapshotId && record.fileHash === expected.manifestHash &&
    record.importerVersion === expected.importerVersion && record.sourceTable === expected.sourceTable &&
    nonblank(record.id) && nonblank(record.sourceKey) && Number.isSafeInteger(record.sourceRow) && record.sourceRow > 0 &&
    HASH.test(record.contentHash) && record.treatment === "fact_candidate";
}

function uniqueSourceRows(rows: readonly AppSheetSourceStockRecord[]): boolean {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const foldedKeys = new Set<string>();
  const sourceRows = new Set<number>();
  for (const row of rows) {
    const folded = row.sourceKey.toLocaleLowerCase("en-US");
    if (ids.has(row.id) || keys.has(row.sourceKey) || foldedKeys.has(folded) || sourceRows.has(row.sourceRow)) return false;
    ids.add(row.id);
    keys.add(row.sourceKey);
    foldedKeys.add(folded);
    sourceRows.add(row.sourceRow);
  }
  return true;
}

function validateFact(
  fact: AppSheetSourceStockFact,
  record: AppSheetSourceStockRecord,
  expected: { snapshotId: string; sourceTable: string },
): boolean {
  return fact.snapshotId === expected.snapshotId && fact.sourceRecordId === record.id &&
    fact.sourceTable === expected.sourceTable && fact.sourceKey === record.sourceKey && fact.sourceRow === record.sourceRow &&
    fact.sourceHash === record.contentHash && fact.mappingId === APPSHEET_HISTORY_MAPPING_ID && fact.correctionOf == null;
}

function rawCell(record: AppSheetSourceStockRecord, header: string): Record<string, unknown> | null {
  const column = uniqueColumn(record, header);
  if (!column || !Array.isArray(record.original?.columns)) return null;
  const cells = record.original!.columns.filter((item) => item?.coordinate === column.coordinate && item.header === header);
  if (cells.length !== 1 || !isObject(cells[0]!.value)) return null;
  const value = cells[0]!.value;
  return value.kind === "appsheet_cell" ? value : null;
}

function numberFormatType(cell: Record<string, unknown>, formatKey: "effectiveFormat" | "userEnteredFormat"): string | null | "invalid" {
  if (!Object.hasOwn(cell, formatKey)) return null;
  const format = cell[formatKey];
  if (format === null) return null;
  if (!isObject(format)) return "invalid";
  if (!Object.hasOwn(format, "numberFormat") || format.numberFormat === null) return null;
  if (!isObject(format.numberFormat) || typeof format.numberFormat.type !== "string") return "invalid";
  return format.numberFormat.type;
}

/** Convert a Sheets date serial only when the signed AppSheet field and source number format both say Date. */
export function deriveAppSheetSourceStockDeliveryDate(input: {
  definitionInventory: unknown;
  appliedDefinitionHash: string;
  lot: AppSheetSourceStockRecord;
  hashCanonicalJson: AppSheetSourceStockHash;
}): { status: "derived"; value: string; definitionHash: string } | AppSheetSourceStockBlocked {
  const bound = bindDefinitionColumn(input.definitionInventory, input.appliedDefinitionHash, "C_Mercaderia", "Fecha_Entrega", input.hashCanonicalJson);
  if (bound.status !== "bound") return bound;
  if (bound.binding.type !== "Date" || bound.binding.virtual !== "No") return blocked("delivery_date_invalid");
  const normalized = uniqueColumn(input.lot, "Fecha_Entrega");
  const cell = rawCell(input.lot, "Fecha_Entrega");
  const effective = cell && isObject(cell.effectiveValue) ? cell.effectiveValue : null;
  const entered = cell && isObject(cell.userEnteredValue) ? cell.userEnteredValue : null;
  if (!normalized || !cell || cell.formula !== null || !effective || !entered ||
      typeof effective.numberValue !== "number" || entered.numberValue !== effective.numberValue ||
      Object.keys(entered).some((key) => key !== "numberValue") ||
      Object.keys(effective).filter((key) => key === "numberValue" || key === "stringValue" || key === "boolValue" || key === "errorValue").length !== 1 ||
      !Number.isSafeInteger(effective.numberValue) || normalized.value !== String(effective.numberValue) ||
      normalized.exactDecimal !== undefined && normalized.exactDecimal !== String(effective.numberValue))
    return blocked("delivery_date_invalid");
  const effectiveFormat = numberFormatType(cell, "effectiveFormat");
  const userFormat = numberFormatType(cell, "userEnteredFormat");
  if (effectiveFormat === "invalid" || userFormat === "invalid" ||
      effectiveFormat !== null && userFormat !== null && effectiveFormat !== userFormat ||
      effectiveFormat !== "DATE" && userFormat !== "DATE") return blocked("delivery_date_invalid");
  const millis = SHEETS_EPOCH_UTC_MS + effective.numberValue * DAY_MS;
  if (!Number.isSafeInteger(millis)) return blocked("delivery_date_invalid");
  const date = new Date(millis);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999)
    return blocked("delivery_date_invalid");
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const value = `${year}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  const definitionHash = input.hashCanonicalJson({
    appId: bound.inventory.app.id,
    table: "C_Mercaderia",
    column: "Fecha_Entrega",
    type: bound.binding.type,
    virtual: bound.binding.virtual,
    appliedDefinitionHash: bound.appliedDefinitionHash,
    typeEvidenceId: bound.binding.typeEvidenceId,
    virtualEvidenceId: bound.binding.virtualEvidenceId,
  });
  return HASH.test(definitionHash) ? { status: "derived", value, definitionHash } : blocked("derivation_hash_invalid");
}

/** Reproduce the signed Stock_Actual App formula from a complete, same-capture Mov_Stock1 rowset. */
export function deriveAppSheetSourceStockEvidence(input: AppSheetSourceStockInput, hashCanonicalJson: AppSheetSourceStockHash): AppSheetSourceStockResult {
  if (input.capture.stableAndComplete !== true || !/^appsreal-[a-f0-9]{16}$/.test(input.capture.captureId) ||
      !HASH.test(input.capture.manifestHash) || !HASH.test(input.capture.dataHash)) return blocked("capture_not_stable");
  const bound = bindDefinitionColumn(input.definitionInventory, input.appliedDefinitionHash, "C_Mercaderia", "Stock_Actual", hashCanonicalJson);
  if (bound.status !== "bound") return bound;
  const stockDefinition = bound.binding;
  if (stockDefinition.type !== "Decimal" || stockDefinition.virtual !== "Yes" || stockDefinition.readOnly !== "Yes")
    return blocked("definition_binding_missing");
  if (stockDefinition.appFormula !== APPSHEET_SOURCE_STOCK_FORMULA) return blocked("definition_formula_mismatch");
  const definition: AppSheetSourceStockDefinitionBinding = {
    appId: bound.inventory.app.id!, table: "C_Mercaderia", column: "Stock_Actual", type: "Decimal", virtual: true,
    readOnly: true, expression: stockDefinition.appFormula, expressionHash: hashCanonicalJson({
      appId: bound.inventory.app.id, table: "C_Mercaderia", column: "Stock_Actual", expression: stockDefinition.appFormula,
      evidenceId: stockDefinition.appFormulaEvidenceId,
    }), appliedDefinitionHash: bound.appliedDefinitionHash,
    descriptorSha256: bound.inventory.descriptorSha256, sourceSha256: bound.inventory.source.sha256,
    recordEvidenceId: stockDefinition.record.evidenceId, expressionEvidenceId: stockDefinition.appFormulaEvidenceId!,
    bindingHash: "",
  };
  if (!HASH.test(definition.expressionHash)) return blocked("derivation_hash_invalid");
  const { bindingHash: _unboundBindingHash, ...definitionBasis } = definition;
  definition.bindingHash = hashCanonicalJson(definitionBasis);
  if (!HASH.test(definition.bindingHash)) return blocked("derivation_hash_invalid");

  const lot = input.lot;
  const snapshotId = lot.snapshotId;
  const expectedLot = { snapshotId, manifestHash: input.capture.manifestHash, importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, sourceTable: "C_Mercaderia" };
  const expectedMovement = { ...expectedLot, sourceTable: "Mov_Stock1" };
  if (!compareIdentityFields(lot, expectedLot) || !input.lotRows.some((row) => row.id === lot.id && row.contentHash === lot.contentHash) ||
      !assertSheetCoverage(input.lotCoverage, input.lotRows, input.lotFacts)) return blocked("lot_rowset_incomplete");
  if (!uniqueSourceRows(input.lotRows)) return blocked("lot_source_ambiguous");
  if (input.lotRows.some((row) => !compareIdentityFields(row, expectedLot))) return blocked("lot_rowset_incomplete");
  const lotMatches = input.lotRows.filter((row) => row.sourceKey === lot.sourceKey && row.id === lot.id);
  if (lotMatches.length !== 1) return blocked("lot_source_ambiguous");
  const lotFactMatches = input.lotFacts.filter((fact) => fact.sourceRecordId === lot.id);
  if (input.lotFacts.length !== input.lotRows.length || lotFactMatches.length !== 1 ||
      !validateFact(lotFactMatches[0]!, lot, { snapshotId, sourceTable: "C_Mercaderia" }) ||
      lotFactMatches[0]!.kind !== "purchase") return blocked("lot_fact_invalid");
  const lotCode = uniqueColumn(lot, "Codigo_Detalle");
  const lotId = uniqueColumn(lot, "Id_Compra_Lote");
  const sourceLotId = uniqueColumn(lot, "ID_Mercaderia");
  if (!lotCode || !nonblank(lotCode.value) || !lotId || !nonblank(lotId.value) ||
      !sourceLotId || sourceLotId.value !== lot.sourceKey) return blocked("lot_source_invalid");
  const date = deriveAppSheetSourceStockDeliveryDate({
    definitionInventory: bound.inventory, appliedDefinitionHash: bound.appliedDefinitionHash, lot, hashCanonicalJson,
  });
  if (date.status === "blocked") return date;

  if (!assertSheetCoverage(input.movementCoverage, input.movementRows, input.movementFacts)) return blocked("movement_rowset_incomplete");
  if (!uniqueSourceRows(input.movementRows)) return blocked("movement_source_ambiguous");
  if (input.movementRows.some((row) => !compareIdentityFields(row, expectedMovement))) return blocked("movement_rowset_incomplete");
  const factsBySource = new Map<string, AppSheetSourceStockFact[]>();
  for (const fact of input.movementFacts) {
    const rows = factsBySource.get(fact.sourceRecordId) ?? [];
    rows.push(fact);
    factsBySource.set(fact.sourceRecordId, rows);
  }
  if (input.movementRows.length !== input.movementFacts.length) return blocked("movement_fact_invalid");

  const parsedMovements: ParsedMovement[] = [];
  const foldedPairs = new Map<string, string>();
  for (const row of input.movementRows) {
    const code = uniqueColumn(row, "Codigo_Detalle");
    const lotRef = uniqueColumn(row, "Id_Lote");
    const classification = uniqueColumn(row, "Tipo_Registro_Mercaderia");
    const quantity = uniqueColumn(row, "Cantidad_Gr");
    if (!code || !nonblank(code.value) || !lotRef || !nonblank(lotRef.value) ||
        !classification || !nonblank(classification.value) || !quantity || quantity.value === null ||
        typeof quantity.exactDecimal !== "string") return blocked("movement_source_invalid");
    if (classification.value !== "Entrada" && classification.value !== "Venta" && classification.value !== "Merma")
      return blocked("movement_classification_invalid");
    let scaledQuantity: bigint;
    try {
      scaledQuantity = parseDecimal(quantity.exactDecimal, DECIMAL_SCALE);
      if (parseDecimal(quantity.value, DECIMAL_SCALE) !== scaledQuantity) return blocked("movement_quantity_invalid");
    } catch {
      return blocked("movement_quantity_invalid");
    }
    const factMatches = factsBySource.get(row.id) ?? [];
    const fact = factMatches.length === 1 ? factMatches[0]! : null;
    if (!fact || !validateFact(fact, row, { snapshotId, sourceTable: "Mov_Stock1" }) || fact.kind !== "stock" ||
        fact.quantityState !== "known" || fact.quantity === null || fact.unitState !== "known" || fact.unit !== "g" ||
        !HASH.test(fact.sourceHash))
      return blocked("movement_fact_invalid");
    try {
      if (parseDecimal(fact.quantity, DECIMAL_SCALE) !== scaledQuantity) return blocked("movement_fact_invalid");
    } catch {
      return blocked("movement_fact_invalid");
    }
    const attributes = isObject(fact.attributes) ? fact.attributes : null;
    const sourceClassification = attributes && isObject(attributes.sourceClassification) ? attributes.sourceClassification : null;
    if (!sourceClassification || sourceClassification.field !== "Tipo_Registro_Mercaderia" ||
        sourceClassification.state !== "known" || sourceClassification.value !== classification.value)
      return blocked("movement_fact_invalid");
    const pair = `${code.value}\u0000${lotRef.value}`;
    const folded = foldedJoinPair(code.value, lotRef.value);
    const prior = foldedPairs.get(folded);
    if (prior !== undefined && prior !== pair) return blocked("movement_join_case_ambiguous");
    foldedPairs.set(folded, pair);
    parsedMovements.push({
      binding: {
        sourceRecordId: row.id, sourceKey: row.sourceKey, sourceHash: row.contentHash, factId: fact.id,
        factHash: fact.sourceHash, classification: classification.value, quantity: formatDecimal(scaledQuantity, DECIMAL_SCALE),
      },
      code: code.value,
      lot: lotRef.value,
      scaledQuantity,
      sourceRow: row.sourceRow,
    });
  }
  if (factsBySource.size !== input.movementRows.length || [...factsBySource.values()].some((items) => items.length !== 1))
    return blocked("movement_fact_invalid");

  // Text `=` behavior is not bound by this proof; do not exclude a case-only candidate silently.
  const foldedLotPair = foldedJoinPair(lotCode.value, lotId.value);
  if (parsedMovements.some((row) => foldedJoinPair(row.code, row.lot) === foldedLotPair &&
      (row.code !== lotCode.value || row.lot !== lotId.value)))
    return blocked("movement_join_case_ambiguous");

  const selected = parsedMovements.filter((row) => row.code === lotCode.value && row.lot === lotId.value)
    .sort((a, b) => a.sourceRow - b.sourceRow || (a.binding.sourceKey < b.binding.sourceKey ? -1 : a.binding.sourceKey > b.binding.sourceKey ? 1 : 0));
  const entrada = selected.filter((row) => row.binding.classification === "Entrada").reduce((sum, row) => sum + row.scaledQuantity, 0n);
  const venta = selected.filter((row) => row.binding.classification === "Venta").reduce((sum, row) => sum + row.scaledQuantity, 0n);
  const merma = selected.filter((row) => row.binding.classification === "Merma").reduce((sum, row) => sum + row.scaledQuantity, 0n);
  const sourceStockActual = formatDecimal(entrada - venta - merma, DECIMAL_SCALE);
  const movements = selected.map((row) => row.binding);
  const movementRowsetHash = hashCanonicalJson({
    schemaVersion: "appsheet-source-stock-rowset/v1", captureId: input.capture.captureId,
    manifestHash: input.capture.manifestHash,
    rows: parsedMovements.slice().sort((a, b) => a.sourceRow - b.sourceRow || (a.binding.sourceKey < b.binding.sourceKey ? -1 : 1))
      .map((row) => ({ sourceRow: row.sourceRow, ...row.binding, code: row.code, lot: row.lot })),
  });
  const sourceRowHash = hashCanonicalJson({
    schemaVersion: "appsheet-source-stock-lot-row/v1", captureId: input.capture.captureId,
    manifestHash: input.capture.manifestHash, sourceRecordId: lot.id, sourceKey: lot.sourceKey,
    sourceRow: lot.sourceRow, sourceContentHash: lot.contentHash,
  });
  const selectionHash = hashCanonicalJson({
    schemaVersion: "appsheet-source-stock-selection/v1", captureId: input.capture.captureId,
    manifestHash: input.capture.manifestHash, sourceRecordId: lot.id, sourceKey: lot.sourceKey,
    sourceContentHash: lot.contentHash, lotCode: lotCode.value, lotId: lotId.value,
    movements,
  });
  const derivationHash = hashCanonicalJson({
    schemaVersion: "appsheet-source-stock-derivation/v1", captureId: input.capture.captureId,
    manifestHash: input.capture.manifestHash, dataHash: input.capture.dataHash, sourceRecordId: lot.id,
    sourceKey: lot.sourceKey, sourceContentHash: lot.contentHash, sourceRowHash, sourceDeliveryDate: date.value,
    appliedDefinitionHash: definition.appliedDefinitionHash, definitionBindingHash: definition.bindingHash,
    formula: definition.expression, formulaHash: definition.expressionHash, movementRowsetHash, selectionHash,
    movementCount: parsedMovements.length, selectedMovementCount: movements.length, sourceStockActual,
  });
  if (![movementRowsetHash, sourceRowHash, selectionHash, derivationHash].every((digest) => HASH.test(digest)))
    return blocked("derivation_hash_invalid");
  return {
    status: "derived", captureId: input.capture.captureId, manifestHash: input.capture.manifestHash,
    dataHash: input.capture.dataHash, sourceRecordId: lot.id, sourceKey: lot.sourceKey,
    sourceContentHash: lot.contentHash, sourceRowHash, sourceDeliveryDate: date.value, definition,
    movementCount: parsedMovements.length, selectedMovementCount: movements.length,
    movementRowsetHash, selectionHash, movements, sourceStockActual, derivationHash,
  };
}
