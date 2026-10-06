import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../db.js";
import { OperationError, type Tx } from "./core.js";
import { projectInvoiceAmount } from "./invoice-projection.js";
import { signCursor, verifyCursor } from "./signed-cursor.js";

const historicalCursorSchema = z.strictObject({ memberId: z.string(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), snapshotId: z.string(), row: z.number().int().positive(), id: z.string() });

/** A read projection through independently approved identities. Never books stock, debt or cash. */
export async function memberHistory(memberId: string, limit: number, cursor?: string, historicalCursor?: string) {
  return db.$transaction(tx => readMemberHistory(tx, memberId, limit, cursor, historicalCursor), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 5000, timeout: 15000,
  });
}
async function readMemberHistory(tx: Tx, memberId: string, limit: number, cursor?: string, historicalCursor?: string) {
  if (cursor && !await tx.operationOrder.findFirst({ where: { id: cursor, memberId }, select: { id: true } }))
    throw new OperationError(400, "HISTORY_CURSOR_INVALID", "El cursor no corresponde al historial del socio.");
  const [orders, identities] = await Promise.all([
    tx.operationOrder.findMany({ where: { memberId }, select: {
      id: true, currency: true, totalMinor: true, subtotalMinor: true, quote: true, confirmedAt: true, createdAt: true,
      channel: true, commercialState: true, fulfillmentState: true, verifiedMinor: true,
    }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) }),
    tx.legacyIdentity.findMany({ where: { destinationType: "member", destinationId: memberId, approvedBy: { not: null }, sourceTable: "C_Cliente" } }),
  ]);
  const legacyInvoices: Array<Record<string, unknown>> = [];
  const populations: Array<{ sourceSystem: string; sourceKey: string; snapshotId: string; fileHash: string; publicationFingerprint: string }> = [];
  for (const identity of identities) {
    const publication = await tx.legacyHistoryPublication.findUnique({ where: { sourceSystem: identity.sourceSystem } });
    if (!publication) continue;
    const snapshot = await tx.legacyImportSnapshot.findFirst({ where: { id: publication.snapshotId, status: "reviewed", fileHash: publication.fileHash, reviewedBy: { not: null } }, select: { id: true, fileHash: true } });
    if (!snapshot) continue;
    populations.push({ sourceSystem: identity.sourceSystem, sourceKey: identity.sourceKey, snapshotId: snapshot.id, fileHash: snapshot.fileHash, publicationFingerprint: publication.fingerprint });
  }
  populations.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
  const fingerprint = createHash("sha256").update(JSON.stringify({ memberId, populations })).digest("hex");
  let after: z.infer<typeof historicalCursorSchema> | undefined;
  if (historicalCursor) {
    try { after = historicalCursorSchema.parse(verifyCursor("member-history", historicalCursor)); }
    catch { throw new OperationError(400, "HISTORY_CURSOR_INVALID", "Cursor histórico inválido."); }
    if (after.memberId !== memberId) throw new OperationError(400, "HISTORY_CURSOR_INVALID", "El cursor no corresponde al socio.");
    if (after.fingerprint !== fingerprint) throw new OperationError(409, "HISTORY_POPULATION_CHANGED", "Cambió la fuente revisada; reiniciá la consulta histórica.");
  }
  const filters = populations.map(population => {
    const path = `$.columns[*] ? (@.header == "Cliente" && @.value == ${JSON.stringify(population.sourceKey)})`;
    return Prisma.sql`(f."snapshotId" = ${population.snapshotId} AND r."normalized" @? ${path}::jsonpath)`;
  });
  const records = filters.length ? await tx.$queryRaw<Array<{ id: string; snapshotId: string; sourceKey: string; sourceTable: string; sourceRow: number; contentHash: string; normalized: Prisma.JsonValue; attributes: Prisma.JsonValue; occurredOn: string | null; dateState: string; currency: string | null; currencyState: string; amountMinor: bigint | null; amountState: string; correctionOf: string | null }>>`
      SELECT f."id", f."snapshotId", f."sourceKey", f."sourceTable", f."sourceRow", f."sourceHash" AS "contentHash", r."normalized", f."attributes", f."occurredOn", f."dateState", f."currency", f."currencyState", f."amountMinor", f."amountState", f."correctionOf"
      FROM "LegacyHistoricalFact" f JOIN "LegacySourceRecord" r ON r."id" = f."sourceRecordId"
      JOIN "LegacyHistoryPublication" p ON p."snapshotId" = f."snapshotId" AND p."mappingId" = f."mappingId"
      WHERE f."kind" = 'invoice' AND (${Prisma.join(filters, " OR ")}) AND NOT EXISTS (SELECT 1 FROM "LegacyHistoricalFact" newer WHERE newer."correctionOf" = f."id")
      ${after ? Prisma.sql`AND (f."snapshotId", f."sourceRow", f."id") > (${after.snapshotId}, ${after.row}, ${after.id})` : Prisma.empty}
      ORDER BY f."snapshotId", f."sourceRow", f."id" LIMIT ${limit + 1}` : [];
  const historicalHasMore = records.length > limit;
  for (const record of records.slice(0, limit)) {
      const population = populations.find(p => p.snapshotId === record.snapshotId)!;
      const rawColumns = record.normalized !== null && typeof record.normalized === "object" && !Array.isArray(record.normalized) ? record.normalized.columns : undefined;
      const columns = (Array.isArray(rawColumns) ? rawColumns : []).filter((value): value is { header: string; value: string | null } =>
        value !== null && typeof value === "object" && !Array.isArray(value)
        && typeof value.header === "string" && (value.value === null || typeof value.value === "string"));
      const field = (header: string) => columns.find(c => c.header === header);
      const amountBasis = (record.attributes as { fields?: { amountField?: string } })?.fields?.amountField ?? null;
      legacyInvoices.push({
        id: record.id, sourceId: record.sourceKey, date: record.occurredOn, dateState: record.dateState,
        reference: field("N_factura")?.value ?? null, state: field("Estado")?.value ?? null,
        currency: record.currency, currencyState: record.currencyState, amountMinor: record.amountMinor, amountState: record.amountState, amountBasis,
        productMinor: amountBasis === "Subtotal_Venta" ? record.amountMinor : null,
        totalMinor: amountBasis === "Total_Facturado" ? record.amountMinor : null, correctionOf: record.correctionOf,
        provenance: { sourceSystem: population.sourceSystem, snapshotId: population.snapshotId, fileHash: population.fileHash, contentHash: record.contentHash, sourceTable: record.sourceTable, sourceRow: record.sourceRow },
        financialEffect: "history-only-not-evidence-of-payment",
      });
  }
  const last = records[Math.min(records.length, limit) - 1];
  const historicalNextCursor = historicalHasMore && last ? signCursor("member-history", { memberId, fingerprint, snapshotId: last.snapshotId, row: last.sourceRow, id: last.id }) : null;
  const hasMore = orders.length > limit;
  return {
    orders: orders.slice(0, limit).map(o => {
      const projected = projectInvoiceAmount(o);
      const { quote, ...publicOrder } = projected;
      void quote;
      return { ...publicOrder, productMinor: projected.subtotalMinor };
    }), nextCursor: hasMore ? orders[limit - 1]!.id : null, hasMore,
    legacyInvoices, historicalHasMore, historicalNextCursor,
    coverage: { historical: populations.length ? "approved-identity-reviewed-snapshot" : "approved-historical-correspondence-pending", snapshotIds: [...new Set(populations.map(p => p.snapshotId))], fingerprint, historyCreatesBalances: false },
  };
}
