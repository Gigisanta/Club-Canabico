import { z } from "zod";
import { canonicalJson } from "./exact.js";
import {
  appSheetPendingReconciliationSchema,
  APPSHEET_PENDING_MAPPING_ID,
  type AppSheetPendingDimension,
  type AppSheetPendingReconciliation,
} from "./appsheet-pending.js";

export const APPSHEET_PENDING_IMPORT_VERSION = "appsheet-pending-import/v1" as const;
export const APPSHEET_PENDING_IMPORT_SOURCE_VERSION = "appsheet-pending-import-source/1.0.0" as const;
export const APPSHEET_PENDING_DIMENSIONS = ["preSale", "receivable", "unpaidPurchase", "delivery"] as const;
export const APPSHEET_PENDING_DELIVERY_CARDINALITY_REVIEW_REASON = "multiple_related_c_motos_for_same_order_requires_review" as const;
export type AppSheetPendingImportDimension = (typeof APPSHEET_PENDING_DIMENSIONS)[number];
export type AppSheetPendingDispositionState = "blocked" | "closed" | "not_applicable" | "materialized";

/** Import bindings have their own version/hash; the history reconciliation contract stays immutable. */
export const APPSHEET_PENDING_IMPORT_SOURCE_SPEC = {
  version: APPSHEET_PENDING_IMPORT_SOURCE_VERSION,
  preSale: {
    table: "Pre_Venta",
    key: "Id_Preventa",
    customerRef: { field: "fw_Cliente", table: "C_Cliente", key: "Id_Cliente" },
    date: "Pre_Fechaventa",
    status: "Estado_Preventa",
    segment: "Segmento_Compra",
    headerQuantity: "Pre_Gramos",
    subtotal: "Subtotal_Venta",
    total: "Total_Facturado",
    invoiceRef: "Id_facturado",
    currency: null,
    detail: {
      table: "Pre_Detalle_Fact",
      key: "Id_Pre_Detalle",
      parentRef: { field: "Id_Pre_Venta", table: "Pre_Venta", key: "Id_Preventa" },
      skuRef: { field: "Pre_Artículo", table: "C_Mercaderia", key: "ID_Mercaderia" },
      quantity: "Pre_Cantidad_Gr",
      unitPrice: "Pre_Precio_gramo_línea",
      lineTotal: "Pre_Valor_Total",
    },
    policy: { headerQuantityIsNotLineQuantity: true, currencyMustBeSeparatelyProven: true, draftOnly: true },
  },
  delivery: {
    table: "C_Moto",
    key: "Id_Moto",
    invoiceRef: { field: "N_Factura", tableId: "e10137", table: "C_Facturacion", key: "N_factura" },
    completion: "Entrega_completada",
    address: {
      sourceTable: "C_Facturacion",
      sourceField: "Domicilio",
      sourceFieldId: "e8872",
      sourceFieldType: "Text",
      sourceFieldVirtual: false,
      derivedFormFields: [
        { field: "Moto_Cliente_Destino", fieldId: "e10663", fieldKind: "virtual" },
        { field: "Direccion_Entrega", fieldId: "e10773", fieldKind: "virtual" },
        { field: "Moto_Domicilio_Entrega", fieldId: "e10839", fieldKind: "virtual" },
      ],
    },
    policy: { pendingAssignmentOnly: true, noDispatchOrDeliveryConfirmation: true, neverUseCurrentMemberAddress: true },
  },
  unpaidPurchase: {
    table: "C_Mercaderia",
    paidAmount: "Precio_Total_Abonado",
    dueAmount: null,
    currency: null,
    policy: { blockUntilGrossDueAndCurrencyAreSourceProven: true },
  },
} as const;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nonempty = z.string().trim().min(1).max(200);

export const appSheetPendingImportSourceSchema = z.strictObject({
  sourceRecordId: nonempty,
  sourceTable: nonempty,
  sourceRow: z.number().int().positive().max(100_000),
  sourceKeyHash: hashSchema,
  sourceRecordHash: hashSchema,
  reconciliationHash: hashSchema,
  reconciliation: appSheetPendingReconciliationSchema,
});

/** A cell reference is useful only when the caller reopens the captured source row and checks it. */
export const appSheetPendingImportSourceCellSchema = z.strictObject({
  sourceRecordId: nonempty,
  sourceRecordHash: hashSchema,
  coordinate: z.string().trim().min(1).max(20),
  header: nonempty,
  valueHash: hashSchema,
});

export const appSheetPendingDeliveryResolutionSchema = z.strictObject({
  requestId: z.uuid(),
  sourceRecordId: nonempty,
  sourceRecordHash: hashSchema,
  reconciliationHash: hashSchema,
  mappingHash: hashSchema,
  sourceSpecHash: hashSchema,
  invoiceRecordId: nonempty,
  invoiceRecordHash: hashSchema,
  motoKeyCell: appSheetPendingImportSourceCellSchema,
  invoiceReferenceCell: appSheetPendingImportSourceCellSchema,
  invoiceKeyCell: appSheetPendingImportSourceCellSchema,
  invoiceAddressCell: appSheetPendingImportSourceCellSchema,
  operationOrderId: nonempty,
  operationOrderVersion: z.number().int().nonnegative(),
  operationOrderHash: hashSchema,
  approvedBy: nonempty,
  evidenceHash: hashSchema,
  evidence: z.string().trim().min(3).max(1000),
});

export const appSheetPendingImportDispositionSchema = z.strictObject({
  sourceRecordId: nonempty,
  sourceTable: nonempty,
  sourceRow: z.number().int().positive().max(100_000),
  sourceRecordHash: hashSchema,
  reconciliationHash: hashSchema,
  mappingHash: hashSchema,
  dimension: z.enum(APPSHEET_PENDING_DIMENSIONS),
  sourceStatus: z.enum(["confirmed_pending", "not_pending", "needs_review", "not_applicable"]),
  state: z.enum(["blocked", "closed", "not_applicable", "materialized"]),
  reason: z.string().min(1).max(160).nullable(),
  destinationType: z.enum(["legacy_settlement", "delivery_assignment", "historical_draft_order"]).nullable(),
  destinationId: nonempty.nullable(),
  destinationVersion: z.number().int().positive().nullable(),
  destinationHash: hashSchema.nullable(),
});

export const appSheetPendingImportBatchSchema = z.strictObject({
  schemaVersion: z.literal(APPSHEET_PENDING_IMPORT_VERSION),
  mappingId: z.literal(APPSHEET_PENDING_MAPPING_ID),
  captureId: nonempty,
  manifestHash: hashSchema,
  dataHash: hashSchema,
  historySnapshotId: nonempty,
  historyRecordsHash: hashSchema,
  mappingHash: hashSchema,
  sourceSpecHash: hashSchema,
  sourceCoverageHash: hashSchema,
  destinationHash: hashSchema,
  destinationVersion: z.number().int().positive(),
  sourceRecordCount: z.number().int().nonnegative().max(100_000),
  dispositionCount: z.number().int().nonnegative().max(400_000),
  dispositionHash: hashSchema,
});

export const appSheetPendingImportReviewSchema = z.strictObject({
  schemaVersion: z.literal("appsheet-pending-import-review/v1"),
  reviewKind: z.enum(["independent-pending-import-plan", "independent-pending-import-destination"]),
  captureId: nonempty,
  manifestHash: hashSchema,
  dataHash: hashSchema,
  mappingHash: hashSchema,
  sourceSpecHash: hashSchema,
  sourceCoverageHash: hashSchema,
  dispositionHash: hashSchema,
  destinationHash: hashSchema,
  destinationVersion: z.number().int().positive(),
  projectionHash: hashSchema,
  target: z.enum(["isolated-test", "production"]),
  destinationIdentity: z.string().regex(/^appsheet-db-v1:[a-f0-9]{64}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  backupManifestHash: hashSchema,
  backupSnapshotAt: z.iso.datetime(),
  importer: nonempty,
  reviewer: nonempty,
  approved: z.literal(true),
  reviewedAt: z.iso.datetime(),
  findings: z.array(z.string().trim().min(1).max(500)).max(100),
});

export type AppSheetPendingImportSource = z.infer<typeof appSheetPendingImportSourceSchema>;
export type AppSheetPendingImportSourceCell = z.infer<typeof appSheetPendingImportSourceCellSchema>;
export type AppSheetPendingDeliveryResolution = z.infer<typeof appSheetPendingDeliveryResolutionSchema>;
export type AppSheetPendingImportDisposition = z.infer<typeof appSheetPendingImportDispositionSchema>;
export type AppSheetPendingImportBatch = z.infer<typeof appSheetPendingImportBatchSchema>;
export type AppSheetPendingImportReview = z.infer<typeof appSheetPendingImportReviewSchema>;

export class AppSheetPendingImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AppSheetPendingImportError";
  }
}

export type AppSheetPendingImportHash = (value: string) => string;

export function sha256Canonical(value: unknown, hash: AppSheetPendingImportHash): string {
  const output = hash(canonicalJson(value));
  if (!hashSchema.safeParse(output).success) throw new AppSheetPendingImportError("pending_import_hash_invalid");
  return output;
}

/** C_Moto.N_Factura references C_Facturacion.N_factura, not the invoice row's Id_Factura source key. */
export function appSheetDeliveryInvoiceReferenceMatches(motoInvoiceReference: string | null, invoiceNumber: string | null): boolean {
  return Boolean(motoInvoiceReference && invoiceNumber && motoInvoiceReference === invoiceNumber);
}

/** Keep every source disposition visible when more than one C_Moto resolves to the same order. */
export function appSheetPendingDeliveryCardinalityAmbiguities(
  deliveries: readonly { sourceRecordId: string; operationOrderId: string }[],
): Set<string> {
  const sourceRecordsByOrder = new Map<string, string[]>();
  for (const delivery of deliveries) {
    const sourceRecords = sourceRecordsByOrder.get(delivery.operationOrderId) ?? [];
    sourceRecords.push(delivery.sourceRecordId);
    sourceRecordsByOrder.set(delivery.operationOrderId, sourceRecords);
  }
  return new Set([...sourceRecordsByOrder.values()].filter(sourceRecords => sourceRecords.length > 1).flat());
}

/** Keep pending C_Moto dispositions blocked when their captured invoice has multiple related C_Moto rows. */
export function appSheetPendingDeliveryInvoiceCardinalityAmbiguities(
  rows: readonly { sourceRecordId: string; invoiceSourceRecordId: string | null; confirmedPending: boolean }[],
): Set<string> {
  const sourceRecordsByInvoice = new Map<string, { sourceRecordId: string; confirmedPending: boolean }[]>();
  for (const row of rows) {
    if (!row.invoiceSourceRecordId) continue;
    const sourceRecords = sourceRecordsByInvoice.get(row.invoiceSourceRecordId) ?? [];
    sourceRecords.push({ sourceRecordId: row.sourceRecordId, confirmedPending: row.confirmedPending });
    sourceRecordsByInvoice.set(row.invoiceSourceRecordId, sourceRecords);
  }
  return new Set([...sourceRecordsByInvoice.values()].filter(sourceRecords => sourceRecords.length > 1)
    .flatMap(sourceRecords => sourceRecords.filter(row => row.confirmedPending).map(row => row.sourceRecordId)));
}

function paymentReferences(dimension: AppSheetPendingDimension) {
  const byIdentity = new Map<string, { sourceTable: string; sourceRow: number; sourceKeyHash: string; sourceEvidenceHash: string }>();
  for (const relationship of dimension.relationships) {
    if (relationship.targetTable !== "Movimiento_Nueva") continue;
    for (const reference of [...(relationship.target ? [relationship.target] : []), ...(relationship.targets ?? [])]) {
      const key = canonicalJson([reference.sourceTable, reference.sourceRow]);
      const previous = byIdentity.get(key);
      if (previous && canonicalJson(previous) !== canonicalJson(reference))
        throw new AppSheetPendingImportError("pending_payment_reference_conflict");
      byIdentity.set(key, reference);
    }
  }
  return [...byIdentity.values()].sort((left, right) => left.sourceRow - right.sourceRow || left.sourceTable.localeCompare(right.sourceTable));
}

export function validatedLegacySettlement(
  reconciliation: AppSheetPendingReconciliation,
  hash: AppSheetPendingImportHash,
): { currency: string; dueMinor: bigint; legacyPaidMinor: bigint; remainingMinor: bigint; paymentReferences: ReturnType<typeof paymentReferences> } {
  const classification = reconciliation.dimensions.receivable;
  if (classification.status !== "confirmed_pending" || !classification.settlement)
    throw new AppSheetPendingImportError("pending_receivable_not_confirmed");
  const settlement = classification.settlement;
  const references = paymentReferences(classification);
  if (sha256Canonical(references, hash) !== settlement.paymentRowsHash)
    throw new AppSheetPendingImportError("pending_payment_rows_hash_mismatch");
  const dueMinor = BigInt(settlement.dueMinorUnits);
  const legacyPaidMinor = BigInt(settlement.paidMinorUnits);
  const remainingMinor = BigInt(settlement.remainingMinorUnits);
  if (dueMinor <= 0n || legacyPaidMinor < 0n || remainingMinor <= 0n || dueMinor - legacyPaidMinor !== remainingMinor)
    throw new AppSheetPendingImportError("pending_receivable_amounts_inconsistent");
  return { currency: settlement.currency, dueMinor, legacyPaidMinor, remainingMinor, paymentReferences: references };
}

export function deriveAppSheetPendingImportDispositions(
  sources: readonly AppSheetPendingImportSource[],
  hash: AppSheetPendingImportHash,
): AppSheetPendingImportDisposition[] {
  const rows = new Set<string>();
  const capture: AppSheetPendingImportSource["reconciliation"]["capture"] | null = sources[0]?.reconciliation.capture ?? null;
  const mappingHash = sources[0]?.reconciliation.mappingHash ?? null;
  for (const source of sources) {
    const parsed = appSheetPendingImportSourceSchema.safeParse(source);
    if (!parsed.success) throw new AppSheetPendingImportError("pending_import_source_invalid");
    const reconciliation = parsed.data.reconciliation;
    if (reconciliation.source.sourceEvidenceHash !== source.reconciliation.source.sourceEvidenceHash ||
        reconciliation.source.sourceKeyHash !== source.reconciliation.source.sourceKeyHash ||
        source.sourceTable !== reconciliation.source.sourceTable || source.sourceRow !== reconciliation.source.sourceRow)
      throw new AppSheetPendingImportError("pending_import_source_binding_mismatch");
    if (capture && canonicalJson(capture) !== canonicalJson(reconciliation.capture))
      throw new AppSheetPendingImportError("pending_import_capture_mismatch");
    if (mappingHash && mappingHash !== reconciliation.mappingHash)
      throw new AppSheetPendingImportError("pending_import_mapping_mismatch");
    const identity = `${source.sourceRecordId}\0${source.sourceTable}\0${source.sourceRow}`;
    if (rows.has(identity)) throw new AppSheetPendingImportError("pending_import_source_duplicated");
    rows.add(identity);
  }

  return sources.flatMap(source => APPSHEET_PENDING_DIMENSIONS.map(dimensionName => {
    const dimension = source.reconciliation.dimensions[dimensionName];
    let state: AppSheetPendingDispositionState;
    let reason: string | null = null;
    let destinationType: "legacy_settlement" | null = null;
    switch (dimension.status) {
      case "not_applicable": state = "not_applicable"; break;
      case "not_pending": state = "closed"; break;
      case "needs_review": state = "blocked"; reason = dimension.reasonCodes.join(",") || "source_requires_review"; break;
      case "confirmed_pending":
        if (dimensionName === "receivable" && dimension.settlement) {
          // Creation still requires an independently reviewed exact invoice-to-order identity.
          state = "blocked";
          reason = "reviewed_order_mapping_missing";
          destinationType = "legacy_settlement";
        } else {
          state = "blocked";
          reason = dimensionName === "unpaidPurchase" ? "purchase_due_and_currency_unproven" :
            dimensionName === "delivery" ? "delivery_address_and_dispatch_authority_unproven" :
              dimensionName === "preSale" ? "presale_lines_and_customer_mapping_unproven" : "receivable_settlement_unproven";
        }
        break;
    }
    const reconciliationHash = sha256Canonical(source.reconciliation, hash);
    return appSheetPendingImportDispositionSchema.parse({
      sourceRecordId: source.sourceRecordId,
      sourceTable: source.sourceTable,
      sourceRow: source.sourceRow,
      sourceRecordHash: source.sourceRecordHash,
      reconciliationHash,
      mappingHash: source.reconciliation.mappingHash,
      dimension: dimensionName,
      sourceStatus: dimension.status,
      state,
      reason,
      destinationType,
      destinationId: null,
      destinationVersion: null,
      destinationHash: null,
    });
  }));
}

export function assertAppSheetPendingImportReview(input: {
  review: unknown;
  reviewKind: AppSheetPendingImportReview["reviewKind"];
  expected: Omit<AppSheetPendingImportReview, "schemaVersion" | "reviewKind" | "importer" | "reviewer" | "approved" | "reviewedAt" | "findings">;
  importerId: string;
  reviewerId?: string;
}): AppSheetPendingImportReview {
  const parsed = appSheetPendingImportReviewSchema.safeParse(input.review);
  if (!parsed.success) throw new AppSheetPendingImportError("pending_review_invalid");
  const review = parsed.data;
  if (review.reviewKind !== input.reviewKind || review.importer !== input.importerId || (input.reviewerId && review.reviewer !== input.reviewerId) ||
      review.importer.trim().toLowerCase() === review.reviewer.trim().toLowerCase())
    throw new AppSheetPendingImportError("independent_pending_reviewer_required");
  if (review.findings.length !== 0) throw new AppSheetPendingImportError("pending_review_findings_open");
  if (Date.parse(review.reviewedAt) > Date.now() + 60_000 || Date.parse(review.backupSnapshotAt) > Date.parse(review.reviewedAt))
    throw new AppSheetPendingImportError("pending_review_time_invalid");
  for (const [key, value] of Object.entries(input.expected)) {
    if (review[key as keyof typeof review] !== value)
      throw new AppSheetPendingImportError("pending_review_binding_mismatch");
  }
  return review;
}

/** Legacy receipts reduce collectible demand but never mutate OperationOrder.verifiedMinor. */
export function appSheetLegacyAdjustedOutstanding(input: {
  totalMinor: bigint;
  bomboVerifiedMinor: bigint;
  legacyPaidMinor: bigint;
  cancelled?: boolean;
}): bigint {
  if (input.totalMinor < 0n || input.bomboVerifiedMinor < 0n || input.legacyPaidMinor < 0n)
    throw new AppSheetPendingImportError("receivable_amount_invalid");
  if (input.cancelled) return 0n;
  const outstanding = input.totalMinor - input.bomboVerifiedMinor - input.legacyPaidMinor;
  return outstanding > 0n ? outstanding : 0n;
}

/** Project visible payment status from both ledgers while keeping legacy cash out of Bombo's verified total. */
export function appSheetLegacyAdjustedFinancialState(input: {
  totalMinor: bigint;
  bomboVerifiedMinor: bigint;
  legacyPaidMinor: bigint;
  refundedMinor: bigint;
}): "unpaid" | "partially_paid" | "paid" | "refunded" | "partially_refunded" {
  if ([input.totalMinor, input.bomboVerifiedMinor, input.legacyPaidMinor, input.refundedMinor].some(value => value < 0n) ||
      input.refundedMinor > input.bomboVerifiedMinor)
    throw new AppSheetPendingImportError("receivable_amount_invalid");
  if (input.refundedMinor > 0n)
    return input.refundedMinor === input.bomboVerifiedMinor && input.legacyPaidMinor === 0n ? "refunded" : "partially_refunded";
  const paid = input.bomboVerifiedMinor + input.legacyPaidMinor;
  return paid >= input.totalMinor ? "paid" : paid > 0n ? "partially_paid" : "unpaid";
}
