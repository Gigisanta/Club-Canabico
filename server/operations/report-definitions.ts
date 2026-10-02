import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import type { Capability } from "../../shared/operations/contracts.js";
import { capabilities, objectScope, OperationError, requireCapability, wire } from "./core.js";
import { queryOperationsReport, supportsReportScope, validateReportScope } from "./report-queries.js";

export const reportAreaIds = [
  "sales-revenue",
  "product-contribution",
  "operating-expenses",
  "purchases",
  "inventory",
  "cash-ledger",
  "delivery-collections",
  "fx-reconciliation",
  "customer-segmentation",
  "commercial-scenarios",
  "obligations-13-weeks",
] as const;

export type ReportAreaId = (typeof reportAreaIds)[number];
export type ReportFieldKind = "minor-unit-string" | "decimal-string" | "count" | "civil-date" | "state" | "evidence";

export interface ReportFieldContract {
  name: string;
  kind: ReportFieldKind;
  nullable: boolean;
  currency: "same-as-parent" | "per-row" | "not-monetary";
  meaning: string;
}

export interface ReportAreaDefinition {
  id: ReportAreaId;
  title: string;
  purpose: string;
  grain: string;
  historicalModels: readonly string[];
  operationalModels: readonly string[];
  legacyMeasureTables: readonly string[];
  dateRoles: readonly string[];
  dimensions: readonly string[];
  inclusionRules: readonly string[];
  output: readonly ReportFieldContract[];
  currencyPolicy: string;
  coveragePolicy: string;
  sensitivity: "aggregate-internal" | "restricted-finance" | "restricted-member-aggregate";
  requiredCapability: Capability;
  version: {
    historical: "pbix-2026-09-30";
    operational: "operations-v1";
    queryState: "operations-v1-query-implemented-unverified" | "operations-v1-observed-only-incomplete-fx-coverage";
  };
}

const moneyByCurrency: ReportFieldContract = {
  name: "netProductRevenueByCurrency",
  kind: "minor-unit-string",
  nullable: true,
  currency: "per-row",
  meaning: "Exact signed minor-unit totals, grouped by ISO currency; no implicit conversion.",
};

const evidenceState: ReportFieldContract = {
  name: "evidenceState",
  kind: "state",
  nullable: false,
  currency: "not-monetary",
  meaning: "Observed, partial, reconciled, estimated, scenario, or missing as supported by source evidence.",
};

const commonCoverage: ReportFieldContract = {
  name: "coverage",
  kind: "evidence",
  nullable: false,
  currency: "not-monetary",
  meaning: "Known and expected source counts, date span, source batch, and reconciliation state; visible-row limits are reported separately and never imply a complete aggregate.",
};

export const reportDefinitions = [
  {
    id: "sales-revenue",
    title: "Ventas e ingresos",
    purpose: "Show confirmed local orders separately from imported historical delivery sales and distinguish net product revenue from invoice totals.",
    grain: "One order and, where required, one order line.",
    historicalModels: ["HistoricalDeliverySale", "HistoricalDeliverySaleLine", "LegacySourceRecord", "HistoricalImportBatch"],
    operationalModels: ["OperationOrder", "OperationOrderLine"],
    legacyMeasureTables: ["C_Facturacion", "C_Detalle_Fact", "DimFecha"],
    dateRoles: ["OperationOrder.confirmedAt", "HistoricalDeliverySale.saleDate"],
    dimensions: ["channel", "currency", "date", "SKU", "unit"],
    inclusionRules: [
      "Use confirmed orders and exclude fully cancelled fulfillment. Retained quoted product revenue excludes cancelled demand and customer returns using the frozen billed-to-physical allocation ratio.",
      "Original order totals remain the frozen original quote. Financial refunds and cash receipts are separate facts and do not redefine retained product quantities.",
      "Historical delivery facts remain a separate source and do not create local stock or cash events.",
      "Do not equate product subtotal, order total, verified collections, or ledger movements.",
    ],
    output: [
      { name: "orderCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Distinct included order IDs." },
      { name: "netProductRevenueByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Retained confirmed quoted product revenue, grouped by order currency; not delivered revenue or cash received." },
      { name: "revenueQuantityCoverage", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Completeness and validity of the frozen billed-to-physical return ratios used to exclude customer returns." },
      { name: "dateRange", kind: "civil-date", nullable: true, currency: "not-monetary", meaning: "Inclusive source-date range." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Group ARS and USD independently. Do not add Order currency buckets or convert without an explicit, dated rate contract.",
    coveragePolicy: "Only label coverage complete when the source period and batch reconciliation are attested; an empty period is not assumed to be zero.",
    sensitivity: "restricted-finance",
    requiredCapability: "finance.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "product-contribution",
    title: "Contribución por producto",
    purpose: "Calculate revenue less lot-allocated cost and assignable variable cost with exact money arithmetic.",
    grain: "One delivered order line allocated to one inventory lot.",
    historicalModels: ["HistoricalDeliverySaleLine", "HistoricalPurchaseReceiptLine", "LegacySourceRecord"],
    operationalModels: ["OperationOrder", "OperationOrderLine", "PreparationAllocation", "StockFact", "InventoryLot", "OperationPayable"],
    legacyMeasureTables: ["C_Detalle_Fact", "C_Facturacion", "C_Mercaderia", "D_Catalogo_Mercaderia", "Combos", "Descuentos"],
    dateRoles: ["OperationOrder.confirmedAt", "StockFact.occurredAt", "InventoryLot.receivedAt"],
    dimensions: ["SKU", "lot", "channel", "unit", "currency"],
    inclusionRules: [
      "Use net line revenue and the cost recorded for the units actually delivered from each lot.",
      "Physical excess affects stock and allocated cost, not the frozen billed quantity. Customer returns reduce billed revenue through the frozen allocation ratio; undelivered returns do not reverse delivered cost.",
      "Management contribution adds frozen net delivery/surcharge charges only on completed fulfillment and subtracts verified courier fees and explicitly classified variable operating expenses by accrual month, once regardless of payment.",
      "Positive charges on partial fulfillment, missing expense classification, or missing accrual period leave management contribution unavailable. Observed arithmetic does not attest complete source-period coverage.",
      "Keep fixed operating expenses outside per-line contribution; show them in the operating-expense area.",
      "Historical average-cost DAX is reference only and does not prove lot/FIFO cost allocation.",
    ],
    output: [
      { name: "deliveredLineCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact count across the filtered delivered-line population." },
      { name: "linesWithRevenueObserved", kind: "count", nullable: false, currency: "not-monetary", meaning: "Observed line count; detailed source rows are capped at 10,000 and dependent money totals are withheld if that cap truncates the population." },
      { name: "productSourceRowsComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether all delivered lines and their preparation allocations were loaded; false means dependent product money totals are null." },
      { name: "revenueByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Full-population total, or null when the 10,000-row line/allocation limit prevents a complete calculation." },
      { name: "actualAllocatedCostSoldByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Full-population allocated cost, or null when the 10,000-row line/allocation limit prevents a complete calculation." },
      { name: "netRevenueMinor", kind: "minor-unit-string", nullable: true, currency: "same-as-parent", meaning: "Net line revenue in the order currency." },
      { name: "historicalCostMinor", kind: "minor-unit-string", nullable: true, currency: "same-as-parent", meaning: "Cost tied to delivered quantity and lot." },
      { name: "variableCostsMinor", kind: "minor-unit-string", nullable: true, currency: "same-as-parent", meaning: "Only evidenced variable costs assigned to the line." },
      { name: "contributionMinor", kind: "minor-unit-string", nullable: true, currency: "same-as-parent", meaning: "Revenue minus evidenced costs." },
      { name: "grossContributionBeforeFixedCostsByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Delivered product revenue less actual allocated cost, before delivery/surcharge charges or general variable costs." },
      { name: "managementContributionBeforeFixedCostsByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Product contribution plus completed net delivery/surcharge charges less verified accrued variable costs; unavailable when required classifications or allocations are pending." },
      { name: "managementCoverage", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Observed arithmetic completeness, pending charges/costs, and the explicit absence of source-period completeness attestation." },
      { name: "fixedCosts", kind: "evidence", nullable: true, currency: "not-monetary", meaning: "Approved effective monthly schedule, with period totals only for fully covered calendar months." },
      { name: "contributionAfterFixedCostsByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Observed management contribution less approved fixed costs in the same currency, only when both arithmetic inputs cover the period; source completeness remains separately reported." },
      { name: "allocationCoverage", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Observed allocation counts and exceptions; see source coverage for whether the line/allocation row limit was reached." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Every contribution is one-currency. Reject or partition mixed-currency inputs before calculation.",
    coveragePolicy: "Contribution is unavailable where revenue, delivered quantity, lot allocation, or historical cost is missing; report known partials separately.",
    sensitivity: "restricted-finance",
    requiredCapability: "finance.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "operating-expenses",
    title: "Gastos operativos",
    purpose: "Separate expenses accrued for management reporting from the cash payment that settles them.",
    grain: "One dated expense record, with a separate linked payment event when paid.",
    historicalModels: ["HistoricalExpense", "LegacySourceRecord", "HistoricalImportBatch"],
    operationalModels: ["Expense", "OperationPayable", "PayablePayment", "LedgerEvent", "LedgerLeg"],
    legacyMeasureTables: ["C_gastos_operacion", "Movimiento_Nueva"],
    dateRoles: ["HistoricalExpense.expenseDate", "Expense.date", "PayablePayment.date", "LedgerEvent.occurredAt"],
    dimensions: ["category", "accrual period", "payment date", "currency", "account"],
    inclusionRules: [
      "An expense record is not proof of payment; use LedgerLeg/PayablePayment for cash settlement.",
      "Keep inventory purchases and local investments out of operating expenses.",
      "Historical formulas filtering editable concept labels are not a portable category contract.",
    ],
    output: [
      { name: "historicalExpenseByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population historical expense total; the legacy source currency is unknown." },
      { name: "compatibilityExpenseByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population compatibility expense total; the source currency is unknown." },
      { name: "verifiedPayableAccrualByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population verified operating-payable accruals by currency." },
      { name: "unverifiedPayableAccrualByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population unverified operating-payable accruals by currency." },
      { name: "paidPayableByObligationCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population dated applied payments grouped by the linked obligation currency." },
      { name: "openVerifiedOperatingPayablesByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population outstanding verified operating obligations." },
      { name: "openUnverifiedOperatingPayablesByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population outstanding unverified operating obligations." },
      { name: "counts", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Exact historical, compatibility, payable, and payment row counts for the queried sources." },
      { name: "fixedCosts", kind: "evidence", nullable: true, currency: "not-monetary", meaning: "Approved private monthly schedule, separate from accrued expenses and cash payments." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Partition by currency; never substitute a cash amount for an accrued expense amount.",
    coveragePolicy: "Historical expenses, compatibility expenses, operating payables, and payments use full-population SQL aggregates; source record and payment-event coverage are reported independently.",
    sensitivity: "restricted-finance",
    requiredCapability: "finance.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "purchases",
    title: "Compras y costos de ingreso",
    purpose: "Reconcile purchase orders, received quantities, lot costs, and payable settlement without expensing inventory twice.",
    grain: "One purchase receipt line and its resulting inventory lot.",
    historicalModels: ["HistoricalPurchaseReceipt", "HistoricalPurchaseReceiptLine", "LegacySourceRecord"],
    operationalModels: ["PurchaseOrder", "GoodsReceipt", "InventoryLot", "OperationPayable", "PayablePayment"],
    legacyMeasureTables: ["C_Mercaderia", "D_Catalogo_Mercaderia"],
    dateRoles: ["PurchaseOrder.agreementDate", "GoodsReceipt.receivedDate", "InventoryLot.receivedAt", "PayablePayment.date"],
    dimensions: ["supplier", "SKU", "lot", "unit", "currency"],
    inclusionRules: [
      "Use received quantity and receipt evidence for stock entry; ordered quantity is not received stock.",
      "Purchase cost enters inventory; payment affects cash, and cost affects result as units are sold.",
      "Do not infer an unpaid balance from missing legacy flags or dates.",
    ],
    output: [
      { name: "purchaseOrders", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Full-population order count, currency totals, and counts by observed status." },
      { name: "receipts", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Full-population receipt count, linked-order count, and created-lot count." },
      { name: "verifiedOpenPurchasePayablesByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population outstanding verified purchase obligations." },
      { name: "pendingOpenPurchasePayablesByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population outstanding unverified purchase obligations." },
      { name: "historicalPurchaseReceiptCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Full-population historical receipt count." },
      { name: "historicalPurchaseTotalByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population historical purchase total; the source currency is unknown." },
      { name: "receiptQuantities", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Explicitly not calculated until receipt items have a typed quantity contract." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Preserve receipt and payable currencies as recorded; no inferred conversion.",
    coveragePolicy: "Reconcile purchase source IDs, receipt lines, lot IDs, and payable IDs. Unmatched or duplicate source keys stay exceptions.",
    sensitivity: "restricted-finance",
    requiredCapability: "finance.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "inventory",
    title: "Inventario por lote",
    purpose: "Show stock balances separately from goods still held after preparation or dispatch, with unit, source location, and custodian evidence.",
    grain: "One SKU, lot, source location, custodian, and custody stage; stock facts remain event-level.",
    historicalModels: ["HistoricalStockObservation", "HistoricalStockout", "LegacySourceRecord"],
    operationalModels: ["CatalogSku", "InventoryLot", "StockBalance", "StockReservation", "StockFact", "PreparationAllocation", "DeliveryAssignment"],
    legacyMeasureTables: ["Mov_Stock1", "C_Mercaderia", "D_Catalogo_Mercaderia"],
    dateRoles: ["HistoricalStockObservation.observedDate", "StockFact.occurredAt", "InventoryLot.receivedAt"],
    dimensions: ["SKU", "lot", "location", "custodian", "unit", "event kind"],
    inclusionRules: [
      "Preparation reduces StockBalance at weigh-out; count the still-held remainder from PreparationAllocation separately.",
      "Physical club stock is valid StockBalance quantity plus preparation/delivery custody; reserved quantity is already inside StockBalance and is not added again.",
      "For custody use actualQuantity - deliveredQuantity - (returnedQuantity - returnedDeliveredQuantity); show dispatched custody under the assigned driver or unresolved when no driver is recorded.",
      "Use source StockBalance.locationId for custody; the current route location is not modeled and is not inferred.",
      "Do not infer signs from positive legacy quantities; use the typed operation event contract.",
      "Historical delivery observations remain separate from operational stock and are not combined without a verified location mapping.",
    ],
    output: [
      { name: "balanceOnHandByUnit", kind: "decimal-string", nullable: true, currency: "not-monetary", meaning: "StockBalance quantities by explicit unit, including reserved quantities." },
      { name: "reservedByUnit", kind: "decimal-string", nullable: true, currency: "not-monetary", meaning: "Reservations already included in balanceOnHandByUnit." },
      { name: "availableByUnit", kind: "decimal-string", nullable: true, currency: "not-monetary", meaning: "Balance quantity less its reservation, by explicit unit." },
      { name: "preparationDeliveryCustodyByLotLocationCustodian", kind: "evidence", nullable: true, currency: "not-monetary", meaning: "Remaining allocation quantity grouped by lot, source balance location, custodian basis, and preparation or delivery stage." },
      { name: "physicalClubStockByUnit", kind: "decimal-string", nullable: true, currency: "not-monetary", meaning: "Valid balance quantity plus separately held preparation/delivery custody; reservations are not added twice." },
      { name: "physicalCustodyFormula", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "actualQuantity - deliveredQuantity - (returnedQuantity - returnedDeliveredQuantity)." },
      { name: "custodyState", kind: "state", nullable: false, currency: "not-monetary", meaning: "Unknown with no allocations, partial with malformed/unresolved custody, otherwise observed and unattested." },
      { name: "stockMovementEventsByKindAndUnit", kind: "evidence", nullable: true, currency: "not-monetary", meaning: "Waste remains positive; count adjustments remain signed; transfers are internal flow; unrecognized kinds keep raw quantities." },
      { name: "stockMovementEvents", kind: "evidence", nullable: true, currency: "not-monetary", meaning: "Dated stock facts are included only when every non-null endpoint is within each restricted location and custodian set; empty restricted sets match none." },
      { name: "stockValuationByCostCurrencyMinor", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Valid balance valuation grouped by each lot's recorded cost currency." },
      { name: "balanceRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact scoped StockBalance population count." },
      { name: "visibleBalanceRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "At most 10,000 balance-detail rows; the aggregate quantities and valuation use the full scoped population." },
      { name: "balanceRowsState", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether the visible balance-detail rows cover the full source population." },
      { name: "visibleCustodyRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "At most 10,000 custody-detail rows." },
      { name: "custodyRowsState", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether the visible custody details cover all qualifying allocations and dispatches." },
      { name: "stockMovementEventRowsVisible", kind: "count", nullable: false, currency: "not-monetary", meaning: "At most 10,000 dated stock-fact detail rows." },
      { name: "stockMovementEventRowsState", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether the visible stock-fact details cover the full filtered population." },
      { name: "stockMovementEventCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact full-population dated stock-fact count." },
      { name: "historicalObservations", kind: "evidence", nullable: true, currency: "not-monetary", meaning: "Legacy physical observations and stockouts remain a distinct source." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Stock quantities are exact decimals grouped by explicit unit. Any valuation is grouped by each lot's cost currency.",
    coveragePolicy: "SQL balance, valuation, and dated movement aggregates cover the full authorized scope. A stock fact in a restricted location or custodian dimension is included only when at least one endpoint is in scope and every non-null endpoint is in scope. Detail arrays are limited to 10,000 rows and expose visible counts/state; custody-derived totals are null when allocations or dispatch assignments are incomplete. Invalid units/quantities or unresolved dispatched drivers make the affected source partial. A complete stock report still requires a dated physical count and reconciled event coverage for the same location/unit scope.",
    sensitivity: "aggregate-internal",
    requiredCapability: "stock.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "cash-ledger",
    title: "Caja, cuentas y conciliación",
    purpose: "Report signed ledger legs by account, currency, date, and reconciliation evidence.",
    grain: "One ledger leg per event, account, and currency.",
    historicalModels: ["HistoricalCashMovement", "HistoricalCashReconciliation", "LegacySourceRecord"],
    operationalModels: ["OperationAccount", "LedgerEvent", "LedgerLeg", "AccountReconciliation"],
    legacyMeasureTables: ["Movimiento_Nueva", "DistribucionIngresos", "DimFecha"],
    dateRoles: ["LedgerEvent.occurredAt", "AccountReconciliation.date", "HistoricalCashMovement.movementDate"],
    dimensions: ["account", "category", "event kind", "currency", "date"],
    inclusionRules: [
      "Use signed LedgerLeg amounts and keep account openings/reconciliations distinct from activity.",
      "Cash movement is not automatically income or expense for management result.",
      "Legacy Monto has no currency filter in the extracted measures; do not reproduce mixed totals.",
    ],
    output: [
      { name: "clubAccountPeriodNetMovementByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Full-population SQL sum of signed ledger legs for verified club accounts with approved openings; null if currency mismatches exist." },
      { name: "custodyAccountPeriodNetMovementByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Full-population SQL sum of signed ledger legs for verified custody accounts with approved openings; null if currency mismatches exist." },
      { name: "accounts", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Per-account details capped at 10,000 rows; active-account coverage reports any truncation while currency totals remain full-population." },
      { name: "movementAggregationState", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether full-population SQL movement totals were withheld because account/leg currencies mismatch." },
      { name: "ledgerLegRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact count of dated ledger legs in the requested scope." },
      { name: "historicalMovementByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Full-population historical movement total with unknown source currency; withheld for account-scoped reports." },
      { name: "historicalMovementCount", kind: "count", nullable: true, currency: "not-monetary", meaning: "Exact historical movement count when the report is not account scoped." },
      { name: "reconciledThrough", kind: "civil-date", nullable: true, currency: "not-monetary", meaning: "Latest evidenced counted balance date for visible account details." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Never net ARS and USD. A transfer has two same-currency legs; cross-currency exchange needs its own evidenced rate and linked legs.",
    coveragePolicy: "Currency movement totals aggregate all qualifying legs in SQL; per-account detail is limited to 10,000 active accounts and is marked partial by coverage when truncated. Reconciled balances remain available only through verified opening/reconciliation evidence plus complete dated ledger coverage.",
    sensitivity: "restricted-finance",
    requiredCapability: "finance.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "delivery-collections",
    title: "Entregas, cobros y rendiciones",
    purpose: "Track delivery fulfillment, reported collections, applied credits, and accepted renditions as separate stages.",
    grain: "One delivery assignment, collection report, or rendition; linked by explicit IDs.",
    historicalModels: ["HistoricalDeliverySale", "HistoricalDeliverySaleLine", "HistoricalCashMovement", "HistoricalCashReconciliation"],
    operationalModels: ["DeliveryAssignment", "CollectionReport", "MemberCredit", "Rendition", "LedgerEvent", "LedgerLeg"],
    legacyMeasureTables: ["C_Moto", "C_Facturacion", "Movimiento_Nueva"],
    dateRoles: ["DeliveryAssignment.deliveredAt", "CollectionReport.verifiedAt", "Rendition.acceptedAt", "LedgerEvent.occurredAt"],
    dimensions: ["delivery", "route", "currency", "collection method", "custodian", "account"],
    inclusionRules: [
      "A delivery completion flag is not a cash receipt; a reported collection is not a verified or posted ledger event.",
      "Count a rendition only after its accepted record and preserve gross, delivered, fee, and mode fields separately.",
      "Open member credit and refund obligations use amount minus resolved amount; reversed treatment is excluded even when its stored amount is non-zero.",
      "Do not infer unpaid customer balances from historical collection flags or dates.",
    ],
    output: [
      { name: "deliveryCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Distinct deliveries by lifecycle state." },
      { name: "collectionReportCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact full-population collection-report count in the date range." },
      { name: "reportedCollectionByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population reported collection amounts, before verification." },
      { name: "verifiedAppliedCollectionByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population verified collection amounts applied to orders." },
      { name: "verifiedExcessByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population verified collection excess amounts." },
      { name: "acceptedRenditionCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact full-population accepted-rendition count." },
      { name: "renditionGrossByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population accepted rendition gross amounts." },
      { name: "renditionDeliveredByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population accepted rendition delivered amounts." },
      { name: "renditionFeeByCurrency", kind: "minor-unit-string", nullable: false, currency: "per-row", meaning: "Full-population accepted rendition fees." },
      { name: "spendableOpenCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact count of valid unresolved spendable credits." },
      { name: "refundDueOpenCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact count of valid unresolved refund obligations." },
      { name: "spendableMemberCreditOpenByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Unresolved spendable member credit excluding reversed records." },
      { name: "refundDueOpenByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Unresolved refund obligations excluding reversed records." },
      { name: "reversedCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Reversed credit records excluded from spendable and refundable totals." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Partition collections, applied amounts, rendition fees, and ledger postings by currency; no conversion from an unverified exchange rate.",
    coveragePolicy: "SQL counts and monetary aggregates cover each full source population. Current credit balances are date-range independent and report invalid or unclassified rows as partial coverage.",
    sensitivity: "restricted-finance",
    requiredCapability: "collections.report",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "fx-reconciliation",
    title: "Conversiones y diferencias cambiarias",
    purpose: "Review current FX events with their recorded rate, difference, commission, and individual signed ledger legs.",
    grain: "One ForeignExchangeRecorded event and each persisted LedgerLeg, including a commission leg when recorded.",
    historicalModels: ["LegacySourceRecord", "HistoricalCashMovement"],
    operationalModels: ["OperationAccount", "LedgerEvent", "LedgerLeg"],
    legacyMeasureTables: ["C_OperacionUSD"],
    dateRoles: ["LedgerEvent.occurredAt"],
    dimensions: ["event", "account", "currency", "signed leg", "recorded rate", "recorded difference", "recorded commission"],
    inclusionRules: [
      "Read only LedgerEvent rows recorded by ForeignExchangeRecorded; preserve every signed LedgerLeg separately, including a third commission leg.",
      "Show the rate, ARS difference, and commission exactly as stored in event metadata; do not aggregate nominal amounts across events or currencies.",
      "Historical FX values are not inferred from legacy movement rows. Account-scoped viewers see only authorized legs and the event is marked incomplete for pairing.",
      "The legacy catalog records no direct DAX measures on C_OperacionUSD; its model relationships are documented separately from this report contract.",
    ],
    output: [
      { name: "conversionEventCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Observed LedgerEvent records of kind fx." },
      { name: "visibleConversionEventRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "At most 10,000 event-detail rows; conversionEventCount remains exact." },
      { name: "conversionEventRowsComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether all events in the filtered population are present in fxEvents." },
      { name: "conversionEventSummaryComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether SQL summarized metadata and all ledger legs for every event in the filtered population; independent of the visible detail limit." },
      { name: "validatedPairedConversionCount", kind: "count", nullable: true, currency: "not-monetary", meaning: "Exact count of structurally complete events from the full SQL summary; withheld only when that summary is unavailable or account scope hides other legs." },
      { name: "invalidOrIncompleteFxEventCount", kind: "count", nullable: true, currency: "not-monetary", meaning: "Exact full-population count of events with invalid metadata or missing/inconsistent legs; null only when the summary is unavailable." },
      { name: "fxEvents", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "At most 10,000 event-level details with recorded rate, ARS difference, commission, expected/observed leg count, and signed account legs; nominal amounts are not summed." },
      { name: "coverage", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Observed event and leg completeness; source-period coverage remains unattested." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Preserve every signed amount in its LedgerLeg currency. The report displays the recorded rate and event difference but never nets nominal amounts across currencies.",
    coveragePolicy: "SQL summarizes every in-scope event and leg, independently of the 10,000-row detail cap. Paired and incomplete counts are exact when the unscoped summary is available; account scope withholds other legs. Structural completeness does not attest source-period coverage.",
    sensitivity: "restricted-finance",
    requiredCapability: "finance.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "customer-segmentation",
    title: "Segmentación de compra",
    purpose: "Apply the reviewed legacy thresholds to aggregate purchase behavior without creating membership, loyalty, or eligibility decisions.",
    grain: "One pseudonymous member aggregate for a defined source and date range.",
    historicalModels: ["HistoricalMember", "HistoricalDeliverySale", "HistoricalDeliverySaleLine", "LegacyIdentity"],
    operationalModels: ["OperationOrder", "OperationOrderLine", "OperationMember", "LegacyIdentity"],
    legacyMeasureTables: ["C_Cliente", "C_Facturacion"],
    dateRoles: ["OperationOrder.confirmedAt", "HistoricalDeliverySale.saleDate"],
    dimensions: ["recency band", "ARS spend band", "distinct purchase months", "maximum grams"],
    inclusionRules: [
      "Priority order: recency of at least 105 days; ARS spend of at least 175000000 minor units; six distinct purchase months; maximum purchase greater than 20 grams; otherwise occasional when inputs are complete.",
      "Never convert USD spend into ARS for this rule without a separate dated rate policy.",
      "The result is analysis only. It never grants loyalty approval, member privileges, or permissions.",
      "Full cancellations create no purchase recency or spend. Partial cancellations and customer returns reduce retained quoted quantities and revenue; refunds are not subtracted a second time.",
      "Suppress member identifiers in aggregate reports and withhold a segment when required inputs are missing.",
    ],
    output: [
      { name: "segment", kind: "state", nullable: true, currency: "not-monetary", meaning: "Legacy analytical segment or insufficient-data state." },
      { name: "memberCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Distinct eligible pseudonymous member aggregates." },
      { name: "includedMemberCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact member population count." },
      { name: "visibleMemberRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "At most 10,000 member details used by the analytical aggregation." },
      { name: "memberRowsComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether every included member detail fits within the 10,000-row limit." },
      { name: "currentOperationOrderCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Exact order population count through the inclusive as-of date." },
      { name: "visibleOperationOrderRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "At most 10,000 order details." },
      { name: "operationOrderRowsComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether every eligible order detail fits within the 10,000-row limit." },
      { name: "segmentationSummaryComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether full-population SQL produced exact segment counts from all members, orders, and valid return data, independent of detail limits." },
      { name: "sourceRowsComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Alias for a complete, valid full-population segmentation summary; detail completeness is reported separately." },
      { name: "invalidCustomerReturnAllocationCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Invalid return allocations in the full order population; any invalid row withholds exact segment counts." },
      { name: "invalidCustomerReturnLineCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Invalid retained-quantity lines in the full order population; any invalid row withholds exact segment counts." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Only ARS purchase spend participates in the legacy threshold; USD is kept separate and not converted.",
    coveragePolicy: "Full-population SQL calculates segment counts independently of the 10,000-member and 10,000-order detail caps; the visible-row completeness flags remain false when details are truncated. Withhold segment counts only when source counts disagree or retained-order/return data is invalid. Groups below five remain suppressed. Report missing purchase history and incomplete member linkage separately.",
    sensitivity: "restricted-member-aggregate",
    requiredCapability: "reports.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "commercial-scenarios",
    title: "Precios, promociones y escenarios",
    purpose: "Show approved commercial policies and alternative 13-week cash scenarios under versioned assumptions for human review.",
    grain: "One approved versioned scenario, currency, and calendar week; commercial policy coverage remains a separate inventory.",
    historicalModels: ["HistoricalPromotion", "HistoricalDeliverySale", "HistoricalDeliverySaleLine", "LegacySourceRecord"],
    operationalModels: ["CatalogSku", "PricePolicy", "CommercialPack", "CommercialPromotion", "InventoryLot", "OperationalConfiguration", "OperationPayable", "OperationAccount"],
    legacyMeasureTables: ["D_Catalogo_Mercaderia", "Combos", "Componentes", "Descuentos", "Metas", "Migracion", "Ventas_Nuevas"],
    dateRoles: ["PricePolicy.validFrom", "CommercialPack.validFrom", "CommercialPromotion.startsOn", "DecisionReplacementQuote.quotedOn"],
    dimensions: ["SKU", "pack", "discount", "policy version", "currency", "assumption version"],
    inclusionRules: [
      "A proposal or simulation is never booked as a sale, collection, or actual result.",
      "Project explicitly approved cash flows by currency over 13 calendar weeks. Alternative scenarios are compared, never summed as additional obligations.",
      "A reconciled opening is required for projected closing balances. When it is missing, show dated known flows and keep the closing balance unknown.",
      "Cash projections do not claim product margin, price-policy equivalence, or promotion causality. Pack margin previews are separate local simulations with explicit price, physical quantity, and cost inputs.",
      "Historical comparisons do not establish promotion causality; any commercial action remains subject to human approval.",
    ],
    output: [
      { name: "scenarioCalculations", kind: "evidence", nullable: true, currency: "per-row", meaning: "Approved scenario projections, 13-week horizon, per-week flows, opening/closing coverage and configuration version; unavailable when no valid approved scenario exists or approved configurations exceed the 10,000-row limit." },
      { name: "fixedCosts", kind: "evidence", nullable: true, currency: "not-monetary", meaning: "Approved private monthly schedule; missing configuration leaves period costs unknown." },
      { name: "assumptionVersion", kind: "state", nullable: false, currency: "not-monetary", meaning: "Version and approval state of the scenario inputs." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "One currency per scenario; baseline and proposal must use the same currency and cost basis.",
    coveragePolicy: "Missing prices, costs, unit conversions, or periods make the dependent scenario unavailable, not zero.",
    sensitivity: "restricted-finance",
    requiredCapability: "prices.propose",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
  {
    id: "obligations-13-weeks",
    title: "Obligaciones próximas de 13 semanas",
    purpose: "Summarize unique verified payables and dated cash-plan events in Monday–Sunday calendar weeks while retaining account openings and source coverage.",
    grain: "One obligation ID or one active cash-plan event, bucketed into one calendar week.",
    historicalModels: ["HistoricalCashMovement", "HistoricalCashReconciliation", "LegacySourceRecord"],
    operationalModels: ["OperationPayable", "PayablePayment", "OperationAccount", "AccountReconciliation", "DecisionCashSnapshot", "DecisionCashSnapshotAccount", "DecisionCashPlanEvent", "DecisionInputAttestation"],
    legacyMeasureTables: ["Movimiento_Nueva", "C_Mercaderia", "C_gastos_operacion"],
    dateRoles: ["OperationPayable.dueDate", "PayablePayment.date", "DecisionCashPlanEvent.date", "AccountReconciliation.date"],
    dimensions: ["scenario", "account", "currency", "obligation kind", "verification state", "calendar week"],
    inclusionRules: [
      "Require a reconciled opening balance for each included account and a continuous 13-week attestation for the scenario.",
      "Deduplicate obligations by stable ID; identical replays count once and a conflicting ID is an exception.",
      "Use amountMinor minus paidMinor for open payables and do not count a payable payment again as a new obligation.",
      "Show verified and unverified obligations separately; an incomplete source cannot certify a closing balance.",
    ],
    output: [
      { name: "openingByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Reconciled opening balance by account currency." },
      { name: "obligationsByCurrency", kind: "minor-unit-string", nullable: true, currency: "per-row", meaning: "Unique remaining obligations by due week and currency." },
      { name: "obligationCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Unique open obligation IDs in the week." },
      { name: "weekly", kind: "evidence", nullable: true, currency: "not-monetary", meaning: "Exact 13-week SQL aggregates for the full payable population when all source rows and summary counts validate; otherwise null, regardless of detail truncation." },
      { name: "payableSummaryComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether SQL summarized and validated every payable in the 13-week horizon." },
      { name: "invalidPayableDateCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Selected horizon payables with invalid ISO due dates." },
      { name: "invalidPayableCurrencyCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Selected horizon payables with currencies outside ARS and USD." },
      { name: "invalidPayableAmountCount", kind: "count", nullable: false, currency: "not-monetary", meaning: "Selected horizon payables with negative amounts or paid amounts outside zero through total." },
      { name: "payableRowsComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether all payable identity details fit within the 10,000-row detail limit; independent of the weekly SQL summary." },
      { name: "visiblePayableRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "At most 10,000 obligation-detail rows." },
      { name: "activeAccountRowsComplete", kind: "state", nullable: false, currency: "not-monetary", meaning: "Whether all active account details fit within the 10,000-row limit." },
      { name: "visibleActiveAccountRows", kind: "count", nullable: false, currency: "not-monetary", meaning: "At most 10,000 active-account details." },
      { name: "verifiedObligationsByIdentity", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Verified obligation details, subject to the visible 10,000-row limit and source coverage." },
      { name: "pendingObligationsByIdentity", kind: "evidence", nullable: false, currency: "not-monetary", meaning: "Unverified obligation details, subject to the visible 10,000-row limit and source coverage." },
      { name: "weekStart", kind: "civil-date", nullable: false, currency: "not-monetary", meaning: "Monday of the calendar week." },
      { name: "weekEnd", kind: "civil-date", nullable: false, currency: "not-monetary", meaning: "Sunday of the calendar week." },
      commonCoverage,
      evidenceState,
    ],
    currencyPolicy: "Produce a separate 13-week path for each currency/account. Never convert or net ARS and USD.",
    coveragePolicy: "Weekly SQL aggregates cover every payable in the horizon and remain exact when identity details exceed 10,000 rows; invalid source values or a population-count mismatch make weekly null. Scenario projections that require complete payable identities remain unavailable when detail rows truncate. Account and obligation detail caps are explicit in visibility fields and coverage. A forecast is certified only with a reconciled opening, all unique dated obligations, and complete continuous coverage for the full horizon.",
    sensitivity: "restricted-finance",
    requiredCapability: "finance.read",
    version: { historical: "pbix-2026-09-30", operational: "operations-v1", queryState: "operations-v1-query-implemented-unverified" },
  },
] as const satisfies readonly ReportAreaDefinition[];

export function getReportDefinition(id: ReportAreaId): ReportAreaDefinition {
  const definition = reportDefinitions.find(candidate => candidate.id === id);
  if (!definition) throw new Error(`Unknown report area: ${id}`);
  return definition;
}

const reportParamsSchema = z.strictObject({
  area: z.enum(reportAreaIds).optional(),
  fromDate: z.iso.date().optional(),
  throughDate: z.iso.date().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export function parseReportParams(value: unknown, requireArea = true): { area?: ReportAreaId; from?: string; to?: string } {
  const parsed = reportParamsSchema.safeParse(value);
  if (!parsed.success) {
    throw new OperationError(400, "INVALID_REPORT_QUERY", "Indicá fechas civiles válidas en orden inclusivo");
  }
  const { area, fromDate, throughDate, from, to } = parsed.data;
  if (requireArea && !area) throw new OperationError(400, "INVALID_REPORT_QUERY", "Indicá un área de reporte");
  if ((fromDate && from && fromDate !== from) || (throughDate && to && throughDate !== to)) {
    throw new OperationError(400, "INVALID_REPORT_QUERY", "No combines nombres alternativos para la misma fecha");
  }
  const start = fromDate ?? from;
  const end = throughDate ?? to;
  if (start && end && start > end) {
    throw new OperationError(400, "INVALID_REPORT_QUERY", "El inicio debe ser anterior o igual al fin del período");
  }
  return { ...(area ? { area } : {}), ...(start ? { from: start } : {}), ...(end ? { to: end } : {}) };
}

function definitionAllowed(definition: ReportAreaDefinition, granted: readonly Capability[], scope: Awaited<ReturnType<typeof objectScope>>): boolean {
  if (!granted.includes("reports.read") || !granted.includes(definition.requiredCapability) || !supportsReportScope(definition.id, scope)) return false;
  if (definition.id === "customer-segmentation" && !granted.includes("members.read")) return false;
  return true;
}

async function authorizeReport(req: Express.Request, area: ReportAreaId) {
  await requireCapability(db, req.user, "reports.read");
  const definition = getReportDefinition(area);
  await requireCapability(db, req.user, definition.requiredCapability);
  if (area === "customer-segmentation") await requireCapability(db, req.user, "members.read");
  const scope = await objectScope(db, req.user);
  validateReportScope(scope);
  if (!supportsReportScope(area, scope)) {
    throw new OperationError(403, "REPORT_SCOPE_UNSUPPORTED", "Este reporte no puede aplicar todos los alcances asignados a sus fuentes");
  }
  return { definition, scope };
}

export const operationsReports = Router();
operationsReports.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store");
  next();
});

operationsReports.get("/areas", async (req, res) => {
  await requireCapability(db, req.user, "reports.read");
  const scope = await objectScope(db, req.user);
  validateReportScope(scope);
  const granted = await capabilities(db, req.user);
  const items = reportDefinitions.filter(definition => definitionAllowed(definition, granted, scope));
  res.json(wire({ areas: items }));
});

operationsReports.get("/metrics", async (req, res) => {
  await requireCapability(db, req.user, "reports.read");
  const scope = await objectScope(db, req.user);
  validateReportScope(scope);
  const granted = await capabilities(db, req.user);
  const items = reportDefinitions.filter(definition => definitionAllowed(definition, granted, scope)).map(definition => ({
    id: definition.id,
    title: definition.title,
    grain: definition.grain,
    dimensions: definition.dimensions,
    output: definition.output,
    currencyPolicy: definition.currencyPolicy,
    coveragePolicy: definition.coveragePolicy,
    queryState: definition.version.queryState,
  }));
  res.json(wire({ metrics: items }));
});

operationsReports.get("/metrics/:area", async (req, res) => {
  const area = z.enum(reportAreaIds).safeParse(req.params.area);
  if (!area.success) throw new OperationError(404, "REPORT_AREA_NOT_FOUND", "Área de reporte desconocida");
  const params = parseReportParams(req.query, false);
  const { definition, scope } = await authorizeReport(req, area.data);
  const summary = await queryOperationsReport(area.data, { from: params.from, to: params.to }, scope);
  res.json(wire({ metric: definition, summary }));
});

operationsReports.get("/summary", async (req, res) => {
  const params = parseReportParams(req.query);
  const area = params.area!;
  const { definition, scope } = await authorizeReport(req, area);
  const summary = await queryOperationsReport(area, { from: params.from, to: params.to }, scope);
  res.json(wire({ definition: { id: definition.id, title: definition.title }, summary }));
});
