import { z } from "zod";
import {
  appSheetCataloguePatchSchema,
  appSheetCatalogueStoredSchema,
  type AppSheetCataloguePatch,
} from "../../shared/operations/appsheet-catalogue.js";
import { audit, json, OperationError, registerCommand } from "./core.js";
import { recordAppSheetCanonicalSkuMutation, requireEligibleAppSheetReplacementSkus } from "./access.js";

const commandSchema = z.strictObject({ patch: appSheetCataloguePatchSchema });
const appSheetKeys = Object.keys(appSheetCatalogueStoredSchema.shape);

function plainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Return only the known AppSheet fields; preserve other stored metadata during writes. */
export function projectAppSheetCatalogue(value: unknown) {
  const parsed = appSheetCatalogueStoredSchema.parse(plainRecord(value));
  return Object.fromEntries(appSheetKeys
    .filter(key => Object.hasOwn(parsed, key))
    .map(key => [key, parsed[key as keyof typeof parsed]]));
}

registerCommand("CatalogueSheetSaved", {
  kind: "sku",
  capability: "prices.propose",
  // Legacy SKUs activated from a reviewed import may predate OperationObject.
  // The handler still requires the actual SKU row, so this only initializes its version record.
  create: true,
  schema: commandSchema,
  execute: async ctx => {
    const sku = await ctx.tx.catalogSku.findUnique({ where: { id: ctx.envelope.targetId } });
    if (!sku) throw new OperationError(404, "SKU_NOT_FOUND", "No se encontró el producto de catálogo");
    await requireEligibleAppSheetReplacementSkus(ctx.tx, [sku.id]);

    const { patch } = ctx.envelope.data as { patch: AppSheetCataloguePatch };
    const previous = plainRecord(sku.appSheet);
    const next = { ...previous, ...patch };
    appSheetCatalogueStoredSchema.parse(next);
    const updated = await ctx.tx.catalogSku.update({
      where: { id: sku.id },
      data: { appSheet: json(next) },
      select: { id: true, appSheet: true },
    });
    const responseAppSheet = projectAppSheetCatalogue(updated.appSheet);
    // The public result stays partial for compatibility; the audit chain keeps
    // a complete SKU snapshot so later eligibility checks can reconstruct it.
    await recordAppSheetCanonicalSkuMutation(ctx, sku, { ...sku, appSheet: updated.appSheet }, responseAppSheet);
    await audit(ctx, "appsheet.catalogue-fields-saved", { fields: Object.keys(patch) });
    return { skuId: updated.id, appSheet: responseAppSheet };
  },
});
