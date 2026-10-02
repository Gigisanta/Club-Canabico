import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { defaults } from "../shared/domain.js";
import { splitSqlStatements } from "./migration-sql.js";
test(
  "PostgreSQL API: isolation, atomic sales, cash closing and migration",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = `test_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set("schema", schema);
    process.env.DATABASE_URL = url.toString();
    process.env.DEMO_MODE = "true";
    process.env.JWT_SECRET = "test-only-secret-with-more-than-thirty-two-chars";
    process.env.ALLOWED_ORIGIN = "http://test.local";
    process.env.NODE_ENV = "test";
    const { db } = await import("../server/db.js");
    await db.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    const migrationRoot=new URL('../prisma/migrations/',import.meta.url);
    for(const folder of (await readdir(migrationRoot,{withFileTypes:true})).filter(f=>f.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name))){
      const sql=await readFile(new URL(`${folder.name}/migration.sql`,migrationRoot),'utf8');
      for(const statement of splitSqlStatements(sql))await db.$executeRawUnsafe(statement);
    }
    const password = await bcrypt.hash("test-password-123", 4);
    for (const [id, role] of [
      ["owner", "owner"],
      ["r1", "responsible"],
      ["r2", "responsible"],
      ["cashier", "cashier"],
      ["viewer", "viewer"],
    ] as const)
      await db.user.create({
        data: { id, name: id, username: id, email: `${id}@test.local`, role, password },
      });
    await db.setting.create({ data: { id: 1, value: { ...defaults,pointsEvery:1000,pointValue:10,silverAt:5000,goldAt:15000 } } });
    await db.customer.create({
      data: {
        id: "customer",
        name: "Cliente de prueba",
        email: "hidden@example.test",
        phone: "",
        points: 200,
      },
    });
    for (const id of ["p1", "p2"])
      await db.product.create({
        data: {
          id,
          name: id,
          strain: "Test",
          type: "Flor",
          unit: "g",
          lot: id,
          stock: 10000,
          minimum: 1000,
          cost: 400,
          price: 1000,
          location: "A",
          ownerId: id === "p1" ? "r1" : "r2",
        },
      });
    const { app } = await import("../server/app.js");
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    const address = server.address();
    assert(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api`;
    async function login(id: string) {
      const res = await fetch(base + "/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://test.local",
        },
        body: JSON.stringify({
          email: `${id}@test.local`,
          password: "test-password-123",
        }),
      });
      assert.equal(res.status, 200);
      return res.headers.get("set-cookie")!.split(";")[0];
    }
    const cookies = {
      owner: await login("owner"),
      r1: await login("r1"),
      cashier: await login("cashier"),
      viewer: await login("viewer"),
      // Set once the first subtest activates Camila's manager seat.
      admin: "",
    };
    async function call(
      path: string,
      role: keyof typeof cookies = "owner",
      body?: unknown,
      method?: string,
    ) {
      return fetch(base + path, {
        method: method || (body ? "POST" : "GET"),
        headers: {
          Cookie: cookies[role],
          Origin: "http://test.local",
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    }
    try {
      await t.test("team access stays inactive until a personal one-time link is used", async () => {
        assert.equal((await call("/team-seats", "viewer", { name: "Intruso", role: "admin" })).status, 403);
        const created = await call("/team-seats", "owner", { name: "Camila", role: "admin" });
        assert.equal(created.status, 201);
        const seat = await created.json();
        assert.equal(seat.email, null);
        assert.equal((await db.user.findUnique({ where: { id: seat.id } })), null);
        const before = await fetch(base + "/auth/login", { method: "POST", headers: { Origin: "http://test.local", "Content-Type": "application/json" }, body: JSON.stringify({ email: "camila@test.local", password: "Camila-personal-123" }) });
        assert.equal(before.status, 401);
        const prepared = await call(`/team-seats/${seat.id}/invite`, "owner", { email: "Camila@Test.Local" });
        assert.equal(prepared.status, 200);
        const { path } = await prepared.json();
        const token = new URL(`http://test.local${path}`).hash.slice("#token=".length);
        const saved = await db.teamSeat.findUniqueOrThrow({ where: { id: seat.id } });
        assert.equal(saved.email, "camila@test.local");
        assert.notEqual(saved.tokenHash, token);
        const publicCall = (endpoint: string, body: unknown) => fetch(base + endpoint, { method: "POST", headers: { Origin: "http://test.local", "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const invitation = await publicCall("/auth/invitation", { token });
        assert.equal(invitation.status, 200);
        assert.equal((await invitation.json()).name, "Camila");
        assert.equal((await publicCall("/auth/activate", { token: "invalid", password: "Camila-personal-123" })).status, 404);
        assert.equal((await publicCall("/auth/activate", { token, username: " OWNER ", password: "Camila-personal-123" })).status, 409);
        assert.equal((await db.teamSeat.findUniqueOrThrow({ where: { id: seat.id } })).activatedAt, null);
        const activated = await publicCall("/auth/activate", { token, username: " Camila ", password: "Camila-personal-123" });
        assert.equal(activated.status, 200);
        const activatedUser = (await activated.json()).user;
        assert.equal(activatedUser.role, "admin");
        assert.equal(activatedUser.username, "camila");
        assert.equal((await publicCall("/auth/activate", { token, password: "Camila-personal-123" })).status, 404);
        assert.equal((await publicCall("/auth/invitation", { token })).status, 404);
        const camila = await publicCall("/auth/login", { username: " CAMILA ", password: "Camila-personal-123" });
        assert.equal(camila.status, 200);
        cookies.admin = camila.headers.get("set-cookie")!.split(";")[0];
        for (const username of ["camila", "missing-user"]) {
          const denied = await publicCall("/auth/login", { username, password: "Wrong-local-password" });
          assert.equal(denied.status, 401);
          assert.equal(denied.headers.get("set-cookie"), null);
          assert.equal((await denied.json()).error, "Usuario o contraseña incorrectos");
        }
        assert.equal((await publicCall("/auth/login", { username: "camila", email: "owner@test.local", password: "Camila-personal-123" })).status, 400);
        await db.user.update({ where: { id: seat.id }, data: { active: false } });
        try {
          assert.equal((await publicCall("/auth/login", { username: "camila", password: "Camila-personal-123" })).status, 401);
        } finally {
          await db.user.update({ where: { id: seat.id }, data: { active: true } });
        }
      });
      await t.test("product catalog remembers saved names and optional profiles within each role's scope", async () => {
        const lots = ["catalog-lot-1", "catalog-lot-2", "catalog-lot-3"];
        try {
          assert.equal((await call("/product-catalog", "viewer")).status, 403);
          const original = await db.product.findUniqueOrThrow({ where: { id: "p1" } });
          for (const lot of lots.slice(0, 2)) {
            const created = await call("/products", "owner", { ...original, name: "Lemon Haze", strain: "", lot });
            assert.equal(created.status, 201, await created.clone().text());
          }
          const cbd = await call("/products", "owner", { ...original, name: "Aceite CBD 10%", strain: "CBD", type: "Aceite", unit: "ud", lot: lots[2] });
          assert.equal(cbd.status, 201, await cbd.clone().text());
          const ownerCatalog = await (await call("/product-catalog?q=lemon", "owner")).json();
          assert.deepEqual(ownerCatalog.products.map((p: { name: string }) => p.name), ["Lemon Haze"]);
          assert.equal(ownerCatalog.products[0].strain, "");
          assert.equal(ownerCatalog.profiles.includes("Test"), true);
          assert.equal(ownerCatalog.profiles.includes("CBD"), true);
          assert.equal(ownerCatalog.profiles.includes(""), false);
          const responsibleCatalog = await (await call("/product-catalog?q=p2", "r1")).json();
          assert.deepEqual(responsibleCatalog.products, []);
          const scopedCatalog = await (await call("/product-catalog?q=lemon", "r1")).json();
          assert.equal(scopedCatalog.products.length, 1);
          assert.deepEqual((await (await call("/product-catalog?q=_", "owner")).json()).products, []);
        } finally {
          const products = await db.product.findMany({ where: { lot: { in: lots } }, select: { id: true } });
          await db.movement.deleteMany({ where: { productId: { in: products.map((p) => p.id) } } });
          await db.product.deleteMany({ where: { lot: { in: lots } } });
        }
      });
      await t.test("product catalog browse reaches every saved name without duplicates", async () => {
        const lots = Array.from({ length: 45 }, (_, index) => `catalog-page-${index}`);
        try {
          await db.product.createMany({ data: lots.map((lot, index) => ({
            name: `Catálogo ${String(index).padStart(2, "0")}`,
            strain: "", type: "Flor", unit: "g", lot,
            stock: 1, minimum: 0, cost: 100, price: 200, location: "A", ownerId: "r1",
          })) });
          const first = await (await call("/product-catalog?all=1", "r1")).json();
          assert.equal(first.products.length, 40);
          assert.ok(first.nextCursor);
          const second = await (await call(`/product-catalog?all=1&cursor=${encodeURIComponent(first.nextCursor)}`, "r1")).json();
          const names = [...first.products, ...second.products].map((product: { name: string }) => product.name);
          assert.equal(names.length, 46);
          assert.equal(new Set(names).size, names.length);
          assert.equal(names.includes("p1"), true);
          assert.equal(names.includes("p2"), false);
          assert.equal(second.nextCursor, null);
        } finally {
          await db.product.deleteMany({ where: { lot: { in: lots } } });
        }
      });
      await t.test("requires session and rejects foreign origins", async () => {
        assert.equal((await fetch(base + "/views/dashboard")).status, 401);
        assert.equal(
          (
            await fetch(base + "/products", {
              method: "POST",
              headers: {
                Cookie: cookies.owner,
                Origin: "https://evil.local",
                "Content-Type": "application/json",
              },
              body: "{}",
            })
          ).status,
          403,
        );
      });
      await t.test("owner saves suppliers, selects a default, and archives without losing linked lots", async () => {
        assert.equal((await call("/suppliers", "viewer")).status, 403);
        const body = { name: "  Cultivo   Norte ", contactName: "Camila", phone: "123", email: "", notes: "Entrega semanal", isDefault: true };
        assert.equal((await call("/suppliers", "r1", body)).status, 403);
        const created = await call("/suppliers", "owner", body);
        assert.equal(created.status, 201, await created.clone().text());
        const first = await created.json();
        assert.equal(first.name, "Cultivo Norte");
        assert.equal((await call("/suppliers", "owner", { ...body, name: "cultivo norte" })).status, 409);
        const secondResponse = await call("/suppliers", "owner", { ...body, name: "Vivero Sur" });
        assert.equal(secondResponse.status, 201);
        const second = await secondResponse.json();
        const catalog = await (await call("/suppliers", "r1")).json();
        assert.equal(catalog.items.find((s: { id: string }) => s.id === first.id).isDefault, false);
        assert.equal(catalog.items.find((s: { id: string }) => s.id === second.id).isDefault, true);
        const p1 = await db.product.findUniqueOrThrow({ where: { id: "p1" } });
        assert.equal((await call("/products/p1", "owner", { ...p1, supplierId: first.id }, "PATCH")).status, 200);
        assert.equal((await db.product.findUniqueOrThrow({ where: { id: "p1" } })).supplier, "Cultivo Norte");
        const linked = await (await call("/suppliers")).json();
        assert.equal(linked.items.find((s: { id: string }) => s.id === first.id).lotCount, 1);
        assert.equal((await call(`/suppliers/${first.id}`, "owner", { ...body, name: "Cultivo Norte Renovado", isDefault: false }, "PATCH")).status, 200);
        const currentLot = await (await call("/list/products?q=p1", "owner")).json();
        assert.equal(currentLot.items[0].supplier, "Cultivo Norte Renovado");
        assert.equal((await call(`/suppliers/${first.id}/status`, "owner", { active: false }, "PATCH")).status, 200);
        assert.equal((await call("/products/p1", "owner", { ...p1, supplierId: first.id }, "PATCH")).status, 200);
        const newLot = { ...p1, lot: "new-lot", name: "New lot", stock: 1000, supplierId: first.id };
        assert.equal((await call("/products", "owner", newLot)).status, 400);
        assert.equal((await call(`/suppliers/${first.id}/status`, "owner", { active: true }, "PATCH")).status, 200);
        assert.equal((await call("/products", "owner", newLot)).status, 201);
        const added = await db.product.findUniqueOrThrow({ where: { lot: "new-lot" } });
        assert.equal(added.supplierId, first.id);
        await db.movement.deleteMany({ where: { productId: added.id } });
        await db.product.delete({ where: { id: added.id } });
      });
      await t.test("owner manages locations and linked lots keep a stable location", async () => {
        assert.equal((await call("/locations", "viewer")).status, 403);
        assert.equal((await call("/locations", "r1", { name: "Sin permiso" })).status, 403);
        const body = { name: " Depósito   Central ", isDefault: true };
        const created = await call("/locations", "owner", body);
        assert.equal(created.status, 201, await created.clone().text());
        const first = await created.json();
        assert.equal(first.name, "Depósito Central");
        assert.equal((await call("/locations", "owner", { name: "depósito central" })).status, 409);
        const secondResponse = await call("/locations", "owner", { name: "Estante B", isDefault: false });
        assert.equal(secondResponse.status, 201);
        const second = await secondResponse.json();
        assert.equal(second.isDefault, false);
        assert.equal((await call(`/locations/${second.id}`, "r1", { name: "Estante B", isDefault: true }, "PATCH")).status, 403);
        assert.equal((await call(`/locations/${second.id}`, "owner", { name: "Estante B", isDefault: true }, "PATCH")).status, 200);
        const catalog = await (await call("/locations", "r1")).json();
        assert.equal(catalog.items.find((l: { id: string }) => l.id === first.id).isDefault, false);
        assert.equal(catalog.items.find((l: { id: string }) => l.id === second.id).isDefault, true);
        const original = await db.product.findUniqueOrThrow({ where: { id: "p1" } });
        try {
          assert.equal((await call("/products", "r1", { ...original, lot: "unknown-location-lot", location: "Ubicación ajena", locationId: null })).status, 400);
          assert.equal((await call("/products/p1", "owner", { ...original, locationId: first.id }, "PATCH")).status, 200);
          assert.equal((await db.product.findUniqueOrThrow({ where: { id: "p1" } })).location, "Depósito Central");
          const linked = await (await call("/locations")).json();
          assert.equal(linked.items.find((l: { id: string }) => l.id === first.id).lotCount, 1);
          assert.equal((await call(`/locations/${first.id}`, "owner", { name: "Depósito Principal", isDefault: false }, "PATCH")).status, 200);
          const listed = await (await call("/list/products?q=p1", "owner")).json();
          assert.equal(listed.items[0].location, "Depósito Principal");
          assert.equal((await call(`/locations/${first.id}/status`, "owner", { active: false }, "PATCH")).status, 200);
          const updated = await db.product.findUniqueOrThrow({ where: { id: "p1" } });
          assert.equal((await call("/products/p1", "owner", { ...updated }, "PATCH")).status, 200);
          assert.equal((await call("/products", "owner", { ...updated, lot: "new-location-lot", locationId: first.id })).status, 400);
          assert.equal((await call(`/locations/${first.id}/status`, "owner", { active: true }, "PATCH")).status, 200);
          const added = await call("/products", "owner", { ...updated, lot: "new-location-lot", locationId: first.id });
          assert.equal(added.status, 201, await added.clone().text());
          const newProduct = await added.json();
          assert.equal(newProduct.locationId, first.id);
          await db.movement.deleteMany({ where: { productId: newProduct.id } });
          await db.product.delete({ where: { id: newProduct.id } });
        } finally {
          await db.product.update({ where: { id: "p1" }, data: { location: original.location, locationId: original.locationId } });
        }
      });
      await t.test(
        "viewer cannot mutate; responsible cannot read or move another owner stock",
        async () => {
          assert.equal((await call("/products", "viewer", {})).status, 403);
          const state = await (await call("/list/products?owner=r2", "r1")).json();
          assert.deepEqual(
            state.items.map((p: { id: string }) => p.id),
            ["p1"],
          );
          assert.equal((await (await call("/views/inventory?owner=r2", "r1")).json()).users.length, 1);
          assert.equal((await (await call("/list/customers?q=hidden%40example.test", "viewer")).json()).total, 0);
          assert.equal((await (await call("/list/customers?q=hidden%40example.test", "owner")).json()).total, 1);
          assert.equal(
            (
              await call("/products/p2/movements", "r1", {
                type: "entry",
                quantity: 1000,
                note: "No permitido",
              })
            ).status,
            404,
          );
        },
      );
      const requestId = randomUUID();
      await t.test(
        "sale atomically decrements stock, awards points, and is idempotent",
        async () => {
          const payload = {
            requestId,
            customerId: "customer",
            payment: "cash",
            points: 10,
            items: [{ productId: "p1", quantity: 2000 }],
          };
          const res = await call("/sales", "owner", payload);
          assert.equal(res.status, 201, await res.clone().text());
          const sale = await res.json();
          assert.equal(sale.total, 1900);
          assert.equal(sale.items[0].unit, "g");
          assert.equal(
            (await db.product.findUniqueOrThrow({ where: { id: "p1" } })).stock,
            8000,
          );
          assert.equal(
            (await db.customer.findUniqueOrThrow({ where: { id: "customer" } }))
              .points,
            191,
          );
          assert.equal((await call("/sales", "owner", payload)).status, 201);
          assert.equal(await db.sale.count(), 1);
          assert.equal(await db.movement.count(), 1);
        },
      );
      await t.test(
        "insufficient stock rejects all lines with no partial writes",
        async () => {
          const res = await call("/sales", "owner", {
            requestId: randomUUID(),
            customerId: "customer",
            payment: "cash",
            items: [
              { productId: "p1", quantity: 1000 },
              { productId: "p2", quantity: 999000 },
            ],
          });
          assert.equal(res.status, 409);
          assert.equal(
            (await db.product.findUniqueOrThrow({ where: { id: "p1" } })).stock,
            8000,
          );
          assert.equal(await db.sale.count(), 1);
        },
      );
      await t.test("concurrent sales cannot oversell", async () => {
        const payload = () => ({
          requestId: randomUUID(),
          customerId: "customer",
          payment: "card",
          items: [{ productId: "p2", quantity: 7000 }],
        });
        const results = await Promise.all([
          call("/sales", "owner", payload()),
          call("/sales", "owner", payload()),
        ]);
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        assert.equal(
          (await db.product.findUniqueOrThrow({ where: { id: "p2" } })).stock,
          3000,
        );
      });
      await t.test("sale history finds product names within the user's scope", async () => {
        // Short tokens such as P2 can also match a randomly generated sale ID.
        // Exercise the product-name search with distinct historical item names.
        const names = { p1: "Nombre historico producto propio", p2: "Nombre historico producto ajeno" };
        for (const [productId, name] of Object.entries(names))
          await db.saleItem.updateMany({ where: { productId }, data: { name } });
        try {
          const owner = await (await call(`/list/sales?q=${encodeURIComponent(names.p2.toUpperCase())}`, "owner")).json();
          assert.equal(owner.total, 1);
          assert.equal(owner.items[0].items[0].name, names.p2);
          assert.equal(owner.items[0].items[0].unit, "g");
          const responsible = await (await call(`/list/sales?q=${encodeURIComponent(names.p2)}`, "r1")).json();
          assert.equal(responsible.total, 0);
          const ownProduct = await (await call(`/list/sales?q=${encodeURIComponent(names.p1.toUpperCase())}`, "r1")).json();
          assert.equal(ownProduct.total, 1);
        } finally {
          for (const productId of Object.keys(names))
            await db.saleItem.updateMany({ where: { productId }, data: { name: productId } });
        }
      });
      await t.test(
        "responsible sale cannot include a foreign product",
        async () => {
          assert.equal(
            (
              await call("/sales", "r1", {
                requestId: randomUUID(),
                customerId: "customer",
                payment: "cash",
                items: [{ productId: "p2", quantity: 1000 }],
              })
            ).status,
            403,
          );
        },
      );
      await t.test(
        "transfers preserve historic attribution; restricted state masks costs",
        async () => {
          assert.equal(
            (
              await call("/products/p1/movements", "owner", {
                type: "transfer",
                quantity: 0,
                ownerId: "r2",
                note: "Traspaso completo",
              })
            ).status,
            201,
          );
          const state = await (await call("/views/dashboard", "r1")).json();
          assert.equal((await (await call("/views/inventory", "r1")).json()).products.length, 0);
          assert.equal("sales" in state, false);
          assert.equal("customers" in state, false);
          const history = await (await call("/customers/customer/history", "r1")).json();
          assert.equal(history.items.length, 1);
          assert.equal(history.items[0].items[0].ownerId, "r1");
          assert.equal(history.items[0].subtotal, 2000);
          assert.equal(history.items[0].discount, 100);
          assert.equal(history.items[0].pointsEarned, 0);
          const salePage = await (await call("/list/sales", "r1")).json();
          assert.equal(salePage.items[0].subtotal, 2000);
          assert.equal(salePage.items[0].discount, 100);
          const customers = await (await call("/list/customers", "r1")).json();
          assert.equal(customers.items[0].totalSpent, 1900);
          assert.equal(customers.items[0].tier, "Plata");
          const dashboard = await (await call("/dashboard?range=month", "r1")).json();
          assert.equal(dashboard.total, 1900);
          assert.equal(dashboard.active, 1);
          assert.equal(dashboard.customerTotal, 1);
          assert.equal(dashboard.outlook.buyers28, 1);
          assert.equal(dashboard.outlook.repeatBuyers28, 0);
          assert.equal(dashboard.outlook.revenue7, null);
          assert.equal(dashboard.outlook.buyers30, null);
          const insight = await (await call("/customers/customer/insights", "r1")).json();
          assert.equal(insight.purchases, 1);
          assert.equal(insight.averageTicket, 1900);
          assert.equal(insight.favoriteProduct.name, "p1");
          assert.equal(insight.nextExpectedDate, null);
          // r1 sold p1 (Interior QA) and r2 sold p2 (Exterior QA) to this member, one purchase each: ties go to the name.
          const [interior, exterior] = await Promise.all(["Interior QA", "Exterior QA"].map((name) =>
            db.productCategory.create({ data: { name, key: name.toLowerCase() } })));
          await db.product.update({ where: { id: "p1" }, data: { categoryId: interior.id } });
          await db.product.update({ where: { id: "p2" }, data: { categoryId: exterior.id } });
          try {
            const favorites = async (query: string, user: string) => {
              const read = await (await call(`/customers/customer/insights${query}`, user)).json();
              return [read.favoriteCategory, read.favoriteProduct?.name];
            };
            assert.deepEqual(await favorites("", "r1"), [{ name: "Interior QA", purchases: 1, variety: "p1" }, "p1"]);
            assert.deepEqual(await favorites("?owner=r2", "owner"), [{ name: "Exterior QA", purchases: 1, variety: "p2" }, "p2"]);
            // Club-wide the favorite product is p1, but the variety shown comes from inside the favorite category.
            assert.deepEqual(await favorites("", "owner"), [{ name: "Exterior QA", purchases: 1, variety: "p2" }, "p1"]);
          } finally {
            await db.product.updateMany({ where: { id: { in: ["p1", "p2"] } }, data: { categoryId: null } });
            await db.productCategory.deleteMany({ where: { id: { in: [interior.id, exterior.id] } } });
          }
          const otherScopeInsight = await (await call("/customers/customer/insights?owner=r2", "owner")).json();
          const otherScopeHistory = await (await call("/customers/customer/history?owner=r2", "owner")).json();
          assert.equal(otherScopeInsight.purchases, otherScopeHistory.total);
          assert.equal(otherScopeInsight.averageTicket, Math.round(otherScopeHistory.items.reduce((sum: number, sale: { total: number }) => sum + sale.total, 0) / otherScopeHistory.total));
          assert.equal((await call("/list/customers?segment=permits", "r1")).status, 403);
          await db.customer.create({ data: { id: "other-insight", name: "Otro socio", email: "", phone: "", permitStatus: "pending" } });
          try {
            assert.equal((await call("/customers/other-insight/insights", "r1")).status, 404);
            const emptyInsight = await (await call("/customers/other-insight/insights", "owner")).json();
            assert.equal(emptyInsight.purchases, 0);
            const emptyScoped = await (await call("/customers/other-insight/insights?owner=r2", "owner")).json();
            assert.equal(emptyScoped.purchases, 0);
            const ownerDashboard = await (await call("/dashboard", "owner")).json();
            assert.equal(ownerDashboard.permitsToReview, 1);
            const permits = await (await call("/list/customers?segment=permits", "owner")).json();
            assert.equal(permits.total, 1);
            assert.equal(permits.items[0].id, "other-insight");
          } finally {
            await db.customer.delete({ where: { id: "other-insight" } });
          }
          const ledger=await(await call('/movements?owner=r2','r1')).json();
          assert(ledger.items.every((m:{fromOwner:string;toOwner:string})=>m.fromOwner==='r1'||m.toOwner==='r1'));
          const cashier = await (await call("/views/dashboard", "cashier")).json();
          assert(cashier.products.every((p: { cost: number }) => p.cost === 0));
          assert.equal("sales" in cashier, false);
          assert.equal("expenses" in cashier, false);
        },
      );
      await t.test(
        "CSV validation is non-mutating; duplicate lots reject entire import",
        async () => {
          const csv =
            "name,strain,type,unit,lot,stock,minimum,cost,price,location,ownerId,sourceSystem,sourceId\nNuevo,Híbrida,Flor,g,nuevo,10,2,4,10,A,r1,appsheet,lote-nuevo\nDuplicado,Híbrida,Flor,g,p1,10,2,4,10,A,r1,appsheet,lote-duplicado";
          const preview = await (
            await call("/import", "owner", { kind: "products", csv })
          ).json();
          assert.equal(preview.errors.length, 1);
          assert.equal(
            (
              await call("/import", "owner", {
                kind: "products",
                csv,
                commit: true,
              })
            ).status,
            400,
          );
          assert.equal(await db.product.count(), 2);
          const productCsv = "name,strain,type,unit,lot,supplier,stock,minimum,cost,price,location,ownerId,expires,sourceSystem,sourceId\nImportado,Test,Flor,g,import-supplier-1,Cooperativa Oeste,2,1,4.50,10.00,Depósito importado,r1,,appsheet,lote-supplier-1";
          const productPreview = await (await call("/import", "owner", { kind: "products", csv: productCsv })).json();
          assert.equal(productPreview.count, 1);
          assert.equal(await db.supplier.count({ where: { key: "cooperativa oeste" } }), 0);
          assert.equal(await db.location.count({ where: { key: "depósito importado" } }), 0);
          assert.equal((await call("/import", "owner", { kind: "products", csv: productCsv, commit: true })).status, 200);
          const imported = await db.product.findUniqueOrThrow({ where: { lot: "import-supplier-1" } });
          assert.equal(imported.supplierId, (await db.supplier.findUniqueOrThrow({ where: { key: "cooperativa oeste" } })).id);
          assert.equal(imported.locationId, (await db.location.findUniqueOrThrow({ where: { key: "depósito importado" } })).id);
          const repeatedProduct = await (await call("/import", "owner", { kind: "products", csv: productCsv, commit: true })).json();
          assert.equal(await db.location.count({ where: { key: "depósito importado" } }), 1);
          assert.equal(repeatedProduct.count, 0);
          assert.equal(repeatedProduct.skipped, 1);
          await db.movement.deleteMany({ where: { productId: imported.id } });
          await db.product.delete({ where: { id: imported.id } });
          const valid =
            "name,email,phone,notes,sourceSystem,sourceId\nNuevo socio,nuevo@example.com,,Migrado,appsheet,contacto-1";
          assert.equal(
            (
              await call("/import", "owner", {
                kind: "customers",
                csv: valid,
                commit: true,
              })
            ).status,
            200,
          );
          assert.equal(await db.customer.count(), 2);
          const repeated = await (await call("/import", "owner", { kind: "customers", csv: valid, commit: true })).json();
          assert.equal(repeated.count, 0);
          assert.equal(repeated.skipped, 1);
          assert.equal(await db.customer.count(), 2);
        },
      );
      await t.test("permit verification is restricted and finance entries are idempotent", async () => {
        assert.equal((await call("/customers/customer/permit", "cashier", { status: "verified", validUntil: "2027-01-01" }, "PATCH")).status, 403);
        assert.equal((await call("/customers/customer/permit", "owner", { status: "verified", validUntil: "2027-01-01" }, "PATCH")).status, 200);
        const cashier = await (await call("/views/dashboard", "cashier")).json();
        assert.equal((await (await call("/list/customers", "cashier")).json()).items.find((c: {id: string}) => c.id === "customer").permitStatus, "verified");
        const responsible = await (await call("/list/customers", "r1")).json();
        assert.equal(responsible.items.find((c: {id: string}) => c.id === "customer").permitStatus, "unverified");
        const viewer = await (await call("/list/customers", "viewer")).json();
        const masked = viewer.items.find((c: {id: string}) => c.id === "customer");
        assert.equal(masked.permitStatus, "unverified");
        assert.equal(masked.email, "");
        assert.equal(masked.notes, "");
        const date = cashier.today;
        const entry = { date, account: "bank", category: "owner_draw", amount: -50000, description: "Retiro de prueba", sourceSystem: "sheet", sourceId: "row-1" };
        assert.equal((await call("/cash-entries", "cashier", entry)).status, 403);
        assert.equal((await call("/cash-entries", "owner", entry)).status, 201);
        assert.equal((await call("/cash-entries", "owner", entry)).status, 201);
        assert.equal(await db.cashEntry.count({ where: { sourceSystem: "sheet", sourceId: "row-1" } }), 1);
        assert.equal((await call("/cash-entries", "owner", { ...entry, amount: -60000 })).status, 409);
        assert.equal((await call("/cash-plans", "owner", { date: "2027-01-10", account: "bank", category: "operating_expense", amount: -300000, description: "Personal", scenario: "base" })).status, 201);
        const csv = `date,account,category,amount,description,sourceSystem,sourceId\n${date},bank,delivery_receipt,123.45,Cobro delivery,appsheet,cobro-1`;
        const preview = await (await call("/import", "owner", { kind: "cash_entries", csv })).json();
        assert.equal(preview.count, 1);
        assert.equal(await db.cashEntry.count({ where: { sourceSystem: "appsheet" } }), 0);
        assert.equal((await call("/import", "owner", { kind: "cash_entries", csv, commit: true })).status, 200);
        const repeated = await (await call("/import", "owner", { kind: "cash_entries", csv, commit: true })).json();
        assert.equal(repeated.count, 0);
        assert.equal(repeated.skipped, 1);
        assert.equal(await db.cashEntry.count({ where: { sourceSystem: "appsheet" } }), 1);
        assert.equal((await call("/import", "owner", { kind: "cash_entries", csv: csv.replace("123.45", "124.45"), commit: true })).status, 400);
      });
      await t.test('expired lots, invalid point redemption and changing units cannot mutate stock',async()=>{
        const before=await db.product.findUniqueOrThrow({where:{id:'p2'}});
        const sale={requestId:randomUUID(),customerId:'customer',payment:'cash',items:[{productId:'p2',quantity:1000}]};
        assert.equal((await call('/sales','owner',{...sale,points:999999})).status,400);
        await db.product.update({where:{id:'p2'},data:{expires:'2000-01-01'}});
        assert.equal((await call('/sales','owner',sale)).status,409);
        assert.equal((await call('/products/p2','owner',{...before,unit:'ud'},'PATCH')).status,400);
        assert.equal((await db.product.findUniqueOrThrow({where:{id:'p2'}})).stock,before.stock);
        await db.product.update({where:{id:'p2'},data:{expires:null}});
      });
      await t.test("PDF, XLSX and CSV exports contain real data", async () => {
        for (const [format, signature] of [
          ["pdf", "%PDF"],
          ["xlsx", "PK"],
          ["csv", "Fecha"],
        ] as const) {
          const res = await call(`/reports/${format}`);
          assert.equal(res.status, 200);
          const data = Buffer.from(await res.arrayBuffer());
          if (format === "csv") assert(data.toString().includes(signature));
          else
            assert.equal(
              data.subarray(0, signature.length).toString(),
              signature,
            );
        }
      });
      await t.test("mixed payment books each part in its own account and is idempotent", async () => {
        // "customer" has spent 8.900 (Plata, 3 % off), so 1 g of p1 at 1.000 totals 970.
        const payload = { requestId: randomUUID(), customerId: "customer", payment: "mixed",
          split: { cash: 300, other: "transfer" }, items: [{ productId: "p1", quantity: 1000 }] };
        const sales = await db.sale.count();
        for (const invalid of [{ ...payload, split: undefined }, { ...payload, payment: "cash" }, { ...payload, split: { cash: 970, other: "transfer" } }])
          assert.equal((await call("/sales", "owner", invalid)).status, 400);
        assert.equal(await db.sale.count(), sales);
        const res = await call("/sales", "owner", payload);
        assert.equal(res.status, 201, await res.clone().text());
        const sale = await res.json();
        assert.equal(sale.total, 970);
        assert.deepEqual(sale.paymentSplit, [{ method: "cash", amount: 300 }, { method: "transfer", amount: 670 }]);
        const entries = async () => (await db.cashEntry.findMany({ where: { saleId: sale.id }, orderBy: { account: "asc" } }))
          .map(({ account, amount }) => [account, amount]);
        assert.deepEqual(await entries(), [["bank", 670], ["cash", 300]]);
        const retry = await call("/sales", "owner", payload);
        assert.equal(retry.status, 201);
        assert.equal((await retry.json()).id, sale.id);
        assert.equal(await db.sale.count(), sales + 1);
        assert.deepEqual(await entries(), [["bank", 670], ["cash", 300]]);
        // The drawer expects the 1.900 cash sale plus only the cash part of this one.
        assert.equal((await (await call("/views/sales", "cashier")).json()).cashExpected, 2200);
      });
      await t.test(
        "recurring expenses generate once, then cash close prevents further sales",
        async () => {
          assert.equal(
            (
              await call("/expenses", "owner", {
                name: "Recurrente",
                amount: 1000,
                category: "Otros",
                kind: "fixed",
                ownerId: null,
                date: "2026-09-01",
                recurrence: "monthly",
              })
            ).status,
            201,
          );
          await call("/expenses/recurring", "owner", {});
          const n = await db.expense.count();
          await call("/expenses/recurring", "owner", {});
          assert.equal(await db.expense.count(), n);
          // Cash sale 1.900 plus the 300 cash part of the mixed sale; its transfer part is not in the drawer.
          const close = await call("/closures", "cashier", {
            counted: 2200,
            note: "Conciliado",
          });
          assert.equal(close.status, 201);
          assert.equal((await close.json()).difference, 0);
          assert.equal(
            (
              await call("/sales", "owner", {
                requestId: randomUUID(),
                customerId: "customer",
                payment: "cash",
                items: [{ productId: "p2", quantity: 1000 }],
              })
            ).status,
            409,
          );
          assert.equal(
            (await call("/closures", "owner", { counted: 1900, note: "" }))
              .status,
            409,
          );
        },
      );
      await t.test("bounded pages are stable and checkout reads keep role gates", async () => {
        await db.customer.createMany({ data: Array.from({ length: 61 }, (_, i) => ({
          id: `paged-c-${i}`, name: `Paginado ${String(i).padStart(3, "0")}`, email: "", phone: "",
        })) });
        await db.product.createMany({ data: Array.from({ length: 61 }, (_, i) => ({
          id: `paged-p-${i}`, name: `Paginado ${String(i).padStart(3, "0")}`, strain: "Test", type: "Flor",
          lot: `paged-${i}`, stock: 1000, minimum: 500, cost: 100, price: 200,
          location: "A", ownerId: "r1",
        })) });
        await db.sale.createMany({ data: Array.from({ length: 61 }, (_, i) => ({
          id: `paged-s-${i}`, customerId: `paged-c-${i}`, userId: "owner", date: "2026-01-01",
          subtotal: 100, discount: 0, total: 100, cost: 50, pointsEarned: 0, pointsUsed: 0,
          payment: "cash", requestId: `paged-request-${i}`,
        })) });
        for (const path of ["/list/customers?q=Paginado", "/list/customers?q=Paginado&segment=top", "/list/products?q=Paginado", "/list/sales?date=2026-01-01"]) {
          const first = await (await call(path)).json();
          assert.equal(first.items.length, 50);
          assert(first.nextCursor);
          const second = await (await call(`${path}&cursor=${encodeURIComponent(first.nextCursor)}`)).json();
          assert.equal(second.items.length, 11);
          assert.equal(second.nextCursor, null);
          assert.equal(new Set([...first.items, ...second.items].map((x: { id: string }) => x.id)).size, 61);
        }
        assert.equal((await call("/checkout/customers?q=cliente", "viewer")).status, 403);
        assert.equal((await call("/checkout/products", "viewer")).status, 403);
        const scoped = await (await call("/list/products?q=Paginado&owner=r2", "r1")).json();
        assert.equal(scoped.total, 61);
        assert(scoped.items.every((p: { ownerId: string }) => p.ownerId === "r1"));
      });
      await t.test("financial aggregates and ledger pages preserve totals and roles", async () => {
        const finance = await (await call("/views/finance", "owner")).json();
        const monthStart = `${finance.today.slice(0, 7)}-01`;
        const saleTotals = await db.sale.aggregate({ where: { date: { gte: monthStart, lte: finance.today } },
          _sum: { total: true, cost: true } });
        assert.equal(finance.periodRevenue, saleTotals._sum.total || 0);
        assert.equal(finance.periodCost, saleTotals._sum.cost || 0);
        assert.equal("sales" in finance, false);
        const responsible = await (await call("/views/responsibles", "owner")).json();
        const itemTotals = await db.saleItem.aggregate({ where: { sale: { date: { gte: monthStart, lte: finance.today } } },
          _sum: { revenue: true, cost: true } });
        assert.equal(responsible.responsibleRows.reduce((sum: number, row: { revenue: number }) => sum + row.revenue, 0), itemTotals._sum.revenue || 0);
        assert.equal(responsible.responsibleRows.reduce((sum: number, row: { cost: number }) => sum + row.cost, 0), itemTotals._sum.cost || 0);
        await db.expense.createMany({ data: Array.from({ length: 61 }, (_, i) => ({
          id: `paged-e-${i}`, name: `Paged expense ${i}`, amount: 100, category: "Test", kind: "variable",
          date: finance.today, ownerId: "r1",
        })) });
        await db.cashEntry.createMany({ data: Array.from({ length: 61 }, (_, i) => ({
          id: `paged-cash-${i}`, date: finance.today, account: "bank", category: "adjustment",
          amount: 100, description: `Paged entry ${i}`, userId: "owner",
        })) });
        const expenses = await (await call(`/list/expenses?month=${finance.today.slice(0, 7)}&q=Paged`, "owner")).json();
        assert.equal(expenses.items.length, 50);
        const expensesNext = await (await call(`/list/expenses?month=${finance.today.slice(0, 7)}&q=Paged&cursor=${encodeURIComponent(expenses.nextCursor)}`, "owner")).json();
        assert.equal(expensesNext.items.length, 11);
        assert.equal(expenses.summary.total, (await db.expense.aggregate({ where: { date: { startsWith: finance.today.slice(0, 7) } }, _sum: { amount: true } }))._sum.amount);
        const ledger = await (await call("/list/cash-entries", "owner")).json();
        assert.equal(ledger.items.length, 50);
        const ledgerNext = await (await call(`/list/cash-entries?cursor=${encodeURIComponent(ledger.nextCursor)}`, "owner")).json();
        assert(new Set([...ledger.items, ...ledgerNext.items].map((row: { id: string }) => row.id)).size > 50);
        assert.equal((await call("/list/cash-entries", "cashier")).status, 403);
        assert.equal((await call(`/list/expenses?month=${finance.today.slice(0, 7)}`, "cashier")).status, 200);
        assert.equal((await (await call(`/list/expenses?month=${finance.today.slice(0, 7)}`, "cashier")).json()).items.length, 0);
      });
      await t.test("break-even adds local sales and this month's fixed costs, counting rule dates once", async () => {
        const audits = () => db.sensitiveAccessAudit.count({ where: { area: "finance", action: "break_even" } });
        const audited = await audits();
        for (const role of ["cashier", "viewer", "r1"] as const)
          assert.equal((await call("/finance/break-even", role)).status, 403);
        const read = async () => {
          const res = await call("/finance/break-even", "owner");
          assert.equal(res.status, 200, await res.clone().text());
          return res.json();
        };
        const before = await read();
        assert.equal(await audits(), audited + 1);
        assert.equal((await call("/finance/break-even", "admin")).status, 200);
        const { today } = await (await call("/views/dashboard")).json();
        const shift = (date: string, days: number) => {
          const value = new Date(`${date}T12:00:00Z`);
          value.setUTCDate(value.getUTCDate() + days);
          return value.toISOString().slice(0, 10);
        };
        const sale = { customerId: "customer", userId: "owner", date: today, discount: 0, pointsEarned: 0, pointsUsed: 0, payment: "cash" };
        await db.sale.createMany({ data: [
          { ...sale, subtotal: 50000, total: 50000, cost: 20000, requestId: randomUUID(), channel: "local" },
          // Delivery stays in AppSheet: an imported delivery sale must not move the local break-even.
          { ...sale, subtotal: 90000, total: 90000, cost: 30000, requestId: randomUUID(), channel: "delivery" },
        ] });
        await db.expense.createMany({ data: [
          { name: "Alquiler", amount: 70000, category: "Alquiler", kind: "fixed", date: before.monthEnd },
          { name: "Alquiler anterior", amount: 99999, category: "Alquiler", kind: "fixed", date: shift(before.monthStart, -1) },
          { name: "Bolsas", amount: 4000, category: "Insumos", kind: "variable", date: today },
        ] });
        // Both rules start four weeks before the 1st: their pending dates run from before the month through the 1st.
        for (const [name, kind, amount] of [["Limpieza", "fixed", 1000], ["Envases", "variable", 500]] as const) {
          const created = await call("/expenses", "owner", { name, amount, category: name, kind, ownerId: null,
            date: shift(before.monthStart, -28), recurrence: "weekly" });
          assert.equal(created.status, 201, await created.clone().text());
        }
        // Weekly dates from the 1st up to day n of the month.
        const weekly = (n: number) => Math.floor((n - 1) / 7) + 1;
        const after = await read();
        assert.equal(after.revenue - before.revenue, 50000);
        assert.equal(after.cost - before.cost, 20000);
        assert.equal(after.variable - before.variable, 4000);
        // The variable rule takes the kind of its first expense, so only the fixed rule adds its dates in the month.
        assert.equal(after.fixedTotal - before.fixedTotal, 70000 + 1000 * weekly(before.daysInMonth));
        assert.equal((await call("/expenses/recurring", "owner", {})).status, 200);
        const materialized = await read();
        assert.equal(materialized.fixedTotal, after.fixedTotal);
        assert.equal(materialized.variable - after.variable, 500 * weekly(before.daysElapsed));
      });
      await t.test("cash ledger filters rows and keeps each account's running balance", async () => {
        // The oldest movements in the ledger, so every balance below comes from these rows alone.
        await db.cashEntry.createMany({ data: [
          { date: "2026-01-02", account: "cash", category: "opening_balance", amount: 10000, description: "Ledger apertura", userId: "owner" },
          { date: "2026-01-03", account: "cash", category: "operating_expense", amount: -2500, description: "Ledger limpieza", userId: "owner" },
          { date: "2026-01-04", account: "bank", category: "stock_purchase", amount: -8000, description: "Ledger compra", userId: "owner" },
          { date: "2026-01-05", account: "bank", category: "other_income", amount: 4000, description: "Ledger cobro", userId: "owner" },
        ] });
        assert.equal((await call("/list/cash-entries?account=cash", "admin")).status, 200);
        const ledger = async (query: string) => {
          const res = await call(`/list/cash-entries?${query}`);
          assert.equal(res.status, 200, await res.clone().text());
          return res.json();
        };
        const rows = (page: { items: Array<{ description: string; balanceAfter: number }> }) =>
          page.items.map((entry) => [entry.description, entry.balanceAfter]);
        // A filtered row still shows its account's balance: the 10.000 opening came before the 2.500 expense.
        assert.deepEqual(rows(await ledger("q=LIMPIEZA")), [["Ledger limpieza", 7500]]);
        assert.deepEqual(rows(await ledger("category=stock_purchase")), [["Ledger compra", -8000]]);
        assert.deepEqual(rows(await ledger("account=bank&from=2026-01-04&to=2026-01-05")), [["Ledger cobro", -4000], ["Ledger compra", -8000]]);
        assert.deepEqual(rows(await ledger("account=cash&direction=in&to=2026-01-31")), [["Ledger apertura", 10000]]);
        const outflows = await ledger("direction=out&to=2026-01-31");
        assert.deepEqual(rows(outflows), [["Ledger compra", -8000], ["Ledger limpieza", 7500]]);
        assert.equal(outflows.total, 2);
        assert.deepEqual([outflows.summary.inflow, outflows.summary.outflow, outflows.summary.net], [0, 10500, -10500]);
        // Across pages, each bank row carries the running sum of the bank ledger in (date, createdAt, id) order.
        const bank = await db.cashEntry.findMany({ where: { account: "bank" }, orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }] });
        let running = 0;
        const expected = bank.map((entry) => [entry.id, (running += entry.amount)]).reverse();
        const first = await ledger("account=bank");
        assert(first.nextCursor);
        const second = await ledger(`account=bank&cursor=${encodeURIComponent(first.nextCursor)}`);
        assert.equal(second.nextCursor, null);
        assert.deepEqual([...first.items, ...second.items].map((entry: { id: string; balanceAfter: number }) => [entry.id, entry.balanceAfter]), expected);
        assert.equal(first.total, bank.length);
        assert.equal(first.summary.bankBalance, running);
        assert.equal(first.summary.bankCount, bank.length);
        const cash = await db.cashEntry.aggregate({ where: { account: "cash" }, _sum: { amount: true }, _count: true });
        assert.equal(first.summary.cashBalance, cash._sum.amount);
        assert.equal(first.summary.cashCount, cash._count);
      });
      await t.test("upcoming payments bring the base plan, active obligations, future expenses and unregistered rule dates", async () => {
        for (const role of ["cashier", "viewer", "r1"] as const)
          assert.equal((await call("/finance/upcoming-payments", role)).status, 403);
        const audits = () => db.sensitiveAccessAudit.count({ where: { area: "finance", action: "upcoming_payments" } });
        const audited = await audits();
        assert.equal((await call("/finance/upcoming-payments", "admin")).status, 200);
        assert.equal(await audits(), audited + 1);
        const { today } = await (await call("/views/dashboard")).json();
        const shift = (days: number) => {
          const value = new Date(`${today}T12:00:00Z`);
          value.setUTCDate(value.getUTCDate() + days);
          return value.toISOString().slice(0, 10);
        };
        const created = async (res: Response) => {
          assert.equal(res.status, 201, await res.clone().text());
          return res.json();
        };
        for (const scenario of ["base", "cautious"])
          await created(await call("/cash-plans", "owner", { scenario, date: shift(3), account: "bank", category: "stock_purchase",
            amount: -12345, description: `Upcoming QA plan ${scenario}` }));
        await created(await call("/cash-plans", "owner", { scenario: "base", date: shift(4), account: "bank", category: "other_income",
          amount: 5000, description: "Upcoming QA income" }));
        const obligations = [];
        for (const sourceReference of ["Upcoming QA obligation", "Upcoming QA cancelled"])
          obligations.push(await created(await call("/decision-inputs/cash-plans", "owner", { scenario: "base", date: shift(5),
            account: "banco", category: "operating_expense", amountCents: "-67890", sourceReference })));
        assert.equal((await call(`/decision-inputs/cash-plans/${obligations[1].id}`, "owner", { status: "cancelled" }, "PATCH")).status, 200);
        await created(await call("/expenses", "owner", { name: "Upcoming QA expense", amount: 4321, category: "Servicios", kind: "fixed",
          ownerId: null, date: shift(2), recurrence: "none" }));
        await db.recurringRule.create({ data: { name: "Upcoming QA rule", amount: 1000, category: "QA", recurrence: "weekly", nextDate: shift(-3) } });
        // A movement dated ahead is not in the balance yet.
        await db.cashEntry.create({ data: { date: shift(1), account: "bank", category: "other_outflow", amount: -777,
          description: "Upcoming QA dated ahead", userId: "owner" } });
        const res = await call("/finance/upcoming-payments");
        assert.equal(res.status, 200, await res.clone().text());
        const upcoming = await res.json();
        const mine = upcoming.items.filter((item: { label: string }) => item.label.startsWith("Upcoming QA"))
          .map((item: { label: string; date: string; source: string; amount: number; overdue: boolean }) =>
            [item.label, item.date, item.source, item.amount, item.overdue]);
        // The cautious plan, the income and the cancelled obligation stay out. The weekly rule missed three days ago
        // keeps that date as overdue and brings its next four inside the 30 days.
        assert.deepEqual(mine, [
          ["Upcoming QA rule", shift(-3), "recurring", 1000, true],
          ["Upcoming QA expense", shift(2), "expense", 4321, false],
          ["Upcoming QA plan base", shift(3), "plan", 12345, false],
          ["Upcoming QA rule", shift(4), "recurring", 1000, false],
          ["Upcoming QA obligation", shift(5), "obligation", 67890, false],
          ["Upcoming QA rule", shift(11), "recurring", 1000, false],
          ["Upcoming QA rule", shift(18), "recurring", 1000, false],
          ["Upcoming QA rule", shift(25), "recurring", 1000, false],
        ]);
        const ledger = await db.cashEntry.aggregate({ where: { date: { lte: today } }, _sum: { amount: true } });
        assert.equal(upcoming.balance, ledger._sum.amount);
      });
      await t.test("categories count distinct sellable varieties and alert managers below the minimum", async () => {
        for (const role of ["cashier", "r1"] as const)
          assert.equal((await call("/categories", role, { name: "Sin permiso", minVarieties: 1 })).status, 403);
        const created = await call("/categories", "admin", { name: "  Interior   Premium ", minVarieties: 2 });
        assert.equal(created.status, 201, await created.clone().text());
        const category = await created.json();
        assert.equal(category.name, "Interior Premium");
        assert.equal((await call("/categories", "owner", { name: "interior premium" })).status, 409);
        // The manager's edit sets the minimum of 3 that the alert below reports.
        assert.equal((await call(`/categories/${category.id}`, "admin", { name: category.name, minVarieties: 3 }, "PATCH")).status, 200);
        const { today } = await (await call("/views/dashboard")).json();
        const base = { strain: "", type: "Flor", unit: "g", minimum: 0, cost: 400, price: 1000, location: "A", categoryId: category.id };
        // One variety in two lots of different owners, one that expires today (still sellable), one without stock and one expired.
        for (const [name, code, stock, ownerId] of [["Gelato", "cat-1", 1000, "r1"], [" gelato ", "cat-2", 2000, "r2"],
          ["Mimosa", "cat-3", 1000, "r1"], ["Runtz", "cat-4", 0, "r1"], ["Zkittlez", "cat-5", 1000, "r1"]] as const) {
          const res = await call("/products", "owner", { ...base, name, lot: code, stock, ownerId });
          assert.equal(res.status, 201, await res.clone().text());
        }
        await db.product.update({ where: { lot: "cat-3" }, data: { expires: today } });
        await db.product.update({ where: { lot: "cat-5" }, data: { expires: "2000-01-01" } });
        const coverage = async (role: "owner" | "r1") =>
          (await (await call("/categories", role)).json()).items.find((item: { id: string }) => item.id === category.id);
        const owned = await coverage("owner");
        assert.equal(owned.varieties, 2);
        assert.deepEqual(owned.varietyNames.map((name: string) => name.toLowerCase()).sort(), ["gelato", "mimosa"]);
        assert.equal(owned.lotCount, 5);
        // The stock of the same lots: both Gelato lots and Mimosa, not the empty or the expired one.
        assert.deepEqual(owned.stock, [{ unit: "g", milliunits: 4000 }]);
        assert.deepEqual(Object.keys(await coverage("r1")).sort(), ["active", "id", "name"]);
        const alerts = async (role: "owner" | "cashier" | "r1") => (await (await call("/views/dashboard", role)).json()).categoryAlerts;
        assert.deepEqual(await alerts("owner"), [{ id: category.id, name: "Interior Premium", minVarieties: 3, varieties: 2 }]);
        assert.deepEqual(await alerts("cashier"), []);
        assert.deepEqual(await alerts("r1"), []);
        const listed = await (await call(`/list/products?category=${category.id}`)).json();
        assert.equal(listed.total, 5);
        assert(listed.items.every((product: { category: string }) => product.category === "Interior Premium"));
        const unassigned = await (await call("/list/products?category=unassigned")).json();
        assert.equal(unassigned.total, await db.product.count({ where: { categoryId: null } }));
        assert(unassigned.items.every((product: { categoryId: string | null }) => product.categoryId === null));
        assert.equal((await call(`/categories/${category.id}/status`, "admin", { active: false }, "PATCH")).status, 200);
        assert.deepEqual(await alerts("owner"), []);
        assert.equal((await call("/products", "owner", { ...base, name: "Nuevo", lot: "cat-6", stock: 1000, ownerId: "r1" })).status, 400);
        // An edited lot keeps its archived category, and an edit that leaves the field out does not clear it.
        const gelato = await db.product.findUniqueOrThrow({ where: { lot: "cat-1" } });
        assert.equal((await call(`/products/${gelato.id}`, "owner", { ...gelato, minimum: 500 }, "PATCH")).status, 200);
        assert.equal((await call(`/products/${gelato.id}`, "owner", { ...gelato, minimum: 600, categoryId: undefined }, "PATCH")).status, 200);
        const edited = await db.product.findUniqueOrThrow({ where: { lot: "cat-1" } });
        assert.deepEqual([edited.minimum, edited.categoryId], [600, category.id]);
      });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await db.$disconnect();
    }
  },
);
