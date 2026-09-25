export const dataImportKinds = [
  "delivery_sales",
  "purchases",
  "stock",
  "cash_reconciliation",
  "cash_movements",
  "expenses",
  "promotions",
  "members",
] as const;

export type DataImportKind = (typeof dataImportKinds)[number];

export const dataImportColumns = [
  "recordType",
  "sourceId",
  "date",
  "orderDate",
  "parentSourceId",
  "total",
  "discount",
  "itemLabel",
  "productSourceId",
  "quantity",
  "unit",
  "unitPrice",
  "lineTotal",
  "supplierSourceId",
  "locationSourceId",
  "lostQuantity",
  "category",
  "label",
  "endDate",
  "account",
  "expected",
  "counted",
  "amount",
  "memberKey",
  "permitStatus",
  "permitExpiryDate",
  "permitCheckedAt",
] as const;

export type DataImportColumn = (typeof dataImportColumns)[number];

/**
 * Identifier columns must contain opaque source IDs. The server blocks contact or
 * identity headers and email-shaped values; arbitrary personal text under a generic
 * header cannot be classified reliably and must be excluded by the source owner.
 */
export interface DataImportMapping {
  version: string;
  columns: Partial<Record<DataImportColumn, string>>;
  sheetName?: string;
  decimalSeparator?: "." | ",";
}

export interface DataImportInput {
  kind: DataImportKind;
  sourceSystem: string;
  filename: string;
  contentBase64: string;
  mapping: DataImportMapping;
  cutoff: string;
}

export interface DataImportFileInput {
  filename: string;
  contentBase64: string;
  sheetName?: string;
}

export interface DataImportInspection {
  sheets: string[];
  headers: string[];
  sampleRows: Record<string, string>[];
}

interface FactBase {
  sourceId: string;
  date: string;
}

export type HistoricalImportFact =
  | (FactBase & {
      kind: "delivery_sale";
      totalCents: string;
      discountCents: string;
    })
  | (FactBase & {
      kind: "delivery_sale_line";
      parentSourceId: string;
      itemLabel: string;
      productSourceId: string | null;
      quantityMilliunits: string;
      quantityUnit: string;
      unitPriceCents: string | null;
      lineTotalCents: string;
    })
  | (FactBase & {
      kind: "purchase_receipt";
      /** Optional supplier order date; must be on or before the receipt date and cutoff. */
      orderDate: string | null;
      supplierSourceId: string | null;
      totalCents: string;
    })
  | (FactBase & {
      kind: "purchase_receipt_line";
      parentSourceId: string;
      itemLabel: string;
      productSourceId: string | null;
      quantityMilliunits: string;
      quantityUnit: string;
      unitCostCents: string | null;
      lineTotalCents: string;
    })
  | (FactBase & {
      kind: "stock_observation";
      productSourceId: string | null;
      itemLabel: string;
      locationSourceId: string | null;
      quantityMilliunits: string;
      quantityUnit: string;
    })
  | (FactBase & {
      kind: "stockout";
      productSourceId: string | null;
      itemLabel: string;
      locationSourceId: string | null;
      lostQuantityMilliunits: string | null;
      quantityUnit: string | null;
    })
  | (FactBase & {
      kind: "expense";
      category: string;
      amountCents: string;
    })
  | (FactBase & {
      kind: "promotion";
      label: string;
      endDate: string | null;
      discountCents: string | null;
    })
  | (FactBase & {
      kind: "cash_reconciliation";
      account: string;
      expectedCents: string;
      countedCents: string;
      varianceCents: string;
    });

/** Member sourceId/memberKey are keyed HMAC pseudonyms; keep the configured key stable. */
export type DataImportFact = HistoricalImportFact |
  {
    kind: "cash_movement";
    sourceId: string;
    date: string;
    account: string;
    /** Recognized categories receive direction checks; unknown legacy labels are preserved as supplied. */
    category: string;
    amountCents: string;
  } |
  {
    kind: "member";
    sourceId: string;
    memberKey: string;
    permitStatus: string;
    permitExpiryDate: string | null;
    permitCheckedAt: string | null;
  };

export interface DataImportIssue {
  row: number;
  field: string;
  code: string;
}

export type DataImportBatchStatus = "ready" | "rejected" | "imported" | "reconciled";

export interface DataImportPreview {
  batchId: string;
  status: DataImportBatchStatus;
  kind: DataImportKind;
  sourceSystem: string;
  fileHash: string;
  mappingVersion: string;
  cutoff: string;
  rowCount: number;
  acceptedCount: number;
  skipped: number;
  errors: DataImportIssue[];
  conflicts: DataImportIssue[];
  sample: DataImportFact[];
}

export interface DataImportCommitResult {
  batchId: string;
  status: "imported" | "reconciled";
  inserted: number;
  skipped: number;
}
