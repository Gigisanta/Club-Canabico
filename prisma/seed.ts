import "dotenv/config";
import { PrismaClient, type Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { defaults, businessDate, nextDate } from "../shared/domain.js";
import { profileCapabilities } from "../shared/operations/contracts.js";
const db = new PrismaClient();
async function seed() {
  const demo = process.env.DEMO_MODE === "true";
  if (!demo) {
    if (/demo/i.test(new URL(process.env.DATABASE_URL || "").pathname))
      throw new Error("La conexión apunta a una base llamada demo. Usá una base real separada.");
    if (await db.user.count({ where: { email: { endsWith: "@demo.bombo.local" } } }))
      throw new Error("La base contiene usuarios de demostración. Usá una base real separada.");
    for (const [id, name, role, profile] of [
      ["tiziano", "Tiziano", "owner", "owner"],
      ["camila", "Camila", "admin", "commercial"],
      ["gio", "Gio", "admin", "finance"],
    ] as const) {
      if (await db.user.findUnique({ where: { id }, select: { id: true } })) continue;
      await db.teamSeat.upsert({ where: { id }, create: { id, name, role }, update: {} });
      // Initial profiles come from the approved migration plan; preserve any existing grants.
      await db.operationAccess.upsert({ where: { userId: id }, create: { userId: id, profile, capabilities: profileCapabilities[profile]!, scope: {} }, update: {} });
    }
  }
  if (await db.user.count()) {
    if (process.env.DEMO_MODE === "true" && process.env.NODE_ENV !== "production" &&
        await db.user.findUnique({ where: { email: "owner@demo.bombo.local" }, select: { id: true } })) {
      const password = await bcrypt.hash("Demo-Bombo-2026!", 12);
      await db.$transaction(async (tx) => {
        await tx.user.updateMany({ where: { id: "admin", email: "admin@demo.bombo.local", name: "Ana Martínez" },
          data: { name: "Camila" } });
        await tx.user.upsert({ where: { email: "gio@demo.bombo.local" },
          create: { id: "gio", name: "Gio", email: "gio@demo.bombo.local", role: "admin", color: "#789b84", password },
          update: {} });
      });
      console.log("Demo existente conservada; Camila y Gio disponibles si faltaban.");
    } else console.log("La base ya tiene usuarios; no se modificó.");
    return;
  }
  await db.setting.upsert({
    where: { id: 1 },
    create: { id: 1, value: { ...defaults } },
    update: {},
  });
  if (!demo) {
    if (process.env.ADMIN_EMAIL || process.env.ADMIN_PASSWORD) {
      if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)
        throw new Error("Configurá ADMIN_EMAIL y ADMIN_PASSWORD (12 caracteres mínimo), o dejá ambos vacíos para activar con invitación.");
      await db.user.create({ data: { id: "owner", name: process.env.ADMIN_NAME || "Administrador", email: process.env.ADMIN_EMAIL.toLowerCase(), password: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12), role: "owner" } });
      console.log("Administrador inicial creado. Base sin datos de demostración.");
    } else console.log("Club real preparado: Tiziano, Camila y Gio esperan correo y activación individual.");
    return;
  }
  if (process.env.NODE_ENV === "production")
    throw new Error("Seed demo deshabilitado en producción");
  const password = await bcrypt.hash("Demo-Bombo-2026!", 12);
  const people: [string, string, Role, string][] = [
    ["owner", "Tiziano", "owner", "#9b78e6"],
    ["r1", "Lucía Fernández", "responsible", "#b39cc9"],
    ["r2", "Martín López", "responsible", "#d3b27e"],
    ["r3", "Sofía Rodríguez", "responsible", "#86a5be"],
    ["admin", "Camila", "admin", "#9b78e6"],
    ["gio", "Gio", "admin", "#789b84"],
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
            email: `${id}@demo.bombo.local`,
            username: id,
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
      const stockLocations = [];
      for (const [index, name] of ["Almacén A", "Almacén B"].entries())
        stockLocations.push(await tx.location.create({ data: { name, key: name.toLowerCase(), isDefault: index === 0 } }));
      // Tiziano's commercial categories. Interior Premium+ stays one variety short so Inicio shows the alert.
      const categories: [string, number, number[]][] = [
        ["Interior Premium+", 3, [3, 6]],
        ["Interior Premium", 3, [2, 5, 11]],
        ["Exterior Premium", 2, [1, 8]],
        ["Exterior", 2, [4, 7]],
      ];
      const categoryOf = new Map<number, string>();
      for (const [name, minVarieties, lots] of categories) {
        const category = await tx.productCategory.create({ data: { name, key: name.toLowerCase(), minVarieties } });
        for (const lot of lots) categoryOf.set(lot, category.id);
      }
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
            locationId: stockLocations[i % 2].id,
            categoryId: categoryOf.get(i + 1) ?? null,
            expires: i === 8 ? ago(-20) : null,
            createdAt: new Date(`${ago(100)}T09:00:00Z`),
          },
        });
      let seq = 1;
      const products = await tx.product.findMany();
      // Caja: opening balances, one entry per sale in its account, a Monday deposit of the drawer above
      // the float and the bank payment of each expense. Today's times stay at or before the seed run,
      // so a movement made afterwards is the newest in its account.
      const seededAt = new Date();
      const at = (date: string, time: string) => {
        const value = new Date(`${date}T${time}Z`);
        return value > seededAt ? seededAt : value;
      };
      const float = 25_000_000;
      let drawer = float;
      await tx.cashEntry.createMany({
        data: [
          { account: "cash", amount: float, description: "Saldo inicial de la caja del local" },
          { account: "bank", amount: 800_000_000, description: "Saldo inicial de la cuenta bancaria" },
        ].map((entry) => ({
          ...entry,
          date: ago(100),
          category: "opening_balance",
          userId: "owner",
          createdAt: at(ago(100), "09:00:00"),
        })),
      });
      for (let day = 89; day >= 0; day--) {
        const deposit = drawer - float;
        if (day > 0 && deposit > 0 && new Date(`${ago(day)}T12:00:00Z`).getUTCDay() === 1) {
          await tx.cashEntry.createMany({
            data: [
              { account: "cash", amount: -deposit, description: "Depósito del efectivo en el banco · sale de la caja" },
              { account: "bank", amount: deposit, description: "Depósito del efectivo en el banco · entra al banco" },
            ].map((entry) => ({
              ...entry,
              date: ago(day),
              category: "adjustment",
              userId: "owner",
              createdAt: at(ago(day), "09:00:00"),
            })),
          });
          drawer = float;
        }
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
          const payment = n % 3 ? "card" : "cash";
          const time = `${String(10 + n).padStart(2, "0")}:30:00`;
          await tx.sale.create({
            data: {
              id,
              customerId,
              userId: "cashier",
              date,
              createdAt: new Date(`${date}T${time}Z`),
              subtotal: total,
              discount: 0,
              total,
              cost,
              pointsEarned,
              pointsUsed: 0,
              payment,
              requestId: id,
              items: {
                create: {
                  productId: p.id,
                  ownerId: p.ownerId,
                  name: p.name,
                  unit: p.unit,
                  quantity,
                  price: p.price,
                  cost,
                  revenue: total,
                },
              },
            },
          });
          await tx.cashEntry.create({
            data: {
              date,
              account: payment === "cash" ? "cash" : "bank",
              category: "sale",
              amount: total,
              description: `Venta local ${id}`,
              saleId: id,
              userId: "cashier",
              createdAt: at(date, time),
            },
          });
          if (payment === "cash") drawer += total;
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
      // Rent and staff repeat monthly: each rule's next date is the 1st of next month, one of Finanzas' upcoming payments.
      const fixedRules = new Map<string, string>();
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
        for (const [i, e] of expenses.entries()) {
          let ruleId = fixedRules.get(e[0]);
          if (e[3] === "fixed" && !ruleId) {
            ruleId = (await tx.recurringRule.create({ data: { name: e[0], amount: e[1] * 1000, category: e[2],
              recurrence: "monthly", nextDate: nextDate(date, "monthly") } })).id;
            fixedRules.set(e[0], ruleId);
          }
          await tx.expense.create({
            data: {
              name: e[0],
              amount: e[1] * 1000,
              category: e[2],
              kind: e[3],
              ownerId: i === 3 ? "r1" : null,
              date,
              recurrence: ruleId ? "monthly" : "none",
              ruleId,
            },
          });
          await tx.cashEntry.create({
            data: {
              date,
              account: "bank",
              category: "operating_expense",
              amount: -e[1] * 1000,
              description: `Pago · ${e[0]}`,
              userId: "owner",
              createdAt: at(date, "08:00:00"),
            },
          });
        }
      }
      // A stock purchase on credit and a tax advance, in the base plan: the payments Tizi wants to see coming.
      await tx.cashPlan.createMany({ data: [
        { date: ago(-12), category: "stock_purchase", amount: -240_000_000, description: "Compra a plazo · lote Interior Premium" },
        { date: ago(-19), category: "operating_expense", amount: -38_000_000, description: "Anticipo de impuestos" },
      ].map((plan) => ({ ...plan, account: "bank", scenario: "base", userId: "owner" })) });
    },
    { timeout: 120000 },
  );
  console.log(
    "Demo creada: 8 usuarios, 24 socios, 12 lotes y 90 días de actividad con caja, banco y pagos previstos.",
  );
}
seed()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
