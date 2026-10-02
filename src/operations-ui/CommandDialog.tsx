import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ActionField, CommandAction, JsonRecord, RunCommand } from "./types";
import { isUncertainCommandOutcome } from "./api";
import { RemoteSelect } from "./RemoteSelect";

interface CommandDialogProps {
  action: CommandAction;
  runCommand: RunCommand;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

function FieldControl({ field }: { field: ActionField }) {
  if (field.type === "repeat") return <RepeatedFields field={field} />;
  const id = `ops-field-${field.name}`;
  const common = {
    id,
    name: field.name,
    required: field.required,
    "aria-label": field.label,
    "aria-describedby": field.help ? `${id}-help` : undefined,
  };

  if (field.type === "textarea") {
    return <textarea {...common} rows={3} placeholder={field.placeholder} defaultValue={typeof field.defaultValue === "string" ? field.defaultValue : undefined} />;
  }
  if (field.type === "select") {
    if (field.lookupPath) return <RemoteSelect field={field} />;
    return (
      <select {...common} defaultValue={typeof field.defaultValue === "string" ? field.defaultValue : ""}>
        <option value="">Elegí una opción</option>
        {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  if (field.type === "checkbox") {
    return <input {...common} type="checkbox" defaultChecked={field.defaultValue === true} />;
  }
  const textualType = field.type === "email" || field.type === "tel" || field.type === "date" || field.type === "month" || field.type === "datetime-local" ? field.type : "text";
  const inputMode = field.type === "amount" || field.type === "decimal" ? "decimal" : field.type === "integer" ? "numeric" : undefined;
  return (
    <input
      {...common}
      type={textualType}
      inputMode={inputMode}
      placeholder={field.placeholder}
      defaultValue={typeof field.defaultValue === "string" ? field.defaultValue : undefined}
      min={field.min}
      max={field.max}
      step={field.step}
      autoComplete="off"
    />
  );
}

function RepeatedFields({ field }: { field: ActionField }) {
  const defaults = (): Record<string, string | boolean> => ({ entryId: crypto.randomUUID(), ...Object.fromEntries((field.fields ?? []).map(child => [child.name, child.defaultValue ?? (child.type === "checkbox" ? false : "")])) });
  const [rows, setRows] = useState(() => Array.from({ length: field.initialRows ?? 0 }, () => ({ key: crypto.randomUUID(), values: defaults() })));
  return <div className="ops-repeat-fields">
    <input type="hidden" name={field.name} value={JSON.stringify(rows.map(row => row.values))} />
    {rows.map((row, index) => <fieldset className="ops-repeat-row" key={row.key} onChange={event => {
      const control = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      const name = control.name.replace(`${field.name}-${row.key}-`, "");
      const value = control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value;
      setRows(current => current.map(item => {
        if (item.key !== row.key) return item;
        const next = { ...item.values, [name]: value };
        for (const child of field.rowFields?.(next) ?? field.fields ?? []) {
          if (child.type !== "select") continue;
          if (next[child.name] && !child.options?.some(option => option.value === next[child.name])) next[child.name] = "";
          if (child.autoSelectSingleOption && child.options?.length === 1) next[child.name] = child.options[0]!.value;
        }
        return { ...item, values: next };
      }));
    }}>
      <legend>{field.label} {index + 1}</legend>
      {(field.rowFields?.(row.values) ?? field.fields ?? []).map(child => {
        const nested = { ...child, name: `${field.name}-${row.key}-${child.name}`, defaultValue: row.values[child.name] ?? child.defaultValue };
        return <label className="ops-field" htmlFor={`ops-field-${nested.name}`} key={child.name}>
          <span>{child.label}{child.required && <i aria-hidden="true"> ·</i>}</span>
          <FieldControl field={nested} />
          {child.help && <small id={`ops-field-${nested.name}-help`}>{child.help}</small>}
        </label>;
      })}
      <button className="ops-button ops-button-quiet ops-button-small" type="button" onClick={() => setRows(current => current.filter(item => item.key !== row.key))}>Quitar {index + 1}</button>
    </fieldset>)}
    <button className="ops-button ops-button-quiet" type="button" disabled={rows.length >= (field.maxRows ?? 200)} onClick={() => setRows(current => [...current, { key: crypto.randomUUID(), values: defaults() }])}>{field.addLabel ?? "Agregar línea"}</button>
  </div>;
}

export function CommandDialog({ action, runCommand, onClose, onSuccess }: CommandDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const target = useRef(action.targetId ?? crypto.randomUUID());
  const attemptedData = useRef<JsonRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  useEffect(() => {
    if (!busy && !uncertain) return;
    const preventLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeaving);
    return () => window.removeEventListener("beforeunload", preventLeaving);
  }, [busy, uncertain]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const values: Record<string, string | boolean> = {};
    for (const field of action.fields) {
      values[field.name] = field.type === "checkbox" ? form.has(field.name) : String(form.get(field.name) ?? "").trim();
    }
    try {
      const targetId = target.current;
      const expectedVersion = action.expectedVersion ?? 0;
      const data = attemptedData.current ?? action.toData(values);
      attemptedData.current = data;
      const result = await runCommand(action.command, targetId, expectedVersion, data, action.requestIdIsTarget);
      dialog.current?.close();
      onSuccess(`${action.title} quedó registrado.`);
      onClose();
    } catch (cause) {
      const pendingConfirmation = uncertain || isUncertainCommandOutcome(cause);
      setUncertain(pendingConfirmation);
      if (!pendingConfirmation) attemptedData.current = null;
      setError(pendingConfirmation ? "Confirmación pendiente: el servidor pudo registrar esta acción. Reintentá con los mismos datos antes de cerrar el formulario." : cause instanceof Error ? cause.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog className="ops-dialog" ref={dialog} aria-labelledby="ops-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy && !uncertain) onClose(); }}>
      <form className="ops-dialog-card" onSubmit={submit}>
        <header className="ops-dialog-head">
          <div>
            <span className="ops-kicker">Acción registrada</span>
            <h2 id="ops-dialog-title">{action.title}</h2>
            {action.description && <p>{action.description}</p>}
          </div>
          <button type="button" className="ops-icon-button" aria-label="Cerrar formulario" onClick={onClose} disabled={busy || uncertain}>×</button>
        </header>
        <fieldset className="ops-dialog-fields" disabled={busy || uncertain}>
          {action.fields.map(field => (
            field.type === "repeat" ? <fieldset className="ops-repeat-group" key={field.name}><legend>{field.label}</legend><FieldControl field={field} />{field.help && <small>{field.help}</small>}</fieldset> :
            <label className={`ops-field${field.type === "checkbox" ? " ops-field-check" : ""}`} htmlFor={`ops-field-${field.name}`} key={field.name}>
              {field.type === "checkbox" ? <FieldControl field={field} /> : <span>{field.label}{field.required && <i aria-hidden="true"> ·</i>}</span>}
              {field.type !== "checkbox" && <FieldControl field={field} />}
              {field.help && <small id={`ops-field-${field.name}-help`}>{field.help}</small>}
              {field.type === "checkbox" && <span>{field.label}</span>}
            </label>
          ))}
        </fieldset>
        {error && <p className="ops-inline-error" role="alert">{error}</p>}
        <footer className="ops-dialog-actions">
          <button type="button" className="ops-button ops-button-quiet" onClick={onClose} disabled={busy || uncertain}>Cancelar</button>
          <button type="submit" className="ops-button ops-button-primary" disabled={busy}>
            {busy ? "Guardando…" : action.submitLabel ?? "Registrar"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function evidenceFrom(value: string | boolean | undefined, label = "nota"): JsonRecord {
  const note = typeof value === "string" ? value.trim() : "";
  if (!note) throw new Error("Agregá una evidencia o motivo para continuar.");
  return { [label]: note };
}
