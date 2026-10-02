import type { Prisma } from "@prisma/client";

/** Every disclosed non-null endpoint must be authorized; missing endpoints grant no scope. */
export function stockFactScopeWhere(scope: { locationIds?: string[]; custodianIds?: string[] }): Prisma.StockFactWhereInput {
  const clauses: Prisma.StockFactWhereInput[] = [];
  if (scope.locationIds !== undefined) clauses.push(
    { OR: [{ fromLocationId: null }, { fromLocationId: { in: scope.locationIds } }] },
    { OR: [{ toLocationId: null }, { toLocationId: { in: scope.locationIds } }] },
    { OR: [{ fromLocationId: { in: scope.locationIds } }, { toLocationId: { in: scope.locationIds } }] },
  );
  if (scope.custodianIds !== undefined) clauses.push(
    { OR: [{ fromCustodianId: null }, { fromCustodianId: { in: scope.custodianIds } }] },
    { OR: [{ toCustodianId: null }, { toCustodianId: { in: scope.custodianIds } }] },
    { OR: [{ fromCustodianId: { in: scope.custodianIds } }, { toCustodianId: { in: scope.custodianIds } }] },
  );
  return { AND: clauses };
}
