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
import { getState, publicUser, ownerScope } from "./state.js";
import {
  productSchema,
  customerSchema,
  saleSchema,
  expenseSchema,
  settingsSchema,
  date,
  HttpError,
} from "./validation.js";
import { exportReport } from "./reports.js";
declare global {
  namespace Express {
    interface Request {
      user: User;
    }
  }
}
const demo = process.env.DEMO_MODE === "true";
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
app.get("/api/state", async (req, res) =>
  res.json(
    await getState(
      req.user,
      typeof req.query.owner === "string" ? req.query.owner : undefined,
    ),
  ),
);
app.get("/api/movements", async (req, res) => {
  const page = z.coerce
    .number()
    .int()
    .min(1)
    .max(100000)
    .parse(req.query.page || 1);
  const ownerId = ownerScope(
    req.user,
    typeof req.query.owner === "string" ? req.query.owner : undefined,
  );
  const where: Prisma.MovementWhereInput = ownerId
    ? { OR: [{ fromOwner: ownerId }, { toOwner: ownerId }] }
    : {};
  const [rows, total] = await Promise.all([
    db.movement.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * 100,
      take: 100,
    }),
    db.movement.count({ where }),
  ]);
  res.json({ rows, total });
});
async function validOwner(id: string) {
  const owner = await db.user.findUnique({ where: { id } });
  if (!owner || !["responsible", "owner", "admin"].includes(owner.role))
    throw new HttpError(400, "Responsable inválido");
}
app.post(
  "/api/products",
  roles("owner", "admin", "responsible"),
  async (req, res) => {
    const v = productSchema.parse(req.body);
    if (v.unit === "ud" && (v.stock % 1000 !== 0 || v.minimum % 1000 !== 0))
      throw new HttpError(400, "El stock de unidades debe ser entero");
    if (req.user.role === "responsible" && v.ownerId !== req.user.id)
      throw new HttpError(403, "Solo podés crear lotes propios");
    await validOwner(v.ownerId);
    const product = await atomic(async (tx) => {
      const p = await tx.product.create({ data: v });
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
      .omit({ stock: true, ownerId: true })
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
    const result = await db.product.updateMany({
      where: {
        id: String(req.params.id),
        ...(req.user.role === "responsible" ? { ownerId: req.user.id } : {}),
      },
      data: v,
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
  async (req, res) =>
    res
      .status(201)
      .json(await db.customer.create({ data: customerSchema.parse(req.body) })),
);
app.patch(
  "/api/customers/:id",
  roles("owner", "admin", "cashier"),
  async (req, res) =>
    res.json(
      await db.customer.update({
        where: { id: String(req.params.id) },
        data: customerSchema.parse(req.body),
      }),
    ),
);
app.post(
  "/api/sales",
  roles("owner", "admin", "cashier", "responsible"),
  async (req, res) => {
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
          throw new HttpError(403, "Producto fuera de tu reprogram");
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
      throw new HttpError(403, "Asigná el gasto a tu reprogram");
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
        const expected =
          (
            await tx.sale.aggregate({
              where: { date: today, payment: "cash" },
              _sum: { total: true },
            })
          )._sum.total || 0;
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
      kind: z.enum(["products", "customers"]),
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
  )[] = [];
  const owners = await db.user.findMany({
    where: { role: { in: ["owner", "admin", "responsible"] } },
    select: { id: true },
  });
  const lots = new Set(
    (await db.product.findMany({ select: { lot: true } })).map((p) => p.lot),
  );
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
        });
        if (p.unit === "ud" && (p.stock % 1000 !== 0 || p.minimum % 1000 !== 0))
          throw new Error("Las unidades deben ser enteras");
        if (!owners.some((o) => o.id === p.ownerId))
          throw new Error("Responsable desconocido");
        if (lots.has(p.lot)) throw new Error("Lote duplicado");
        lots.add(p.lot);
        data.push(p);
      } else
        data.push(
          customerSchema.parse({
            ...r,
            email: r.email || "",
            phone: r.phone || "",
            notes: r.notes || "",
          }),
        );
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
      for (const row of data) {
        if ("lot" in row) {
          const p = await tx.product.create({ data: row });
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
        } else await tx.customer.create({ data: row });
      }
    });
  res.json({
    count: data.length,
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
    await exportReport(res, await getState(req.user, owner), format, from, to);
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
