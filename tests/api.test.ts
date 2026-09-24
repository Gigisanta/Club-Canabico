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
          const productCsv = "name,strain,type,unit,lot,supplier,stock,minimum,cost,price,location,ownerId,expires,sourceSystem,sourceId\nImportado,Test,Flor,g,import-supplier-1,Cooperativa Oeste,2,1,4.50,10.00,A,r1,,appsheet,lote-supplier-1";
          const productPreview = await (await call("/import", "owner", { kind: "products", csv: productCsv })).json();
          assert.equal(productPreview.count, 1);
          assert.equal(await db.supplier.count({ where: { key: "cooperativa oeste" } }), 0);
          assert.equal((await call("/import", "owner", { kind: "products", csv: productCsv, commit: true })).status, 200);
          const imported = await db.product.findUniqueOrThrow({ where: { lot: "import-supplier-1" } });
          assert.equal(imported.supplierId, (await db.supplier.findUniqueOrThrow({ where: { key: "cooperativa oeste" } })).id);
          const repeatedProduct = await (await call("/import", "owner", { kind: "products", csv: productCsv, commit: true })).json();
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
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await db.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
      await db.$disconnect();
    }
  },
);
