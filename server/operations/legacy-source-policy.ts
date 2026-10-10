import { OperationError } from "./core.js";
import { isTechnicalLegacySource } from "../../shared/operations/source-control.js";

export { requireFullLegacySourceScope } from "./core.js";

export function assertLegacyHistorySourceAllowed(sourceSystem: string): void {
  if (!isTechnicalLegacySource(sourceSystem)) return;
  throw new OperationError(
    423,
    "LEGACY_TECHNICAL_SOURCE_BLOCKED",
    "Las fuentes técnicas de observaciones y archivo sólo se consultan en sus vistas de conciliación; no se pueden aprobar, mapear, activar, proyectar, corregir ni publicar como historia o maestros canónicos.",
  );
}
