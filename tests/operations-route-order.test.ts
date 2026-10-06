import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { splitSqlStatements } from "./migration-sql.js";

// Real HTTP and PostgreSQL coverage for the command owner. Rows below are only
// pre-existing synthetic route state; command effects are read back from PG.
test("RouteReordered only changes an open planned route with every non-cancelled stop exactly once", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000,
}, async t => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /^\/bombo_ui_[a-z0-9_-]+$/i, "usar una base sintética bombo_ui_ dedicada");

  const schema = `route_order_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  const envKeys = ["DATABASE_URL", "NODE_ENV", "DEMO_MODE", "JWT_SECRET", "ALLOWED_ORIGIN"] as const;
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl.toString(),
    NODE_ENV: "test",
    DEMO_MODE: "true",
    JWT_SECRET: "route-order-test-only-secret-more-than-32-characters",
    ALLOWED_ORIGIN: "http://route-order.test",
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

    const ownerId = "route-order-owner";
    const routeId = "route-order-fixture";
    const completedId = "route-order-completed";
    const dispatchedId = "route-order-dispatched";
    const cancelledId = "route-order-cancelled";
    const pendingId = "route-order-pending";
    const fixturePassword = randomUUID();
    const password = await bcrypt.hash(fixturePassword, 4);
    await db.user.create({
      data: { id: ownerId, name: "Synthetic route owner", email: "owner@route-order.test", password, role: "owner" },
    });
    await db.deliveryRoute.create({
      data: { id: routeId, driverId: "synthetic-driver", shiftDate: "2026-10-05", status: "planned" },
    });
    await db.operationObject.create({ data: { id: routeId, kind: "route", version: 4, createdBy: ownerId } });

    for (const [id, status, stopSequence, version] of [
      [completedId, "delivered", 0, 3],
      [dispatchedId, "dispatched", 1, 5],
      [cancelledId, "cancelled", 2, 7],
    ] as const) {
      await db.deliveryAssignment.create({
        data: {
          id,
          orderId: `synthetic-order-${id}`,
          routeId,
          driverId: "synthetic-driver",
          status,
          stopSequence,
          address: { street: "Dirección sintética" },
          incidents: [],
        },
      });
      await db.operationObject.create({ data: { id, kind: "delivery", version, createdBy: ownerId } });
    }
    await db.deliveryAssignment.create({
      data: { id: pendingId, orderId: `synthetic-order-${pendingId}`, address: { street: "Dirección sintética" }, incidents: [] },
    });
    await db.operationObject.create({ data: { id: pendingId, kind: "delivery", version: 2, createdBy: ownerId } });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const login = await fetch(`${apiBase}/auth/login`, {
      method: "POST",
      headers: { Origin: "http://route-order.test", "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@route-order.test", password: fixturePassword }),
    });
    assert.equal(login.status, 200, await login.clone().text());
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "login debe emitir la sesión del actor sintético");

    type ReorderEnvelope = {
      schemaVersion: 1;
      requestId: string;
      targetId: string;
      expectedVersion: number;
      occurredAt: string;
      command: "RouteReordered";
      data: { deliveryIds: string[]; evidence: { reference: string; scope: string } };
    };
    const envelope = async (deliveryIds: string[]): Promise<ReorderEnvelope> => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId: routeId,
      expectedVersion: (await db.operationObject.findUniqueOrThrow({ where: { id: routeId } })).version,
      occurredAt: new Date().toISOString(),
      command: "RouteReordered",
      data: { deliveryIds, evidence: { reference: "synthetic-route-order-test", scope: "fixture-only" } },
    });
    const reorder = async (deliveryIds: string[]) => {
      const request = await envelope(deliveryIds);
      const response = await fetch(`${apiBase}/operations/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "http://route-order.test", "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      return { request, status: response.status, body: await response.json() as Record<string, unknown> };
    };
    type AssignmentEnvelope = {
      schemaVersion: 1;
      requestId: string;
      targetId: string;
      expectedVersion: number;
      occurredAt: string;
      command: "DeliveryAssigned";
      data: { routeId: string; driverId: string; stopSequence: number; evidence: { reference: string; scope: string } };
    };
    const assign = async () => {
      const request: AssignmentEnvelope = {
        schemaVersion: 1,
        requestId: randomUUID(),
        targetId: pendingId,
        expectedVersion: (await db.operationObject.findUniqueOrThrow({ where: { id: pendingId } })).version,
        occurredAt: new Date().toISOString(),
        command: "DeliveryAssigned",
        data: {
          routeId,
          driverId: "synthetic-driver",
          stopSequence: 3,
          evidence: { reference: "synthetic-route-assignment-test", scope: "fixture-only" },
        },
      };
      const response = await fetch(`${apiBase}/operations/commands`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "http://route-order.test", "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      return { request, status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const snapshot = async () => {
      const [route, deliveries, objects] = await Promise.all([
        db.deliveryRoute.findUniqueOrThrow({ where: { id: routeId }, select: { status: true, closedWithPending: true } }),
        db.deliveryAssignment.findMany({ where: { routeId }, orderBy: [{ stopSequence: "asc" }, { id: "asc" }], select: { id: true, status: true, stopSequence: true } }),
        db.operationObject.findMany({ where: { id: { in: [routeId, completedId, dispatchedId, cancelledId] } }, select: { id: true, version: true } }),
      ]);
      return { route, deliveries, versions: Object.fromEntries(objects.map(object => [object.id, object.version])) };
    };
    const assertNoCommandWrites = async (request: ReorderEnvelope, before: Awaited<ReturnType<typeof snapshot>>) => {
      assert.deepEqual(await snapshot(), before);
      assert.equal(await db.commandReceipt.count({ where: { requestId: request.requestId } }), 0, "rejected command must not leave a successful receipt");
    };

    await t.test("closed_with_pending rejects before changing route, stops, versions, or receipt", async () => {
      await db.deliveryRoute.update({ where: { id: routeId }, data: { status: "closed_with_pending", closedWithPending: true } });
      const before = await snapshot();
      const result = await reorder([dispatchedId, completedId]);
      assert.equal(result.status, 409, JSON.stringify(result.body));
      assert.equal((result.body as { code?: unknown }).code, "ROUTE_REORDER_STATE");
      await assertNoCommandWrites(result.request, before);
      await db.deliveryRoute.update({ where: { id: routeId }, data: { status: "planned", closedWithPending: false } });
    });

    await t.test("incomplete and duplicate orders fail without changing persisted stops", async () => {
      for (const [ids, expectedStatus, expectedCode] of [
        [[dispatchedId], 422, "ROUTE_SCOPE"],
        [[dispatchedId, dispatchedId, completedId], 400, "ROUTE_DUPLICATES"],
      ] as const) {
        const before = await snapshot();
        const result = await reorder([...ids]);
        assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
        assert.equal((result.body as { code?: unknown }).code, expectedCode);
        await assertNoCommandWrites(result.request, before);
      }
    });

    await t.test("planned route reorders delivered and active stops once while leaving cancelled stops unchanged", async () => {
      const before = await snapshot();
      const result = await reorder([completedId, dispatchedId]);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual((result.body as { result?: { deliveryIds?: unknown } }).result?.deliveryIds, [completedId, dispatchedId]);
      const after = await snapshot();
      assert.deepEqual(after.deliveries, [
        { id: completedId, status: "delivered", stopSequence: 0 },
        { id: dispatchedId, status: "dispatched", stopSequence: 1 },
        { id: cancelledId, status: "cancelled", stopSequence: 2 },
      ]);
      assert.equal(after.route.status, "planned");
      assert.equal(after.route.closedWithPending, false);
      assert.equal(after.versions[routeId], before.versions[routeId]! + 1);
      assert.equal(after.versions[completedId], before.versions[completedId]! + 1);
      assert.equal(after.versions[dispatchedId], before.versions[dispatchedId]! + 1);
      assert.equal(after.versions[cancelledId], before.versions[cancelledId]);
      assert.equal(await db.commandReceipt.count({ where: { requestId: result.request.requestId } }), 1);
    });

    await t.test("DeliveryAssigned rejects a closed route before writes and accepts the same pending stop on an open route", async () => {
      const assignmentSnapshot = async () => {
        const [route, assignment, object] = await Promise.all([
          db.deliveryRoute.findUniqueOrThrow({ where: { id: routeId }, select: { status: true, closedWithPending: true } }),
          db.deliveryAssignment.findUniqueOrThrow({ where: { id: pendingId }, select: { routeId: true, driverId: true, status: true, stopSequence: true } }),
          db.operationObject.findUniqueOrThrow({ where: { id: pendingId }, select: { version: true } }),
        ]);
        return { route, assignment, version: object.version };
      };

      await db.deliveryRoute.update({ where: { id: routeId }, data: { status: "closed_with_pending", closedWithPending: true } });
      const beforeRejectedAssignment = await assignmentSnapshot();
      const rejected = await assign();
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.equal((rejected.body as { code?: unknown }).code, "DELIVERY_ROUTE_STATE");
      assert.deepEqual(await assignmentSnapshot(), beforeRejectedAssignment);
      assert.equal(await db.commandReceipt.count({ where: { requestId: rejected.request.requestId } }), 0);
      assert.equal(await db.operationAudit.count({ where: { requestId: rejected.request.requestId } }), 0);

      await db.deliveryRoute.update({ where: { id: routeId }, data: { status: "planned", closedWithPending: false } });
      const accepted = await assign();
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
      const afterAcceptedAssignment = await assignmentSnapshot();
      assert.deepEqual(afterAcceptedAssignment.route, { status: "planned", closedWithPending: false });
      assert.deepEqual(afterAcceptedAssignment.assignment, { routeId, driverId: "synthetic-driver", status: "assigned", stopSequence: 3 });
      assert.equal(afterAcceptedAssignment.version, beforeRejectedAssignment.version + 1);
      assert.equal(await db.commandReceipt.count({ where: { requestId: accepted.request.requestId } }), 1);
      assert.equal(await db.operationAudit.count({ where: { requestId: accepted.request.requestId } }), 2);
    });
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    if (schemaCreated) await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
