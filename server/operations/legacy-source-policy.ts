import { objectScope, OperationError, type Tx } from "./core.js";
import type { User } from "@prisma/client";
import { isTechnicalLegacySource } from "../../shared/operations/source-control.js";

export async function requireFullLegacySourceScope(tx: Tx, actor: User): Promise<void> {
  const scope = await objectScope(tx, actor);
  const access = await tx.operationAccess.findUnique({ where: { userId: actor.id }, select: { profile: true } });
  const profile = access?.profile ?? actor.role;
  if (Object.values(scope).some((value) => value !== undefined) || profile === "driver" || profile === "cashier")
    throw new OperationError(403, "LEGACY_SOURCE_FULL_SCOPE_REQUIRED", "La conciliación de fuentes requiere alcance operativo completo");
}

export function assertLegacyHistorySourceAllowed(sourceSystem: string): void {
  if (!isTechnicalLegacySource(sourceSystem)) return;
  throw new OperationError(
    423,
    "LEGACY_TECHNICAL_SOURCE_BLOCKED",
    "Las fuentes técnicas de observaciones y archivo sólo se consultan en sus vistas de conciliación; no se pueden aprobar, mapear, activar, proyectar, corregir ni publicar como historia o maestros canónicos.",
  );
}
