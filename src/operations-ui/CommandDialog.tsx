import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type InvalidEvent } from "react";
import type { ActionField, CommandAction, JsonRecord, RunCommand } from "./types";
import { isUncertainCommandOutcome } from "./api";
import { RemoteSelect } from "./RemoteSelect";

interface CommandDialogProps {
  action: CommandAction;
  runCommand: RunCommand;
  onClose: () => void;
  onSuccess: (message: string) => void;
}

function describedBy(...ids: Array<string | undefined>) {
  const value = ids.filter(Boolean).join(" ");
  return value || undefined;
}

function FieldControl({ field, error, errors }: { field: ActionField; error?: string; errors?: Record<string, string> }) {
  if (field.type === "repeat") return <RepeatedFields field={field} errors={errors} />;
  const id = `ops-field-${field.name}`;
  const common = {
    id,
    name: field.name,
    required: field.required,
    "aria-label": field.label,
    "aria-describedby": describedBy(field.help ? `${id}-help` : undefined, error ? `${id}-error` : undefined),
    "aria-invalid": error ? true : undefined,
  };

  if (field.type === "textarea") {
    return <textarea {...common} rows={3} placeholder={field.placeholder} defaultValue={typeof field.defaultValue === "string" ? field.defaultValue : undefined} />;
  }
  if (field.type === "select") {
    if (field.lookupPath) return <RemoteSelect field={field} validationError={error} />;
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
  const numericType = field.type === "integer" || field.type === "decimal" || field.type === "amount" ? field.type : undefined;
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
      data-numeric-type={numericType}
      data-numeric-min={numericType ? field.min : undefined}
      data-numeric-max={numericType ? field.max : undefined}
      data-numeric-step={numericType ? field.step : undefined}
      autoComplete="off"
    />
  );
}

function RepeatedFields({ field, errors = {} }: { field: ActionField; errors?: Record<string, string> }) {
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
        const error = errors[nested.name];
        return <label className="ops-field" htmlFor={`ops-field-${nested.name}`} key={child.name}>
          <span>{child.label}{child.required && <i aria-hidden="true"> ·</i>}</span>
          <FieldControl field={nested} error={error} />
          {child.help && <small id={`ops-field-${nested.name}-help`}>{child.help}</small>}
          {error && <p id={`ops-field-${nested.name}-error`} className="ops-inline-error" role="alert">{error}</p>}
        </label>;
      })}
      <button className="ops-button ops-button-quiet ops-button-small" type="button" onClick={() => setRows(current => current.filter(item => item.key !== row.key))}>Quitar {index + 1}</button>
    </fieldset>)}
    <button className="ops-button ops-button-quiet" type="button" disabled={rows.length >= (field.maxRows ?? 200)} onClick={() => setRows(current => [...current, { key: crypto.randomUUID(), values: defaults() }])}>{field.addLabel ?? "Agregar línea"}</button>
  </div>;
}

interface NumericValue {
  units: bigint;
  precision: number;
}

function parseNumericValue(value: string, type: "integer" | "decimal" | "amount"): NumericValue | null {
  let normalized = value.trim().replace(/\s/g, "");
  if (type === "amount") {
    const commaDecimal = normalized.includes(",");
    const thousandsOnly = !commaDecimal && /^-?\d{1,3}(?:\.\d{3})+$/.test(normalized);
    normalized = commaDecimal
      ? normalized.replace(/\./g, "").replace(",", ".")
      : thousandsOnly ? normalized.replace(/\./g, "") : normalized;
  }
  normalized = normalized.replace(",", ".");
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (type === "integer" && fraction) return null;
  if (type === "amount" && fraction.length > 2) return null;
  const rawUnits = BigInt(`${match[2]}${fraction}`);
  return { units: match[1] ? -rawUnits : rawUnits, precision: fraction.length };
}

function compareNumericValues(left: NumericValue, right: NumericValue) {
  const precision = Math.max(left.precision, right.precision);
  const scale = 10n ** BigInt(precision);
  const leftUnits = left.units * (scale / 10n ** BigInt(left.precision));
  const rightUnits = right.units * (scale / 10n ** BigInt(right.precision));
  return leftUnits < rightUnits ? -1 : leftUnits > rightUnits ? 1 : 0;
}

type NumericFieldSpec = Pick<ActionField, "type" | "min" | "max" | "step">;

function numericFieldError(field: NumericFieldSpec, rawValue: string): string | null {
  const type = field.type;
  if (type !== "integer" && type !== "decimal" && type !== "amount") return null;
  if (!rawValue.trim()) return null;
  const value = parseNumericValue(rawValue, type);
  if (!value) return type === "integer" ? "Ingresá un número entero válido." : type === "amount" ? "Ingresá un importe válido con hasta dos decimales." : "Ingresá una cantidad decimal válida.";
  const minimum = field.min ? parseNumericValue(field.min, type) : null;
  if (minimum && compareNumericValues(value, minimum) < 0) return `El valor mínimo es ${field.min}.`;
  const maximum = field.max ? parseNumericValue(field.max, type) : null;
  if (maximum && compareNumericValues(value, maximum) > 0) return `El valor máximo es ${field.max}.`;
  const step = field.step && field.step !== "any" ? parseNumericValue(field.step, type) : null;
  if (step && step.units !== 0n) {
    const base = minimum ?? { units: 0n, precision: 0 };
    const precision = Math.max(value.precision, base.precision, step.precision);
    const factor = 10n ** BigInt(precision);
    const scaled = (number: NumericValue) => number.units * (factor / 10n ** BigInt(number.precision));
    if ((scaled(value) - scaled(base)) % scaled(step) !== 0n) return `Usá incrementos de ${field.step}.`;
  }
  return null;
}

function numericSpecFromControl(control: HTMLInputElement): NumericFieldSpec | null {
  const type = control.dataset.numericType;
  if (type !== "integer" && type !== "decimal" && type !== "amount") return null;
  return { type, min: control.dataset.numericMin, max: control.dataset.numericMax, step: control.dataset.numericStep };
}

function nativeFieldError(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  if (control.validity.customError) return control.validationMessage || "Revisá el valor de este campo.";
  if (control.validity.valueMissing) return "Completá este campo para continuar.";
  if (control.validity.typeMismatch) return control.type === "email" ? "Ingresá un correo electrónico válido." : "Revisá el formato de este campo.";
  if (control instanceof HTMLInputElement) {
    if (control.validity.rangeUnderflow) return `Ingresá un valor igual o mayor que ${control.min}.`;
    if (control.validity.rangeOverflow) return `Ingresá un valor igual o menor que ${control.max}.`;
    if (control.validity.stepMismatch) return `Usá incrementos de ${control.step}.`;
    if (control.validity.tooLong) return `Este campo admite hasta ${control.maxLength} caracteres.`;
  }
  return "Revisá el valor de este campo.";
}

function isFormControl(target: EventTarget | null): target is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

export function CommandDialog({ action, runCommand, onClose, onSuccess }: CommandDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorSummaryRef = useRef<HTMLParagraphElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const focusSummaryPending = useRef(false);
  const submitting = useRef(false);
  const target = useRef(action.targetId ?? crypto.randomUUID());
  const attemptedData = useRef<JsonRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!element.open) element.showModal();
    return () => { if (element.open) element.close(); };
  }, []);

  useEffect(() => {
    const name = pendingFocus.current;
    const focusSummary = focusSummaryPending.current;
    if (!name && !focusSummary) return;
    pendingFocus.current = null;
    focusSummaryPending.current = false;
    if (name) {
      const control = formRef.current?.elements.namedItem(name);
      if (control instanceof HTMLElement) control.focus();
      else errorSummaryRef.current?.focus();
    } else {
      errorSummaryRef.current?.focus();
    }
  }, [error, fieldErrors]);

  useEffect(() => {
    if (!busy && !uncertain) return;
    const preventLeaving = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeaving);
    return () => window.removeEventListener("beforeunload", preventLeaving);
  }, [busy, uncertain]);

  function closeDialog() {
    if (submitting.current || uncertain) return;
    if (dialog.current?.open) dialog.current.close();
    onClose();
  }

  function handleInvalid(event: InvalidEvent<HTMLFormElement>) {
    if (!isFormControl(event.target)) return;
    const control = event.target;
    const name = control.name;
    if (name) {
      pendingFocus.current ??= name;
      const message = nativeFieldError(control);
      setFieldErrors(current => ({ ...current, [name]: message }));
    }
    setError("Revisá los campos marcados antes de continuar.");
  }

  function handleChange(event: ChangeEvent<HTMLFormElement>) {
    if (!isFormControl(event.target) || !event.target.name) return;
    const name = event.target.name;
    if (!fieldErrors[name]) return;
    const field = action.fields.find(candidate => candidate.name === name);
    const numericField = field ?? (event.target instanceof HTMLInputElement ? numericSpecFromControl(event.target) : null);
    const message = numericField
      ? numericFieldError(numericField, event.target.value)
      : event.target.validity.valid ? null : nativeFieldError(event.target);
    setFieldErrors(current => {
      if (!current[name]) return current;
      const next = { ...current };
      if (message) next[name] = message;
      else delete next[name];
      return next;
    });
    const otherFieldErrorsRemain = Object.keys(fieldErrors).some(fieldName => fieldName !== name && Boolean(fieldErrors[fieldName]));
    const clearsEditedFieldSummary = Boolean(fieldErrors[name]) && error === fieldErrors[name];
    const clearsResolvedValidationSummary = !message && !otherFieldErrorsRemain && error === "Revisá los campos marcados antes de continuar.";
    if (clearsEditedFieldSummary || clearsResolvedValidationSummary) setError("");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    setFieldErrors({});
    const form = new FormData(event.currentTarget);
    const values: Record<string, string | boolean> = {};
    for (const field of action.fields) {
      values[field.name] = field.type === "checkbox" ? form.has(field.name) : String(form.get(field.name) ?? "").trim();
    }

    const invalidValues: Record<string, string> = {};
    for (const control of formRef.current?.querySelectorAll<HTMLInputElement>("input[data-numeric-type]") ?? []) {
      const field = numericSpecFromControl(control);
      const issue = field ? numericFieldError(field, control.value) : null;
      if (issue) invalidValues[control.name] = issue;
    }
    const firstInvalid = Object.keys(invalidValues)[0];
    if (firstInvalid) {
      pendingFocus.current = firstInvalid;
      setFieldErrors(invalidValues);
      setError("Revisá los campos marcados antes de continuar.");
      return;
    }

    submitting.current = true;
    setBusy(true);
    try {
      const targetId = target.current;
      const expectedVersion = action.expectedVersion ?? 0;
      const data = attemptedData.current ?? action.toData(values);
      attemptedData.current = data;
      const result = await runCommand(action.command, targetId, expectedVersion, data, action.requestIdIsTarget);
      if (dialog.current?.open) dialog.current.close();
      onSuccess(`${action.title} quedó registrado.`);
      onClose();
    } catch (cause) {
      const pendingConfirmation = uncertain || isUncertainCommandOutcome(cause);
      setUncertain(pendingConfirmation);
      if (!pendingConfirmation) attemptedData.current = null;
      const message = pendingConfirmation ? "Confirmación pendiente: el servidor pudo registrar esta acción. Los campos y la clave del intento quedan conservados. Reintentá la misma acción para confirmar el comprobante." : cause instanceof Error ? cause.message : "No se pudo completar la acción.";
      const matchingField = !pendingConfirmation && cause instanceof Error
        ? action.fields.find(field => field.type !== "repeat" && cause.message.startsWith(`${field.label}:`))
          ?? (cause.message.toLowerCase().includes("evidencia") || cause.message.toLowerCase().includes("motivo") ? action.fields.find(field => field.type !== "repeat" && (field.name === "evidence" || /evidencia|motivo/i.test(field.label))) : undefined)
        : undefined;
      if (matchingField) {
        pendingFocus.current = matchingField.name;
        setFieldErrors({ [matchingField.name]: message });
      } else focusSummaryPending.current = true;
      setError(message);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <dialog className="ops-dialog" ref={dialog} aria-labelledby="ops-dialog-title" onCancel={(event) => { event.preventDefault(); closeDialog(); }}>
      <form className="ops-dialog-card" ref={formRef} aria-busy={busy} onSubmit={submit} onInvalidCapture={handleInvalid} onChangeCapture={handleChange}>
        <header className="ops-dialog-head">
          <div>
            <span className="ops-kicker">Completar datos</span>
            <h2 id="ops-dialog-title">{action.title}</h2>
            {action.description && <p>{action.description}</p>}
          </div>
          <button type="button" className="ops-icon-button" aria-label="Cerrar formulario" onClick={closeDialog} disabled={busy || uncertain}>×</button>
        </header>
        <fieldset className="ops-dialog-fields" disabled={busy || uncertain}>
          {action.fields.map(field => (
            field.type === "repeat" ? <fieldset className="ops-repeat-group" key={field.name}><legend>{field.label}</legend><FieldControl field={field} errors={fieldErrors} />{field.help && <small>{field.help}</small>}</fieldset> :
            <label className={`ops-field${field.type === "checkbox" ? " ops-field-check" : ""}`} htmlFor={`ops-field-${field.name}`} key={field.name}>
              {field.type === "checkbox" ? <FieldControl field={field} error={fieldErrors[field.name]} errors={fieldErrors} /> : <span>{field.label}{field.required && <i aria-hidden="true"> ·</i>}</span>}
              {field.type !== "checkbox" && <FieldControl field={field} error={fieldErrors[field.name]} errors={fieldErrors} />}
              {field.help && <small id={`ops-field-${field.name}-help`}>{field.help}</small>}
              {fieldErrors[field.name] && <p id={`ops-field-${field.name}-error`} className="ops-inline-error" role="alert">{fieldErrors[field.name]}</p>}
              {field.type === "checkbox" && <span>{field.label}</span>}
            </label>
          ))}
        </fieldset>
        {busy && <span className="sr-only" role="status">Enviando la acción. No cierres el formulario.</span>}
        {error && <p id="ops-dialog-error" ref={errorSummaryRef} className="ops-inline-error" role="alert" tabIndex={-1}>{error}</p>}
        <footer className="ops-dialog-actions">
          <button type="button" className="ops-button ops-button-quiet" onClick={closeDialog} disabled={busy || uncertain}>Cancelar</button>
          <button type="submit" className="ops-button ops-button-primary" disabled={busy}>
            {busy ? "Guardando…" : uncertain ? "Reintentar confirmación" : action.submitLabel ?? "Registrar"}
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
