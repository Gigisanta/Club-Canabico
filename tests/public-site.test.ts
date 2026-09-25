import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

test("public showcase, inquiry and permissions stay separate from club data", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const schema = `test_site_${randomUUID().replaceAll("-", "")}`;
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
  for (const folder of (await readdir(migrationRoot, { withFileTypes: true })).filter(f => f.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const sql = await readFile(new URL(`${folder.name}/migration.sql`, migrationRoot), "utf8");
    for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
  }
  for (const [id, role] of [["owner", "owner"], ["admin", "admin"], ["r1", "responsible"], ["cashier", "cashier"]] as const)
    await db.user.create({ data: { id, name: id, email: `${id}@test.local`, role, password: "unused" } });
  await db.customer.create({ data: { name: "Dato privado", email: "private@example.test", phone: "", notes: "private note" } });
  await db.product.create({ data: { name: "Lote interno", strain: "", type: "Flor", lot: "SECRET-LOT", stock: 1000, minimum: 0, cost: 900, price: 2000, location: "A", ownerId: "owner" } });
  const { app } = await import("../server/app.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api`;
  async function login(id: string) {
    const response = await fetch(`${base}/auth/demo`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://test.local" }, body: JSON.stringify({ id }) });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }
  const owner = await login("owner");
  const admin = await login("admin");
  const responsible = await login("r1");
  const cashier = await login("cashier");
  async function call(path: string, options: { method?: string; body?: unknown; cookie?: string; type?: string } = {}) {
    const isRaw = Buffer.isBuffer(options.body);
    return fetch(base + path, {
      method: options.method || (options.body === undefined ? "GET" : "POST"),
      headers: { Origin: "http://test.local", ...(options.cookie ? { Cookie: options.cookie } : {}), ...(options.body === undefined ? {} : { "Content-Type": options.type || (isRaw ? "image/png" : "application/json") }) },
      body: options.body === undefined ? undefined : isRaw ? options.body as Buffer : JSON.stringify(options.body),
    });
  }
  try {
    assert.equal((await call("/site/admin/showcase", { cookie: responsible })).status, 403);
    assert.equal((await call("/site/admin/inquiries", { cookie: cashier })).status, 403);
    assert.equal((await call("/site/admin/channels", { cookie: admin })).status, 200);
    assert.deepEqual((await (await call("/site/showcase")).json()).items, []);
    const draftResponse = await call("/site/admin/showcase", { cookie: owner, body: { title: "Ficha editorial", slug: "ficha-editorial", category: "Flores", description: "Descripción editorial sin disponibilidad ni precio.", sortOrder: 2 } });
    assert.equal(draftResponse.status, 201, await draftResponse.clone().text());
    const draft = await draftResponse.json();
    assert.equal((await call("/site/showcase/ficha-editorial")).status, 404);
    assert.equal((await call(`/site/admin/showcase/${draft.id}/status`, { cookie: owner, method: "PATCH", body: { status: "published" } })).status, 400);
    const png = await readFile(new URL("../public/brand/bombo-symbol.png", import.meta.url));
    assert.equal((await call(`/site/admin/showcase/${draft.id}/image`, { cookie: owner, method: "PUT", body: png, type: "image/png" })).status, 200);
    assert.equal((await call(`/site/admin/showcase/${draft.id}/status`, { cookie: admin, method: "PATCH", body: { status: "published" } })).status, 200);
    const response = await call("/site/showcase");
    assert.equal(response.status, 200);
    const publicBody = await response.text();
    assert.ok(!/stock|price|cost|SECRET-LOT|private@example|Dato privado|notes/i.test(publicBody));
    const listed = JSON.parse(publicBody).items;
    assert.deepEqual(Object.keys(listed[0]).sort(), ["category", "description", "imageUrl", "slug", "title"]);
    assert.equal((await call("/site/showcase/ficha-editorial/image")).headers.get("content-type"), "image/webp");
    assert.equal((await call("/site/admin/channels", { cookie: owner, method: "PUT", body: { whatsappPhone: "+54 9 11 2345 6789", instagramUrl: "https://www.instagram.com/bombo.club/" } })).status, 200);
    assert.deepEqual(await (await call("/site")).json(), { whatsappAvailable: true, instagramUrl: "https://www.instagram.com/bombo.club/" });
    const bad = await call("/site/inquiries", { body: { name: "Ana", contact: "ana@example.test", interest: "Ficha", message: "Quiero saber más del club.", source: "producto:ficha-editorial", consent: false } });
    assert.equal(bad.status, 400);
    const created = await call("/site/inquiries", { body: { name: "Ana", contact: "ana@example.test", interest: "Ficha", message: "Quiero saber más del club.", source: "producto:ficha-editorial", consent: true, website: "" } });
    assert.equal(created.status, 201, await created.clone().text());
    const result = await created.json();
    assert.equal(result.saved, true);
    assert.ok(result.whatsappUrl.startsWith("https://wa.me/5491123456789?text="));
    assert.ok(!result.whatsappUrl.includes("Ana") && !result.whatsappUrl.includes("example"));
    assert.equal(await db.publicInquiry.count(), 1);
    assert.equal(await db.customer.count(), 1);
    assert.equal((await (await call("/site/admin/inquiries", { cookie: owner })).json()).items[0].contact, "ana@example.test");
    await db.publicInquiry.createMany({ data: Array.from({ length: 50 }, (_, index) => ({
      name: `Consulta ${index}`, contact: `consulta${index}@example.test`, interest: "Club",
      message: "Consulta editorial para verificar paginación.", source: "test", consentAt: new Date(),
    })) });
    const firstPage = await (await call("/site/admin/inquiries", { cookie: owner })).json();
    assert.equal(firstPage.items.length, 50);
    assert.ok(firstPage.nextCursor);
    const secondPage = await (await call(`/site/admin/inquiries?cursor=${firstPage.nextCursor}`, { cookie: owner })).json();
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.nextCursor, null);
    assert.ok(!firstPage.items.some((item: { id: string }) => item.id === secondPage.items[0].id));
    assert.equal((await call(`/site/admin/showcase/${draft.id}/status`, { cookie: owner, method: "PATCH", body: { status: "draft" } })).status, 200);
    assert.equal((await call("/site/showcase/ficha-editorial/image")).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
