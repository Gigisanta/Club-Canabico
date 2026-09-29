// Synthetic, removable local preview for Tiziano's real account. Never use on a remote DB.
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";

const env = dotenv.parse(readFileSync(new URL("../.local/real-club.env", import.meta.url)));
const url = new URL(env.DATABASE_URL);
if (!(["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname === "/bombo_real" && env.DEMO_MODE === "false"))
  throw new Error("La vista de prueba solo puede cargarse en la base real local con DEMO_MODE=false.");
const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const prefix = "tiziano-preview-20260929";
const sourceSystem = "bombo_preview_tiziano";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const ago = (days) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - days); return d.toISOString().slice(0, 10); };
const products = [
  ["Amnesia Haze", "Sativa", "Flor", 96, 30, 380, 1000],
  ["Gorilla Glue", "Híbrida", "Flor", 78, 25, 420, 1200],
  ["Purple Punch", "Índica", "Flor", 62, 25, 450, 1300],
  ["Lemon Haze", "Sativa", "Flor", 12, 30, 360, 1000],
  ["CBD Balance", "CBD", "Flor", 54, 20, 280, 800],
  ["Rosin Premium", "Híbrida", "Extracto", 7, 10, 1600, 3500],
];
const names = ["Mateo Álvarez", "Valentina Costa", "Nicolás Romero", "Julieta Ríos", "Santiago Méndez", "Florencia Silva", "Joaquín Díaz", "Agustina Vega", "Bruno Sosa", "Clara Ortiz"];

try {
  const counts = await Promise.all(["product", "customer", "sale", "saleItem", "movement", "expense", "cashEntry", "closure", "historicalImportBatch"].map((model) => db[model].count()));
  if (counts.some(Boolean)) throw new Error(`La base ya tiene registros operativos (${counts.join(",")}); se canceló para evitar mezclas o duplicados.`);
  const owner = await db.user.findUnique({ where: { id: "tiziano" }, select: { role: true } });
  if (owner?.role !== "owner") throw new Error("No existe la cuenta owner de Tiziano.");
  await db.$transaction(async (tx) => {
    for (const [i, name] of names.entries()) await tx.customer.create({ data: {
      id: `${prefix}-c${i + 1}`, name, email: `socio${i + 1}@example.invalid`, phone: "", notes: "DATO DE PRUEBA · socio ficticio",
      sourceSystem, sourceId: `c${i + 1}`, createdAt: new Date(`${ago(90)}T10:00:00Z`),
    } });
    for (const [i, p] of products.entries()) await tx.product.create({ data: {
      id: `${prefix}-p${i + 1}`, name: p[0], strain: p[1], type: p[2], unit: "g", lot: `MUESTRA-26-${String(i + 1).padStart(3, "0")}`,
      stock: p[3] * 1000, minimum: p[4] * 1000, cost: p[5] * 1000, price: p[6] * 1000,
      location: "Depósito · muestra", ownerId: "tiziano", sourceSystem, sourceId: `p${i + 1}`,
      createdAt: new Date(`${ago(40)}T09:00:00Z`),
    } });
    const soldByProduct = Array(products.length).fill(0);
    for (let day = 29, seq = 1; day >= 0; day--) for (let n = 0; n < 2 + (day % 2); n++, seq++) {
      const pi = (day * 3 + n * 2) % products.length;
      const p = products[pi]; const quantity = (2 + seq % 3) * 1000;
      const total = quantity * p[6]; const cost = quantity * p[5]; const date = ago(day);
      const id = `${prefix}-v${seq}`; const payment = n % 3 === 0 ? "cash" : "card";
      const createdAt = new Date(`${date}T${String(11 + n).padStart(2, "0")}:30:00Z`);
      await tx.sale.create({ data: {
        id, customerId: `${prefix}-c${(seq % names.length) + 1}`, userId: "tiziano", date, createdAt,
        subtotal: total, discount: 0, total, cost, pointsEarned: Math.floor(total / 1000000), pointsUsed: 0,
        payment, requestId: id, channel: "local",
        items: { create: { productId: `${prefix}-p${pi + 1}`, ownerId: "tiziano", name: p[0], unit: "g", quantity, price: p[6] * 1000, cost, revenue: total } },
      } });
      await tx.cashEntry.create({ data: { date, account: payment === "cash" ? "cash" : "bank", category: "sale", amount: total,
        description: `DATO DE PRUEBA · ${id}`, sourceSystem, sourceId: id, saleId: id, userId: "tiziano", createdAt } });
      soldByProduct[pi] += quantity;
    }
    for (const [i, p] of products.entries()) await tx.movement.create({ data: {
      productId: `${prefix}-p${i + 1}`, type: "entry", quantity: p[3] * 1000 + soldByProduct[i], beforeStock: 0,
      afterStock: p[3] * 1000 + soldByProduct[i], toOwner: "tiziano", userId: "tiziano",
      note: "DATO DE PRUEBA · stock inicial ficticio", createdAt: new Date(`${ago(40)}T09:00:00Z`),
    } });
    for (const [i, p] of products.entries()) {
      const items = await tx.saleItem.findMany({ where: { productId: `${prefix}-p${i + 1}` }, include: { sale: true }, orderBy: { sale: { createdAt: "asc" } } });
      let balance = p[3] * 1000 + soldByProduct[i];
      for (const item of items) {
        await tx.movement.create({ data: { productId: item.productId, type: "sale", quantity: -item.quantity,
          beforeStock: balance, afterStock: balance - item.quantity, fromOwner: "tiziano", toOwner: "tiziano",
          userId: "tiziano", note: `DATO DE PRUEBA · ${item.saleId}`, createdAt: item.sale.createdAt } });
        balance -= item.quantity;
      }
      if (balance !== p[3] * 1000) throw new Error("Saldo de prueba inconsistente.");
    }
    for (const [i, [name, amount, category, kind]] of [
      ["Alquiler del local", 60000, "Alquiler", "fixed"], ["Equipo y colaboradores", 55000, "Personal", "fixed"],
      ["Electricidad", 20000, "Servicios", "variable"], ["Insumos", 15000, "Insumos", "variable"],
    ].entries()) await tx.expense.create({ data: { name: `MUESTRA · ${name}`, amount: amount * 1000,
      category, kind, ownerId: "tiziano", date: `${today.slice(0, 7)}-${String(1 + i).padStart(2, "0")}`, recurrence: "none" } });
    const setting = await tx.setting.findUniqueOrThrow({ where: { id: 1 } });
    await tx.setting.update({ where: { id: 1 }, data: { value: { ...setting.value, clubName: "Bombo · DATOS DE PRUEBA", sampleData: true } } });
  }, { timeout: 120000 });
  console.log(JSON.stringify({ status: "loaded", date: today, customers: names.length, products: products.length, sales: 75, expenses: 4, marker: sourceSystem }));
} finally { await db.$disconnect(); }
