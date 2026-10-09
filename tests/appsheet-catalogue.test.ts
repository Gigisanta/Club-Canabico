import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

test("AppSheet catalogue writes preserve SKU identity and never book stock, sales or money", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");

  const schema = `appsheet_catalogue_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "true",
    JWT_SECRET: "appsheet-catalogue-test-only-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://appsheet-catalogue.test",
  });

  const { db } = await import("../server/db.js");
  let schemaCreated = false;
  let server: import("node:http").Server | undefined;
  try {
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const passwordText = "Synthetic-AppSheet-Test-Password";
    const password = await bcrypt.hash(passwordText, 4);
    for (const [id, role] of [["catalog-owner", "owner"], ["catalog-commercial", "admin"], ["catalog-stock", "admin"]] as const) {
      await db.user.create({ data: { id, name: id, email: `${id}@appsheet-catalogue.test`, password, role } });
    }
    const { profileCapabilities } = await import("../shared/operations/contracts.js");
    await db.operationAccess.create({ data: { userId: "catalog-commercial", profile: "commercial", capabilities: profileCapabilities.commercial } });
    await db.operationAccess.create({ data: { userId: "catalog-stock", profile: "stock", capabilities: profileCapabilities.stock } });

    const skuId = "appsheet-fixture-active-sku";
    const inactiveSkuId = "appsheet-fixture-inactive-sku";
    await db.catalogSku.create({
      data: {
        id: skuId, code: "AS-CAT-001", name: "Synthetic flower", variety: "Synthetic cultivar", category: "Fixture",
        unit: "g", minQuantity: "0.250", minVarieties: 3, active: true,
        appSheet: {
          catalogId: "legacy-catalog-id", price5Grams: { amountMinor: "9000", currency: "ARS" },
          price20To25Grams: { amountMinor: "345678", currency: "USD" }, futureField: { retained: true },
        },
      },
    });
    await db.catalogSku.create({
      data: {
        id: inactiveSkuId, code: "AS-CAT-002", name: "Inactive synthetic item", variety: "Fixture cultivar", category: "Fixture",
        unit: "ud", active: false, appSheet: { availability: "NO" },
      },
    });
    await db.operationObject.create({ data: { id: skuId, kind: "sku", version: 3, createdBy: "catalog-owner" } });
    await db.operationObject.create({ data: { id: inactiveSkuId, kind: "sku", version: 0, createdBy: "catalog-owner" } });
    await db.inventoryLot.create({
      data: {
        id: "appsheet-fixture-lot", skuId, label: "Synthetic stock lot", unit: "g", unitCost: "12.50", costCurrency: "ARS", receivedAt: new Date("2026-10-01T12:00:00.000Z"),
      },
    });
    await db.stockBalance.create({
      data: { id: "appsheet-fixture-balance", lotId: "appsheet-fixture-lot", locationId: "fixture-location", custodianId: "fixture-custodian", unit: "g", quantity: "17.250", reserved: "2.000" },
    });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const cookies: Record<string, string> = {};
    for (const id of ["catalog-owner", "catalog-commercial", "catalog-stock"]) {
      const login = await fetch(`${apiBase}/auth/login`, {
        method: "POST",
        headers: { Origin: "http://appsheet-catalogue.test", "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${id}@appsheet-catalogue.test`, password: passwordText }),
      });
      assert.equal(login.status, 200, await login.clone().text());
      cookies[id] = login.headers.get("set-cookie")!.split(";")[0]!;
    }
    const call = (path: string, actor = "catalog-owner", body?: unknown) => fetch(`${apiBase}${path}`, {
      method: body ? "POST" : "GET",
      headers: { Cookie: cookies[actor]!, Origin: "http://appsheet-catalogue.test", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const envelope = (requestId: string, targetId: string, command: string, data: Record<string, unknown>, expectedVersion: number): CommandEnvelope => ({
      schemaVersion: 1, requestId, targetId, command, data, expectedVersion, occurredAt: new Date().toISOString(),
    });

    const commercialListResponse = await call("/operations/catalogue-sheets", "catalog-commercial");
    assert.equal(commercialListResponse.status, 200);
    const commercialList = await commercialListResponse.json() as { items: Array<Record<string, unknown>>; versions: Record<string, number> };
    assert.deepEqual(commercialList.items.map(item => item.id).sort(), [inactiveSkuId, skuId].sort(), "la consulta incluye productos inactivos");
    assert.equal(commercialList.versions[skuId], 3);
    const exposedSku = commercialList.items.find(item => item.id === skuId)!;
    assert.equal("futureField" in (exposedSku.appSheet as Record<string, unknown>), false, "la API sólo proyecta campos AppSheet conocidos");
    const stockListResponse = await call("/operations/catalogue-sheets", "catalog-stock");
    assert.equal(stockListResponse.status, 200, "stock.adjust habilita consulta, pero no edición comercial");

    const balanceBefore = await db.stockBalance.findUniqueOrThrow({ where: { id: "appsheet-fixture-balance" } });
    const balanceValues = (balance: typeof balanceBefore) => ({
      id: balance.id, lotId: balance.lotId, locationId: balance.locationId, custodianId: balance.custodianId,
      unit: balance.unit, quantity: balance.quantity.toString(), reserved: balance.reserved.toString(),
    });
    const skuBefore = await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } });
    const effectsBefore = {
      stockFacts: await db.stockFact.count(),
      ledgerLegs: await db.ledgerLeg.count(),
      sales: await db.sale.count(),
      pricePolicies: await db.pricePolicy.count(),
      promotions: await db.commercialPromotion.count(),
      packs: await db.commercialPack.count(),
      balances: await db.stockBalance.count(),
    };
    const requestId = randomUUID();
    const capture = envelope(requestId, skuId, "CatalogueSheetSaved", {
      patch: {
        catalogId: "catalog-id-kept-separate", availability: "Sí", segment: "Premium", description: "Descripción ya validada",
        price5Grams: { amountMinor: "1234567", currency: "ARS" },
        price10Grams: { amountMinor: "11000", currency: "ARS" },
        price15Grams: { amountMinor: "12000", currency: "ARS" },
        price20Grams: { amountMinor: "13000", currency: "ARS" },
        price25Grams: { amountMinor: "14000", currency: "ARS" },
        price30Grams: { amountMinor: "15000", currency: "ARS" },
        price10To15Grams: { amountMinor: "4500000", currency: "USD" },
        promoA: { amountMinor: "250000", currency: "ARS" }, clientTariff: { amountMinor: "7500000", currency: "ARS" },
      },
    }, 3);
    const savedResponse = await call("/operations/commands", "catalog-commercial", capture);
    assert.equal(savedResponse.status, 200, await savedResponse.clone().text());
    const saved = await savedResponse.json() as { version: number; result: { appSheet: Record<string, unknown> } };
    assert.equal(saved.version, 4);
    assert.deepEqual(saved.result.appSheet.price5Grams, { amountMinor: "1234567", currency: "ARS" });
    assert.deepEqual(saved.result.appSheet.price10Grams, { amountMinor: "11000", currency: "ARS" });
    assert.deepEqual(saved.result.appSheet.price15Grams, { amountMinor: "12000", currency: "ARS" });
    assert.deepEqual(saved.result.appSheet.price20Grams, { amountMinor: "13000", currency: "ARS" });
    assert.deepEqual(saved.result.appSheet.price25Grams, { amountMinor: "14000", currency: "ARS" });
    assert.deepEqual(saved.result.appSheet.price30Grams, { amountMinor: "15000", currency: "ARS" });

    // A second editor opened at v3 must not overwrite the first editor's v4 save.
    const staleRequestId = randomUUID();
    const staleWrite = await call("/operations/commands", "catalog-commercial", envelope(staleRequestId, skuId, "CatalogueSheetSaved", {
      patch: { price5Grams: { amountMinor: "9999999", currency: "ARS" } },
    }, 3));
    assert.equal(staleWrite.status, 409, "un borrador abierto en v3 no puede promoverse a v4 tras una actualización concurrente");
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: skuId } })).version, 4);
    const skuAfterStaleAttempt = await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } });
    assert.deepEqual((skuAfterStaleAttempt.appSheet as Record<string, unknown>).price5Grams, { amountMinor: "1234567", currency: "ARS" }, "el intento obsoleto conserva el valor confirmado por la otra sesión");
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: staleRequestId } }), null, "el rechazo por versión obsoleta no deja comprobante");

    const stored = await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } });
    assert.equal(stored.unit, skuBefore.unit);
    assert.equal(stored.code, skuBefore.code);
    assert.equal(stored.name, skuBefore.name);
    assert.equal(stored.variety, skuBefore.variety);
    assert.equal(stored.category, skuBefore.category);
    assert.equal(stored.active, skuBefore.active);
    assert.equal(stored.minQuantity.toString(), skuBefore.minQuantity.toString());
    assert.equal(stored.minVarieties, skuBefore.minVarieties);
    assert.deepEqual((stored.appSheet as Record<string, unknown>).price10Grams, { amountMinor: "11000", currency: "ARS" });
    assert.deepEqual((stored.appSheet as Record<string, unknown>).price15Grams, { amountMinor: "12000", currency: "ARS" });
    assert.deepEqual((stored.appSheet as Record<string, unknown>).price20Grams, { amountMinor: "13000", currency: "ARS" });
    assert.deepEqual((stored.appSheet as Record<string, unknown>).price25Grams, { amountMinor: "14000", currency: "ARS" });
    assert.deepEqual((stored.appSheet as Record<string, unknown>).price30Grams, { amountMinor: "15000", currency: "ARS" });
    assert.deepEqual((stored.appSheet as Record<string, unknown>).price10To15Grams, { amountMinor: "4500000", currency: "USD" }, "el intervalo legado conserva su propio dato y moneda");
    assert.deepEqual((stored.appSheet as Record<string, unknown>).price20To25Grams, { amountMinor: "345678", currency: "USD" }, "editar campos parciales conserva los valores conocidos omitidos");
    assert.deepEqual((stored.appSheet as Record<string, unknown>).futureField, { retained: true }, "los metadatos futuros desconocidos se conservan en persistencia");
    assert.deepEqual(balanceValues(await db.stockBalance.findUniqueOrThrow({ where: { id: "appsheet-fixture-balance" } })), balanceValues(balanceBefore));
    assert.deepEqual({
      stockFacts: await db.stockFact.count(), ledgerLegs: await db.ledgerLeg.count(), sales: await db.sale.count(),
      pricePolicies: await db.pricePolicy.count(), promotions: await db.commercialPromotion.count(),
      packs: await db.commercialPack.count(), balances: await db.stockBalance.count(),
    }, effectsBefore, "capturar ficha no registra movimientos, ventas ni reglas comerciales activas");

    const replayResponse = await call("/operations/commands", "catalog-commercial", capture);
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json() as { replay?: boolean }).replay, true);
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: skuId } })).version, 4, "el replay idempotente no vuelve a escribir ni incrementa versión");

    const clearResponse = await call("/operations/commands", "catalog-commercial", envelope(randomUUID(), skuId, "CatalogueSheetSaved", {
      patch: { promoA: null },
    }, 4));
    assert.equal(clearResponse.status, 200, await clearResponse.clone().text());
    const clearedSku = await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } });
    assert.equal((clearedSku.appSheet as Record<string, unknown>).promoA, null, "null explícito borra el campo sin sustituirlo por cero");
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: skuId } })).version, 5);

    const stockWrite = await call("/operations/commands", "catalog-stock", envelope(randomUUID(), skuId, "CatalogueSheetSaved", {
      patch: { availability: "NO" },
    }, 5));
    assert.equal(stockWrite.status, 403, "stock.adjust no obtiene facultad de edición comercial");
    assert.equal((await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } })).appSheet && ((await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } })).appSheet as Record<string, unknown>).availability, "Sí");

    const invalidRequestId = randomUUID();
    const invalidPatch = await call("/operations/commands", "catalog-commercial", envelope(invalidRequestId, skuId, "CatalogueSheetSaved", {
      patch: { price15Grams: { amountMinor: "-1", currency: "ARS" } },
    }, 5));
    assert.ok(invalidPatch.status >= 400 && invalidPatch.status < 500, "un importe exacto inválido se rechaza antes de escribir");
    assert.equal((await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } })).unit, "g");
    assert.equal((await db.operationObject.findUniqueOrThrow({ where: { id: skuId } })).version, 5);
    assert.deepEqual(((await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } })).appSheet as Record<string, unknown>).price15Grams, { amountMinor: "12000", currency: "ARS" });
    assert.equal(await db.commandReceipt.findUnique({ where: { requestId: invalidRequestId } }), null, "el rechazo de esquema no deja comprobante");

    const missingId = "appsheet-fixture-missing-sku";
    const missingRequestId = randomUUID();
    const missing = await call("/operations/commands", "catalog-commercial", envelope(missingRequestId, missingId, "CatalogueSheetSaved", {
      patch: { price30Grams: { amountMinor: "1", currency: "ARS" } },
    }, 0));
    assert.equal(missing.status, 404, "no se puede crear un SKU editando su ficha AppSheet");
    assert.equal(await db.catalogSku.findUnique({ where: { id: missingId } }), null, "el rollback tampoco crea el SKU que faltaba");
    assert.equal((await db.operationObject.findUnique({ where: { id: missingId } })), null, "la operación crea su versión sólo dentro de la transacción; el rechazo revierte ese intento");
    assert.equal((await db.commandReceipt.findUnique({ where: { requestId: missingRequestId } })), null, "el rechazo no deja comprobante persistido");

    const oldSkuEdit = envelope(randomUUID(), skuId, "CatalogSkuUpdated", {
      code: skuBefore.code, name: "Synthetic flower updated", variety: skuBefore.variety, category: skuBefore.category,
      unit: skuBefore.unit, minQuantity: "0.250", minVarieties: 3, active: true,
      evidence: { reference: "appsheet-metadata-preservation-test" },
    }, 5);
    const oldUpdateResponse = await call("/operations/commands", "catalog-stock", oldSkuEdit);
    assert.equal(oldUpdateResponse.status, 200, await oldUpdateResponse.clone().text());
    const afterOldUpdate = await db.catalogSku.findUniqueOrThrow({ where: { id: skuId } });
    assert.equal(afterOldUpdate.name, "Synthetic flower updated");
    assert.deepEqual(afterOldUpdate.appSheet, clearedSku.appSheet, "el comando antiguo de SKU conserva íntegra la metadata AppSheet");
    assert.equal((await db.stockBalance.findUniqueOrThrow({ where: { id: "appsheet-fixture-balance" } })).quantity.toString(), "17.25");
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
