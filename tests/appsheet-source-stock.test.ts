import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { APPSHEET_HISTORY_IMPORTER_VERSION, APPSHEET_HISTORY_MAPPING_ID } from "../shared/operations/appsheet-history.js";
import { canonicalJson } from "../shared/operations/exact.js";
import {
  APPSHEET_SOURCE_STOCK_FORMULA,
  deriveAppSheetSourceStockDeliveryDate,
  deriveAppSheetSourceStockEvidence,
  type AppSheetSourceStockFact,
  type AppSheetSourceStockInput,
  type AppSheetSourceStockRecord,
} from "../shared/operations/appsheet-source-stock.js";

const rawSha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const hash = (value: unknown) => rawSha(canonicalJson(value));
const appId = "5b49e640-a7c9-40bb-bccf-ddbc9fcc63f0";

function definitionFixture(formula = APPSHEET_SOURCE_STOCK_FORMULA) {
  const field = (label: string, semanticKey: string | null, value: string, evidenceId: string) =>
    ({ label, semanticKey, value, state: "observed" as const, evidenceId });
  const stock = {
    category: "columns" as const, name: "Stock_Actual", evidenceId: "stock-record", children: [],
    fields: [field("Type", "type", "Decimal", "stock-type"), field("Virtual?", "virtual", "Yes", "stock-virtual"),
      field("Read-Only", null, "Yes", "stock-read-only"), field("App formula", "appFormula", formula, "stock-app-formula")],
  };
  const delivery = {
    category: "columns" as const, name: "Fecha_Entrega", evidenceId: "delivery-record", children: [],
    fields: [field("Type", "type", "Date", "delivery-type"), field("Virtual?", "virtual", "No", "delivery-virtual")],
  };
  const inventory = {
    schemaVersion: 1 as const, parserVersion: "bombo-appsheet-definition/1.2.0",
    source: { sha256: rawSha("appdoc-source"), byteLength: 12, encoding: "utf-8" as const },
    app: { id: appId, name: "Bombo legacy", version: "1", deploymentState: "Deployed", generatedAt: "2026-10-09T12:00:00Z" },
    declaredCounts: { columns: 2 }, observedCounts: { columns: 2 }, descriptorSha256: "",
    coverage: [],
    sections: [{ category: "columns" as const, title: "C_Mercaderia", sectionPath: [], evidenceId: "section", records: [{
      category: "columns" as const, name: "Schema Name C_Mercaderia_Schema", evidenceId: "schema", fields: [], children: [stock, delivery],
    }] }],
    evidence: [], redactedFieldCount: 0, warnings: [],
  };
  inventory.descriptorSha256 = hash({ ...inventory, descriptorSha256: "" });
  return { inventory, appliedDefinitionHash: hash({ sourceSha256: inventory.source.sha256, descriptorSha256: inventory.descriptorSha256 }) };
}

const sourceSnapshot = "history-snapshot-test";
const manifestHash = rawSha("manifest-test");
const capture = { captureId: `appsreal-${manifestHash.slice(0, 16)}`, manifestHash, dataHash: rawSha("data-test"), stableAndComplete: true as const };

function record(table: string, key: string, sourceRow: number, columns: Array<{ header: string; value: string | null; exactDecimal?: string }>, original?: AppSheetSourceStockRecord["original"]): AppSheetSourceStockRecord {
  const normalized = { columns: columns.map((column, index) => ({ coordinate: `${String.fromCharCode(65 + index)}${sourceRow}`,
    header: column.header, value: column.value, ...(column.exactDecimal !== undefined ? { exactDecimal: column.exactDecimal } : {}) })) };
  return {
    id: `${table}-${key}`, snapshotId: sourceSnapshot, sourceTable: table, sourceKey: key, sourceRow,
    fileHash: manifestHash, contentHash: rawSha(`${table}:${key}:${sourceRow}`),
    importerVersion: APPSHEET_HISTORY_IMPORTER_VERSION, treatment: "fact_candidate", normalized, original,
  };
}

function fact(source: AppSheetSourceStockRecord, kind: string, quantity: string | null, classification?: string): AppSheetSourceStockFact {
  return {
    id: `fact-${source.id}`, snapshotId: source.snapshotId, sourceRecordId: source.id, sourceTable: source.sourceTable,
    sourceKey: source.sourceKey, sourceRow: source.sourceRow, sourceHash: source.contentHash,
    mappingId: APPSHEET_HISTORY_MAPPING_ID, kind, quantity, quantityState: quantity === null ? "absent" : "known",
    unit: source.sourceTable === "Mov_Stock1" ? "g" : null, unitState: source.sourceTable === "Mov_Stock1" ? "known" : "absent",
    attributes: classification === undefined ? {} : { sourceClassification: {
      field: "Tipo_Registro_Mercaderia", state: "known", value: classification,
    } }, correctionOf: null,
  };
}

function sourceCellDate(serial: number, formats: Record<string, unknown> = { userEnteredFormat: { numberFormat: { type: "DATE" } } }) {
  return {
    coordinate: "E2", header: "Fecha_Entrega", value: {
      kind: "appsheet_cell", formula: null, userEnteredValue: { numberValue: serial }, effectiveValue: { numberValue: serial },
      ...formats, dataValidation: null,
    },
  };
}

function fixture(overrides: Partial<AppSheetSourceStockInput> = {}) {
  const { inventory, appliedDefinitionHash } = definitionFixture();
  const lot = record("C_Mercaderia", "lot-1", 2, [
    { header: "ID_Mercaderia", value: "lot-1" }, { header: "Codigo_Detalle", value: "item-A" },
    { header: "Id_Compra_Lote", value: "lot-1" }, { header: "Fecha_Compra", value: "2026-01-01" },
    { header: "Fecha_Entrega", value: "46023", exactDecimal: "46023" },
  ], { columns: [sourceCellDate(46023)] });
  const movements = [
    record("Mov_Stock1", "move-entry", 4, [
      { header: "ID_Mov_Stock_Total", value: "move-entry" }, { header: "Codigo_Detalle", value: "item-A" },
      { header: "Id_Lote", value: "lot-1" }, { header: "Tipo_Registro_Mercaderia", value: "Entrada" },
      { header: "Cantidad_Gr", value: "100.125", exactDecimal: "100.125" },
    ]),
    record("Mov_Stock1", "move-sale", 5, [
      { header: "ID_Mov_Stock_Total", value: "move-sale" }, { header: "Codigo_Detalle", value: "item-A" },
      { header: "Id_Lote", value: "lot-1" }, { header: "Tipo_Registro_Mercaderia", value: "Venta" },
      { header: "Cantidad_Gr", value: "12.125", exactDecimal: "12.125" },
    ]),
    record("Mov_Stock1", "move-waste", 6, [
      { header: "ID_Mov_Stock_Total", value: "move-waste" }, { header: "Codigo_Detalle", value: "item-A" },
      { header: "Id_Lote", value: "lot-1" }, { header: "Tipo_Registro_Mercaderia", value: "Merma" },
      { header: "Cantidad_Gr", value: "2", exactDecimal: "2" },
    ]),
    record("Mov_Stock1", "other-lot", 7, [
      { header: "ID_Mov_Stock_Total", value: "other-lot" }, { header: "Codigo_Detalle", value: "item-A" },
      { header: "Id_Lote", value: "lot-2" }, { header: "Tipo_Registro_Mercaderia", value: "Entrada" },
      { header: "Cantidad_Gr", value: "500", exactDecimal: "500" },
    ]),
  ];
  const input: AppSheetSourceStockInput = {
    capture, definitionInventory: inventory, appliedDefinitionHash, lot, lotRows: [lot],
    lotFacts: [fact(lot, "purchase", "1")],
    lotCoverage: { sourceRecordCount: 1, factCount: 1, blockingExceptionCount: 0, reviewExceptionCount: 0,
      sourceRecordUnresolvedFormulaCount: 0, changedPageIndexes: [], stable: true },
    movementRows: movements, movementFacts: movements.map((movement) => {
      const classification = movement.normalized.columns.find((column) => column.header === "Tipo_Registro_Mercaderia")!.value!;
      return fact(movement, "stock", movement.normalized.columns.find((column) => column.header === "Cantidad_Gr")!.value, classification);
    }),
    movementCoverage: { sourceRecordCount: movements.length, factCount: movements.length, blockingExceptionCount: 0,
      reviewExceptionCount: 0, sourceRecordUnresolvedFormulaCount: 0, changedPageIndexes: [], stable: true },
  };
  return { input: { ...input, ...overrides }, inventory, appliedDefinitionHash, lot, movements };
}

test("reproduce Stock_Actual exactly from the complete same-capture rowset and signed definition", () => {
  const { input } = fixture();
  const result = deriveAppSheetSourceStockEvidence(input, hash);
  assert.equal(result.status, "derived");
  if (result.status !== "derived") return;
  assert.equal(result.sourceStockActual, "86.000000000000");
  assert.equal(result.sourceDeliveryDate, "2026-01-01");
  assert.equal(result.movementCount, 4);
  assert.equal(result.selectedMovementCount, 3);
  assert.equal(result.definition.expression, APPSHEET_SOURCE_STOCK_FORMULA);
  assert.match(result.definition.bindingHash, /^[a-f0-9]{64}$/);
  assert.match(result.movementRowsetHash, /^[a-f0-9]{64}$/);
  assert.match(result.selectionHash, /^[a-f0-9]{64}$/);
  assert.match(result.derivationHash, /^[a-f0-9]{64}$/);
});

test("blocks a changed formula, missing AppDoc binding, or incomplete current capture", () => {
  const original = fixture();
  const changed = definitionFixture(`${APPSHEET_SOURCE_STOCK_FORMULA}\n `);
  const formulaMismatch = deriveAppSheetSourceStockEvidence({ ...original.input, definitionInventory: changed.inventory,
    appliedDefinitionHash: changed.appliedDefinitionHash }, hash);
  assert.deepEqual(formulaMismatch, { status: "blocked", code: "definition_formula_mismatch" });
  const missing = structuredClone(original.inventory);
  missing.sections[0]!.records[0]!.children = [];
  missing.descriptorSha256 = hash({ ...missing, descriptorSha256: "" });
  const missingAppliedDefinitionHash = hash({ sourceSha256: missing.source.sha256, descriptorSha256: missing.descriptorSha256 });
  const missingBinding = deriveAppSheetSourceStockEvidence({ ...original.input, definitionInventory: missing,
    appliedDefinitionHash: missingAppliedDefinitionHash }, hash);
  assert.deepEqual(missingBinding, { status: "blocked", code: "definition_binding_missing" });
  const unstable = deriveAppSheetSourceStockEvidence({ ...original.input, capture: { ...original.input.capture, stableAndComplete: false } }, hash);
  assert.deepEqual(unstable, { status: "blocked", code: "capture_not_stable" });
});

test("blocks a missing, duplicated, changed-capture or exceptional movement row", () => {
  const { input } = fixture();
  const missingRow = deriveAppSheetSourceStockEvidence({ ...input, movementRows: input.movementRows.slice(1),
    movementFacts: input.movementFacts.slice(1) }, hash);
  assert.deepEqual(missingRow, { status: "blocked", code: "movement_rowset_incomplete" });
  const duplicateRow = deriveAppSheetSourceStockEvidence({ ...input, movementRows: [...input.movementRows, input.movementRows[0]!],
    movementFacts: [...input.movementFacts, input.movementFacts[0]!], movementCoverage: { ...input.movementCoverage, sourceRecordCount: 5, factCount: 5 } }, hash);
  assert.deepEqual(duplicateRow, { status: "blocked", code: "movement_source_ambiguous" });
  const changedCapture = { ...input.movementRows[0]!, fileHash: rawSha("different-manifest") };
  const mixed = deriveAppSheetSourceStockEvidence({ ...input, movementRows: [changedCapture, ...input.movementRows.slice(1)] }, hash);
  assert.deepEqual(mixed, { status: "blocked", code: "movement_rowset_incomplete" });
  const exception = deriveAppSheetSourceStockEvidence({ ...input,
    movementCoverage: { ...input.movementCoverage, reviewExceptionCount: 1 } }, hash);
  assert.deepEqual(exception, { status: "blocked", code: "movement_rowset_incomplete" });
});

test("blocks unknown quantities, facts, classifications and case-ambiguous join references", () => {
  const { input, movements } = fixture();
  const badQuantity = { ...movements[0]!, normalized: { columns: movements[0]!.normalized.columns.map((column) =>
    column.header === "Cantidad_Gr" ? { ...column, exactDecimal: undefined } : column) } };
  const noQuantity = deriveAppSheetSourceStockEvidence({ ...input, movementRows: [badQuantity, ...input.movementRows.slice(1)] }, hash);
  assert.deepEqual(noQuantity, { status: "blocked", code: "movement_source_invalid" });
  const badFact = { ...input.movementFacts[0]!, sourceHash: rawSha("different-source") };
  const hashMismatch = deriveAppSheetSourceStockEvidence({ ...input, movementFacts: [badFact, ...input.movementFacts.slice(1)] }, hash);
  assert.deepEqual(hashMismatch, { status: "blocked", code: "movement_fact_invalid" });
  const malformedFact = { ...input.movementFacts[0]!, quantity: "not-a-decimal" };
  const malformedFactResult = deriveAppSheetSourceStockEvidence({ ...input,
    movementFacts: [malformedFact, ...input.movementFacts.slice(1)] }, hash);
  assert.deepEqual(malformedFactResult, { status: "blocked", code: "movement_fact_invalid" });
  const lowerCase = { ...movements[0]!, normalized: { columns: movements[0]!.normalized.columns.map((column) =>
    column.header === "Tipo_Registro_Mercaderia" ? { ...column, value: "entrada" } : column) } };
  const classification = deriveAppSheetSourceStockEvidence({ ...input, movementRows: [lowerCase, ...input.movementRows.slice(1)] }, hash);
  assert.deepEqual(classification, { status: "blocked", code: "movement_classification_invalid" });
  const ambiguous = { ...movements[0]!, id: "alternate-case-row", sourceKey: "alternate-case-row", sourceRow: 8,
    contentHash: rawSha("alternate-case-row"), normalized: { columns: movements[0]!.normalized.columns.map((column) =>
      column.header === "Codigo_Detalle" ? { ...column, value: "ITEM-A" } : column) } };
  const ambiguousFact = { ...input.movementFacts[0]!, id: "fact-alternate", sourceRecordId: ambiguous.id,
    sourceKey: ambiguous.sourceKey, sourceRow: ambiguous.sourceRow, sourceHash: ambiguous.contentHash };
  const ambiguousJoin = deriveAppSheetSourceStockEvidence({ ...input, movementRows: [...input.movementRows, ambiguous],
    movementFacts: [...input.movementFacts, ambiguousFact], movementCoverage: { ...input.movementCoverage, sourceRecordCount: 5, factCount: 5 } }, hash);
  assert.deepEqual(ambiguousJoin, { status: "blocked", code: "movement_join_case_ambiguous" });
});

test("blocks a lone case-differing movement that may match the lot under AppSheet equality", () => {
  const { input, movements } = fixture();
  const originalCandidate = movements[0]!;
  const candidate = { ...originalCandidate, contentHash: rawSha("case-differing-entry"), normalized: {
    columns: originalCandidate.normalized.columns.map((column) =>
      column.header === "Codigo_Detalle" ? { ...column, value: "ITEM-A" } : column),
  } };
  const candidateFact = { ...input.movementFacts[0]!, sourceHash: candidate.contentHash };
  const unrelated = movements[3]!;
  const unrelatedFact = input.movementFacts.find((movementFact) => movementFact.sourceRecordId === unrelated.id)!;
  const result = deriveAppSheetSourceStockEvidence({ ...input,
    movementRows: [candidate, unrelated], movementFacts: [candidateFact, unrelatedFact],
    movementCoverage: { ...input.movementCoverage, sourceRecordCount: 2, factCount: 2 },
  }, hash);
  assert.deepEqual(result, { status: "blocked", code: "movement_join_case_ambiguous" });
});

test("converts an integer serial only when signed Date semantics and DATE format agree", () => {
  const { inventory, appliedDefinitionHash, lot } = fixture();
  const date = deriveAppSheetSourceStockDeliveryDate({ definitionInventory: inventory, appliedDefinitionHash, lot, hashCanonicalJson: hash });
  assert.equal(date.status, "derived");
  if (date.status !== "derived") return;
  assert.equal(date.value, "2026-01-01");
  assert.match(date.definitionHash, /^[a-f0-9]{64}$/);
  const effectiveFormatOnly = { ...lot, original: { columns: [sourceCellDate(46023, {
    userEnteredFormat: null, effectiveFormat: { numberFormat: { type: "DATE" } },
  })] } };
  const effectiveDate = deriveAppSheetSourceStockDeliveryDate({ definitionInventory: inventory, appliedDefinitionHash,
    lot: effectiveFormatOnly, hashCanonicalJson: hash });
  assert.equal(effectiveDate.status, "derived");
  if (effectiveDate.status === "derived") assert.equal(effectiveDate.value, "2026-01-01");
  const formulaDateCell = sourceCellDate(46023);
  const formulaDate = { ...lot, original: { columns: [{ ...formulaDateCell, value: {
    ...formulaDateCell.value, formula: "=DATE(2026,1,1)", userEnteredValue: { formulaValue: "=DATE(2026,1,1)" },
  } }] } };
  assert.deepEqual(deriveAppSheetSourceStockDeliveryDate({ definitionInventory: inventory, appliedDefinitionHash,
    lot: formulaDate, hashCanonicalJson: hash }), { status: "blocked", code: "delivery_date_invalid" });
  const conflictingLiteralDate = { ...lot, original: { columns: [{ ...formulaDateCell, value: {
    ...formulaDateCell.value, userEnteredValue: { numberValue: 46024 },
  } }] } };
  assert.deepEqual(deriveAppSheetSourceStockDeliveryDate({ definitionInventory: inventory, appliedDefinitionHash,
    lot: conflictingLiteralDate, hashCanonicalJson: hash }), { status: "blocked", code: "delivery_date_invalid" });
  const noFormat = { ...lot, original: { columns: [sourceCellDate(46023, {})] } };
  assert.deepEqual(deriveAppSheetSourceStockDeliveryDate({ definitionInventory: inventory, appliedDefinitionHash, lot: noFormat,
    hashCanonicalJson: hash }), { status: "blocked", code: "delivery_date_invalid" });
  const timeFormat = { ...lot, original: { columns: [sourceCellDate(46023, {
    userEnteredFormat: { numberFormat: { type: "DATE" } }, effectiveFormat: { numberFormat: { type: "DATE_TIME" } },
  })] } };
  assert.deepEqual(deriveAppSheetSourceStockDeliveryDate({ definitionInventory: inventory, appliedDefinitionHash, lot: timeFormat,
    hashCanonicalJson: hash }), { status: "blocked", code: "delivery_date_invalid" });
  const fractional = { ...lot, normalized: { columns: lot.normalized.columns.map((column) =>
    column.header === "Fecha_Entrega" ? { ...column, value: "46023.5", exactDecimal: "46023.5" } : column) },
    original: { columns: [sourceCellDate(46023.5)] } };
  assert.deepEqual(deriveAppSheetSourceStockDeliveryDate({ definitionInventory: inventory, appliedDefinitionHash, lot: fractional,
    hashCanonicalJson: hash }), { status: "blocked", code: "delivery_date_invalid" });
  const numericInventory = definitionFixture().inventory;
  const records = (numericInventory.sections[0]!.records[0]!.children as Array<{ name: string | null; fields: Array<{ label: string; semanticKey: string | null; value: string | null }> }>);
  const delivery = records.find((item) => item.name === "Fecha_Entrega")!;
  delivery.fields[0]!.value = "Number";
  numericInventory.descriptorSha256 = hash({ ...numericInventory, descriptorSha256: "" });
  const numericAppliedHash = hash({ sourceSha256: numericInventory.source.sha256, descriptorSha256: numericInventory.descriptorSha256 });
  assert.deepEqual(deriveAppSheetSourceStockDeliveryDate({ definitionInventory: numericInventory,
    appliedDefinitionHash: numericAppliedHash, lot, hashCanonicalJson: hash }), { status: "blocked", code: "delivery_date_invalid" });
});
