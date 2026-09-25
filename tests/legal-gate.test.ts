import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { defaults } from "../shared/domain.js";
import { splitSqlStatements } from "./migration-sql.js";

test("real club mode blocks regulated sales until club approval", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.DEMO_MODE = "false";
  delete process.env.CLUB_OPERATIONS_APPROVED;
  process.env.JWT_SECRET = "test-only-secret-with-more-than-thirty-two-chars";
  process.env.ALLOWED_ORIGIN = "http://test.local";
  process.env.NODE_ENV = "test";
  const { db } = await import("../server/db.js");
  await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  const migrationRoot = new URL("../prisma/migrations/", import.meta.url);
  for (const folder of (await readdir(migrationRoot, { withFileTypes: true })).filter((f) => f.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = await readFile(new URL(`${folder.name}/migration.sql`, migrationRoot), "utf8");
    for (const statement of splitSqlStatements(sql)) await db.$executeRawUnsafe(statement);
  }
  await db.user.create({ data: { id: "owner", name: "Owner", email: "owner@test.local", role: "owner", password: await bcrypt.hash("test-password-123", 4) } });
  await db.setting.create({ data: { id: 1, value: defaults } });
  await db.customer.create({ data: { id: "member", name: "Member", email: "", phone: "", permitStatus: "verified", permitValidUntil: "2027-12-31" } });
  await db.product.create({ data: { id: "lot", name: "Lot", strain: "Test", type: "Flor", unit: "g", lot: "lot", stock: 1000, minimum: 0, cost: 100, price: 200, location: "A", ownerId: "owner" } });
  const { app } = await import("../server/app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api`;
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { Origin: "http://test.local", "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@test.local", password: "test-password-123" }) });
    assert.equal(login.status, 200);
    const headers = { Cookie: login.headers.get("set-cookie")!.split(";")[0], Origin: "http://test.local", "Content-Type": "application/json" };
    const state = await (await fetch(`${base}/views/settings`, { headers })).json();
    assert.equal(state.operationsEnabled, false);
    const sale = await fetch(`${base}/sales`, { method: "POST", headers, body: JSON.stringify({ requestId: randomUUID(), customerId: "member", payment: "cash", items: [{ productId: "lot", quantity: 1000 }] }) });
    assert.equal(sale.status, 403);
    assert.equal(await db.sale.count(), 0);
    assert.equal(await db.cashEntry.count(), 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
