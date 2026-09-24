import type { Prisma } from "@prisma/client";
import { HttpError } from "./validation.js";

export const locationName = (name: string) => name.trim().replace(/\s+/g, " ");
export const locationKey = (name: string) => locationName(name).toLowerCase();

export async function resolveLocation(
  tx: Prisma.TransactionClient,
  locationId: string | null,
  legacyName: string,
  currentId?: string | null,
  allowCreate = false,
) {
  const location = locationId
    ? await tx.location.findUnique({ where: { id: locationId } })
    : allowCreate
      ? await tx.location.upsert({
          where: { key: locationKey(legacyName) },
          create: { name: locationName(legacyName), key: locationKey(legacyName) },
          update: {},
        })
      : await tx.location.findUnique({ where: { key: locationKey(legacyName) } });
  if (!location) throw new HttpError(400, "Elegí una ubicación guardada");
  if (!location.active && location.id !== currentId)
    throw new HttpError(400, "La ubicación está archivada");
  return { locationId: location.id, location: location.name };
}
