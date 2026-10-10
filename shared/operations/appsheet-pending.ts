import { z } from "zod";
import { APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS } from "./appsheet-history.js";
import { canonicalJson } from "./exact.js";

export const APPSHEET_PENDING_SCHEMA_VERSION = "appsheet-pending-reconciliation/1.0.0" as const;
export const APPSHEET_PENDING_MAPPING_ID = "appsheet-live-pending-reconciliation-v1" as const;
export const APPSHEET_PENDING_TABLES = [
  "Pre_Venta",
  "Pre_Detalle_Fact",
  "C_Facturacion",
  "C_Detalle_Fact",
  "C_Moto",
  "C_Mercaderia",
  "Movimiento_Nueva",
  "Movimiento",
  "O_Ruta",
] as const;

/**
 * This mapping is deliberately explicit. In particular, invoice and purchase
 * currency are not inferred from the club's usual currency or from a cash row.
 */
export const APPSHEET_PENDING_MAPPING_SPEC = {
  version: APPSHEET_PENDING_MAPPING_ID,
  dimensions: {
    preSale: {
      sourceTable: "Pre_Venta",
      statusField: "Estado_Preventa",
      invoiceReferenceField: "Id_facturado",
      detailRelationship: ["Pre_Detalle_Fact", "Id_Pre_Venta", "Pre_Venta", "Id_Preventa"],
      pendingStatus: "Confirmado",
      closedStatus: "Cancelado",
    },
    receivable: {
      sourceTable: "C_Facturacion",
      dueField: "Total_Facturado",
      currencyField: "Tipo_Moneda",
      invoiceNumberField: "N_factura",
      detailsRelationship: ["C_Detalle_Fact", "Id_Factura", "C_Facturacion", "Id_Factura"],
      motoRelationship: ["C_Moto", "N_Factura", "C_Facturacion", "N_factura"],
      movementTables: ["Movimiento_Nueva", "Movimiento"],
      movementCategoryField: "Tabla_Origen",
      movementOriginField: "Origen_ID",
      movementInvoiceNumberField: "ID_Origen_2",
      movementCategoryValues: ["venta", "c_moto"],
      motoMovementCategory: "c_moto",
      moneyAmountField: "Monto",
      moneyCurrencyField: "Tipo_Moneda",
      moneyDirectionField: "Tipo_Movimiento",
      incomingValue: "ingreso",
      decimalScale: 2,
    },
    unpaidPurchase: {
      sourceTable: "C_Mercaderia",
      receivedTypeField: "Tipo_Registro_Mercaderia",
      receivedTypeValue: "Entrada",
      paidAmountField: "Precio_Total_Abonado",
      movementCategory: "c_mercaderia",
      movementOriginField: "Origen_ID",
      movementAmountField: "Monto",
      movementCurrencyField: "Tipo_Moneda",
      dueAmountField: null,
      currencyField: null,
    },
    delivery: {
      sourceTable: "C_Moto",
      invoiceReferenceField: "N_Factura",
      routeReferenceField: "Moto_Ruta_ID",
      routeTable: "O_Ruta",
      routeKeyField: "Ruta_ID",
      routeActiveField: "Ruta_Activa",
      completionField: "Entrega_completada",
    },
  },
  relationships: [
    ["Pre_Venta", "Id_Preventa", "Pre_Detalle_Fact", "Id_Pre_Venta", "one-to-many"],
    ["Pre_Venta", "Id_facturado", "C_Facturacion", "Id_Factura", "optional-reference"],
    ["Pre_Detalle_Fact", "Id_Pre_Venta", "Pre_Venta", "Id_Preventa", "many-to-one"],
    ["C_Facturacion", "Id_Factura", "C_Detalle_Fact", "Id_Factura", "one-to-many"],
    ["C_Facturacion", "N_factura", "C_Moto", "N_Factura", "one-to-many"],
    ["C_Moto", "N_Factura", "C_Facturacion", "N_factura", "many-to-one"],
    ["C_Moto", "Moto_Ruta_ID", "O_Ruta", "Ruta_ID", "optional-reference"],
    ["C_Moto", "Id_Moto", "Movimiento_Nueva", "Origen_ID", "category=c_moto"],
    ["C_Mercaderia", "ID_Mercaderia", "Movimiento_Nueva", "Origen_ID", "category=c_mercaderia"],
    ["C_Facturacion", "Id_Factura", "Movimiento_Nueva", "Origen_ID", "category=venta"],
    ["C_Facturacion", "N_factura", "Movimiento_Nueva", "ID_Origen_2", "category=venta"],
  ],
  policy: {
    noCurrencyDefaults: true,
    noHistoricalSideEffects: true,
    movementTablesNeverSummedTogether: true,
    pendingClassificationIsNotApproval: true,
    preliminaryCaptureNeverCertified: true,
    maximumSerializedRelationshipTargets: 1_000,
  },
} as const;

const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const relationshipStatusSchema = z.enum(["unique", "multiple", "missing", "ambiguous", "unresolved", "not_applicable"]);
const dimensionStatusSchema = z.enum(["confirmed_pending", "not_pending", "needs_review", "not_applicable"]);

export const appSheetPendingSourceReferenceSchema = z.strictObject({
  sourceTable: z.string().min(1).max(120),
  sourceRow: z.number().int().positive().max(100_000),
  sourceKeyHash: HASH,
  sourceEvidenceHash: HASH,
});

export const appSheetPendingRelationshipSchema = z.strictObject({
  sourceField: z.string().min(1).max(120),
  targetTable: z.string().min(1).max(120),
  targetField: z.string().min(1).max(120),
  status: relationshipStatusSchema,
  matchCount: z.number().int().nonnegative().max(100_000).nullable(),
  valueHash: HASH.nullable(),
  matchesHash: HASH.nullable(),
  target: appSheetPendingSourceReferenceSchema.optional(),
  targets: z.array(appSheetPendingSourceReferenceSchema).max(1_000).optional(),
});

export const appSheetPendingSettlementSchema = z.strictObject({
  currency: z.string().min(1).max(12),
  dueMinorUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  paidMinorUnits: z.string().regex(/^(0|[1-9][0-9]*)$/),
  remainingMinorUnits: z.string().regex(/^-?(0|[1-9][0-9]*)$/),
  paymentRowsHash: HASH,
});

export const appSheetPendingDimensionSchema = z.strictObject({
  status: dimensionStatusSchema,
  reasonCodes: z.array(z.string().min(1).max(120)).max(80),
  evidenceFields: z.array(z.string().min(1).max(120)).max(80),
  relationships: z.array(appSheetPendingRelationshipSchema).max(80),
  settlement: appSheetPendingSettlementSchema.optional(),
});

export const appSheetPendingReconciliationSchema = z.strictObject({
  schemaVersion: z.literal(APPSHEET_PENDING_SCHEMA_VERSION),
  mappingId: z.literal(APPSHEET_PENDING_MAPPING_ID),
  mappingHash: HASH,
  source: appSheetPendingSourceReferenceSchema,
  capture: z.strictObject({
    captureId: z.string().min(1).max(128),
    manifestHash: HASH,
    mode: z.enum(["stable", "preliminary-delta"]),
    provisional: z.boolean(),
  }),
  dimensions: z.strictObject({
    preSale: appSheetPendingDimensionSchema,
    receivable: appSheetPendingDimensionSchema,
    unpaidPurchase: appSheetPendingDimensionSchema,
    delivery: appSheetPendingDimensionSchema,
  }),
});

export type AppSheetPendingReconciliation = z.infer<typeof appSheetPendingReconciliationSchema>;
export type AppSheetPendingDimension = z.infer<typeof appSheetPendingDimensionSchema>;
export type AppSheetPendingRelationship = z.infer<typeof appSheetPendingRelationshipSchema>;
export type AppSheetPendingSourceReference = z.infer<typeof appSheetPendingSourceReferenceSchema>;
export type AppSheetPendingStatus = z.infer<typeof dimensionStatusSchema>;

/** Internal-only row material. It is consumed while projecting and never returned. */
export interface AppSheetPendingSourceRecord {
  sourceTable: string;
  sourceRow: number;
  sourceKey: string;
  sourceEvidenceHash: string;
  values: Record<string, string | null>;
  duplicateFields?: readonly string[];
  unresolvedFields?: readonly string[];
}

export interface AppSheetPendingCaptureContext {
  captureId: string;
  manifestHash: string;
  mode: "stable" | "preliminary-delta";
  mappingHash: string;
}

export type AppSheetPendingHash = (value: string) => string;

type MatchResult = {
  status: z.infer<typeof relationshipStatusSchema>;
  value: string | null;
  matches: readonly AppSheetPendingSourceRecord[];
  matchSet?: IndexedMatchSet;
  matchCount: number | null;
  sourceTable: string;
  sourceField: string;
  targetTable: string;
  targetField: string;
};

type IndexedMatchSet = {
  records: AppSheetPendingSourceRecord[];
  referencesHash?: string;
};

type RelationshipValueBucket = {
  all: IndexedMatchSet;
  targetFieldIssueCount: number;
  categoryUnknownCount: number;
  byCategory: Map<string, IndexedMatchSet>;
};

type RelationshipFieldIndex = {
  unresolvedRowCount: number;
  categoryField?: string;
  byValue: Map<string, RelationshipValueBucket>;
};

type RelationshipIndex = {
  fields: Map<string, RelationshipFieldIndex>;
  movementRelationshipsUnresolved: boolean;
};

type MovementCandidateIntegrity = {
  duplicateUniqueIds: Set<string>;
  duplicateLegacyIds: Set<string>;
  duplicateComposites: Set<string>;
  unresolvedUniqueIdRows: number;
  unresolvedLegacyIdRows: number;
};

const EMPTY_DIMENSION = (): AppSheetPendingDimension => ({
  status: "not_applicable",
  reasonCodes: [],
  evidenceFields: [],
  relationships: [],
});

const token = (value: string | null | undefined) => (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("en-US");
const present = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== "";
const hasIssue = (record: AppSheetPendingSourceRecord, field: string) => record.duplicateFields?.includes(field) === true || record.unresolvedFields?.includes(field) === true;
const fieldExists = (record: AppSheetPendingSourceRecord, field: string) => Object.prototype.hasOwnProperty.call(record.values, field);
const validHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const relationshipIndexKey = (table: string, field: string) => `${table}\0${field}`;

/**
 * Index each mapped target once. The global unresolved count deliberately keeps
 * the old fail-closed rule for direct/one-to-many references; category lookups
 * retain their per-value ambiguity checks without rescanning the full table.
 */
function buildRelationshipIndex(rows: readonly AppSheetPendingSourceRecord[]): RelationshipIndex {
  const targetSpecs = new Map<string, { table: string; field: string; categoryField?: string }>();
  for (const relationship of APPSHEET_PENDING_MAPPING_SPEC.relationships) {
    const [, , targetTable, targetField, relationshipKind] = relationship;
    const categoryField = relationshipKind.startsWith("category=") ? APPSHEET_PENDING_MAPPING_SPEC.dimensions.receivable.movementCategoryField : undefined;
    targetSpecs.set(relationshipIndexKey(targetTable, targetField), {
      table: targetTable,
      field: targetField,
      ...(categoryField ? { categoryField } : {}),
    });
  }
  for (const table of APPSHEET_PENDING_MAPPING_SPEC.dimensions.receivable.movementTables) {
    for (const field of [
      APPSHEET_PENDING_MAPPING_SPEC.dimensions.receivable.movementOriginField,
      APPSHEET_PENDING_MAPPING_SPEC.dimensions.receivable.movementInvoiceNumberField,
    ]) {
      targetSpecs.set(relationshipIndexKey(table, field), {
        table,
        field,
        categoryField: APPSHEET_PENDING_MAPPING_SPEC.dimensions.receivable.movementCategoryField,
      });
    }
  }

  const rowsByTable = new Map<string, AppSheetPendingSourceRecord[]>();
  for (const row of rows) {
    const group = rowsByTable.get(row.sourceTable) ?? [];
    group.push(row);
    rowsByTable.set(row.sourceTable, group);
  }

  const fields = new Map<string, RelationshipFieldIndex>();
  for (const [key, spec] of targetSpecs) {
    let unresolvedRowCount = 0;
    const byValue = new Map<string, RelationshipValueBucket>();
    for (const record of rowsByTable.get(spec.table) ?? []) {
      const targetFieldIssue = !fieldExists(record, spec.field) || hasIssue(record, spec.field);
      if (targetFieldIssue) unresolvedRowCount++;
      const value = record.values[spec.field] ?? null;
      if (!present(value)) continue;

      let bucket = byValue.get(value);
      if (!bucket) {
        bucket = { all: { records: [] }, targetFieldIssueCount: 0, categoryUnknownCount: 0, byCategory: new Map() };
        byValue.set(value, bucket);
      }
      bucket.all.records.push(record);
      if (targetFieldIssue) bucket.targetFieldIssueCount++;

      if (!spec.categoryField) continue;
      if (!fieldExists(record, spec.categoryField) || hasIssue(record, spec.categoryField)) {
        bucket.categoryUnknownCount++;
        continue;
      }
      const category = token(record.values[spec.categoryField]);
      const categoryGroup = bucket.byCategory.get(category) ?? { records: [] };
      categoryGroup.records.push(record);
      bucket.byCategory.set(category, categoryGroup);
    }
    fields.set(key, { unresolvedRowCount, byValue, ...(spec.categoryField ? { categoryField: spec.categoryField } : {}) });
  }

  const movementRelationshipsUnresolved = rows.some(record =>
    (record.sourceTable === "Movimiento_Nueva" || record.sourceTable === "Movimiento") &&
    hasUnresolvedAny(record, ["Tabla_Origen", "Origen_ID", "ID_Origen_2"]));
  return { fields, movementRelationshipsUnresolved };
}

function indexedField(index: RelationshipIndex, targetTable: string, targetField: string): RelationshipFieldIndex {
  const result = index.fields.get(relationshipIndexKey(targetTable, targetField));
  if (!result) throw new TypeError("pending_relationship_index_missing");
  return result;
}

function hashCanonical(hash: AppSheetPendingHash, value: unknown): string {
  const result = hash(canonicalJson(value));
  if (!validHash(result)) throw new TypeError("pending_hash_must_be_sha256");
  return result;
}

function reference(record: AppSheetPendingSourceRecord, hash: AppSheetPendingHash): AppSheetPendingSourceReference {
  if (!validHash(record.sourceEvidenceHash)) throw new TypeError("pending_source_evidence_hash_invalid");
  return {
    sourceTable: record.sourceTable,
    sourceRow: record.sourceRow,
    sourceKeyHash: hashCanonical(hash, ["appsheet-pending-key-v1", record.sourceTable, record.sourceKey]),
    sourceEvidenceHash: record.sourceEvidenceHash,
  };
}

function directMatch(
  source: AppSheetPendingSourceRecord,
  sourceField: string,
  targetTable: string,
  targetField: string,
  index: RelationshipIndex,
): MatchResult {
  const value = source.values[sourceField] ?? null;
  const base = { sourceTable: source.sourceTable, sourceField, targetTable, targetField, value };
  if (!fieldExists(source, sourceField) || hasIssue(source, sourceField))
    return { ...base, status: "unresolved", matches: [], matchCount: null };
  if (!present(value)) return { ...base, status: "missing", matches: [], matchCount: 0 };
  const targetIndex = indexedField(index, targetTable, targetField);
  if (targetIndex.unresolvedRowCount > 0)
    return { ...base, status: "unresolved", matches: [], matchCount: null };
  const matchSet = targetIndex.byValue.get(value)?.all;
  const matches = matchSet?.records ?? [];
  const status = matches.length > 1_000 ? "unresolved" : matches.length === 0 ? "missing" : matches.length === 1 ? "unique" : "ambiguous";
  return { ...base, status, matches, ...(matchSet ? { matchSet } : {}), matchCount: matches.length, value };
}

function reverseMatch(
  source: AppSheetPendingSourceRecord,
  sourceField: string,
  targetTable: string,
  targetField: string,
  index: RelationshipIndex,
): MatchResult {
  const value = source.values[sourceField] ?? null;
  const base = { sourceTable: source.sourceTable, sourceField, targetTable, targetField, value };
  if (!fieldExists(source, sourceField) || hasIssue(source, sourceField))
    return { ...base, status: "unresolved", matches: [], matchCount: null };
  if (!present(value)) return { ...base, status: "missing", matches: [], matchCount: 0 };
  const targetIndex = indexedField(index, targetTable, targetField);
  if (targetIndex.unresolvedRowCount > 0)
    return { ...base, status: "unresolved", matches: [], matchCount: null };
  const matchSet = targetIndex.byValue.get(value)?.all;
  const matches = matchSet?.records ?? [];
  const status = matches.length > 1_000 ? "unresolved" : matches.length === 0 ? "missing" : matches.length === 1 ? "unique" : "multiple";
  return { ...base, status, matches, ...(matchSet ? { matchSet } : {}), matchCount: matches.length, value };
}

function relationshipEvidence(match: MatchResult, hash: AppSheetPendingHash): AppSheetPendingRelationship {
  const refs = match.status === "unique" || match.status === "multiple"
    ? match.matches.map(record => reference(record, hash)).sort((left, right) =>
      left.sourceTable.localeCompare(right.sourceTable) || left.sourceRow - right.sourceRow || left.sourceKeyHash.localeCompare(right.sourceKeyHash))
    : [];
  let matchesHash: string | null = null;
  if (match.matches.length > 0) {
    if (match.matchSet?.referencesHash === undefined) {
      const allRefs = refs.length === match.matches.length ? refs : match.matches.map(record => reference(record, hash)).sort((left, right) =>
        left.sourceTable.localeCompare(right.sourceTable) || left.sourceRow - right.sourceRow || left.sourceKeyHash.localeCompare(right.sourceKeyHash));
      matchesHash = hashCanonical(hash, allRefs);
      if (match.matchSet) match.matchSet.referencesHash = matchesHash;
    } else matchesHash = match.matchSet.referencesHash;
  }
  return {
    sourceField: match.sourceField,
    targetTable: match.targetTable,
    targetField: match.targetField,
    status: match.status,
    matchCount: match.matchCount,
    valueHash: present(match.value) ? hashCanonical(hash, ["appsheet-pending-rel-v1", match.sourceTable, match.sourceField, match.value]) : null,
    matchesHash,
    ...(match.status === "unique" && refs.length === 1 ? { target: refs[0] } : {}),
    ...(match.status === "multiple" ? { targets: refs } : {}),
  };
}

function reverseByRelationshipField(
  source: AppSheetPendingSourceRecord,
  sourceField: string,
  targetTable: string,
  targetField: string,
  index: RelationshipIndex,
  categoryField?: string,
  categoryValue?: string,
): MatchResult {
  const value = source.values[sourceField] ?? null;
  const base = { sourceTable: source.sourceTable, sourceField, targetTable, targetField, value };
  if (!fieldExists(source, sourceField) || hasIssue(source, sourceField))
    return { ...base, status: "unresolved", matches: [], matchCount: null };
  if (!present(value)) return { ...base, status: "missing", matches: [], matchCount: 0 };
  const targetIndex = indexedField(index, targetTable, targetField);
  const bucket = targetIndex.byValue.get(value);
  if (bucket && (bucket.targetFieldIssueCount > 0 || (categoryField && bucket.categoryUnknownCount > 0)))
    return { ...base, status: "unresolved", matches: [], matchCount: null };
  if (categoryField && !targetIndex.categoryField)
    throw new TypeError("pending_relationship_category_index_missing");
  const matchSet = categoryField
    ? bucket?.byCategory.get(token(categoryValue))
    : bucket?.all;
  const matches = matchSet?.records ?? [];
  const status = matches.length > 1_000 ? "unresolved" : matches.length === 0 ? "missing" : matches.length === 1 ? "unique" : "multiple";
  return { ...base, status, matches, ...(matchSet ? { matchSet } : {}), matchCount: matches.length, value };
}

function parseMinorUnits(value: string | null | undefined, scale: number): bigint | null {
  if (!present(value)) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > scale) return null;
  const magnitude = BigInt(match[2]! + fraction.padEnd(scale, "0"));
  return match[1] === "-" ? -magnitude : magnitude;
}

function booleanValue(value: string | null | undefined): boolean | null {
  const normalized = token(value);
  if (["true", "yes", "si", "1", "y"].includes(normalized)) return true;
  if (["false", "no", "0", "n"].includes(normalized)) return false;
  return null;
}

function dimension(status: AppSheetPendingStatus, reasonCodes: string[], evidenceFields: string[], relationships: AppSheetPendingRelationship[] = [], settlement?: AppSheetPendingDimension["settlement"]): AppSheetPendingDimension {
  const result: AppSheetPendingDimension = {
    status,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    evidenceFields: [...new Set(evidenceFields)].sort(),
    relationships,
  };
  if (settlement) result.settlement = settlement;
  return result;
}

function hasUnresolvedAny(record: AppSheetPendingSourceRecord, fields: readonly string[]): boolean {
  return fields.some(field => !fieldExists(record, field) || hasIssue(record, field));
}

function classifyPreSale(row: AppSheetPendingSourceRecord, index: RelationshipIndex, hash: AppSheetPendingHash): AppSheetPendingDimension {
  if (row.sourceTable !== "Pre_Venta") return EMPTY_DIMENSION();
  const stateField = "Estado_Preventa";
  const invoiceField = "Id_facturado";
  const details = reverseMatch(row, "Id_Preventa", "Pre_Detalle_Fact", "Id_Pre_Venta", index);
  const invoice = directMatch(row, invoiceField, "C_Facturacion", "Id_Factura", index);
  const relationships = [relationshipEvidence(details, hash), relationshipEvidence(invoice, hash)];
  const state = token(row.values[stateField]);
  const evidence = [stateField, invoiceField, "Id_Preventa", "Pre_Detalle_Fact.Id_Pre_Venta"];
  if (hasUnresolvedAny(row, [stateField, invoiceField, "Id_Preventa"]) || details.status === "unresolved" || invoice.status === "unresolved")
    return dimension("needs_review", ["presale_source_evidence_unresolved"], evidence, relationships);
  if (state === "cancelado") {
    if (invoice.status === "unique" || details.status === "ambiguous")
      return dimension("needs_review", ["cancelled_presale_has_conflicting_relationships"], evidence, relationships);
    return dimension("not_pending", ["presale_cancelled"], evidence, relationships);
  }
  if (state !== "confirmado") return dimension("needs_review", ["presale_status_not_recognized"], evidence, relationships);
  if (invoice.status === "unique") return dimension("not_pending", ["presale_has_invoice_reference"], evidence, relationships);
  if (invoice.status === "ambiguous")
    return dimension("needs_review", ["presale_invoice_reference_ambiguous"], evidence, relationships);
  if (details.status === "missing") return dimension("needs_review", ["presale_has_no_linked_details"], evidence, relationships);
  if (!["unique", "multiple"].includes(details.status)) return dimension("needs_review", ["presale_detail_relationship_unresolved"], evidence, relationships);
  return dimension("confirmed_pending", ["confirmed_presale_without_invoice_and_with_details"], evidence, relationships);
}

function movementRowsForInvoice(invoice: AppSheetPendingSourceRecord, index: RelationshipIndex, hash: AppSheetPendingHash): {
  newRows: AppSheetPendingSourceRecord[];
  oldRows: AppSheetPendingSourceRecord[];
  direct: MatchResult[];
  relationships: AppSheetPendingRelationship[];
  uncertain: boolean;
} {
  const motoRelation = reverseMatch(invoice, "N_factura", "C_Moto", "N_Factura", index);
  const motoMovementRelations = motoRelation.matches.map(moto =>
    reverseByRelationshipField(moto, "Id_Moto", "Movimiento_Nueva", "Origen_ID", index, "Tabla_Origen", "c_moto"));
  const directById = reverseByRelationshipField(invoice, "Id_Factura", "Movimiento_Nueva", "Origen_ID", index, "Tabla_Origen", "venta");
  const directByNumber = reverseByRelationshipField(invoice, "N_factura", "Movimiento_Nueva", "ID_Origen_2", index, "Tabla_Origen", "venta");
  const directOldById = reverseByRelationshipField(invoice, "Id_Factura", "Movimiento", "Origen_ID", index, "Tabla_Origen", "venta");
  const directOldByNumber = reverseByRelationshipField(invoice, "N_factura", "Movimiento", "ID_Origen_2", index, "Tabla_Origen", "venta");
  const legacyMotoCategory = APPSHEET_PENDING_MAPPING_SPEC.dimensions.receivable.motoMovementCategory;
  const oldMotoRows = motoRelation.matches.flatMap(moto => reverseByRelationshipField(moto, "Id_Moto", "Movimiento", "Origen_ID", index, "Tabla_Origen", legacyMotoCategory).matches);
  const uniqueRows = (items: AppSheetPendingSourceRecord[]) => [...new Map(items.map(item => [`${item.sourceTable}:${item.sourceRow}`, item])).values()];
  const newRows = uniqueRows([...directById.matches, ...directByNumber.matches, ...motoMovementRelations.flatMap(item => item.matches)]);
  const oldRows = uniqueRows([...directOldById.matches, ...directOldByNumber.matches, ...oldMotoRows]);
  const relationshipMatches = [motoRelation, directById, directByNumber, ...motoMovementRelations, directOldById, directOldByNumber];
  const uncertain = relationshipMatches.some(item => item.status === "unresolved" || item.status === "ambiguous") ||
    index.movementRelationshipsUnresolved;
  const direct = [directById, directByNumber, directOldById, directOldByNumber];
  const relationships = [
    relationshipEvidence(motoRelation, hash),
    ...direct.map(item => relationshipEvidence(item, hash)),
    ...motoMovementRelations.map(item => relationshipEvidence(item, hash)),
  ];
  return { newRows, oldRows, direct, relationships, uncertain };
}

function buildMovementCandidateIntegrity(rows: readonly AppSheetPendingSourceRecord[]): MovementCandidateIntegrity {
  const uniqueIdCounts = new Map<string, number>();
  const legacyIdCounts = new Map<string, number>();
  const compositeCounts = new Map<string, number>();
  let unresolvedUniqueIdRows = 0;
  let unresolvedLegacyIdRows = 0;
  for (const row of rows) {
    if (row.sourceTable !== "Movimiento_Nueva") continue;
    const uniqueIdField = "ID_Movimiento_Unique";
    const uniqueId = row.values[uniqueIdField] ?? null;
    if (!fieldExists(row, uniqueIdField) || hasIssue(row, uniqueIdField)) unresolvedUniqueIdRows++;
    else if (present(uniqueId)) uniqueIdCounts.set(uniqueId, (uniqueIdCounts.get(uniqueId) ?? 0) + 1);

    const legacyIdField = "ID_Movimiento";
    const legacyId = row.values[legacyIdField] ?? null;
    if (!fieldExists(row, legacyIdField) || hasIssue(row, legacyIdField)) unresolvedLegacyIdRows++;
    else if (present(legacyId)) legacyIdCounts.set(legacyId, (legacyIdCounts.get(legacyId) ?? 0) + 1);

    const completeComposite = APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS.every(field =>
      fieldExists(row, field) && !hasIssue(row, field) && present(row.values[field]));
    if (completeComposite) {
      const fingerprint = canonicalJson(APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS.map(field => row.values[field]));
      compositeCounts.set(fingerprint, (compositeCounts.get(fingerprint) ?? 0) + 1);
    }
  }
  return {
    duplicateUniqueIds: new Set([...uniqueIdCounts].filter(([, count]) => count > 1).map(([id]) => id)),
    duplicateLegacyIds: new Set([...legacyIdCounts].filter(([, count]) => count > 1).map(([id]) => id)),
    duplicateComposites: new Set([...compositeCounts].filter(([, count]) => count > 1).map(([fingerprint]) => fingerprint)),
    unresolvedUniqueIdRows,
    unresolvedLegacyIdRows,
  };
}

function movementCandidateIntegrityReason(payment: AppSheetPendingSourceRecord, index: MovementCandidateIntegrity): string | null {
  const uniqueIdField = "ID_Movimiento_Unique";
  const uniqueId = payment.values[uniqueIdField] ?? null;
  if (!fieldExists(payment, uniqueIdField) || hasIssue(payment, uniqueIdField) || !present(uniqueId) ||
      payment.sourceKey.startsWith(`synthetic:${payment.sourceTable}:`) || payment.sourceKey !== uniqueId)
    return "payment_candidate_unique_id_not_proven";
  if (index.unresolvedUniqueIdRows > 0) return "payment_candidate_unique_id_namespace_unresolved";
  if (index.duplicateUniqueIds.has(uniqueId)) return "payment_candidate_unique_id_duplicated";

  const legacyIdField = "ID_Movimiento";
  const legacyId = payment.values[legacyIdField] ?? null;
  if (!fieldExists(payment, legacyIdField) || hasIssue(payment, legacyIdField)) return "payment_candidate_legacy_id_unresolved";
  if (index.unresolvedLegacyIdRows > 0) return "payment_candidate_legacy_id_namespace_unresolved";
  if (present(legacyId) && index.duplicateLegacyIds.has(legacyId)) return "payment_candidate_legacy_id_duplicated";

  if (APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS.some(field => !fieldExists(payment, field) || hasIssue(payment, field)))
    return "payment_candidate_composite_fields_unresolved";
  const compositeValues = APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS.map(field => payment.values[field] ?? null);
  if (compositeValues.some(value => !present(value))) return "payment_candidate_composite_fields_incomplete";
  if (index.duplicateComposites.has(canonicalJson(compositeValues))) return "payment_candidate_composite_duplicated";
  return null;
}

function classifyReceivable(invoice: AppSheetPendingSourceRecord, index: RelationshipIndex, hash: AppSheetPendingHash, movementIntegrity: MovementCandidateIntegrity): AppSheetPendingDimension {
  if (invoice.sourceTable !== "C_Facturacion") return EMPTY_DIMENSION();
  const details = reverseMatch(invoice, "Id_Factura", "C_Detalle_Fact", "Id_Factura", index);
  const linked = movementRowsForInvoice(invoice, index, hash);
  const relationships = [relationshipEvidence(details, hash), ...linked.relationships];
  const evidence = ["Total_Facturado", "Tipo_Moneda", "Movimiento_Nueva.Monto", "Movimiento_Nueva.Tipo_Moneda", "Movimiento_Nueva.Tipo_Movimiento", "Movimiento", "C_Moto.N_Factura"];
  if (hasUnresolvedAny(invoice, ["Id_Factura", "N_factura", "Total_Facturado"]) || details.status === "unresolved" || linked.uncertain)
    return dimension("needs_review", ["receivable_relationship_or_source_unresolved"], evidence, relationships);
  if (!["unique", "multiple"].includes(details.status))
    return dimension("needs_review", ["invoice_detail_relationship_not_proven"], evidence, relationships);
  if (linked.oldRows.length > 0)
    return dimension("needs_review", ["legacy_movement_overlap_not_settled"], evidence, relationships);
  if (!fieldExists(invoice, "Tipo_Moneda") || hasIssue(invoice, "Tipo_Moneda") || !present(invoice.values.Tipo_Moneda))
    return dimension("needs_review", ["invoice_currency_missing_no_default_applied"], evidence, relationships);
  const due = parseMinorUnits(invoice.values.Total_Facturado, 2);
  if (due === null || due < 0n) return dimension("needs_review", ["invoice_total_not_exact"], evidence, relationships);
  if (due === 0n) return dimension("needs_review", ["invoice_total_zero_or_ambiguous"], evidence, relationships);
  let paid = 0n;
  for (const payment of linked.newRows) {
    if (hasUnresolvedAny(payment, ["Monto", "Tipo_Moneda", "Tipo_Movimiento"]))
      return dimension("needs_review", ["payment_fields_unresolved"], evidence, relationships);
    const integrityReason = movementCandidateIntegrityReason(payment, movementIntegrity);
    if (integrityReason) return dimension("needs_review", [integrityReason], evidence, relationships);
    if (token(payment.values.Tipo_Movimiento) !== "ingreso")
      return dimension("needs_review", ["linked_movement_is_not_explicit_income"], evidence, relationships);
    if (payment.values.Tipo_Moneda !== invoice.values.Tipo_Moneda)
      return dimension("needs_review", ["payment_currency_differs_from_invoice"], evidence, relationships);
    const amount = parseMinorUnits(payment.values.Monto, 2);
    if (amount === null || amount < 0n) return dimension("needs_review", ["payment_amount_not_exact"], evidence, relationships);
    paid += amount;
  }
  const remaining = due - paid;
  const paymentRowsHash = hashCanonical(hash, linked.newRows.map(item => reference(item, hash)).sort((left, right) => left.sourceRow - right.sourceRow));
  const settlement = {
    currency: invoice.values.Tipo_Moneda!,
    dueMinorUnits: due.toString(),
    paidMinorUnits: paid.toString(),
    remainingMinorUnits: remaining.toString(),
    paymentRowsHash,
  };
  if (remaining > 0n) return dimension("confirmed_pending", ["explicit_invoice_currency_and_partial_payments"], evidence, relationships, settlement);
  if (remaining === 0n) return dimension("not_pending", ["invoice_fully_paid_in_explicit_currency"], evidence, relationships, settlement);
  return dimension("needs_review", ["payments_exceed_invoice_total"], evidence, relationships, settlement);
}

function classifyUnpaidPurchase(purchase: AppSheetPendingSourceRecord, index: RelationshipIndex, hash: AppSheetPendingHash): AppSheetPendingDimension {
  if (purchase.sourceTable !== "C_Mercaderia") return EMPTY_DIMENSION();
  const movement = reverseByRelationshipField(purchase, "ID_Mercaderia", "Movimiento_Nueva", "Origen_ID", index, "Tabla_Origen", "c_mercaderia");
  const relationship = relationshipEvidence(movement, hash);
  const evidence = ["Tipo_Registro_Mercaderia", "Precio_Total_Abonado", "Movimiento_Nueva.Monto", "Movimiento_Nueva.Tipo_Moneda"];
  if (hasUnresolvedAny(purchase, ["ID_Mercaderia", "Tipo_Registro_Mercaderia"]) || movement.status === "unresolved")
    return dimension("needs_review", ["purchase_or_payment_relationship_unresolved"], evidence, [relationship]);
  if (token(purchase.values.Tipo_Registro_Mercaderia) !== "entrada")
    return dimension("needs_review", ["purchase_receipt_status_not_proven"], evidence, [relationship]);
  // Precio_Total_Abonado is a paid amount, not a source-proven gross amount due.
  // No total-due or purchase-currency field exists in the captured C_Mercaderia
  // headers, so absence of a cash movement cannot prove unpaid liability.
  return dimension("needs_review", ["purchase_total_due_and_currency_not_source_proven"], evidence, [relationship]);
}

function classifyDelivery(moto: AppSheetPendingSourceRecord, index: RelationshipIndex, hash: AppSheetPendingHash): AppSheetPendingDimension {
  if (moto.sourceTable !== "C_Moto") return EMPTY_DIMENSION();
  const invoice = directMatch(moto, "N_Factura", "C_Facturacion", "N_factura", index);
  const routeValue = moto.values.Moto_Ruta_ID ?? null;
  const route = directMatch(moto, "Moto_Ruta_ID", "O_Ruta", "Ruta_ID", index);
  const relationships = [relationshipEvidence(invoice, hash), relationshipEvidence(route, hash)];
  const evidence = ["Entrega_completada", "N_Factura", "Moto_Ruta_ID", "O_Ruta.Ruta_Activa"];
  if (hasUnresolvedAny(moto, ["Entrega_completada", "N_Factura", "Moto_Ruta_ID"]) || invoice.status !== "unique")
    return dimension("needs_review", [invoice.status === "ambiguous" ? "delivery_invoice_reference_ambiguous" : "delivery_invoice_reference_unresolved"], evidence, relationships);
  if (present(routeValue) && route.status !== "unique")
    return dimension("needs_review", [route.status === "ambiguous" ? "delivery_route_reference_ambiguous" : "delivery_route_reference_unresolved"], evidence, relationships);
  if (route.status === "unique") {
    const target = route.matches[0]!;
    if (!fieldExists(target, "Ruta_Activa") || hasIssue(target, "Ruta_Activa"))
      return dimension("needs_review", ["delivery_route_status_unresolved"], evidence, relationships);
    if (booleanValue(target.values.Ruta_Activa) !== true)
      return dimension("needs_review", ["delivery_route_not_confirmed_active"], evidence, relationships);
  }
  const delivered = booleanValue(moto.values.Entrega_completada);
  if (delivered === true) return dimension("not_pending", ["delivery_completion_explicit_true"], evidence, relationships);
  if (delivered === false)
    return dimension("confirmed_pending", [present(routeValue) ? "delivery_not_completed_on_active_route" : "delivery_not_completed_without_route_assignment"], evidence, relationships);
  return dimension("needs_review", ["delivery_completion_status_ambiguous"], evidence, relationships);
}

/**
 * Classifies source rows without database access or operational side effects.
 * Raw row values are used only in memory to resolve links and are never copied
 * to the returned reconciliation DTO.
 */
export function reconcileAppSheetPendingRows(
  rows: readonly AppSheetPendingSourceRecord[],
  capture: AppSheetPendingCaptureContext,
  hash: AppSheetPendingHash,
): Array<{ sourceTable: string; sourceRow: number; reconciliation: AppSheetPendingReconciliation }> {
  if (!validHash(capture.manifestHash) || !validHash(capture.mappingHash)) throw new TypeError("pending_capture_hash_invalid");
  if (!capture.captureId || capture.captureId.length > 128) throw new TypeError("pending_capture_id_invalid");
  if (rows.length > 100_000) throw new TypeError("pending_record_limit_exceeded");
  const relationshipIndex = buildRelationshipIndex(rows);
  const movementIntegrity = buildMovementCandidateIntegrity(rows);
  const identities = new Set<string>();
  for (const row of rows) {
    if (!APPSHEET_PENDING_TABLES.includes(row.sourceTable as (typeof APPSHEET_PENDING_TABLES)[number])) continue;
    if (!Number.isInteger(row.sourceRow) || row.sourceRow < 1 || row.sourceRow > 100_000 || !row.sourceKey || !validHash(row.sourceEvidenceHash))
      throw new TypeError("pending_source_record_invalid");
    const identity = `${row.sourceTable}\0${row.sourceRow}`;
    if (identities.has(identity)) throw new TypeError("pending_source_row_duplicated");
    identities.add(identity);
  }
  return rows.filter(row => APPSHEET_PENDING_TABLES.includes(row.sourceTable as (typeof APPSHEET_PENDING_TABLES)[number])).map(row => {
    const source = reference(row, hash);
    const reconciliation: AppSheetPendingReconciliation = {
      schemaVersion: APPSHEET_PENDING_SCHEMA_VERSION,
      mappingId: APPSHEET_PENDING_MAPPING_ID,
      mappingHash: capture.mappingHash,
      source,
      capture: {
        captureId: capture.captureId,
        manifestHash: capture.manifestHash,
        mode: capture.mode,
        provisional: capture.mode !== "stable",
      },
      dimensions: {
        preSale: classifyPreSale(row, relationshipIndex, hash),
        receivable: classifyReceivable(row, relationshipIndex, hash, movementIntegrity),
        unpaidPurchase: classifyUnpaidPurchase(row, relationshipIndex, hash),
        delivery: classifyDelivery(row, relationshipIndex, hash),
      },
    };
    return { sourceTable: row.sourceTable, sourceRow: row.sourceRow, reconciliation: appSheetPendingReconciliationSchema.parse(reconciliation) };
  });
}

export function pendingMappingFingerprintPayload(): string {
  return canonicalJson(APPSHEET_PENDING_MAPPING_SPEC);
}
