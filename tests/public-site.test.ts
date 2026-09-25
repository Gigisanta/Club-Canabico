import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const gateProbe = `
import express from "express";
import { publicSite } from "./server/site.ts";
const app = express();
app.use(express.json());
app.use("/api/site", publicSite);
app.use((error, _req, res, next) => {
  if (error instanceof Error && error.name === "ZodError") return res.status(400).json({ error: "validación" });
  next(error);
});
app.use((_req, res) => res.status(404).json({ error: "Ruta no encontrada" }));
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No se pudo leer el puerto de prueba");
  const base = \`http://127.0.0.1:\${address.port}/api\`;
  if (process.env.GATE_INQUIRY_PROBE === "true") {
    const { db } = await import("./server/db.ts");
    const events = [];
    Object.defineProperty(db.siteChannels, "findUnique", {
      configurable: true,
      value: async () => { events.push("channels"); throw new Error("optional channels unavailable"); },
    });
    Object.defineProperty(db.publicInquiry, "create", {
      configurable: true,
      value: async () => { events.push("insert"); return { id: "isolated-unit-inquiry" }; },
    });
    const submit = (consent) => fetch(base + "/site/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Ana", contact: "ana@example.test", interest: "Ficha", message: "Quiero saber más del club.", source: "test", consent }),
    });
    const rejected = await submit(false);
    const writesAfterRejected = events.length;
    const saved = await submit(true);
    process.stdout.write(JSON.stringify({
      rejected: { status: rejected.status, writesAfterRejected },
      saved: { status: saved.status, body: await saved.json() },
      events,
    }));
  } else {
    const routes = [];
    if (process.env.GATE_OPEN_PROBE !== "true") {
      for (const path of ["/site", "/site/showcase", "/site/showcase/demo", "/site/showcase/demo/image"]) {
        const response = await fetch(base + path);
        routes.push({ path, status: response.status, body: await response.json() });
      }
    }
    const inquiry = await fetch(base + "/site/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://test.local" },
      body: "{}",
    });
    process.stdout.write(JSON.stringify({ routes, inquiry: { status: inquiry.status, body: await inquiry.json() } }));
  }
} finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
`;

function probePublicSiteGate(overrides: NodeJS.ProcessEnv, openProbe = false) {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", gateProbe], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: {
      PATH: process.env.PATH || "",
      ...overrides,
      ...(openProbe ? { GATE_OPEN_PROBE: "true" } : {}),
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as {
    routes: { path: string; status: number; body: { error?: string } }[];
    inquiry: { status: number; body: { error?: string } };
    rejected?: { status: number; writesAfterRejected: number };
    saved?: { status: number; body: { saved?: boolean; whatsappUrl?: string | null } };
    events?: string[];
  };
}

test("public API gate is closed by default and in non-development environments", () => {
  const denied = { error: "Sitio público pendiente de aprobación" };
  const blockedScenarios = [
    { name: "NODE_ENV unset", env: {} },
    { name: "staging preview", env: { NODE_ENV: "staging", PUBLIC_SITE_PREVIEW: "true", HOST: "127.0.0.1" } },
    { name: "production preview", env: { NODE_ENV: "production", PUBLIC_SITE_PREVIEW: "true", HOST: "127.0.0.1" } },
    { name: "development on a wildcard host", env: { NODE_ENV: "development", PUBLIC_SITE_PREVIEW: "true", HOST: "0.0.0.0" } },
  ];
  for (const scenario of blockedScenarios) {
    const result = probePublicSiteGate(scenario.env);
    for (const route of result.routes)
      assert.deepEqual({ status: route.status, body: route.body }, { status: 404, body: denied }, `${scenario.name}: ${route.path}`);
    assert.deepEqual({ status: result.inquiry.status, body: result.inquiry.body }, { status: 404, body: denied }, `${scenario.name}: inquiry`);
  }
});

test("explicit local preview and approval open the public API gate", () => {
  const localPreview = probePublicSiteGate({
    NODE_ENV: "development", PUBLIC_SITE_PREVIEW: "true", HOST: "127.0.0.1",
  }, true);
  assert.equal(localPreview.inquiry.status, 400, "the invalid inquiry reached validation behind the open gate");

  const approvedProduction = probePublicSiteGate({
    NODE_ENV: "production", PUBLIC_SITE_APPROVED: "true", HOST: "0.0.0.0",
  }, true);
  assert.equal(approvedProduction.inquiry.status, 400, "the invalid inquiry reached validation behind the approved gate");
});

test("inquiry rejection is write-free and channel failure falls back to a saved response", () => {
  const result = probePublicSiteGate({
    NODE_ENV: "development", PUBLIC_SITE_PREVIEW: "true", HOST: "127.0.0.1", GATE_INQUIRY_PROBE: "true",
  }, true);
  assert.deepEqual(result.rejected, { status: 400, writesAfterRejected: 0 });
  assert.equal(result.saved?.status, 201);
  assert.deepEqual(result.saved?.body, { saved: true, whatsappUrl: null });
  assert.deepEqual(result.events, ["channels", "insert"]);
});

test("public showcase, inquiry and permissions stay separate from club data", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const testUrl = new URL(process.env.TEST_DATABASE_URL!);
  const testHost = testUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const testName = decodeURIComponent(testUrl.pathname.slice(1));
  assert.ok(["postgres:", "postgresql:"].includes(testUrl.protocol), "Las pruebas requieren PostgreSQL.");
  assert.ok(testHost === "localhost" || testHost === "::1" || /^127\./.test(testHost), "TEST_DATABASE_URL debe apuntar a loopback.");
  assert.match(testName, /^bombo_ui_[a-z0-9_-]+$/i, "TEST_DATABASE_URL debe usar una base dedicada bombo_ui_.");
  if (process.env.DATABASE_URL) {
    const appUrl = new URL(process.env.DATABASE_URL);
    const appHost = appUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const normalizedHost = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host) ? "loopback" : host;
    assert.notEqual(
      `${normalizedHost(testHost)}:${testUrl.port || "5432"}/${testName}`,
      `${normalizedHost(appHost)}:${appUrl.port || "5432"}/${decodeURIComponent(appUrl.pathname.slice(1))}`,
      "TEST_DATABASE_URL no puede ser la base configurada para la aplicación.",
    );
  }
  const schema = `test_site_${randomUUID().replaceAll("-", "")}`;
  const url = new URL(testUrl);
  url.searchParams.set("schema", schema);
  process.env.DATABASE_URL = url.toString();
  process.env.DEMO_MODE = "true";
  process.env.JWT_SECRET = "test-only-secret-with-more-than-thirty-two-chars";
  process.env.ALLOWED_ORIGIN = "http://test.local";
  process.env.NODE_ENV = "test";
  process.env.PUBLIC_SITE_APPROVED = "true";
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
      body: options.body === undefined ? undefined : isRaw ? options.body as unknown as BodyInit : JSON.stringify(options.body),
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
    assert.equal(await db.publicInquiry.count(), 0, "rejected consent must not persist an inquiry");
    const created = await call("/site/inquiries", { body: { name: "Ana", contact: "ana@example.test", interest: "Ficha", message: "Quiero saber más del club.", source: "producto:ficha-editorial", consent: true, website: "" } });
    assert.equal(created.status, 201, await created.clone().text());
    const result = await created.json();
    assert.equal(result.saved, true);
    assert.ok(result.whatsappUrl.startsWith("https://wa.me/5491123456789?text="));
    assert.ok(!result.whatsappUrl.includes("Ana") && !result.whatsappUrl.includes("example"));
    assert.equal(await db.publicInquiry.count(), 1);

    await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."SiteChannels" RENAME TO "SiteChannels_unavailable"`);
    let fallbackCreated: Response;
    try {
      fallbackCreated = await call("/site/inquiries", { body: { name: "Eva", contact: "eva@example.test", interest: "Ficha", message: "Quiero saber más del club.", source: "producto:ficha-editorial", consent: true, website: "" } });
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."SiteChannels_unavailable" RENAME TO "SiteChannels"`);
    }
    assert.equal(fallbackCreated.status, 201, await fallbackCreated.clone().text());
    const fallbackResult = await fallbackCreated.json();
    assert.equal(fallbackResult.saved, true);
    assert.equal(fallbackResult.whatsappUrl, null, "a channel lookup failure must not turn a saved inquiry into a failure");
    assert.equal(await db.publicInquiry.count(), 2);
    assert.equal(await db.customer.count(), 1);
    assert.equal((await (await call("/site/admin/inquiries", { cookie: owner })).json()).items[0].contact, "eva@example.test");
    await db.publicInquiry.createMany({ data: Array.from({ length: 50 }, (_, index) => ({
      name: `Consulta ${index}`, contact: `consulta${index}@example.test`, interest: "Club",
      message: "Consulta editorial para verificar paginación.", source: "test", consentAt: new Date(),
    })) });
    const firstPage = await (await call("/site/admin/inquiries", { cookie: owner })).json();
    assert.equal(firstPage.items.length, 50);
    assert.ok(firstPage.nextCursor);
    const secondPage = await (await call(`/site/admin/inquiries?cursor=${firstPage.nextCursor}`, { cookie: owner })).json();
    assert.equal(secondPage.items.length, 2);
    assert.equal(secondPage.nextCursor, null);
    assert.ok(!firstPage.items.some((item: { id: string }) => item.id === secondPage.items[0].id));
    assert.equal((await call(`/site/admin/showcase/${draft.id}/status`, { cookie: owner, method: "PATCH", body: { status: "draft" } })).status, 200);
    assert.equal((await call("/site/showcase/ficha-editorial/image")).status, 404);

    const countBeforeFailedInsert = await db.publicInquiry.count();
    await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."PublicInquiry" RENAME TO "PublicInquiry_unavailable"`);
    let failedInsert: Response;
    try {
      failedInsert = await call("/site/inquiries", { body: { name: "Eva", contact: "eva@example.test", interest: "Ficha", message: "Quiero saber más del club.", source: "test", consent: true } });
    } finally {
      await db.$executeRawUnsafe(`ALTER TABLE "${schema}"."PublicInquiry_unavailable" RENAME TO "PublicInquiry"`);
    }
    assert.equal(failedInsert.status, 500);
    assert.equal(await db.publicInquiry.count(), countBeforeFailedInsert, "a failed insert must leave no persisted inquiry");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
    await db.$disconnect();
  }
});
