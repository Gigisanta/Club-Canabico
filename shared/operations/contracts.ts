/** Wire v1: closed amounts and decimals are exact strings. Civil dates use the club timezone. */
export const businessTimeZone = "America/Argentina/Buenos_Aires";
export type Currency = "ARS" | "USD";
export interface CommandEnvelope {
  schemaVersion: 1;
  requestId: string;
  targetId: string;
  expectedVersion: number;
  occurredAt: string;
  command: string;
  data: Record<string, unknown>;
}
export interface CommandResult {
  requestId: string;
  targetId: string;
  version: number;
  result: Record<string, unknown>;
  replay?: boolean;
}
export type Capability =
  | "operations.read" | "members.read" | "members.write" | "permissions.verify"
  | "clinical.read" | "clinical.review" | "documents.read" | "documents.write"
  | "prices.propose" | "prices.approve" | "tasks.write" | "orders.write"
  | "stock.read" | "stock.receive" | "stock.prepare" | "stock.adjust"
  | "purchases.write" | "logistics.write" | "delivery.report"
  | "finance.read" | "collections.report" | "collections.verify" | "renditions.accept"
  | "accounts.write" | "openings.approve" | "payables.write" | "imports.write"
  | "imports.review" | "reports.read" | "access.manage" | "cutover.approve" | "queue.recover";
export const profileCapabilities: Record<string, Capability[]> = {
  owner: ["operations.read","members.read","members.write","permissions.verify","documents.read","documents.write","prices.propose","prices.approve","tasks.write","orders.write","stock.read","stock.receive","stock.prepare","stock.adjust","purchases.write","logistics.write","finance.read","collections.report","collections.verify","renditions.accept","accounts.write","openings.approve","payables.write","imports.write","imports.review","reports.read","access.manage","cutover.approve","queue.recover"],
  finance: ["operations.read","members.read","documents.read","finance.read","collections.report","collections.verify","renditions.accept","accounts.write","payables.write","imports.write","imports.review","reports.read","queue.recover"],
  commercial: ["operations.read","members.read","members.write","prices.propose","tasks.write","orders.write"],
  stock: ["operations.read","stock.read","stock.receive","stock.prepare","stock.adjust","purchases.write","documents.read"],
  logistics: ["operations.read","stock.read","logistics.write","documents.read"],
  driver: ["delivery.report","collections.report"],
  cashier: ["operations.read","members.read","orders.write","collections.report","collections.verify","renditions.accept","documents.read","finance.read"],
  clinical: ["members.read","clinical.read","clinical.review","permissions.verify","documents.read","documents.write"],
  viewer: ["operations.read"],
};
export interface MoneyValue { currency: Currency; minor: string }
export interface MetricValue { value: string | null; currency?: Currency; unit?: string; coverage: { known: number; total: number; reason?: string } }
export const cutoverGateIds = ["legacy-writers-inventoried","legacy-queues-drained","final-export-consistent","final-delta-reconciled","open-objects-approved","physical-opening-approved","cash-opening-approved","legacy-writes-disabled","android-accepted","restore-accepted","shadow-seven-days","analytics-approved","professional-permissions-approved","handoff-approved"] as const;
