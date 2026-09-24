import { Prisma, type User } from "@prisma/client";
import { z } from "zod";
import { db } from "./db.js";
import { ownerScope } from "./state.js";

export async function productCatalog(user: User, rawQuery: unknown) {
  const q = z.string().trim().max(80).parse(rawQuery || "");
  const ownerId = ownerScope(user);
  const scope = ownerId ? Prisma.sql`"ownerId" = ${ownerId}` : Prisma.sql`TRUE`;
  const escaped = q.replace(/[\\%_]/g, "\\$&");
  const matches = q ? Prisma.sql`AND name ILIKE ${`%${escaped}%`} ESCAPE '\\'` : Prisma.empty;
  const [products, profiles] = await Promise.all([
    db.$queryRaw<Array<{ name: string; strain: string; type: string; unit: string }>>`
      SELECT name, strain, type, unit FROM (
        SELECT DISTINCT ON (lower(trim(name))) trim(name) AS name, strain, type, unit, "createdAt"
        FROM "Product"
        WHERE ${scope} ${matches}
        ORDER BY lower(trim(name)), "createdAt" DESC, id DESC
      ) recent
      ORDER BY ${q ? Prisma.sql`CASE WHEN name ILIKE ${`${escaped}%`} ESCAPE '\\' THEN 0 ELSE 1 END,` : Prisma.empty}
               ${q ? Prisma.sql`name ASC` : Prisma.sql`"createdAt" DESC, name ASC`}
      LIMIT 8`,
    db.$queryRaw<Array<{ value: string }>>`
      SELECT MIN(trim(strain)) AS value
      FROM "Product"
      WHERE ${scope} AND trim(strain) <> ''
      GROUP BY lower(trim(strain))
      ORDER BY COUNT(*) DESC, MIN(trim(strain)) ASC
      LIMIT 12`,
  ]);
  return { products, profiles: profiles.map((p) => p.value) };
}
