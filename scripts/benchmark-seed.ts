import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { businessDate, defaults } from "../shared/domain.js";

const url = process.env.BENCH_DATABASE_URL;
if (!url || new URL(url).pathname !== "/raiz_bench") {
  throw new Error("BENCH_DATABASE_URL debe apuntar a una base desechable llamada raiz_bench");
}
const db = new PrismaClient({ datasources: { db: { url } } });
const today = businessDate(defaults);
const offset = (days: number) => {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};
try {
  if (await db.user.count() || await db.sale.count()) throw new Error("La base de benchmark no está vacía");
  await db.user.create({ data: {
    id: "bench-owner", name: "Bench Owner", email: "bench@example.test",
    role: "owner", password: await bcrypt.hash("bench-only-password", 4),
  } });
  await db.setting.create({ data: { id: 1, value: defaults } });
  for (let start = 0; start < 5_000; start += 1_000) {
    await db.customer.createMany({ data: Array.from({ length: 1_000 }, (_, index) => {
      const id = start + index;
      return { id: `bench-c-${id}`, name: `Socio ${String(id).padStart(5, "0")}`,
        email: `socio${id}@example.test`, phone: "", createdAt: new Date(`${offset(id % 365)}T12:00:00Z`) };
    }) });
  }
  await db.product.createMany({ data: Array.from({ length: 500 }, (_, id) => ({
    id: `bench-p-${id}`, name: `Producto ${String(id).padStart(4, "0")}`, strain: "Prueba",
    type: "Flor", lot: `BENCH-${id}`, stock: 2_000_000, minimum: 1_000,
    cost: 400_000, price: 800_000, location: "Test", ownerId: "bench-owner",
  })) });
  for (let start = 0; start < 100_000; start += 1_000) {
    const sales = Array.from({ length: 1_000 }, (_, index) => {
      const id = start + index;
      const date = offset(id % 90);
      return { id: `bench-s-${String(id).padStart(6, "0")}`, customerId: `bench-c-${id % 5_000}`,
        userId: "bench-owner", date, createdAt: new Date(`${date}T12:00:00Z`),
        subtotal: 8_000, discount: 0, total: 8_000, cost: 4_000,
        pointsEarned: 0, pointsUsed: 0, payment: "cash", requestId: `bench-request-${id}` };
    });
    await db.sale.createMany({ data: sales });
    await db.saleItem.createMany({ data: sales.map((sale, index) => ({
      saleId: sale.id, productId: `bench-p-${(start + index) % 500}`, ownerId: "bench-owner",
      name: "Producto de prueba", quantity: 1_000, price: 8_000, cost: 4_000, revenue: 8_000,
    })) });
    if ((start + 1_000) % 20_000 === 0) process.stdout.write(`${start + 1_000} ventas de prueba\n`);
  }
  await db.$executeRawUnsafe(`INSERT INTO "CashEntry"
    (id, date, account, category, amount, description, "saleId", "userId", "createdAt")
    SELECT 'bench-e-' || id, date, 'cash', 'sale', total, 'Venta de prueba', id, "userId", "createdAt" FROM "Sale"`);
  await db.$executeRawUnsafe('ANALYZE "Customer"');
  await db.$executeRawUnsafe('ANALYZE "Product"');
  await db.$executeRawUnsafe('ANALYZE "Sale"');
  await db.$executeRawUnsafe('ANALYZE "SaleItem"');
  await db.$executeRawUnsafe('ANALYZE "CashEntry"');
  process.stdout.write("Fixture listo: 5.000 socios, 500 lotes, 100.000 ventas y sus asientos de caja.\n");
} finally {
  await db.$disconnect();
}
