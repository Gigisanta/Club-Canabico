import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { parse as parseCsv } from "csv-parse/sync";
import type { AddressInfo } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";

async function createReportTestSchema() {
  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) return null;
  const base = new URL(raw);
  assert.ok(["postgres:", "postgresql:"].includes(base.protocol), "TEST_DATABASE_URL must be PostgreSQL");
  const host = base.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  assert.ok(["localhost", "127.0.0.1", "::1"].includes(host), "TEST_DATABASE_URL must use loopback");
  const databaseName = decodeURIComponent(base.pathname.slice(1));
  assert.match(databaseName, /^bombo_(?:ui|test)_[a-z0-9][a-z0-9_-]*$/i, "TEST_DATABASE_URL must name a dedicated bombo_ui_* or bombo_test_* database");

  const schema = `report_contract_${process.pid}_${randomBytes(6).toString("hex")}`;
  assert.match(schema, /^report_contract_[0-9]+_[a-f0-9]+$/);
  const adminUrl = new URL(base);
  adminUrl.searchParams.set("schema", "public");
  const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
  let scoped: PrismaClient | undefined;
  let created = false;
  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    created = true;
    const scopedUrl = new URL(base);
    scopedUrl.searchParams.set("schema", schema);
    scoped = new PrismaClient({ datasourceUrl: scopedUrl.toString() });
    const migrationsDir = new URL("../prisma/migrations/", import.meta.url);
    const migrationsPath = decodeURIComponent(migrationsDir.pathname);
    const migrations = (await readdir(migrationsPath, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
    assert.ok(migrations.length > 0, "expected checked-in database migrations");
    for (const migration of migrations) {
      const sql = await readFile(join(migrationsPath, migration, "migration.sql"), "utf8");
      for (const statement of splitSqlStatements(sql)) await scoped.$executeRawUnsafe(statement);
    }
    const scopedUrlString = scopedUrl.toString();
    process.env.DATABASE_URL = scopedUrlString;
    process.env.NODE_ENV = "test";
    const [{ db }, queries] = await Promise.all([
      import("../server/db.js"),
      import("../server/operations/report-queries.js"),
    ]);
    return {
      db,
      queries,
      schema,
      async close() {
        await db.$disconnect();
        await scoped?.$disconnect();
        await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.$disconnect();
      },
    };
  } catch (error) {
    await scoped?.$disconnect().catch(() => undefined);
    if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`).catch(() => undefined);
    await admin.$disconnect();
    throw error;
  }
}

const reportTestSchema = await createReportTestSchema();
const reportQueries = reportTestSchema?.queries ?? await import("../server/operations/report-queries.js");
const { parseReportParams, reportAreaIds, reportDefinitions } = await import("../server/operations/report-definitions.js");
after(async () => { await reportTestSchema?.close(); });

const {
  aggregateCustomerSegmentationProfiles,
  customerSegmentationQueryContract,
  reportPeriodDateBounds,
  reportTodayCivilDate,
  summarizeMemberCreditBalances,
  summarizeStockFactMovements,
  supportsReportScope,
} = reportQueries;

test("report catalog defines all eleven selectable areas and explicit coverage outputs", () => {
  assert.equal(reportDefinitions.length, 11);
  assert.deepEqual(reportDefinitions.map(area => area.id), reportAreaIds);
  for (const area of reportDefinitions) {
    assert.ok(area.output.some(field => field.name === "coverage"));
    assert.ok(area.output.some(field => field.name === "evidenceState"));
    assert.ok(area.version.queryState.startsWith("operations-v1-"));
  }
  const inventory = reportDefinitions.find(area => area.id === "inventory")!;
  assert.ok(inventory.output.some(field => field.name === "stockMovementEventsByKindAndUnit"));
  assert.ok(inventory.inclusionRules.some(rule => rule.includes("actualQuantity - deliveredQuantity - (returnedQuantity - returnedDeliveredQuantity)")));
  const collections = reportDefinitions.find(area => area.id === "delivery-collections")!;
  assert.ok(collections.output.some(field => field.name === "reversedCount"));
  assert.ok(collections.inclusionRules.some(rule => rule.includes("reversed treatment is excluded")));
});

test("report date parser supports the mounted UI aliases and fromDate/throughDate", () => {
  assert.deepEqual(parseReportParams({ area: "cash-ledger", from: "2026-09-01", to: "2026-09-30" }), {
    area: "cash-ledger",
    from: "2026-09-01",
    to: "2026-09-30",
  });
  assert.deepEqual(parseReportParams({ area: "cash-ledger", fromDate: "2026-09-01", throughDate: "2026-09-30" }), {
    area: "cash-ledger",
    from: "2026-09-01",
    to: "2026-09-30",
  });
  assert.throws(() => parseReportParams({ area: "cash-ledger", fromDate: "2026-10-01", throughDate: "2026-09-30" }), /anterior o igual/);
  assert.throws(() => parseReportParams({ area: "cash-ledger", from: "2026-09-01", fromDate: "2026-09-02" }), /nombres alternativos/);
});

test("report periods follow Buenos Aires civil dates across UTC midnight", () => {
  const afterUtcMidnight = new Date("2026-10-02T00:30:00.000Z");
  assert.equal(reportTodayCivilDate(afterUtcMidnight), "2026-10-01");

  const bounds = reportPeriodDateBounds({ from: "2026-10-01", to: "2026-10-01" });
  assert.equal(bounds.gte?.toISOString(), "2026-10-01T03:00:00.000Z");
  assert.equal(bounds.lt?.toISOString(), "2026-10-02T03:00:00.000Z");
});

test("report areas advertise only scopes their query sources can enforce", () => {
  assert.equal(supportsReportScope("cash-ledger", { accountIds: ["a"] }), true);
  assert.equal(supportsReportScope("product-contribution", { memberIds: ["m"] }), true);
  assert.equal(supportsReportScope("inventory", { locationIds: ["l"] }), true);
  assert.equal(supportsReportScope("inventory", { custodianIds: ["c"] }), true);
  assert.equal(supportsReportScope("cash-ledger", { memberIds: ["m"] }), false);
  assert.equal(supportsReportScope("operating-expenses", { accountIds: [] }), false);
});

test("customer segmentation uses all confirmed history through the inclusive Buenos Aires as-of date", () => {
  const query = customerSegmentationQueryContract(
    { from: "2026-01-01", to: "2026-09-30" },
    { memberIds: ["member-a"] },
  );

  assert.equal(query.asOfDate, "2026-09-30");
  assert.equal(query.where.confirmedAt.lt.toISOString(), "2026-10-01T03:00:00.000Z");
  assert.equal("gte" in query.where.confirmedAt, false);
  assert.deepEqual(query.where.memberId, { in: ["member-a"] });
  assert.deepEqual(query.where.fulfillmentState, { not: "cancelled" });
});

test("pending AppSheet captures stay outside official reports while generic orders remain included", { skip: !reportTestSchema }, async t => {
  t.after(async () => {
    await reportTestSchema!.db.operationOrderLine.deleteMany({ where: { id: { in: ["utc-boundary-generic-line", "pending-appsheet-line", "unknown-appsheet-line", "v2-calculated-a-line", "v2-calculated-b-line", "v2-missing-moto-line", "legacy-v1-moto-line", "staff-confirmed-a-line", "staff-confirmed-b-line", "staff-version-zero-line", "staff-version-mismatch-line"] } } });
    await reportTestSchema!.db.operationOrder.deleteMany({ where: { id: { in: ["utc-boundary-order", "pending-appsheet-order", "pending-only-appsheet-order", "unknown-appsheet-order", "v2-calculated-appsheet-order", "v2-missing-moto-order", "legacy-v1-moto-order", "staff-confirmed-appsheet-order", "staff-version-zero-order", "staff-version-mismatch-order"] } } });
    await reportTestSchema!.db.operationMember.deleteMany({ where: { id: { in: ["utc-boundary-member", "pending-only-member", "staff-confirmed-member", "staff-version-member"] } } });
    await reportTestSchema!.db.user.deleteMany({ where: { id: "report-export-owner" } });
    await reportTestSchema!.db.historicalDeliverySale.deleteMany({ where: { sourceSystem: "report-contract-boundary" } });
  });
  const fixture = new Date("2026-10-02T00:30:00.000Z");
  const civilDate = reportQueries.reportTodayCivilDate(fixture);
  assert.equal(civilDate, "2026-10-01");

  await reportTestSchema!.db.operationMember.create({
    data: { id: "utc-boundary-member", name: "Report fixture member", address: {}, preferences: {} },
  });
  await reportTestSchema!.db.operationMember.create({
    data: { id: "pending-only-member", name: "Pending invoice fixture", address: {}, preferences: {} },
  });
  await reportTestSchema!.db.operationMember.create({
    data: { id: "staff-confirmed-member", name: "Confirmed invoice fixture", address: {}, preferences: {} },
  });
  await reportTestSchema!.db.operationMember.create({
    data: { id: "staff-version-member", name: "Invoice version fixture", address: {}, preferences: {} },
  });
  await reportTestSchema!.db.operationOrder.create({
    data: {
      id: "utc-boundary-order",
      memberId: "utc-boundary-member",
      channel: "local",
      currency: "ARS",
      commercialState: "confirmed",
      quote: {},
      subtotalMinor: 5_500_000n,
      totalMinor: 5_500_000n,
      fulfillmentState: "delivered",
      address: {},
      createdBy: "report-contract-fixture",
      confirmedAt: fixture,
    },
  });
  await reportTestSchema!.db.operationOrder.create({
    data: {
      id: "pending-appsheet-order",
      memberId: "utc-boundary-member",
      channel: "local",
      currency: "ARS",
      commercialState: "confirmed",
      fulfillmentState: "delivered",
      quote: {
        source: "appsheet-invoice",
        capturedBaseMinor: "190000700",
        capturedProductMinor: "190000000",
        subtotalMinor: null,
        totalMinor: null,
        subtotalCalculationState: "pending_definition",
        totalCalculationState: "pending_definition",
      },
      subtotalMinor: 190_000_000n,
      deliveryMinor: 700n,
      totalMinor: 190_000_700n,
      address: {},
      createdBy: "report-contract-fixture",
      confirmedAt: fixture,
    },
  });
  await reportTestSchema!.db.operationOrder.create({
    data: {
      id: "pending-only-appsheet-order",
      memberId: "pending-only-member",
      channel: "local",
      currency: "ARS",
      commercialState: "confirmed",
      fulfillmentState: "delivered",
      quote: {
        source: "appsheet-invoice",
        capturedBaseMinor: "490",
        capturedProductMinor: "490",
        subtotalMinor: null,
        totalMinor: null,
        subtotalCalculationState: "pending_definition",
        totalCalculationState: "pending_definition",
      },
      subtotalMinor: 490n,
      totalMinor: 490n,
      address: {},
      createdBy: "report-contract-fixture",
      confirmedAt: new Date("2026-09-30T15:00:00.000Z"),
    },
  });
  await reportTestSchema!.db.operationOrder.create({
    data: {
      id: "unknown-appsheet-order", memberId: "utc-boundary-member", channel: "local", currency: "ARS",
      commercialState: "confirmed", fulfillmentState: "delivered",
      quote: { source: "appsheet-invoice", capturedBaseMinor: "900", capturedProductMinor: "800", totalCalculationState: "future-review" },
      subtotalMinor: 800n, totalMinor: 900n, deliveryMinor: 100n, address: {}, createdBy: "report-contract-fixture", confirmedAt: fixture,
    },
  });
  await reportTestSchema!.db.operationOrder.create({
    data: {
      id: "v2-calculated-appsheet-order", memberId: "utc-boundary-member", channel: "delivery", currency: "ARS",
      commercialState: "confirmed", fulfillmentState: "delivered", subtotalMinor: 1_000n, surchargeMinor: 50n, deliveryMinor: 315n, totalMinor: 1_365n,
      quote: {
        source: "appsheet-invoice", currency: "ARS", capturedBaseMinor: "1300", capturedProductMinor: "1000",
        subtotalMinor: "1000", totalMinor: "1365", subtotalCalculationState: "defined", totalCalculationState: "defined",
        totalCalculationSource: "appsheet_recalculation_action",
        appSheetFormula: { ruleVersion: "appsheet-invoice-rules/v2", results: { Subtotal_Cliente_Moto: "315" } },
        paymentComponents: {
          products: { paymentMethod: "transfer", transferMinor: "50", totalMinor: "1050" },
          moto: { paymentMethod: "transfer", clientTariffMinor: "300", transferMinor: "15", clientSubtotalMinor: "315" },
        },
      },
      address: {}, createdBy: "report-contract-fixture", confirmedAt: fixture,
    },
  });
  await reportTestSchema!.db.operationOrder.create({
    data: {
      id: "legacy-v1-moto-order", memberId: "utc-boundary-member", channel: "delivery", currency: "ARS",
      commercialState: "confirmed", fulfillmentState: "delivered", subtotalMinor: 400n, deliveryMinor: 75n, totalMinor: 475n,
      quote: {
        source: "appsheet-invoice", currency: "ARS", capturedBaseMinor: "475", capturedProductMinor: "400",
        subtotalMinor: "400", totalMinor: "475", subtotalCalculationState: "defined", totalCalculationState: "defined",
        appSheetFormula: { ruleVersion: "appsheet-invoice-rules/v1" },
        paymentComponents: { products: { paymentMethod: "cash", totalMinor: "400" }, moto: { paymentMethod: "cash", clientTotalMinor: "75" } },
      },
      address: {}, createdBy: "report-contract-fixture", confirmedAt: fixture,
    },
  });
  await reportTestSchema!.db.operationOrder.create({
    data: {
      id: "v2-missing-moto-order", memberId: "utc-boundary-member", channel: "delivery", currency: "ARS",
      commercialState: "confirmed", fulfillmentState: "delivered", subtotalMinor: 400n, deliveryMinor: 100n, totalMinor: 500n,
      quote: {
        source: "appsheet-invoice", currency: "ARS", capturedBaseMinor: "500", capturedProductMinor: "400",
        subtotalMinor: "400", totalMinor: "500", subtotalCalculationState: "defined", totalCalculationState: "defined",
        appSheetFormula: { ruleVersion: "appsheet-invoice-rules/v2" },
        // A v2 snapshot must not fall back to this old field when its v2 value is missing.
        paymentComponents: { products: { paymentMethod: "cash", totalMinor: "400" }, moto: { paymentMethod: "cash", clientTotalMinor: "100" } },
      },
      address: {}, createdBy: "report-contract-fixture", confirmedAt: fixture,
    },
  });
  await reportTestSchema!.db.operationOrder.create({
    data: {
      id: "staff-confirmed-appsheet-order", memberId: "staff-confirmed-member", channel: "local", currency: "ARS",
      commercialState: "confirmed", fulfillmentState: "delivered", quoteVersion: 1, subtotalMinor: 1_000n, deliveryMinor: 700n, totalMinor: 1_350n,
      quote: {
        source: "appsheet-invoice", currency: "ARS", capturedBaseMinor: "1_700", capturedProductMinor: "1_000",
        subtotalMinor: null, totalMinor: "1350", subtotalCalculationState: "pending_definition", totalCalculationState: "staff_confirmed",
        totalCalculationSource: "staff_confirmation",
        financialResolution: { kind: "staff_confirmation", currency: "ARS", productsTotalMinor: "1050", motoClientTotalMinor: "300", totalMinor: "1350", evidence: { note: "fixture evidence" }, actorId: "report-export-owner", confirmedAt: fixture.toISOString(), quoteVersion: 1, snapshotHash: "a".repeat(64) },
        paymentComponents: { products: { paymentMethod: "transfer", totalMinor: "1050" }, moto: { paymentMethod: "cash", clientTotalMinor: "300" } },
      },
      address: {}, createdBy: "report-contract-fixture", confirmedAt: fixture,
    },
  });
  for (const [id, resolutionVersion] of [["staff-version-zero-order", 0], ["staff-version-mismatch-order", 2]] as const) {
    await reportTestSchema!.db.operationOrder.create({
      data: {
        id, memberId: "staff-version-member", channel: "local", currency: "ARS",
        commercialState: "confirmed", fulfillmentState: "delivered", quoteVersion: 1,
        subtotalMinor: 200n, deliveryMinor: 50n, totalMinor: 250n,
        quote: {
          source: "appsheet-invoice", currency: "ARS", capturedBaseMinor: "250", capturedProductMinor: "200",
          subtotalMinor: null, totalMinor: "250", subtotalCalculationState: "pending_definition", totalCalculationState: "staff_confirmed",
          totalCalculationSource: "staff_confirmation",
          financialResolution: { kind: "staff_confirmation", currency: "ARS", productsTotalMinor: "200", motoClientTotalMinor: "50", totalMinor: "250", evidence: { note: "fixture evidence" }, actorId: "report-export-owner", confirmedAt: "2026-10-02T15:00:00.000Z", quoteVersion: resolutionVersion, snapshotHash: "b".repeat(64) },
          paymentComponents: { products: { paymentMethod: "transfer", totalMinor: "200" }, moto: { paymentMethod: "cash", clientTotalMinor: "50" } },
        },
        address: {}, createdBy: "report-contract-fixture", confirmedAt: new Date("2026-10-02T15:00:00.000Z"),
      },
    });
  }
  await reportTestSchema!.db.operationOrderLine.createMany({
    data: [
      {
        id: "utc-boundary-generic-line", orderId: "utc-boundary-order", skuId: "generic-sku", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 5_500_000n, revenueMinor: 5_500_000n,
      },
      {
        id: "pending-appsheet-line", orderId: "pending-appsheet-order", skuId: "pending-sku", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 190_000_000n, revenueMinor: 190_000_000n,
      },
      {
        id: "unknown-appsheet-line", orderId: "unknown-appsheet-order", skuId: "unknown-sku", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 800n, revenueMinor: 800n,
      },
      {
        id: "v2-calculated-a-line", orderId: "v2-calculated-appsheet-order", skuId: "v2-sku-a", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 400n, revenueMinor: 400n,
      },
      {
        id: "v2-calculated-b-line", orderId: "v2-calculated-appsheet-order", skuId: "v2-sku-b", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 600n, revenueMinor: 600n,
      },
      {
        id: "legacy-v1-moto-line", orderId: "legacy-v1-moto-order", skuId: "legacy-v1-sku", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 400n, revenueMinor: 400n,
      },
      {
        id: "v2-missing-moto-line", orderId: "v2-missing-moto-order", skuId: "v2-missing-sku", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 400n, revenueMinor: 400n,
      },
      {
        id: "staff-confirmed-a-line", orderId: "staff-confirmed-appsheet-order", skuId: "staff-sku-a", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 400n, revenueMinor: 400n,
      },
      {
        id: "staff-confirmed-b-line", orderId: "staff-confirmed-appsheet-order", skuId: "staff-sku-b", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 600n, revenueMinor: 600n,
      },
      {
        id: "staff-version-zero-line", orderId: "staff-version-zero-order", skuId: "staff-version-sku", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 200n, revenueMinor: 200n,
      },
      {
        id: "staff-version-mismatch-line", orderId: "staff-version-mismatch-order", skuId: "staff-version-sku", unit: "g",
        requested: "1", delivered: "1", unitPrice: "1", referenceMinor: 200n, revenueMinor: 200n,
      },
    ],
  });
  await reportTestSchema!.db.historicalDeliverySale.createMany({
    data: [
      {
        id: "utc-boundary-history-in",
        sourceSystem: "report-contract-boundary",
        sourceId: "in-civil-day",
        factHash: "in-civil-day",
        saleDate: new Date("2026-10-01T00:00:00.000Z"),
        totalCents: 1234n,
      },
      {
        id: "utc-boundary-history-out",
        sourceSystem: "report-contract-boundary",
        sourceId: "next-civil-day",
        factHash: "next-civil-day",
        saleDate: new Date("2026-10-02T00:00:00.000Z"),
        totalCents: 5678n,
      },
    ],
  });

  const report = await reportTestSchema!.queries.queryOperationsReport(
    "sales-revenue",
    { from: civilDate, to: civilDate },
  );
  assert.equal(report.metrics.operational.confirmedOrderCount, 5);
  assert.deepEqual(report.metrics.operational.orderTotalByCurrency, [{ currency: "ARS", minor: "5503690" }]);
  assert.deepEqual(report.metrics.pendingAppSheetInvoices.capturedBaseMinorByCurrency, [{ currency: "ARS", minor: "190001600" }]);
  assert.deepEqual(report.metrics.pendingAppSheetInvoices.capturedProductLineMinorByCurrency, [{ currency: "ARS", minor: "190000800" }]);
  assert.deepEqual(report.metrics.pendingAppSheetInvoices.capturedClientTariffMinorByCurrency, [{ currency: "ARS", minor: "800" }]);
  assert.equal(report.metrics.pendingAppSheetInvoices.totalMinorByCurrency, null);
  assert.equal(report.metrics.pendingAppSheetInvoices.recognizedAsSalesRevenue, false);
  assert.equal(report.metrics.staffConfirmedAppSheetInvoices.count, 1);
  assert.equal(report.metrics.staffConfirmedAppSheetInvoices.invalidResolutionCount, 0);
  assert.deepEqual(report.metrics.staffConfirmedAppSheetInvoices.invoiceTotalMinorByCurrency, [{ currency: "ARS", minor: "1350" }]);
  assert.deepEqual(report.metrics.staffConfirmedAppSheetInvoices.productsTotalMinorByCurrency, [{ currency: "ARS", minor: "1050" }]);
  assert.deepEqual(report.metrics.staffConfirmedAppSheetInvoices.motoClientTotalMinorByCurrency, [{ currency: "ARS", minor: "300" }]);
  assert.deepEqual(report.metrics.staffConfirmedAppSheetInvoices.unallocatedProductDeltaMinorByCurrency, [{ currency: "ARS", minor: "50" }]);
  assert.equal(report.metrics.operational.netProductRevenueByCurrency, null);
  assert.deepEqual(report.metrics.operational.lineBasisNetProductRevenueByCurrency, [{ currency: "ARS", minor: "5502800" }]);
  assert.equal(report.metrics.historicalDelivery.saleCount, 1);

  const products = await reportTestSchema!.queries.queryOperationsReport("product-contribution", { from: civilDate, to: civilDate });
  assert.equal(products.metrics.deliveredLineCount, 7);
  assert.deepEqual(products.metrics.pendingAppSheetInvoices.capturedProductLineMinorByCurrency, [{ currency: "ARS", minor: "190000800" }]);
  assert.deepEqual(products.metrics.recognizedDeliveryAndSurchargeByCurrency, [{ currency: "ARS", minor: "840" }]);
  assert.deepEqual(products.metrics.pendingAppSheetDeliveryTariffByCurrency, [{ currency: "ARS", minor: "800" }]);
  assert.equal(products.metrics.pendingAppSheetDeliveryTariffRecognized, false);
  assert.equal(products.metrics.productAmountAttributionComplete, false);
  assert.deepEqual(products.metrics.staffConfirmedAppSheetInvoices.unallocatedProductDeltaMinorByCurrency, [{ currency: "ARS", minor: "50" }]);

  const invalidVersionReport = await reportTestSchema!.queries.queryOperationsReport(
    "sales-revenue", { from: "2026-10-02", to: "2026-10-02" }, { memberIds: ["staff-version-member"] },
  );
  assert.equal(invalidVersionReport.metrics.staffConfirmedAppSheetInvoices.count, 2);
  assert.equal(invalidVersionReport.metrics.staffConfirmedAppSheetInvoices.invalidResolutionCount, 2);
  assert.equal(invalidVersionReport.metrics.staffConfirmedAppSheetInvoices.unallocatedProductInvoiceCount, 0);
  assert.deepEqual(invalidVersionReport.metrics.staffConfirmedAppSheetInvoices.unallocatedProductDeltaMinorByCurrency, [{ currency: "ARS", minor: "0" }]);
  const invalidVersionSegmentation = await reportTestSchema!.queries.queryOperationsReport(
    "customer-segmentation", { from: "2026-10-02", to: "2026-10-02" }, { memberIds: ["staff-version-member"] },
  );
  assert.equal(invalidVersionSegmentation.metrics.currentOperationOrderCount, 2);
  assert.equal(invalidVersionSegmentation.metrics.pendingAppSheetInvoiceOrderCount, 0);
  assert.equal(invalidVersionSegmentation.metrics.sourceRowsComplete, true);
  assert.equal(invalidVersionSegmentation.metrics.segmentationDataComplete, false);
  assert.equal(invalidVersionSegmentation.metrics.staffConfirmedProductAllocationMemberCount, 1);
  assert.equal(invalidVersionSegmentation.metrics.staffConfirmedProductAllocationOrderCount, 2);
  assert.deepEqual(invalidVersionSegmentation.metrics.segmentCounts, [
    { segment: "insufficient-data", memberCount: null, suppressed: true },
  ]);
  assert.ok(invalidVersionSegmentation.coverage.some(row => row.source === "staff-confirmed-unallocated-product-segmentation-inputs"
    && row.state === "partial" && row.knownCount === 0 && row.expectedCount === 2));

  const segmentation = await reportTestSchema!.queries.queryOperationsReport("customer-segmentation", { from: civilDate, to: civilDate });
  // The five confirmed fixtures also supply the current-operation population as of this date.
  assert.equal(segmentation.metrics.currentOperationOrderCount, 5);
  assert.equal(segmentation.metrics.sourceRowsComplete, true);
  assert.equal(segmentation.metrics.segmentationSummaryComplete, true);
  assert.equal(segmentation.metrics.segmentationDataComplete, false);
  assert.equal(segmentation.metrics.pendingAppSheetInvoiceMemberCount, 2);
  assert.equal(segmentation.metrics.pendingAppSheetInvoiceOrderCount, 3);
  assert.deepEqual(segmentation.metrics.segmentCounts, [
    { segment: "insufficient-data", memberCount: null, suppressed: true },
    { segment: "no-purchase-history", memberCount: null, suppressed: true },
  ]);
  assert.equal(segmentation.metrics.staffConfirmedProductAllocationMemberCount, 1);
  assert.equal(segmentation.metrics.staffConfirmedProductAllocationOrderCount, 1);
  assert.ok(segmentation.coverage.some(row => row.source === "pending-appsheet-invoice-segmentation-inputs"
    && row.state === "partial" && row.knownCount === 0 && row.expectedCount === 3));
  const manualOnlySegmentation = await reportTestSchema!.queries.queryOperationsReport(
    "customer-segmentation", { from: civilDate, to: civilDate }, { memberIds: ["staff-confirmed-member"] },
  );
  assert.equal(manualOnlySegmentation.metrics.currentOperationOrderCount, 1);
  assert.equal(manualOnlySegmentation.metrics.pendingAppSheetInvoiceOrderCount, 0);
  assert.equal(manualOnlySegmentation.metrics.sourceRowsComplete, true);
  assert.equal(manualOnlySegmentation.metrics.segmentationDataComplete, false);
  assert.equal(manualOnlySegmentation.metrics.staffConfirmedProductAllocationMemberCount, 1);
  assert.equal(manualOnlySegmentation.metrics.staffConfirmedProductAllocationOrderCount, 1);
  assert.deepEqual(manualOnlySegmentation.metrics.segmentCounts, [
    { segment: "insufficient-data", memberCount: null, suppressed: true },
  ]);
  assert.ok(manualOnlySegmentation.coverage.some(row => row.source === "staff-confirmed-unallocated-product-segmentation-inputs"
    && row.state === "partial" && row.knownCount === 0 && row.expectedCount === 1));

  process.env.JWT_SECRET ??= "report-contract-export-test-secret-0123456789";
  const exportActor = await reportTestSchema!.db.user.create({ data: { id: "report-export-owner", name: "Report export fixture", email: "report-export-owner@example.test", password: "fixture-hash", role: "owner" } });
  const express = (await import("express")).default;
  const { operationsExports } = await import("../server/operations/report-exports.js");
  const app = express();
  app.use((req, _res, next) => { (req as typeof req & { user: typeof exportActor }).user = exportActor; next(); });
  app.use("/exports", operationsExports);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const address = server.address() as AddressInfo;
  let cursor: string | null = null;
  const exportedRows: Array<Record<string, string>> = [];
  do {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`http://127.0.0.1:${address.port}/exports/sales-lines?from=${civilDate}&to=${civilDate}&limit=1${cursorParam}`);
    assert.equal(response.status, 200, await response.clone().text());
    const block = await response.json() as { csv: string; nextCursor: string | null; coverage: { queryVersion: string } };
    assert.equal(block.coverage.queryVersion, "canonical-csv-v3");
    exportedRows.push(...parseCsv(block.csv, { bom: true, columns: true, skip_empty_lines: true }) as Array<Record<string, string>>);
    cursor = block.nextCursor;
  } while (cursor);
  const manualExportRows = exportedRows.filter(row => row.objectId === "staff-confirmed-appsheet-order");
  assert.equal(manualExportRows.length, 2);
  assert.equal(manualExportRows[0]!.invoiceTotalMinor, "1350");
  assert.equal(manualExportRows[0]!.invoiceMotoClientTotalMinor, "300");
  assert.equal(manualExportRows[0]!.invoiceTotalCalculationSource, "staff_confirmation");
  assert.equal(manualExportRows[0]!.invoiceUnallocatedProductDeltaMinor, "50");
  assert.equal(manualExportRows[0]!.invoiceSnapshotHash, "a".repeat(64));
  assert.equal(manualExportRows[1]!.invoiceTotalMinor, "");
  assert.equal(manualExportRows[1]!.invoiceMotoClientTotalMinor, "");
  assert.equal(exportedRows.find(row => row.objectId === "unknown-appsheet-order")!.kind, "captured-product-line");

  const calculatedV2Rows = exportedRows.filter(row => row.objectId === "v2-calculated-appsheet-order");
  assert.equal(calculatedV2Rows.length, 2);
  const calculatedV2Invoice = calculatedV2Rows.find(row => row.invoiceTotalMinor !== "")!;
  assert.equal(calculatedV2Invoice.invoiceTotalMinor, "1365");
  assert.equal(calculatedV2Invoice.invoiceProductsTotalMinor, "1050");
  assert.equal(calculatedV2Invoice.invoiceMotoClientTotalMinor, "315");
  assert.deepEqual(calculatedV2Rows.map(row => row.amountMinor), ["400", "600"]);
  assert.deepEqual(calculatedV2Rows.map(row => row.quantity), ["1", "1"]);
  assert.equal(calculatedV2Rows.filter(row => row.invoiceMotoClientTotalMinor !== "").length, 1);

  const legacyV1Invoice = exportedRows.find(row => row.objectId === "legacy-v1-moto-order")!;
  assert.equal(legacyV1Invoice.invoiceTotalMinor, "475");
  assert.equal(legacyV1Invoice.invoiceMotoClientTotalMinor, "75");

  const incompleteV2Invoice = exportedRows.find(row => row.objectId === "v2-missing-moto-order")!;
  assert.equal(incompleteV2Invoice.invoiceTotalMinor, "500");
  assert.equal(incompleteV2Invoice.invoiceMotoClientTotalMinor, "");

  const { memberHistory } = await import("../server/operations/member-history.js");
  const history = await memberHistory("utc-boundary-member", 10);
  const genericHistoryOrder = history.orders.find(order => order.id === "utc-boundary-order")!;
  assert.equal(genericHistoryOrder.totalMinor, 5_500_000n);
  assert.equal(genericHistoryOrder.subtotalMinor, 5_500_000n);
  assert.equal(genericHistoryOrder.productMinor, 5_500_000n);
  const pendingHistoryOrder = history.orders.find(order => order.id === "pending-appsheet-order")!;
  assert.equal(pendingHistoryOrder.totalMinor, null);
  assert.equal(pendingHistoryOrder.subtotalMinor, null);
  assert.equal(pendingHistoryOrder.productMinor, null);
  assert.equal(pendingHistoryOrder.capturedBaseMinor, "190000700");
  assert.equal(pendingHistoryOrder.capturedProductMinor, "190000000");
  assert.equal(pendingHistoryOrder.totalCalculationState, "pending_definition");
  assert.equal("quote" in pendingHistoryOrder, false);
});

test("cancelled demand and customer returns do not inflate spend, months or recency", () => {
  const base = { memberId: "m", currency: "ARS", subtotalMinor: 300000000n, discountMinor: 0n, refundedMinor: 0n, confirmedAt: new Date("2026-09-29T15:00:00Z"), fulfillmentState: "unprepared" };
  const full = { ...base, fulfillmentState: "cancelled", lines: [{ unit: "g", requested: "10", cancelled: "10", delivered: "0", revenueMinor: 300000000n }] };
  assert.deepEqual([...aggregateCustomerSegmentationProfiles([{ id: "m" }], [full], "2026-09-30")], [["no-purchase-history", 1]]);
  const half = { ...base, lines: [{ unit: "g", requested: "10", cancelled: "5", delivered: "5", revenueMinor: 300000000n }] };
  assert.deepEqual([...aggregateCustomerSegmentationProfiles([{ id: "m" }], [half], "2026-09-30")], [["occasional", 1]]);
  const returned = { ...base, fulfillmentState: "delivered", refundedMinor: 150000000n, lines: [{ unit: "g", requested: "10", cancelled: "0", delivered: "10", returnedBilled: "5", revenueMinor: 300000000n }] };
  assert.deepEqual([...aggregateCustomerSegmentationProfiles([{ id: "m" }], [returned], "2026-09-30")], [["occasional", 1]]);
  const old = { ...half, confirmedAt: new Date("2026-06-01T15:00:00Z") };
  assert.deepEqual([...aggregateCustomerSegmentationProfiles([{ id: "m" }], [old, full], "2026-09-30")], [["recency-priority", 1]]);
});

test("reversed collection credits are excluded from both spendable and refundable open balances", () => {
  assert.deepEqual(summarizeMemberCreditBalances([
    { treatment: "member_credit", currency: "ARS", amountMinor: 1_000n, resolvedMinor: 250n },
    { treatment: "refund_due", currency: "USD", amountMinor: 500n, resolvedMinor: 100n },
    { treatment: "reversed", currency: "ARS", amountMinor: 9_999n, resolvedMinor: 0n },
  ]), {
    spendableMemberCreditOpenByCurrency: [{ currency: "ARS", minor: "750" }],
    refundDueOpenByCurrency: [{ currency: "USD", minor: "400" }],
    spendableOpenCount: 1,
    refundDueOpenCount: 1,
    reversedCount: 1,
    unclassifiedCount: 0,
    invalidCount: 0,
  });
});

test("stock fact summaries keep waste, signed count adjustments, and internal transfers distinct", () => {
  assert.deepEqual(summarizeStockFactMovements([
    { kind: "waste", quantity: "2.5", unit: "g" },
    { kind: "count_adjustment", quantity: "-1.25", unit: "g" },
    { kind: "transfer", quantity: "3", unit: "g" },
    { kind: "transfer_internal", quantity: "1", unit: "g" },
    { kind: "waste", quantity: "-1", unit: "g" },
  ]), {
    byKindAndUnit: [
      { kind: "count_adjustment", meaning: "signed-count-difference", unit: "g", eventCount: 1, recordedQuantity: "-1.25" },
      { kind: "transfer_internal", meaning: "internal-transfer-flow-not-club-wide-loss", unit: "g", eventCount: 1, recordedQuantity: "1" },
      { kind: "transfer", meaning: "internal-transfer-flow-not-club-wide-loss", unit: "g", eventCount: 1, recordedQuantity: "3" },
      { kind: "waste", meaning: "positive-waste-quantity", unit: "g", eventCount: 1, recordedQuantity: "2.5" },
    ],
    invalidCount: 1,
  });
});

test("report metrics and period fingerprints cover populations beyond ten thousand rows", { skip: !reportTestSchema }, async () => {
  const amount = 9_007_199_254_740_993n;
  await reportTestSchema!.db.$executeRawUnsafe(`
    INSERT INTO "OperationMember" ("id", "name", "address", "preferences")
    VALUES ('member-a', 'Fixture', '{}'::jsonb, '{}'::jsonb), ('member-b', 'Fixture', '{}'::jsonb, '{}'::jsonb)
  `);
  await reportTestSchema!.db.$executeRawUnsafe(`
    INSERT INTO "OperationMember" ("id", "name", "address", "preferences")
    SELECT 'segment-no-history-' || lpad(n::text, 5, '0'), 'Fixture', '{}'::jsonb, '{}'::jsonb
    FROM generate_series(1, 10000) AS n
  `);
  await reportTestSchema!.db.$executeRawUnsafe(`
    INSERT INTO "OperationOrder" ("id", "memberId", "channel", "currency", "commercialState", "quote", "subtotalMinor", "totalMinor", "fulfillmentState", "address", "createdBy", "confirmedAt")
    SELECT 'metric-order-' || lpad(n::text, 5, '0'), 'member-a', 'local', 'ARS', 'confirmed', '{}'::jsonb, ${amount.toString()}::bigint, ${amount.toString()}::bigint, 'delivered', '{}'::jsonb, 'test-actor', '2026-09-15 12:00:00'::timestamp
    FROM generate_series(1, 10001) AS n
  `);
  await reportTestSchema!.db.$executeRawUnsafe(`
    INSERT INTO "OperationOrderLine" ("id", "orderId", "skuId", "unit", "requested", "delivered", "unitPrice", "referenceMinor", "revenueMinor")
    SELECT 'metric-line-' || lpad(n::text, 5, '0'), 'metric-order-' || lpad(n::text, 5, '0'), 'sku-a', 'g', 1, 1, 1, ${amount.toString()}::bigint, ${amount.toString()}::bigint
    FROM generate_series(1, 10001) AS n
  `);
  await reportTestSchema!.db.$executeRawUnsafe(`
    INSERT INTO "OperationOrder" ("id", "memberId", "channel", "currency", "commercialState", "quote", "subtotalMinor", "totalMinor", "fulfillmentState", "address", "createdBy", "confirmedAt")
    VALUES
      ('metric-order-other-member', 'member-b', 'local', 'USD', 'confirmed', '{}'::jsonb, 17, 17, 'delivered', '{}'::jsonb, 'test-actor', '2026-09-15 12:00:00'::timestamp),
      ('metric-order-cancelled', 'member-a', 'local', 'ARS', 'confirmed', '{}'::jsonb, 19, 19, 'cancelled', '{}'::jsonb, 'test-actor', '2026-09-15 12:00:00'::timestamp),
      ('metric-order-outside-period', 'member-a', 'local', 'ARS', 'confirmed', '{}'::jsonb, 23, 23, 'delivered', '{}'::jsonb, 'test-actor', '2026-08-15 12:00:00'::timestamp)
  `);
  await reportTestSchema!.db.$executeRawUnsafe(`
    INSERT INTO "OperationOrderLine" ("id", "orderId", "skuId", "unit", "requested", "delivered", "unitPrice", "referenceMinor", "revenueMinor")
    VALUES ('metric-line-other-member', 'metric-order-other-member', 'sku-a', 'g', 1, 1, 1, 17, 17)
  `);

  const report = await reportTestSchema!.queries.queryOperationsReport(
    "sales-revenue",
    { from: "2026-09-01", to: "2026-09-30" },
    { memberIds: ["member-a"] },
  );
  const total = (amount * 10001n).toString();
  assert.equal(report.metrics.operational.confirmedOrderCount, 10001);
  assert.deepEqual(report.metrics.operational.netProductRevenueByCurrency, [{ currency: "ARS", minor: total }]);
  assert.deepEqual(report.metrics.operational.orderTotalByCurrency, [{ currency: "ARS", minor: total }]);
  assert.equal(report.metrics.operationalChannels[0]?.orderCount, 10001);
  assert.equal(report.coverage.find(row => row.source === "operation-orders")?.queryComplete, true);

  await reportTestSchema!.db.$executeRawUnsafe(`
    INSERT INTO "PreparationAllocation" ("id", "orderId", "lineId", "lotId", "balanceId", "requestedQuantity", "actualQuantity", "deliveredQuantity", "returnedQuantity", "returnedDeliveredQuantity", "costMinor", "state")
    VALUES ('metric-return-1', 'metric-order-00001', 'metric-line-00001', 'test-lot', 'test-balance', 1, 1, 1, 0.5, 0.5, 0, 'delivered')
  `);
  const segmentation = await reportTestSchema!.queries.queryOperationsReport(
    "customer-segmentation",
    { to: "2026-09-30" },
  );
  assert.equal(segmentation.metrics.includedMemberCount, 10002);
  assert.equal(segmentation.metrics.visibleMemberRows, 10000);
  assert.equal(segmentation.metrics.memberRowsComplete, false);
  // Segmentation uses all retained history through `to`; the August fixture remains in scope.
  assert.equal(segmentation.metrics.currentOperationOrderCount, 10003);
  assert.equal(segmentation.metrics.visibleOperationOrderRows, 10000);
  assert.equal(segmentation.metrics.operationOrderRowsComplete, false);
  assert.equal(segmentation.metrics.sourceRowsComplete, true);
  assert.equal(segmentation.metrics.segmentationSummaryComplete, true);
  assert.deepEqual(segmentation.metrics.segmentCounts, [
    { segment: "high-spend", memberCount: null, suppressed: true },
    { segment: "insufficient-data", memberCount: null, suppressed: true },
    { segment: "no-purchase-history", memberCount: 10000, suppressed: false },
  ]);
  assert.equal(segmentation.coverage.find(row => row.source === "operation-members")?.queryComplete, false);
  assert.equal(segmentation.coverage.find(row => row.source === "confirmed-orders-for-segmentation")?.queryComplete, false);
  assert.deepEqual(
    [segmentation.coverage.find(row => row.source === "customer-segmentation-full-population")?.knownCount, segmentation.coverage.find(row => row.source === "customer-segmentation-full-population")?.expectedCount, segmentation.coverage.find(row => row.source === "customer-segmentation-full-population")?.queryComplete],
    [10002, 10002, true],
  );
  assert.equal(segmentation.coverage.find(row => row.source === "customer-return-allocations")?.expectedCount, 1);
  assert.equal(segmentation.coverage.find(row => row.source === "customer-return-allocations")?.queryComplete, true);

  const { getManagementPeriodCoverageSnapshot } = await import("../server/operations/period-coverage.js");
  const snapshot = await reportTestSchema!.db.$transaction(
    tx => getManagementPeriodCoverageSnapshot(tx, "2026-09"),
    { isolationLevel: "RepeatableRead", timeout: 30000 },
  );
  const orderPopulation = snapshot.populations.find(row => row.name === "confirmed-orders-with-delivered-lines");
  const linePopulation = snapshot.populations.find(row => row.name === "delivered-order-lines");
  assert.deepEqual([orderPopulation?.recordCount, orderPopulation?.observedCount, orderPopulation?.complete], [10002, 10002, true]);
  assert.deepEqual([linePopulation?.recordCount, linePopulation?.observedCount, linePopulation?.complete], [10002, 10002, true]);
  assert.equal(snapshot.queryComplete, true);
});

test("cash, expenses, purchases, delivery and scoped stock aggregate complete populations beyond the visible-row limit", { skip: !reportTestSchema }, async () => {
  const db = reportTestSchema!.db;
  await db.$executeRawUnsafe(`
    INSERT INTO "OperationAccount" ("id", "name", "currency", "kind", "holder", "purpose", "verified", "active", "openingMinor", "openingApprovedBy")
    VALUES ('volume-cash-account', 'Volume test', 'ARS', 'club', 'Fixture', 'Report contract', TRUE, TRUE, 0, 'reviewer')
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "OperationAccount" ("id", "name", "currency", "kind", "holder", "purpose", "verified", "active", "openingMinor", "openingApprovedBy")
    SELECT 'volume-cash-account-' || lpad(n::text, 5, '0'), 'Volume test', 'ARS', 'club', 'Fixture', 'Report contract', TRUE, TRUE, 0, 'reviewer'
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "LedgerEvent" ("id", "requestId", "kind", "occurredAt", "actorId", "sourceObjectId", "description", "metadata")
    SELECT 'volume-ledger-event-' || lpad(n::text, 5, '0'), gen_random_uuid(), 'cash_receipt', '2026-09-15 12:00:00'::timestamp,
      'fixture', 'volume', 'volume report fixture', '{}'::jsonb
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "LedgerLeg" ("id", "eventId", "accountId", "currency", "amountMinor")
    SELECT 'volume-ledger-leg-' || lpad(n::text, 5, '0'), 'volume-ledger-event-' || lpad(n::text, 5, '0'), 'volume-cash-account', 'ARS', 2
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "LedgerLeg" ("id", "eventId", "accountId", "currency", "amountMinor")
    SELECT 'volume-ledger-account-leg-' || lpad(n::text, 5, '0'), 'volume-ledger-event-' || lpad(n::text, 5, '0'), 'volume-cash-account-' || lpad(n::text, 5, '0'), 'ARS', 3
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "OperationAccount" ("id", "name", "currency", "kind", "holder", "purpose", "verified", "active", "openingMinor")
    VALUES
      ('volume-fx-account-ars', 'FX fixture ARS', 'ARS', 'club', 'Fixture', 'Report contract', TRUE, FALSE, 0),
      ('volume-fx-account-usd', 'FX fixture USD', 'USD', 'club', 'Fixture', 'Report contract', TRUE, FALSE, 0)
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "LedgerEvent" ("id", "requestId", "kind", "occurredAt", "actorId", "sourceObjectId", "description", "metadata")
    SELECT 'volume-fx-event-' || lpad(n::text, 5, '0'), gen_random_uuid(), 'fx', '2026-09-15 12:00:00'::timestamp,
      'fixture', 'volume-fx', 'volume report FX fixture',
      CASE WHEN n = 10001 THEN '{"rate":"1.5","differenceMinor":"0","commissionMinor":"invalid","evidence":{}}'::jsonb
        ELSE '{"rate":"1.5","differenceMinor":"0","commissionMinor":"0","evidence":{}}'::jsonb END
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "LedgerLeg" ("id", "eventId", "accountId", "currency", "amountMinor")
    SELECT 'volume-fx-leg-ars-' || lpad(n::text, 5, '0'), 'volume-fx-event-' || lpad(n::text, 5, '0'), 'volume-fx-account-ars', 'ARS', 1
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "LedgerLeg" ("id", "eventId", "accountId", "currency", "amountMinor")
    SELECT 'volume-fx-leg-usd-' || lpad(n::text, 5, '0'), 'volume-fx-event-' || lpad(n::text, 5, '0'), 'volume-fx-account-usd', 'USD', -1
    FROM generate_series(1, 10001) AS n
  `);

  await db.$executeRawUnsafe(`
    INSERT INTO "HistoricalExpense" ("id", "sourceSystem", "sourceId", "factHash", "expenseDate", "category", "amountCents")
    SELECT 'volume-historical-expense-' || lpad(n::text, 5, '0'), 'report-volume', 'expense-' || n, 'hash-' || n, '2026-09-15'::date, 'fixture', 3
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "Expense" ("id", "name", "amount", "category", "kind", "date")
    SELECT 'volume-compat-expense-' || lpad(n::text, 5, '0'), 'Fixture', 4, 'fixture', 'operating', '2026-09-15'
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "OperationPayable" ("id", "beneficiaryId", "kind", "currency", "amountMinor", "paidMinor", "dueDate", "accrualPeriod", "evidence", "verified")
    SELECT 'volume-expense-payable-' || lpad(n::text, 5, '0'), 'fixture', 'operating_expense', 'ARS', 11, 4, '2026-09-20', '2026-09', '{"costTreatment":"variable"}'::jsonb, TRUE
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "PayablePayment" ("id", "payableId", "accountId", "currency", "amountMinor", "appliedMinor", "date", "eventId")
    SELECT 'volume-expense-payment-' || lpad(n::text, 5, '0'), 'volume-expense-payable-' || lpad(n::text, 5, '0'), 'fixture', 'ARS', 5, 5, '2026-09-21', 'fixture-event'
    FROM generate_series(1, 10001) AS n
  `);

  await db.$executeRawUnsafe(`
    INSERT INTO "PurchaseOrder" ("id", "supplierId", "agreementDate", "currency", "totalMinor", "status", "items")
    SELECT 'volume-purchase-' || lpad(n::text, 5, '0'), 'fixture', '2026-09-15', 'USD', 13, 'received', '[]'::jsonb
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "GoodsReceipt" ("id", "purchaseId", "receivedDate", "receivedBy", "items", "evidence")
    SELECT 'volume-receipt-' || lpad(n::text, 5, '0'), 'volume-purchase-' || lpad(n::text, 5, '0'), '2026-09-16', 'fixture', '[]'::jsonb, '{}'::jsonb
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "HistoricalPurchaseReceipt" ("id", "sourceSystem", "sourceId", "factHash", "receivedDate", "totalCents")
    SELECT 'volume-historical-purchase-' || lpad(n::text, 5, '0'), 'report-volume', 'purchase-' || n, 'hash-' || n, '2026-09-16'::date, 7
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "OperationPayable" ("id", "purchaseId", "beneficiaryId", "kind", "currency", "amountMinor", "paidMinor", "dueDate", "evidence", "verified")
    SELECT 'volume-purchase-payable-' || lpad(n::text, 5, '0'), 'volume-purchase-' || lpad(n::text, 5, '0'), 'fixture', 'purchase', 'USD', 19, 4, '2026-09-20', '{}'::jsonb, TRUE
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "OperationPayable" ("id", "beneficiaryId", "kind", "currency", "amountMinor", "paidMinor", "dueDate", "evidence", "verified")
    SELECT 'volume-obligation-' || lpad(n::text, 5, '0'), 'fixture', 'operating_expense', 'ARS', 100, 0, '2026-10-01', '{}'::jsonb, TRUE
    FROM generate_series(1, 10001) AS n
  `);

  await db.$executeRawUnsafe(`
    INSERT INTO "DeliveryAssignment" ("id", "orderId", "status", "address", "incidents")
    SELECT 'volume-delivery-' || lpad(n::text, 5, '0'), 'volume-order-' || n, 'delivered', '{}'::jsonb, '[]'::jsonb
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "CollectionReport" ("id", "orderId", "reporterId", "method", "currency", "amountMinor", "custodianId", "evidence", "status", "verifiedBy", "verifiedAt", "appliedMinor", "excessMinor")
    SELECT 'volume-collection-' || lpad(n::text, 5, '0'), 'volume-order-' || n, 'fixture', 'cash', 'ARS', 23, 'custodian', '{}'::jsonb, 'verified', 'reviewer', '2026-09-17 12:00:00'::timestamp, 20, 3
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "Rendition" ("id", "driverId", "fromAccountId", "toAccountId", "currency", "grossMinor", "deliveredMinor", "feeMinor", "acceptedBy", "acceptedAt")
    SELECT 'volume-rendition-' || lpad(n::text, 5, '0'), 'driver', 'custody', 'club', 'ARS', 31, 29, 2, 'reviewer', '2026-09-17 12:00:00'::timestamp
    FROM generate_series(1, 10001) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "MemberCredit" ("id", "memberId", "collectionId", "currency", "amountMinor", "resolvedMinor", "treatment")
    SELECT 'volume-credit-' || lpad(n::text, 5, '0'), 'member', 'volume-collection-' || lpad(n::text, 5, '0'), 'ARS', 100, 25, 'member_credit'
    FROM generate_series(1, 10001) AS n
  `);

  await db.$executeRawUnsafe(`
    INSERT INTO "CatalogSku" ("id", "code", "name", "variety", "category", "unit")
    VALUES ('volume-sku', 'VOLUME', 'Volume fixture', 'test', 'test', 'g')
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "InventoryLot" ("id", "skuId", "receiptId", "label", "unit", "unitCost", "costCurrency", "receivedAt")
    SELECT 'volume-lot-' || lpad(n::text, 5, '0'), 'volume-sku', 'volume-receipt-' || lpad(n::text, 5, '0'), 'Volume lot', 'g', 2.5, 'ARS', '2026-09-16 12:00:00'::timestamp
    FROM generate_series(1, 10002) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "StockBalance" ("id", "lotId", "locationId", "custodianId", "unit", "quantity", "reserved")
    SELECT 'volume-balance-' || lpad(n::text, 5, '0'), 'volume-lot-' || lpad(n::text, 5, '0'), CASE WHEN n = 10002 THEN 'warehouse-b' ELSE 'warehouse-a' END, 'custodian', 'g', 2, 0.5
    FROM generate_series(1, 10002) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "StockFact" ("id", "requestId", "lotId", "kind", "quantity", "unit", "fromLocationId", "reason", "actorId", "occurredAt")
    SELECT gen_random_uuid(), gen_random_uuid(), 'volume-lot-' || lpad(n::text, 5, '0'), 'waste', 1, 'g',
      CASE WHEN n = 10002 THEN 'warehouse-b' ELSE 'warehouse-a' END, 'volume fixture', 'fixture', '2026-09-18 12:00:00'::timestamp
    FROM generate_series(1, 10002) AS n
  `);
  await db.$executeRawUnsafe(`
    INSERT INTO "PreparationAllocation" ("id", "orderId", "lineId", "lotId", "balanceId", "requestedQuantity", "actualQuantity", "deliveredQuantity", "returnedQuantity", "returnedDeliveredQuantity", "costMinor", "state")
    SELECT 'volume-allocation-' || lpad(n::text, 5, '0'), 'volume-custody-order', 'volume-custody-line', 'volume-lot-00001', 'volume-balance-00001', 1, 1, 0, 0, 0, 10, 'prepared'
    FROM generate_series(1, 10001) AS n
  `);

  const range = { from: "2026-09-01", to: "2026-09-30" };
  await db.operationalConfiguration.create({ data: {
    id: "volume-approved-cash-scenario", name: "Volume cash scenario", kind: "scenarios", version: 1,
    state: "approved", proposedBy: "fixture", approvedBy: "reviewer", approvedAt: new Date("2026-09-01T12:00:00Z"),
    validFrom: "2026-09-01", definition: { currency: "ARS", weeks: 13, items: [
      { id: "income", date: "2026-09-28", kind: "income", amountMinor: "2000000" },
      { id: "recorded-payment", date: "2026-09-28", kind: "payment", amountMinor: "100", commitmentId: " volume-obligation-10001 " },
    ] },
  } });
  const cash = await reportTestSchema!.queries.queryOperationsReport("cash-ledger", range);
  assert.equal(cash.metrics.ledgerLegRows, 40004);
  assert.equal(cash.metrics.accounts.length, 10000);
  assert.deepEqual(cash.metrics.clubAccountPeriodNetMovementByCurrency, [{ currency: "ARS", minor: "50005" }]);
  assert.equal(cash.coverage.find(row => row.source === "dated-ledger-legs")?.queryComplete, true);
  assert.deepEqual(
    [cash.coverage.find(row => row.source === "active-accounts")?.knownCount, cash.coverage.find(row => row.source === "active-accounts")?.expectedCount, cash.coverage.find(row => row.source === "active-accounts")?.queryComplete],
    [10000, 10002, false],
  );

  const obligations = await reportTestSchema!.queries.queryOperationsReport("obligations-13-weeks", range);
  assert.equal(obligations.metrics.payableSummaryComplete, true);
  assert.equal(obligations.metrics.invalidPayableDateCount, 0);
  assert.equal(obligations.metrics.invalidPayableCurrencyCount, 0);
  assert.equal(obligations.metrics.invalidPayableAmountCount, 0);
  assert.equal(obligations.metrics.payableRowsComplete, false);
  assert.equal(obligations.metrics.visiblePayableRows, 500);
  assert.equal(obligations.metrics.payableDetailLimit, 500);
  assert.equal(obligations.metrics.scenarioProjections.length, 1);
  const scenario = obligations.metrics.scenarioProjections[0]!;
  assert.equal(scenario.matchedExistingObligationCount, 1);
  assert.equal(scenario.includedItemCount, 1);
  assert.equal(scenario.weeks[0]!.openPayableMinor, "1000100");
  assert.equal(scenario.weeks[0]!.verifiedOpenPayableMinor, "1000100");
  assert.equal(scenario.weeks[0]!.netFlowAfterAllOpenPayablesMinor, "999900");
  const weekly = obligations.metrics.weekly as Array<{
    weekStart: string;
    obligationCount: number;
    verifiedCount: number;
    unverifiedCount: number;
    outstandingByCurrency: Array<{ currency: string; minor: string }>;
    verifiedOutstandingByCurrency: Array<{ currency: string; minor: string }>;
  }>;
  assert.equal(weekly.length, 13);
  const firstObligationWeek = weekly.find(row => row.weekStart === "2026-09-28");
  assert.deepEqual(firstObligationWeek && {
    obligationCount: firstObligationWeek.obligationCount,
    verifiedCount: firstObligationWeek.verifiedCount,
    unverifiedCount: firstObligationWeek.unverifiedCount,
    outstandingByCurrency: firstObligationWeek.outstandingByCurrency,
    verifiedOutstandingByCurrency: firstObligationWeek.verifiedOutstandingByCurrency,
  }, {
    obligationCount: 10001,
    verifiedCount: 10001,
    unverifiedCount: 0,
    outstandingByCurrency: [{ currency: "ARS", minor: "1000100" }],
    verifiedOutstandingByCurrency: [{ currency: "ARS", minor: "1000100" }],
  });
  assert.equal(obligations.coverage.find(row => row.source === "13-week-payables")?.queryComplete, true);
  assert.equal(obligations.coverage.find(row => row.source === "visible-13-week-payable-details")?.queryComplete, false);
  assert.equal(obligations.metrics.activeAccountRowsComplete, false);
  assert.equal(obligations.metrics.visibleActiveAccountRows, 10000);
  assert.equal(obligations.coverage.find(row => row.source === "club-and-custody-accounts")?.queryComplete, false);

  const fx = await reportTestSchema!.queries.queryOperationsReport("fx-reconciliation", range);
  const fxBytes = Buffer.byteLength(JSON.stringify(fx), "utf8");
  assert.ok(fxBytes <= 4_000_000, `the FX report must leave room below the Function response limit; observed ${fxBytes} bytes`);
  assert.equal(fx.metrics.conversionEventCount, 10001);
  assert.equal(fx.metrics.visibleConversionEventRows, 500);
  assert.equal(fx.metrics.fxEvents.length, 500);
  assert.equal(fx.metrics.conversionEventDetailLimit, 500);
  assert.equal(fx.metrics.conversionEventRowsComplete, false);
  assert.equal(fx.metrics.conversionEventSummaryComplete, true);
  assert.equal(fx.metrics.validatedPairedConversionCount, 10000);
  assert.equal(fx.metrics.invalidOrIncompleteFxEventCount, 1);
  assert.equal(fx.coverage.find(row => row.source === "fx-ledger-events")?.queryComplete, false);
  assert.deepEqual(
    [fx.coverage.find(row => row.source === "fx-events-with-complete-recorded-legs-and-metadata")?.knownCount, fx.coverage.find(row => row.source === "fx-events-with-complete-recorded-legs-and-metadata")?.expectedCount, fx.coverage.find(row => row.source === "fx-events-with-complete-recorded-legs-and-metadata")?.queryComplete, fx.coverage.find(row => row.source === "fx-events-with-complete-recorded-legs-and-metadata")?.state],
    [10000, 10001, true, "partial"],
  );

  const expenses = await reportTestSchema!.queries.queryOperationsReport("operating-expenses", range);
  assert.deepEqual(expenses.metrics.historicalExpenseByCurrency, [{ currency: null, minor: "30003" }]);
  assert.deepEqual(expenses.metrics.compatibilityExpenseByCurrency, [{ currency: null, minor: "40004" }]);
  assert.deepEqual(expenses.metrics.verifiedPayableAccrualByCurrency, [{ currency: "ARS", minor: "1110111" }]);
  assert.deepEqual(expenses.metrics.openVerifiedOperatingPayablesByCurrency, [{ currency: "ARS", minor: "1070107" }]);
  assert.deepEqual(expenses.metrics.paidPayableByObligationCurrency, [{ currency: "ARS", minor: "50005" }]);
  assert.equal(expenses.coverage.find(row => row.source === "payable-payments")?.queryComplete, true);

  const purchases = await reportTestSchema!.queries.queryOperationsReport("purchases", range);
  assert.equal(purchases.metrics.purchaseOrders.count, 10001);
  assert.deepEqual(purchases.metrics.purchaseOrders.totalsByCurrency, [{ currency: "USD", minor: "130013" }]);
  assert.equal(purchases.metrics.receipts.count, 10001);
  assert.equal(purchases.metrics.historicalPurchaseReceiptCount, 10001);
  assert.deepEqual(purchases.metrics.historicalPurchaseTotalByCurrency, [{ currency: null, minor: "70007" }]);
  assert.deepEqual(purchases.metrics.verifiedOpenPurchasePayablesByCurrency, [{ currency: "USD", minor: "150015" }]);

  const delivery = await reportTestSchema!.queries.queryOperationsReport("delivery-collections", range);
  assert.equal(delivery.metrics.deliveryCount, 10001);
  assert.equal(delivery.metrics.collectionReportCount, 10001);
  assert.deepEqual(delivery.metrics.reportedCollectionByCurrency, [{ currency: "ARS", minor: "230023" }]);
  assert.deepEqual(delivery.metrics.verifiedAppliedCollectionByCurrency, [{ currency: "ARS", minor: "200020" }]);
  assert.deepEqual(delivery.metrics.renditionGrossByCurrency, [{ currency: "ARS", minor: "310031" }]);
  assert.deepEqual(delivery.metrics.spendableMemberCreditOpenByCurrency, [{ currency: "ARS", minor: "750075" }]);

  const inventory = await reportTestSchema!.queries.queryOperationsReport("inventory", range, { locationIds: ["warehouse-a"] });
  assert.equal(inventory.metrics.current.balanceRows, 10001);
  assert.equal(inventory.metrics.current.visibleBalanceRows, 500);
  assert.equal(inventory.metrics.current.balanceRowsState, "partial-visible-row-limit");
  assert.deepEqual(inventory.metrics.current.balanceOnHandByUnit, [{ unit: "g", quantity: "20002" }]);
  assert.deepEqual(inventory.metrics.current.availableByUnit, [{ unit: "g", quantity: "15001.5" }]);
  assert.deepEqual(inventory.metrics.current.stockValuationByCostCurrencyMinor, [{ currency: "ARS", minor: "5000500" }]);
  assert.equal(inventory.metrics.current.stockMovementEventCount, 10001);
  assert.deepEqual(inventory.metrics.current.stockMovementEventsByKindAndUnit, [{
    kind: "waste", meaning: "positive-waste-quantity", unit: "g", eventCount: 10001, recordedQuantity: "10001",
  }]);
  assert.equal(inventory.metrics.current.custodyAllocationCount, 10001);
  assert.equal(inventory.metrics.current.visibleCustodyRows, 1);
  assert.equal(inventory.metrics.current.custodyRowsState, "partial-visible-row-limit");
  assert.equal(inventory.metrics.current.custodySummaryState, "not-calculated-source-incomplete-or-invalid");
  assert.equal(inventory.metrics.current.preparationCustodyByUnit, null);
  assert.equal(inventory.metrics.current.physicalClubStockByUnit, null);
  assert.equal(inventory.coverage.find(row => row.source === "preparation-delivery-custody")?.queryComplete, false);
  assert.equal(inventory.coverage.find(row => row.source === "current-stock-balance-aggregates")?.queryComplete, true);
  assert.equal(inventory.coverage.find(row => row.source === "visible-current-stock-balance-rows")?.queryComplete, false);

  const reportBytes = Object.entries({ cash, obligations, fx, expenses, purchases, delivery, inventory })
    .map(([name, report]) => ({ name, bytes: Buffer.byteLength(JSON.stringify(report), "utf8") }));
  assert.ok(reportBytes.every(row => row.bytes <= 4_000_000),
    `reports must leave room below the Function response limit; observed ${JSON.stringify(reportBytes)}`);

  await db.$executeRawUnsafe(`
    INSERT INTO "StockFact" ("id", "requestId", "lotId", "kind", "quantity", "unit", "fromLocationId", "toLocationId", "fromCustodianId", "toCustodianId", "reason", "actorId", "occurredAt")
    SELECT gen_random_uuid(), gen_random_uuid(), 'volume-lot-00001', 'waste', 1, 'g', sample."fromLocationId", sample."toLocationId", sample."fromCustodianId", sample."toCustodianId", sample."reason", 'fixture', '2026-09-18 12:00:00'::timestamp
    FROM (VALUES
      ('warehouse-a', 'warehouse-a', 'custodian', 'custodian', 'scope-in-both'),
      ('warehouse-a', NULL, 'custodian', NULL, 'scope-in-null'),
      ('warehouse-b', 'warehouse-a', 'custodian', 'custodian', 'leak-location-from'),
      ('warehouse-a', 'warehouse-b', 'custodian', 'custodian', 'leak-location-to'),
      ('warehouse-a', NULL, 'private-custodian', 'custodian', 'leak-custodian-from'),
      ('warehouse-a', NULL, 'custodian', 'private-custodian', 'leak-custodian-to'),
      ('warehouse-b', NULL, 'custodian', NULL, 'leak-no-known-location')
    ) AS sample("fromLocationId", "toLocationId", "fromCustodianId", "toCustodianId", "reason")
  `);
  const scopedInventory = await reportTestSchema!.queries.queryOperationsReport("inventory", range, {
    locationIds: ["warehouse-a"],
    custodianIds: ["custodian"],
  });
  assert.equal(scopedInventory.metrics.current.stockMovementEventCount, 2);
  assert.equal(scopedInventory.metrics.current.stockMovementEventRowsVisible, 2);
  assert.deepEqual(scopedInventory.metrics.current.stockMovementEventsByKindAndUnit, [{
    kind: "waste", meaning: "positive-waste-quantity", unit: "g", eventCount: 2, recordedQuantity: "2",
  }]);
  assert.equal(scopedInventory.coverage.find(row => row.source === "dated-stock-fact-aggregates")?.queryComplete, true);
  assert.equal(scopedInventory.coverage.find(row => row.source === "visible-dated-stock-fact-rows")?.expectedCount, 2);
  for (const event of scopedInventory.metrics.current.stockMovementEvents) {
    assert.ok(event.fromLocationId === null || event.fromLocationId === "warehouse-a");
    assert.ok(event.toLocationId === null || event.toLocationId === "warehouse-a");
    assert.ok(event.fromCustodianId === null || event.fromCustodianId === "custodian");
    assert.ok(event.toCustodianId === null || event.toCustodianId === "custodian");
    assert.equal(event.outsideScopeEndpoint, false);
  }
  const emptyLocationInventory = await reportTestSchema!.queries.queryOperationsReport("inventory", range, {
    locationIds: [],
    custodianIds: ["custodian"],
  });
  assert.equal(emptyLocationInventory.metrics.current.stockMovementEventCount, 0);
  assert.deepEqual(emptyLocationInventory.metrics.current.stockMovementEventsByKindAndUnit, []);
  assert.equal(emptyLocationInventory.coverage.find(row => row.source === "visible-dated-stock-fact-rows")?.expectedCount, 0);
});
