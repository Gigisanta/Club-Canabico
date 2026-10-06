import { useEffect, useRef, useState } from "react";
import { apiGet } from "./api";
import type { ActionField } from "./types";

type Option = { value: string; label: string };
type Page = { items: Array<{ id: string; name?: string }>; nextCursor?: string | null };
type LoadedPage = { lookupPath: string; query: string; options: Option[]; nextCursor: string | null };
type SelectedOption = { lookupPath: string; option: Option };

function readPage(value: unknown): Page {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La respuesta de la lista no tiene el formato esperado. Reintentá la búsqueda.");
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.items) || result.items.some(item => !item || typeof item !== "object" || Array.isArray(item)
    || typeof (item as Record<string, unknown>).id !== "string" || !(item as Record<string, unknown>).id
    || typeof (item as Record<string, unknown>).name !== "string" || !(item as Record<string, unknown>).name)) {
    throw new Error("La respuesta de la lista no incluye opciones utilizables. Reintentá la búsqueda.");
  }
  const nextCursor = result.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && nextCursor !== "" && (typeof nextCursor !== "string" || nextCursor.trim() !== nextCursor)) {
    throw new Error("La respuesta de la lista no permite continuar la búsqueda. Reintentá.");
  }
  return { items: result.items as Page["items"], nextCursor: typeof nextCursor === "string" && nextCursor ? nextCursor : null };
}

/** Paginated, scoped lookup: a long-tail member remains selectable without downloading all members. */
export function RemoteSelect({ field, value, onChange, validationError }: { field: ActionField; value?: string; onChange?: (value: string) => void; validationError?: string }) {
  const lookupPath = field.lookupPath ?? "";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<LoadedPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lookupFailed, setLookupFailed] = useState(false);
  const initial = typeof field.defaultValue === "string" ? field.defaultValue : "";
  const [selected, setSelected] = useState<SelectedOption | null>(() => {
    const option = field.options?.find(candidate => candidate.value === initial);
    return option ? { lookupPath, option } : null;
  });
  const previousLookupPath = useRef(lookupPath);
  const requestNumber = useRef(0);

  useEffect(() => {
    if (previousLookupPath.current === lookupPath) return;
    previousLookupPath.current = lookupPath;
    setSearch(""); setQuery(""); setCursor(""); setPage(null); setSelected(null); setLookupFailed(false);
    onChange?.("");
  }, [lookupPath, onChange]);

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setCursor(""); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    const request = ++requestNumber.current;
    setLoading(true); setError("");
    const params = new URLSearchParams({ limit: "100", ...(query ? { q: query } : {}), ...(cursor ? { cursor } : {}) });
    apiGet<unknown>(`${lookupPath}?${params}`, { signal: controller.signal }).then(payload => {
      if (controller.signal.aborted || request !== requestNumber.current) return;
      const result = readPage(payload);
      const options = result.items
        .map(item => ({ value: item.id, label: item.name! }));
      setLookupFailed(false);
      setPage(previous => {
        const combined = cursor && previous?.lookupPath === lookupPath && previous.query === query ? [...previous.options, ...options] : options;
        return { lookupPath, query, options: [...new Map(combined.map(option => [option.value, option])).values()], nextCursor: result.nextCursor ?? null };
      });
    }).catch(reason => {
      if (!controller.signal.aborted && request === requestNumber.current) {
        setLookupFailed(true);
        setError(reason instanceof Error ? reason.message : "No se pudo consultar la lista.");
      }
    }).finally(() => {
      if (!controller.signal.aborted && request === requestNumber.current) setLoading(false);
    });
    return () => controller.abort();
  }, [lookupPath, query, cursor, retry]);
  const waiting = loading || search.trim() !== query;
  const currentPage = page?.lookupPath === lookupPath && page.query === query ? page : null;
  const options = currentPage && search.trim() === query && !error ? currentPage.options : [];
  const selectedForPath = selected?.lookupPath === lookupPath ? selected.option : null;
  const selectedValue = value === undefined ? selectedForPath?.value ?? "" : value;
  const selectedOption = visibleOption(options, error || lookupFailed ? null : selectedForPath, selectedValue);
  const visible = selectedOption && !options.some(option => option.value === selectedOption.value) ? [selectedOption, ...options] : options;
  const id = `ops-field-${field.name}`;
  const lookupErrorId = `${id}-lookup-error`;
  const statusId = `${id}-lookup-status`;
  const emptyId = `${id}-lookup-empty`;
  const selectionStatusId = `${id}-selection-status`;
  const validationErrorId = `${id}-error`;
  const hasMissingSelection = Boolean(selectedValue) && !selectedOption && !waiting && !error && Boolean(currentPage);
  const selectionIssue = Boolean(selectedValue) && (error || lookupFailed)
    ? loading && lookupFailed ? "Volviendo a comprobar la selección. Esperá a que termine la búsqueda." : "No se pudo comprobar la selección. Reintentá la búsqueda antes de continuar."
    : hasMissingSelection
      ? "La selección actual ya no está disponible. Buscá y elegí una opción vigente."
      : Boolean(selectedValue) && !selectedOption && waiting
        ? "Comprobando la selección actual. Esperá a que termine la búsqueda."
        : "";
  const lookupDescription = [field.help ? `${id}-help` : "", validationError ? validationErrorId : "", error ? lookupErrorId : "", waiting ? statusId : "", selectionIssue ? selectionStatusId : "", !waiting && !error && !selectionIssue && currentPage && !options.length ? emptyId : ""].filter(Boolean).join(" ") || undefined;
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    selectRef.current?.setCustomValidity(selectionIssue);
    return () => selectRef.current?.setCustomValidity("");
  }, [selectionIssue]);

  return <div>
    <input type="search" id={`${id}-search`} aria-label={`Buscar ${field.label.toLowerCase()} por nombre`} aria-describedby={lookupDescription} value={search}
      onChange={event => setSearch(event.target.value)} placeholder={`Buscar ${field.label.toLowerCase()} por nombre`} autoComplete="off" />
    <select ref={selectRef} id={id} name={field.name} aria-label={field.label} aria-describedby={lookupDescription} aria-invalid={validationError || selectionIssue ? true : undefined} required={field.required}
      value={selectedValue} onChange={event => {
        const option = visible.find(candidate => candidate.value === event.target.value) ?? null;
        setSelected(option ? { lookupPath, option } : null);
        onChange?.(option?.value ?? "");
      }}>
      <option value="">Elegí una opción</option>
      {selectedValue && !selectedOption && <option value={selectedValue} disabled>{error || lookupFailed ? "Selección pendiente de comprobar" : "Comprobando selección…"}</option>}
      {visible.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {waiting && <small id={statusId} role="status">Buscando {field.label.toLowerCase()}…</small>}
    {error && <div id={lookupErrorId} role="alert">{error} <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => setRetry(value => value + 1)}>Reintentar búsqueda</button></div>}
    {selectionIssue && <small id={selectionStatusId} role="status">{selectionIssue}</small>}
    {!waiting && !error && currentPage?.nextCursor && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => setCursor(currentPage.nextCursor!)}>Cargar más opciones</button>}
    {!waiting && !error && !selectionIssue && currentPage && !options.length && <small id={emptyId} role="status">No hay coincidencias dentro de tu alcance.</small>}
  </div>;
}

function visibleOption(options: Option[], selected: Option | null, value: string): Option | null {
  if (!value) return null;
  return options.find(option => option.value === value) ?? (selected?.value === value ? selected : null);
}
