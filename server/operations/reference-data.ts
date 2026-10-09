import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { locationKey, locationName } from "../locations.js";
import { supplierKey, supplierName } from "../suppliers.js";
import { audit, capabilities, objectScope, OperationError, registerCommand, requireCapability, wire, type CommandContext, type Tx } from "./core.js";

const referenceEvidence = z.strictObject({ note: z.string().trim().min(1).max(2000) });

const supplierFields = {
  name: z.string().trim().min(1).max(180),
  contactName: z.string().trim().max(180).default(""),
  phone: z.string().trim().max(40).default(""),
  email: z.union([z.email(), z.literal("")]).default(""),
  notes: z.string().trim().max(2000).default(""),
  isDefault: z.boolean().default(false),
};
const supplierCreateSchema = z.strictObject({ ...supplierFields, evidence: referenceEvidence });
const supplierUpdateSchema = z.strictObject({ ...supplierFields, active: z.boolean(), evidence: referenceEvidence });
const locationFields = { name: z.string().trim().min(1).max(180), isDefault: z.boolean().default(false) };
const locationCreateSchema = z.strictObject({ ...locationFields, evidence: referenceEvidence });
const locationUpdateSchema = z.strictObject({ ...locationFields, active: z.boolean(), evidence: referenceEvidence });

/** Reference catalogs are global administration surfaces; scoped grants cannot use them to mutate global names. */
async function requireFullReferenceScope(tx: Tx, actor: CommandContext["actor"]) {
  const scope = await objectScope(tx, actor);
  if (Object.values(scope).some(value => value !== undefined))
    throw new OperationError(403, "REFERENCE_FULL_SCOPE_REQUIRED", "La administración de referencias requiere alcance operativo completo");
}

async function ensureSupplierKeyAvailable(tx: Tx, name: string, exceptId?: string) {
  const existing = await tx.supplier.findUnique({ where: { key: supplierKey(name) }, select: { id: true } });
  if (existing && existing.id !== exceptId)
    throw new OperationError(409, "SUPPLIER_NAME_IN_USE", "Ya existe un proveedor con ese nombre");
}

async function ensureLocationKeyAvailable(tx: Tx, name: string, exceptId?: string) {
  const existing = await tx.location.findUnique({ where: { key: locationKey(name) }, select: { id: true } });
  if (existing && existing.id !== exceptId)
    throw new OperationError(409, "LOCATION_NAME_IN_USE", "Ya existe una ubicación con ese nombre");
}

registerCommand("SupplierCreated", {
  kind: "supplier",
  capability: "purchases.write",
  create: true,
  schema: supplierCreateSchema,
  authorize: async ctx => requireFullReferenceScope(ctx.tx, ctx.actor),
  execute: async ctx => {
    const { evidence: proof, ...raw } = ctx.envelope.data;
    const input = supplierCreateSchema.omit({ evidence: true }).parse(raw);
    const name = supplierName(input.name);
    await ensureSupplierKeyAvailable(ctx.tx, name);
    if (input.isDefault) await ctx.tx.supplier.updateMany({ data: { isDefault: false } });
    const supplier = await ctx.tx.supplier.create({ data: { ...input, id: ctx.envelope.targetId, name, key: supplierKey(name), active: true } });
    await audit(ctx, "SupplierCreated", { supplierId: supplier.id, evidence: proof });
    return { supplier };
  },
});

registerCommand("SupplierUpdated", {
  kind: "supplier",
  capability: "purchases.write",
  // Legacy Supplier rows predate OperationObject. Allow version 0 only after confirming the model row exists.
  create: true,
  schema: supplierUpdateSchema,
  authorize: async ctx => requireFullReferenceScope(ctx.tx, ctx.actor),
  execute: async ctx => {
    const { evidence: proof, ...raw } = ctx.envelope.data;
    const input = supplierUpdateSchema.omit({ evidence: true }).parse(raw);
    const current = await ctx.tx.supplier.findUnique({ where: { id: ctx.envelope.targetId } });
    if (!current) throw new OperationError(404, "SUPPLIER_NOT_FOUND", "No se encontró el proveedor");
    const name = supplierName(input.name);
    await ensureSupplierKeyAvailable(ctx.tx, name, current.id);
    const isDefault = input.active && input.isDefault;
    if (isDefault) await ctx.tx.supplier.updateMany({ where: { id: { not: current.id } }, data: { isDefault: false } });
    const supplier = await ctx.tx.supplier.update({ where: { id: current.id }, data: { ...input, name, key: supplierKey(name), isDefault } });
    await audit(ctx, "SupplierUpdated", { supplierId: supplier.id, previousName: current.name, active: supplier.active, evidence: proof });
    return { supplier };
  },
});

registerCommand("LocationCreated", {
  kind: "location",
  capability: "stock.adjust",
  create: true,
  schema: locationCreateSchema,
  authorize: async ctx => requireFullReferenceScope(ctx.tx, ctx.actor),
  execute: async ctx => {
    const { evidence: proof, ...raw } = ctx.envelope.data;
    const input = locationCreateSchema.omit({ evidence: true }).parse(raw);
    const name = locationName(input.name);
    await ensureLocationKeyAvailable(ctx.tx, name);
    const firstActive = (await ctx.tx.location.count({ where: { active: true } })) === 0;
    const isDefault = input.isDefault || firstActive;
    if (isDefault) await ctx.tx.location.updateMany({ data: { isDefault: false } });
    const location = await ctx.tx.location.create({ data: { id: ctx.envelope.targetId, name, key: locationKey(name), active: true, isDefault } });
    await audit(ctx, "LocationCreated", { locationId: location.id, evidence: proof });
    return { location };
  },
});

registerCommand("LocationUpdated", {
  kind: "location",
  capability: "stock.adjust",
  // Legacy Location rows predate OperationObject; update handlers still require an existing model row.
  create: true,
  schema: locationUpdateSchema,
  authorize: async ctx => requireFullReferenceScope(ctx.tx, ctx.actor),
  execute: async ctx => {
    const { evidence: proof, ...raw } = ctx.envelope.data;
    const input = locationUpdateSchema.omit({ evidence: true }).parse(raw);
    const current = await ctx.tx.location.findUnique({ where: { id: ctx.envelope.targetId } });
    if (!current) throw new OperationError(404, "LOCATION_NOT_FOUND", "No se encontró la ubicación");
    const name = locationName(input.name);
    await ensureLocationKeyAvailable(ctx.tx, name, current.id);
    const isDefault = input.active && input.isDefault;
    if (isDefault) await ctx.tx.location.updateMany({ where: { id: { not: current.id } }, data: { isDefault: false } });
    const location = await ctx.tx.location.update({ where: { id: current.id }, data: { ...input, name, key: locationKey(name), isDefault } });
    if (current.name !== name)
      await ctx.tx.product.updateMany({ where: { locationId: current.id }, data: { location: name } });
    await audit(ctx, "LocationUpdated", { locationId: location.id, previousName: current.name, active: location.active, evidence: proof });
    return { location };
  },
});

export const manualReferenceDataRoutes = Router();

async function referenceVersions(tx: Tx, ids: string[]) {
  const found = await tx.operationObject.findMany({ where: { id: { in: ids } }, select: { id: true, version: true } });
  const result: Record<string, number> = Object.fromEntries(ids.map(id => [id, 0]));
  for (const item of found) result[item.id] = item.version;
  return result;
}

function fullScope(scope: Awaited<ReturnType<typeof objectScope>>) {
  return Object.values(scope).every(value => value === undefined);
}

manualReferenceDataRoutes.get("/manual-reference-data", async (req, res) => {
  const result = await db.$transaction(async tx => {
    const granted = await capabilities(tx, req.user);
    const canSuppliers = granted.includes("purchases.write");
    const canLocations = granted.includes("stock.adjust");
    if (!canSuppliers && !canLocations) throw new OperationError(403, "CAPABILITY_REQUIRED", "No tenés permiso para consultar estas referencias");
    const scope = await objectScope(tx, req.user);
    const [suppliers, locations] = await Promise.all([
      canSuppliers ? tx.supplier.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }], select: { id: true, name: true, contactName: true, phone: true, email: true, notes: true, active: true, isDefault: true } }) : Promise.resolve([]),
      canLocations ? tx.location.findMany({ where: scope.locationIds ? { id: { in: scope.locationIds } } : {}, orderBy: [{ active: "desc" }, { name: "asc" }, { id: "asc" }], select: { id: true, name: true, active: true, isDefault: true } }) : Promise.resolve([]),
    ]);
    const ids = [...suppliers.map(item => item.id), ...locations.map(item => item.id)];
    return wire({ suppliers, locations, versions: await referenceVersions(tx, ids), editable: { suppliers: canSuppliers && fullScope(scope), locations: canLocations && fullScope(scope) } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  res.json(result);
});

manualReferenceDataRoutes.get("/manual-reference-data/preparers", async (req, res) => {
  await requireCapability(db, req.user, "openings.approve");
  const scope = await objectScope(db, req.user);
  if (!fullScope(scope)) throw new OperationError(403, "REFERENCE_FULL_SCOPE_REQUIRED", "La selección de preparadores requiere alcance operativo completo");
  const items = await db.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  res.json({ items });
});
