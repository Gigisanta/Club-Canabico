import { OperationError } from "./core.js";

const TECHNICAL_LEGACY_SOURCE_SYSTEMS = new Set([
  "appsheet-business-archive",
  "appsheet-finance-observations",
]);

export function assertLegacyHistorySourceAllowed(sourceSystem: string): void {
  if (!TECHNICAL_LEGACY_SOURCE_SYSTEMS.has(sourceSystem)) return;
  throw new OperationError(
    423,
    "LEGACY_TECHNICAL_SOURCE_BLOCKED",
    "Las fuentes técnicas de observaciones y archivo sólo se consultan en sus vistas de conciliación; no se pueden aprobar, mapear, activar, proyectar, corregir ni publicar como historia o maestros canónicos.",
  );
}
