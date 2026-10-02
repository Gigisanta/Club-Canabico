import { useEffect, useRef, useState } from "react";
import { apiGet } from "./api";
import type { ActionField } from "./types";

type Option = { value: string; label: string };
type Page = { items: Array<{ id: string; name?: string }>; nextCursor?: string | null };

/** Paginated, scoped lookup: a long-tail member remains selectable without downloading all members. */
export function RemoteSelect({ field, value, onChange }: { field: ActionField; value?: string; onChange?: (value: string) => void }) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState("");
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<{ query: string; options: Option[]; nextCursor: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const initial = typeof field.defaultValue === "string" ? field.defaultValue : "";
  const [selected, setSelected] = useState<Option | null>(field.options?.find(option => option.value === initial) ?? null);
  const requestNumber = useRef(0);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setCursor(""); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    const request = ++requestNumber.current;
    setLoading(true); setError("");
    const params = new URLSearchParams({ limit: "100", ...(query ? { q: query } : {}), ...(cursor ? { cursor } : {}) });
    apiGet<Page>(`${field.lookupPath}?${params}`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || request !== requestNumber.current) return;
      const options = result.items.filter(item => typeof item.id === "string" && typeof item.name === "string")
        .map(item => ({ value: item.id, label: item.name! }));
      setPage(previous => {
        const combined = cursor && previous?.query === query ? [...previous.options, ...options] : options;
        return { query, options: [...new Map(combined.map(option => [option.value, option])).values()], nextCursor: result.nextCursor ?? null };
      });
    }).catch(reason => {
      if (!controller.signal.aborted && request === requestNumber.current) setError(reason instanceof Error ? reason.message : "No se pudo consultar la lista.");
    }).finally(() => {
      if (!controller.signal.aborted && request === requestNumber.current) setLoading(false);
    });
    return () => controller.abort();
  }, [field.lookupPath, query, cursor, retry]);
  const waiting = loading || search.trim() !== query;
  const options = page?.query === query && search.trim() === query && !error ? page.options : [];
  const selectedValue = value === undefined ? selected?.value ?? "" : value;
  const selectedOption = visibleOption(options, selected, selectedValue);
  const visible = selectedOption && !options.some(option => option.value === selectedOption.value) ? [selectedOption, ...options] : options;
  const id = `ops-field-${field.name}`;
  return <div>
    <input type="search" aria-label={`Buscar ${field.label.toLowerCase()}`} value={search}
      onChange={event => setSearch(event.target.value)} placeholder="Nombre, correo o teléfono" autoComplete="off" />
    <select id={id} name={field.name} aria-label={field.label} required={field.required}
      value={selectedValue} onChange={event => {
        const option = visible.find(candidate => candidate.value === event.target.value) ?? null;
        setSelected(option);
        onChange?.(option?.value ?? "");
      }}>
      <option value="">Elegí una opción</option>
      {visible.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    {waiting && <small role="status">Buscando socios…</small>}
    {error && <div role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Reintentar búsqueda</button></div>}
    {!waiting && !error && page?.nextCursor && <button type="button" className="ops-button ops-button-quiet ops-button-small" onClick={() => setCursor(page.nextCursor!)}>Cargar más opciones</button>}
    {!waiting && !error && !options.length && <small>No hay coincidencias dentro de tu alcance.</small>}
  </div>;
}

function visibleOption(options: Option[], selected: Option | null, value: string): Option | null {
  if (!value) return null;
  return options.find(option => option.value === value) ?? (selected?.value === value ? selected : null);
}
