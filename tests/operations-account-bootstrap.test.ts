import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { splitSqlStatements } from "./migration-sql.js";
import bcrypt from "bcryptjs";
import type { Server } from "node:http";
import type { CommandEnvelope } from "../shared/operations/contracts.js";

test("account bootstrap eligibility follows global state, capability and scope; six-account command persists without balances", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname), "TEST_DATABASE_URL debe apuntar a loopback");
  assert.match(databaseUrl.pathname, /bombo_ui_(test|ci|optimization)/i, "usar una base descartable bombo_ui_");
  const schema = `acctboot_${randomUUID().replaceAll("-", "")}`;
  databaseUrl.searchParams.set("schema", schema);
  process.env.DATABASE_URL = databaseUrl.toString();
  process.env.DEMO_MODE = "true";
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "account-bootstrap-test-secret-more-than-32-characters";
  process.env.ALLOWED_ORIGIN = "http://account-bootstrap.test";

  const { db } = await import("../server/db.js");
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  let server: Server | undefined;
  try {
    const migrationsRoot = new URL("../prisma/migrations/", import.meta.url);
    const migrations = (await readdir(migrationsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const migration of migrations) {
      const sql = await readFile(new URL(`${migration.name}/migration.sql`, migrationsRoot), "utf8");
      for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
    }

    const fixturePassword = randomUUID();
    const password = await bcrypt.hash(fixturePassword, 4);
    await db.user.createMany({ data: [
      { id: "owner", name: "Synthetic owner", email: "owner@account-bootstrap.test", password, role: "owner" },
      { id: "reader", name: "Synthetic finance reader", email: "reader@account-bootstrap.test", password, role: "admin" },
      { id: "scoped", name: "Synthetic scoped finance", email: "scoped@account-bootstrap.test", password, role: "admin" },
    ] });
    await db.operationAccess.createMany({ data: [
      { userId: "reader", profile: "finance", capabilities: ["finance.read"] },
      { userId: "scoped", profile: "finance", capabilities: ["finance.read", "accounts.write"], scope: { accountIds: [] } },
    ] });

    const { app } = await import("../server/app.js");
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api`;
    const cookies: Record<string, string> = {};

    async function login(actor: string) {
      const response = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { Origin: "http://account-bootstrap.test", "Content-Type": "application/json" },
        body: JSON.stringify({ email: `${actor}@account-bootstrap.test`, password: fixturePassword }),
      });
      assert.equal(response.status, 200);
      cookies[actor] = response.headers.get("set-cookie")!.split(";")[0]!;
    }
    async function call(path: string, actor: string, body?: unknown) {
      return fetch(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { Cookie: cookies[actor]!, Origin: "http://account-bootstrap.test", "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    async function accounts(actor: string) {
      const response = await call("/operations/accounts", actor);
      const body = await response.json() as Record<string, any>;
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    }
    const envelope = (targetId: string, data: Record<string, unknown>): CommandEnvelope => ({
      schemaVersion: 1,
      requestId: randomUUID(),
      targetId,
      command: "AccountsInitialized",
      data,
      expectedVersion: 0,
      occurredAt: new Date().toISOString(),
    });

    for (const actor of ["owner", "reader", "scoped"]) await login(actor);

    const empty = await accounts("owner");
    assert.equal(empty.accountBootstrapEligible, true);
    assert.deepEqual(empty.items, []);
    assert.equal((await accounts("reader")).accountBootstrapEligible, false, "finance.read no demuestra accounts.write");
    const scopedEmpty = await accounts("scoped");
    assert.deepEqual(scopedEmpty.items, []);
    assert.equal(scopedEmpty.accountBootstrapEligible, false, "un alcance de cuentas vacío no demuestra que el estado global esté vacío");

    const inactiveId = randomUUID();
    await db.operationAccount.create({ data: {
      id: inactiveId,
      name: "Inactive synthetic account",
      currency: "ARS",
      kind: "bank",
      holder: "Synthetic holder",
      purpose: "Eligibility boundary fixture",
      active: false,
    } });
    const inactiveOnly = await accounts("owner");
    assert.deepEqual(inactiveOnly.items, [], "la lista visible mantiene el filtro de cuentas activas");
    assert.equal(inactiveOnly.accountBootstrapEligible, false, "una cuenta de club inactiva sigue bloqueando el bootstrap");
    await db.operationAccount.delete({ where: { id: inactiveId } });
    assert.equal((await accounts("owner")).accountBootstrapEligible, true);

    const templates = [
      { name: "Caja local ARS", currency: "ARS", kind: "cash", holder: "Synthetic holder", purpose: "Local cash" },
      { name: "Banco operativo ARS", currency: "ARS", kind: "bank", holder: "Synthetic holder", purpose: "Local operations" },
      { name: "Reserva ARS", currency: "ARS", kind: "reserve", holder: "Synthetic holder", purpose: "Local reserve" },
      { name: "Caja USD", currency: "USD", kind: "cash", holder: "Synthetic holder", purpose: "Foreign-currency cash" },
      { name: "Banco operativo USD", currency: "USD", kind: "bank", holder: "Synthetic holder", purpose: "Foreign-currency operations" },
      { name: "Reserva USD", currency: "USD", kind: "reserve", holder: "Synthetic holder", purpose: "Foreign-currency reserve" },
    ].map((account) => ({ ...account, id: randomUUID() }));

    const duplicateIds = templates.map((account) => ({ ...account }));
    duplicateIds[5]!.id = duplicateIds[0]!.id;
    const rejected = await call("/operations/commands", "owner", envelope(randomUUID(), { accounts: duplicateIds }));
    const rejectedBody = await rejected.json() as Record<string, any>;
    assert.equal(rejected.status, 422, JSON.stringify(rejectedBody));
    assert.equal(rejectedBody.code, "SIX_ACCOUNTS_REQUIRED");
    assert.equal(await db.operationAccount.count(), 0, "el rechazo por IDs duplicados no deja cuentas parciales");
    assert.equal(await db.operationObject.count(), 0, "el rechazo tampoco crea objetos versionados");
    assert.equal((await accounts("owner")).accountBootstrapEligible, true);

    const bootstrapTargetId = randomUUID();
    const initialized = await call("/operations/commands", "owner", envelope(bootstrapTargetId, { accounts: templates }));
    const initializedBody = await initialized.json() as Record<string, any>;
    assert.equal(initialized.status, 200, JSON.stringify(initializedBody));
    assert.equal(initializedBody.result.accounts.length, 6);
    assert.ok(initializedBody.result.accounts.every((account: { verified: boolean }) => account.verified === false));

    const persisted = await db.operationAccount.findMany({ orderBy: [{ currency: "asc" }, { name: "asc" }] });
    assert.equal(persisted.length, 6);
    assert.equal(persisted.filter((account) => account.currency === "ARS").length, 3);
    assert.equal(persisted.filter((account) => account.currency === "USD").length, 3);
    assert.ok(persisted.every((account) => account.kind !== "custody" && account.verified === false && account.openingMinor === 0n));
    assert.equal(await db.ledgerLeg.count(), 0, "la inicialización no fabrica saldos ni movimientos");
    assert.equal(await db.operationObject.count(), 7, "la transacción crea seis objetos de cuenta y el objeto versionado del bootstrap");
    assert.ok(await db.operationObject.findUnique({ where: { id: bootstrapTargetId } }));

    const after = await accounts("owner");
    assert.equal(after.accountBootstrapEligible, false);
    assert.equal(after.items.length, 6);
    assert.ok(after.items.every((account: { verified: boolean; balanceMinor: string | null; coverage: string }) =>
      account.verified === false && account.balanceMinor === null && account.coverage === "opening_pending"));
  } finally {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
