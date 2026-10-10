import type { Prisma, PrismaClient } from "@prisma/client";
import { HttpError } from "./validation.js";

export const categoryName = (name: string) => name.trim().replace(/\s+/g, " ");
export const categoryKey = (name: string) => categoryName(name).toLowerCase();

/** A lot may have no category. An archived category is accepted only when the lot already had it. */
export async function resolveCategory(
  tx: Prisma.TransactionClient,
  categoryId: string | null,
  currentId?: string | null,
) {
  if (!categoryId) return { categoryId: null };
  const category = await tx.productCategory.findUnique({ where: { id: categoryId } });
  if (!category) throw new HttpError(400, "Elegí una categoría guardada");
  if (!category.active && category.id !== currentId)
    throw new HttpError(400, "La categoría está archivada");
  return { categoryId: category.id };
}

export interface CategoryCoverage {
  id: string;
  name: string;
  minVarieties: number;
  active: boolean;
  lotCount: number;
  /** Distinct product names with stock that can still be sold today. */
  varieties: number;
  varietyNames: string[];
  /** Sellable stock (the same lots as the varieties) per unit, in milliunits. */
  stock: { unit: string; milliunits: number }[];
}

/**
 * Varieties and stock per category. A variety is a product name, compared without case or outer spaces, with stock
 * above zero and not expired (a lot that expires today can still be sold, as in checkout).
 */
export async function categoryCoverage(db: PrismaClient | Prisma.TransactionClient, today: string): Promise<CategoryCoverage[]> {
  const rows = await db.$queryRaw<Array<{ id: string; name: string; minVarieties: number; active: boolean;
    lotCount: bigint; varieties: bigint; varietyNames: string[]; stock: { unit: string; milliunits: number }[] }>>`
    WITH sellable AS (
      SELECT p."categoryId", p.name, p.unit, p.stock FROM "Product" p
      WHERE p."categoryId" IS NOT NULL AND p.stock > 0 AND (p.expires IS NULL OR p.expires >= ${today})
    ), available AS (
      SELECT "categoryId", lower(btrim(name)) AS key, MIN(btrim(name)) AS name
      FROM sellable GROUP BY "categoryId", lower(btrim(name))
    ), stocked AS (
      SELECT "categoryId", json_agg(json_build_object('unit', unit, 'milliunits', milliunits) ORDER BY unit) AS stock
      FROM (SELECT "categoryId", unit, SUM(stock)::bigint AS milliunits FROM sellable GROUP BY "categoryId", unit) units
      GROUP BY "categoryId"
    )
    SELECT c.id, c.name, c."minVarieties", c.active,
           (SELECT COUNT(*) FROM "Product" p WHERE p."categoryId" = c.id)::bigint AS "lotCount",
           COUNT(a.key)::bigint AS varieties,
           COALESCE((ARRAY_AGG(a.name ORDER BY a.name) FILTER (WHERE a.key IS NOT NULL))[1:12], ARRAY[]::text[]) AS "varietyNames",
           COALESCE((SELECT s.stock FROM stocked s WHERE s."categoryId" = c.id), '[]'::json) AS stock
    FROM "ProductCategory" c LEFT JOIN available a ON a."categoryId" = c.id
    GROUP BY c.id
    ORDER BY c.active DESC, c.name ASC, c.id ASC`;
  return rows.map((row) => ({ ...row, lotCount: Number(row.lotCount), varieties: Number(row.varieties) }));
}

/** Active categories with a minimum that current stock does not reach. */
export const categoryAlerts = (coverage: CategoryCoverage[]) =>
  coverage
    .filter((category) => category.active && category.minVarieties > 0 && category.varieties < category.minVarieties)
    .map(({ id, name, minVarieties, varieties }) => ({ id, name, minVarieties, varieties }));
