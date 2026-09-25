import { Router } from "express";
import { z } from "zod";
import { db, getSettings } from "./db.js";
import { businessDate } from "../shared/domain.js";
import type {
  DecisionCard,
  DecisionCenterPayload,
  DecisionTaskView,
  MonthlyReviewView,
  EvidenceState,
} from "../shared/decision-center.js";
import { HttpError } from "./validation.js";

export const decisionCenter = Router();
const CALCULATION_VERSION = "decision-v1";
const date = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const evidence = z.enum(["demo", "missing", "imported", "reconciled", "estimated", "scenario"]);
const cents = z.string().regex(/^-?(?:0|[1-9]\d*)$/).refine((value) => {
  try {
    const amount = BigInt(value);
    return amount >= -(2n ** 63n) && amount <= 2n ** 63n - 1n;
  } catch { return false; }
}, "Importe fuera del rango de 64 bits");

function requireFinanceRole(role: string) {
  if (role !== "owner" && role !== "admin") throw new HttpError(403, "No tenés acceso a decisiones financieras");
}

async function audit(userId: string, area: string, action: string) {
  await db.sensitiveAccessAudit.create({ data: { userId, area, action } });
}

function offset(value: string, days: number) {
  const target = new Date(`${value}T12:00:00Z`);
  target.setUTCDate(target.getUTCDate() + days);
  return target.toISOString().slice(0, 10);
}

const dbDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const uiDate = (value: Date) => value.toISOString().slice(0, 10);

function dueDate(today: string, weekday: number) {
  const current = new Date(`${today}T12:00:00Z`).getUTCDay();
  return offset(today, weekday - current);
}

const taskTemplates = [
  { key: "reconcile", title: "Conciliar caja y banco", cadence: "weekly", weekday: 1, owner: "gio" },
  { key: "stock", title: "Contar stock y registrar faltantes", cadence: "weekly", weekday: 6, owner: "tiziano" },
  { key: "purchases", title: "Revisar compras y plazos de proveedores", cadence: "weekly", weekday: 0, owner: "tiziano" },
  { key: "promotions", title: "Revisar precios y promociones", cadence: "weekly", weekday: 0, owner: "camila" },
  { key: "members", title: "Revisar segmentos de socios", cadence: "monthly", day: 5, owner: "camila" },
  { key: "monthly", title: "Revisar resultado, desvíos y decisiones", cadence: "monthly", day: 10, owner: "gio" },
] as const;

async function ensureCurrentTasks(today: string, users: { id: string; name: string }[]) {
  const records = taskTemplates.map((template) => {
    const due = template.cadence === "weekly"
      ? dueDate(today, template.weekday)
      : `${today.slice(0, 7)}-${String(template.day).padStart(2, "0")}`;
    const owner = users.find((user) => user.name.toLocaleLowerCase("es-AR").includes(template.owner));
    return {
      id: `decision:${template.key}:${due}`,
      title: template.title,
      ownerId: owner?.id ?? null,
      dueDate: dbDate(due),
      cadence: template.cadence,
      status: "todo" as const,
    };
  });
  await db.decisionTask.createMany({ data: records, skipDuplicates: true });
}

function taskView(
  row: { id: string; title: string; ownerId: string | null; dueDate: Date; cadence: string; status: string },
  users: Map<string, string>,
): DecisionTaskView {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.ownerId,
    ownerName: row.ownerId ? users.get(row.ownerId) || "Usuario anterior" : "Sin asignar",
    dueDate: uiDate(row.dueDate),
    cadence: row.cadence as DecisionTaskView["cadence"],
    status: row.status as DecisionTaskView["status"],
  };
}

function reviewView(
  row: { id: string; period: string; metric: string; actualCents: bigint | null; planCents: bigint | null; cause: string; decision: string; ownerId: string | null; followUpDate: Date | null; source: string; evidence: string },
  users: Map<string, string>,
): MonthlyReviewView {
  return {
    id: row.id,
    period: row.period,
    metric: row.metric,
    actualCents: row.actualCents?.toString() ?? null,
    planCents: row.planCents?.toString() ?? null,
    deviationCents: row.actualCents !== null && row.planCents !== null ? (row.actualCents - row.planCents).toString() : null,
    cause: row.cause,
    decision: row.decision,
    ownerId: row.ownerId,
    ownerName: row.ownerId ? users.get(row.ownerId) || "Usuario anterior" : "Sin asignar",
    followUpDate: row.followUpDate ? uiDate(row.followUpDate) : null,
    source: row.source,
    evidence: row.evidence as EvidenceState,
  };
}

export async function decisionCenterPayload(): Promise<DecisionCenterPayload> {
  const today = businessDate(await getSettings());
  const demo = process.env.DEMO_MODE === "true";
  const users = await db.user.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  await ensureCurrentTasks(today, users);
  const start = `${today.slice(0, 7)}-01`;
  const [products, lowLots, localSales, reconciledCashToday, plans, tasks, reviews, importedBatches, rejectedImports] = await Promise.all([
    db.product.count(),
    db.product.count({ where: { stock: { lte: db.product.fields.minimum } } }),
    db.sale.count({ where: { channel: "local", date: { gte: start, lte: today } } }),
    db.decisionCashSnapshot.count({ where: { asOf: dbDate(today), complete: true } }),
    db.decisionCashPlanEvent.count({ where: { date: { gt: dbDate(today) }, status: "active" } }),
    db.decisionTask.findMany({ orderBy: [{ dueDate: "asc" }, { title: "asc" }], take: 100 }),
    db.monthlyReview.findMany({ orderBy: [{ period: "desc" }, { createdAt: "desc" }], take: 24 }),
    db.historicalImportBatch.findMany({ where: { status: { in: ["imported", "reconciled"] } }, orderBy: { importedAt: "desc" }, select: {
      kind: true, status: true, sourceSystem: true, cutoffDate: true,
      reconciliation: { select: { id: true, coverageComplete: true, varianceCents: true } },
    } }),
    db.historicalImportBatch.findMany({ where: { status: "rejected" }, select: { conflicts: true } }),
  ]);
  const latestImport = importedBatches[0];
  const status: EvidenceState = demo ? "demo" : latestImport ? "imported" : "missing";
  const sourceEvidence = (kinds: string[]): EvidenceState => {
    if (demo) return "demo";
    const matches = importedBatches.filter((batch) => kinds.includes(batch.kind));
    if (!matches.length) return "missing";
    return kinds.every((kind) => matches.some((batch) => batch.kind === kind && batch.status === "reconciled" &&
      batch.reconciliation?.coverageComplete && batch.reconciliation.varianceCents === 0n)) &&
      matches.every((batch) => batch.status === "reconciled") ? "reconciled" : "imported";
  };
  const pendingConflicts = rejectedImports.reduce((count, batch) => {
    const issues = Array.isArray(batch.conflicts) ? batch.conflicts : [];
    return count + issues.length;
  }, 0);
  const cards: [DecisionCard, DecisionCard, DecisionCard] = [
    {
      kind: "replenishment",
      title: "Qué comprar",
      summary: products === 0
        ? "Faltan lotes y conteo físico para calcular existencias."
        : lowLots > 0
          ? `${lowLots} ${lowLots === 1 ? "lote está" : "lotes están"} bajo el mínimo cargado.`
          : "Los lotes registrados no están bajo su mínimo cargado.",
      nextStep: "Validar conteo, disponibilidad, pedidos pendientes y plazo de proveedores.",
      path: "/app/decisiones/stock",
      owner: "Tiziano",
      evidence: sourceEvidence(["stock", "purchases"]),
      source: products ? "Lotes registrados en Bombo" : "Sin fuente de stock confirmada",
      asOf: today,
      calculationVersion: CALCULATION_VERSION,
      impactCents: null,
      quantityMilli: null,
      limitation: "Tiziano debe confirmar si delivery y local comparten stock; no se suma ni recomienda una compra conjunta.",
    },
    {
      kind: "commercial",
      title: "Qué precio o promoción revisar",
      summary: localSales
        ? `${localSales} ventas locales este mes. Falta contrastar descuentos, costos y ventas de delivery.`
        : "Faltan ventas y costos conciliados para comparar promociones.",
      nextStep: "Cargar comprobantes, cotizaciones y promociones; preparar la propuesta para revisión humana.",
      path: "/app/decisiones/comercial",
      owner: "Camila y Tiziano",
      evidence: sourceEvidence(["delivery_sales", "promotions", "purchases"]),
      source: localSales ? "Ventas locales de Bombo" : "Sin ventas conciliadas",
      asOf: today,
      calculationVersion: CALCULATION_VERSION,
      impactCents: null,
      quantityMilli: null,
      limitation: "Una comparación histórica es descriptiva; no demuestra que la promoción causó ventas adicionales.",
    },
    {
      kind: "cash",
      title: "Qué permite la caja",
      summary: reconciledCashToday
        ? `Saldo de caja conciliado hoy; ${plans} partidas futuras activas en escenarios.`
        : "Falta un saldo del día conciliado para proyectar caja utilizable.",
      nextStep: "Conciliar saldos y vencimientos de cobros, pagos e inversiones antes de comprometer compras o contratación.",
      path: "/app/decisiones/caja",
      owner: "Gio y Tiziano",
      evidence: reconciledCashToday ? "scenario" : "missing",
      source: reconciledCashToday ? "Saldo por cuenta y planes de caja de Bombo" : "Sin saldo del día conciliado",
      asOf: today,
      calculationVersion: CALCULATION_VERSION,
      impactCents: null,
      quantityMilli: null,
      limitation: "El resultado y el valor del inventario no equivalen al dinero disponible.",
    },
  ];
  const userNames = new Map(users.map((user) => [user.id, user.name]));
  return {
    asOf: today,
    demo,
    cards,
    dataQuality: {
      state: status,
      latestCutoff: latestImport ? uiDate(latestImport.cutoffDate) : null,
      latestSource: latestImport?.sourceSystem ?? null,
      pendingConflicts,
      note: demo
        ? "Datos de demostración: no sirven para decisiones del negocio real."
        : latestImport
          ? latestImport.reconciliation
            ? "La última fuente tiene conciliación registrada. Comprobar la cobertura de todas las fuentes antes de decidir."
            : "La última fuente fue importada, pero aún falta conciliarla con sus comprobantes."
          : "Faltan archivos históricos y conciliación con AppSheet, comprobantes y caja/banco.",
    },
    tasks: tasks.map((task) => taskView(task, userNames)),
    reviews: reviews.map((review) => reviewView(review, userNames)),
    users,
  };
}

async function assertOwner(id: string | null | undefined) {
  if (id === null || id === undefined) return;
  const exists = await db.user.count({ where: { id } });
  if (!exists) throw new HttpError(400, "Responsable inválido");
}

decisionCenter.get("/decision-center", async (req, res) => {
  requireFinanceRole(req.user.role);
  await audit(req.user.id, "decision_center", "read");
  res.json(await decisionCenterPayload());
});

decisionCenter.put("/decision-tasks/:id", async (req, res) => {
  requireFinanceRole(req.user.role);
  await audit(req.user.id, "decision_task", "update");
  const input = z.object({
    status: z.enum(["todo", "doing", "done"]).optional(),
    ownerId: z.string().nullable().optional(),
    dueDate: date.optional(),
  }).strict().parse(req.body);
  await assertOwner(input.ownerId);
  const current = await db.decisionTask.findUnique({ where: { id: String(req.params.id) } });
  if (!current) throw new HttpError(404, "Tarea no encontrada");
  const task = await db.decisionTask.update({ where: { id: current.id }, data: {
    ...input,
    ...(input.dueDate ? { dueDate: dbDate(input.dueDate) } : {}),
  } });
  const users = await db.user.findMany({ select: { id: true, name: true } });
  res.json(taskView(task, new Map(users.map((user) => [user.id, user.name]))));
});

decisionCenter.post("/monthly-reviews", async (req, res) => {
  requireFinanceRole(req.user.role);
  await audit(req.user.id, "monthly_review", "create");
  const input = z.object({
    period: month,
    metric: z.string().trim().min(2).max(120),
    actualCents: cents.nullable(),
    planCents: cents.nullable(),
    cause: z.string().trim().max(500),
    decision: z.string().trim().min(3).max(500),
    ownerId: z.string().nullable(),
    followUpDate: date.nullable(),
    source: z.string().trim().min(2).max(180),
    evidence,
  }).strict().parse(req.body);
  await assertOwner(input.ownerId);
  if (input.evidence === "reconciled")
    throw new HttpError(400, "Una revisión manual no puede declararse conciliada sin vincular y recalcular la fuente");
  const review = await db.monthlyReview.create({ data: {
    ...input,
    actualCents: input.actualCents === null ? null : BigInt(input.actualCents),
    planCents: input.planCents === null ? null : BigInt(input.planCents),
    deviationCents: input.actualCents === null || input.planCents === null
      ? null : BigInt(input.actualCents) - BigInt(input.planCents),
    followUpDate: input.followUpDate ? dbDate(input.followUpDate) : null,
  } });
  const users = await db.user.findMany({ select: { id: true, name: true } });
  res.status(201).json(reviewView(review, new Map(users.map((user) => [user.id, user.name]))));
});
