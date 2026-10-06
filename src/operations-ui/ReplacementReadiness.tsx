import { useId } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { cutoverGateIds } from "../../shared/operations/contracts";
import { hasCapability } from "./api";
import type { OperationsContext } from "./types";
import "./replacement-readiness.css";

type GateId = typeof cutoverGateIds[number];
type GateRecord = Record<string, unknown>;
type StepId = "sources" | "opening" | "daily" | "handoff";
type SectionId = "imports" | "accounts" | "catalog" | "orders" | "routes" | "reports" | "permissions" | "gates";

const gateCopy: Record<GateId, { label: string; step: StepId }> = {
  "legacy-writers-inventoried": { label: "Fuentes que todavía escriben", step: "sources" },
  "legacy-queues-drained": { label: "Colas del sistema anterior", step: "handoff" },
  "final-export-consistent": { label: "Exportación final", step: "sources" },
  "final-delta-reconciled": { label: "Diferencias del período final", step: "sources" },
  "open-objects-approved": { label: "Pendientes operativos abiertos", step: "opening" },
  "physical-opening-approved": { label: "Existencias de apertura", step: "opening" },
  "cash-opening-approved": { label: "Saldo inicial de caja", step: "opening" },
  "legacy-writes-disabled": { label: "Retiro de escrituras anteriores", step: "handoff" },
  "android-accepted": { label: "Jornada en Android", step: "daily" },
  "restore-accepted": { label: "Prueba de restauración", step: "daily" },
  "shadow-seven-days": { label: "Uso en sombra durante siete días", step: "daily" },
  "analytics-approved": { label: "Informes operativos", step: "daily" },
  "professional-permissions-approved": { label: "Permisos profesionales", step: "daily" },
  "handoff-approved": { label: "Decisión de traspaso", step: "handoff" },
};

const stepCopy: Record<StepId, { title: string; description: string; sections: SectionId[] }> = {
  sources: {
    title: "Fuentes e historia",
    description: "Identificar los sistemas que escriben y revisar la exportación y sus diferencias.",
    sections: ["imports", "reports"],
  },
  opening: {
    title: "Saldos y pendientes",
    description: "Revisar los objetos abiertos y los saldos que acompañan el cambio.",
    sections: ["accounts", "catalog", "orders"],
  },
  daily: {
    title: "Jornada y continuidad",
    description: "Consultar la jornada Android, la restauración, los días en sombra, los informes y los permisos profesionales.",
    sections: ["orders", "routes", "reports", "permissions"],
  },
  handoff: {
    title: "Retiro de escrituras y traspaso",
    description: "Revisar las colas, el retiro de escrituras anteriores y la decisión de traspaso.",
    sections: ["imports", "gates"],
  },
};

const stepOrder: StepId[] = ["sources", "opening", "daily", "handoff"];

const sectionLabels: Record<SectionId, string> = {
  imports: "Importación legado",
  accounts: "Cuentas y saldos",
  catalog: "Catálogo y stock",
  orders: "Pedidos",
  routes: "Rutas y entregas",
  reports: "Informes",
  permissions: "Permisos y documentos",
  gates: "Habilitación y auditoría",
};

const sectionCapabilities: Record<SectionId, string[]> = {
  imports: ["imports.write", "imports.review"],
  accounts: ["finance.read"],
  catalog: ["stock.read"],
  orders: ["operations.read"],
  routes: ["logistics.write"],
  reports: ["reports.read"],
  permissions: ["documents.read", "documents.write", "permissions.verify"],
  gates: ["cutover.approve"],
};

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function recordValue(value: unknown): GateRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as GateRecord : null;
}

function reviewStatus(gate: GateRecord | null) {
  if (!gate) return { label: "Sin evidencia registrada", tone: "missing" };
  const status = textValue(gate.status)?.toLowerCase();
  if (status === "approved") return { label: "Revisión registrada", tone: "recorded" };
  if (status === "pending") return { label: "Pendiente", tone: "pending" };
  if (status === "rejected") return { label: "Revisión no aceptada", tone: "pending" };
  return { label: "Estado por confirmar", tone: "unknown" };
}

const evidenceLabels: Record<string, string> = {
  detail: "Detalle",
  description: "Descripción",
  evidence: "Evidencia",
  note: "Nota",
  notes: "Notas",
  reason: "Motivo",
  reference: "Referencia",
  source: "Fuente",
  summary: "Resumen",
};

function evidenceText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const parts = value.flatMap(item => typeof item === "string" && item.trim() ? [item.trim()] : []);
    return parts.length ? parts.join(" · ") : value.length ? "Evidencia registrada" : null;
  }
  const record = recordValue(value);
  if (!record) return null;
  const parts = Object.entries(record).flatMap(([key, item]) => {
    const label = evidenceLabels[key.toLowerCase()];
    return label && typeof item === "string" && item.trim() ? [`${label}: ${item.trim()}`] : [];
  });
  return parts.length ? parts.join(" · ") : Object.keys(record).length ? "Evidencia registrada" : null;
}

function formatReviewDate(value: unknown, timeZone: string): { iso: string; label: string } | null {
  const source = textValue(value);
  if (!source) return null;
  const date = new Date(source);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    return {
      iso: date.toISOString(),
      label: new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date),
    };
  } catch {
    return { iso: date.toISOString(), label: date.toLocaleString("es-AR") };
  }
}

function stepStatus(gates: Array<GateRecord | null>, stale: boolean): string {
  if (stale) return "Información desactualizada";
  if (gates.some(gate => !gate)) return "Hay controles sin evidencia registrada";
  if (gates.some(gate => textValue(gate?.status)?.toLowerCase() === "pending")) return "Hay controles pendientes";
  if (gates.every(gate => textValue(gate?.status)?.toLowerCase() === "approved")) return "Revisiones registradas en este paso";
  return "Hay estados por confirmar";
}

function canOpenSection(context: OperationsContext, section: SectionId): boolean {
  return sectionCapabilities[section].some(capability => hasCapability(context, capability));
}

function canonicalGateMap(gates: GateRecord[]): Map<GateId, GateRecord | null> {
  const canonical = new Set<string>(cutoverGateIds);
  const byId = new Map<GateId, GateRecord | null>();
  for (const candidate of Array.isArray(gates) ? gates : []) {
    const gate = recordValue(candidate);
    const id = textValue(gate?.id);
    if (!gate || !id || !canonical.has(id)) continue;
    const canonicalId = id as GateId;
    byId.set(canonicalId, byId.has(canonicalId) ? null : gate);
  }
  return byId;
}

export function ReplacementReadiness({ context, gates, stale = false }: {
  context: OperationsContext;
  gates: Record<string, unknown>[];
  stale?: boolean;
}) {
  const [searchParams] = useSearchParams();
  const headingId = useId();

  // The authority endpoint is owner/cutover-capability scoped; do not leak its rows into other profiles.
  if (!hasCapability(context, "cutover.approve")) return null;

  const gateMap = canonicalGateMap(gates);
  const sectionSearch = (section: SectionId) => {
    const next = new URLSearchParams(searchParams);
    next.set("section", section);
    return `?${next.toString()}`;
  };

  return (
    <section className="rr-readiness" aria-labelledby={headingId}>
      <header className="rr-header">
        <div>
          <p className="rr-eyebrow">Guía de operación</p>
          <h2 id={headingId}>Revisión del reemplazo total</h2>
          <p className="rr-intro">Cuatro pasos cotidianos para revisar fuentes, saldos, jornadas y traspaso.</p>
        </div>
      </header>

      <div className="rr-observations" aria-label="Estado observado del circuito">
        {context.authority.mode === "active" ? (
          <p className="rr-authority"><strong>Fuente Bombo observada</strong><span>El contexto del circuito informa autoridad activa.</span></p>
        ) : context.authority.mode === "shadow" ? (
          <p className="rr-authority"><strong>Circuito en sombra</strong><span>El contexto de Bombo informa el modo en sombra.</span></p>
        ) : (
          <p className="rr-authority"><strong>Autoridad por confirmar</strong><span>El contexto no informa un modo reconocido.</span></p>
        )}
        {context.rehearsal && (
          <p className="rr-rehearsal" role="note"><strong>Evidencias de ensayo</strong><span>Estas revisiones no acreditan condiciones de producción.</span></p>
        )}
        {stale && (
          <p className="rr-stale" role="status"><strong>Datos desactualizados</strong><span>Actualizá Habilitación y auditoría antes de interpretar las revisiones.</span></p>
        )}
      </div>

      <p className="rr-boundary">Cada estado indica una revisión registrada; la guía no declara por sí sola que el reemplazo esté ejecutado.</p>

      <div className="rr-steps">
        {stepOrder.map((stepId, index) => {
          const step = stepCopy[stepId];
          const stepGates = cutoverGateIds
            .filter(id => gateCopy[id].step === stepId)
            .map(id => ({ id, gate: gateMap.get(id) ?? null }));
          const visibleSections = step.sections.filter(section => canOpenSection(context, section));
          const summary = stepStatus(stepGates.map(item => item.gate), stale);

          return (
            <section className="rr-step" key={stepId} aria-labelledby={`${headingId}-step-${stepId}`}>
              <header className="rr-step-header">
                <span className="rr-step-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <span className="rr-step-copy">
                  <h3 id={`${headingId}-step-${stepId}`}>{step.title}</h3>
                  <p>{step.description}</p>
                </span>
                <span className="rr-step-meta">
                  <span className="rr-step-status">{summary}</span>
                  <span className="rr-step-count">{stepGates.length} controles</span>
                </span>
              </header>

              <ul className="rr-gates">
                {stepGates.map(({ id, gate }) => {
                  const status = reviewStatus(gate);
                  const evidence = evidenceText(gate?.evidence);
                  const approvedBy = textValue(gate?.approvedBy);
                  const reviewedBy = textValue(gate?.reviewedBy);
                  const reviewedAt = formatReviewDate(gate?.approvedAt, context.timeZone);
                  return (
                    <li className="rr-gate" key={id}>
                      <details className="rr-gate-disclosure">
                        <summary className="rr-gate-summary">
                          <strong>{gateCopy[id].label}</strong>
                          <span className={`rr-status rr-status-${status.tone}`}>{status.label}</span>
                          <span className="rr-gate-chevron" aria-hidden="true">⌄</span>
                        </summary>
                        <div className="rr-gate-details">
                          {evidence ? <p><span>Evidencia</span><strong>{evidence}</strong></p> : gate ? <p><span>Evidencia</span><strong>No disponible en esta vista</strong></p> : null}
                          {(approvedBy || reviewedBy) && (
                            <p><span>Personas</span><strong>{[approvedBy && "Autor registrado", reviewedBy && "Revisor registrado"].filter(Boolean).join(" · ")}</strong></p>
                          )}
                          {reviewedAt && <p><span>Fecha</span><time dateTime={reviewedAt.iso}>{reviewedAt.label}</time></p>}
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>

              {visibleSections.length > 0 && (
                <nav className="rr-section-links" aria-label={`Secciones relacionadas: ${step.title}`}>
                  {visibleSections.map(section => (
                    <Link className="rr-section-link" key={section} to={{ search: sectionSearch(section) }}>
                      <span>{sectionLabels[section]}</span><span aria-hidden="true">→</span>
                    </Link>
                  ))}
                </nav>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
}
