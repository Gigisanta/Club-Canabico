import type { ReactNode } from "react";

export function SectionHeading({ eyebrow, title, detail, action }: { eyebrow?: string; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="ops-section-heading">
      <div>
        {eyebrow && <span className="ops-kicker">{eyebrow}</span>}
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {action && <div className="ops-heading-action" role="group" aria-label={`${title}: acciones`}>{action}</div>}
    </div>
  );
}

export function LoadingState({ label = "Cargando…" }: { label?: string }) {
  return <div className="ops-state" role="status"><span className="ops-spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="ops-state ops-state-error" role="alert"><p>{message}</p>{retry && <button className="ops-button ops-button-quiet" type="button" onClick={retry}>Reintentar</button>}</div>;
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="ops-empty"><span aria-hidden="true">—</span><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

export function StatusTag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "olive" }) {
  return <span className={`ops-status ops-status-${tone}`}>{children}</span>;
}

export function InfoBand({ children, tone = "info", title }: { children: ReactNode; tone?: "info" | "warning" | "blocked"; title?: string }) {
  return <aside className={`ops-info-band ops-info-${tone}`} role={tone === "blocked" ? "status" : undefined}>{title && <strong>{title}</strong>}<div>{children}</div></aside>;
}

export function DataTable({ children, label }: { children: ReactNode; label: string }) {
  return <div className="ops-table-scroll"><table className="ops-table"><caption className="sr-only">{label}</caption>{children}</table></div>;
}

export function ActionButton({ children, onClick, quiet = false, disabled = false, title }: { children: ReactNode; onClick: () => void; quiet?: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" title={title} className={`ops-button${quiet ? " ops-button-quiet" : " ops-button-primary"}`} onClick={onClick} disabled={disabled}>{children}</button>;
}

export function MinorMeta({ children }: { children: ReactNode }) {
  return <span className="ops-meta">{children}</span>;
}
