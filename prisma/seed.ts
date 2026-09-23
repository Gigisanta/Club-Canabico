import "dotenv/config";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { defaults, businessDate } from "../shared/domain.js";
const db = new PrismaClient();
async function seed() {
  if (await db.user.count()) {
    console.log("La base ya tiene usuarios; no se modificó.");
    return;
  }
  const demo = process.env.DEMO_MODE === "true";
  await db.setting.upsert({
    where: { id: 1 },
    create: { id: 1, value: { ...defaults } },
    update: {},
  });
  if (!demo) {
    if (
      !process.env.ADMIN_EMAIL ||
      !process.env.ADMIN_PASSWORD ||
      process.env.ADMIN_PASSWORD.length < 12
    )
      throw new Error(
        "Configurá ADMIN_EMAIL y ADMIN_PASSWORD (12 caracteres mínimo)",
      );
    await db.user.create({
      data: {
        id: "owner",
        name: process.env.ADMIN_NAME || "Administrador",
        email: process.env.ADMIN_EMAIL.toLowerCase(),
        password: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
        role: "owner",
      },
    });
    console.log("Administrador creado. Base sin datos de demostración.");
    return;
  }
  if (process.env.NODE_ENV === "production")
    throw new Error("Seed demo deshabilitado en producción");
  const password = await bcrypt.hash("Demo-Raiz-2026!", 12);
  const people: [string, string, Role, string][] = [
    ["owner", "Tomás García", "owner", "#9b78e6"],
    ["r1", "Lucía Fernández", "responsible", "#b39cc9"],
    ["r2", "Martín López", "responsible", "#d3b27e"],
    ["r3", "Sofía Rodríguez", "responsible", "#86a5be"],
    ["admin", "Ana Martínez", "admin", "#9b78e6"],
    ["cashier", "Diego Ruiz", "cashier", "#b89682"],
    ["viewer", "Invitado", "viewer", "#92999f"],
  ];
  const today = businessDate(defaults);
  const ago = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  await db.$transaction(
    async (tx) => {
      for (const [id, name, role, color] of people)
        await tx.user.create({
          data: {
            id,
            name,
            role,
            color,
            password,
            email: `${id}@demo.raiz.local`,
          },
        });
      const names = [
        "Mateo Álvarez",
        "Valentina Costa",
        "Nicolás Romero",
        "Camila Torres",
        "Santiago Méndez",
        "Julieta Ríos",
        "Lucas Acosta",
        "Florencia Silva",
        "Joaquín Díaz",
        "Agustina Vega",
        "Benjamín Castro",
        "Martina Paz",
        "Felipe Molina",
        "Catalina Suárez",
        "Tomás Navarro",
        "Emma Ferrer",
        "Bruno Sosa",
        "Clara Ortiz",
        "Pedro Luna",
        "Lola Medina",
        "Simón Blanco",
        "Alma Reyes",
        "Lautaro Gil",
        "Paula Moreno",
      ];
      for (const [i, name] of names.entries())
        await tx.customer.create({
          data: {
            id: `c${i + 1}`,
            name,
            email: `socio${i + 1}@example.com`,
            phone: `+54 11 5555 ${String(i + 1).padStart(3, "0")}`,
            notes: i === 0 ? "Prefiere recibir las novedades por email." : "",
            createdAt: new Date(`${ago(240 + i)}T10:00:00Z`),
          },
        });
      const list: [
        string,
        string,
        string,
        number,
        number,
        number,
        number,
        string,
      ][] = [
        ["Amnesia Haze", "Sativa", "Flor", 312, 50, 380, 1000, "r1"],
        ["Gorilla Glue", "Híbrida", "Flor", 248, 40, 420, 1200, "r2"],
        ["Purple Punch", "Índica", "Flor", 185, 35, 450, 1300, "r3"],
        ["Lemon Haze", "Sativa", "Flor", 22, 40, 360, 1000, "r1"],
        ["Northern Lights", "Índica", "Flor", 156, 30, 350, 1100, "r2"],
        ["Gelato #41", "Híbrida", "Flor", 208, 35, 480, 1400, "r3"],
        ["Critical +", "Índica", "Flor", 18, 35, 320, 900, "r2"],
        ["CBD Balance", "CBD", "Flor", 126, 25, 280, 800, "r1"],
        ["Rosin Premium", "Híbrida", "Extracto", 45, 10, 1600, 3500, "r3"],
        ["Dry Sift", "Híbrida", "Extracto", 8, 15, 900, 2200, "r2"],
        ["Orange Cookies", "Híbrida", "Flor", 168, 30, 440, 1200, "r1"],
        ["Aceite CBD 10%", "CBD", "Aceite", 38, 8, 1100, 2800, "r3"],
      ];
      for (const [i, p] of list.entries())
        await tx.product.create({
          data: {
            id: `p${i + 1}`,
            name: p[0],
            strain: p[1],
            type: p[2],
            stock: p[3] * 1000,
            minimum: p[4] * 1000,
            cost: p[5] * 1000,
            price: p[6] * 1000,
            ownerId: p[7],
            unit: p[2] === "Aceite" ? "ud" : "g",
            lot: `RC-26-${String(i + 1).padStart(3, "0")}`,
            location: `Almacén ${i % 2 ? "B" : "A"}`,
            expires: i === 8 ? ago(-20) : null,
            createdAt: new Date(`${ago(100)}T09:00:00Z`),
          },
        });
      let seq = 1;
      const products = await tx.product.findMany();
      for (let day = 89; day >= 0; day--) {
        const count = 5 + ((day * 17) % 7);
        for (let n = 0; n < count; n++) {
          const p = products[(day * 7 + n * 5) % products.length];
          const customerId = `c${1 + ((day > 65 ? day + n : day * 3 + n) % (day > 65 ? 24 : 19))}`;
          const quantity = p.unit === "ud" ? 1000 : (2 + (seq % 7)) * 1000;
          const total = Math.round((quantity * p.price) / 1000);
          const cost = Math.round((quantity * p.cost) / 1000);
          const date = ago(day);
          const id = `V-${String(seq++).padStart(5, "0")}`;
          const pointsEarned = Math.floor(total / defaults.pointsEvery);
          await tx.sale.create({
            data: {
              id,
              customerId,
              userId: "cashier",
              date,
              createdAt: new Date(
                `${date}T${String(10 + n).padStart(2, "0")}:30:00Z`,
              ),
              subtotal: total,
              discount: 0,
              total,
              cost,
              pointsEarned,
              pointsUsed: 0,
              payment: n % 3 ? "card" : "cash",
              requestId: id,
              items: {
                create: {
                  productId: p.id,
                  ownerId: p.ownerId,
                  name: p.name,
                  quantity,
                  price: p.price,
                  cost,
                  revenue: total,
                },
              },
            },
          });
          await tx.customer.update({
            where: { id: customerId },
            data: { points: { increment: pointsEarned } },
          });
        }
      }
      for (const p of products) {
        const items = await tx.saleItem.findMany({
          where: { productId: p.id },
          include: { sale: true },
          orderBy: { sale: { createdAt: "asc" } },
        });
        let balance = p.stock + items.reduce((n, i) => n + i.quantity, 0);
        await tx.movement.create({
          data: {
            productId: p.id,
            type: "entry",
            quantity: balance,
            beforeStock: 0,
            afterStock: balance,
            toOwner: p.ownerId,
            userId: "owner",
            note: "Stock inicial de demostración",
            createdAt: new Date(`${ago(100)}T09:00:00Z`),
          },
        });
        for (const i of items) {
          const before = balance;
          balance -= i.quantity;
          await tx.movement.create({
            data: {
              productId: p.id,
              type: "sale",
              quantity: -i.quantity,
              beforeStock: before,
              afterStock: balance,
              fromOwner: p.ownerId,
              toOwner: p.ownerId,
              userId: "cashier",
              note: i.saleId,
              createdAt: i.sale.createdAt,
            },
          });
        }
      }
      for (let month = 0; month < 3; month++) {
        const d = new Date(`${today}T12:00:00Z`);
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() - month);
        const date = d.toISOString().slice(0, 10);
        const expenses: [string, number, string, string][] = [
          ["Alquiler del local", 180000, "Alquiler", "fixed"],
          ["Equipo y colaboradores", 260000, "Personal", "fixed"],
          ["Electricidad", 78000, "Servicios", "variable"],
          ["Insumos de mantenimiento", 34000, "Insumos", "variable"],
          ["Transporte y logística", 21500, "Transporte", "variable"],
        ];
        for (const [i, e] of expenses.entries())
          await tx.expense.create({
            data: {
              name: e[0],
              amount: e[1] * 1000,
              category: e[2],
              kind: e[3],
              ownerId: i === 3 ? "r1" : null,
              date,
              recurrence: "none",
            },
          });
      }
    },
    { timeout: 120000 },
  );
  console.log(
    "Demo creada: 7 usuarios, 24 socios, 12 lotes y 90 días de actividad.",
  );
}
seed()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
