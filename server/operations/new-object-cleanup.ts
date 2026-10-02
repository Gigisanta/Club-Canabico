import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../db.js";
import { deletePrivateObjectVersion } from "./object-store.js";

const topic = "document.asset-intent";
const claimLease = 15 * 60 * 1000;
type AssetPayload = Record<string, unknown> & {
  version: 1;
  requestId: string;
  documentId: string;
  key: string;
  checksum: string;
  bytes: number;
  mediaType: string;
  sourceHash: string;
  expectedVersion?: string;
  stored?: { key: string; version: string; checksum: string; bytes: number; mediaType: string };
};
type Candidate = { id: string; requestId: string; status: string; payload: Prisma.JsonValue; createdAt: Date };
type Claim = { id: string; token: string; key: string; version: string; payload: AssetPayload };

function asObject(value: Prisma.JsonValue): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsePayload(value: Prisma.JsonValue): AssetPayload | undefined {
  const payload = asObject(value);
  if (!payload) return undefined;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const checksum = /^[a-f0-9]{64}$/;
  if (payload.version !== 1 || typeof payload.requestId !== "string" || !uuid.test(payload.requestId)
    || typeof payload.documentId !== "string" || !uuid.test(payload.documentId)
    || typeof payload.key !== "string" || !payload.key.startsWith(`documents/${payload.documentId}/`)
    || typeof payload.checksum !== "string" || !checksum.test(payload.checksum)
    || !Number.isSafeInteger(payload.bytes) || (payload.bytes as number) < 1 || (payload.bytes as number) > 3_000_000
    || !["application/pdf","image/png","image/jpeg"].includes(String(payload.mediaType)) || typeof payload.sourceHash !== "string" || !checksum.test(payload.sourceHash)) return undefined;
  if (payload.expectedVersion !== undefined && payload.expectedVersion !== payload.checksum) return undefined;
  if (payload.stored !== undefined) {
    const stored = payload.stored as Record<string, unknown>;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)
      || stored.key !== payload.key || stored.checksum !== payload.checksum || stored.bytes !== payload.bytes
      || stored.mediaType !== payload.mediaType || typeof stored.version !== "string"
      || !stored.version || stored.version === "null" || stored.version.length > 1000) return undefined;
  }
  return payload as AssetPayload;
}

function objectVersion(payload: AssetPayload): string | undefined {
  const version = payload.stored?.version ?? payload.expectedVersion;
  return typeof version === "string" && version.length > 0 && version !== "null" ? version : undefined;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/**
 * Reap stale private document objects in bounded batches. The database transaction only claims
 * work and checks references; object-store I/O always happens after it commits.
 */
export async function processAbandonedDocumentAssets(limit = 100): Promise<number> {
  const size = Math.max(1, Math.min(200, Math.floor(Number.isFinite(limit) ? limit : 100)));
  const now = new Date();
  const reclaimBefore = new Date(now.getTime() - claimLease).toISOString();
  const claims = await db.$transaction(async tx => {
    const rows = await tx.$queryRaw<Candidate[]>`
      SELECT "id", "requestId", "status", "payload", "createdAt"
      FROM "OperationOutbox"
      WHERE "topic" = ${topic}
        AND (
          ("status" IN ('asset-preparing', 'asset-ready') AND "createdAt" < CURRENT_TIMESTAMP - INTERVAL '1 hour')
          OR ("status" = 'asset-cleaning' AND (
            NOT ("payload" ? 'cleanupClaimedAt')
            OR "payload"->>'cleanupClaimedAt' <= ${reclaimBefore}
          ))
        )
      ORDER BY "createdAt", "id"
      LIMIT ${size}
      FOR UPDATE SKIP LOCKED`;
    const claimed: Claim[] = [];
    for (const row of rows) {
      const payload = parsePayload(row.payload);
      if (!payload || payload.requestId !== row.requestId) {
        const broken = asObject(row.payload) ?? {};
        await tx.operationOutbox.update({
          where: { id: row.id },
          data: { status: "review", attempts: { increment: 1 }, payload: json({ ...broken, reviewReason: "INVALID_ASSET_INTENT" }) },
        });
        continue;
      }
      const version = objectVersion(payload);
      if (version) {
        const document = await tx.operationDocument.findUnique({
          where: { id: payload.documentId },
          select: { objectKey: true, objectVersion: true },
        });
        if (document?.objectKey === payload.key && document.objectVersion === version) {
          await tx.operationOutbox.update({
            where: { id: row.id },
            data: { status: "processed", attempts: { increment: 1 }, processedAt: now },
          });
          continue;
        }
      }
      if (!version) {
        await tx.operationOutbox.update({
          where: { id: row.id },
          data: {
            status: "review",
            attempts: { increment: 1 },
            payload: json({ ...payload, reviewReason: "OBJECT_VERSION_UNKNOWN" }),
          },
        });
        continue;
      }
      const token = randomUUID();
      const claimedPayload = { ...payload, cleanupClaimToken: token, cleanupClaimedAt: now.toISOString() };
      await tx.operationOutbox.update({
        where: { id: row.id },
        data: { status: "asset-cleaning", payload: json(claimedPayload) },
      });
      claimed.push({ id: row.id, token, key: payload.key, version, payload: claimedPayload });
    }
    return claimed;
  }, { timeout: 15000 });

  let removed = 0;
  for (const claim of claims) {
    try {
      await deletePrivateObjectVersion(claim.key, claim.version);
      const { cleanupClaimToken: _token, cleanupClaimedAt: _claimedAt, cleanupError: _error, ...completedPayload } = claim.payload;
      await db.$executeRaw`
        UPDATE "OperationOutbox"
        SET "status" = 'processed', "attempts" = "attempts" + 1, "processedAt" = ${new Date()}, "payload" = ${JSON.stringify(completedPayload)}::jsonb
        WHERE "id" = ${claim.id}::uuid AND "status" = 'asset-cleaning' AND "payload"->>'cleanupClaimToken' = ${claim.token}`;
      removed++;
    } catch {
      const failedPayload = { ...claim.payload, cleanupError: "OBJECT_DELETE_FAILED" };
      await db.$executeRaw`
        UPDATE "OperationOutbox"
        SET "attempts" = "attempts" + 1, "payload" = ${JSON.stringify(failedPayload)}::jsonb
        WHERE "id" = ${claim.id}::uuid AND "status" = 'asset-cleaning' AND "payload"->>'cleanupClaimToken' = ${claim.token}`;
    }
  }
  return removed;
}
