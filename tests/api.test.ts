import "dotenv/config";
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { defaults } from "../shared/domain.js";
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
      for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean))await db.$executeRawUnsafe(statement);
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
        data: { id, name: id, email: `${id}@test.local`, role, password },
      });
    await db.setting.create({ data: { id: 1, value: { ...defaults,pointsEvery:1000,pointValue:10,silverAt:5000,goldAt:15000 } } });
    await db.customer.create({
      data: {
        id: "customer",
        name: "Cliente de prueba",
        email: "",
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
      await t.test("requires session and rejects foreign origins", async () => {
        assert.equal((await fetch(base + "/state")).status, 401);
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
      await t.test(
        "viewer cannot mutate; responsible cannot read or move another owner stock",
        async () => {
          assert.equal((await call("/products", "viewer", {})).status, 403);
          const state = await (await call("/state?owner=r2", "r1")).json();
          assert.deepEqual(
            state.products.map((p: { id: string }) => p.id),
            ["p1"],
          );
          assert.equal(state.users.length, 1);
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
          const state = await (await call("/state", "r1")).json();
          assert.equal(state.products.length, 0);
          assert.equal(state.sales.length, 1);
          assert.equal(state.sales[0].items[0].ownerId, "r1");
          assert.equal(state.customers[0].totalSpent,1900);
          assert.equal(state.customers[0].tier,'Plata');
          const ledger=await(await call('/movements?page=1&owner=r2','r1')).json();
          assert(ledger.rows.every((m:{fromOwner:string;toOwner:string})=>m.fromOwner==='r1'||m.toOwner==='r1'));
          const cashier = await (await call("/state", "cashier")).json();
          assert(cashier.products.every((p: { cost: number }) => p.cost === 0));
          assert(cashier.sales.every((s: { cost: number }) => s.cost === 0));
          assert.equal(cashier.expenses.length, 0);
        },
      );
      await t.test(
        "CSV validation is non-mutating; duplicate lots reject entire import",
        async () => {
          const csv =
            "name,strain,type,unit,lot,stock,minimum,cost,price,location,ownerId\nNuevo,Híbrida,Flor,g,nuevo,10,2,4,10,A,r1\nDuplicado,Híbrida,Flor,g,p1,10,2,4,10,A,r1";
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
          const valid =
            "name,email,phone,notes\nNuevo socio,nuevo@example.com,,Migrado";
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
        },
      );
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
          const close = await call("/closures", "cashier", {
            counted: 1900,
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
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await db.$disconnect();
    }
  },
);
