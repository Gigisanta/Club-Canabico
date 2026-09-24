import type { Prisma } from "@prisma/client";
import { HttpError } from "./validation.js";

export const supplierName = (name: string) => name.trim().replace(/\s+/g, " ");
export const supplierKey = (name: string) => supplierName(name).toLowerCase();

export async function resolveSupplier(
  tx: Prisma.TransactionClient,
  supplierId: string | null,
  legacyName: string,
  currentId?: string | null,
) {
  const supplier = supplierId
    ? await tx.supplier.findUnique({ where: { id: supplierId } })
    : legacyName
      ? await tx.supplier.findUnique({ where: { key: supplierKey(legacyName) } })
      : null;
  if ((supplierId || legacyName) && !supplier)
    throw new HttpError(400, "Guardá el proveedor antes de asignarlo al lote");
  if (supplier && !supplier.active && supplier.id !== currentId)
    throw new HttpError(400, "El proveedor está archivado");
  return { supplierId: supplier?.id ?? null, supplier: supplier?.name ?? "" };
}
