import { Router } from "express";
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { db, getSettings } from "./db.js";
import { businessDate } from "../shared/domain.js";
import {
  calculateManagementPnl,
  compareNominalUsingOfficialCpi,
  forecastSevenDayAggregate,
  forecastThirteenWeekCash,
  forecastLongRangeScenarios,
  type PlannedCashCategory,
  type PlanningScenario,
} from "../shared/decision-finance.js";
import {
  calculateCommerceDecisions,
  segmentMembers,
  simulatePromotion,
  type PromotionScenario,
} from "../shared/decision-commerce.js";
import { HttpError } from "./validation.js";
import { decisionInputsSnapshot } from "./decision-inputs.js";

export const decisionAnalysis = Router();
const CENTS64_MIN = -(2n ** 63n);
const CENTS64_MAX = 2n ** 63n - 1n;
const moneyString = z.string().regex(/^-?(?:0|[1-9]\d*)$/).refine((value) => {
  try { const cents = BigInt(value); return cents >= CENTS64_MIN && cents <= CENTS64_MAX; }
  catch { return false; }
});
const unsignedMoney = moneyString.refine((value) => BigInt(value) >= 0n);
const date = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const iso = (value: Date) => value.toISOString().slice(0, 10);
const dbDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const jsonSafe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? item.toString() : item));
const supplierAliasKey = process.env.JWT_SECRET || randomBytes(32).toString("hex");
const financialAccess = (role: string) => {
  if (role !== "owner" && role !== "admin") throw new HttpError(403, "No tenés acceso a este análisis");
};

type DailyLocal = { date: string; revenue: bigint; cost: bigint; saleCount: bigint };
type DailyExpense = { date: string; amount: bigint };
type DailyDemand = { productId: string; date: string; sold: bigint };
type MemberTotal = { customerId: string; lastDate: string; purchaseCount: bigint; spent: bigint };
type LocalMarginRow = { productId: string; name: string; category: string; supplier: string; revenue: bigint; cost: bigint; quantityMilliunits: bigint; lineCount: bigint };
type ImportedAvailabilityRow = { sourceSystem: string; productSourceId: string | null; date: Date; locationSourceId: string | null; quantityUnit: string | null; quantityMilliunits: bigint | null };
type ImportedDemandRow = { sourceSystem: string; productSourceId: string | null; date: Date; quantityUnit: string; quantityMilliunits: bigint };
type DeliveryDailyRow = { date: Date; netCents: bigint };
type CountRow = { count: bigint };
type SupplierLeadTimeRow = { sourceSystem: string; supplierSourceId: string | null; orderDate: Date; receivedDate: Date };
type PlanningSnapshot = {
  mapping: null | { status: "shared" | "separate"; sharedLocationIds: string[]; localLocationIds: string[]; deliveryLocationIds: string[]; reference: string };
  rules: Array<{ productId: string; leadTimeDays: number; minimumOrderQuantityMilliunits: number; reviewPeriodDays: number; sourceReference: string }>;
  quotes: Array<{ id: string; productId: string; quotedOn: string; validUntil: string | null; unitCostCentsPerUnit: string; status: string; sourceReference: string }>;
  inbounds: Array<{ id: string; productId: string; locationId: string | null; quantityMilliunits: number; arrivalDate: string; status: string }>;
  cashSnapshots: Array<{ id: string; asOf: string; floorCents: string; complete: boolean; accounts: Array<{ account: string; amountCents: string }> }>;
  cashPlans: Array<{ id: string; scenario: string; date: string; category: string; amountCents: string; status: string }>;
  attestations: Array<{ id: string; domain: string; scenario: string | null; fromDate: string; throughDate: string; complete: boolean; sourceReference: string }>;
};
const allowedCashCategories = new Set<PlannedCashCategory>([
  "sale", "operating_expense", "stock_purchase", "local_investment", "capital_contribution",
  "owner_draw", "delivery_receipt", "other_income", "other_outflow", "adjustment",
]);

function offset(value: string, days: number) {
  const result = new Date(`${value}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

async function audit(userId: string, area: string) {
  await db.sensitiveAccessAudit.create({ data: { userId, area, action: "read" } });
}

async function sourceSnapshot() {
  const [committed, rejected, reconciled] = await Promise.all([
    db.historicalImportBatch.count({ where: { status: { in: ["imported", "reconciled"] } } }),
    db.historicalImportBatch.count({ where: { status: "rejected" } }),
    db.historicalReconciliation.count(),
  ]);
  return { committed, rejected, reconciled, state: process.env.DEMO_MODE === "true" ? "demo" : committed ? "imported" : "missing" };
}

export async function decisionAnalysisPayload(asOfDate: string) {
  const fromMonth = `${asOfDate.slice(0, 7)}-01`;
  const historyStart = offset(asOfDate, -364);
  const [products, localDaily, marginRows, expenses, demandRows, memberRows, planning, delivery, purchases, importedCash,
    importedExpenses, importedStock, importedStockouts, importedPromotions, importedMembers, importState] = await Promise.all([
    db.product.findMany({ select: {
      id: true, name: true, lot: true, supplierId: true, supplier: true, locationId: true,
      stock: true, minimum: true, cost: true, price: true, unit: true, expires: true,
      sourceSystem: true, sourceId: true,
    } }),
    db.$queryRaw<DailyLocal[]>`
      SELECT date, SUM(total)::bigint AS revenue, SUM(cost)::bigint AS cost, COUNT(*)::bigint AS "saleCount"
      FROM "Sale" WHERE channel = 'local' AND date >= ${historyStart} AND date <= ${asOfDate}
      GROUP BY date ORDER BY date`,
    db.$queryRaw<LocalMarginRow[]>`
      SELECT i."productId", MIN(i.name) AS name, p.type AS category,
        COALESCE(NULLIF(MIN(su.name), ''), NULLIF(MIN(p.supplier), ''), 'Sin proveedor') AS supplier,
        SUM(i.revenue)::bigint AS revenue, SUM(i.cost)::bigint AS cost,
        SUM(i.quantity)::bigint AS "quantityMilliunits", COUNT(*)::bigint AS "lineCount"
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      JOIN "Product" p ON p.id = i."productId"
      LEFT JOIN "Supplier" su ON su.id = p."supplierId"
      WHERE s.channel = 'local' AND s.date >= ${fromMonth} AND s.date <= ${asOfDate}
      GROUP BY i."productId", p.type ORDER BY SUM(i.revenue) DESC`,
    db.$queryRaw<DailyExpense[]>`
      SELECT date, SUM(amount)::bigint AS amount FROM "Expense"
      WHERE date >= ${fromMonth} AND date <= ${asOfDate} GROUP BY date ORDER BY date`,
    db.$queryRaw<DailyDemand[]>`
      SELECT i."productId", s.date, SUM(i.quantity)::bigint AS sold
      FROM "SaleItem" i JOIN "Sale" s ON s.id = i."saleId"
      WHERE s.channel = 'local' AND s.date >= ${historyStart} AND s.date <= ${asOfDate}
      GROUP BY i."productId", s.date`,
    db.$queryRaw<MemberTotal[]>`
      SELECT s."customerId", MAX(s.date) AS "lastDate", COUNT(*)::bigint AS "purchaseCount", SUM(s.total)::bigint AS spent
      FROM "Sale" s WHERE s.channel = 'local' AND s.date <= ${asOfDate}
      GROUP BY s."customerId"`,
    decisionInputsSnapshot() as Promise<PlanningSnapshot>,
    db.historicalDeliverySale.aggregate({ _sum: { totalCents: true }, _count: true }),
    db.historicalPurchaseReceipt.aggregate({ _sum: { totalCents: true }, _count: true }),
    db.historicalCashMovement.aggregate({ _sum: { amountCents: true }, _count: true }),
    db.historicalExpense.aggregate({ _sum: { amountCents: true }, _count: true }),
    db.historicalStockObservation.count(),
    db.historicalStockout.count(),
    db.historicalPromotion.findMany({ take: 20, orderBy: { startsOn: "desc" }, select: {
      sourceSystem: true, sourceId: true, label: true, startsOn: true, endsOn: true, discountCents: true,
    } }),
    db.historicalMember.count(),
    sourceSnapshot(),
  ]);

  // Preserve fractional cents until all lots are valued, then allocate the
  // rounded cent remainder to lots with the largest fractional portions.
  // This keeps the displayed lot values equal to the inventory total.
  const valuationParts = products.map((product) => {
    const exactMilliCents = BigInt(product.stock) * BigInt(product.cost);
    return { id: product.id, wholeCents: exactMilliCents / 1000n, remainder: exactMilliCents % 1000n };
  });
  const roundedInventoryTotal = (valuationParts.reduce((sum, row) =>
    sum + row.wholeCents * 1000n + row.remainder, 0n) + 500n) / 1000n;
  const wholeInventoryTotal = valuationParts.reduce((sum, row) => sum + row.wholeCents, 0n);
  const extraCents = Number(roundedInventoryTotal - wholeInventoryTotal);
  const lotValueCents = new Map(valuationParts.map((row) => [row.id, row.wholeCents]));
  for (const row of [...valuationParts].sort((a, b) => a.remainder === b.remainder
    ? a.id.localeCompare(b.id) : a.remainder > b.remainder ? -1 : 1).slice(0, extraCents))
    lotValueCents.set(row.id, row.wholeCents + 1n);
  const inventoryValueCents = roundedInventoryTotal;
  const pnl = calculateManagementPnl({
    period: { from: fromMonth, through: asOfDate },
    netSales: localDaily.map((row) => ({ date: row.date, amountCents: row.revenue })),
    historicalCogs: localDaily.map((row) => ({ date: row.date, amountCents: row.cost })),
    accruedOperatingExpenses: expenses.map((row) => ({ date: row.date, amountCents: row.amount })),
    inventoryAcquisitions: [],
    cashEntries: [],
    sourceCoverage: {
      netSales: "partial", historicalCogs: "partial", accruedOperatingExpenses: "partial",
      inventoryAcquisitions: "unknown", cashEntries: "unknown",
    },
  });
  const dailyByDate = new Map(localDaily.map((row) => [row.date, row.revenue]));
  const first = localDaily[0]?.date ?? asOfDate;
  const calendar: Array<{ date: string; netSalesCents: bigint }> = [];
  for (let date = first; date <= asOfDate; date = offset(date, 1))
    calendar.push({ date, netSalesCents: dailyByDate.get(date) ?? 0n });
  const weeklyForecast = forecastSevenDayAggregate({ dailySales: calendar, sourceCoverage: "partial" });
  const deliveryAttestation = planning.attestations.find((row) => row.domain === "delivery_sales" && row.scenario === null);
  let deliveryForecast = forecastSevenDayAggregate({ dailySales: [], sourceCoverage: "partial" });
  let deliveryForecastSource: { sourceSystem: string; batchId: string; from: string; through: string } | null = null;
  if (deliveryAttestation?.complete) {
    const attestedBatchId = /^batch:([0-9a-f-]{36})$/i.exec(deliveryAttestation.sourceReference)?.[1];
    const batch = attestedBatchId ? await db.historicalImportBatch.findUnique({
      where: { id: attestedBatchId }, include: { reconciliation: true },
    }) : null;
    const reconciledCoverage = batch?.kind === "delivery_sales" && batch.status === "reconciled" &&
      batch.rejectedCount === 0 && batch.reconciliation?.varianceCents === 0n &&
      batch.reconciliation?.coverageComplete && batch.reconciliation.coverageFrom && batch.reconciliation.coverageThrough &&
      iso(batch.reconciliation.coverageFrom) <= deliveryAttestation.fromDate &&
      iso(batch.reconciliation.coverageThrough) >= deliveryAttestation.throughDate &&
      iso(batch.cutoffDate) >= deliveryAttestation.throughDate;
    if (reconciledCoverage && batch) {
      const [untrustedSales, untrustedLines, dailyDelivery] = await Promise.all([
        db.$queryRaw<CountRow[]>`
          SELECT COUNT(*)::bigint AS count FROM "HistoricalDeliverySale" s
          WHERE s."sourceSystem" = ${batch.sourceSystem}
            AND s."saleDate" BETWEEN ${deliveryAttestation.fromDate}::date AND ${deliveryAttestation.throughDate}::date
            AND NOT EXISTS (SELECT 1 FROM "HistoricalImportProvenance" p
              JOIN "HistoricalImportBatch" b ON b.id = p."batchId"
              JOIN "HistoricalReconciliation" r ON r."batchId" = b.id
              WHERE p."factKind" = 'delivery_sale' AND p."sourceSystem" = s."sourceSystem"
                AND p."sourceId" = s."sourceId" AND p."factHash" = s."factHash"
                AND b.status = 'reconciled' AND b."rejectedCount" = 0
                AND r."coverageComplete" = true AND r."varianceCents" = 0
                AND r."coverageFrom" <= s."saleDate" AND r."coverageThrough" >= s."saleDate")`,
        db.$queryRaw<CountRow[]>`
          SELECT COUNT(*)::bigint AS count FROM "HistoricalDeliverySaleLine" l
          JOIN "HistoricalDeliverySale" s ON s.id = l."saleId"
          WHERE s."sourceSystem" = ${batch.sourceSystem}
            AND s."saleDate" BETWEEN ${deliveryAttestation.fromDate}::date AND ${deliveryAttestation.throughDate}::date
            AND NOT EXISTS (SELECT 1 FROM "HistoricalImportProvenance" p
              JOIN "HistoricalImportBatch" b ON b.id = p."batchId"
              JOIN "HistoricalReconciliation" r ON r."batchId" = b.id
              WHERE p."factKind" = 'delivery_sale_line' AND p."sourceSystem" = l."sourceSystem"
                AND p."sourceId" = l."sourceId" AND p."factHash" = l."factHash"
                AND b.status = 'reconciled' AND b."rejectedCount" = 0
                AND r."coverageComplete" = true AND r."varianceCents" = 0
                AND r."coverageFrom" <= s."saleDate" AND r."coverageThrough" >= s."saleDate")`,
        db.$queryRaw<DeliveryDailyRow[]>`
          SELECT s."saleDate" AS date, SUM(s."totalCents" - s."discountCents")::bigint AS "netCents"
          FROM "HistoricalDeliverySale" s
          WHERE s."sourceSystem" = ${batch.sourceSystem}
            AND s."saleDate" BETWEEN ${deliveryAttestation.fromDate}::date AND ${deliveryAttestation.throughDate}::date
            AND EXISTS (SELECT 1 FROM "HistoricalImportProvenance" p
              JOIN "HistoricalImportBatch" b ON b.id = p."batchId"
              JOIN "HistoricalReconciliation" r ON r."batchId" = b.id
              WHERE p."factKind" = 'delivery_sale' AND p."sourceSystem" = s."sourceSystem"
                AND p."sourceId" = s."sourceId" AND p."factHash" = s."factHash"
                AND b.status = 'reconciled' AND b."rejectedCount" = 0
                AND r."coverageComplete" = true AND r."varianceCents" = 0
                AND r."coverageFrom" <= s."saleDate" AND r."coverageThrough" >= s."saleDate")
          GROUP BY s."saleDate"`,
      ]);
      if (untrustedSales[0]?.count === 0n && untrustedLines[0]?.count === 0n) {
        const daily = new Map(dailyDelivery.map((row) => [iso(row.date), row.netCents]));
        const series: Array<{ date: string; netSalesCents: bigint }> = [];
        for (let day = deliveryAttestation.fromDate; day <= deliveryAttestation.throughDate; day = offset(day, 1))
          series.push({ date: day, netSalesCents: daily.get(day) ?? 0n });
        deliveryForecast = forecastSevenDayAggregate({ dailySales: series, sourceCoverage: "complete" });
        deliveryForecastSource = { sourceSystem: batch.sourceSystem, batchId: batch.id,
          from: deliveryAttestation.fromDate, through: deliveryAttestation.throughDate };
      }
    }
  }

  const productById = new Map(products.map((row) => [row.id, row]));
  const leadTimeRows = await db.$queryRaw<SupplierLeadTimeRow[]>`
    SELECT r."sourceSystem", r."supplierSourceId", r."orderDate", r."receivedDate"
    FROM "HistoricalPurchaseReceipt" r
    WHERE r."orderDate" IS NOT NULL AND r."receivedDate" <= ${asOfDate}::date
      AND EXISTS (SELECT 1 FROM "HistoricalImportProvenance" p
        JOIN "HistoricalImportBatch" b ON b.id = p."batchId"
        JOIN "HistoricalReconciliation" c ON c."batchId" = b.id
        WHERE p."sourceSystem" = r."sourceSystem" AND p."sourceId" = r."sourceId"
          AND p."factKind" = 'purchase_receipt' AND p."factHash" = r."factHash"
          AND b.status = 'reconciled' AND c."varianceCents" = 0)`;
  const leadTimeGroups = new Map<string, { sourceSystem: string; supplierSourceId: string | null; days: number[] }>();
  for (const row of leadTimeRows) {
    const days = Math.round((row.receivedDate.getTime() - row.orderDate.getTime()) / 86_400_000);
    if (!Number.isSafeInteger(days) || days < 0 || days > 365) continue;
    const key = `${row.sourceSystem}\u0000${row.supplierSourceId ?? ""}`;
    const group = leadTimeGroups.get(key) ?? { sourceSystem: row.sourceSystem, supplierSourceId: row.supplierSourceId, days: [] };
    group.days.push(days);
    leadTimeGroups.set(key, group);
  }
  const supplierAlias = (value: string | null) => value === null ? "Proveedor sin ID" :
    `Proveedor externo ${createHmac("sha256", supplierAliasKey)
      .update(`supplier-source-id\u0000${value}`).digest("hex").slice(0, 8)}`;
  const observedSupplierLeadTimes = [...leadTimeGroups.values()].map((group) => {
    const days = group.days.sort((a, b) => a - b);
    const middle = Math.floor(days.length / 2);
    return { sourceSystem: group.sourceSystem, supplier: supplierAlias(group.supplierSourceId),
      sampleCount: days.length, minimumDays: days[0],
      medianDays: days.length % 2 ? days[middle] : (days[middle - 1] + days[middle]) / 2,
      p75Days: days[Math.ceil(days.length * 0.75) - 1], maximumDays: days[days.length - 1],
      evidence: "reconciled_purchase_receipts", ruleUse: "descriptive_only_until_validated" };
  }).sort((a, b) => a.sourceSystem.localeCompare(b.sourceSystem) || a.supplier.localeCompare(b.supplier));
  const supplierKey = (productId: string) => {
    const row = productById.get(productId);
    return row?.supplierId || row?.supplier || "sin-proveedor";
  };
  const latestCashSnapshot = planning.cashSnapshots.find((row) => row.asOf === asOfDate);
  const reconciledOpening = latestCashSnapshot?.complete ? {
    kind: "reconciled" as const,
    amountCents: latestCashSnapshot.accounts.reduce((sum, row) => sum + BigInt(row.amountCents), 0n),
    asOfDate,
    reconciliationId: latestCashSnapshot.id,
  } : null;
  const coverage = (domain: "cash_plan" | "delivery_sales", scenario: string | null, from: string, through: string) =>
    planning.attestations.find((row) => row.domain === domain && row.scenario === scenario &&
      row.fromDate <= from && row.throughDate >= through)?.complete === true;
  const [verifiedObservations, verifiedStockouts, importedDemand] = planning.mapping?.status === "shared"
    ? await Promise.all([
      db.$queryRaw<ImportedAvailabilityRow[]>`
        SELECT o."sourceSystem", o."productSourceId", o."observedDate" AS date, o."locationSourceId",
          o."quantityUnit", o."quantityMilliunits"
        FROM "HistoricalStockObservation" o
        WHERE o."observedDate" >= ${historyStart}::date AND o."observedDate" <= ${asOfDate}::date
          AND EXISTS (SELECT 1 FROM "HistoricalImportProvenance" p
            JOIN "HistoricalImportBatch" b ON b.id = p."batchId"
            JOIN "HistoricalReconciliation" r ON r."batchId" = b.id
            WHERE p."sourceSystem" = o."sourceSystem" AND p."sourceId" = o."sourceId"
              AND p."factKind" = 'stock_observation' AND p."factHash" = o."factHash"
              AND b.status = 'reconciled' AND r."coverageComplete" = true
              AND r."coverageFrom" <= o."observedDate" AND r."coverageThrough" >= o."observedDate")`,
      db.$queryRaw<ImportedAvailabilityRow[]>`
        SELECT o."sourceSystem", o."productSourceId", o."stockoutDate" AS date, o."locationSourceId",
          o."quantityUnit", o."lostQuantityMilliunits" AS "quantityMilliunits"
        FROM "HistoricalStockout" o
        WHERE o."stockoutDate" >= ${historyStart}::date AND o."stockoutDate" <= ${asOfDate}::date
          AND EXISTS (SELECT 1 FROM "HistoricalImportProvenance" p
            JOIN "HistoricalImportBatch" b ON b.id = p."batchId"
            JOIN "HistoricalReconciliation" r ON r."batchId" = b.id
            WHERE p."sourceSystem" = o."sourceSystem" AND p."sourceId" = o."sourceId"
              AND p."factKind" = 'stockout' AND p."factHash" = o."factHash"
              AND b.status = 'reconciled' AND r."coverageComplete" = true
              AND r."coverageFrom" <= o."stockoutDate" AND r."coverageThrough" >= o."stockoutDate")`,
      deliveryForecastSource ? db.$queryRaw<ImportedDemandRow[]>`
        SELECT l."sourceSystem", l."productSourceId", s."saleDate" AS date,
          l."quantityUnit", SUM(l."quantityMilliunits")::bigint AS "quantityMilliunits"
        FROM "HistoricalDeliverySaleLine" l JOIN "HistoricalDeliverySale" s ON s.id = l."saleId"
        WHERE l."sourceSystem" = ${deliveryForecastSource.sourceSystem}
          AND s."saleDate" >= ${deliveryForecastSource.from}::date
          AND s."saleDate" <= ${deliveryForecastSource.through}::date
          AND EXISTS (SELECT 1 FROM "HistoricalImportProvenance" p
            JOIN "HistoricalImportBatch" b ON b.id = p."batchId"
            JOIN "HistoricalReconciliation" r ON r."batchId" = b.id
            WHERE p."factKind" = 'delivery_sale_line' AND p."sourceSystem" = l."sourceSystem"
              AND p."sourceId" = l."sourceId" AND p."factHash" = l."factHash"
              AND b.status = 'reconciled' AND b."rejectedCount" = 0
              AND r."coverageComplete" = true AND r."varianceCents" = 0
              AND r."coverageFrom" <= s."saleDate" AND r."coverageThrough" >= s."saleDate")
        GROUP BY l."sourceSystem", l."productSourceId", s."saleDate", l."quantityUnit"`
        : Promise.resolve([] as ImportedDemandRow[]),
    ]) : [[], [], []] as [ImportedAvailabilityRow[], ImportedAvailabilityRow[], ImportedDemandRow[]];
  const importedProduct = new Map(products.filter((row) => row.sourceSystem && row.sourceId)
    .map((row) => [`${row.sourceSystem}\u0000${row.sourceId}`, row]));
  const sharedLocations = new Set(planning.mapping?.status === "shared" ? planning.mapping.sharedLocationIds : []);
  const dailyDemand = new Map<string, { productId: string; date: string; soldMilliunits: number;
    availability: "unknown" | "available" | "stockout"; onHandSnapshotMilliunits: number | null }>();
  const dailyKey = (productId: string, date: string) => `${productId}\u0000${date}`;
  for (const row of demandRows) {
    if (row.sold > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    dailyDemand.set(dailyKey(row.productId, row.date), { productId: row.productId, date: row.date,
      soldMilliunits: Number(row.sold), availability: "unknown", onHandSnapshotMilliunits: null });
  }
  for (const row of importedDemand) {
    const product = importedProduct.get(`${row.sourceSystem}\u0000${row.productSourceId}`);
    if (!product || product.unit !== row.quantityUnit || row.quantityMilliunits > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const day = iso(row.date);
    const key = dailyKey(product.id, day);
    const current = dailyDemand.get(key) ?? { productId: product.id, date: day, soldMilliunits: 0,
      availability: "unknown" as const, onHandSnapshotMilliunits: null };
    const combined = current.soldMilliunits + Number(row.quantityMilliunits);
    if (!Number.isSafeInteger(combined)) continue;
    dailyDemand.set(key, { ...current, soldMilliunits: combined });
  }
  const locationAvailability = new Map<string, Map<string, number>>();
  for (const row of verifiedObservations) {
    const product = importedProduct.get(`${row.sourceSystem}\u0000${row.productSourceId}`);
    if (!product || product.unit !== row.quantityUnit || !row.locationSourceId || !sharedLocations.has(row.locationSourceId) ||
        row.quantityMilliunits === null || row.quantityMilliunits < 0n ||
        row.quantityMilliunits > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const day = iso(row.date);
    const key = dailyKey(product.id, day);
    const locations = locationAvailability.get(key) ?? new Map<string, number>();
    const quantity = Number(row.quantityMilliunits);
    // Two reconciled files can disagree about the same day. A conflict must not
    // turn into an apparently precise availability observation.
    locations.set(row.locationSourceId, locations.has(row.locationSourceId) && locations.get(row.locationSourceId) !== quantity
      ? -1 : quantity);
    locationAvailability.set(key, locations);
  }
  for (const row of verifiedStockouts) {
    const product = importedProduct.get(`${row.sourceSystem}\u0000${row.productSourceId}`);
    if (!product || (row.quantityUnit && product.unit !== row.quantityUnit) || !row.locationSourceId ||
        !sharedLocations.has(row.locationSourceId)) continue;
    const day = iso(row.date);
    const key = dailyKey(product.id, day);
    const locations = locationAvailability.get(key) ?? new Map<string, number>();
    if (!locations.has(row.locationSourceId)) locations.set(row.locationSourceId, 0);
    locationAvailability.set(key, locations);
  }
  for (const [key, locations] of locationAvailability) {
    const [productId, day] = key.split("\u0000");
    const current = dailyDemand.get(key) ?? { productId, date: day, soldMilliunits: 0,
      availability: "unknown" as const, onHandSnapshotMilliunits: null };
    const values = [...locations.values()];
    const conflict = values.some((value) => value < 0);
    const complete = !conflict && [...sharedLocations].every((locationId) => locations.has(locationId));
    const positive = !conflict && values.some((value) => value > 0);
    const total = complete ? values.reduce((sum, value) => sum + value, 0) : null;
    dailyDemand.set(key, { ...current,
      availability: positive ? "available" : complete && total === 0 ? "stockout" : "unknown",
      onHandSnapshotMilliunits: total !== null && Number.isSafeInteger(total) ? total : null,
    });
  }
  const commerce = calculateCommerceDecisions({
    asOfDate,
    inventoryLots: products.map((row) => ({
      productId: row.id,
      lotId: row.lot,
      supplierId: row.supplierId || row.supplier || "sin-proveedor",
      locationId: row.locationId,
      quantityMilliunits: row.stock,
      expiresOn: row.expires,
    })),
    demandHistory: [...dailyDemand.values()],
    historicalUnitCosts: products.map((row) => ({
      productId: row.id, supplierId: row.supplierId || row.supplier || "sin-proveedor",
      observedOn: asOfDate, unitCostCentsPerUnit: BigInt(row.cost),
    })),
    replacementQuotes: planning.quotes.filter((row) => row.status === "active" && productById.has(row.productId)).map((row) => ({
      quoteId: row.id, productId: row.productId, supplierId: supplierKey(row.productId),
      quotedOn: row.quotedOn, validUntil: row.validUntil, unitCostCentsPerUnit: BigInt(row.unitCostCentsPerUnit),
    })),
    pendingInbound: planning.inbounds.filter((row) => row.status === "pending" && productById.has(row.productId)).map((row) => ({
      inboundId: row.id, productId: row.productId, supplierId: supplierKey(row.productId),
      locationId: row.locationId, quantityMilliunits: row.quantityMilliunits, arrivalDate: row.arrivalDate,
    })),
    replenishmentRules: products.map((row) => ({
      productId: row.id, supplierId: row.supplierId || row.supplier || "sin-proveedor",
      leadTimeDays: planning.rules.find((rule) => rule.productId === row.id)?.leadTimeDays ?? null,
      minimumOrderQuantityMilliunits: planning.rules.find((rule) => rule.productId === row.id)?.minimumOrderQuantityMilliunits ?? 0,
      reviewPeriodDays: planning.rules.find((rule) => rule.productId === row.id)?.reviewPeriodDays ?? 7,
    })),
    fulfillmentMapping: planning.mapping?.status === "shared"
      ? { status: "known", sharedLocationIds: planning.mapping.sharedLocationIds,
          localLocationIds: planning.mapping.localLocationIds, deliveryLocationIds: planning.mapping.deliveryLocationIds }
      : { status: "unknown", reason: planning.mapping?.status === "separate"
        ? "Stock separado por canal: no hay propuesta conjunta" : "Tiziano debe confirmar stock compartido o separado" },
    cashPosition: reconciledOpening && reconciledOpening.amountCents >= 0n
      ? { availableCents: reconciledOpening.amountCents, floorCents: BigInt(latestCashSnapshot!.floorCents) }
      : { availableCents: null, floorCents: null },
    expiryWarningDays: 30,
  });

  const planEvents = planning.cashPlans.flatMap((row) => {
    if (row.status !== "active" || row.date <= asOfDate || !["low", "base", "high"].includes(row.scenario) ||
        !allowedCashCategories.has(row.category as PlannedCashCategory)) return [];
    return [{ scenario: row.scenario as PlanningScenario, date: row.date,
      category: row.category as PlannedCashCategory, amountCents: BigInt(row.amountCents) }];
  });
  const cash13Weeks = Object.fromEntries((["low", "base", "high"] as const).map((scenario) => [scenario,
    forecastThirteenWeekCash({
      asOfDate, scenario, sourceCoverage: coverage("cash_plan", scenario, offset(asOfDate, 1), offset(asOfDate, 91)) ? "complete" : "partial",
      openingBalance: reconciledOpening,
      events: planEvents.filter((row) => row.scenario === scenario).map(({ scenario: _s, ...event }) => event),
    }),
  ]));
  const forecastMonths: string[] = [];
  for (let month = asOfDate.slice(0, 7); month <= "2027-12";) {
    forecastMonths.push(month);
    const following = new Date(`${month}-01T12:00:00Z`);
    following.setUTCMonth(following.getUTCMonth() + 1);
    month = following.toISOString().slice(0, 7);
  }
  const monthlyAssumptions = (["low", "base", "high"] as const).flatMap((scenario) => {
    return forecastMonths.map((month) => {
      const firstDate = month === asOfDate.slice(0, 7) ? offset(asOfDate, 1) : `${month}-01`;
      const lastDate = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
      return { month, scenario,
      sourceCoverage: coverage("cash_plan", scenario, firstDate, lastDate)
        ? "complete" as const : "partial" as const,
      events: planEvents.filter((row) => row.scenario === scenario && row.date.startsWith(month)).map(({ scenario: _s, ...event }) => event),
    }; });
  });
  const longRange = forecastLongRangeScenarios({ asOfDate, openingBalance: reconciledOpening, assumptions: monthlyAssumptions, hiringWhatIf: null });

  const segmentationAssumptions = {
    recentDays: 30, coolingDays: 60, mediumFrequencyPurchases: 3, highFrequencyPurchases: 8,
    mediumSpendCents: 50_000n, highSpendCents: 150_000n,
  };
  const segments = segmentMembers(asOfDate, memberRows.map((row) => ({
    memberId: row.customerId, lastPurchaseDate: row.lastDate,
    purchaseCount: Number(row.purchaseCount), spendCents: row.spent,
  })), segmentationAssumptions);
  const summarizeMargin = (key: "category" | "supplier") => {
    const groups = new Map<string, { revenueCents: bigint; historicalCogsCents: bigint; quantityMilliunits: bigint; lineCount: bigint }>();
    for (const row of marginRows) {
      const entry = groups.get(row[key]) ?? { revenueCents: 0n, historicalCogsCents: 0n, quantityMilliunits: 0n, lineCount: 0n };
      entry.revenueCents += row.revenue;
      entry.historicalCogsCents += row.cost;
      entry.quantityMilliunits += row.quantityMilliunits;
      entry.lineCount += row.lineCount;
      groups.set(row[key], entry);
    }
    return [...groups].map(([name, entry]) => ({ name, ...entry,
      grossMarginCents: entry.revenueCents - entry.historicalCogsCents }));
  };
  return jsonSafe({
    asOfDate,
    calculationVersion: "decision-v1",
    sourceState: importState,
    limitations: [
      "Ventas históricas de delivery y ventas locales permanecen separadas.",
      planning.mapping?.status === "shared" ? "La reposición aún exige historia de disponibilidad y plazos validados por producto."
        : "Sin decisión de stock compartido no hay orden de compra conjunta calculada.",
      "La caja proyectada exige saldo del día conciliado y cobertura completa de obligaciones futuras certificada por escenario.",
      "Segmentos descriptivos de ventas locales; sin permiso para generar mensajes ni exportar contactos.",
    ],
    inventory: {
      valueAtHistoricalCostCents: inventoryValueCents,
      observedSupplierLeadTimes,
      lots: products.map((row) => ({
        id: row.id, name: row.name, lot: row.lot, unit: row.unit, locationId: row.locationId,
        supplier: row.supplier, stockMilliunits: row.stock, minimumMilliunits: row.minimum,
        historicalUnitCostCents: BigInt(row.cost), currentUnitPriceCents: BigInt(row.price), expiresOn: row.expires,
        valueAtHistoricalCostCents: lotValueCents.get(row.id) ?? 0n,
      })),
      commerce,
    },
    profitability: {
      localMonth: pnl,
      byProduct: marginRows.map((row) => ({ productId: row.productId, name: row.name,
        category: row.category, supplier: row.supplier, revenueCents: row.revenue,
        historicalCogsCents: row.cost, grossMarginCents: row.revenue - row.cost,
        quantityMilliunits: row.quantityMilliunits, lineCount: row.lineCount,
        evidence: process.env.DEMO_MODE === "true" ? "demo" : "observed_local" })),
      byCategory: summarizeMargin("category"),
      bySupplier: summarizeMargin("supplier"),
      byChannel: [
        { channel: "local", revenueCents: pnl.netSalesCents, historicalCogsCents: pnl.historicalCogsCents,
          grossMarginCents: pnl.netSalesCents - pnl.historicalCogsCents,
          saleCount: localDaily.filter((row) => row.date >= fromMonth).reduce((sum, row) => sum + row.saleCount, 0n),
          note: "Ventas locales observadas; sin garantía de cobertura contable completa." },
        { channel: "delivery_importado", revenueCents: delivery._sum.totalCents ?? 0n,
          historicalCogsCents: null, grossMarginCents: null, saleCount: delivery._count,
          note: "Origen AppSheet separado. Margen no calculable hasta vincular líneas, lotes y costos sin solapamientos." },
      ],
      deliveryImported: { saleCount: delivery._count, revenueCents: delivery._sum.totalCents ?? 0n },
    },
    importedHistory: {
      evidence: importState.reconciled > 0 ? "mixed_imported_and_reconciled" : "imported_without_complete_reconciliation",
      deliverySales: { count: delivery._count, grossRecordedCents: delivery._sum.totalCents ?? 0n },
      purchaseReceipts: { count: purchases._count, recordedCents: purchases._sum.totalCents ?? 0n },
      cashMovements: { count: importedCash._count, signedCents: importedCash._sum.amountCents ?? 0n },
      expenses: { count: importedExpenses._count, recordedCents: importedExpenses._sum.amountCents ?? 0n },
      stockObservations: importedStock,
      stockouts: importedStockouts,
      promotions: importedPromotions.map((row) => ({
        ...row, startsOn: iso(row.startsOn), endsOn: row.endsOn ? iso(row.endsOn) : null,
      })),
      memberKeys: importedMembers,
      note: "Estos totales históricos son de archivos externos y no descuentan stock ni caja local. Pueden solaparse con asientos locales hasta conciliar.",
    },
    forecast: { localSevenDay: weeklyForecast, deliverySevenDay: deliveryForecast,
      deliverySource: deliveryForecastSource, cash13Weeks, monthsThrough2027: longRange },
    segments: { assumptions: segmentationAssumptions, result: segments },
  });
}

decisionAnalysis.get("/decision-analysis", async (req, res) => {
  financialAccess(req.user.role);
  await audit(req.user.id, "decision_analysis");
  res.json(await decisionAnalysisPayload(businessDate(await getSettings())));
});

const scenarioSchema = z.object({
  name: z.string().trim().min(2).max(100),
  lines: z.array(z.object({
    productId: z.string().min(1), quantityMilliunits: z.number().int().positive().safe(),
    discount: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("percent_bps"), value: z.number().int().min(0).max(10_000) }),
      z.object({ kind: z.literal("fixed_cents"), value: unsignedMoney }),
    ]),
  })).min(1).max(30),
  shippingChargedCents: unsignedMoney,
  shippingCostCents: unsignedMoney,
  freebies: z.array(z.object({ productId: z.string().min(1), quantityMilliunits: z.number().int().positive().safe() })).max(30),
  campaignCostCents: unsignedMoney,
});

function scenarioInput(value: z.infer<typeof scenarioSchema>): PromotionScenario {
  return {
    name: value.name,
    lines: value.lines.map((line) => ({
      productId: line.productId, quantityMilliunits: line.quantityMilliunits,
      discount: line.discount.kind === "fixed_cents"
        ? { kind: "fixed_cents", value: BigInt(line.discount.value) }
        : line.discount,
    })),
    shippingChargedCents: BigInt(value.shippingChargedCents),
    shippingCostCents: BigInt(value.shippingCostCents),
    freebies: value.freebies,
    campaignCostCents: BigInt(value.campaignCostCents),
  };
}

decisionAnalysis.post("/decision-simulations/promotion", async (req, res) => {
  financialAccess(req.user.role);
  const input = z.object({ promoted: scenarioSchema, reference: scenarioSchema.optional() }).strict().parse(req.body);
  const ids = [...new Set([...input.promoted.lines.map((row) => row.productId), ...input.promoted.freebies.map((row) => row.productId),
    ...(input.reference?.lines.map((row) => row.productId) || []), ...(input.reference?.freebies.map((row) => row.productId) || [])])];
  const products = await db.product.findMany({ where: { id: { in: ids } }, select: { id: true, price: true, cost: true } });
  if (products.length !== ids.length) throw new HttpError(400, "Hay un lote desconocido en la simulación");
  const calculation = simulatePromotion({
    products: products.map((row) => ({ productId: row.id, unitPriceCents: BigInt(row.price), variableCostCentsPerUnit: BigInt(row.cost) })),
    promoted: scenarioInput(input.promoted), reference: input.reference ? scenarioInput(input.reference) : undefined,
  });
  await db.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "promotion_simulation", action: "calculate" } });
  res.json(jsonSafe({ evidence: process.env.DEMO_MODE === "true" ? "demo" : "scenario", calculationVersion: "decision-v1",
    source: "Precio y costo histórico registrados por lote en Bombo; envío y campaña ingresados por usuario",
    limitation: "No incluye tributos ni costos variables no ingresados; la comparación no demuestra ventas incrementales causadas por la promoción.",
    calculation }));
});

decisionAnalysis.post("/decision-simulations/hiring", async (req, res) => {
  financialAccess(req.user.role);
  const input = z.object({
    startMonth: month, endMonth: month.nullable(), headcount: z.number().int().min(1).max(100),
    monthlyEmployerCostPerEmployeeCents: unsignedMoney,
    incrementalContributionPerUnitCents: unsignedMoney,
    cashFloorCents: unsignedMoney,
  }).strict().parse(req.body);
  const cost = BigInt(input.monthlyEmployerCostPerEmployeeCents) * BigInt(input.headcount);
  const contribution = BigInt(input.incrementalContributionPerUnitCents);
  const requiredUnits = contribution > 0n ? (cost + contribution - 1n) / contribution : null;
  const asOfDate = businessDate(await getSettings());
  const scenarios = forecastLongRangeScenarios({ asOfDate, openingBalance: null, assumptions: [], hiringWhatIf: {
    startMonth: input.startMonth, endMonth: input.endMonth, headcount: input.headcount,
    monthlyEmployerCostPerEmployeeCents: BigInt(input.monthlyEmployerCostPerEmployeeCents),
  } });
  await db.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "hiring_simulation", action: "calculate" } });
  res.json(jsonSafe({ evidence: "scenario", calculationVersion: "decision-v1", monthlyIncrementalContributionNeededCents: cost,
    additionalUnitsNeeded: requiredUnits, cashFloorCents: BigInt(input.cashFloorCents),
    cashVerdict: "unavailable_without_reconciled_balance_and_complete_assumptions",
    limitation: "Costo laboral y contribución son supuestos ingresados; validar con el profesional. No se recomienda contratar sin saldo y obligaciones conciliados.",
    scenarios }));
});

const suppliedIndexValue = z.string().max(24).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/).refine((value) => {
  const [whole] = value.split(".");
  return BigInt(whole) <= 1_000_000_000_000n && BigInt(value.replace(".", "")) > 0n;
});
const scaledIndex = (value: string) => {
  const [whole, fractional = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, "0") || "0");
};

decisionAnalysis.post("/decision-simulations/inflation", async (req, res) => {
  financialAccess(req.user.role);
  const input = z.object({
    earlierMonth: month, laterMonth: month,
    earlierNominalCents: moneyString, laterNominalCents: moneyString,
    earlierIndex: suppliedIndexValue, laterIndex: suppliedIndexValue,
    publishedAt: date, seriesVersion: z.string().trim().min(2).max(120),
    sourceUrl: z.url().max(500),
  }).strict().parse(req.body);
  const source = new URL(input.sourceUrl);
  if (source.protocol !== "https:" || (source.hostname !== "indec.gob.ar" && !source.hostname.endsWith(".indec.gob.ar")))
    throw new HttpError(400, "La referencia del índice debe apuntar a una publicación oficial de INDEC");
  const today = businessDate(await getSettings());
  if (input.publishedAt > today || input.laterMonth > input.publishedAt.slice(0, 7))
    throw new HttpError(400, "El índice no puede estar publicado en el futuro");
  if (input.earlierMonth >= input.laterMonth)
    throw new HttpError(400, "El mes base debe preceder al mes de comparación");
  const calculation = compareNominalUsingOfficialCpi({
    earlierMonth: input.earlierMonth, laterMonth: input.laterMonth,
    earlierNominalCents: BigInt(input.earlierNominalCents), laterNominalCents: BigInt(input.laterNominalCents),
    officialIndex: { publisher: "INDEC (referencia suministrada por usuario)", seriesName: input.sourceUrl,
      version: input.seriesVersion, publishedAt: input.publishedAt,
      points: [{ month: input.earlierMonth, indexValue: scaledIndex(input.earlierIndex) },
        { month: input.laterMonth, indexValue: scaledIndex(input.laterIndex) }],
    },
  });
  if (calculation.earlierAdjustedToLaterCents !== null &&
      (calculation.earlierAdjustedToLaterCents < CENTS64_MIN || calculation.earlierAdjustedToLaterCents > CENTS64_MAX))
    throw new HttpError(400, "El valor ajustado excede el rango monetario de 64 bits");
  await audit(req.user.id, "inflation_comparison");
  res.json(jsonSafe({ calculationVersion: "decision-v1", sourceUrl: input.sourceUrl,
    evidence: "official_source_user_supplied_unverified", limitation: "La app valida el dominio y calcula con precisión entera, pero no descarga ni coteja los índices publicados. Revisá ambos puntos contra INDEC; el IPC no reemplaza una cotización de reposición.",
    calculation }));
});
