export interface AppSheetMigrationSnapshot {
  id: string;
  importerVersion: string;
  status: string;
  records: number;
  facts: number;
  openExceptions: number;
  tables: Array<{ name: string; records: number }>;
}

export interface AppSheetMigrationCapture {
  captureId: string;
  manifestHash: string;
  definitionHash: string | null;
  cutoffAt: string;
  verifiedAt: string;
  sheets: number;
  pages: number;
  records: number;
  formulas: number;
  unresolvedFormulas: number;
  inventory: { tables: number | null; columns: number | null; slices: number | null; views: number | null; actions: number | null; bots: number | null };
  snapshots: AppSheetMigrationSnapshot[];
}

export interface AppSheetMigrationSummary {
  captures: AppSheetMigrationCapture[];
  preliminary: Array<AppSheetMigrationSnapshot & { createdAt: string; manifestHash: string }>;
}
export interface AppSheetHistoryView {
  id: string;
  sourceRecordId: string;
  sourceTable: string;
  sourceKey: string;
  sourceRow: number;
  sourceHash: string;
  kind: string;
  occurredOn: string | null;
  dateState: string;
  currency: string | null;
  currencyState: string;
  amountMinor: string | null;
  amountState: string;
  quantity: string | null;
  quantityState: string;
  unit: string | null;
  openExceptions: number;
}
export interface AppSheetHistoryPage { items: AppSheetHistoryView[]; nextCursor: string | null }

export interface AppSheetPendingPage {
  items: Array<{
    sourceRecordId: string;
    sourceTable: string;
    sourceRow: number;
    sourceHash: string;
    integrity: "valid" | "invalid";
    reconciliation: import("./appsheet-pending.js").AppSheetPendingReconciliation | null;
  }>;
  nextCursor: string | null;
}
