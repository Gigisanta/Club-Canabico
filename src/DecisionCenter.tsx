import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowClockwise, ArrowRight, Plus } from "@phosphor-icons/react";
import { toast } from "sonner";
import type {
  DecisionCard,
  DecisionCenterPayload,
  DecisionKind,
  DecisionTaskView,
  EvidenceState,
  MonthlyReviewView,
} from "../shared/decision-center";
import { send, useResource } from "./lib";
import { Badge, Empty, Field, Form, Modal, PageHeader, Panel } from "./ui";
import "./decision-center.css";

type TaskStatus = DecisionTaskView["status"];
type TaskUpdate = {
  status: TaskStatus;
  ownerId: string | null;
  dueDate: string;
};

const cardOrder: DecisionKind[] = ["replenishment", "commercial", "cash"];

const evidenceLabels: Record<EvidenceState, string> = {
  demo: "Demostración",
  missing: "Sin datos",
  imported: "Importado",
  reconciled: "Conciliado",
  estimated: "Estimado",
  scenario: "Escenario",
};

const evidenceTones: Record<EvidenceState, string> = {
  demo: "amber",
  missing: "red",
  imported: "blue",
  reconciled: "green",
  estimated: "amber",
  scenario: "blue",
};

const kindLabels: Record<DecisionKind, string> = {
  replenishment: "Stock",
  commercial: "Comercial",
  cash: "Caja",
};

const taskStatusLabels: Record<TaskStatus, string> = {
  todo: "Pendiente",
  doing: "En curso",
  done: "Hecha",
};

const arsWholeFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
const decimalSeparator =
  new Intl.NumberFormat("es-AR").formatToParts(1.1).find((part) => part.type === "decimal")?.value || ",";

function formatCents(value: string): string {
  if (!/^-?\d+$/.test(value)) return "Importe inválido";
  const cents = BigInt(value);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  const amount = `${arsWholeFormatter.format(whole)}${decimalSeparator}${fraction}`;
  if (!negative) return amount;
  const sign = arsWholeFormatter.formatToParts(-1n).find((part) => part.type === "minusSign")?.value || "−";
  return `${sign}${amount}`;
}

function formatQuantity(milli: number): string {
  return new Intl.NumberFormat("es-AR", { maximumFractionDigits: 3 }).format(milli / 1000);
}

function formatDateTime(value: string): string {
  if (!value) return "Sin fecha informada";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(date);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isPeriod(value: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return false;
  return !Number.isNaN(new Date(`${value}-01T00:00:00.000Z`).getTime());
}

function formatPeriod(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return period;
  const date = new Date(`${period}-01T12:00:00`);
  if (Number.isNaN(date.getTime())) return period;
  return new Intl.DateTimeFormat("es-AR", { month: "long", year: "numeric" }).format(date);
}

function parseCentsInput(raw: string, fieldName: string): string | null {
  const value = raw.trim().replace(",", ".");
  if (!value) return null;
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`${fieldName}: ingresá un importe con hasta dos decimales.`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const total = BigInt(wholePart) * 100n + BigInt(fractionPart.padEnd(2, "0") || "0");
  return (negative ? -total : total).toString();
}

function isTaskStatus(value: string): value is TaskStatus {
  return value === "todo" || value === "doing" || value === "done";
}

function isEvidenceState(value: string): value is EvidenceState {
  return Object.prototype.hasOwnProperty.call(evidenceLabels, value);
}

function localPath(path: string): string | null {
  const value = path.trim();
  return value.startsWith("/") && !value.startsWith("//") ? value : null;
}

function EvidenceBadge({ state }: { state: EvidenceState }) {
  return <Badge tone={evidenceTones[state]}>{evidenceLabels[state]}</Badge>;
}

function DecisionCardView({ card }: { card: DecisionCard }) {
  const path = localPath(card.path);
  const impact = card.impactCents == null ? null : formatCents(card.impactCents);
  const quantity = card.quantityMilli == null ? null : formatQuantity(card.quantityMilli);

  return (
    <article className={`dc-decision-card dc-decision-card--${card.kind}`}>
      <header className="dc-decision-card__head">
        <span className="dc-kind">{kindLabels[card.kind]}</span>
        <EvidenceBadge state={card.evidence} />
      </header>
      <h2>{card.title}</h2>
      <p className="dc-summary">{card.summary}</p>
      <p className="dc-next-step">
        <span>Siguiente paso</span>
        <strong>{card.nextStep || "No se indicó un siguiente paso."}</strong>
      </p>

      {(impact !== null || quantity !== null) && (
        <dl className="dc-card-metrics">
          {impact !== null && (
            <div>
              <dt>Impacto</dt>
              <dd>{impact}</dd>
            </div>
          )}
          {quantity !== null && (
            <div>
              <dt>Cantidad</dt>
              <dd>{quantity}</dd>
            </div>
          )}
        </dl>
      )}

      <dl className="dc-card-meta">
        <div>
          <dt>Fuente</dt>
          <dd>{card.source.trim() || "No informada"}</dd>
        </div>
        <div>
          <dt>Actualizado</dt>
          <dd>
            {card.asOf ? <time dateTime={card.asOf}>{formatDateTime(card.asOf)}</time> : "Sin fecha informada"}
          </dd>
        </div>
        <div>
          <dt>Responsable</dt>
          <dd>{card.owner.trim() || "No informado"}</dd>
        </div>
      </dl>

      <p className="dc-limitation">
        <span>Límite del análisis</span>
        {card.limitation?.trim() || "No informado por la fuente."}
      </p>

      <footer className="dc-card-action">
        <div>
          <span>Ruta</span>
          <code>{card.path || "No informada"}</code>
        </div>
        {path ? (
          <Link className="dc-action-link" to={path}>
            Abrir acción <ArrowRight size={16} aria-hidden="true" />
          </Link>
        ) : (
          <span className="dc-action-unavailable">Destino no disponible</span>
        )}
      </footer>
    </article>
  );
}

function WeeklyTaskRow({
  task,
  users,
  onSave,
}: {
  task: DecisionTaskView;
  users: DecisionCenterPayload["users"];
  onSave: (id: string, update: TaskUpdate) => Promise<void>;
}) {
  return (
    <article className={`dc-task-row dc-task-row--${task.status}`}>
      <div className="dc-task-row__title">
        <span className="dc-task-mark" aria-hidden="true">{task.status === "done" ? "✓" : ""}</span>
        <div>
          <h3>{task.title}</h3>
          <Badge tone={task.status === "done" ? "green" : task.status === "doing" ? "amber" : "blue"}>
            {taskStatusLabels[task.status]}
          </Badge>
        </div>
      </div>
      <Form
        submit="Guardar tarea"
        onSubmit={async (form) => {
          const status = String(form.get("status") || "");
          const ownerId = String(form.get("ownerId") || "");
          const dueDate = String(form.get("dueDate") || "");
          if (!isTaskStatus(status)) throw new Error("Elegí un estado válido para la tarea.");
          if (!isCalendarDate(dueDate)) throw new Error("Indicá una fecha válida.");
          await onSave(task.id, { status, ownerId: ownerId || null, dueDate });
        }}
      >
        <div className="dc-task-fields">
          <Field label="Estado">
            <select name="status" defaultValue={task.status}>
              <option value="todo">Pendiente</option>
              <option value="doing">En curso</option>
              <option value="done">Hecha</option>
            </select>
          </Field>
          <Field label="Responsable">
            <select name="ownerId" defaultValue={task.ownerId || ""}>
              <option value="">Sin asignar</option>
              {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
            </select>
          </Field>
          <Field label="Vencimiento">
            <input name="dueDate" type="date" required defaultValue={task.dueDate.slice(0, 10)} />
          </Field>
        </div>
      </Form>
    </article>
  );
}

function MonthlyReviewItem({ review }: { review: MonthlyReviewView }) {
  const amounts = [
    { label: "Real", value: review.actualCents },
    { label: "Plan", value: review.planCents },
    { label: "Desvío", value: review.deviationCents },
  ].filter((item): item is { label: string; value: string } => item.value !== null);

  return (
    <article className="dc-review-card">
      <header className="dc-review-card__head">
        <div>
          <span className="dc-review-period">{formatPeriod(review.period)}</span>
          <h3>{review.metric}</h3>
        </div>
        <EvidenceBadge state={review.evidence} />
      </header>
      {amounts.length > 0 && (
        <dl className="dc-review-amounts">
          {amounts.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{formatCents(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="dc-review-notes">
        <div>
          <span>Causa</span>
          <p>{review.cause || "No informada"}</p>
        </div>
        <div>
          <span>Decisión</span>
          <p>{review.decision || "No informada"}</p>
        </div>
      </div>
      <footer className="dc-review-meta">
        <span>Fuente: {review.source.trim() || "No informada"}</span>
        <span>Responsable: {review.ownerName.trim() || "No asignado"}</span>
        {review.followUpDate && (
          <span>Seguimiento: <time dateTime={review.followUpDate}>{formatDateTime(review.followUpDate)}</time></span>
        )}
      </footer>
    </article>
  );
}

function ReviewForm({
  users,
  onSubmit,
}: {
  users: DecisionCenterPayload["users"];
  onSubmit: (form: FormData) => Promise<void>;
}) {
  return (
    <Form submit="Guardar revisión" onSubmit={onSubmit}>
      <div className="dc-review-form-grid">
        <Field label="Período">
          <input name="period" type="month" required />
        </Field>
        <Field label="Métrica">
          <input name="metric" required minLength={2} maxLength={120} />
        </Field>
        <Field label="Real (ARS)" hint="Opcional si no hay una cifra disponible. Hasta dos decimales.">
          <input name="actual" type="text" inputMode="decimal" autoComplete="off" />
        </Field>
        <Field label="Plan (ARS)" hint="Opcional si no hay una cifra disponible. Hasta dos decimales.">
          <input name="plan" type="text" inputMode="decimal" autoComplete="off" />
        </Field>
        <Field label="Responsable">
          <select name="ownerId" defaultValue="">
            <option value="">Sin asignar</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </select>
        </Field>
        <Field label="Seguimiento">
          <input name="followUpDate" type="date" />
        </Field>
        <Field label="Fuente">
          <input name="source" required minLength={2} maxLength={180} />
        </Field>
        <Field label="Estado de evidencia">
          <select name="evidence" required defaultValue="">
            <option value="" disabled>Seleccionar estado</option>
            {(Object.keys(evidenceLabels) as EvidenceState[]).filter((state) => state !== "reconciled").map((state) => (
              <option key={state} value={state}>{evidenceLabels[state]}</option>
            ))}
          </select>
        </Field>
        <Field label="Causa">
          <textarea name="cause" required rows={3} maxLength={500} />
        </Field>
        <Field label="Decisión tomada">
          <textarea name="decision" required minLength={3} rows={3} maxLength={500} />
        </Field>
      </div>
    </Form>
  );
}

export default function DecisionCenter() {
  const [params, setParams] = useSearchParams();
  const view = params.get("vista") === "seguimiento" ? "seguimiento" : "prioridades";
  const changeView = (next: "prioridades" | "seguimiento") => {
    const updated = new URLSearchParams(params);
    if (next === "prioridades") updated.delete("vista"); else updated.set("vista", next);
    setParams(updated);
  };
  const resource = useResource<DecisionCenterPayload>("/decision-center");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewCountBeforeCreate, setReviewCountBeforeCreate] = useState<number | null>(null);
  const payload = resource.data;
  const weeklyTasks = payload?.tasks.filter((task) => task.cadence === "weekly") || [];
  const completedTasks = weeklyTasks.filter((task) => task.status === "done").length;
  const cards = payload ? [...payload.cards].sort((a, b) => cardOrder.indexOf(a.kind) - cardOrder.indexOf(b.kind)) : [];

  async function saveTask(id: string, update: TaskUpdate) {
    await send(`/decision-tasks/${encodeURIComponent(id)}`, update, "PUT");
    await resource.reload();
    toast.success("Tarea actualizada.");
  }

  async function saveReview(form: FormData) {
    const period = String(form.get("period") || "");
    const metric = String(form.get("metric") || "").trim();
    const cause = String(form.get("cause") || "").trim();
    const decision = String(form.get("decision") || "").trim();
    const source = String(form.get("source") || "").trim();
    const evidence = String(form.get("evidence") || "");
    if (!isPeriod(period)) throw new Error("Indicá un período mensual válido.");
    if (metric.length < 2 || metric.length > 120) throw new Error("La métrica debe tener entre 2 y 120 caracteres.");
    if (!cause || cause.length > 500) throw new Error("La causa debe tener hasta 500 caracteres.");
    if (decision.length < 3 || decision.length > 500) throw new Error("La decisión debe tener entre 3 y 500 caracteres.");
    if (source.length < 2 || source.length > 180) throw new Error("La fuente debe tener entre 2 y 180 caracteres.");
    if (!isEvidenceState(evidence)) throw new Error("Seleccioná un estado de evidencia válido.");
    const actualCents = parseCentsInput(String(form.get("actual") || ""), "Real");
    const planCents = parseCentsInput(String(form.get("plan") || ""), "Plan");
    const ownerId = String(form.get("ownerId") || "");
    const followUpDate = String(form.get("followUpDate") || "");
    if (followUpDate && !isCalendarDate(followUpDate)) throw new Error("Indicá una fecha de seguimiento válida.");

    await send("/monthly-reviews", {
      period,
      metric,
      actualCents,
      planCents,
      cause,
      decision,
      ownerId: ownerId || null,
      followUpDate: followUpDate || null,
      source,
      evidence,
    });
    setReviewCountBeforeCreate(payload?.reviews.length ?? null);
    setReviewOpen(false);
    await resource.reload();
    toast.success("Revisión mensual guardada.");
  }

  return (
    <div className="decision-center">
      <PageHeader
        eyebrow="GESTIÓN · DECISIONES"
        title="Centro de decisiones"
        description="Prioridades de stock, actividad comercial y caja con su evidencia, alcance y próximo paso."
        actions={(
          <button className="button dc-refresh" type="button" onClick={() => void resource.reload()} disabled={resource.loading}>
            <ArrowClockwise size={17} aria-hidden="true" />
            {resource.loading ? "Actualizando…" : "Actualizar"}
          </button>
        )}
      />
      <nav className="dc-view-nav" aria-label="Vistas del centro de decisiones">
        <button type="button" className={view === "prioridades" ? "active" : ""} aria-current={view === "prioridades" ? "page" : undefined} onClick={() => changeView("prioridades")}>Prioridades</button>
        <button type="button" className={view === "seguimiento" ? "active" : ""} aria-current={view === "seguimiento" ? "page" : undefined} onClick={() => changeView("seguimiento")}>Seguimiento semanal y mensual</button>
      </nav>

      {resource.error && (
        <div className="dc-error-banner" role="alert">
          <p>{payload ? "No se pudo actualizar la información." : "No se pudo cargar el centro de decisiones."} {resource.error}</p>
          {!payload && <button className="button" type="button" onClick={() => void resource.reload()}>Reintentar</button>}
        </div>
      )}

      {!payload && resource.loading && (
        <div className="dc-loading" role="status" aria-live="polite">Cargando decisiones…</div>
      )}

      {!payload && !resource.loading && resource.error && (
        <Empty title="El panel no está disponible" description="Reintentá la carga para consultar las prioridades y el seguimiento." />
      )}

      {payload && (
        <>
          {payload.demo && (
            <div className="dc-demo-banner" role="note">
              <strong>Modo demostración</strong>
              <span>La información mostrada es de ejemplo y no describe la operación real.</span>
            </div>
          )}

          <details className="dc-evidence-details">
            <summary>Calidad de los datos · {payload.demo ? "Demostración" : evidenceLabels[payload.dataQuality.state]} {payload.dataQuality.pendingConflicts > 0 ? `· ${payload.dataQuality.pendingConflicts} conflictos pendientes` : ""}</summary>
          <Panel
            className={`dc-quality dc-quality--${payload.dataQuality.state}`}
            title="Calidad de los datos"
            sub={payload.dataQuality.note || "La fuente no incluyó una nota de calidad."}
            action={<EvidenceBadge state={payload.dataQuality.state} />}
          >
            <div className="dc-quality-meta">
              <div>
                <span>Estado</span>
                <strong>{payload.demo ? "Demostración" : evidenceLabels[payload.dataQuality.state]}</strong>
              </div>
              {payload.dataQuality.latestSource && (
                <div><span>Fuente reciente</span><strong>{payload.dataQuality.latestSource}</strong></div>
              )}
              {payload.dataQuality.latestCutoff && (
                <div>
                  <span>Último corte</span>
                  <strong><time dateTime={payload.dataQuality.latestCutoff}>{formatDateTime(payload.dataQuality.latestCutoff)}</time></strong>
                </div>
              )}
              <div>
                <span>Panel actualizado</span>
                <strong><time dateTime={payload.asOf}>{formatDateTime(payload.asOf)}</time></strong>
              </div>
              {payload.dataQuality.pendingConflicts > 0 && (
                <div className="dc-quality-conflicts">
                  <span>Conflictos pendientes</span>
                  <strong>{payload.dataQuality.pendingConflicts}</strong>
                </div>
              )}
            </div>
          </Panel>
          </details>

          {view === "prioridades" &&
          <section className="dc-priorities" aria-labelledby="dc-priorities-title">
            <div className="dc-section-heading">
              <div>
                <span className="dc-section-kicker">Prioridades</span>
                <h2 id="dc-priorities-title">Tres frentes de acción</h2>
              </div>
              <p>Revisá primero la evidencia y sus límites antes de avanzar.</p>
            </div>
            <div className="dc-card-grid">
              {cards.map((card, index) => <DecisionCardView key={`${card.kind}-${index}`} card={card} />)}
            </div>
          </section>
          }

          {view === "seguimiento" &&
          <div className="dc-work-grid">
            <Panel
              className="dc-weekly-panel"
              title="Checklist semanal"
              sub="Responsable, vencimiento y estado se guardan juntos por tarea."
              action={weeklyTasks.length > 0 ? (
                <span className="dc-completion">{completedTasks} de {weeklyTasks.length} hechas</span>
              ) : undefined}
            >
              {weeklyTasks.length > 0 ? (
                <>
                  <progress className="dc-progress" max={weeklyTasks.length} value={completedTasks} aria-label="Tareas semanales completadas" />
                  <div className="dc-task-list">
                    {weeklyTasks.map((task) => (
                      <WeeklyTaskRow
                        key={`${task.id}-${task.status}-${task.ownerId || "none"}-${task.dueDate}`}
                        task={task}
                        users={payload.users}
                        onSave={saveTask}
                      />
                    ))}
                  </div>
                </>
              ) : (
                <Empty title="Sin tareas semanales" description="Las tareas de esta cadencia aparecerán aquí cuando estén disponibles." />
              )}
            </Panel>

            <Panel
              className="dc-monthly-panel"
              title="Revisión mensual"
              sub="Registrá el resultado, su causa y una decisión con seguimiento."
              action={(
                <button className="button primary dc-add-review" type="button" onClick={() => setReviewOpen(true)}>
                  <Plus size={17} aria-hidden="true" /> Nueva revisión
                </button>
              )}
            >
              {payload.reviews.length > 0 ? (
                <div className="dc-review-list">
                  {payload.reviews.map((review) => <MonthlyReviewItem key={review.id} review={review} />)}
                </div>
              ) : (
                <Empty title="Todavía no hay revisiones" description="Guardá el primer análisis mensual con su fuente y estado de evidencia." />
              )}
            </Panel>
          </div>
          }
        </>
      )}

      {payload && (
        <Modal
          title="Nueva revisión mensual"
          description="Registrá la cifra disponible y dejá explícita su fuente y calidad de evidencia."
          open={reviewOpen}
          onClose={() => setReviewOpen(false)}
          wide
        >
          <ReviewForm users={payload.users} onSubmit={saveReview} />
        </Modal>
      )}

      {reviewCountBeforeCreate !== null && payload && payload.reviews.length === reviewCountBeforeCreate && resource.error && (
        <p className="dc-refresh-warning" role="status">La revisión se guardó, pero no se pudo actualizar la lista. Reintentá la carga para verla.</p>
      )}
    </div>
  );
}
