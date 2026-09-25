import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { businessDate, defaults } from "../shared/domain.js";
import { splitSqlStatements } from "./migration-sql.js";

test("decision API: roles, bigint reviews, isolated imports and reconciliation", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.DEMO_MODE = "true";
  process.env.JWT_SECRET = "test-only-secret-with-more-than-thirty-two-chars";
  process.env.ALLOWED_ORIGIN = "http://test.local";
  process.env.NODE_ENV = "test";
  const { db } = await import("../server/db.js");
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const migrationRoot = new URL("../prisma/migrations/", import.meta.url);
  for (const folder of (await readdir(migrationRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = await readFile(new URL(`${folder.name}/migration.sql`, migrationRoot), "utf8");
    for (const statement of splitSqlStatements(sql))
      await db.$executeRawUnsafe(statement);
  }
  const password = await bcrypt.hash("test-password-123", 4);
  for (const [id, role] of [["owner", "owner"], ["camila", "admin"], ["cashier", "cashier"]] as const)
    await db.user.create({ data: { id, name: id, email: `${id}@test.local`, role, password } });
  await db.setting.create({ data: { id: 1, value: defaults } });
  const { app } = await import("../server/app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  async function login(id: string) {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://test.local" },
      body: JSON.stringify({ email: `${id}@test.local`, password: "test-password-123" }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.headers.get("set-cookie")!.split(";")[0];
  }
  const cookies = { owner: await login("owner"), camila: await login("camila"), cashier: await login("cashier") };
  const call = (path: string, role: keyof typeof cookies, body?: unknown, method?: string) => fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { Cookie: cookies[role], Origin: "http://test.local", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    assert.equal((await call("/decision-center", "cashier")).status, 403);
    assert.equal((await call("/data-import/batches", "cashier")).status, 403);
    const centerResponse = await call("/decision-center", "camila");
    assert.equal(centerResponse.status, 200, await centerResponse.clone().text());
    const center = await centerResponse.json() as { cards: Array<{ kind: string; impactCents: string | null }>; tasks: Array<{ id: string }> };
    assert.deepEqual(center.cards.map((card) => card.kind), ["replenishment", "commercial", "cash"]);
    assert(center.cards.every((card) => card.impactCents === null));
    assert(center.tasks.length >= 4);
    const task = await call(`/decision-tasks/${encodeURIComponent(center.tasks[0].id)}`, "owner", { status: "done" }, "PUT");
    assert.equal(task.status, 200, await task.clone().text());

    const review = await call("/monthly-reviews", "camila", {
      period: "2026-09", metric: "Resultado observado", actualCents: "9000000000000",
      planCents: "8999999999999", cause: "Caso sintético", decision: "Volver a revisar con Tiziano",
      ownerId: "owner", followUpDate: "2026-10-05", source: "caso QA manual", evidence: "demo",
    });
    assert.equal(review.status, 201, await review.clone().text());
    assert.equal((await review.json() as { deviationCents: string }).deviationCents, "1");
    const forgedReview = await call("/monthly-reviews", "camila", {
      period: "2026-09", metric: "Caja", actualCents: "1", planCents: "1",
      cause: "Caso QA", decision: "Revisar fuente", ownerId: "owner",
      followUpDate: null, source: "texto libre", evidence: "reconciled",
    });
    assert.equal(forgedReview.status, 400);

    const csv = [
      "recordType,sourceId,date,total,discount,itemLabel,parentSourceId,quantity,unit,lineTotal",
      "sale,sale-1,2026-09-20,12345678.90,0,,,,,",
      "line,line-1,2026-09-20,,,Flor,sale-1,1,g,12345678.90",
    ].join("\n");
    const body = {
      kind: "delivery_sales", sourceSystem: "appsheet-test", filename: "ventas.csv",
      contentBase64: Buffer.from(csv).toString("base64"), cutoff: "2026-09-24",
      mapping: { version: "test-v1", columns: Object.fromEntries(
        ["recordType", "sourceId", "date", "total", "discount", "itemLabel", "parentSourceId", "quantity", "unit", "lineTotal"]
          .map((column) => [column, column]),
      ) },
    };
    const previewResponse = await call("/data-import/preview", "owner", body);
    assert.equal(previewResponse.status, 200, await previewResponse.clone().text());
    const preview = await previewResponse.json() as { batchId: string; status: string; acceptedCount: number };
    assert.equal(preview.status, "ready");
    assert.equal(preview.acceptedCount, 2);
    const commit = await call("/data-import/commit", "owner", { batchId: preview.batchId });
    assert.equal(commit.status, 200, await commit.clone().text());
    assert.equal((await commit.json() as { inserted: number }).inserted, 2);
    assert.equal((await db.historicalDeliverySale.count()), 1);
    assert.equal((await db.historicalDeliverySaleLine.count()), 1);
    assert.equal((await db.historicalDeliverySale.findFirstOrThrow()).totalCents, 1_234_567_890n);
    const repeated = await call("/data-import/preview", "owner", body);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as { status: string }).status, "imported");
    const repeatedCommit = await call("/data-import/commit", "owner", { batchId: preview.batchId });
    assert.equal(repeatedCommit.status, 200);
    assert.equal((await db.historicalDeliverySale.count()), 1);

    const conflicting = await call("/data-import/preview", "owner", {
      ...body, contentBase64: Buffer.from(csv.replace("12345678.90", "12345678.91")).toString("base64"),
    });
    assert.equal(conflicting.status, 200, await conflicting.clone().text());
    const conflictPreview = await conflicting.json() as { status: string; conflicts: unknown[] };
    assert.equal(conflictPreview.status, "rejected");
    assert(conflictPreview.conflicts.length > 0);
    assert.equal((await db.historicalDeliverySale.count()), 1);

    const unsupportedReconciliation = await call(`/data-import/${preview.batchId}/reconcile`, "camila", {
      asOf: "2026-09-24", reference: "acta QA sintética", notes: "Diferencia sintética todavía pendiente",
      varianceCents: "1", sourceRecordCount: 2, sourceTotalCents: "1234567890",
    });
    assert.equal(unsupportedReconciliation.status, 400);
    const importerCannotReconcile = await call(`/data-import/${preview.batchId}/reconcile`, "owner", {
      asOf: "2026-09-24", reference: "acta QA sintética", notes: "Control externo sintético completo",
      varianceCents: "0", sourceRecordCount: 2, sourceTotalCents: "1234567890",
    });
    assert.equal(importerCannotReconcile.status, 400);
    const wrongExternalTotal = await call(`/data-import/${preview.batchId}/reconcile`, "camila", {
      asOf: "2026-09-24", reference: "acta QA sintética", notes: "Control externo sintético completo",
      varianceCents: "0", sourceRecordCount: 2, sourceTotalCents: "1234567891",
    });
    assert.equal(wrongExternalTotal.status, 400);
    const reconciled = await call(`/data-import/${preview.batchId}/reconcile`, "camila", {
      asOf: "2026-09-24", reference: "acta QA sintética", notes: "Comparado con comprobantes sintéticos del caso QA",
      varianceCents: "0", sourceRecordCount: 2, sourceTotalCents: "1234567890",
    });
    assert.equal(reconciled.status, 201, await reconciled.clone().text());
    assert.equal((await db.historicalImportBatch.findUniqueOrThrow({ where: { id: preview.batchId } })).status, "reconciled");
    const batchListResponse = await call("/data-import/batches", "camila");
    assert.equal(batchListResponse.status, 200);
    const batchList = await batchListResponse.json() as { items: Array<{ id: string; reconciliation: {
      asOf: string; varianceCents: string | null; sourceTotalCents: string | null;
      coverageComplete: boolean; notes: string } | null }> };
    const shown = batchList.items.find((item) => item.id === preview.batchId);
    assert.equal(shown?.reconciliation?.asOf, "2026-09-24");
    assert.equal(shown?.reconciliation?.varianceCents, "0");
    assert.equal(shown?.reconciliation?.sourceTotalCents, "1234567890");
    assert.equal(shown?.reconciliation?.coverageComplete, false);
    assert.match(shown?.reconciliation?.notes ?? "", /Compara/);
    const partialBatchId = randomUUID();
    await db.historicalImportBatch.create({ data: { id: partialBatchId, idempotencyKey: "partial-fixture",
      kind: "delivery_sales", sourceSystem: "partial-qa", fileHash: "partial", mappingVersion: "qa-v1",
      cutoffDate: new Date("2026-09-24T00:00:00.000Z"), status: "imported", mapping: {}, facts: [],
      factsHash: "partial", rowCount: 1, acceptedCount: 0, rejectedCount: 1, errors: [], conflicts: [],
      committedByUserId: "owner", importedAt: new Date() } });
    const falseComplete = await call(`/data-import/${partialBatchId}/reconcile`, "camila", {
      asOf: "2026-09-24", reference: "control de filas QA", notes: "Quedó una fila sin resolver en el archivo",
      varianceCents: "0", sourceRecordCount: 0, sourceTotalCents: "0",
      coverageFrom: "2026-09-01", coverageThrough: "2026-09-24", coverageComplete: true,
    });
    assert.equal(falseComplete.status, 400);
    const today = businessDate(defaults);
    const calendarDay = (days: number) => { const value = new Date(`${today}T12:00:00.000Z`); value.setUTCDate(value.getUTCDate() + days);
      return value.toISOString().slice(0, 10); };
    const dbDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
    const forecastBatchId = randomUUID();
    await db.historicalImportBatch.create({ data: { id: forecastBatchId, idempotencyKey: "forecast-fixture",
      kind: "delivery_sales", sourceSystem: "forecast-qa", fileHash: "fixture", mappingVersion: "qa-v1",
      cutoffDate: dbDate(calendarDay(-1)), status: "reconciled", mapping: {}, facts: [],
      factsHash: "fixture", rowCount: 84, acceptedCount: 84, rejectedCount: 0, errors: [], conflicts: [],
      importedAt: new Date() } });
    await db.historicalReconciliation.create({ data: { batchId: forecastBatchId, asOf: new Date(`${today}T00:00:00.000Z`),
      coverageFrom: dbDate(calendarDay(-84)), coverageThrough: dbDate(calendarDay(-1)),
      coverageComplete: true, reference: "serie sintética completa", notes: "84 días de serie sintética cotejada",
      confirmedByUserId: "owner", varianceCents: 0n } });
    const forecastSales = Array.from({ length: 84 }, (_, index) => ({
      id: randomUUID(), sourceSystem: "forecast-qa", sourceId: `day-${index}`,
      factHash: `hash-${index}`, saleDate: dbDate(calendarDay(index - 84)),
      totalCents: BigInt(10000 + index * 100), discountCents: index === 83 ? 5000n : 0n,
    }));
    await db.historicalDeliverySale.createMany({ data: forecastSales });
    await db.historicalImportProvenance.createMany({ data: forecastSales.map((sale) => ({
      id: randomUUID(), batchId: forecastBatchId, factKind: "delivery_sale",
      sourceSystem: sale.sourceSystem, sourceId: sale.sourceId, factHash: sale.factHash, disposition: "inserted",
    })) });
    const forecastAttestation = await call("/decision-inputs/attestations", "owner", { domain: "delivery_sales",
      scenario: null, fromDate: calendarDay(-84), throughDate: calendarDay(-1), complete: true,
      sourceReference: `batch:${forecastBatchId}` });
    assert.equal(forecastAttestation.status, 201, await forecastAttestation.clone().text());
    const falsePartialAttestation = await call("/decision-inputs/attestations", "owner", { domain: "delivery_sales",
      scenario: null, fromDate: calendarDay(-7), throughDate: today, complete: false,
      sourceReference: `batch:${randomUUID()}` });
    assert.equal(falsePartialAttestation.status, 400);
    await db.customer.create({ data: { id: "margin-member", name: "Socio QA", email: "", phone: "" } });
    await db.product.create({ data: { id: "margin-lot", name: "Flor QA", strain: "", type: "Flores",
      lot: "margin-lot", supplier: "Proveedor QA", unit: "g", location: "Local", stock: 1000,
      minimum: 0, cost: 7000, price: 15000, ownerId: "owner" } });
    const location = await db.location.create({ data: { name: "Local QA", key: "local-qa" } });
    await db.product.update({ where: { id: "margin-lot" }, data: { locationId: location.id } });
    for (const id of ["fraction-lot-a", "fraction-lot-b"])
      await db.product.create({ data: { id, name: id, strain: "", type: "Flores", lot: id,
        supplier: "Proveedor QA", unit: "g", location: "Local QA", locationId: location.id, stock: 500,
        minimum: 0, cost: 1, price: 2, ownerId: "owner" } });
    const receiptId = randomUUID();
    await db.historicalPurchaseReceipt.create({ data: { id: receiptId, sourceSystem: "forecast-qa",
      sourceId: "lead-time-receipt", factHash: "lead-time-fixture", receivedDate: dbDate(today),
      orderDate: dbDate(calendarDay(-5)), supplierSourceId: "private-supplier-id", totalCents: 1500n } });
    await db.historicalImportProvenance.create({ data: { id: randomUUID(), batchId: forecastBatchId,
      factKind: "purchase_receipt", sourceSystem: "forecast-qa", sourceId: "lead-time-receipt",
      factHash: "lead-time-fixture", disposition: "inserted" } });
    await db.sale.create({ data: { id: "margin-sale", customerId: "margin-member", userId: "owner", date: today,
      subtotal: 15000, discount: 2655, total: 12345, cost: 7000, pointsEarned: 0, pointsUsed: 0,
      payment: "cash", requestId: "margin-request", channel: "local",
      items: { create: { productId: "margin-lot", ownerId: "owner", name: "Flor QA", unit: "g",
        quantity: 1000, price: 15000, cost: 7000, revenue: 12345 } } } });
    assert.equal((await call("/decision-inputs", "cashier")).status, 403);
    const mapping = await call("/decision-inputs/mapping", "owner", { status: "shared",
      sharedLocationIds: [location.id], localLocationIds: [location.id], deliveryLocationIds: [location.id],
      reference: "Definición sintética Tiziano QA" });
    assert.equal(mapping.status, 201, await mapping.clone().text());
    const rule = await call("/decision-inputs/rules", "owner", { productId: "margin-lot", leadTimeDays: 5,
      minimumOrderQuantityMilliunits: 1000, reviewPeriodDays: 7, sourceReference: "Plazo sintético proveedor QA" });
    assert.equal(rule.status, 201, await rule.clone().text());
    const quote = await call("/decision-inputs/quotes", "camila", { productId: "margin-lot", quotedOn: today,
      validUntil: null, unitCostCentsPerUnit: "9000000000", sourceReference: "Cotización sintética QA" });
    assert.equal(quote.status, 201, await quote.clone().text());
    const plusDays = calendarDay;
    const inbound = await call("/decision-inputs/inbounds", "owner", { productId: "margin-lot", locationId: location.id,
      quantityMilliunits: 2000, arrivalDate: plusDays(3), sourceReference: "Pedido sintético QA" });
    assert.equal(inbound.status, 201, await inbound.clone().text());
    const snapshot = await call("/decision-inputs/cash-snapshots", "owner", { asOf: today,
      floorCents: "1000000000", sourceReference: "Conciliación sintética banco y caja", complete: true,
      accounts: [{ account: "banco", amountCents: "9000000000000" }, { account: "caja", amountCents: "1000000000000" }] });
    assert.equal(snapshot.status, 201, await snapshot.clone().text());
    assert.equal((await snapshot.json() as { totalCents: string }).totalCents, "10000000000000");
    const plan = await call("/decision-inputs/cash-plans", "owner", { scenario: "base", date: plusDays(7),
      account: "banco", category: "stock_purchase", amountCents: "-5000000000", sourceReference: "Pago sintético QA" });
    assert.equal(plan.status, 201, await plan.clone().text());
    const cashCoverage = await call("/decision-inputs/attestations", "owner", { domain: "cash_plan", scenario: "base",
      fromDate: plusDays(1), throughDate: plusDays(91), complete: true, sourceReference: "Vencimientos sintéticos completos QA" });
    assert.equal(cashCoverage.status, 201, await cashCoverage.clone().text());
    const inputs = await call("/decision-inputs", "owner");
    assert.equal(inputs.status, 200, await inputs.clone().text());
    const inputPayload = await inputs.json() as { quotes: Array<{ unitCostCentsPerUnit: string }>; cashSnapshots: Array<{ accounts: unknown[]; asOf: string; complete: boolean }>; attestations: unknown[] };
    assert.equal(inputPayload.quotes[0]?.unitCostCentsPerUnit, "9000000000");
    assert.equal(inputPayload.cashSnapshots[0]?.accounts.length, 2);
    const analysis = await call("/decision-analysis", "owner");
    assert.equal(analysis.status, 200, await analysis.clone().text());
    const payload = await analysis.json() as {
      importedHistory: { deliverySales: { count: number; grossRecordedCents: string } };
      profitability: { byProduct: Array<{ revenueCents: string; historicalCogsCents: string; grossMarginCents: string }>;
        byCategory: Array<{ name: string; grossMarginCents: string }>;
        byChannel: Array<{ channel: string; grossMarginCents: string | null; saleCount: string }> };
      asOfDate: string;
      forecast: { deliverySevenDay: { forecast: { available: boolean; asOfDate: string; pointCents: string | null }; outOfSample: { forecastOrigins: number } };
        cash13Weeks: { base: { available: boolean; unavailableReasons: string[]; weeks: Array<{ closingCashBalanceCents: string }> };
        low: { available: boolean } } };
      inventory: { valueAtHistoricalCostCents: string;
        lots: Array<{ id: string; valueAtHistoricalCostCents: string }>;
        observedSupplierLeadTimes: Array<{ sourceSystem: string; supplier: string; sampleCount: number; medianDays: number }>;
        commerce: { costEvidence: Array<{ productId: string; usableReplacementQuote: { unitCostCentsPerUnit: string } | null }> } };
    };
    assert.equal(payload.importedHistory.deliverySales.count, 85);
    assert.equal(payload.importedHistory.deliverySales.grossRecordedCents, (1_234_567_890n + Array.from({ length: 84 }, (_, index) => BigInt(10000 + index * 100))
      .reduce((sum, value) => sum + value, 0n)).toString());
    assert.equal(payload.forecast.deliverySevenDay.forecast.available, true);
    assert.equal(payload.forecast.deliverySevenDay.forecast.asOfDate, calendarDay(-1));
    assert.equal(payload.forecast.deliverySevenDay.forecast.pointCents, "117400");
    assert(payload.forecast.deliverySevenDay.outOfSample.forecastOrigins >= 3);
    assert.deepEqual(payload.profitability.byProduct.map((row) =>
      [row.revenueCents, row.historicalCogsCents, row.grossMarginCents]), [["12345", "7000", "5345"]]);
    assert.deepEqual(payload.profitability.byCategory.map((row) => [row.name, row.grossMarginCents]), [["Flores", "5345"]]);
    assert.equal(payload.profitability.byChannel.find((row) => row.channel === "local")?.saleCount, "1");
    assert.equal(payload.profitability.byChannel.find((row) => row.channel === "delivery_importado")?.grossMarginCents, null);
    assert.equal(payload.forecast.cash13Weeks.base.available, true, JSON.stringify({ asOf: payload.asOfDate,
      today, snapshots: inputPayload.cashSnapshots, attestations: inputPayload.attestations,
      reasons: payload.forecast.cash13Weeks.base.unavailableReasons }));
    assert.equal(payload.forecast.cash13Weeks.base.weeks[0]?.closingCashBalanceCents, "9995000000000");
    assert.equal(payload.forecast.cash13Weeks.low.available, false);
    assert.equal(payload.inventory.commerce.costEvidence.find((row) => row.productId === "margin-lot")?.usableReplacementQuote?.unitCostCentsPerUnit, "9000000000");
    assert.equal(payload.inventory.valueAtHistoricalCostCents, "7001");
    assert.equal(payload.inventory.lots.reduce((sum, row) => sum + BigInt(row.valueAtHistoricalCostCents), 0n), 7001n);
    assert.deepEqual(payload.inventory.observedSupplierLeadTimes.map((row) => [row.sourceSystem, row.sampleCount, row.medianDays]),
      [["forecast-qa", 1, 5]]);
    assert(!JSON.stringify(payload.inventory.observedSupplierLeadTimes).includes("private-supplier-id"));
    const pendingBatchId = randomUUID();
    await db.historicalImportBatch.create({ data: { id: pendingBatchId, idempotencyKey: "forecast-pending",
      kind: "delivery_sales", sourceSystem: "forecast-qa", fileHash: "pending", mappingVersion: "qa-v1",
      cutoffDate: dbDate(today), status: "imported", mapping: {}, facts: [], factsHash: "pending",
      rowCount: 1, acceptedCount: 1, rejectedCount: 0, errors: [], conflicts: [], importedAt: new Date() } });
    const pendingLine = { id: randomUUID(), sourceSystem: "forecast-qa", sourceId: "late-historical-line",
      factHash: "late-historical-line-hash", saleId: forecastSales[70].id, itemLabel: "Producto QA",
      productSourceId: "product-qa", quantityMilliunits: 1000n, quantityUnit: "g",
      unitPriceCents: 1000n, lineTotalCents: 1000n };
    await db.historicalDeliverySaleLine.create({ data: pendingLine });
    await db.historicalImportProvenance.create({ data: { id: randomUUID(), batchId: pendingBatchId,
      factKind: "delivery_sale_line", sourceSystem: pendingLine.sourceSystem,
      sourceId: pendingLine.sourceId, factHash: pendingLine.factHash, disposition: "inserted" } });
    const untrustedLineForecast = await call("/decision-analysis", "owner");
    assert.equal(untrustedLineForecast.status, 200, await untrustedLineForecast.clone().text());
    assert.equal((await untrustedLineForecast.json() as { forecast: { deliverySevenDay: { forecast: { available: boolean } } } })
      .forecast.deliverySevenDay.forecast.available, false);
    await db.historicalDeliverySaleLine.delete({ where: { id: pendingLine.id } });
    await db.historicalImportProvenance.delete({ where: { batchId_factKind_sourceSystem_sourceId: {
      batchId: pendingBatchId, factKind: "delivery_sale_line", sourceSystem: pendingLine.sourceSystem,
      sourceId: pendingLine.sourceId } } });
    const pendingSale = { id: randomUUID(), sourceSystem: "forecast-qa", sourceId: "late-historical-sale",
      factHash: "late-historical-hash", saleDate: dbDate(calendarDay(-10)), totalCents: 90_000n,
      discountCents: 1_000n };
    await db.historicalDeliverySale.create({ data: pendingSale });
    await db.historicalImportProvenance.create({ data: { id: randomUUID(), batchId: pendingBatchId,
      factKind: "delivery_sale", sourceSystem: pendingSale.sourceSystem,
      sourceId: pendingSale.sourceId, factHash: pendingSale.factHash, disposition: "inserted" } });
    const contaminatedForecast = await call("/decision-analysis", "owner");
    assert.equal(contaminatedForecast.status, 200, await contaminatedForecast.clone().text());
    assert.equal((await contaminatedForecast.json() as { forecast: { deliverySevenDay: { forecast: { available: boolean } } } })
      .forecast.deliverySevenDay.forecast.available, false);
    const inflationInput = { earlierMonth: calendarDay(-60).slice(0, 7), laterMonth: calendarDay(-30).slice(0, 7),
      earlierNominalCents: "10000", laterNominalCents: "15000", earlierIndex: "100.0", laterIndex: "125.0",
      publishedAt: today, seriesVersion: "fixture QA", sourceUrl: "https://www.indec.gob.ar/ftp/cuadros/economia/fixture.pdf" };
    assert.equal((await call("/decision-simulations/inflation", "cashier", inflationInput)).status, 403);
    assert.equal((await call("/decision-simulations/inflation", "owner", { ...inflationInput,
      sourceUrl: "https://example.com/fixture.pdf" })).status, 400);
    const inflation = await call("/decision-simulations/inflation", "camila", inflationInput);
    assert.equal(inflation.status, 200, await inflation.clone().text());
    const inflationResult = await inflation.json() as { evidence: string; calculation: { earlierAdjustedToLaterCents: string;
      cpiAdjustedChangeCents: string } };
    assert.equal(inflationResult.evidence, "official_source_user_supplied_unverified");
    assert.equal(inflationResult.calculation.earlierAdjustedToLaterCents, "12500");
    assert.equal(inflationResult.calculation.cpiAdjustedChangeCents, "2500");
    assert((await db.sensitiveAccessAudit.count()) >= 6);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
