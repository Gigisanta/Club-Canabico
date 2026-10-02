import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../db.js";
import { legacyPayloadHash } from "./legacy-upload-contract.js";
import { OperationError } from "./core.js";
import { signCursor, verifyCursor } from "./signed-cursor.js";
import { stockFactScopeWhere } from "./stock-scope.js";

const historyCursor = z.strictObject({ skuId: z.string().max(100), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), snapshotId: z.string().max(100), table: z.string().max(120), row: z.number().int().positive(), id: z.string().max(100) });
type Scope = { locationIds?: string[]; custodianIds?: string[] };
type Fact = { id: string; snapshotId: string; sourceTable: string; sourceRow: number; sourceKey: string; sourceHash: string; kind: string; occurredOn: string | null; dateState: string; quantity: Prisma.Decimal | null; quantityState: string; unit: string | null; unitState: string; amountMinor: bigint | null; amountState: string; currency: string | null; currencyState: string; correctionOf: string | null; receiptKey: string | null; codeConflict: boolean };

/** Physical history uses catalogue codes; a sale's Artículo resolves a purchase/receipt first. */
export async function productHistory(skuId: string, limit: number, scope: Scope, financial: boolean, cursor?: string, historicalCursor?: string) {
  return db.$transaction(async tx => {
    const sku = await tx.catalogSku.findUnique({ where: { id: skuId }, select: { id: true, code: true, name: true, unit: true } });
    if (!sku) throw new OperationError(404, "SKU_NOT_FOUND", "Producto no encontrado.");
    const lots = await tx.inventoryLot.findMany({ where: { skuId }, select: { id: true, label: true } });
    const physicalScope: Prisma.StockFactWhereInput = {
      lotId: { in: lots.map(lot => lot.id) },
      ...stockFactScopeWhere(scope),
    };
    if (cursor && !await tx.stockFact.findFirst({ where: { AND: [physicalScope, { id: cursor }] }, select: { id: true } }))
      throw new OperationError(400, "HISTORY_CURSOR_INVALID", "Reiniciá el historial con este producto y alcance.");
    const current = await tx.stockFact.findMany({ where: physicalScope, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: limit + 1, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    // Legacy has no proven location/custody mapping. Restricted stock views cannot acquire global history.
    const identities = scope.locationIds || scope.custodianIds ? [] : await tx.legacyIdentity.findMany({ where: { destinationType: "sku", destinationId: skuId, sourceTable: "D_Catalogo_Mercaderia", approvedBy: { not: null } }, select: { sourceSystem: true, sourceKey: true } });
    const publications = identities.length ? await tx.legacyHistoryPublication.findMany({ where: { sourceSystem: { in: identities.map(identity => identity.sourceSystem) } } }) : [];
    const snapshots = await tx.legacyImportSnapshot.findMany({ where: { id: { in: publications.map(p => p.snapshotId) }, status: "reviewed", reviewedBy: { not: null } }, select: { id: true, fileHash: true, reviewedBy: true, createdBy: true } });
    const populations = identities.flatMap(identity => {
      const publication = publications.find(p => p.sourceSystem === identity.sourceSystem);
      const snapshot = snapshots.find(s => s.id === publication?.snapshotId && s.fileHash === publication.fileHash && s.reviewedBy !== s.createdBy);
      return publication && snapshot ? [{ sourceSystem: identity.sourceSystem, code: identity.sourceKey, snapshotId: snapshot.id, fileHash: snapshot.fileHash, mappingId: publication.mappingId, publicationFingerprint: publication.fingerprint }] : [];
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
    const fingerprint = legacyPayloadHash({ queryVersion: "product-history/1", skuId, scope, populations });
    let after: z.infer<typeof historyCursor> | undefined;
    if (historicalCursor) {
      try { after = historyCursor.parse(verifyCursor("product-history", historicalCursor)); }
      catch { throw new OperationError(400, "HISTORY_CURSOR_INVALID", "Cursor histórico inválido."); }
      if (after.skuId !== skuId) throw new OperationError(400, "HISTORY_CURSOR_INVALID", "El cursor pertenece a otro producto.");
      if (after.fingerprint !== fingerprint) throw new OperationError(409, "HISTORY_POPULATION_CHANGED", "Cambió la historia aprobada; reiniciá la consulta.");
    }
    const clauses = populations.map(population => {
      const codePath = `$.columns[*] ? (@.header == "Codigo_Detalle" && @.value == ${JSON.stringify(population.code)})`;
      return Prisma.sql`(f."snapshotId" = ${population.snapshotId} AND f."mappingId" = ${population.mappingId} AND (
        (f.kind IN ('purchase', 'stock', 'archive') AND r."normalized" @? ${codePath}::jsonpath)
        OR (f.kind IN ('sale-line', 'archive') AND receipt."normalized" @? ${codePath}::jsonpath)))`;
    });
    const history = clauses.length ? await tx.$queryRaw<Fact[]>(Prisma.sql`
      SELECT f.id, f."snapshotId", f."sourceTable", f."sourceRow", f."sourceKey", f."sourceHash", f.kind,
        f."occurredOn", f."dateState", f.quantity, f."quantityState", f.unit, f."unitState", f."amountMinor", f."amountState", f.currency, f."currencyState", f."correctionOf",
        receipt."sourceKey" AS "receiptKey", COALESCE((SELECT c->>'value' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.normalized->'columns')='array' THEN r.normalized->'columns' ELSE '[]'::jsonb END) c WHERE c->>'header' = 'Detalle_Codigo_Detalle' LIMIT 1) <>
          (SELECT c->>'value' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(receipt.normalized->'columns')='array' THEN receipt.normalized->'columns' ELSE '[]'::jsonb END) c WHERE c->>'header' = 'Codigo_Detalle' LIMIT 1), false) AS "codeConflict"
      FROM "LegacyHistoricalFact" f JOIN "LegacySourceRecord" r ON r.id = f."sourceRecordId"
      LEFT JOIN LATERAL (SELECT min(candidate.id) AS id FROM "LegacySourceRecord" candidate
        WHERE f.kind IN ('sale-line', 'archive') AND r."sourceTable" = 'C_Detalle_Fact' AND candidate."snapshotId" = f."snapshotId" AND candidate."sourceTable" = 'C_Mercaderia' AND candidate."sourceKey" =
          (SELECT c->>'value' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.normalized->'columns')='array' THEN r.normalized->'columns' ELSE '[]'::jsonb END) c WHERE c->>'header' = 'Artículo' LIMIT 1)
        HAVING count(*) = 1) reference ON true
      LEFT JOIN "LegacySourceRecord" receipt ON receipt.id = reference.id
      WHERE (${Prisma.join(clauses, " OR ")}) AND NOT EXISTS (SELECT 1 FROM "LegacyHistoricalFact" newer WHERE newer."correctionOf" = f.id)
      ${after ? Prisma.sql`AND (f."snapshotId", f."sourceTable", f."sourceRow", f.id) > (${after.snapshotId}, ${after.table}, ${after.row}, ${after.id})` : Prisma.empty}
      ORDER BY f."snapshotId", f."sourceTable", f."sourceRow", f.id LIMIT ${limit + 1}`) : [];
    const last = history[Math.min(limit, history.length) - 1];
    return { sku, items: current.slice(0, limit).map(fact => ({ ...fact, costMinor: financial ? fact.costMinor : null, lotLabel: lots.find(lot => lot.id === fact.lotId)?.label ?? null })), hasMore: current.length > limit, nextCursor: current.length > limit ? current[limit - 1]!.id : null,
      historicalItems: history.slice(0, limit).map(fact => { const population = populations.find(p => p.snapshotId === fact.snapshotId)!; return { ...fact, amountMinor: financial ? fact.amountMinor : null, amountState: financial ? fact.amountState : "restricted", relationship: fact.kind === "sale-line" ? "sale-line-to-purchase-to-catalogue" : fact.receiptKey ? "archive-via-receipt-to-catalogue" : "catalogue-code", provenance: { sourceSystem: population.sourceSystem, snapshotId: population.snapshotId, fileHash: population.fileHash, contentHash: fact.sourceHash, sourceTable: fact.sourceTable, sourceRow: fact.sourceRow }, financialEffect: "history-only" }; }),
      historicalHasMore: history.length > limit, historicalNextCursor: history.length > limit && last ? signCursor("product-history", { skuId, fingerprint, snapshotId: last.snapshotId, table: last.sourceTable, row: last.sourceRow, id: last.id }) : null,
      coverage: { fingerprint, snapshotIds: [...new Set(populations.map(p => p.snapshotId))], historical: scope.locationIds || scope.custodianIds ? "location-custody-mapping-pending" : populations.length ? "approved-catalogue-identity-and-publication" : "approved-catalogue-identity-pending", unresolvedRelationshipsIncluded: false, historyCreatesBalances: false } };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 });
}
