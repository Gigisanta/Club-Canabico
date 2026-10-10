import { createHash } from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { OperationError, objectScope, requireCapability, requireFullLegacySourceScope, type Tx } from "./core.js";
import { reportPeriodDateBounds } from "./report-queries.js";
import { signCursor, verifyCursor } from "./signed-cursor.js";
import { stockFactScopeWhere } from "./stock-scope.js";
import { isAppSheetInvoiceTotalPending } from "../../shared/operations/appsheet.js";
import { APPSHEET_INVOICE_RULE_VERSION_V1 } from "../../shared/operations/appsheet-invoice-rules.js";

const feeds = ["sales-lines", "ledger", "stock", "history"] as const;
// These values describe persisted snapshot semantics. Do not substitute the
// current rule version: older invoices must remain readable after future bumps.
const APPSHEET_INVOICE_RULE_VERSION_V2 = "appsheet-invoice-rules/v2" as const;
type Feed = typeof feeds[number];
type Scope = Awaited<ReturnType<typeof objectScope>>;
const query = z.strictObject({ from: z.iso.date().optional(), to: z.iso.date().optional(), cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item)).digest("hex");
const csvCell = (value: unknown, exactNumber = false) => {
  const text = value === null || value === undefined ? "" : String(value);
  const trustedNumber = exactNumber && /^-?\d+(?:\.\d+)?$/.test(text);
  return `"${(!trustedNumber && /^[=+@\-\t\r]/.test(text) ? "'" : "") + text.replaceAll('"', '""')}"`;
};
const columns = ["id", "population", "kind", "occurredOn", "dateState", "currency", "currencyState", "amountMinor", "amountState", "quantity", "quantityState", "unit", "unitState", "sourceSystem", "sourceTable", "sourceKey", "sourceRow", "sourceHash", "objectId", "accountId", "skuId", "lotId", "invoiceTotalMinor", "invoiceTotalState", "invoiceSource", "invoiceTotalCalculationState", "invoiceTotalCalculationSource", "invoiceActorId", "invoiceConfirmedAt", "invoiceQuoteVersion", "invoiceSnapshotHash", "invoiceProductsTotalMinor", "invoiceMotoClientTotalMinor", "invoiceProductLineBasisMinor", "invoiceUnallocatedProductDeltaMinor", "invoiceProductPaymentMethod", "invoiceMotoPaymentMethod"];
type ExportRow = Record<string, string | number | null> & { id: string };

function authorizeScope(feed: Feed, scope: Scope) {
  const supported: Record<Feed, Array<keyof Scope>> = { "sales-lines": ["memberIds"], ledger: ["accountIds"], stock: ["locationIds", "custodianIds"], history: [] };
  if (Object.keys(scope).some(key => !supported[feed].includes(key as keyof Scope)))
    throw new OperationError(403, "EXPORT_SCOPE_UNSUPPORTED", "Esta exportación no puede aplicar todas tus restricciones. Elegí una consulta con alcance verificado.");
}

async function page(tx: Tx, feed: Feed, range: { from?: string; to?: string }, scope: Scope, cursor: string | undefined, limit: number) {
  const date = reportPeriodDateBounds(range);
  if (feed === "sales-lines") {
    const where: Prisma.OperationOrderLineWhereInput = { order: { commercialState: "confirmed", confirmedAt: { not: null, ...date }, ...(scope.memberIds ? { memberId: { in: scope.memberIds } } : {}) } };
    const count = await tx.operationOrderLine.count({ where });
    const last = await tx.commandReceipt.findFirst({ orderBy: [{ committedAt: "desc" }, { requestId: "desc" }], select: { requestId: true } });
    const items = await tx.operationOrderLine.findMany({ where: { AND: [where, ...(cursor ? [{ id: { gt: cursor } }] : [])] }, orderBy: { id: "asc" }, take: limit + 1, select: { id: true, orderId: true, skuId: true, revenueMinor: true, requested: true, unit: true, order: { select: { id: true, currency: true, totalMinor: true, confirmedAt: true, quote: true } } } });
    const orderIds = [...new Set(items.map(row => row.orderId))];
    const orderLineTotals = orderIds.length ? await tx.operationOrderLine.groupBy({
      by: ["orderId"], where: { orderId: { in: orderIds } },
      _min: { id: true }, _sum: { revenueMinor: true },
    }) : [];
    const firstLineByOrder = new Map(orderLineTotals.map(row => [row.orderId, row._min.id]));
    const lineBasisByOrder = new Map(orderLineTotals.map(row => [row.orderId, row._sum.revenueMinor ?? 0n]));
    return { marker: { count, last: last?.requestId }, items: items.map(row => {
      const quote = row.order.quote && typeof row.order.quote === "object" && !Array.isArray(row.order.quote)
        ? row.order.quote as Record<string, unknown> : {};
      const resolution = quote.financialResolution && typeof quote.financialResolution === "object" && !Array.isArray(quote.financialResolution)
        ? quote.financialResolution as Record<string, unknown> : {};
      const components = quote.paymentComponents && typeof quote.paymentComponents === "object" && !Array.isArray(quote.paymentComponents)
        ? quote.paymentComponents as Record<string, unknown> : {};
      const productComponent = components.products && typeof components.products === "object" && !Array.isArray(components.products)
        ? components.products as Record<string, unknown> : {};
      const motoComponent = components.moto && typeof components.moto === "object" && !Array.isArray(components.moto)
        ? components.moto as Record<string, unknown> : {};
      const appSheet = quote.source === "appsheet-invoice";
      const pending = isAppSheetInvoiceTotalPending(quote);
      const calculationState = typeof quote.totalCalculationState === "string" ? quote.totalCalculationState : "unknown";
      const formulaEvidence = quote.appSheetFormula && typeof quote.appSheetFormula === "object" && !Array.isArray(quote.appSheetFormula)
        ? quote.appSheetFormula as Record<string, unknown> : {};
      const quoteTotal = typeof quote.totalMinor === "string" && /^(0|[1-9][0-9]*)$/.test(quote.totalMinor)
        ? quote.totalMinor : null;
      const totalConsistent = quoteTotal !== null && BigInt(quoteTotal) === row.order.totalMinor;
      const invoiceTotalKnown = !appSheet || ((calculationState === "defined" || calculationState === "staff_confirmed") && totalConsistent);
      const staffConfirmed = appSheet && calculationState === "staff_confirmed";
      // Persisted v1 stores Moto's total; persisted v2 stores its calculated
      // subtotal. Historical snapshots without a ruleVersion predate versioned
      // formulas and stored the amount as clientTotalMinor; explicit unknown
      // markers remain unsafe to interpret.
      const motoUsesV1Total = appSheet && formulaEvidence.ruleVersion === APPSHEET_INVOICE_RULE_VERSION_V1;
      const motoUsesV2Subtotal = appSheet && formulaEvidence.ruleVersion === APPSHEET_INVOICE_RULE_VERSION_V2;
      const motoUsesVersionlessStoredTotal = appSheet && !Object.hasOwn(formulaEvidence, "ruleVersion");
      const calculatedMotoV2 = motoUsesV2Subtotal && calculationState === "defined";
      const firstLine = firstLineByOrder.get(row.orderId) === row.id;
      const productTotal = staffConfirmed && typeof resolution.productsTotalMinor === "string"
        ? resolution.productsTotalMinor : staffConfirmed ? null : typeof productComponent.totalMinor === "string" ? productComponent.totalMinor : null;
      const motoTotal = staffConfirmed && typeof resolution.motoClientTotalMinor === "string"
        ? resolution.motoClientTotalMinor : staffConfirmed ? null
          : appSheet
            ? motoUsesV1Total || motoUsesVersionlessStoredTotal
              ? typeof motoComponent.clientTotalMinor === "string" ? motoComponent.clientTotalMinor : null
              : motoUsesV2Subtotal && calculatedMotoV2 && typeof motoComponent.clientSubtotalMinor === "string" ? motoComponent.clientSubtotalMinor : null
            : typeof motoComponent.clientTotalMinor === "string" ? motoComponent.clientTotalMinor : null;
      const lineBasis = lineBasisByOrder.get(row.orderId)?.toString() ?? "0";
      const validProductTotal = productTotal !== null && /^(0|[1-9][0-9]*)$/.test(productTotal);
      const productDelta = staffConfirmed && validProductTotal ? (BigInt(productTotal) - BigInt(lineBasis)).toString() : null;
      const fields = firstLine ? {
        invoiceTotalMinor: invoiceTotalKnown ? row.order.totalMinor.toString() : null,
        invoiceTotalState: invoiceTotalKnown ? "known" : pending ? "captured-invoice-total-pending" : "unknown",
        invoiceSource: appSheet ? "appsheet-invoice" : "operation-order",
        invoiceTotalCalculationState: calculationState,
        invoiceTotalCalculationSource: typeof quote.totalCalculationSource === "string" ? quote.totalCalculationSource : null,
        invoiceActorId: staffConfirmed && typeof resolution.actorId === "string" ? resolution.actorId : null,
        invoiceConfirmedAt: staffConfirmed && typeof resolution.confirmedAt === "string" ? resolution.confirmedAt : null,
        invoiceQuoteVersion: staffConfirmed && typeof resolution.quoteVersion === "number" ? resolution.quoteVersion : null,
        invoiceSnapshotHash: staffConfirmed && typeof resolution.snapshotHash === "string" ? resolution.snapshotHash : null,
        invoiceProductsTotalMinor: validProductTotal ? productTotal : null,
        invoiceMotoClientTotalMinor: motoTotal !== null && /^(0|[1-9][0-9]*)$/.test(motoTotal) ? motoTotal : null,
        invoiceProductLineBasisMinor: staffConfirmed ? lineBasis : null,
        invoiceUnallocatedProductDeltaMinor: productDelta,
        invoiceProductPaymentMethod: typeof productComponent.paymentMethod === "string" ? productComponent.paymentMethod : null,
        invoiceMotoPaymentMethod: typeof motoComponent.paymentMethod === "string" ? motoComponent.paymentMethod : null,
      } : {};
      return {
        id: row.id, population: "operations", kind: pending ? "captured-product-line" : "sale-line",
        occurredOn: row.order.confirmedAt?.toISOString() ?? null, dateState: row.order.confirmedAt ? "known" : "absent",
        currency: row.order.currency, currencyState: "known", amountMinor: row.revenueMinor.toString(),
        amountState: pending ? "captured-invoice-total-pending" : "known", quantity: row.requested.toString(),
        quantityState: "known", unit: row.unit, unitState: "known", sourceSystem: appSheet ? "appsheet-invoice" : "operation-order",
        sourceTable: "OperationOrderLine", sourceKey: row.id, objectId: row.order.id, skuId: row.skuId,
        ...fields,
      } as ExportRow;
    }) };
  }
  if (feed === "ledger") {
    const where: Prisma.LedgerLegWhereInput = { ...(scope.accountIds ? { accountId: { in: scope.accountIds } } : {}), event: { occurredAt: date } };
    const count = await tx.ledgerLeg.count({ where });
    const items = await tx.ledgerLeg.findMany({ where: { AND: [where, ...(cursor ? [{ id: { gt: cursor } }] : [])] }, orderBy: { id: "asc" }, take: limit + 1, select: { id: true, accountId: true, currency: true, amountMinor: true, event: { select: { kind: true, occurredAt: true, sourceObjectId: true } } } });
    return { marker: { count }, items: items.map(row => ({ id: row.id, population: "operations", kind: row.event.kind, occurredOn: row.event.occurredAt.toISOString(), dateState: "known", currency: row.currency, currencyState: "known", amountMinor: row.amountMinor.toString(), amountState: "known", quantityState: "not-applicable", unitState: "not-applicable", accountId: row.accountId, objectId: row.event.sourceObjectId } as ExportRow)) };
  }
  if (feed === "stock") {
    const where: Prisma.StockFactWhereInput = { occurredAt: date, ...stockFactScopeWhere(scope) };
    const count = await tx.stockFact.count({ where });
    const items = await tx.stockFact.findMany({ where: { AND: [where, ...(cursor ? [{ id: { gt: cursor } }] : [])] }, orderBy: { id: "asc" }, take: limit + 1, select: { id: true, kind: true, occurredAt: true, currency: true, costMinor: true, quantity: true, unit: true, lotId: true, orderId: true } });
    return { marker: { count }, items: items.map(row => ({ id: row.id, population: "operations", kind: row.kind, occurredOn: row.occurredAt.toISOString(), dateState: "known", currency: row.currency, currencyState: row.currency ? "known" : "absent", amountMinor: row.costMinor?.toString() ?? null, amountState: row.costMinor === null ? "absent" : "known", quantity: row.quantity.toString(), quantityState: "known", unit: row.unit, unitState: "known", objectId: row.orderId, lotId: row.lotId } as ExportRow)) };
  }
  const publications = await tx.legacyHistoryPublication.findMany({ orderBy: { sourceSystem: "asc" }, select: { sourceSystem: true, snapshotId: true, mappingId: true, fingerprint: true } });
  const filters = Prisma.sql`EXISTS (SELECT 1 FROM "LegacyHistoryPublication" p JOIN "LegacyImportSnapshot" s ON s.id=p."snapshotId" WHERE p."snapshotId"=f."snapshotId" AND p."mappingId"=f."mappingId" AND s.status='reviewed' AND s."reviewedBy" IS NOT NULL AND s."reviewedBy"<>s."createdBy") AND NOT EXISTS (SELECT 1 FROM "LegacyHistoricalFact" c WHERE c."correctionOf"=f.id)
    ${range.from ? Prisma.sql`AND f."occurredOn">=${range.from}` : Prisma.empty} ${range.to ? Prisma.sql`AND f."occurredOn"<=${range.to}` : Prisma.empty}`;
  const [totals] = await tx.$queryRaw<Array<{ count: bigint; last: Date | null }>>(Prisma.sql`SELECT count(*) AS count, max(f."createdAt") AS last FROM "LegacyHistoricalFact" f WHERE ${filters}`);
  const items = await tx.$queryRaw<ExportRow[]>(Prisma.sql`SELECT f.id, 'approved-history' AS population, f.kind, f."occurredOn", f."dateState", f.currency, f."currencyState", f."amountMinor"::text, f."amountState", f.quantity::text, f."quantityState", f.unit, f."unitState", p."sourceSystem", f."sourceTable", f."sourceKey", f."sourceRow", f."sourceHash" FROM "LegacyHistoricalFact" f JOIN "LegacyHistoryPublication" p ON p."snapshotId"=f."snapshotId" AND p."mappingId"=f."mappingId" WHERE ${filters} ${cursor ? Prisma.sql`AND f.id>${cursor}` : Prisma.empty} ORDER BY f.id LIMIT ${limit+1}`);
  return { marker: { count: totals!.count, last: totals!.last, publications }, items };
}

/** Each CSV block is bounded; its cursor is invalidated if the selected population changes. */
export const operationsExports = Router();
operationsExports.get("/:feed", async (req, res) => {
  const feed = z.enum(feeds).parse(req.params.feed), params = query.parse(req.query);
  if (params.from && params.to && params.from > params.to) throw new OperationError(400, "EXPORT_RANGE", "El inicio debe ser anterior o igual al final.");
  const result = await db.$transaction(async tx => {
    await requireCapability(tx, req.user, "reports.read");
    await requireCapability(tx, req.user, "finance.read");
    if (feed === "stock") await requireCapability(tx, req.user, "stock.read");
    if (feed === "history") {
      await requireCapability(tx, req.user, "imports.review");
      await requireFullLegacySourceScope(tx, req.user);
    }
    const scope = await objectScope(tx, req.user); authorizeScope(feed, scope);
    const identity = digest({ actor: req.user.id, feed, from: params.from, to: params.to, scope, queryVersion: "canonical-csv-v3" });
    let current: { id: string; fingerprint: string; identity: string } | undefined;
    if (params.cursor) {
      try { current = z.strictObject({ id: z.string().max(200), fingerprint: z.string().length(64), identity: z.string().length(64) }).parse(verifyCursor("canonical-export", params.cursor)); }
      catch { throw new OperationError(400, "EXPORT_CURSOR", "Reiniciá la exportación con sus filtros originales."); }
      if (current.identity !== identity) throw new OperationError(400, "EXPORT_CURSOR", "El cursor pertenece a otros filtros o permisos.");
    }
    const found = await page(tx, feed, params, scope, current?.id, params.limit);
    const fingerprint = digest({ identity, population: found.marker });
    if (current && current.fingerprint !== fingerprint) throw new OperationError(409, "EXPORT_POPULATION_CHANGED", "Los hechos cambiaron. Reiniciá la exportación para conservar una población consistente.");
    let count = Math.min(params.limit, found.items.length), csv = "";
    do { csv = "\uFEFF" + columns.map(key => csvCell(key)).join(",") + "\r\n" + found.items.slice(0,count).map(row => columns.map(key => csvCell(row[key], ["amountMinor", "quantity", "sourceRow", "invoiceTotalMinor", "invoiceProductsTotalMinor", "invoiceMotoClientTotalMinor", "invoiceProductLineBasisMinor", "invoiceUnallocatedProductDeltaMinor", "invoiceQuoteVersion"].includes(key))).join(",")).join("\r\n") + "\r\n"; if (Buffer.byteLength(csv, "utf8") <= 400*1024) break; count = Math.floor(count/2); } while (count);
    if (!count && found.items.length) throw new OperationError(422, "EXPORT_ROW_TOO_LARGE", "Un registro excede el tamaño permitido y requiere revisión.");
    const hasMore = found.items.length > count;
    return { csv, rows: count, nextCursor: hasMore ? signCursor("canonical-export", { id: found.items[count-1]!.id, fingerprint, identity }) : null, fingerprint, coverage: { population: feed === "history" ? "approved-selected-history" : "canonical-operations", historyAndOperationsCombined: false, queryCompleteForPage: true, totalRows: String(found.marker.count), dateUnknownIncluded: !params.from && !params.to, money: "exact-minor-unit-strings", unknownValues: "empty-with-explicit-state", unit: "per-fact", queryVersion: "canonical-csv-v3" } };
  }, { isolationLevel: "RepeatableRead", timeout: 15000 });
  res.setHeader("Cache-Control", "private, no-store"); res.json(result);
});
