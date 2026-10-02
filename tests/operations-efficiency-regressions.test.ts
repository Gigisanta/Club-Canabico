import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Server } from "node:http";
import type { User } from "@prisma/client";
import bcrypt from "bcryptjs";
import express, { type NextFunction, type Request, type Response } from "express";
import { splitSqlStatements } from "./migration-sql.js";

const routerVariant = process.env.BOMBO_ROUTER_VARIANT === "baseline" ? "baseline" : "fixed";

// The owner is the HTTP API boundary: these cases seed only pre-existing records, then
// inspect the authenticated response and durable state. No route or Prisma mocks.
test("operations API pagination, scopes, balances and current revocation", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(testUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(testUrl.pathname, /bombo_ui_(test|ci|optimization)/i, "usar sólo una base descartable bombo_ui_");

  const schema = `effreg_${randomUUID().replaceAll("-", "")}`;
  testUrl.searchParams.set("schema", schema);
  process.env.DATABASE_URL = testUrl.toString();
  process.env.DEMO_MODE = "true";
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "optimization-test-only-secret-more-than-32-characters";
  process.env.ALLOWED_ORIGIN = "http://optimization.test";

  const { db } = await import("../server/db.js");
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  let server: Server | undefined;
  try {
    const migrationRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const password = await bcrypt.hash("Only-a-local-optimization-123", 4);
    const actorIds = [
      "logistics-reader", "member-reader", "finance-reader", "replay-owner",
      "stock-reader", "stock-writer", "custodian-visible", "custodian-private",
    ];
    const actors = new Map<string, User>();
    for (const id of actorIds) {
      actors.set(id, await db.user.create({
        data: {
          id,
          name: `Synthetic ${id}`,
          email: `${id}@optimization.test`,
          password,
          role: id === "replay-owner" ? "owner" : "admin",
        },
      }));
    }

    const memberIds = Array.from({ length: 205 }, (_, index) => `member-${String(index).padStart(3, "0")}`);
    const longTailMemberId = "member-visible-long-tail";
    const outOfScopeMemberId = "member-private-long-tail";
    await db.operationAccess.create({
      data: {
        userId: "logistics-reader",
        profile: "logistics",
        capabilities: ["logistics.write"],
        scope: { custodianIds: ["driver-visible"] },
      },
    });
    await db.operationAccess.create({
      data: {
        userId: "member-reader",
        profile: "commercial",
        capabilities: ["members.read"],
        scope: { memberIds: [...memberIds, longTailMemberId] },
      },
    });
    await db.operationAccess.create({
      data: {
        userId: "finance-reader",
        profile: "finance",
        capabilities: ["finance.read"],
        scope: { accountIds: ["account-visible"] },
      },
    });
    await db.operationAccess.createMany({
      data: [
        {
          userId: "stock-reader",
          profile: "stock",
          capabilities: ["operations.read", "stock.read", "stock.prepare"],
          scope: { locationIds: ["location-visible"], custodianIds: ["custodian-visible"] },
        },
        {
          userId: "stock-writer",
          profile: "stock",
          capabilities: ["stock.adjust"],
          scope: { locationIds: ["location-visible"], custodianIds: ["custodian-visible", "custodian-private"] },
        },
      ],
    });

    await db.location.createMany({
      data: [
        { id: "location-visible", key: "optimization-visible", name: "Synthetic visible location" },
        { id: "location-private", key: "optimization-private", name: "Synthetic private location" },
      ],
    });
    await db.catalogSku.create({
      data: { id: "stock-sku", code: "OPT-STOCK-SCOPE", name: "Synthetic scoped stock", variety: "Fixture", category: "Regression", unit: "ud" },
    });
    await db.inventoryLot.create({
      data: {
        id: "stock-lot", skuId: "stock-sku", label: "Synthetic scope lot", unit: "ud",
        unitCost: "1", costCurrency: "ARS", receivedAt: new Date("2026-09-30T12:00:00.000Z"),
      },
    });
    await db.stockBalance.createMany({
      data: [
        { id: "balance-visible", lotId: "stock-lot", locationId: "location-visible", custodianId: "custodian-visible", unit: "ud", quantity: "10", reserved: "1" },
        { id: "balance-private-location", lotId: "stock-lot", locationId: "location-private", custodianId: "custodian-visible", unit: "ud", quantity: "4", reserved: "0" },
        { id: "balance-private-custodian", lotId: "stock-lot", locationId: "location-visible", custodianId: "custodian-private", unit: "ud", quantity: "3", reserved: "0" },
      ],
    });
    await db.operationOrder.create({
      data: {
        id: "stock-scope-order", memberId: "member-stock-scope", channel: "local", currency: "ARS",
        quote: {}, address: {}, createdBy: "stock-reader",
      },
    });
    await db.stockReservation.createMany({
      data: [
        { id: "reservation-visible", orderId: "stock-scope-order", lineId: "line-visible", balanceId: "balance-visible", quantity: "1" },
        { id: "reservation-private-location", orderId: "stock-scope-order", lineId: "line-private-location", balanceId: "balance-private-location", quantity: "1" },
        { id: "reservation-private-custodian", orderId: "stock-scope-order", lineId: "line-private-custodian", balanceId: "balance-private-custodian", quantity: "1" },
      ],
    });

    await db.operationMember.createMany({
      data: [
        ...memberIds.map((id, index) => ({
          id,
          name: `Member ${String(index).padStart(3, "0")}`,
          address: {},
          preferences: {},
        })),
        { id: longTailMemberId, name: "ZZZ ScopeNeedle visible", email: "scoped-contact@members.test", address: {}, preferences: {} },
        { id: outOfScopeMemberId, name: "ZZZ ScopeNeedle private", email: "scoped-contact@members.test", address: {}, preferences: {} },
      ],
    });

    await db.deliveryRoute.create({ data: { id: "route-visible", driverId: "driver-visible", shiftDate: "2026-10-01" } });
    await db.deliveryAssignment.createMany({
      data: [
        { id: "delivery-assigned", orderId: "order-assigned", routeId: "route-visible", driverId: "driver-visible", status: "assigned", address: {}, incidents: [] },
        { id: "delivery-unassigned", orderId: "order-unassigned", routeId: null, driverId: "driver-visible", status: "pending", address: { label: "Fixture address" }, incidents: [] },
        { id: "delivery-private", orderId: "order-private", routeId: null, driverId: "driver-private", status: "pending", address: {}, incidents: [] },
        { id: "delivery-terminal", orderId: "order-terminal", routeId: null, driverId: "driver-visible", status: "cancelled", address: {}, incidents: [] },
      ],
    });

    const visibleAccountId = "account-visible";
    const privateAccountId = "account-private";
    await db.operationAccount.createMany({
      data: [
        { id: visibleAccountId, name: "Synthetic visible cash", currency: "ARS", kind: "cash", holder: "club", purpose: "fixture", verified: true, openingApprovedBy: "replay-owner" },
        { id: privateAccountId, name: "Synthetic private account", currency: "ARS", kind: "bank", holder: "club", purpose: "scope fixture", verified: true, openingApprovedBy: "replay-owner" },
      ],
    });
    const historicalEvents = Array.from({ length: 205 }, (_, index) => ({
      id: `event-${String(index).padStart(3, "0")}`,
      requestId: randomUUID(),
      kind: "fixture",
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      actorId: "finance-reader",
      sourceObjectId: `fixture-${index}`,
      description: `Synthetic historical entry ${index}`,
      metadata: { fixture: "optimization-regression" },
    }));
    const privateEventId = "event-private";
    await db.ledgerEvent.createMany({
      data: [
        ...historicalEvents,
        {
          id: privateEventId,
          requestId: randomUUID(),
          kind: "fixture",
          occurredAt: new Date(Date.UTC(2026, 0, 2)),
          actorId: "finance-reader",
          sourceObjectId: "private-fixture",
          description: "Private synthetic ledger marker",
          metadata: { fixture: "optimization-regression" },
        },
      ],
    });
    const specialLegId = "leg-000";
    const privateAmount = 9_876_543_210n;
    await db.ledgerLeg.createMany({
      data: [
        ...historicalEvents.map((event, index) => ({
          id: `leg-${String(index).padStart(3, "0")}`,
          eventId: event.id,
          accountId: visibleAccountId,
          currency: "ARS",
          amountMinor: index === 0 ? 2_147_483_648n : 1n,
        })),
        { id: "leg-private", eventId: privateEventId, accountId: privateAccountId, currency: "ARS", amountMinor: privateAmount },
      ],
    });

    let base: string;
    const cookies: Record<string, string> = {};
    if (routerVariant === "baseline") {
      const { operationsRoutes } = await import("../server/operations/routes.optimization-baseline.js");
      const api = express();
      api.use(express.json());
      api.use("/api/operations", (req, res, next) => {
        const actor = actors.get(req.get("x-test-actor") ?? "");
        if (!actor) return res.status(401).json({ error: "Synthetic router fixture identity required" });
        Object.assign(req, { user: actor });
        next();
      }, operationsRoutes);
      api.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        const failure = error as { status?: unknown; code?: unknown; message?: unknown };
        const status = typeof failure.status === "number" ? failure.status : 500;
        res.status(status).json({ error: String(failure.message ?? "Internal error"), ...(failure.code ? { code: failure.code } : {}) });
      });
      server = api.listen(0, "127.0.0.1");
    } else {
      const { app } = await import("../server/app.js");
      server = app.listen(0, "127.0.0.1");
    }
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}/api`;

    async function login(id: string) {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { Origin: "http://optimization.test", "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@optimization.test`, password: "Only-a-local-optimization-123" }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0];
    }
    if (routerVariant === "fixed") for (const id of actorIds) await login(id);

    async function call(path: string, actorId: string, body?: unknown) {
      const headers: Record<string, string> = { Origin: "http://optimization.test" };
      if (routerVariant === "baseline") headers["x-test-actor"] = actorId;
      else headers.Cookie = cookies[actorId];
      if (body !== undefined) headers["Content-Type"] = "application/json";
      return fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }

    await t.test("catalog, orders and purchases paginate equal sort keys without losing the long tail", async () => {
      const names=Array.from({length:5},(_,n)=>`page-fixture-${n}`);
      await db.catalogSku.createMany({data:names.map(id=>({id,code:id,name:"Synthetic paged",variety:"Fixture",category:"Same",unit:"ud"}))});
      await db.operationOrder.createMany({data:names.map(id=>({id,memberId:"page-member",channel:"local",currency:"ARS",quote:{},address:{},createdBy:"replay-owner",createdAt:new Date("2026-01-01T12:00:00Z")}))});
      await db.purchaseOrder.createMany({data:names.map(id=>({id,supplierId:"page-supplier",agreementDate:"2026-01-01",currency:"ARS",totalMinor:1n,items:[]}))});
      for(const [path,expected] of [["catalog?q=Synthetic%20paged",5],["orders",6],["purchases",5]] as const){
        const collected:string[]=[];let cursor:string|null=null;let pages=0;
        do{const response=await call(`/operations/${path}${path.includes("?")?"&":"?"}limit=2${cursor?`&cursor=${encodeURIComponent(cursor)}`:""}`,"replay-owner");assert.equal(response.status,200);const page=await response.json();assert.ok(page.items.length<=2);collected.push(...page.items.map((row:{id:string})=>row.id));assert.equal(page.hasMore,Boolean(page.nextCursor));cursor=page.nextCursor;assert.ok(++pages<=4);}while(cursor);
        assert.equal(collected.length,expected);assert.equal(new Set(collected).size,expected);for(const id of names)assert.ok(collected.includes(id));
      }
      assert.equal((await call("/operations/catalog?q=Synthetic%20paged&cursor=stock-sku","replay-owner")).status,400);
    });

    await t.test("catalog, order reservations and stock reference data honor location and custodian scope", async () => {
      const catalogResponse = await call("/operations/catalog?channel=local", "stock-reader");
      const catalog = await catalogResponse.json();
      assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
      const balances = catalog.items.flatMap((sku: { lots: Array<{ balances: Array<{ id: string }> }> }) =>
        sku.lots.flatMap((lot) => lot.balances));
      assert.deepEqual(balances.map((balance: { id: string }) => balance.id), ["balance-visible"]);

      const orderResponse = await call("/operations/orders/stock-scope-order", "stock-reader");
      const order = await orderResponse.json();
      assert.equal(orderResponse.status, 200, JSON.stringify(order));
      assert.deepEqual(order.reservations.map((reservation: { id: string }) => reservation.id), ["reservation-visible"]);

      const referenceResponse = await call("/operations/stock/reference-data", "stock-reader");
      const reference = await referenceResponse.json();
      assert.equal(referenceResponse.status, 200, JSON.stringify(reference));
      assert.deepEqual(reference.locations.map((item: { id: string }) => item.id), ["location-visible"]);
      assert.deepEqual(reference.custodians.map((item: { id: string }) => item.id), ["custodian-visible"]);
    });

    await t.test("a waste command replay is denied after its custodian leaves the active scope", { skip: routerVariant === "baseline" }, async () => {
      const request = {
        schemaVersion: 1,
        requestId: randomUUID(),
        targetId: "waste-target-after-scope-reduction",
        command: "StockWasteRecorded",
        data: { balanceId: "balance-private-custodian", quantity: "1", reason: "Synthetic custody replay check", evidence: { source: "disposable fixture" } },
        expectedVersion: 0,
        occurredAt: new Date().toISOString(),
      };
      const committed = await call("/operations/commands", "stock-writer", request);
      const committedBody = await committed.json();
      assert.equal(committed.status, 200, JSON.stringify(committedBody));
      assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 1);
      assert.equal(await db.stockFact.count({ where: { requestId: request.requestId } }), 1);

      const finalEffects = async () => ({
        receipts: await db.commandReceipt.count({ where: { requestId: request.requestId } }),
        facts: await db.stockFact.count({ where: { requestId: request.requestId } }),
        outbox: await db.operationOutbox.count({ where: { requestId: request.requestId } }),
        audits: await db.operationAudit.count({ where: { requestId: request.requestId } }),
        balance: (await db.stockBalance.findUniqueOrThrow({ where: { id: "balance-private-custodian" } })).quantity.toString(),
        version: (await db.operationObject.findUniqueOrThrow({ where: { id: request.targetId } })).version,
      });
      const beforeReplay = await finalEffects();
      assert.equal(beforeReplay.receipts, 1);
      assert.equal(beforeReplay.facts, 1);
      assert.equal(beforeReplay.outbox, 1);
      assert.ok(beforeReplay.audits > 0, "el comando inicial debe dejar registrada su auditoría");
      assert.equal(beforeReplay.balance, "2");
      assert.equal(beforeReplay.version, 1);

      await db.operationAccess.update({
        where: { userId: "stock-writer" },
        data: { scope: { locationIds: ["location-visible"], custodianIds: ["custodian-visible"] } },
      });
      const replay = await call("/operations/commands", "stock-writer", request);
      const replayBody = await replay.json();
      assert.equal(replay.status, 403, JSON.stringify(replayBody));
      assert.equal(replayBody.code, "STOCK_CUSTODIAN_SCOPE");
      assert.deepEqual(await finalEffects(), beforeReplay, "el replay denegado no debe crear efectos ni modificar el saldo");
    });

    await t.test("OrderConfirmed replay cannot disclose reservations after custodian scope is reduced", { skip: routerVariant === "baseline" }, async () => {
      const memberId = `member-order-scope-${randomUUID()}`;
      const orderId = `order-custody-replay-${randomUUID()}`;
      const skuId = `sku-custody-replay-${randomUUID()}`;
      const lotId = `lot-custody-replay-${randomUUID()}`;
      const balanceId = `balance-custody-replay-${randomUUID()}`;
      const lineId = `${orderId}-line`;
      const evidence = { source: "disposable scope replay fixture" };

      await db.operationMember.create({ data: { id: memberId, name: "Synthetic scoped-order member", address: {}, preferences: {} } });
      await db.memberPermission.create({
        data: { memberId, kind: "operations", status: "verified", validFrom: "2026-01-01", validUntil: "2099-12-31" },
      });
      await db.catalogSku.create({
        data: { id: skuId, code: `OPT-${randomUUID()}`, name: "Synthetic private-custody SKU", variety: "Fixture", category: "Regression", unit: "ud" },
      });
      await db.inventoryLot.create({
        data: { id: lotId, skuId, label: "Synthetic private-custody lot", unit: "ud", unitCost: "1", costCurrency: "ARS", receivedAt: new Date("2026-09-30T12:00:00.000Z") },
      });
      await db.stockBalance.create({
        data: { id: balanceId, lotId, locationId: "location-visible", custodianId: "custodian-private", unit: "ud", quantity: "5", reserved: "0" },
      });
      await db.operationAccess.update({
        where: { userId: "stock-writer" },
        data: {
          capabilities: ["stock.adjust", "orders.write"],
          scope: { locationIds: ["location-visible"], custodianIds: ["custodian-visible", "custodian-private"] },
        },
      });

      const envelope = (command: string, expectedVersion: number, data: unknown) => ({
        schemaVersion: 1,
        requestId: randomUUID(),
        targetId: orderId,
        command,
        data,
        expectedVersion,
        occurredAt: new Date().toISOString(),
      });
      const created = await call("/operations/commands", "replay-owner", envelope("OrderCreated", 0, {
        memberId, channel: "local", currency: "ARS", address: {}, preorder: false,
      }));
      const createdBody = await created.json();
      assert.equal(created.status, 200, JSON.stringify(createdBody));

      const quoted = await call("/operations/commands", "replay-owner", envelope("OrderQuoted", 1, {
        currency: "ARS", paymentMethod: "cash",
        items: [{ id: lineId, skuId, quantity: "1", manualUnitPrice: "100", manualReason: "Synthetic scoped replay quote" }],
      }));
      const quotedBody = await quoted.json();
      assert.equal(quoted.status, 200, JSON.stringify(quotedBody));

      const confirmation = envelope("OrderConfirmed", 2, { quoteVersion: 1, acceptance: evidence });
      const committed = await call("/operations/commands", "stock-writer", confirmation);
      const committedBody = await committed.json();
      assert.equal(committed.status, 200, JSON.stringify(committedBody));
      assert.deepEqual(
        committedBody.result.reservations.reservations.map((reservation: { balanceId: string }) => reservation.balanceId),
        [balanceId],
      );

      const persistedState = async () => {
        const [receipts, outbox, audits, order, reservations, balance, object] = await Promise.all([
          db.commandReceipt.count({ where: { requestId: confirmation.requestId } }),
          db.operationOutbox.count({ where: { requestId: confirmation.requestId } }),
          db.operationAudit.count({ where: { requestId: confirmation.requestId } }),
          db.operationOrder.findUniqueOrThrow({
            where: { id: orderId },
            select: { commercialState: true, quoteVersion: true, confirmedAt: true, quote: true },
          }),
          db.stockReservation.findMany({
            where: { orderId }, orderBy: { id: "asc" }, select: { balanceId: true, quantity: true, status: true },
          }),
          db.stockBalance.findUniqueOrThrow({ where: { id: balanceId }, select: { quantity: true, reserved: true } }),
          db.operationObject.findUniqueOrThrow({ where: { id: orderId } }),
        ]);
        return {
          receipts,
          outbox,
          audits,
          order: { ...order, confirmedAt: order.confirmedAt?.toISOString() ?? null },
          reservations: reservations.map((reservation) => ({ ...reservation, quantity: reservation.quantity.toString() })),
          balance: { quantity: balance.quantity.toString(), reserved: balance.reserved.toString() },
          version: object.version,
        };
      };
      const beforeReplay = await persistedState();
      assert.equal(beforeReplay.receipts, 1);
      assert.equal(beforeReplay.outbox, 1);
      assert.equal(beforeReplay.audits, 1);
      assert.deepEqual(beforeReplay.reservations, [{ balanceId, quantity: "1", status: "active" }]);
      assert.deepEqual(beforeReplay.balance, { quantity: "5", reserved: "1" });
      assert.equal(beforeReplay.order.commercialState, "confirmed");
      assert.equal(beforeReplay.order.quoteVersion, 1);
      assert.equal(beforeReplay.version, 3);

      await db.operationAccess.update({
        where: { userId: "stock-writer" },
        data: { scope: { locationIds: ["location-visible"], custodianIds: ["custodian-visible"] } },
      });
      const replay = await call("/operations/commands", "stock-writer", confirmation);
      const replayBody = await replay.json();
      assert.equal(replay.status, 403, JSON.stringify(replayBody));
      assert.equal(replayBody.code, "STOCK_CUSTODIAN_SCOPE");
      assert.equal(replayBody.result, undefined);
      assert.ok(!JSON.stringify(replayBody).includes(balanceId), "la respuesta denegada no debe revelar el balance reservado");
      assert.deepEqual(await persistedState(), beforeReplay, "el replay denegado no debe cambiar orden, reserva, saldo, recibo, outbox, auditoría ni versión");
    });

    await t.test("/operations/routes includes eligible unassigned delivery within custodian scope", async () => {
      const response = await call("/operations/routes", "logistics-reader");
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.ok(Array.isArray(body.unassignedDeliveries), "la API debe devolver las entregas activas sin ruta");
      assert.deepEqual(body.unassignedDeliveries.map((item: { id: string }) => item.id), ["delivery-unassigned"]);
      assert.equal(body.unassignedHasMore, false);
      assert.deepEqual(body.deliveries.map((item: { id: string }) => item.id), ["delivery-assigned"]);
    });

    await t.test("member pages honor limit and cursor without duplicates or scope escape", async () => {
      const firstResponse = await call("/operations/members?limit=80", "member-reader");
      const first = await firstResponse.json();
      assert.equal(firstResponse.status, 200, JSON.stringify(first));
      assert.equal(first.items.length, 80);
      assert.equal(first.hasMore, true);
      assert.equal(first.nextCursor, first.items.at(-1).id);

      const secondResponse = await call(`/operations/members?limit=80&cursor=${encodeURIComponent(first.nextCursor)}`, "member-reader");
      const second = await secondResponse.json();
      assert.equal(secondResponse.status, 200, JSON.stringify(second));
      assert.equal(second.items.length, 80);
      const ids = [...first.items, ...second.items].map((item: { id: string }) => item.id);
      assert.equal(new Set(ids).size, ids.length, "las páginas no deben repetir socios");
      assert.ok(ids.every((id) => [...memberIds, longTailMemberId].includes(id)), "una página no debe filtrar socios fuera del alcance");
    });

    await t.test("member q finds a scoped record beyond the former 200-row window", async () => {
      for (const query of ["ScopeNeedle", "SCOPED-CONTACT@MEMBERS.TEST"]) {
        const response = await call(`/operations/members?q=${encodeURIComponent(query)}`, "member-reader");
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.deepEqual(body.items.map((item: { id: string }) => item.id), [longTailMemberId], `búsqueda ${query}`);
        assert.ok(!JSON.stringify(body).includes(outOfScopeMemberId));
      }
    });

    await t.test("member cursor is checked against the active member scope", async () => {
      const response = await call(`/operations/members?limit=80&cursor=${outOfScopeMemberId}`, "member-reader");
      const body = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.code, "PAGE_CURSOR");
    });

    await t.test("ledger pages preserve exact BigInt amounts and never repeat a leg", async () => {
      const collected: Array<{ id: string; amountMinor: string }> = [];
      let cursor: string | null = null;
      let pageCount = 0;
      do {
        const query = new URLSearchParams({ limit: "64" });
        if (cursor) query.set("cursor", cursor);
        const response = await call(`/operations/accounts/${visibleAccountId}/ledger?${query}`, "finance-reader");
        const body = await response.json();
        assert.equal(response.status, 200, JSON.stringify(body));
        assert.ok(body.items.length <= 64);
        collected.push(...body.items);
        pageCount += 1;
        assert.ok(pageCount <= 4, "el cursor debe avanzar hasta cubrir el historial completo");
        if (body.hasMore) {
          assert.equal(body.nextCursor, body.items.at(-1).id);
          assert.notEqual(body.nextCursor, cursor);
          cursor = body.nextCursor;
        } else {
          assert.equal(body.nextCursor, null);
          cursor = null;
          break;
        }
      } while (cursor);

      const ids = collected.map((item) => item.id);
      assert.equal(ids.length, historicalEvents.length);
      assert.equal(new Set(ids).size, ids.length, "un cursor no debe repetir movimientos");
      assert.deepEqual([...ids].sort(), historicalEvents.map((_, index) => `leg-${String(index).padStart(3, "0")}`).sort());
      assert.equal(collected.find((item) => item.id === specialLegId)?.amountMinor, "2147483648");
    });

    await t.test("account balances include all historical legs and expose only scoped accounts", async () => {
      const response = await call("/operations/accounts", "finance-reader");
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.deepEqual(body.items.map((item: { id: string }) => item.id), [visibleAccountId]);
      assert.equal(body.items[0].balanceMinor, "2147483852");
      const serialized = JSON.stringify(body);
      assert.ok(!serialized.includes(privateAccountId));
      assert.ok(!serialized.includes(privateAmount.toString()));
    });

    await t.test("ledger cursor cannot reference a leg from a restricted account", async () => {
      const response = await call(`/operations/accounts/${visibleAccountId}/ledger?limit=64&cursor=leg-private`, "finance-reader");
      const body = await response.json();
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.code, "PAGE_CURSOR");
    });

    await t.test("a revoked session cannot replay an already committed command", { skip: routerVariant === "baseline" }, async () => {
      const request = {
        schemaVersion: 1,
        requestId: randomUUID(),
        targetId: "member-created-before-revocation",
        command: "MemberCreated",
        data: { name: "Synthetic replay member" },
        expectedVersion: 0,
        occurredAt: new Date().toISOString(),
      };
      const first = await call("/operations/commands", "replay-owner", request);
      const firstBody = await first.json();
      assert.equal(first.status, 200, JSON.stringify(firstBody));
      assert.equal((await db.commandReceipt.count({ where: { requestId: request.requestId } })), 1);
      assert.equal(await db.operationMember.count({ where: { id: request.targetId } }), 1);

      await db.user.update({ where: { id: "replay-owner" }, data: { authorizationEpoch: { increment: 1 } } });
      const staleReplay = await call("/operations/commands", "replay-owner", request);
      const replayBody = await staleReplay.json();
      assert.equal(staleReplay.status, 401, JSON.stringify(replayBody));

      const finalState = {
        receipts: await db.commandReceipt.count({ where: { requestId: request.requestId } }),
        outbox: await db.operationOutbox.count({ where: { requestId: request.requestId } }),
        audits: await db.operationAudit.count({ where: { requestId: request.requestId } }),
        members: await db.operationMember.count({ where: { id: request.targetId } }),
        version: (await db.operationObject.findUniqueOrThrow({ where: { id: request.targetId } })).version,
      };
      assert.deepEqual(finalState, { receipts: 1, outbox: 1, audits: 1, members: 1, version: 1 });
    });
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
