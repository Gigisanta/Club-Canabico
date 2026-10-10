import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";
import { canonicalJsonData } from "../../shared/operations/exact.js";
import {
  appSheetPreorderDraftIdSchema,
  appSheetPreorderDraftPayloadSchema,
  buildSourcePreorderDraftPayload,
  sourcePreorderSavedSchema,
  sourcePreorderUpdatedSchema,
  updateSourcePreorderDraftPayload,
  type AppSheetPreorderDraftPayload,
} from "../../shared/operations/appsheet-preorder.js";
import {
  objectScope,
  json,
  OperationError,
  registerCommand,
  requireCapability,
  requireMemberScope,
  type CommandContext,
  type Tx,
} from "./core.js";
import { appSheetReplacementCanonicalMemberIds, requireEligibleAppSheetReplacementMember } from "./access.js";

const hashPattern = /^[a-f0-9]{64}$/;
const collectionLimit = z.coerce.number().int().min(1).max(100);
const collectionMemberFilter = z.string().min(1).max(100).optional();
const collectionCursorInput = z.string().min(1).max(2048).optional();

type StoredDraft = {
  id: string;
  memberId: string;
  schemaVersion: number;
  snapshotHash: string;
  payload: unknown;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  operationObject: { id: string; kind: string; version: number };
};

type DraftDto = {
  id: string;
  memberId: string;
  version: number;
  schemaVersion: number;
  snapshotHash: string;
  payload: AppSheetPreorderDraftPayload;
  createdAt: string;
  updatedAt: string;
};

function hashPayload(payload: AppSheetPreorderDraftPayload): string {
  return createHash("sha256").update(canonicalJsonData(payload), "utf8").digest("hex");
}

function integrityError(): OperationError {
  return new OperationError(409, "APPSHEET_PREORDER_SNAPSHOT_INTEGRITY", "El borrador no pasó la verificación de integridad.");
}

function verifiedPayload(row: StoredDraft): AppSheetPreorderDraftPayload {
  let payload: AppSheetPreorderDraftPayload;
  try {
    payload = appSheetPreorderDraftPayloadSchema.parse(row.payload);
  } catch {
    throw integrityError();
  }
  if (
    !row.operationObject ||
    !hashPattern.test(row.snapshotHash) ||
    row.schemaVersion !== payload.schemaVersion ||
    row.memberId !== payload.memberId ||
    row.operationObject.id !== row.id ||
    row.operationObject.kind !== "appsheetPreorder" ||
    hashPayload(payload) !== row.snapshotHash
  ) {
    throw integrityError();
  }
  return payload;
}

function projectDraft(row: StoredDraft, payload = verifiedPayload(row), version = row.operationObject.version): DraftDto {
  return {
    id: row.id,
    memberId: row.memberId,
    version,
    schemaVersion: row.schemaVersion,
    snapshotHash: row.snapshotHash,
    payload,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function requireDraftId(value: string): string {
  if (!appSheetPreorderDraftIdSchema.safeParse(value).success)
    throw new OperationError(400, "APPSHEET_PREORDER_TARGET_ID", "La identidad debe ser un borrador nativo de Bombo.");
  return value;
}

async function currentMemberScope(tx: Tx, actor: CommandContext["actor"]): Promise<string[] | null> {
  const raw = (await objectScope(tx, actor)).memberIds as unknown;
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.some(memberId => typeof memberId !== "string"))
    throw new OperationError(403, "MEMBER_SCOPE_UNVERIFIED", "No se pudo verificar el alcance actual de socios.");
  return [...new Set(raw as string[])].sort();
}

async function authorizeMember(tx: Tx, actor: CommandContext["actor"], memberId: string): Promise<void> {
  const scopedMembers = await currentMemberScope(tx, actor);
  if (scopedMembers !== null && !scopedMembers.includes(memberId))
    throw new OperationError(403, "MEMBER_SCOPE", "Socio fuera de tu alcance");
  await requireMemberScope(tx, actor, memberId);
  await requireEligibleAppSheetReplacementMember(tx, memberId);
}

async function findStoredDraft(tx: Tx, id: string): Promise<StoredDraft | null> {
  return tx.appSheetPreorderDraft.findUnique({
    where: { id },
    include: { operationObject: { select: { id: true, kind: true, version: true } } },
  }) as Promise<StoredDraft | null>;
}

async function authorizeSaved(ctx: CommandContext): Promise<void> {
  const id = requireDraftId(ctx.envelope.targetId);
  const input = sourcePreorderSavedSchema.parse(ctx.envelope.data);
  const [row, receipt] = await Promise.all([
    findStoredDraft(ctx.tx, id),
    ctx.tx.commandReceipt.findUnique({ where: { requestId: ctx.envelope.requestId }, select: { requestId: true } }),
  ]);

  if (row) {
    const payload = verifiedPayload(row);
    await authorizeMember(ctx.tx, ctx.actor, row.memberId);
    if (payload.memberId !== input.memberId)
      throw new OperationError(409, "APPSHEET_PREORDER_MEMBER_IMMUTABLE", "El socio del borrador no se puede cambiar.");
    if (!receipt)
      throw new OperationError(409, "APPSHEET_PREORDER_ALREADY_EXISTS", "La identidad ya pertenece a un borrador.");
    return;
  }

  if (receipt)
    throw integrityError();
  const object = await ctx.tx.operationObject.findUnique({ where: { id }, select: { id: true } });
  if (object)
    throw new OperationError(409, "APPSHEET_PREORDER_ALREADY_EXISTS", "La identidad ya pertenece a otro agregado.");
  await authorizeMember(ctx.tx, ctx.actor, input.memberId);
}

async function authorizeUpdated(ctx: CommandContext): Promise<void> {
  const id = requireDraftId(ctx.envelope.targetId);
  sourcePreorderUpdatedSchema.parse(ctx.envelope.data);
  const row = await findStoredDraft(ctx.tx, id);
  if (!row) throw new OperationError(404, "APPSHEET_PREORDER_NOT_FOUND", "No se encontró el borrador de preventa.");
  verifiedPayload(row);
  await authorizeMember(ctx.tx, ctx.actor, row.memberId);
}

function generatedLineId(): string {
  return `bombo-preventa-line:${randomUUID()}`;
}

registerCommand("SourcePreorderSaved", {
  kind: "appsheetPreorder",
  capability: "orders.write",
  create: true,
  schema: sourcePreorderSavedSchema,
  authorize: authorizeSaved,
  execute: async ctx => {
    const id = requireDraftId(ctx.envelope.targetId);
    const input = sourcePreorderSavedSchema.parse(ctx.envelope.data);
    const payload = buildSourcePreorderDraftPayload(input, generatedLineId);
    const snapshotHash = hashPayload(payload);
    const created = await ctx.tx.appSheetPreorderDraft.create({
      data: {
        id,
        memberId: input.memberId,
        schemaVersion: payload.schemaVersion,
        snapshotHash,
        payload: json(payload),
        createdBy: ctx.actor.id,
      },
      include: { operationObject: { select: { id: true, kind: true, version: true } } },
    }) as StoredDraft;
    // The command core increments OperationObject after execute returns.
    return { draft: projectDraft(created, payload, ctx.envelope.expectedVersion + 1) };
  },
});

registerCommand("SourcePreorderUpdated", {
  kind: "appsheetPreorder",
  capability: "orders.write",
  schema: sourcePreorderUpdatedSchema,
  authorize: authorizeUpdated,
  execute: async ctx => {
    const id = requireDraftId(ctx.envelope.targetId);
    const existing = await findStoredDraft(ctx.tx, id);
    if (!existing) throw new OperationError(404, "APPSHEET_PREORDER_NOT_FOUND", "No se encontró el borrador de preventa.");
    const previousPayload = verifiedPayload(existing);
    let nextPayload: AppSheetPreorderDraftPayload;
    try {
      nextPayload = updateSourcePreorderDraftPayload(ctx.envelope.data, previousPayload, generatedLineId);
    } catch (error) {
      const code = error instanceof TypeError && error.message === "appsheet_preorder_unknown_line_id"
        ? "APPSHEET_PREORDER_LINE_UNKNOWN"
        : error instanceof TypeError && error.message === "appsheet_preorder_duplicate_line_id"
          ? "APPSHEET_PREORDER_LINE_DUPLICATE"
          : "APPSHEET_PREORDER_INPUT_INVALID";
      throw new OperationError(422, code, "Las líneas del borrador no son válidas.");
    }
    const nextHash = hashPayload(nextPayload);
    const changed = await ctx.tx.appSheetPreorderDraft.updateMany({
      where: { id, snapshotHash: existing.snapshotHash, updatedAt: existing.updatedAt },
      data: { schemaVersion: nextPayload.schemaVersion, snapshotHash: nextHash, payload: json(nextPayload) },
    });
    if (changed.count !== 1)
      throw new OperationError(409, "VERSION_CONFLICT", "El borrador cambió; revisá la versión actual.");
    const updated = await findStoredDraft(ctx.tx, id);
    if (!updated) throw integrityError();
    return { draft: projectDraft(updated, nextPayload, ctx.envelope.expectedVersion + 1) };
  },
});

const cursorSchema = z.strictObject({
  schemaVersion: z.literal(1),
  binding: z.string().regex(hashPattern),
  updatedAt: z.iso.datetime({ offset: true }),
  id: appSheetPreorderDraftIdSchema,
});

function parseCursor(raw: string | undefined) {
  if (raw === undefined) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw new OperationError(400, "PAGE_CURSOR", "Reiniciá la página con los filtros y el alcance actuales.");
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (!parsed.success) throw new Error("invalid_cursor");
    return parsed.data;
  } catch {
    throw new OperationError(400, "PAGE_CURSOR", "Reiniciá la página con los filtros y el alcance actuales.");
  }
}

function encodeCursor(value: z.infer<typeof cursorSchema>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function cursorBinding(tx: Tx, actorId: string, memberId: string | undefined, limit: number, scopedMemberIds: string[] | null) {
  const eligibleCanonicalIds = await appSheetReplacementCanonicalMemberIds(tx);
  const activeEligibility = eligibleCanonicalIds === null ? null : [...eligibleCanonicalIds].sort();
  const binding = createHash("sha256").update(canonicalJsonData({
    actorId,
    memberId: memberId ?? null,
    limit,
    scopedMemberIds,
    eligibleCanonicalIds: activeEligibility,
  }), "utf8").digest("hex");
  return { eligibleCanonicalIds, binding };
}

async function collectionMemberIds(tx: Tx, scopedMemberIds: string[] | null, eligibleCanonicalIds: Set<string> | null) {
  const where = eligibleCanonicalIds === null
    ? scopedMemberIds === null ? {} : { id: { in: scopedMemberIds } }
    : {
        AND: [
          ...(scopedMemberIds === null ? [] : [{ id: { in: scopedMemberIds } }]),
          { OR: [
            { sourceSystem: null, sourceId: null, legacyCustomerId: null },
            { id: { in: [...eligibleCanonicalIds] } },
          ] },
        ],
      };
  const members = await tx.operationMember.findMany({ where, select: { id: true } });
  return members.map(member => member.id);
}

export const appSheetPreorderRoutes = Router();

appSheetPreorderRoutes.get("/", async (req, res) => {
  const limit = collectionLimit.parse(req.query.limit ?? 50);
  const memberId = collectionMemberFilter.parse(req.query.memberId);
  const cursor = parseCursor(collectionCursorInput.parse(req.query.cursor));

  const page = await db.$transaction(async tx => {
    await requireCapability(tx, req.user, "operations.read");
    const scopedMemberIds = await currentMemberScope(tx, req.user);
    if (memberId !== undefined) {
      if (scopedMemberIds !== null && !scopedMemberIds.includes(memberId))
        throw new OperationError(403, "MEMBER_SCOPE", "Socio fuera de tu alcance");
      const requestedMember = await tx.operationMember.findUnique({ where: { id: memberId }, select: { id: true } });
      if (!requestedMember) throw new OperationError(404, "MEMBER_NOT_FOUND", "Socio no encontrado");
      await requireMemberScope(tx, req.user, memberId);
      await requireEligibleAppSheetReplacementMember(tx, memberId);
    }

    const { eligibleCanonicalIds, binding } = await cursorBinding(tx, req.user.id, memberId, limit, scopedMemberIds);
    if (cursor && cursor.binding !== binding)
      throw new OperationError(400, "PAGE_CURSOR", "Reiniciá la página con los filtros y el alcance actuales.");

    const allowedMemberIds = await collectionMemberIds(tx, scopedMemberIds, eligibleCanonicalIds);
    const visibleMemberIds = memberId === undefined
      ? allowedMemberIds
      : allowedMemberIds.includes(memberId) ? [memberId] : [];
    const baseWhere = {
      memberId: { in: visibleMemberIds },
    };
    if (cursor) {
      const cursorRow = await tx.appSheetPreorderDraft.findFirst({
        where: { ...baseWhere, id: cursor.id, updatedAt: new Date(cursor.updatedAt) },
        select: { id: true },
      });
      if (!cursorRow) throw new OperationError(400, "PAGE_CURSOR", "Reiniciá la página con los filtros y el alcance actuales.");
    }
    const where = {
      ...baseWhere,
      ...(cursor ? { OR: [
        { updatedAt: { lt: new Date(cursor.updatedAt) } },
        { updatedAt: new Date(cursor.updatedAt), id: { lt: cursor.id } },
      ] } : {}),
    };

    const rows = await tx.appSheetPreorderDraft.findMany({
      where,
      include: { operationObject: { select: { id: true, kind: true, version: true } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    }) as StoredDraft[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    const items: DraftDto[] = [];
    for (const row of selected) {
      await authorizeMember(tx, req.user, row.memberId);
      items.push(projectDraft(row));
    }
    const last = selected.at(-1);
    return {
      items,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ schemaVersion: 1, binding, updatedAt: last.updatedAt.toISOString(), id: last.id }) : null,
    };
  }, { isolationLevel: "RepeatableRead" });

  res.json(page);
});

appSheetPreorderRoutes.get("/:id", async (req, res) => {
  const id = requireDraftId(z.string().min(1).max(100).parse(req.params.id));
  const item = await db.$transaction(async tx => {
    await requireCapability(tx, req.user, "operations.read");
    const row = await findStoredDraft(tx, id);
    if (!row) throw new OperationError(404, "APPSHEET_PREORDER_NOT_FOUND", "No se encontró el borrador de preventa.");
    await authorizeMember(tx, req.user, row.memberId);
    return projectDraft(row);
  }, { isolationLevel: "RepeatableRead" });
  res.json({ item });
});
