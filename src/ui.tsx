import {
  useState,
  useId,
  Children,
  isValidElement,
  cloneElement,
  type ReactElement,
  type ReactNode,
  type FormEvent,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  ArrowUpRight,
  ArrowDownRight,
  ArrowRight,
  CircleNotch,
  MagnifyingGlass,
  Tray,
} from "@phosphor-icons/react";
import { initials } from "./lib";
export function Brand() {
  return (
    <div className="brand" role="img" aria-label="Bombo">
      <img className="brand-on-dark" src="/brand/bombo-white.webp" alt="" aria-hidden="true" />
      <img className="brand-on-light" src="/brand/bombo-olive.webp" alt="" aria-hidden="true" />
    </div>
  );
}
export function Avatar({
  name,
  color,
  size = 34,
}: {
  name: string;
  color?: string;
  size?: number;
}) {
  return (
    <span
      className="avatar"
      style={{
        background: color ? `${color}28` : undefined,
        color: color || "#3e402e",
        width: size,
        height: size,
      }}
    >
      {initials(name)}
    </span>
  );
}
export function Badge({
  children,
  tone = "green",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="badge-dot" />
      {children}
    </span>
  );
}
export function Empty({
  title = "Todavía no hay registros",
  description = "Los nuevos registros aparecerán aquí.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="empty">
      <Tray size={34} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
export function Search({
  value,
  onChange,
  placeholder = "Buscar…",
}: {
  value: string;
  onChange: (s: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="search-field">
      <MagnifyingGlass size={18} />
      <input
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button type="button" aria-label="Limpiar búsqueda" onClick={() => onChange("")}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}
export function Panel({
  title,
  sub,
  action,
  children,
  className = "",
}: {
  title: ReactNode;
  sub?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          {sub && <p>{sub}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Metric({
  title,
  value,
  icon,
  change,
  detail,
  spark,
}: {
  title: string;
  value: string;
  icon: ReactNode;
  change?: number | null;
  detail?: string;
  spark?: number[];
}) {
  const max = Math.max(...(spark || [1]), 1);
  return (
    <div className="metric">
      <div className="metric-top">
        <span>{title}</span>
        <span className="metric-icon">{icon}</span>
      </div>
      <strong>{value}</strong>
      <div className="metric-bottom">
        {change != null ? (
          <>
            <span className={change >= 0 ? "trend up" : "trend down"}>
              {change >= 0 ? <ArrowUpRight /> : <ArrowDownRight />}
              {Math.abs(change).toFixed(1)}%
            </span>
            <span>vs. período anterior</span>
          </>
        ) : (
          <span>{detail || "En el período seleccionado"}</span>
        )}
      </div>
      {spark && (
        <div className="spark" aria-hidden="true">
          {spark.map((n, i) => (
            <i key={i} style={{ height: `${Math.max(8, (n / max) * 100)}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}
export function ActionLink({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className="action-link" onClick={onClick}>
      {children}
      <ArrowRight size={15} />
    </button>
  );
}
export function Modal({
  title,
  description,
  open,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const descriptionId = useId();
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className={`modal ${wide ? "wide" : ""}`}
          aria-describedby={description ? descriptionId : undefined}
        >
          <div className="modal-body">
            <div className="modal-head">
              <div>
                <Dialog.Title>{title}</Dialog.Title>
                {description && (
                  <Dialog.Description id={descriptionId}>
                    {description}
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close className="icon-button" aria-label="Cerrar">
                <X size={22} />
              </Dialog.Close>
            </div>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Form({
  children,
  onSubmit,
  submit = "Guardar",
  onCancel,
}: {
  children: ReactNode;
  onSubmit: (form: FormData) => Promise<void>;
  submit?: string;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const fd = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await onSubmit(fd);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={run}>
      {children}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        {onCancel && (
          <button type="button" className="button" onClick={onCancel}>
            Cancelar
          </button>
        )}
        <button className="button primary" disabled={busy}>
          {busy ? (
            <>
              <CircleNotch className="spin" />
              Guardando…
            </>
          ) : (
            submit
          )}
        </button>
      </div>
    </form>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {Children.map(children, (child) => {
        if (!isValidElement(child) || typeof child.type !== "string" || !["input", "select", "textarea"].includes(child.type)) return child;
        const control = child as ReactElement<{ id?: string; "aria-describedby"?: string }>;
        return cloneElement(control, {
          id,
          "aria-describedby": hint ? [control.props["aria-describedby"], hintId].filter(Boolean).join(" ") : control.props["aria-describedby"],
        });
      })}
      {hint && <small id={hintId}>{hint}</small>}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`page-heading${className ? ` ${className}` : ""}`}>
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="heading-actions">{actions}</div>
    </div>
  );
}
