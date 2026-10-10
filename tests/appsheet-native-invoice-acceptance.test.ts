import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { splitSqlStatements } from "./migration-sql.js";

function databaseTargetIdentity(url: URL) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const normalizedHost = hostname === "localhost" || hostname === "::1" || hostname.startsWith("127.")
    ? "loopback"
    : hostname;
  return JSON.stringify([normalizedHost, url.port || "5432", decodeURIComponent(url.pathname.slice(1))]);
}

test("legacy AppSheet preorder keeps its manual invoice number and confirms once without financial effects", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["postgres:", "postgresql:"].includes(databaseUrl.protocol), "TEST_DATABASE_URL debe ser PostgreSQL");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");
  if (process.env.DATABASE_URL) {
    let applicationUrl: URL;
    try {
      applicationUrl = new URL(process.env.DATABASE_URL);
    } catch {
      assert.fail("DATABASE_URL debe ser una URL PostgreSQL válida cuando está definida");
    }
    assert.ok(["postgres:", "postgresql:"].includes(applicationUrl.protocol), "DATABASE_URL debe ser PostgreSQL");
    assert.notEqual(databaseTargetIdentity(databaseUrl), databaseTargetIdentity(applicationUrl),
      "TEST_DATABASE_URL no puede apuntar a la misma base PostgreSQL que DATABASE_URL");
  }

  const schema = `appsheet_native_accept_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.delete("schema");
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: scopedUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "false",
    JWT_SECRET: `native-invoice-${randomUUID()}-secret-more-than-32-characters`,
    ALLOWED_ORIGIN: "http://appsheet-native-acceptance.test",
  });

  const bootstrapDb = new PrismaClient({ datasourceUrl: databaseUrl.toString() });
  let migrationDb: PrismaClient | undefined;
  let appDb: { $disconnect(): Promise<void> } | undefined;
  let schemaCreated = false;
  let server: import("node:http").Server | undefined;
  try {
    await bootstrapDb.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    migrationDb = new PrismaClient({ datasourceUrl: scopedUrl.toString() });
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await migrationDb.$executeRawUnsafe(statement);
    }
    await migrationDb.$disconnect();
    migrationDb = undefined;

    const { db } = await import("../server/db.js");
    appDb = db;
    const { app } = await import("../server/app.js");

    const ownerId = `native-invoice-owner-${randomUUID()}`;
    const memberId = `native-invoice-member-${randomUUID()}`;
    const skuId = `native-invoice-sku-${randomUUID()}`;
    const locationId = `native-invoice-location-${randomUUID()}`;
    const lotId = `native-invoice-lot-${randomUUID()}`;
    const balanceId = `native-invoice-balance-${randomUUID()}`;
    const passwordText = randomUUID();
    await db.user.create({
      data: {
        id: ownerId,
        name: "Synthetic legacy invoice owner",
        email: `${ownerId}@appsheet-native-acceptance.test`,
        password: await bcrypt.hash(passwordText, 4),
        role: "owner",
      },
    });
    await db.operationMember.create({
      data: { id: memberId, name: "Synthetic legacy member", address: {}, preferences: {} },
    });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date());
    const validUntil = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    await db.memberPermission.create({
      data: { memberId, kind: "operations", status: "verified", validFrom: today, validUntil },
    });
    await db.catalogSku.create({
      data: {
        id: skuId,
        code: skuId,
        name: "Synthetic native product",
        variety: "Fixture",
        category: "Fixture",
        unit: "g",
        appSheet: { availability: "Sí" },
      },
    });
    await db.location.create({ data: { id: locationId, key: locationId, name: "Synthetic native location" } });
    await db.inventoryLot.create({
      data: {
        id: lotId,
        skuId,
        label: "Synthetic native lot",
        unit: "g",
        unitCost: "1",
        costCurrency: "ARS",
        receivedAt: new Date(),
      },
    });
    await db.stockBalance.create({
      data: { id: balanceId, lotId, locationId, custodianId: ownerId, unit: "g", quantity: "20", reserved: "0" },
    });

    // This test starts in the legacy default state: no authority transition, capture, or import fixture.
    assert.equal(await db.operationAuthority.findUnique({ where: { id: "operations" } }), null);
    assert.equal(await db.appSheetCaptureManifest.count(), 0);
    assert.equal(await db.legacyImportSnapshot.count(), 0);

    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server!.once("listening", resolve);
      server!.once("error", reject);
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const origin = "http://appsheet-native-acceptance.test";
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${ownerId}@appsheet-native-acceptance.test`, password: passwordText }),
    });
    assert.equal(login.status, 200, await login.text());
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "el login HTTP debe emitir una cookie de sesión");

    const send = async (request: Record<string, unknown>) => {
      const response = await fetch(`${base}/operations/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      return { response, body: await response.json() as Record<string, any> };
    };
    const envelope = (targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0) => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command,
      data,
      expectedVersion,
      occurredAt: new Date().toISOString(),
    });
    const financialEffects = async () => ({
      ledgerEvents: await db.ledgerEvent.count(),
      ledgerLegs: await db.ledgerLeg.count(),
      cashEntries: await db.cashEntry.count(),
      collections: await db.collectionReport.count(),
      memberCredits: await db.memberCredit.count(),
      payablePayments: await db.payablePayment.count(),
    });
    const commandEffects = async (requestIds: string[]) => ({
      receipts: await db.commandReceipt.count({ where: { requestId: { in: requestIds } } }),
      audits: await db.operationAudit.count({ where: { requestId: { in: requestIds } } }),
      outbox: await db.operationOutbox.findMany({ where: { requestId: { in: requestIds } }, orderBy: { topic: "asc" } }),
    });
    const readOrder = async (orderId: string) => {
      const [order, object, lines, balance] = await Promise.all([
        db.operationOrder.findUniqueOrThrow({ where: { id: orderId } }),
        db.operationObject.findUniqueOrThrow({ where: { id: orderId } }),
        db.operationOrderLine.findMany({ where: { orderId }, orderBy: { id: "asc" } }),
        db.stockBalance.findUniqueOrThrow({ where: { id: balanceId } }),
      ]);
      return {
        state: order.commercialState,
        quoteVersion: order.quoteVersion,
        financialState: order.financialState,
        confirmedAt: order.confirmedAt?.toISOString() ?? null,
        quote: order.quote as Record<string, any>,
        objectVersion: object.version,
        lines: lines.map(line => ({ id: line.id, skuId: line.skuId, requested: line.requested.toString() })),
        stockQuantity: balance.quantity.toString(),
        stockReserved: balance.reserved.toString(),
        reservations: await db.stockReservation.count({ where: { orderId, status: "active" } }),
        deliveries: await db.deliveryAssignment.count({ where: { orderId } }),
      };
    };

    const initialFinancialEffects = await financialEffects();
    assert.deepEqual(initialFinancialEffects, {
      ledgerEvents: 0,
      ledgerLegs: 0,
      cashEntries: 0,
      collections: 0,
      memberCredits: 0,
      payablePayments: 0,
    });
    const orderId = `native-legacy-invoice-${randomUUID()}`;
    const invoiceNumber = `APP-${today.slice(0, 4)}-${randomUUID().slice(0, 8).toUpperCase()}`;
    const lineId = `native-legacy-line-${randomUUID()}`;
    const savedRequest = envelope(orderId, "InvoiceSaved", {
      memberId,
      invoiceNumber,
      invoiceDate: today,
      currency: "ARS",
      address: { city: "Salta" },
      note: "Cotización nativa pendiente de aceptación",
      productPaymentMethod: "cash",
      lines: [{ id: lineId, skuId, date: today, scale: "fixture", quantity: "2", totalMinor: "2400" }],
      preorder: true,
    });
    const saved = await send(savedRequest);
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.result.commercialState, "preorder");
    assert.equal(saved.body.result.invoiceNumber, invoiceNumber, "legacy conserva el número ingresado");
    assert.match(saved.body.result.snapshotHash, /^[a-f0-9]{64}$/);

    const preorder = await readOrder(orderId);
    assert.equal(preorder.state, "preorder");
    assert.equal(preorder.objectVersion, 1);
    assert.equal(preorder.quoteVersion, 1);
    assert.equal(preorder.quote.invoiceNumber, invoiceNumber);
    assert.equal(Object.hasOwn(preorder.quote, "appSheetFormula"), false,
      "la fórmula AppSheet no es requisito para preservar una cotización legacy");
    assert.deepEqual(preorder.lines, [{ id: lineId, skuId, requested: "2" }]);
    assert.equal(preorder.stockQuantity, "20");
    assert.equal(preorder.stockReserved, "0", "guardar la preventa no reserva stock");
    assert.equal(preorder.reservations, 0);
    assert.equal(preorder.deliveries, 0);
    assert.equal(await db.appSheetInvoiceSequence.count(), 0, "legacy no siembra ni consume secuencia AppSheet");
    assert.equal(await db.appSheetInvoiceNumberReservation.count(), 0, "legacy no crea una reserva de numeración AppSheet");
    assert.equal(await db.appSheetCaptureManifest.count(), 0);
    assert.equal(await db.legacyImportSnapshot.count(), 0);
    assert.deepEqual(await financialEffects(), initialFinancialEffects,
      "guardar una preventa no registra caja, cobros, créditos ni pagos");
    const afterSaveEffects = await commandEffects([String(savedRequest.requestId)]);
    assert.equal(afterSaveEffects.receipts, 1);
    assert.equal(afterSaveEffects.audits, 1);
    assert.deepEqual(afterSaveEffects.outbox.map(item => item.topic), ["operation.InvoiceSaved"]);

    const acceptance = { note: "El operador registró la aceptación de la cotización revisada" };
    const confirmRequest = envelope(orderId, "InvoiceConfirmed", { acceptance }, 1);
    const confirmed = await send(confirmRequest);
    assert.equal(confirmed.response.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.result.commercialState, "confirmed");
    assert.equal(confirmed.body.version, 2);
    assert.equal(confirmed.body.result.reservations.length, 1);

    const accepted = await readOrder(orderId);
    assert.equal(accepted.state, "confirmed");
    assert.equal(accepted.objectVersion, 2);
    assert.equal(accepted.quoteVersion, 1);
    assert.equal(accepted.financialState, "unpaid");
    assert.ok(accepted.confirmedAt);
    assert.equal(accepted.quote.invoiceNumber, invoiceNumber);
    assert.equal(Object.hasOwn(accepted.quote, "appSheetFormula"), false);
    assert.equal(accepted.quote.acceptance.acceptedBy, ownerId);
    assert.equal(accepted.quote.confirmedBy, ownerId);
    assert.equal(accepted.quote.acceptance.quoteVersion, 1);
    assert.match(accepted.quote.acceptance.snapshotHash, /^[a-f0-9]{64}$/);
    assert.equal(accepted.quote.acceptance.snapshotHash, saved.body.result.snapshotHash);
    assert.ok(Number.isFinite(Date.parse(accepted.quote.acceptance.acceptedAt)));
    assert.equal(accepted.stockQuantity, "20");
    assert.equal(accepted.stockReserved, "2");
    assert.equal(accepted.reservations, 1, "la aceptación crea una única reserva de stock");
    assert.equal(accepted.deliveries, 0);
    assert.equal(await db.appSheetInvoiceSequence.count(), 0);
    assert.equal(await db.appSheetInvoiceNumberReservation.count(), 0);
    assert.equal(await db.appSheetCaptureManifest.count(), 0);
    assert.equal(await db.legacyImportSnapshot.count(), 0);
    assert.deepEqual(await financialEffects(), initialFinancialEffects,
      "confirmar la cotización no registra pagos, cobros, asientos ni caja");
    const acceptedEffects = await commandEffects([String(savedRequest.requestId), String(confirmRequest.requestId)]);
    assert.equal(acceptedEffects.receipts, 2);
    assert.equal(acceptedEffects.audits, 2);
    assert.deepEqual(acceptedEffects.outbox.map(item => item.topic), ["operation.InvoiceConfirmed", "operation.InvoiceSaved"],
      "sólo se emiten los eventos de comando; no hay efectos de comunicación");

    const replay = await send(confirmRequest);
    assert.equal(replay.response.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replay, true);
    assert.deepEqual(await readOrder(orderId), accepted, "repetir la misma aceptación conserva estado y reserva");
    assert.deepEqual(await commandEffects([String(savedRequest.requestId), String(confirmRequest.requestId)]), acceptedEffects,
      "el replay no duplica recibos, auditoría ni eventos");
    assert.deepEqual(await financialEffects(), initialFinancialEffects);
    assert.equal(await db.appSheetInvoiceSequence.count(), 0);
    assert.equal(await db.appSheetInvoiceNumberReservation.count(), 0);
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (appDb) await appDb.$disconnect();
    if (migrationDb) await migrationDb.$disconnect();
    if (schemaCreated) await bootstrapDb.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await bootstrapDb.$disconnect();
    for (const key of envKeys) {
      const previous = previousEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
});
