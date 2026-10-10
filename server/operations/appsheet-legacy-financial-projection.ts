import { isAppSheetInvoiceTotalPending } from "../../shared/operations/appsheet.js";
import {
  appSheetLegacyAdjustedFinancialState,
  appSheetLegacyAdjustedOutstanding,
} from "../../shared/operations/appsheet-pending-import.js";
import { reviewedAppSheetLegacyPaidForOrder } from "./appsheet-pending-import.js";
import type { Tx } from "./core.js";

export type AppSheetLegacyFinancialOrder = {
  id: string;
  memberId: string;
  currency: string;
  totalMinor: bigint;
  verifiedMinor: bigint;
  refundedMinor: bigint;
  commercialState: string;
  financialState: string;
  quote: unknown;
};

export type AppSheetLegacyFinancialSummary = {
  financialState: string | null;
  legacyFinancialProjectionState: "reviewed" | "unknown";
  /** Bombo's own counters, refreshed in the same read snapshot as the historical proof. */
  verifiedMinor: string | null;
  refundedMinor: string | null;
  legacyPaidMinor: string | null;
  outstandingMinor: string | null;
  legacyFinancialProjectionReason: "invoice_total_pending" | "historical_payment_review_blocked" | "financial_basis_invalid" | null;
};

/** A failed historical review or unresolved invoice total must never look like a collectible balance. */
export function projectAppSheetLegacyFinancialSummary(
  order: AppSheetLegacyFinancialOrder,
  legacyPaidMinor: bigint | null,
): AppSheetLegacyFinancialSummary {
  if (legacyPaidMinor === null) {
    return { financialState: null, legacyFinancialProjectionState: "unknown", verifiedMinor: order.verifiedMinor.toString(),
      refundedMinor: order.refundedMinor.toString(), legacyPaidMinor: null,
      outstandingMinor: null, legacyFinancialProjectionReason: "historical_payment_review_blocked" };
  }
  if (isAppSheetInvoiceTotalPending(order.quote)) {
    return { financialState: null, legacyFinancialProjectionState: "unknown", verifiedMinor: order.verifiedMinor.toString(),
      refundedMinor: order.refundedMinor.toString(), legacyPaidMinor: null,
      outstandingMinor: null, legacyFinancialProjectionReason: "invoice_total_pending" };
  }
  try {
    const calculatedFinancialState = appSheetLegacyAdjustedFinancialState({ totalMinor: order.totalMinor,
      bomboVerifiedMinor: order.verifiedMinor, legacyPaidMinor, refundedMinor: order.refundedMinor });
    const isUnpaidUnconfirmedZeroTotal = order.totalMinor === 0n && order.verifiedMinor === 0n && legacyPaidMinor === 0n &&
      ["draft", "preorder"].includes(order.commercialState);
    const financialState = isUnpaidUnconfirmedZeroTotal ? order.financialState : calculatedFinancialState;
    const outstandingMinor = appSheetLegacyAdjustedOutstanding({ totalMinor: order.totalMinor,
      bomboVerifiedMinor: order.verifiedMinor, legacyPaidMinor, cancelled: order.commercialState === "cancelled" });
    return { financialState, legacyFinancialProjectionState: "reviewed", verifiedMinor: order.verifiedMinor.toString(),
      refundedMinor: order.refundedMinor.toString(), legacyPaidMinor: legacyPaidMinor.toString(),
      outstandingMinor: outstandingMinor.toString(), legacyFinancialProjectionReason: null };
  } catch {
    return { financialState: null, legacyFinancialProjectionState: "unknown", verifiedMinor: order.verifiedMinor.toString(),
      refundedMinor: order.refundedMinor.toString(), legacyPaidMinor: null,
      outstandingMinor: null, legacyFinancialProjectionReason: "financial_basis_invalid" };
  }
}

/**
 * Resolve only orders with a legacy settlement using one batched candidate query, then run
 * the same full review guard used before applying Bombo collections. No ledger is written.
 */
export async function appSheetLegacyFinancialSummariesForOrders(
  tx: Tx,
  orders: AppSheetLegacyFinancialOrder[],
): Promise<Map<string, AppSheetLegacyFinancialSummary>> {
  const orderIds = [...new Set(orders.map(order => order.id))];
  if (!orderIds.length) return new Map();
  const currentOrders = await tx.operationOrder.findMany({
    where: { id: { in: orderIds } },
    select: { id: true, memberId: true, currency: true, totalMinor: true, verifiedMinor: true, refundedMinor: true,
      commercialState: true, financialState: true, quote: true },
  });
  const currentOrderById = new Map(currentOrders.map(order => [order.id, order]));
  const currentOrderIds = currentOrders.map(order => order.id);
  const candidates = await tx.appSheetLegacySettlement.findMany({
    where: { operationOrderId: { in: currentOrderIds } },
    select: { operationOrderId: true },
  });
  const candidateIds = new Set(candidates.map(candidate => candidate.operationOrderId));
  const summaries = new Map<string, AppSheetLegacyFinancialSummary>();
  for (const requestedOrder of orders) {
    const order = currentOrderById.get(requestedOrder.id);
    if (!order) {
      summaries.set(requestedOrder.id, { financialState: null, legacyFinancialProjectionState: "unknown",
        verifiedMinor: null, refundedMinor: null, legacyPaidMinor: null, outstandingMinor: null,
        legacyFinancialProjectionReason: "financial_basis_invalid" });
      continue;
    }
    let legacyPaidMinor: bigint | null = 0n;
    if (candidateIds.has(order.id)) {
      try {
        legacyPaidMinor = await reviewedAppSheetLegacyPaidForOrder(tx, order);
      } catch {
        legacyPaidMinor = null;
      }
    }
    summaries.set(order.id, projectAppSheetLegacyFinancialSummary(order, legacyPaidMinor));
  }
  return summaries;
}
