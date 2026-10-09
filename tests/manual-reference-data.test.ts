import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

type CommandResponse = {
  requestId: string;
  targetId: string;
  version: number;
  replay?: boolean;
  result: Record<string, unknown>;
};

test("manual reference catalogs use versioned commands and persist their observable effects", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async t => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL must use loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "TEST_DATABASE_URL must name a dedicated bombo_ui_* database");

  const schema = "manual_reference_" + randomUUID().replaceAll("-", "");
  databaseUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "true",
    JWT_SECRET: "manual-reference-test-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://manual-reference.test",
  });

  let db: (typeof import("../server/db.js"))["db"] | undefined;
  let server: import("node:http").Server | undefined;
  let schemaCreated = false;
  try {
    ({ db } = await import("../server/db.js"));
    await db.$executeRawUnsafe('CREATE SCHEMA "' + schema + '"');
    schemaCreated = true;

    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(migration.name + "/migration.sql", migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const suffix = randomUUID();
    const ownerId = "manual-owner-" + suffix;
    const scopedId = "manual-scoped-" + suffix;
    const viewerId = "manual-viewer-" + suffix;
    const preparerId = "manual-preparer-" + suffix;
    const inactivePreparerId = "manual-inactive-preparer-" + suffix;
    const scopedLocationId = "manual-scope-location-" + suffix;
    const passwordText = "Only-a-local-manual-reference-123";
    const password = await bcrypt.hash(passwordText, 4);
    for (const [id, role, active] of [
      [ownerId, "owner", true],
      [scopedId, "admin", true],
      [viewerId, "viewer", true],
      [preparerId, "admin", true],
      [inactivePreparerId, "admin", false],
    ] as const) {
      await db.user.create({
        data: { id, name: id, email: id + "@manual-reference.test", password, role, active },
      });
    }
    await db.location.create({
      data: { id: scopedLocationId, name: "Synthetic scoped location", key: "synthetic-scoped-" + suffix },
    });
    await db.operationAccess.create({
      data: {
        userId: scopedId,
        profile: "stock",
        capabilities: ["purchases.write", "stock.adjust", "openings.approve"],
        scope: { locationIds: [scopedLocationId] },
      },
    });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = "http://127.0.0.1:" + address.port + "/api";
    const origin = "http://manual-reference.test";
    const cookies: Record<string, string> = {};

    async function login(id: string) {
      const response = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: id + "@manual-reference.test", password: passwordText }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      cookies[id] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    async function call(path: string, actor = ownerId, body?: unknown, method?: string) {
      return fetch(base + path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: {
          Cookie: cookies[actor] ?? "",
          Origin: origin,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    function envelope(targetId: string, command: string, data: Record<string, unknown>, expectedVersion = 0): CommandEnvelope {
      return {
        schemaVersion: 1,
        requestId: randomUUID(),
        targetId,
        command,
        data,
        expectedVersion,
        occurredAt: new Date().toISOString(),
      };
    }
    async function accepted(request: CommandEnvelope, actor = ownerId): Promise<CommandResponse> {
      const response = await call("/operations/commands", actor, request);
      const body = await response.json() as CommandResponse;
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    }
    async function rejected(request: CommandEnvelope, status: number, code: string, actor = ownerId) {
      const response = await call("/operations/commands", actor, request);
      const body = await response.json() as { code?: string };
      assert.equal(response.status, status, JSON.stringify(body));
      assert.equal(body.code, code);
    }
    async function assertNoCommandEffects(request: CommandEnvelope) {
      assert.equal(await db!.commandReceipt.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db!.operationAudit.count({ where: { requestId: request.requestId } }), 0);
      assert.equal(await db!.operationOutbox.count({ where: { requestId: request.requestId } }), 0);
    }
    const proof = (note: string) => ({ note: "synthetic manual-reference fixture: " + note });
    const supplierInput = (name: string, isDefault: boolean, note: string) => ({
      name,
      contactName: "Synthetic contact",
      phone: "",
      email: "",
      notes: "Disposable API fixture",
      isDefault,
      evidence: proof(note),
    });
    const locationInput = (name: string, isDefault: boolean, active: boolean, note: string) => ({
      name,
      isDefault,
      active,
      evidence: proof(note),
    });
    for (const id of [ownerId, scopedId, viewerId]) await login(id);

    await t.test("create, update, default, replay and inactive reference rows persist through the canonical API", async () => {
      const supplierAId = "manual-supplier-a-" + suffix;
      const supplierBId = "manual-supplier-b-" + suffix;
      const supplierA = await accepted(envelope(supplierAId, "SupplierCreated", supplierInput("Synthetic Supplier A " + suffix, true, "supplier A create")));
      assert.equal(supplierA.version, 1);
      const supplierBRequest = envelope(supplierBId, "SupplierCreated", supplierInput("Synthetic Supplier B " + suffix, true, "supplier B create"));
      const supplierB = await accepted(supplierBRequest);
      assert.equal(supplierB.version, 1);
      assert.equal((await db!.supplier.findUniqueOrThrow({ where: { id: supplierAId } })).isDefault, false);
      assert.equal((await db!.supplier.findUniqueOrThrow({ where: { id: supplierBId } })).isDefault, true);

      const auditCountBeforeReplay = await db!.operationAudit.count({ where: { requestId: supplierBRequest.requestId } });
      const outboxCountBeforeReplay = await db!.operationOutbox.count({ where: { requestId: supplierBRequest.requestId } });
      const replay = await accepted(supplierBRequest);
      assert.equal(replay.replay, true);
      assert.equal(await db!.supplier.count({ where: { id: supplierBId } }), 1);
      assert.equal(await db!.commandReceipt.count({ where: { requestId: supplierBRequest.requestId } }), 1);
      assert.equal(await db!.operationAudit.count({ where: { requestId: supplierBRequest.requestId } }), auditCountBeforeReplay);
      assert.equal(await db!.operationOutbox.count({ where: { requestId: supplierBRequest.requestId } }), outboxCountBeforeReplay);

      const deactivateSupplier = envelope(
        supplierBId,
        "SupplierUpdated",
        { ...supplierInput("Synthetic Supplier B " + suffix, true, "supplier B deactivate"), active: false },
        1,
      );
      const inactiveSupplier = await accepted(deactivateSupplier);
      assert.equal(inactiveSupplier.version, 2);
      const makeSupplierDefault = envelope(
        supplierAId,
        "SupplierUpdated",
        { ...supplierInput("Synthetic Supplier A " + suffix, true, "supplier A default"), active: true },
        1,
      );
      const defaultSupplier = await accepted(makeSupplierDefault);
      assert.equal(defaultSupplier.version, 2);
      const supplierAState = await db!.supplier.findUniqueOrThrow({ where: { id: supplierAId } });
      const supplierBState = await db!.supplier.findUniqueOrThrow({ where: { id: supplierBId } });
      assert.equal(supplierAState.active, true);
      assert.equal(supplierAState.isDefault, true);
      assert.equal(supplierBState.active, false);
      assert.equal(supplierBState.isDefault, false);
      const supplierEvidence = await db!.operationAudit.findMany({
        where: { requestId: makeSupplierDefault.requestId, action: "SupplierUpdated" },
      });
      assert.ok(supplierEvidence.some(row => (row.details as { evidence?: { note?: string } }).evidence?.note === proof("supplier A default").note));

      const locationAId = "manual-location-a-" + suffix;
      const locationBId = "manual-location-b-" + suffix;
      const firstLocation = await accepted(envelope(locationAId, "LocationCreated", {
        name: "Synthetic Location A " + suffix,
        isDefault: false,
        evidence: proof("location A create"),
      }));
      const secondLocation = await accepted(envelope(locationBId, "LocationCreated", {
        name: "Synthetic Location B " + suffix,
        isDefault: false,
        evidence: proof("location B create"),
      }));
      assert.equal(firstLocation.version, 1);
      assert.equal(secondLocation.version, 1);
      assert.equal((await db!.location.findUniqueOrThrow({ where: { id: locationAId } })).isDefault, false);
      assert.equal((await db!.location.findUniqueOrThrow({ where: { id: locationBId } })).isDefault, false);

      const makeLocationDefault = envelope(
        locationBId,
        "LocationUpdated",
        locationInput("Synthetic Location B " + suffix, true, true, "location B default"),
        1,
      );
      assert.equal((await accepted(makeLocationDefault)).version, 2);
      const deactivateLocation = envelope(
        locationAId,
        "LocationUpdated",
        locationInput("Synthetic Location A " + suffix, true, false, "location A deactivate"),
        1,
      );
      assert.equal((await accepted(deactivateLocation)).version, 2);

      const referencesResponse = await call("/operations/manual-reference-data");
      assert.equal(referencesResponse.status, 200);
      const references = await referencesResponse.json() as {
        suppliers: Array<{ id: string; active: boolean; isDefault: boolean }>;
        locations: Array<{ id: string; active: boolean; isDefault: boolean }>;
        versions: Record<string, number>;
        editable: { suppliers: boolean; locations: boolean };
      };
      const listedSupplierA = references.suppliers.find(item => item.id === supplierAId);
      const listedSupplierB = references.suppliers.find(item => item.id === supplierBId);
      const listedLocationA = references.locations.find(item => item.id === locationAId);
      const listedLocationB = references.locations.find(item => item.id === locationBId);
      assert.deepEqual(listedSupplierA && [listedSupplierA.active, listedSupplierA.isDefault], [true, true]);
      assert.deepEqual(listedSupplierB && [listedSupplierB.active, listedSupplierB.isDefault], [false, false]);
      assert.deepEqual(listedLocationA && [listedLocationA.active, listedLocationA.isDefault], [false, false]);
      assert.deepEqual(listedLocationB && [listedLocationB.active, listedLocationB.isDefault], [true, true]);
      assert.equal(references.versions[supplierAId], 2);
      assert.equal(references.versions[supplierBId], 2);
      assert.equal(references.versions[locationAId], 2);
      assert.equal(references.versions[locationBId], 2);
      assert.deepEqual(references.editable, { suppliers: true, locations: true });
    });

    await t.test("capabilities, full-scope administration and stale versions reject without command effects", async () => {
      const scopedResponse = await call("/operations/manual-reference-data", scopedId);
      assert.equal(scopedResponse.status, 200);
      const scopedReferences = await scopedResponse.json() as {
        suppliers: Array<{ id: string }>;
        locations: Array<{ id: string }>;
        editable: { suppliers: boolean; locations: boolean };
      };
      assert.equal(scopedReferences.suppliers.length > 0, true);
      assert.deepEqual(scopedReferences.locations.map(item => item.id), [scopedLocationId]);
      assert.deepEqual(scopedReferences.editable, { suppliers: false, locations: false });

      const scopedSupplier = envelope(
        "denied-supplier-" + suffix,
        "SupplierCreated",
        supplierInput("Denied Supplier " + suffix, false, "scoped supplier denial"),
      );
      await rejected(scopedSupplier, 403, "REFERENCE_FULL_SCOPE_REQUIRED", scopedId);
      await assertNoCommandEffects(scopedSupplier);
      assert.equal(await db!.supplier.count({ where: { id: scopedSupplier.targetId } }), 0);

      const scopedLocation = envelope(
        "denied-location-" + suffix,
        "LocationCreated",
        { name: "Denied Location " + suffix, isDefault: false, evidence: proof("scoped location denial") },
      );
      await rejected(scopedLocation, 403, "REFERENCE_FULL_SCOPE_REQUIRED", scopedId);
      await assertNoCommandEffects(scopedLocation);
      assert.equal(await db!.location.count({ where: { id: scopedLocation.targetId } }), 0);

      const wrongCapability = envelope(
        "viewer-location-" + suffix,
        "LocationCreated",
        { name: "Viewer Location " + suffix, isDefault: false, evidence: proof("missing capability") },
      );
      await rejected(wrongCapability, 403, "CAPABILITY_REQUIRED", viewerId);
      await assertNoCommandEffects(wrongCapability);
      const hiddenReferences = await call("/operations/manual-reference-data", viewerId);
      assert.equal(hiddenReferences.status, 403);
      assert.equal((await hiddenReferences.json() as { code?: string }).code, "CAPABILITY_REQUIRED");

      const activePreparer = await call("/operations/manual-reference-data/preparers");
      assert.equal(activePreparer.status, 200);
      const activePreparerIds = (await activePreparer.json() as { items: Array<{ id: string }> }).items.map(item => item.id);
      assert.ok(activePreparerIds.includes(preparerId));
      assert.ok(!activePreparerIds.includes(inactivePreparerId));
      const scopedPreparers = await call("/operations/manual-reference-data/preparers", scopedId);
      assert.equal(scopedPreparers.status, 403);
      assert.equal((await scopedPreparers.json() as { code?: string }).code, "REFERENCE_FULL_SCOPE_REQUIRED");
      const unauthorizedPreparers = await call("/operations/manual-reference-data/preparers", viewerId);
      assert.equal(unauthorizedPreparers.status, 403);
      assert.equal((await unauthorizedPreparers.json() as { code?: string }).code, "CAPABILITY_REQUIRED");

      const locationId = "manual-stale-location-" + suffix;
      await accepted(envelope(locationId, "LocationCreated", {
        name: "Before stale update " + suffix,
        isDefault: false,
        evidence: proof("stale fixture create"),
      }));
      const currentUpdate = envelope(
        locationId,
        "LocationUpdated",
        locationInput("Current location name " + suffix, true, true, "current version update"),
        1,
      );
      assert.equal((await accepted(currentUpdate)).version, 2);
      const staleUpdate = envelope(
        locationId,
        "LocationUpdated",
        locationInput("Stale location name " + suffix, false, true, "stale update"),
        1,
      );
      await rejected(staleUpdate, 409, "VERSION_CONFLICT");
      await assertNoCommandEffects(staleUpdate);
      assert.equal((await db!.location.findUniqueOrThrow({ where: { id: locationId } })).name, "Current location name " + suffix);
      assert.equal((await db!.operationObject.findUniqueOrThrow({ where: { id: locationId } })).version, 2);
    });

    await t.test("blank evidence is rejected over HTTP before creating reference data", async () => {
      const invalidCreate = envelope(
        "manual-blank-evidence-supplier-" + suffix,
        "SupplierCreated",
        {
          ...supplierInput("Supplier with blank evidence " + suffix, false, "valid placeholder"),
          evidence: { note: "   " },
        },
      );
      const response = await call("/operations/commands", ownerId, invalidCreate);
      assert.equal(response.status, 400, await response.clone().text());
      await assertNoCommandEffects(invalidCreate);
      assert.equal(await db!.supplier.count({ where: { id: invalidCreate.targetId } }), 0);
      assert.equal(await db!.operationObject.count({ where: { id: invalidCreate.targetId } }), 0);
    });

    await t.test("location rename rolls back with a rejected Product label write and preserves stock state", async () => {
      const locationId = "manual-rename-location-" + suffix;
      const oldName = "Location before rename " + suffix;
      await accepted(envelope(locationId, "LocationCreated", {
        name: oldName,
        isDefault: false,
        evidence: proof("rename fixture"),
      }));

      const productId = "manual-product-" + suffix;
      const skuId = "manual-sku-" + suffix;
      const lotId = "manual-lot-" + suffix;
      const balanceId = "manual-balance-" + suffix;
      const stockFactId = randomUUID();
      await db!.product.create({
        data: {
          id: productId,
          name: "Synthetic linked product",
          strain: "Synthetic",
          type: "Flower",
          unit: "g",
          lot: "manual-product-lot-" + suffix,
          stock: 7000,
          minimum: 0,
          cost: 100,
          price: 200,
          location: oldName,
          locationId,
          ownerId,
        },
      });
      await db!.catalogSku.create({
        data: { id: skuId, code: "MANUAL-" + suffix, name: "Synthetic SKU", variety: "Synthetic", category: "Test", unit: "g" },
      });
      await db!.inventoryLot.create({
        data: { id: lotId, skuId, label: "Synthetic lot", unit: "g", unitCost: "12.5", costCurrency: "ARS", receivedAt: new Date("2026-10-01T12:00:00Z") },
      });
      await db!.stockBalance.create({
        data: { id: balanceId, lotId, locationId, custodianId: preparerId, unit: "g", quantity: "7.5", reserved: "1.25" },
      });
      await db!.stockFact.create({
        data: {
          id: stockFactId,
          requestId: randomUUID(),
          lotId,
          kind: "opening",
          quantity: "7.5",
          unit: "g",
          toLocationId: locationId,
          toCustodianId: preparerId,
          costMinor: 9375n,
          currency: "ARS",
          reason: "Synthetic preexisting opening",
          actorId: ownerId,
          occurredAt: new Date("2026-10-01T12:00:00Z"),
        },
      });

      const balanceBefore = await db!.stockBalance.findUniqueOrThrow({ where: { id: balanceId } });
      const factBefore = await db!.stockFact.findUniqueOrThrow({ where: { id: stockFactId } });
      const ledgerEventsBefore = await db!.ledgerEvent.count();
      const functionName = "reject_manual_location_label_" + randomUUID().replaceAll("-", "");
      const triggerName = "reject_manual_location_label_" + randomUUID().replaceAll("-", "");
      const functionSql =
        'CREATE FUNCTION "' + schema + '"."' + functionName + '"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."location" = $label$Forced Product Label Failure ' +
        suffix +
        "$label$ THEN RAISE EXCEPTION USING MESSAGE = 'synthetic Product label write rejection'; END IF; RETURN NEW; END; $$";
      await db!.$executeRawUnsafe(functionSql);
      await db!.$executeRawUnsafe(
        'CREATE TRIGGER "' + triggerName + '" BEFORE UPDATE OF "location" ON "' + schema +
        '"."Product" FOR EACH ROW EXECUTE FUNCTION "' + schema + '"."' + functionName + '"()',
      );

      const failedRename = envelope(
        locationId,
        "LocationUpdated",
        locationInput("Forced Product Label Failure " + suffix, true, true, "rollback on linked label failure"),
        1,
      );
      const failedResponse = await call("/operations/commands", ownerId, failedRename);
      assert.equal(failedResponse.status, 500, await failedResponse.clone().text());
      await assertNoCommandEffects(failedRename);
      assert.equal((await db!.location.findUniqueOrThrow({ where: { id: locationId } })).name, oldName);
      assert.equal((await db!.product.findUniqueOrThrow({ where: { id: productId } })).location, oldName);
      assert.equal((await db!.operationObject.findUniqueOrThrow({ where: { id: locationId } })).version, 1);
      assert.deepEqual(await db!.stockBalance.findUniqueOrThrow({ where: { id: balanceId } }), balanceBefore);
      assert.deepEqual(await db!.stockFact.findUniqueOrThrow({ where: { id: stockFactId } }), factBefore);
      assert.equal(await db!.ledgerEvent.count(), ledgerEventsBefore);

      await db!.$executeRawUnsafe('DROP TRIGGER "' + triggerName + '" ON "' + schema + '"."Product"');
      await db!.$executeRawUnsafe('DROP FUNCTION "' + schema + '"."' + functionName + '"()');
      const newName = "Location after rename " + suffix;
      const successfulRename = envelope(
        locationId,
        "LocationUpdated",
        locationInput(newName, true, true, "successful linked label rename"),
        1,
      );
      assert.equal((await accepted(successfulRename)).version, 2);
      const renamedLocation = await db!.location.findUniqueOrThrow({ where: { id: locationId } });
      const renamedProduct = await db!.product.findUniqueOrThrow({ where: { id: productId } });
      assert.equal(renamedLocation.name, newName);
      assert.equal(renamedProduct.location, newName);
      assert.equal(renamedProduct.locationId, locationId);
      assert.deepEqual(await db!.stockBalance.findUniqueOrThrow({ where: { id: balanceId } }), balanceBefore);
      assert.deepEqual(await db!.stockFact.findUniqueOrThrow({ where: { id: stockFactId } }), factBefore);
      assert.equal(await db!.ledgerEvent.count(), ledgerEventsBefore);
    });
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    try {
      if (schemaCreated && db) await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
    } finally {
      if (db) await db.$disconnect();
      for (const key of envKeys) {
        const value = previousEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
});
