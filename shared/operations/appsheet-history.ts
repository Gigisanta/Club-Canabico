/**
 * Historical-only projection rules for the AppSheet live capture.
 *
 * These rules intentionally describe source facts. They never create stock,
 * cash, delivery, payment, messaging, or document-operation events.
 */
export const APPSHEET_HISTORY_SOURCE_SYSTEM = "appsheet-live-verified" as const;
export const APPSHEET_HISTORY_IMPORTER_VERSION = "bombo-appsheet-history/1.0.0" as const;
export const APPSHEET_HISTORY_MAPPING_ID = "appsheet-live-history-v1" as const;

export type AppSheetHistoryKind =
  | "invoice"
  | "sale-line"
  | "purchase"
  | "cash"
  | "expense"
  | "fx"
  | "delivery"
  | "archive";

export interface AppSheetHistoryTableRule {
  table: string;
  kind: AppSheetHistoryKind;
  /** Source key from the table definition. Missing/duplicate values stay exceptions. */
  keyField: string | null;
  dateField: string | null;
  amountField: string | null;
  quantityField: string | null;
  currencyField: string | null;
  /** Explicitly known physical unit, based on the source column's name. */
  defaultUnit: "g" | "ud" | null;
  /** Fields that name a related source row; never used as a substitute key. */
  relationships: readonly {
    sourceField: string;
    targetTable: string;
    targetField: string;
  }[];
  /** Source flags are kept as evidence and must not be treated as certification. */
  nonAuthoritativeStatusFields: readonly string[];
}

/**
 * Field names were read from the live Sheets header capture. A null amount
 * means preserve all source columns but do not derive a single monetary value
 * from a multi-currency or semantically ambiguous row.
 */
export const APPSHEET_HISTORY_TABLE_RULES = [
  {
    table: "C_Facturacion",
    kind: "invoice",
    keyField: "Id_Factura",
    dateField: "Fecha",
    amountField: "Total_Facturado",
    quantityField: "Cantidad_Gr",
    currencyField: null,
    defaultUnit: "g",
    relationships: [],
    nonAuthoritativeStatusFields: ["Estado", "Fecha_Cobro", "Moto_Cobrada"],
  },
  {
    table: "C_Detalle_Fact",
    kind: "sale-line",
    keyField: "Id_Detalle",
    dateField: "Fecha",
    amountField: "Valor_Total",
    quantityField: "Cantidad_Gr",
    currencyField: null,
    defaultUnit: "g",
    relationships: [{ sourceField: "Id_Factura", targetTable: "C_Facturacion", targetField: "Id_Factura" }],
    nonAuthoritativeStatusFields: [],
  },
  {
    table: "C_Moto",
    kind: "delivery",
    keyField: "Id_Moto",
    dateField: "Fecha",
    amountField: null,
    quantityField: null,
    currencyField: null,
    defaultUnit: null,
    relationships: [{ sourceField: "N_Factura", targetTable: "C_Facturacion", targetField: "N_factura" }],
    nonAuthoritativeStatusFields: ["Cobranza", "Entrega_completada", "Fecha_Entrega"],
  },
  {
    table: "Movimiento_Nueva",
    kind: "cash",
    keyField: "ID_Movimiento_Unique",
    dateField: "Fecha",
    amountField: "Monto",
    quantityField: null,
    currencyField: "Tipo_Moneda",
    defaultUnit: null,
    relationships: [],
    nonAuthoritativeStatusFields: [],
  },
  {
    table: "Movimiento",
    kind: "cash",
    keyField: "ID_Movimiento",
    dateField: "Fecha",
    amountField: "Monto",
    quantityField: null,
    currencyField: "Tipo_Moneda",
    defaultUnit: null,
    relationships: [],
    nonAuthoritativeStatusFields: ["Anulado"],
  },
  {
    table: "C_Mercaderia",
    kind: "purchase",
    keyField: "ID_Mercaderia",
    dateField: "Fecha_Compra",
    amountField: "Precio_Total_Abonado",
    quantityField: "Cantidad_Cann_Ingresado",
    currencyField: null,
    defaultUnit: null,
    relationships: [{ sourceField: "Codigo_Detalle", targetTable: "D_Catalogo_Mercaderia", targetField: "Codigo_Detalle" }],
    nonAuthoritativeStatusFields: ["Mercaderia_Movimiento_Generado", "Anulado", "Fecha_Entrega"],
  },
  {
    table: "C_gastos_operacion",
    kind: "expense",
    keyField: "Id_gastos",
    dateField: "Fecha",
    amountField: "Monto",
    quantityField: null,
    currencyField: null,
    defaultUnit: null,
    relationships: [],
    nonAuthoritativeStatusFields: ["Gasto_Movimiento_Generado", "Anulado"],
  },
  {
    table: "C_OperacionUSD",
    kind: "fx",
    keyField: "ID_OPUSD",
    dateField: "Fecha",
    amountField: null,
    quantityField: null,
    currencyField: null,
    defaultUnit: null,
    relationships: [],
    nonAuthoritativeStatusFields: ["Caja_Movimiento_Generado", "Anulado"],
  },
  {
    table: "Auditoria_General",
    kind: "archive",
    keyField: null,
    dateField: null,
    amountField: null,
    quantityField: null,
    currencyField: null,
    defaultUnit: null,
    relationships: [],
    nonAuthoritativeStatusFields: [],
  },
  {
    table: "Auditoria_Stock_Detalle_Mercaderia",
    kind: "archive",
    keyField: "Audit_ID",
    dateField: "Fecha_Log",
    amountField: null,
    quantityField: null,
    currencyField: null,
    defaultUnit: null,
    relationships: [],
    nonAuthoritativeStatusFields: [],
  },
  {
    table: "Auditoria_Movimiento_Factura_gasto_Caja",
    kind: "archive",
    keyField: "Audit_ID",
    dateField: "Fecha_Log",
    amountField: null,
    quantityField: null,
    currencyField: null,
    defaultUnit: null,
    relationships: [],
    nonAuthoritativeStatusFields: [],
  },
] as const satisfies readonly AppSheetHistoryTableRule[];

export const APPSHEET_HISTORY_TABLE_NAMES = APPSHEET_HISTORY_TABLE_RULES.map(rule => rule.table);
export const APPSHEET_HISTORY_MOVEMENT_OVERLAP_FIELDS = [
  "Fecha",
  "Tipo_Movimiento",
  "Concepto",
  "Caja",
  "Monto",
  "Tipo_Moneda",
  "Afecta_Resultado",
] as const;

export const APPSHEET_HISTORY_MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
export const APPSHEET_HISTORY_MAX_RECORDS = 100_000;
export const APPSHEET_HISTORY_MAX_PAGE_BYTES = 32 * 1024 * 1024;

/**
 * Header matching tolerates harmless whitespace/Unicode differences only.
 * It does not make duplicate source headers unambiguous: callers must reject
 * duplicate matches explicitly.
 */
export function normalizeAppSheetHistoryHeader(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export function appSheetHistoryRule(table: string): AppSheetHistoryTableRule | null {
  return APPSHEET_HISTORY_TABLE_RULES.find(rule => rule.table === table) ?? null;
}
