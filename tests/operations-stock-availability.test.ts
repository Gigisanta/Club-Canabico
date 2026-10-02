import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

test("stock availability gates confirmation and receipts through real commands with rollback", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const baseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname));
  assert.match(baseUrl.pathname, /test|ci/i);
  const schema = `stockavailability_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(baseUrl);
  url.searchParams.set("schema", schema);
  const previousEnv = new Map<string, string | undefined>();
  for (const key of ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "OPERATIONAL_REHEARSAL", "CLUB_OPERATIONS_APPROVED", "JWT_SECRET", "ALLOWED_ORIGIN"]) previousEnv.set(key, process.env[key]);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    NODE_ENV: "development",
    DEMO_MODE: "false",
    OPERATIONAL_REHEARSAL: "false",
    CLUB_OPERATIONS_APPROVED: "true",
    JWT_SECRET: "stock-availability-isolated-test-secret-32-chars",
    ALLOWED_ORIGIN: "http://stock-availability.local",
  });

  let cleanupDb: PrismaClient | undefined;
  let server: Server | undefined;
  let schemaCreated = false;
  try {
    const { db } = await import("../server/db.js");
    cleanupDb = db;
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrationsPath = new URL("../prisma/migrations/", import.meta.url);
    const migrationDirs = (await readdir(migrationsPath, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of migrationDirs) {
      const migration = await readFile(new URL(`${dir.name}/migration.sql`, migrationsPath), "utf8");
      for (const statement of splitSqlStatements(migration)) await db.$executeRawUnsafe(statement);
    }

    const password = await bcrypt.hash("Only-a-local-stock-test-123", 4);
    for (const [id, role] of [["owner", "owner"], ["stock", "viewer"], ["custodian", "viewer"], ["custodian-a", "viewer"], ["custodian-b", "viewer"], ["outside-custodian", "viewer"], ["scoped-preparer", "viewer"], ["driver", "viewer"]] as const)
      await db.user.create({ data: { id, name: id, email: `${id}@stock-availability.local`, password, role } });
    await db.operationAccess.create({ data: {
      userId: "stock",
      profile: "stock",
      capabilities: ["operations.read", "stock.read", "stock.receive", "stock.adjust", "purchases.write"],
      scope: { locationIds: ["location"], custodianIds: ["custodian"] },
    } });
    await db.operationAccess.create({ data: {
      userId: "driver", profile: "driver", capabilities: ["delivery.report"],
    } });
    await db.operationAuthority.upsert({ where: { id: "operations" }, create: { id: "operations", mode: "active" }, update: { mode: "active" } });
    await db.location.create({ data: { id: "location", name: "Synthetic local", key: "synthetic-local" } });
    await db.supplier.create({ data: { id: "supplier", name: "Synthetic supplier", key: "synthetic-supplier" } });

    const { app } = await import("../server/app.js");
    const runningServer = app.listen(0, "127.0.0.1");
    server = runningServer;
    await new Promise<void>((resolve, reject) => {
      runningServer.once("listening", resolve);
      runningServer.once("error", reject);
    });
    const base = `http://127.0.0.1:${(runningServer.address() as { port: number }).port}/api`;
    const origin = "http://stock-availability.local";
    const cookies: Record<string, string> = {};
    const evidence = { reference: "synthetic-stock-availability-test" };
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const future = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;

    async function call(path: string, actor: string, body?: unknown) {
      return fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), Origin: origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function login(id: string) {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@stock-availability.local`, password: "Only-a-local-stock-test-123" }),
      });
      assert.equal(response.status, 200, await response.text());
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    async function envelope(targetId: string, command: string, data: Record<string, unknown>): Promise<CommandEnvelope> {
      const object = await db.operationObject.findUnique({ where: { id: targetId }, select: { version: true } });
      return { schemaVersion: 1, requestId: randomUUID(), targetId, command, data, expectedVersion: object?.version ?? 0, occurredAt: new Date().toISOString() };
    }
    async function send(actor: string, targetId: string, command: string, data: Record<string, unknown>) {
      const request = await envelope(targetId, command, data);
      const response = await call("/operations/commands", actor, request);
      return { request, response, body: await response.json() as Record<string, any> };
    }
    async function command(actor: string, targetId: string, name: string, data: Record<string, unknown>) {
      const result = await send(actor, targetId, name, data);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      return result.body;
    }
    async function rejected(actor: string, targetId: string, name: string, data: Record<string, unknown>, status: number, code?: string) {
      const result = await send(actor, targetId, name, data);
      assert.equal(result.response.status, status, JSON.stringify(result.body));
      if (code) assert.equal(result.body.code, code, JSON.stringify(result.body));
      assert.equal(await db.commandReceipt.findUnique({ where: { requestId: result.request.requestId } }), null);
      assert.equal(await db.operationOutbox.findFirst({ where: { requestId: result.request.requestId } }), null);
      return result;
    }
    async function createOrder(orderId: string, channel: "local" | "delivery", skuLines: Array<{ skuId: string; lineId: string }>) {
      const lines = skuLines.map((line) => ({ ...line, lineId: `${orderId}-${line.lineId}` }));
      await command("owner", orderId, "OrderCreated", { memberId: "member", channel, currency: "ARS" });
      await command("owner", orderId, "OrderQuoted", {
        currency: "ARS", paymentMethod: "cash",
        items: lines.map(({ skuId, lineId }) => ({ id: lineId, skuId, quantity: "2", manualUnitPrice: "100", manualReason: "Synthetic test quote" })),
      });
    }
    async function approveAvailability(version: number, rules: Array<{ locationId: string; custodianId: string; channel: "local" | "delivery"; available: boolean; reason: string }>) {
      const id = `availability-${version}`;
      await command("owner", id, "ConfigurationProposed", {
        name: "Synthetic stock availability", kind: "stock_availability", version, validFrom: today, validUntil: "2099-12-31",
        definition: { rules }, evidence,
      });
      await command("owner", id, "ConfigurationApproved", { evidence });
      return id;
    }
    async function assertNoCreatedCommand(requestId: string, targetId: string) {
      assert.equal(await db.operationObject.findUnique({ where: { id: targetId } }), null);
      assert.equal(await db.commandReceipt.findUnique({ where: { requestId } }), null);
      assert.equal(await db.operationOutbox.findFirst({ where: { requestId } }), null);
    }

    await login("owner");
    await login("stock");
    const duplicateRule = { locationId: "location", custodianId: "custodian-a", channel: "local", available: true, reason: "Synthetic rule" };
    const duplicateConfig = await rejected("owner", "configuration-duplicate", "ConfigurationProposed", {
      name: "Synthetic duplicate availability", kind: "stock_availability", version: 1, validFrom: today, validUntil: "2099-12-31",
      definition: { rules: [duplicateRule, duplicateRule] }, evidence,
    }, 422, "STOCK_AVAILABILITY_DUPLICATE");
    await assertNoCreatedCommand(duplicateConfig.request.requestId, "configuration-duplicate");
    const missingReferenceConfig = await rejected("owner", "configuration-missing-reference", "ConfigurationProposed", {
      name: "Synthetic unavailable reference", kind: "stock_availability", version: 1, validFrom: today, validUntil: "2099-12-31",
      definition: { rules: [{ ...duplicateRule, locationId: "inactive-location" }] }, evidence,
    }, 422, "STOCK_AVAILABILITY_REFERENCE");
    await assertNoCreatedCommand(missingReferenceConfig.request.requestId, "configuration-missing-reference");

    await command("owner", "sku-a", "CatalogSkuCreated", { code: "SYN-A", name: "Synthetic A", variety: "A", category: "flower", unit: "g", evidence });
    await command("owner", "sku-b", "CatalogSkuCreated", { code: "SYN-B", name: "Synthetic B", variety: "B", category: "flower", unit: "g", evidence });
    await command("owner", "member", "MemberCreated", { name: "Synthetic member" });
    await db.memberPermission.create({ data: { memberId: "member", kind: "operations", status: "verified", validFrom: today, validUntil: "2099-12-31" } });
    for (const [id, skuId, custodianId] of [["lot-a", "sku-a", "custodian-a"], ["lot-b", "sku-b", "custodian-b"]] as const) {
      await db.inventoryLot.create({ data: { id, skuId, label: id, unit: "g", unitCost: "1", costCurrency: "ARS", receivedAt: new Date(`${today}T12:00:00-03:00`) } });
      await db.stockBalance.create({ data: { id: `balance-${id.slice(-1)}`, lotId: id, locationId: "location", custodianId, unit: "g", quantity: "5", reserved: "0" } });
    }

    await createOrder("order-no-policy", "local", [{ skuId: "sku-a", lineId: "a-line" }]);
    const noPolicy = await rejected("owner", "order-no-policy", "OrderConfirmed", { quoteVersion: 1, acceptance: evidence }, 423, "STOCK_AVAILABILITY_PENDING");
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: "order-no-policy" } })).commercialState, "draft");
    assert.equal(await db.stockReservation.count({ where: { orderId: "order-no-policy" } }), 0);
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-a" } })).reserved.toString(), "0");

    await approveAvailability(1, [{ locationId: "location", custodianId: "custodian-a", channel: "local", available: true, reason: "Synthetic local fulfillment approved" }]);
    await createOrder("order-rollback", "local", [{ skuId: "sku-a", lineId: "a-line" }, { skuId: "sku-b", lineId: "b-line" }]);
    const rollbackVersion = (await db.operationObject.findUniqueOrThrow({ where: { id: "order-rollback" } })).version;
    const pendingTuple = await rejected("owner", "order-rollback", "OrderConfirmed", { quoteVersion: 1, acceptance: evidence }, 423, "STOCK_AVAILABILITY_PENDING");
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: "order-rollback" } })).commercialState, "draft");
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: "order-rollback" } })).version, rollbackVersion);
    assert.equal(await db.stockReservation.count({ where: { orderId: "order-rollback" } }), 0);
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-a" } })).reserved.toString(), "0");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-b" } })).reserved.toString(), "0");
    assert.equal(await db.deliveryAssignment.count({ where: { orderId: "order-rollback" } }), 0);
    assert.equal(await db.operationAudit.count({ where: { requestId: pendingTuple.request.requestId } }), 0);

    const approvedId = await approveAvailability(2, [
      { locationId: "location", custodianId: "custodian-a", channel: "local", available: true, reason: "Synthetic local fulfillment approved" },
      { locationId: "location", custodianId: "custodian-b", channel: "local", available: true, reason: "Synthetic local fulfillment approved" },
    ]);
    const confirmed = await command("owner", "order-rollback", "OrderConfirmed", { quoteVersion: 1, acceptance: evidence });
    assert.equal(confirmed.result.commercialState, "confirmed");
    assert.equal(confirmed.result.reservations.availability.coverage, "approved");
    assert.equal(confirmed.result.reservations.availability.configurationId, approvedId);
    assert.equal(confirmed.result.reservations.availability.version, 2);
    assert.equal(await db.stockReservation.count({ where: { orderId: "order-rollback", status: "active" } }), 2);
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-a" } })).reserved.toString(), "2");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-b" } })).reserved.toString(), "2");

    const { resolveStockAvailability } = await import("../server/operations/stock-availability.js");
    const physicalBalances = await db.stockBalance.findMany({ where: { id: { in: ["balance-a", "balance-b"] } }, include: { lot: true } });
    const physical = await resolveStockAvailability(db, { balances: physicalBalances, channel: "local", asOf: today, rehearsal: false });
    assert.equal(physical.coverage, "approved");
    const physicalById = new Map(physical.balances.map((row) => [row.balanceId, row]));
    for (const id of ["balance-a", "balance-b"]) {
      const row = physicalById.get(id)!;
      assert.deepEqual([row.quantity, row.reservedQuantity, row.physicalFreeQuantity, row.availableQuantity, row.state], ["5.000", "2.000", "3.000", "3.000", "available"]);
    }

    await approveAvailability(3, [
      { locationId: "location", custodianId: "custodian-a", channel: "local", available: false, reason: "Synthetic local fulfillment suspended" },
      { locationId: "location", custodianId: "custodian-b", channel: "local", available: true, reason: "Synthetic local fulfillment approved" },
    ]);
    await createOrder("order-denied", "local", [{ skuId: "sku-a", lineId: "a-line" }]);
    const deniedVersion = (await db.operationObject.findUniqueOrThrow({ where: { id: "order-denied" } })).version;
    const denied = await rejected("owner", "order-denied", "OrderConfirmed", { quoteVersion: 1, acceptance: evidence }, 409, "STOCK_SHORTAGE");
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: "order-denied" } })).commercialState, "draft");
    assert.equal(await db.stockReservation.count({ where: { orderId: "order-denied" } }), 0);
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: "order-denied" } })).version, deniedVersion);
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: denied.request.requestId } }), null);

    await createOrder("order-channel", "delivery", [{ skuId: "sku-a", lineId: "a-line" }]);
    const wrongChannel = await rejected("owner", "order-channel", "OrderConfirmed", { quoteVersion: 1, acceptance: evidence }, 423, "STOCK_AVAILABILITY_PENDING");
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: "order-channel" } })).commercialState, "draft");
    assert.equal(await db.stockReservation.count({ where: { orderId: "order-channel" } }), 0);
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: wrongChannel.request.requestId } }), null);

    await db.inventoryLot.create({ data: { id: "lot-outside", skuId: "sku-a", label: "Outside custody", unit: "g", unitCost: "1", costCurrency: "ARS", receivedAt: new Date(`${today}T12:00:00-03:00`) } });
    await db.stockBalance.create({ data: { id: "balance-outside", lotId: "lot-outside", locationId: "location", custodianId: "outside-custodian", unit: "g", quantity: "2", reserved: "0" } });
    const beforeOutside = await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-outside" } });
    const beforeFacts = await db.stockFact.count();
    const scopeDenied = await rejected("stock", "waste-outside", "StockWasteRecorded", { balanceId: "balance-outside", quantity: "1", reason: "Custody scope regression", evidence }, 403, "STOCK_CUSTODIAN_SCOPE");
    await assertNoCreatedCommand(scopeDenied.request.requestId, "waste-outside");
    const afterOutside = await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-outside" } });
    assert.equal(afterOutside.quantity.toString(), beforeOutside.quantity.toString());
    assert.equal(afterOutside.reserved.toString(), beforeOutside.reserved.toString());
    assert.equal(await db.stockFact.count(), beforeFacts);

    await command("owner", "purchase", "PurchaseOrderCreated", {
      supplierId: "supplier", agreementDate: today, currency: "ARS",
      items: [{ lineId: "purchase-line", skuId: "sku-a", unit: "g", quantity: "10", unitCost: "1" }], evidence,
    });
    await command("stock", "purchase", "PurchaseOrderApproved", { evidence });
    const lotCount = await db.inventoryLot.count();
    const balanceCount = await db.stockBalance.count();
    const factCount = await db.stockFact.count();
    for (const [targetId, data, expectedStatus, expectedCode] of [
      ["receipt-future", { purchaseId: "purchase", receivedDate: future, locationId: "location", custodianId: "custodian", items: [{ lineId: "purchase-line", quantity: "1", lotLabel: "future" }], evidence }, 422, "RECEIPT_DATE_FUTURE"],
      ["receipt-expiry", { purchaseId: "purchase", receivedDate: today, locationId: "location", custodianId: "custodian", items: [{ lineId: "purchase-line", quantity: "1", lotLabel: "expired", expiresOn: "2020-01-01" }], evidence }, 422, "RECEIPT_EXPIRY_DATE"],
      ["receipt-zero", { purchaseId: "purchase", receivedDate: today, locationId: "location", custodianId: "custodian", items: [{ lineId: "purchase-line", quantity: "0", lotLabel: "zero" }], evidence }, 422, "STOCK_QUANTITY_POSITIVE"],
      ["receipt-negative", { purchaseId: "purchase", receivedDate: today, locationId: "location", custodianId: "custodian", items: [{ lineId: "purchase-line", quantity: "-1", lotLabel: "negative" }], evidence }, 400, undefined],
    ] as Array<[string, Record<string, unknown>, number, string | undefined]>) {
      const result = await rejected("stock", targetId, "GoodsReceived", data, expectedStatus, expectedCode);
      await assertNoCreatedCommand(result.request.requestId, targetId);
      assert.equal(await db.goodsReceipt.count({ where: { id: targetId } }), 0);
      assert.equal(await db.inventoryLot.count(), lotCount);
      assert.equal(await db.stockBalance.count(), balanceCount);
      assert.equal(await db.stockFact.count(), factCount);
      assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: "purchase" } })).status, "approved");
    }
    const received = await command("stock", "receipt-valid", "GoodsReceived", {
      purchaseId: "purchase", receivedDate: today, locationId: "location", custodianId: "custodian",
      items: [{ lineId: "purchase-line", quantity: "2", lotLabel: "valid receipt", expiresOn: future }], evidence,
    });
    assert.equal(received.result.receipt.receivedDate, today);
    assert.equal(received.result.lots[0].quantity, "2.000");
    assert.equal(await db.goodsReceipt.count({ where: { id: "receipt-valid" } }), 1);
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: "purchase" } })).status, "partially_received");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: received.result.lots[0].balanceId } })).quantity.toString(), "2");
    assert.equal(await db.stockFact.count(), factCount + 1);

    await command("owner", "sku-weight", "CatalogSkuCreated", { code: "SYN-WEIGHT", name: "Synthetic weight", variety: "Weight", category: "flower", unit: "g", evidence });
    await command("owner", "purchase-weight", "PurchaseOrderCreated", {
      supplierId: "supplier", agreementDate: today, currency: "ARS",
      items: [{ lineId: "purchase-weight-line", skuId: "sku-weight", unit: "g", quantity: "20", unitCost: "1" }], evidence,
    });
    await command("stock", "purchase-weight", "PurchaseOrderApproved", { evidence });
    const weightReceipt = await command("stock", "receipt-weight", "GoodsReceived", {
      purchaseId: "purchase-weight", receivedDate: today, locationId: "location", custodianId: "custodian",
      items: [{ lineId: "purchase-weight-line", quantity: "16", lotLabel: "synthetic weight lot" }], evidence,
    });
    const weightLot = weightReceipt.result.lots[0] as { lotId: string; balanceId: string };
    const weightBalance = await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } });
    assert.equal(weightBalance.quantity.toString(), "16");
    assert.equal((await db.purchaseOrder.findUniqueOrThrow({ where: { id: "purchase-weight" } })).status, "partially_received");

    await approveAvailability(4, [{ locationId: "location", custodianId: "custodian", channel: "local", available: true, reason: "Synthetic local weight fulfillment approved" }]);
    await command("owner", "preparation-limits", "ConfigurationProposed", {
      name: "Synthetic preparation limits", kind: "preparation_limits", version: 1, validFrom: today, validUntil: "2099-12-31",
      definition: { maximumGramsPerOrder: "100", maximumExtraGramsPerLine: "0.1", maximumExtraBps: 100, evidence }, evidence,
    });
    await command("owner", "preparation-limits", "ConfigurationApproved", { evidence });
    await command("owner", "order-weight", "OrderCreated", { memberId: "member", channel: "local", currency: "ARS" });
    await command("owner", "order-weight", "OrderQuoted", {
      currency: "ARS", paymentMethod: "cash",
      items: [{ id: "line-weight", skuId: "sku-weight", quantity: "15", manualUnitPrice: "100", manualReason: "Synthetic weight preparation" }],
    });
    await command("owner", "order-weight", "OrderConfirmed", { quoteVersion: 1, acceptance: evidence });
    const weightReservation = await db.stockReservation.findFirstOrThrow({ where: { orderId: "order-weight", status: "active" } });
    assert.equal(weightReservation.quantity.toString(), "15");

    await db.operationAccess.create({ data: {
      userId: "outside-custodian", profile: "stock", capabilities: ["operations.read", "stock.read", "stock.prepare"],
      scope: { locationIds: ["location"], custodianIds: ["outside-custodian"] },
    } });
    await login("outside-custodian");
    const firstWeightAllocation = { lineId: "line-weight", lotId: weightLot.lotId, balanceId: weightLot.balanceId, requestedQuantity: "10", actualQuantity: "10.07" };
    const beforeCustodyDenial = await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } });
    const custodyDenied = await rejected("outside-custodian", "order-weight", "OrderPrepared", { allocations: [firstWeightAllocation], evidence }, 403, "STOCK_CUSTODIAN_SCOPE");
    assert.equal(await db.preparationAllocation.count({ where: { orderId: "order-weight" } }), 0);
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } })).quantity.toString(), beforeCustodyDenial.quantity.toString());
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } })).reserved.toString(), beforeCustodyDenial.reserved.toString());
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: custodyDenied.request.requestId } }), null);

    const wrongSku = await rejected("owner", "order-weight", "OrderPrepared", {
      allocations: [{ lineId: "line-weight", lotId: "lot-a", balanceId: "balance-a", requestedQuantity: "1", actualQuantity: "1" }], evidence,
    }, 422, "PREPARATION_STOCK_SCOPE");
    assert.equal(await db.preparationAllocation.count({ where: { orderId: "order-weight" } }), 0);
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-a" } })).quantity.toString(), "5");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: wrongSku.request.requestId } }), null);

    await command("owner", "order-weight", "OrderPrepared", { allocations: [firstWeightAllocation], evidence });
    const partiallyPreparedBalance = await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } });
    assert.equal(partiallyPreparedBalance.quantity.toString(), "5.93");
    assert.equal(partiallyPreparedBalance.reserved.toString(), "5");
    const partiallyPreparedReservation = await db.stockReservation.findFirstOrThrow({ where: { orderId: "order-weight", status: "active" } });
    assert.equal(partiallyPreparedReservation.quantity.toString(), "15");
    assert.equal(partiallyPreparedReservation.consumed.toString(), "10");
    const weightLine = await db.operationOrderLine.findUniqueOrThrow({ where: { id: "line-weight" } });
    assert.equal(weightLine.prepared.toString(), "10.07");
    assert.equal(weightLine.extra.toString(), "0.07");
    assert.equal(weightLine.revenueMinor, 150000n);
    assert.equal((await db.operationOrder.findUniqueOrThrow({ where: { id: "order-weight" } })).fulfillmentState, "partially_prepared");
    const acceptedRevenue = weightLine.revenueMinor;

    await db.stockBalance.update({ where: { id: weightLot.balanceId }, data: { reserved: "4.96" } });
    await db.stockReservation.update({ where: { id: partiallyPreparedReservation.id }, data: { quantity: "14.96" } });
    await db.stockBalance.create({ data: {
      id: "000-hidden-balance", lotId: weightLot.lotId, locationId: "location", custodianId: "custodian-b",
      unit: "g", quantity: "0.04", reserved: "0.04",
    } });
    await db.stockReservation.create({ data: {
      id: "000-hidden-reservation", orderId: "order-weight", lineId: "line-weight", balanceId: "000-hidden-balance",
      quantity: "0.04", consumed: "0", status: "active",
    } });
    await db.operationAccess.create({ data: {
      userId: "scoped-preparer", profile: "stock", capabilities: ["operations.read", "stock.read", "stock.prepare"],
      scope: { locationIds: ["location"], custodianIds: ["custodian"] },
    } });
    await login("scoped-preparer");
    const versionBeforeScopeRollback = (await db.operationObject.findUniqueOrThrow({ where: { id: "order-weight" } })).version;
    const allocationsBeforeScopeRollback = await db.preparationAllocation.count({ where: { orderId: "order-weight" } });
    const factsBeforeScopeRollback = await db.stockFact.count({ where: { orderId: "order-weight" } });
    const outOfScopeRelease = await rejected("scoped-preparer", "order-weight", "OrderPrepared", {
      allocations: [{ lineId: "line-weight", lotId: weightLot.lotId, balanceId: weightLot.balanceId, requestedQuantity: "4", actualQuantity: "4" }], evidence,
    }, 403, "STOCK_CUSTODIAN_SCOPE");
    assert.equal(await db.stockFact.count({ where: { requestId: outOfScopeRelease.request.requestId } }), 0);
    assert.equal(await db.preparationAllocation.count({ where: { orderId: "order-weight" } }), allocationsBeforeScopeRollback);
    assert.equal((await db.operationOrderLine.findUniqueOrThrow({ where: { id: "line-weight" } })).prepared.toString(), "10.07");
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: "order-weight" } })).version, versionBeforeScopeRollback);
    assert.equal(await db.stockFact.count({ where: { orderId: "order-weight" } }), factsBeforeScopeRollback);
    assert.deepEqual(
      (await db.stockBalance.findMany({ where: { id: { in: [weightLot.balanceId, "000-hidden-balance"] } }, orderBy: { id: "asc" } }))
        .map((row) => [row.id, row.quantity.toString(), row.reserved.toString()]),
      [["000-hidden-balance", "0.04", "0.04"], [weightLot.balanceId, "5.93", "4.96"]].sort((a, b) => a[0].localeCompare(b[0])),
    );
    assert.deepEqual(
      (await db.stockReservation.findMany({ where: { orderId: "order-weight", status: "active" }, orderBy: { id: "asc" } }))
        .map((row) => [row.id, row.quantity.toString(), row.consumed.toString()]),
      [["000-hidden-reservation", "0.04", "0"], [partiallyPreparedReservation.id, "14.96", "10"]].sort((a, b) => a[0].localeCompare(b[0])),
    );
    await db.stockReservation.delete({ where: { id: "000-hidden-reservation" } });
    await db.stockBalance.delete({ where: { id: "000-hidden-balance" } });
    await db.stockBalance.update({ where: { id: weightLot.balanceId }, data: { reserved: "5" } });
    await db.stockReservation.update({ where: { id: partiallyPreparedReservation.id }, data: { quantity: "15" } });

    await command("owner", "order-weight", "OrderPrepared", {
      allocations: [{ lineId: "line-weight", lotId: weightLot.lotId, balanceId: weightLot.balanceId, requestedQuantity: "5", actualQuantity: "5" }], evidence,
    });
    const completedPreparation = await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } });
    assert.equal(completedPreparation.quantity.toString(), "0.93");
    assert.equal(completedPreparation.reserved.toString(), "0");
    assert.equal(await db.stockReservation.count({ where: { orderId: "order-weight", status: "active" } }), 0);
    const completedReservation = await db.stockReservation.findFirstOrThrow({ where: { orderId: "order-weight", status: "consumed" } });
    assert.equal(completedReservation.quantity.toString(), "15");
    assert.equal(completedReservation.consumed.toString(), "15");
    const completedLine = await db.operationOrderLine.findUniqueOrThrow({ where: { id: "line-weight" } });
    assert.equal(completedLine.prepared.toString(), "15.07");
    assert.equal(completedLine.extra.toString(), "0.07");
    assert.equal(completedLine.revenueMinor, acceptedRevenue);

    await command("owner", "order-weight", "LocalPickupCompleted", { lines: [{ lineId: "line-weight", quantity: "15", actualQuantity: "15.07" }], evidence });
    const allocation = await db.preparationAllocation.findFirstOrThrow({ where: { orderId: "order-weight", requestedQuantity: "10" } });
    const beforeUnfitReturn = await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } });
    const unfitReturn = await command("stock", "order-weight", "OrderReturnInspected", {
      returns: [{ lineId: "line-weight", allocationId: allocation.id, quantity: "1", origin: "customer", disposition: "merma", evidence }], evidence,
    });
    assert.equal(unfitReturn.result.result.returns[0].disposition, "merma");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } })).quantity.toString(), beforeUnfitReturn.quantity.toString());
    assert.equal(await db.stockFact.count({ where: { requestId: unfitReturn.requestId, kind: "return" } }), 1);
    const returnedAllocation = await db.preparationAllocation.findUniqueOrThrow({ where: { id: allocation.id } });
    assert.equal(returnedAllocation.returnedDeliveredQuantity.toString(), "1");
    const overReturn = await rejected("stock", "order-weight", "OrderReturnInspected", {
      returns: [{ lineId: "line-weight", allocationId: allocation.id, quantity: "15", origin: "customer", disposition: "restock", evidence }], evidence,
    }, 422, "CUSTOMER_RETURN_LIMIT");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: overReturn.request.requestId } }), null);
    assert.equal((await db.preparationAllocation.findUniqueOrThrow({ where: { id: allocation.id } })).returnedDeliveredQuantity.toString(), "1");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } })).quantity.toString(), beforeUnfitReturn.quantity.toString());

    const countRowsBeforeNegative = await db.operationalStockCount.count();
    const countBalanceBeforeNegative = await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } });
    const negativeCount = await rejected("owner", "stock-count-negative", "StockCountRecorded", {
      balanceId: weightLot.balanceId, countedQuantity: "-1", evidence,
    }, 400);
    assert.match(negativeCount.body.error, /countedQuantity/);
    await assertNoCreatedCommand(negativeCount.request.requestId, "stock-count-negative");
    assert.equal(await db.operationalStockCount.count(), countRowsBeforeNegative);
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } })).quantity.toString(), countBalanceBeforeNegative.quantity.toString());

    await command("stock", "stock-count-zero", "StockCountRecorded", {
      balanceId: weightLot.balanceId, countedQuantity: "0", evidence,
    });
    const pendingZeroCount = await db.operationalStockCount.findUniqueOrThrow({ where: { id: "stock-count-zero" } });
    assert.equal(pendingZeroCount.countedQuantity.toString(), "0");
    assert.equal(pendingZeroCount.status, "pending");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } })).quantity.toString(), "0.93");
    const approvedZeroCount = await command("owner", "stock-count-zero", "StockCountAdjustmentApproved", {
      reason: "Synthetic empty physical balance verified", evidence,
    });
    assert.equal(approvedZeroCount.result.count.status, "approved");
    assert.equal(approvedZeroCount.result.difference, "-0.930");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: weightLot.balanceId } })).quantity.toString(), "0");

    await approveAvailability(5, [{ locationId: "location", custodianId: "custodian", channel: "delivery", available: true, reason: "Synthetic delivery custody regression" }]);
    await db.inventoryLot.create({ data: {
      id: "lot-partial-return", skuId: "sku-weight", label: "Partial return custody lot", unit: "g", unitCost: "1",
      costCurrency: "ARS", receivedAt: new Date(`${today}T12:00:00-03:00`),
    } });
    await db.stockBalance.create({ data: {
      id: "balance-partial-return", lotId: "lot-partial-return", locationId: "location", custodianId: "custodian",
      unit: "g", quantity: "10", reserved: "0",
    } });
    await command("owner", "order-partial-return", "OrderCreated", { memberId: "member", channel: "delivery", currency: "ARS" });
    await command("owner", "order-partial-return", "OrderQuoted", {
      currency: "ARS", paymentMethod: "cash",
      items: [{ id: "line-partial-return", skuId: "sku-weight", quantity: "10", manualUnitPrice: "100", manualReason: "Partial undelivered custody regression" }],
    });
    const partialReturnOrder = await command("owner", "order-partial-return", "OrderConfirmed", { quoteVersion: 1, acceptance: evidence });
    await command("owner", "order-partial-return", "OrderPrepared", {
      allocations: [{ lineId: "line-partial-return", lotId: "lot-partial-return", balanceId: "balance-partial-return", requestedQuantity: "10", actualQuantity: "10" }], evidence,
    });
    await command("owner", "route-partial-return", "RouteCreated", { driverId: "driver", shiftDate: today });
    await command("owner", partialReturnOrder.result.deliveryId, "DeliveryAssigned", {
      routeId: "route-partial-return", driverId: "driver", stopSequence: 0, evidence,
    });
    await command("owner", partialReturnOrder.result.deliveryId, "DeliveryDispatched", { evidence });
    const partialReturnAllocation = await db.preparationAllocation.findFirstOrThrow({ where: { orderId: "order-partial-return" } });
    await command("stock", "order-partial-return", "OrderReturnInspected", {
      returns: [{ lineId: "line-partial-return", allocationId: partialReturnAllocation.id, quantity: "1", origin: "undelivered", disposition: "merma", evidence }], evidence,
    });
    const cancelBefore = {
      object: await db.operationObject.findUniqueOrThrow({ where: { id: "order-partial-return" } }),
      order: await db.operationOrder.findUniqueOrThrow({ where: { id: "order-partial-return" } }),
      line: await db.operationOrderLine.findUniqueOrThrow({ where: { id: "line-partial-return" } }),
      balance: await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-partial-return" } }),
      facts: await db.stockFact.count({ where: { orderId: "order-partial-return" } }),
    };
    const partialCancel = await send("owner", "order-partial-return", "OrderCancelled", { reason: "Must inspect all dispatched custody first", evidence });
    const partialCancelAfter = {
      status: partialCancel.response.status,
      code: partialCancel.body.code ?? null,
      commercialState: (await db.operationOrder.findUniqueOrThrow({ where: { id: "order-partial-return" } })).commercialState,
      fulfillmentState: (await db.operationOrder.findUniqueOrThrow({ where: { id: "order-partial-return" } })).fulfillmentState,
      lineCancelled: (await db.operationOrderLine.findUniqueOrThrow({ where: { id: "line-partial-return" } })).cancelled.toString(),
      balanceQuantity: (await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-partial-return" } })).quantity.toString(),
      balanceReserved: (await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-partial-return" } })).reserved.toString(),
      stockFacts: await db.stockFact.count({ where: { orderId: "order-partial-return" } }),
      receipt: Boolean(await db.commandReceipt.findUnique({ where: { requestId: partialCancel.request.requestId } })),
      outbox: Boolean(await db.operationOutbox.findFirst({ where: { requestId: partialCancel.request.requestId } })),
    };
    console.log("BASELINE_PARTIAL_RETURN_CANCEL", JSON.stringify({
      status: partialCancelAfter.status, code: partialCancelAfter.code,
      expected: { status: 409, code: "PHYSICAL_RETURN_REQUIRED", noReceipt: true, noOutbox: true },
      before: { commercialState: cancelBefore.order.commercialState, fulfillmentState: cancelBefore.order.fulfillmentState, lineCancelled: cancelBefore.line.cancelled.toString(), balanceQuantity: cancelBefore.balance.quantity.toString(), balanceReserved: cancelBefore.balance.reserved.toString(), stockFacts: cancelBefore.facts },
      after: partialCancelAfter,
    }));
    assert.equal(partialCancel.response.status, 409, JSON.stringify(partialCancelAfter));
    assert.equal(partialCancel.body.code, "PHYSICAL_RETURN_REQUIRED", JSON.stringify(partialCancel.body));
    assert.equal(partialCancelAfter.commercialState, cancelBefore.order.commercialState);
    assert.equal(partialCancelAfter.fulfillmentState, cancelBefore.order.fulfillmentState);
    assert.equal(partialCancelAfter.lineCancelled, cancelBefore.line.cancelled.toString());
    assert.equal(partialCancelAfter.balanceQuantity, cancelBefore.balance.quantity.toString());
    assert.equal(partialCancelAfter.balanceReserved, cancelBefore.balance.reserved.toString());
    assert.equal(partialCancelAfter.stockFacts, cancelBefore.facts);
    assert.equal(partialCancelAfter.receipt, false);
    assert.equal(partialCancelAfter.outbox, false);

    await command("stock", "order-partial-return", "OrderReturnInspected", {
      returns: [{ lineId: "line-partial-return", allocationId: partialReturnAllocation.id, quantity: "9", origin: "undelivered", disposition: "restock", evidence }], evidence,
    });
    const fullyInspectedAllocation = await db.preparationAllocation.findUniqueOrThrow({ where: { id: partialReturnAllocation.id } });
    assert.equal(fullyInspectedAllocation.returnedQuantity.toString(), "10");
    assert.equal(fullyInspectedAllocation.state, "returned");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-partial-return" } })).quantity.toString(), "9");
    await command("owner", "order-partial-return", "OrderCancelled", { reason: "All remaining delivery custody inspected", evidence });
    const closedAfterReturn = await db.operationOrderLine.findUniqueOrThrow({ where: { id: "line-partial-return" } });
    assert.equal(closedAfterReturn.cancelled.toString(), "10");
    assert.equal((await db.preparationAllocation.findUniqueOrThrow({ where: { id: partialReturnAllocation.id } })).state, "returned");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-partial-return" } })).quantity.toString(), "9");

    // Complete every physical allocation, including the extra weight. The
    // original nominal quote remains fully reversible after a complete return.
    const secondAllocation = await db.preparationAllocation.findFirstOrThrow({ where: { orderId: "order-weight", requestedQuantity: "5" } });
    await command("stock", "order-weight", "OrderReturnInspected", {
      returns: [
        { lineId: "line-weight", allocationId: allocation.id, quantity: "9.07", origin: "customer", disposition: "restock", evidence },
        { lineId: "line-weight", allocationId: secondAllocation.id, quantity: "5", origin: "customer", disposition: "restock", evidence },
      ], evidence,
    });
    const returnedLine = await db.operationOrderLine.findUniqueOrThrow({ where: { id: "line-weight" } });
    assert.equal(returnedLine.returned.toString(), "15.07");
    assert.equal(returnedLine.delivered.toString(), "15");
    assert.equal(returnedLine.costMinor, 0n);
    await command("owner", "weight-cash", "AccountCreated", { name: "Synthetic return cash", currency: "ARS", kind: "cash", holder: "Club", purpose: "Synthetic complete return" });
    await command("owner", "weight-cash", "AccountVerified", { evidence });
    await command("owner", "weight-cash", "AccountOpeningApproved", { amountMinor: "0", preparedBy: "stock", evidence });
    await command("owner", "weight-collection", "CollectionReported", { orderId: "order-weight", method: "cash", currency: "ARS", amountMinor: "150000", evidence });
    await command("owner", "weight-collection", "CollectionVerified", { accountId: "weight-cash", evidence });
    await rejected("owner", "order-weight", "OrderRefunded", {
      accountId: "weight-cash", amountMinor: "150001", lines: [{ lineId: "line-weight", amountMinor: "150001" }], reason: "Must not exceed verified original quote", evidence,
    }, 422, "REFUND_VERIFIED_LIMIT");
    await command("owner", "order-weight", "OrderRefunded", {
      accountId: "weight-cash", amountMinor: "150000", lines: [{ lineId: "line-weight", amountMinor: "150000" }], reason: "Complete physical return of all nominal preparation", evidence,
    });
    const fullyRefunded = await db.operationOrder.findUniqueOrThrow({ where: { id: "order-weight" } });
    assert.equal(fullyRefunded.refundedMinor, 150000n);
    assert.equal(fullyRefunded.financialState, "refunded");
    assert.equal((await db.operationOrderLine.findUniqueOrThrow({ where: { id: "line-weight" } })).refundedMinor, 150000n);
    assert.equal((await db.ledgerLeg.aggregate({ where: { accountId: "weight-cash" }, _sum: { amountMinor: true } }))._sum.amountMinor, 0n);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (schemaCreated && cleanupDb) {
      await cleanupDb.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await cleanupDb.$disconnect();
    }
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
