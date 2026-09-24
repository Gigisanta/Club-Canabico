import express, {
  type RequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { Prisma, type User, type Role } from "@prisma/client";
import { z } from "zod";
import { parse } from "csv-parse/sync";
import { db, atomic, getSettings } from "./db.js";
import { businessDate, nextDate, priceSale, allocateRevenue } from "../shared/domain.js";
import { getState, publicUser } from "./state.js";
import { customerPage, productPage, checkoutCustomers, checkoutProducts, salesPage, customerHistory, globalSearch, cashEntryPage, expensePage, movementPage } from "./read.js";
import { dashboardMetrics } from "./dashboard.js";
import {
  productSchema,
  supplierSchema,
  locationSchema,
  customerSchema,
  saleSchema,
  expenseSchema,
  settingsSchema,
  date,
  permitSchema,
  cashEntrySchema,
  cashPlanSchema,
  HttpError,
} from "./validation.js";
import { resolveSupplier, supplierKey, supplierName } from "./suppliers.js";
import { resolveLocation, locationKey, locationName } from "./locations.js";
import { exportReport } from "./reports.js";
import { productCatalog } from "./product-catalog.js";
declare global {
  namespace Express {
    interface Request {
      user: User;
    }
  }
}
const demo = process.env.DEMO_MODE === "true";
const operationsEnabled = demo || process.env.CLUB_OPERATIONS_APPROVED === "true";
const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32)
  throw new Error("JWT_SECRET debe tener al menos 32 caracteres.");
if (demo && process.env.NODE_ENV === "production")
  throw new Error("DEMO_MODE no puede activarse en producción.");
const allowedOrigins = (
  process.env.ALLOWED_ORIGIN || "http://localhost:5173,http://127.0.0.1:5173"
).split(",");
export const app = express();
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        "script-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "upgrade-insecure-requests":
          process.env.COOKIE_SECURE === "true" ? [] : null,
      },
    },
  }),
);
app.use(
  cors({
    origin: (origin, cb) =>
      cb(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    (!req.get("Origin") || !allowedOrigins.includes(req.get("Origin")!))
  )
    return res.status(403).json({ error: "Origen no autorizado" });
  next();
});
const auth: RequestHandler = async (req, res, next) => {
  try {
    const payload = jwt.verify(req.cookies.session || "", secret!, {
      algorithms: ["HS256"],
    });
    if (typeof payload === "string" || !payload.sub) throw new Error();
    const user = await db.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new Error();
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Iniciá sesión para continuar" });
  }
};
const roles =
  (...allowed: Role[]): RequestHandler =>
  (req, res, next) => {
    if (!allowed.includes(req.user.role))
      return res
        .status(403)
        .json({ error: "No tenés permiso para esta operación" });
    next();
  };
function session(res: Response, user: User) {
  const token = jwt.sign({}, secret!, {
    subject: user.id,
    algorithm: "HS256",
    expiresIn: "8h",
  });
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: 8 * 60 * 60 * 1000,
    path: "/",
  });
  res.json({
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      color: user.color,
    },
  });
}
app.get("/api/health", async (_req, res) => {
  await db.$queryRaw`SELECT 1`;
  res.json({ ok: true });
});
app.get("/api/config", (_req, res) => res.json({ demo }));
app.post(
  "/api/auth/login",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Demasiados intentos. Reintentá en 15 minutos." },
  }),
  async (req, res) => {
    const v = z
      .object({ email: z.email(), password: z.string().max(200) })
      .parse(req.body);
    const user = await db.user.findUnique({
      where: { email: v.email.toLowerCase() },
    });
    if (!user || !(await bcrypt.compare(v.password, user.password)))
      throw new HttpError(401, "Email o contraseña incorrectos");
    session(res, user);
  },
);
app.post("/api/auth/demo", async (req, res) => {
  if (!demo) throw new HttpError(404, "No disponible");
  const id = z
    .enum(["owner", "r1", "r2", "r3", "admin", "cashier", "viewer"])
    .parse(req.body.id || "owner");
  const user = await db.user.findUnique({ where: { id } });
  if (!user) throw new HttpError(404, "Ejecutá el seed de demostración");
  session(res, user);
});
app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("session", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/auth/me", auth, (req, res) =>
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      role: req.user.role,
      email: req.user.email,
      color: req.user.color,
    },
  }),
);
app.use("/api", auth);
app.get("/api/views/:view", async (req, res) =>
  res.json(
    await getState(
      req.user,
      typeof req.query.owner === "string" ? req.query.owner : undefined,
      z.enum(["dashboard", "inventory", "customers", "sales", "expenses", "finance", "responsibles", "reports", "settings"]).parse(req.params.view),
      req.params.view === "expenses" && req.query.month !== undefined
        ? z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).parse(req.query.month)
        : undefined,
    ),
  ),
);
app.get("/api/list/customers", async (req, res) =>
  res.json(await customerPage(req.user, typeof req.query.owner === "string" ? req.query.owner : undefined, req.query)));
app.get("/api/dashboard", async (req, res) =>
  res.json(await dashboardMetrics(req.user, typeof req.query.owner === "string" ? req.query.owner : undefined, req.query)));
app.get("/api/list/products", async (req, res) =>
  res.json(await productPage(req.user, typeof req.query.owner === "string" ? req.query.owner : undefined, req.query)));
app.get("/api/product-catalog", roles("owner", "admin", "responsible"), async (req, res) =>
  res.json(await productCatalog(req.user, req.query.q)));
app.get("/api/list/sales", async (req, res) =>
  res.json(await salesPage(req.user, typeof req.query.owner === "string" ? req.query.owner : undefined, req.query)));
app.get("/api/list/cash-entries", async (req, res) => res.json(await cashEntryPage(req.user, req.query)));
app.get("/api/list/expenses", async (req, res) =>
  res.json(await expensePage(req.user, typeof req.query.owner === "string" ? req.query.owner : undefined, req.query)));
app.get("/api/checkout/customers", roles("owner", "admin", "cashier", "responsible"), async (req, res) => res.json(await checkoutCustomers(req.user, req.query.q)));
app.get("/api/checkout/products", roles("owner", "admin", "cashier", "responsible"), async (req, res) =>
  res.json(await checkoutProducts(req.user, typeof req.query.owner === "string" ? req.query.owner : undefined)));
app.get("/api/customers/:id/history", async (req, res) =>
  res.json(await customerHistory(req.user, String(req.params.id), req.query)));
app.get("/api/search", async (req, res) =>
  res.json(await globalSearch(req.user, typeof req.query.owner === "string" ? req.query.owner : undefined, req.query.q)));
app.get("/api/movements", async (req, res) =>
  res.json(await movementPage(req.user, typeof req.query.owner === "string" ? req.query.owner : undefined, req.query)));
async function validOwner(id: string) {
  const owner = await db.user.findUnique({ where: { id } });
  if (!owner || !["responsible", "owner", "admin"].includes(owner.role))
    throw new HttpError(400, "Responsable inválido");
}
app.get("/api/suppliers", roles("owner", "admin", "responsible"), async (_req, res) => {
  const items = await db.supplier.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }],
    include: { _count: { select: { products: true } } },
  });
  res.json({ items: items.map(({ _count, ...supplier }) => ({ ...supplier, lotCount: _count.products })), total: items.length });
});
app.post("/api/suppliers", roles("owner"), async (req, res) => {
  const v = supplierSchema.parse(req.body);
  const name = supplierName(v.name);
  const result = await atomic(async (tx) => {
    if (v.isDefault) await tx.supplier.updateMany({ data: { isDefault: false } });
    return tx.supplier.create({ data: { ...v, name, key: supplierKey(name) } });
  });
  res.status(201).json(result);
});
app.patch("/api/suppliers/:id", roles("owner"), async (req, res) => {
  const v = supplierSchema.parse(req.body);
  const name = supplierName(v.name);
  const result = await atomic(async (tx) => {
    const current = await tx.supplier.findUnique({ where: { id: String(req.params.id) } });
    if (!current) throw new HttpError(404, "Proveedor no encontrado");
    if (!current.active && v.isDefault) throw new HttpError(400, "Activá el proveedor antes de marcarlo como predeterminado");
    if (v.isDefault) await tx.supplier.updateMany({ where: { id: { not: current.id } }, data: { isDefault: false } });
    return tx.supplier.update({ where: { id: current.id }, data: { ...v, name, key: supplierKey(name) } });
  });
  res.json(result);
});
app.patch("/api/suppliers/:id/status", roles("owner"), async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  const result = await db.supplier.update({
    where: { id: String(req.params.id) },
    data: { active, ...(!active ? { isDefault: false } : {}) },
  });
  res.json(result);
});
app.get("/api/locations", roles("owner", "admin", "responsible"), async (_req, res) => {
  const items = await db.location.findMany({
    orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }],
    include: { _count: { select: { products: true } } },
  });
  res.json({ items: items.map(({ _count, ...location }) => ({ ...location, lotCount: _count.products })), total: items.length });
});
app.post("/api/locations", roles("owner"), async (req, res) => {
  const v = locationSchema.parse(req.body);
  const name = locationName(v.name);
  const result = await atomic(async (tx) => {
    const first = !(await tx.location.count({ where: { active: true } }));
    if (v.isDefault) await tx.location.updateMany({ data: { isDefault: false } });
    return tx.location.create({ data: { name, key: locationKey(name), isDefault: v.isDefault || first } });
  });
  res.status(201).json(result);
});
app.patch("/api/locations/:id", roles("owner"), async (req, res) => {
  const v = locationSchema.parse(req.body);
  const name = locationName(v.name);
  const result = await atomic(async (tx) => {
    const current = await tx.location.findUnique({ where: { id: String(req.params.id) } });
    if (!current) throw new HttpError(404, "Ubicación no encontrada");
    if (!current.active && v.isDefault) throw new HttpError(400, "Activá la ubicación antes de marcarla como predeterminada");
    if (v.isDefault) await tx.location.updateMany({ where: { id: { not: current.id } }, data: { isDefault: false } });
    const updated = await tx.location.update({ where: { id: current.id }, data: { name, key: locationKey(name), isDefault: v.isDefault } });
    if (current.name !== name) await tx.product.updateMany({ where: { locationId: current.id }, data: { location: name } });
    return updated;
  });
  res.json(result);
});
app.patch("/api/locations/:id/status", roles("owner"), async (req, res) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  const result = await db.location.update({
    where: { id: String(req.params.id) },
    data: { active, ...(!active ? { isDefault: false } : {}) },
  });
  res.json(result);
});
function validateCashDirection(category: string, amount: number) {
  if (["opening_balance", "capital_contribution", "delivery_receipt", "other_income"].includes(category) && amount < 0)
    throw new HttpError(400, "Este tipo de ingreso requiere importe positivo");
  if (["operating_expense", "stock_purchase", "local_investment", "owner_draw", "other_outflow"].includes(category) && amount > 0)
    throw new HttpError(400, "Este tipo de egreso requiere importe negativo");
}
app.post(
  "/api/products",
  roles("owner", "admin", "responsible"),
  async (req, res) => {
    const v = productSchema.parse(req.body);
    if (Boolean(v.sourceSystem) !== Boolean(v.sourceId)) throw new HttpError(400, "Completá origen e ID de origen juntos");
    if (v.unit === "ud" && (v.stock % 1000 !== 0 || v.minimum % 1000 !== 0))
      throw new HttpError(400, "El stock de unidades debe ser entero");
    if (req.user.role === "responsible" && v.ownerId !== req.user.id)
      throw new HttpError(403, "Solo podés crear lotes propios");
    await validOwner(v.ownerId);
    const product = await atomic(async (tx) => {
      const selected = await resolveSupplier(tx, v.supplierId, v.supplier);
      const located = await resolveLocation(tx, v.locationId, v.location, null, req.user.role === "owner");
      const p = await tx.product.create({ data: { ...v, ...selected, ...located, sourceSystem: v.sourceSystem || "local", sourceId: v.sourceId || randomUUID() } });
      await tx.movement.create({
        data: {
          productId: p.id,
          type: "entry",
          quantity: p.stock,
          beforeStock: 0,
          afterStock: p.stock,
          toOwner: p.ownerId,
          userId: req.user.id,
          note: "Alta de lote",
        },
      });
      return p;
    });
    res.status(201).json(product);
  },
);
app.patch(
  "/api/products/:id",
  roles("owner", "admin", "responsible"),
  async (req, res) => {
    const v = productSchema
      .omit({ stock: true, ownerId: true, sourceSystem: true, sourceId: true })
      .parse(req.body);
    const existing = await db.product.findFirst({
      where: {
        id: String(req.params.id),
        ...(req.user.role === "responsible" ? { ownerId: req.user.id } : {}),
      },
    });
    if (!existing) throw new HttpError(404, "Lote no encontrado");
    if (existing.unit !== v.unit)
      throw new HttpError(
        400,
        "La unidad de un lote no se puede cambiar. Creá un lote nuevo.",
      );
    if (v.unit === "ud" && v.minimum % 1000 !== 0)
      throw new HttpError(400, "El mínimo de unidades debe ser entero");
    const result = await atomic(async (tx) => {
      const selected = await resolveSupplier(tx, v.supplierId, v.supplier, existing.supplierId);
      const located = await resolveLocation(tx, v.locationId, v.location, existing.locationId, req.user.role === "owner");
      return tx.product.updateMany({
        where: {
          id: String(req.params.id),
          ...(req.user.role === "responsible" ? { ownerId: req.user.id } : {}),
        },
        data: { ...v, ...selected, ...located },
      });
    });
    if (!result.count) throw new HttpError(404, "Lote no encontrado");
    res.json({ ok: true });
  },
);
app.post(
  "/api/products/:id/movements",
  roles("owner", "admin", "responsible"),
  async (req, res) => {
    const v = z
      .object({
        type: z.enum(["entry", "exit", "adjustment", "transfer"]),
        quantity: z.number().int().min(0).max(100000000),
        ownerId: z.string().optional(),
        note: z.string().trim().min(3).max(500),
      })
      .parse(req.body);
    if (v.type === "transfer" && req.user.role === "responsible")
      throw new HttpError(403, "Un gerente debe autorizar los traspasos");
    if (v.type === "transfer") {
      if (!v.ownerId) throw new HttpError(400, "Seleccioná el destinatario");
      await validOwner(v.ownerId);
    }
    const result = await atomic(async (tx) => {
      const p = await tx.product.findUnique({
        where: { id: String(req.params.id) },
      });
      if (!p || (req.user.role === "responsible" && p.ownerId !== req.user.id))
        throw new HttpError(404, "Lote no encontrado");
      if (p.unit === "ud" && v.quantity % 1000 !== 0)
        throw new HttpError(400, "Las unidades deben ser enteras");
      const after =
        v.type === "adjustment"
          ? v.quantity
          : v.type === "transfer"
            ? p.stock
            : p.stock + (v.type === "entry" ? v.quantity : -v.quantity);
      if (after < 0) throw new HttpError(409, "Stock insuficiente");
      if (v.type === "transfer" && v.ownerId === p.ownerId)
        throw new HttpError(400, "El destino ya es responsable del lote");
      await tx.product.update({
        where: { id: p.id },
        data: {
          stock: after,
          ownerId: v.type === "transfer" ? v.ownerId : p.ownerId,
        },
      });
      return tx.movement.create({
        data: {
          productId: p.id,
          type: v.type,
          quantity: after - p.stock,
          beforeStock: p.stock,
          afterStock: after,
          fromOwner: p.ownerId,
          toOwner: v.type === "transfer" ? v.ownerId : p.ownerId,
          userId: req.user.id,
          note: v.note,
        },
      });
    });
    res.status(201).json(result);
  },
);
app.post(
  "/api/customers",
  roles("owner", "admin", "cashier"),
  async (req, res) => {
    const v = customerSchema.parse(req.body);
    if (Boolean(v.sourceSystem) !== Boolean(v.sourceId)) throw new HttpError(400, "Completá origen e ID de origen juntos");
    res.status(201).json(await db.customer.create({ data: { ...v, sourceSystem: v.sourceSystem || "local", sourceId: v.sourceId || randomUUID() } }));
  },
);
app.patch(
  "/api/customers/:id",
  roles("owner", "admin", "cashier"),
  async (req, res) =>
    res.json(
      await db.customer.update({
        where: { id: String(req.params.id) },
        data: customerSchema.omit({ sourceSystem: true, sourceId: true }).parse(req.body),
      }),
    ),
);
app.patch("/api/customers/:id/permit", roles("owner", "admin"), async (req, res) => {
  const v = permitSchema.parse(req.body);
  if (v.status === "verified" && (!v.validUntil || v.validUntil < businessDate(await getSettings())))
    throw new HttpError(400, "La vigencia verificada debe ser futura o de hoy");
  const customer = await db.customer.update({
    where: { id: String(req.params.id) },
    data: { permitStatus: v.status, permitValidUntil: v.validUntil, permitCheckedAt: new Date() },
  });
  res.json({ id: customer.id, permitStatus: customer.permitStatus, permitValidUntil: customer.permitValidUntil });
});
app.post(
  "/api/sales",
  roles("owner", "admin", "cashier", "responsible"),
  async (req, res) => {
    if (!operationsEnabled) throw new HttpError(403, "Operaciones con cannabis pendientes de validación legal del club");
    const v = saleSchema.parse(req.body);
    const config = await getSettings();
    const result = await atomic(async (tx) => {
      const existing = await tx.sale.findUnique({
        where: { requestId: v.requestId },
        include: { items: true },
      });
      if (existing) {
        if (existing.userId !== req.user.id)
          throw new HttpError(409, "Identificador ya utilizado");
        return existing;
      }
      const today = businessDate(config);
      if (await tx.closure.findUnique({ where: { date: today } }))
        throw new HttpError(409, "La caja de hoy está cerrada");
      const customer = await tx.customer.findUnique({
        where: { id: v.customerId },
      });
      if (!customer) throw new HttpError(404, "Socio no encontrado");
      if (!demo && (customer.permitStatus !== "verified" || !customer.permitValidUntil || customer.permitValidUntil < today))
        throw new HttpError(403, "Permiso del socio sin verificación vigente");
      if (
        req.user.role === "responsible" &&
        !(await tx.sale.findFirst({
          where: {
            customerId: customer.id,
            items: { some: { ownerId: req.user.id } },
          },
        }))
      )
        throw new HttpError(403, "Socio fuera de tu ámbito");
      const products = await tx.product.findMany({
        where: { id: { in: v.items.map((i) => i.productId) } },
      });
      const lines = v.items.map((line) => {
        const p = products.find((p) => p.id === line.productId);
        if (
          !p ||
          (req.user.role === "responsible" && p.ownerId !== req.user.id)
        )
          throw new HttpError(403, "Producto fuera de tus lotes asignados");
        if (p.stock < line.quantity)
          throw new HttpError(409, `Stock insuficiente: ${p.name}`);
        if (p.expires && p.expires < today)
          throw new HttpError(409, `Lote vencido: ${p.name}`);
        if (p.unit === "ud" && line.quantity % 1000 !== 0)
          throw new HttpError(400, "Las unidades deben ser enteras");
        return {
          p,
          quantity: line.quantity,
          amount: Math.round((p.price * line.quantity) / 1000),
          cost: Math.round((p.cost * line.quantity) / 1000),
        };
      });
      const subtotal = lines.reduce((n, l) => n + l.amount, 0);
      if (subtotal > 1_000_000_000)
        throw new HttpError(400, "El importe supera el límite por operación");
      if (subtotal <= 0)
        throw new HttpError(400, "El importe debe ser positivo");
      const spent =
        (
          await tx.sale.aggregate({
            where: { customerId: customer.id },
            _sum: { total: true },
          })
        )._sum.total || 0;
      let pricing;
      try {
        pricing = priceSale(subtotal, spent, customer.points, v.points, config);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const allocations=allocateRevenue(lines.map(l=>l.amount),pricing.total);
      const sale = await tx.sale.create({
        data: {
          customerId: customer.id,
          userId: req.user.id,
          date: today,
          subtotal,
          ...pricing,
          payment: v.payment,
          cost: lines.reduce((n, l) => n + l.cost, 0),
          requestId: v.requestId,
          channel: "local",
          items: {
            create: lines.map((l, i) => {
              const revenue = allocations[i];
              return {
                productId: l.p.id,
                ownerId: l.p.ownerId,
                name: l.p.name,
                quantity: l.quantity,
                price: l.p.price,
                cost: l.cost,
                revenue,
              };
            }),
          },
        },
        include: { items: true },
      });
      for (const l of lines) {
        await tx.product.update({
          where: { id: l.p.id },
          data: { stock: { decrement: l.quantity } },
        });
        await tx.movement.create({
          data: {
            productId: l.p.id,
            type: "sale",
            quantity: -l.quantity,
            beforeStock: l.p.stock,
            afterStock: l.p.stock - l.quantity,
            fromOwner: l.p.ownerId,
            toOwner: l.p.ownerId,
            userId: req.user.id,
            note: sale.id,
          },
        });
      }
      await tx.customer.update({
        where: { id: customer.id },
        data: { points: { increment: pricing.pointsEarned - v.points } },
      });
      await tx.cashEntry.create({ data: {
        date: today,
        account: v.payment === "cash" ? "cash" : "bank",
        category: "sale",
        amount: sale.total,
        description: `Venta local ${sale.id}`,
        saleId: sale.id,
        userId: req.user.id,
      } });
      return sale;
    });
    res
      .status(201)
      .json(
        req.user.role === "cashier"
          ? {
              ...result,
              cost: 0,
              items: result.items.map((i) => ({ ...i, cost: 0 })),
            }
          : result,
      );
  },
);
app.post(
  "/api/expenses",
  roles("owner", "admin", "responsible"),
  async (req, res) => {
    const v = expenseSchema.parse(req.body);
    if (req.user.role === "responsible" && v.ownerId !== req.user.id)
      throw new HttpError(403, "Solo podés asignar gastos a tu usuario");
    if (v.ownerId) await validOwner(v.ownerId);
    res.status(201).json(
      await atomic(async (tx) => {
        const rule =
          v.recurrence === "none"
            ? null
            : await tx.recurringRule.create({
                data: {
                  name: v.name,
                  amount: v.amount,
                  category: v.category,
                  ownerId: v.ownerId,
                  recurrence: v.recurrence,
                  nextDate: nextDate(v.date, v.recurrence),
                },
              });
        return tx.expense.create({ data: { ...v, ruleId: rule?.id } });
      }),
    );
  },
);
app.post(
  "/api/expenses/recurring",
  roles("owner", "admin"),
  async (_req, res) => {
    const today = businessDate(await getSettings());
    const count = await atomic(async (tx) => {
      let count = 0;
      const rules = await tx.recurringRule.findMany({
        where: {
          nextDate: { lte: today },
          recurrence: { in: ["weekly", "monthly"] },
        },
      });
      for (const r of rules) {
        const original = await tx.expense.findFirst({
          where: { ruleId: r.id },
          orderBy: { date: "asc" },
        });
        let due = r.nextDate;
        while (due <= today) {
          await tx.expense.upsert({
            where: { ruleId_date: { ruleId: r.id, date: due } },
            create: {
              name: r.name,
              amount: r.amount,
              category: r.category,
              kind: original?.kind || "fixed",
              ownerId: r.ownerId,
              date: due,
              recurrence: r.recurrence,
              ruleId: r.id,
            },
            update: {},
          });
          count++;
          due = nextDate(due, r.recurrence);
        }
        await tx.recurringRule.update({
          where: { id: r.id },
          data: { nextDate: due },
        });
      }
      return count;
    });
    res.json({ count });
  },
);
app.post(
  "/api/closures",
  roles("owner", "admin", "cashier"),
  async (req, res) => {
    const v = z
      .object({
        counted: z.number().int().min(0).max(1_000_000_000),
        note: z.string().max(500),
      })
      .parse(req.body);
    const today = businessDate(await getSettings());
    res.status(201).json(
      await atomic(async (tx) => {
        if (await tx.closure.findUnique({ where: { date: today } }))
          throw new HttpError(409, "La caja ya está cerrada");
        const previous = await tx.closure.findFirst({ where: { date: { lt: today } }, orderBy: { date: "desc" } });
        const movements = await tx.cashEntry.aggregate({
          where: { account: "cash", date: { gt: previous?.date || "0000-00-00", lte: today } },
          _sum: { amount: true },
        });
        const expected = (previous?.counted || 0) + (movements._sum.amount || 0);
        return tx.closure.create({
          data: {
            date: today,
            expected,
            counted: v.counted,
            difference: v.counted - expected,
            userId: req.user.id,
            note: v.note,
          },
        });
      }),
    );
  },
);
app.post("/api/cash-entries", roles("owner", "admin"), async (req, res) => {
  const v = cashEntrySchema.parse(req.body);
  validateCashDirection(v.category, v.amount);
  const today = businessDate(await getSettings());
  if (v.date > today) throw new HttpError(400, "Un movimiento real no puede tener fecha futura; usá la proyección");
  const entry = await atomic(async (tx) => {
    if (v.sourceSystem && v.sourceId) {
      const prior = await tx.cashEntry.findUnique({ where: { sourceSystem_sourceId: { sourceSystem: v.sourceSystem, sourceId: v.sourceId } } });
      if (prior) {
        if (prior.date !== v.date || prior.amount !== v.amount || prior.category !== v.category || prior.account !== v.account)
          throw new HttpError(409, "Identificador de origen con datos distintos");
        return prior;
      }
    }
    if (v.account === "cash" && await tx.closure.findFirst({ where: { date: { gte: v.date } } }))
      throw new HttpError(409, "Hay un cierre de caja para esta fecha o posterior");
    return tx.cashEntry.create({ data: { ...v, userId: req.user.id } });
  });
  res.status(201).json(entry);
});
app.post("/api/cash-plans", roles("owner", "admin"), async (req, res) => {
  const v = cashPlanSchema.parse(req.body);
  validateCashDirection(v.category, v.amount);
  const plan = await db.cashPlan.create({ data: { ...v, userId: req.user.id } });
  res.status(201).json(plan);
});
app.put("/api/settings", roles("owner", "admin"), async (req, res) => {
  const value = settingsSchema.parse(req.body);
  const current = await getSettings();
  if (value.currency !== current.currency && (await db.sale.count()))
    throw new HttpError(
      409,
      "Con ventas registradas, cambiar moneda requiere migrar los importes.",
    );
  await db.setting.upsert({
    where: { id: 1 },
    create: { id: 1, value },
    update: { value },
  });
  res.json(value);
});
app.post("/api/users", roles("owner"), async (req, res) => {
  const v = z
    .object({
      name: z.string().min(2).max(100),
      email: z.email(),
      password: z.string().min(12).max(72),
      role: z.enum(["admin", "responsible", "cashier", "viewer"]),
    })
    .parse(req.body);
  res
    .status(201)
    .json(
      await db.user.create({
        data: {
          ...v,
          email: v.email.toLowerCase(),
          password: await bcrypt.hash(v.password, 12),
        },
        select: publicUser,
      }),
    );
});
app.post("/api/import", roles("owner", "admin"), async (req, res) => {
  const v = z
    .object({
      kind: z.enum(["products", "customers", "cash_entries"]),
      csv: z.string().min(1).max(1500000),
      commit: z.boolean().default(false),
    })
    .parse(req.body);
  let rows: Record<string, string>[];
  try {
    rows = parse(v.csv, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      delimiter: v.csv.split("\n")[0].includes(";") ? ";" : ",",
    });
  } catch {
    throw new HttpError(400, "CSV inválido. Revisá comillas y separadores.");
  }
  if (rows.length > 2000)
    throw new HttpError(400, "Máximo 2.000 filas por importación");
  const errors: string[] = [];
  const data: (
    | z.infer<typeof productSchema>
    | z.infer<typeof customerSchema>
    | z.infer<typeof cashEntrySchema>
  )[] = [];
  const owners = await db.user.findMany({
    where: { role: { in: ["owner", "admin", "responsible"] } },
    select: { id: true },
  });
  const ownerIds = new Set(owners.map((o) => o.id));
  const sourceSystems = [...new Set(rows.map((r) => r.sourceSystem).filter(Boolean))];
  const sourceIds = [...new Set(rows.map((r) => r.sourceId).filter(Boolean))];
  const sourceWhere = sourceSystems.length && sourceIds.length
    ? { sourceSystem: { in: sourceSystems }, sourceId: { in: sourceIds } }
    : null;
  const existingProducts = v.kind === "products" ? await db.product.findMany({
    where: { OR: [{ lot: { in: rows.map((r) => r.lot).filter(Boolean) } }, ...(sourceWhere ? [sourceWhere] : [])] },
  }) : [];
  const existingCustomers = v.kind === "customers" && sourceWhere ? await db.customer.findMany({ where: sourceWhere }) : [];
  const existingCashEntries = v.kind === "cash_entries" && sourceWhere ? await db.cashEntry.findMany({ where: sourceWhere }) : [];
  const lots = new Set(existingProducts.map((p) => p.lot));
  const productsByLot = new Map(existingProducts.map((p) => [p.lot, p]));
  const productsBySource = new Map(existingProducts.map((p) => [`${p.sourceSystem}\u0000${p.sourceId}`, p]));
  const customersBySource = new Map(existingCustomers.map((c) => [`${c.sourceSystem}\u0000${c.sourceId}`, c]));
  const cashBySource = new Map(existingCashEntries.map((c) => [`${c.sourceSystem}\u0000${c.sourceId}`, c]));
  const latestClosure = v.kind === "cash_entries" ? await db.closure.findFirst({ orderBy: { date: "desc" } }) : null;
  const today = businessDate(await getSettings());
  const sourceKeys = new Set<string>();
  let skipped = 0;
  rows.forEach((r, i) => {
    try {
      if (v.kind === "products") {
        const p = productSchema.parse({
          ...r,
          stock: Math.round(Number(r.stock) * 1000),
          minimum: Math.round(Number(r.minimum) * 1000),
          cost: Math.round(Number(r.cost) * 100),
          price: Math.round(Number(r.price) * 100),
          expires: r.expires || null,
          supplier: r.supplier || "",
          sourceSystem: r.sourceSystem || null,
          sourceId: r.sourceId || null,
        });
        if (!p.sourceSystem || !p.sourceId) throw new Error("Cada lote importado requiere sourceSystem y sourceId");
        if (p.unit === "ud" && (p.stock % 1000 !== 0 || p.minimum % 1000 !== 0))
          throw new Error("Las unidades deben ser enteras");
        if (!ownerIds.has(p.ownerId))
          throw new Error("Responsable desconocido");
        const key = `${p.sourceSystem}\u0000${p.sourceId}`;
        if (sourceKeys.has(key)) throw new Error("ID de origen repetido en el archivo");
        sourceKeys.add(key);
        const prior = productsByLot.get(p.lot) || productsBySource.get(key);
        if (prior) {
          if (prior.lot !== p.lot || prior.sourceSystem !== p.sourceSystem || prior.sourceId !== p.sourceId ||
              prior.name !== p.name || prior.strain !== p.strain || prior.type !== p.type || prior.unit !== p.unit ||
              prior.supplier !== p.supplier || prior.stock !== p.stock || prior.minimum !== p.minimum ||
              prior.cost !== p.cost || prior.price !== p.price || prior.location !== p.location ||
              prior.ownerId !== p.ownerId || prior.expires !== p.expires)
            throw new Error("Lote o ID de origen existente con datos diferentes; conciliar antes de importar");
          skipped++;
          return;
        }
        if (lots.has(p.lot)) throw new Error("Lote duplicado");
        lots.add(p.lot);
        data.push(p);
      } else if (v.kind === "cash_entries") {
        const c = cashEntrySchema.parse({
          ...r,
          amount: Math.round(Number(r.amount) * 100),
        });
        validateCashDirection(c.category, c.amount);
        if (c.date > today) throw new Error("Un movimiento real no puede tener fecha futura");
        const key = `${c.sourceSystem}\u0000${c.sourceId}`;
        if (sourceKeys.has(key)) throw new Error("ID de origen repetido en el archivo");
        sourceKeys.add(key);
        const prior = cashBySource.get(key);
        if (prior) {
          if (prior.date !== c.date || prior.account !== c.account || prior.category !== c.category || prior.amount !== c.amount || prior.description !== c.description)
            throw new Error("Movimiento de origen existente con datos diferentes; conciliar antes de importar");
          skipped++;
          return;
        }
        if (c.account === "cash" && latestClosure && latestClosure.date >= c.date)
          throw new Error("Hay un cierre de caja posterior; conciliar antes de importar efectivo");
        data.push(c);
      } else {
        const c = customerSchema.parse({
            ...r,
            email: r.email || "",
            phone: r.phone || "",
            notes: r.notes || "",
            sourceSystem: r.sourceSystem || null,
            sourceId: r.sourceId || null,
          });
        if (!c.sourceSystem || !c.sourceId) throw new Error("Cada socio importado requiere sourceSystem y sourceId");
        const key = `${c.sourceSystem}\u0000${c.sourceId}`;
        if (sourceKeys.has(key)) throw new Error("ID de origen repetido en el archivo");
        sourceKeys.add(key);
        const prior = customersBySource.get(key);
        if (prior) {
          if (prior.name !== c.name || prior.email !== c.email || prior.phone !== c.phone || prior.notes !== c.notes) throw new Error("Socio de origen existente con datos diferentes; conciliar antes de importar");
          skipped++;
          return;
        }
        data.push(c);
      }
    } catch (e) {
      errors.push(
        `Fila ${i + 2}: ${e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") : (e as Error).message}`,
      );
    }
  });
  if (v.commit && errors.length)
    throw new HttpError(400, "Corregí los errores antes de importar");
  if (v.commit)
    await atomic(async (tx) => {
      const importedSuppliers = new Map<string, string>();
      const importedLocations = new Map<string, { id: string; name: string }>();
      for (const row of data) {
        if ("lot" in row) {
          let supplierId: string | null = null;
          if (row.supplier) {
            const key = supplierKey(row.supplier);
            supplierId = importedSuppliers.get(key) || null;
            if (!supplierId) {
              const supplier = await tx.supplier.upsert({
                where: { key },
                create: { name: supplierName(row.supplier), key },
                update: {},
              });
              supplierId = supplier.id;
              importedSuppliers.set(key, supplierId);
            }
          }
          const key = locationKey(row.location);
          let location = importedLocations.get(key);
          if (!location) {
            location = await tx.location.upsert({
              where: { key },
              create: { name: locationName(row.location), key },
              update: {},
              select: { id: true, name: true },
            });
            importedLocations.set(key, location);
          }
          const p = await tx.product.create({ data: { ...row, supplierId, location: location.name, locationId: location.id } });
          await tx.movement.create({
            data: {
              productId: p.id,
              type: "entry",
              quantity: p.stock,
              beforeStock: 0,
              afterStock: p.stock,
              toOwner: p.ownerId,
              userId: req.user.id,
              note: "Importación CSV",
            },
          });
        } else if ("category" in row) await tx.cashEntry.create({ data: { ...row, userId: req.user.id } });
        else await tx.customer.create({ data: row });
      }
    });
  res.json({
    count: data.length,
    skipped,
    errors,
    preview: data.slice(0, 5),
    committed: v.commit,
  });
});
app.get(
  "/api/reports/:format",
  roles("owner", "admin", "responsible", "viewer"),
  async (req, res) => {
    const format = z.enum(["csv", "xlsx", "pdf"]).parse(req.params.format);
    const owner =
      typeof req.query.owner === "string" ? req.query.owner : undefined;
    const from = req.query.from ? date.parse(req.query.from) : undefined;
    const to = req.query.to ? date.parse(req.query.to) : undefined;
    if (from && to && from > to) throw new HttpError(400, "Rango inválido");
    await exportReport(res, req.user, owner, format, from, to);
  },
);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Ruta no encontrada" }),
);
if (existsSync(resolve("dist/index.html"))) {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
}
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError)
    return res
      .status(400)
      .json({
        error: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      });
  if (error instanceof HttpError)
    return res.status(error.status).json({ error: error.message });
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002")
      return res
        .status(409)
        .json({ error: "Ya existe un registro con esos datos" });
    if (error.code === "P2025")
      return res.status(404).json({ error: "Registro no encontrado" });
  }
  console.error(error);
  res
    .status(500)
    .json({ error: "No se pudo completar la operación. Reintentá." });
});
