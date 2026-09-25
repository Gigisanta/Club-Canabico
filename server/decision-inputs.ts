import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { atomic, db, getSettings } from "./db.js";
import { businessDate } from "../shared/domain.js";
import { HttpError } from "./validation.js";

export const decisionInputs = Router();
const int64Min = -(2n ** 63n);
const int64Max = 2n ** 63n - 1n;
const date = z.iso.date();
const cents = z.string().regex(/^-?(?:0|[1-9]\d*)$/).refine((value) => {
  try { const amount = BigInt(value); return amount >= int64Min && amount <= int64Max; }
  catch { return false; }
}, "Importe fuera del rango de 64 bits");
const nonnegativeCents = cents.refine((value) => BigInt(value) >= 0n);
const sourceReference = z.string().trim().min(3).max(240);
const id = z.string().min(1).max(120);
const locationIds = z.array(id).max(200).refine((values) => new Set(values).size === values.length, "Ubicaciones repetidas");
const scenario = z.enum(["low", "base", "high"]);
const cashCategory = z.enum(["sale", "operating_expense", "stock_purchase", "local_investment", "capital_contribution",
  "owner_draw", "delivery_receipt", "other_income", "other_outflow", "adjustment"]);
const iso = (value: Date) => value.toISOString().slice(0, 10);
const dbDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const safe = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) =>
  typeof item === "bigint" ? item.toString() : item));

function manager(role: string) {
  if (role !== "owner" && role !== "admin") throw new HttpError(403, "No tenés acceso a insumos financieros");
}

async function requireProduct(productId: string) {
  const product = await db.product.findUnique({ where: { id: productId }, select: { id: true, supplierId: true, supplier: true } });
  if (!product) throw new HttpError(400, "Lote inexistente");
  return product;
}

async function requireLocations(ids: string[]) {
  if (!ids.length) return;
  const count = await db.location.count({ where: { id: { in: ids }, active: true } });
  if (count !== ids.length) throw new HttpError(400, "Hay ubicaciones inexistentes o inactivas");
}

type MappingRow = { id: string; status: string; sharedLocationIds: unknown; localLocationIds: unknown; deliveryLocationIds: unknown;
  reference: string; confirmedAt: Date };
type RuleRow = { productId: string; leadTimeDays: number; minimumOrderQuantityMilliunits: number; reviewPeriodDays: number;
  sourceReference: string; updatedAt: Date };
type QuoteRow = { id: string; productId: string; quotedOn: Date; validUntil: Date | null; unitCostCentsPerUnit: bigint;
  sourceReference: string; status: string };
type InboundRow = { id: string; productId: string; locationId: string | null; quantityMilliunits: number; arrivalDate: Date;
  status: string; sourceReference: string };
type CashSnapshotRow = { id: string; asOf: Date; floorCents: bigint; sourceReference: string; complete: boolean;
  accounts: unknown };
type CashPlanRow = { id: string; scenario: string; date: Date; account: string; category: string; amountCents: bigint;
  sourceReference: string; status: string };
type AttestationRow = { id: string; domain: string; scenario: string | null; fromDate: Date; throughDate: Date;
  complete: boolean; sourceReference: string; confirmedAt: Date };

export async function decisionInputsSnapshot() {
  const [products, locations, suppliers, mappingRows, ruleRows, quotes, inbounds, snapshots, plans, attestations] = await Promise.all([
    db.product.findMany({ select: { id: true, name: true, lot: true, unit: true, locationId: true, supplierId: true }, orderBy: { name: "asc" } }),
    db.location.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.supplier.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.$queryRaw<MappingRow[]>`SELECT * FROM "DecisionStockMapping" ORDER BY "confirmedAt" DESC, id DESC LIMIT 1`,
    db.$queryRaw<RuleRow[]>`SELECT DISTINCT ON ("productId") "productId", "leadTimeDays", "minimumOrderQuantityMilliunits", "reviewPeriodDays", "sourceReference", "updatedAt"
      FROM "DecisionSupplierRule" ORDER BY "productId", "updatedAt" DESC, id DESC`,
    db.$queryRaw<QuoteRow[]>`SELECT id, "productId", "quotedOn", "validUntil", "unitCostCentsPerUnit", "sourceReference", status
      FROM "DecisionReplacementQuote" ORDER BY "quotedOn" DESC, "createdAt" DESC LIMIT 500`,
    db.$queryRaw<InboundRow[]>`SELECT id, "productId", "locationId", "quantityMilliunits", "arrivalDate", status, "sourceReference"
      FROM "DecisionInboundOrder" ORDER BY "arrivalDate" ASC LIMIT 500`,
    db.$queryRaw<CashSnapshotRow[]>`SELECT s.id, s."asOf", s."floorCents", s."sourceReference", s.complete,
      COALESCE(jsonb_agg(jsonb_build_object('account', a.account, 'amountCents', a."amountCents"::text)
        ORDER BY a.account) FILTER (WHERE a.account IS NOT NULL), '[]'::jsonb) AS accounts
      FROM "DecisionCashSnapshot" s LEFT JOIN "DecisionCashSnapshotAccount" a ON a."snapshotId" = s.id
      GROUP BY s.id ORDER BY s."asOf" DESC, s."reconciledAt" DESC LIMIT 100`,
    db.$queryRaw<CashPlanRow[]>`SELECT id, scenario, date, account, category, "amountCents", "sourceReference", status
      FROM "DecisionCashPlanEvent" ORDER BY date ASC, id ASC LIMIT 1000`,
    db.$queryRaw<AttestationRow[]>`SELECT id, domain, scenario, "fromDate", "throughDate", complete, "sourceReference", "confirmedAt"
      FROM "DecisionInputAttestation" ORDER BY "confirmedAt" DESC, id DESC LIMIT 200`,
  ]);
  return safe({
    products, locations, suppliers,
    mapping: mappingRows[0] ?? null,
    rules: ruleRows,
    quotes: quotes.map((row) => ({ ...row, quotedOn: iso(row.quotedOn), validUntil: row.validUntil ? iso(row.validUntil) : null })),
    inbounds: inbounds.map((row) => ({ ...row, arrivalDate: iso(row.arrivalDate) })),
    cashSnapshots: snapshots.map((row) => ({ ...row, asOf: iso(row.asOf) })),
    cashPlans: plans.map((row) => ({ ...row, date: iso(row.date) })),
    attestations: attestations.map((row) => ({ ...row, fromDate: iso(row.fromDate), throughDate: iso(row.throughDate) })),
  });
}

decisionInputs.get("/decision-inputs", async (req, res) => {
  manager(req.user.role);
  await db.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "decision_inputs", action: "read" } });
  res.json(await decisionInputsSnapshot());
});

decisionInputs.post("/decision-inputs/mapping", async (req, res) => {
  manager(req.user.role);
  const input = z.object({ status: z.enum(["shared", "separate"]), sharedLocationIds: locationIds,
    localLocationIds: locationIds, deliveryLocationIds: locationIds, reference: sourceReference }).strict().parse(req.body);
  const all = [...new Set([...input.sharedLocationIds, ...input.localLocationIds, ...input.deliveryLocationIds])];
  await requireLocations(all);
  if (!input.localLocationIds.length || !input.deliveryLocationIds.length)
    throw new HttpError(400, "Identificá las ubicaciones del local y del delivery");
  if (input.status === "shared") {
    const pool = new Set(input.sharedLocationIds);
    if (!pool.size || [...input.localLocationIds, ...input.deliveryLocationIds].some((value) => !pool.has(value)))
      throw new HttpError(400, "Ambos canales deben pertenecer al stock compartido declarado");
  } else if (input.sharedLocationIds.length || input.localLocationIds.some((value) => input.deliveryLocationIds.includes(value))) {
    throw new HttpError(400, "El stock separado necesita ubicaciones distintas por canal");
  }
  const rowId = randomUUID();
  await atomic(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DecisionStockMapping" (id, status, "sharedLocationIds", "localLocationIds", "deliveryLocationIds", reference, "confirmedByUserId")
      VALUES (${rowId}, ${input.status}, ${JSON.stringify(input.sharedLocationIds)}::jsonb,
        ${JSON.stringify(input.localLocationIds)}::jsonb, ${JSON.stringify(input.deliveryLocationIds)}::jsonb,
        ${input.reference}, ${req.user.id})`;
    await tx.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "stock_mapping", action: "confirm" } });
  });
  res.status(201).json({ id: rowId, status: input.status });
});

decisionInputs.post("/decision-inputs/rules", async (req, res) => {
  manager(req.user.role);
  const input = z.object({ productId: id, leadTimeDays: z.number().int().min(0).max(365),
    minimumOrderQuantityMilliunits: z.number().int().min(0).safe(), reviewPeriodDays: z.number().int().min(1).max(365),
    sourceReference }).strict().parse(req.body);
  await requireProduct(input.productId);
  const rowId = randomUUID();
  await atomic(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DecisionSupplierRule" (id, "productId", "leadTimeDays", "minimumOrderQuantityMilliunits", "reviewPeriodDays", "sourceReference", "confirmedByUserId", "updatedAt")
      VALUES (${rowId}, ${input.productId}, ${input.leadTimeDays}, ${input.minimumOrderQuantityMilliunits},
        ${input.reviewPeriodDays}, ${input.sourceReference}, ${req.user.id}, CURRENT_TIMESTAMP)`;
    await tx.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "supplier_rule", action: "confirm" } });
  });
  res.status(201).json({ id: rowId, productId: input.productId });
});

decisionInputs.post("/decision-inputs/quotes", async (req, res) => {
  manager(req.user.role);
  const input = z.object({ productId: id, quotedOn: date, validUntil: date.nullable(),
    unitCostCentsPerUnit: nonnegativeCents, sourceReference }).strict().parse(req.body);
  await requireProduct(input.productId);
  if (input.validUntil && input.validUntil < input.quotedOn) throw new HttpError(400, "La vigencia precede la cotización");
  const rowId = randomUUID();
  await atomic(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DecisionReplacementQuote" (id, "productId", "quotedOn", "validUntil", "unitCostCentsPerUnit", "sourceReference", "enteredByUserId")
      VALUES (${rowId}, ${input.productId}, ${input.quotedOn}::date, ${input.validUntil}::date,
        ${BigInt(input.unitCostCentsPerUnit)}, ${input.sourceReference}, ${req.user.id})`;
    await tx.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "replacement_quote", action: "create" } });
  });
  res.status(201).json({ id: rowId, productId: input.productId });
});

decisionInputs.post("/decision-inputs/inbounds", async (req, res) => {
  manager(req.user.role);
  const input = z.object({ productId: id, locationId: id.nullable(), quantityMilliunits: z.number().int().positive().safe(),
    arrivalDate: date, sourceReference }).strict().parse(req.body);
  await requireProduct(input.productId);
  if (input.locationId) await requireLocations([input.locationId]);
  const rowId = randomUUID();
  await atomic(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DecisionInboundOrder" (id, "productId", "locationId", "quantityMilliunits", "arrivalDate", "sourceReference", "enteredByUserId")
      VALUES (${rowId}, ${input.productId}, ${input.locationId}, ${input.quantityMilliunits}, ${input.arrivalDate}::date, ${input.sourceReference}, ${req.user.id})`;
    await tx.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "inbound_order", action: "create" } });
  });
  res.status(201).json({ id: rowId, productId: input.productId });
});

decisionInputs.post("/decision-inputs/cash-snapshots", async (req, res) => {
  manager(req.user.role);
  const input = z.object({ asOf: date, floorCents: nonnegativeCents, sourceReference, complete: z.boolean(),
    accounts: z.array(z.object({ account: z.string().trim().min(2).max(80), amountCents: cents }).strict()).min(1).max(50),
  }).strict().parse(req.body);
  const today = businessDate(await getSettings());
  if (input.asOf > today) throw new HttpError(400, "El saldo conciliado no puede tener fecha futura");
  if (new Set(input.accounts.map((row) => row.account.toLowerCase())).size !== input.accounts.length)
    throw new HttpError(400, "Hay cuentas repetidas");
  const total = input.accounts.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  if (total < int64Min || total > int64Max) throw new HttpError(400, "El saldo total excede 64 bits");
  const rowId = randomUUID();
  await atomic(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DecisionCashSnapshot" (id, "asOf", "floorCents", "sourceReference", complete, "reconciledByUserId")
      VALUES (${rowId}, ${input.asOf}::date, ${BigInt(input.floorCents)}, ${input.sourceReference}, ${input.complete}, ${req.user.id})`;
    for (const account of input.accounts) {
      await tx.$executeRaw`INSERT INTO "DecisionCashSnapshotAccount" ("snapshotId", account, "amountCents")
        VALUES (${rowId}, ${account.account}, ${BigInt(account.amountCents)})`;
    }
    await tx.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "cash_snapshot", action: "reconcile" } });
  });
  res.status(201).json({ id: rowId, totalCents: total.toString(), complete: input.complete });
});

decisionInputs.post("/decision-inputs/cash-plans", async (req, res) => {
  manager(req.user.role);
  const input = z.object({ scenario, date, account: z.string().trim().min(2).max(80), category: cashCategory,
    amountCents: cents.refine((value) => BigInt(value) !== 0n), sourceReference }).strict().parse(req.body);
  const today = businessDate(await getSettings());
  if (input.date <= today) throw new HttpError(400, "La partida planificada debe tener fecha futura");
  const positive = ["sale", "capital_contribution", "delivery_receipt", "other_income"].includes(input.category);
  const negative = ["operating_expense", "stock_purchase", "local_investment", "owner_draw", "other_outflow"].includes(input.category);
  const amount = BigInt(input.amountCents);
  if ((positive && amount < 0n) || (negative && amount > 0n))
    throw new HttpError(400, "El signo no coincide con el tipo de cobro o pago");
  const rowId = randomUUID();
  await atomic(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DecisionCashPlanEvent" (id, scenario, date, account, category, "amountCents", "sourceReference", "enteredByUserId")
      VALUES (${rowId}, ${input.scenario}, ${input.date}::date, ${input.account}, ${input.category}, ${amount}, ${input.sourceReference}, ${req.user.id})`;
    await tx.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "cash_plan_event", action: "create" } });
  });
  res.status(201).json({ id: rowId });
});

decisionInputs.post("/decision-inputs/attestations", async (req, res) => {
  manager(req.user.role);
  const input = z.object({ domain: z.enum(["delivery_sales", "cash_plan"]), scenario: scenario.nullable(),
    fromDate: date, throughDate: date, complete: z.boolean(), sourceReference }).strict().parse(req.body);
  if (input.fromDate > input.throughDate) throw new HttpError(400, "El inicio debe preceder el cierre");
  if ((dbDate(input.throughDate).getTime() - dbDate(input.fromDate).getTime()) / 86_400_000 > 730)
    throw new HttpError(400, "Certificá períodos de hasta dos años");
  if ((input.domain === "delivery_sales") !== (input.scenario === null))
    throw new HttpError(400, "El escenario solo corresponde al plan de caja");
  const today = businessDate(await getSettings());
  if (input.domain === "delivery_sales") {
    if (input.throughDate > today) throw new HttpError(400, "No se puede certificar historia futura");
    const match = /^batch:([0-9a-f-]{36})$/i.exec(input.sourceReference);
    const batch = match ? await db.historicalImportBatch.findUnique({ where: { id: match[1] }, include: { reconciliation: true } }) : null;
    if (!batch || batch.kind !== "delivery_sales" || batch.status !== "reconciled" || !batch.reconciliation ||
        batch.reconciliation.varianceCents !== 0n)
      throw new HttpError(400, "La fuente delivery debe ser un lote conciliado (batch:<id>)");
    if (input.complete) {
      if (!batch.reconciliation.coverageComplete || !batch.reconciliation.coverageFrom || !batch.reconciliation.coverageThrough ||
          iso(batch.reconciliation.coverageFrom) > input.fromDate ||
          iso(batch.reconciliation.coverageThrough) < input.throughDate || iso(batch.cutoffDate) < input.throughDate)
        throw new HttpError(400, "La cobertura completa requiere un lote delivery conciliado con rango validado (batch:<id>)");
    }
  } else if (input.fromDate <= today) {
    throw new HttpError(400, "El plan de caja certificado debe empezar después de hoy");
  }
  const rowId = randomUUID();
  await atomic(async (tx) => {
    await tx.$executeRaw`INSERT INTO "DecisionInputAttestation" (id, domain, scenario, "fromDate", "throughDate", complete, "sourceReference", "confirmedByUserId")
      VALUES (${rowId}, ${input.domain}, ${input.scenario}, ${input.fromDate}::date, ${input.throughDate}::date,
        ${input.complete}, ${input.sourceReference}, ${req.user.id})`;
    await tx.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: "data_coverage", action: "attest" } });
  });
  res.status(201).json({ id: rowId, complete: input.complete });
});

for (const [type, table] of [
  ["quotes", "DecisionReplacementQuote"], ["inbounds", "DecisionInboundOrder"], ["cash-plans", "DecisionCashPlanEvent"],
] as const) {
  decisionInputs.patch(`/decision-inputs/${type}/:id`, async (req, res) => {
    manager(req.user.role);
    const input = z.object({ status: type === "inbounds" ? z.enum(["pending", "received", "cancelled"]) : z.enum(["active", "cancelled"]) }).strict().parse(req.body);
    const targetId = z.uuid().parse(String(req.params.id));
    const changed = await atomic(async (tx) => {
      const count = table === "DecisionReplacementQuote"
        ? await tx.$executeRaw`UPDATE "DecisionReplacementQuote" SET status = ${input.status} WHERE id = ${targetId}`
        : table === "DecisionInboundOrder"
          ? await tx.$executeRaw`UPDATE "DecisionInboundOrder" SET status = ${input.status} WHERE id = ${targetId}`
          : await tx.$executeRaw`UPDATE "DecisionCashPlanEvent" SET status = ${input.status} WHERE id = ${targetId}`;
      if (count) await tx.sensitiveAccessAudit.create({ data: { userId: req.user.id, area: type, action: "status_change" } });
      return count;
    });
    if (!changed) throw new HttpError(404, "Insumo inexistente");
    res.json({ id: targetId, status: input.status });
  });
}
