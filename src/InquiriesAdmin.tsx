import { useState } from "react";
import { Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, send, useResource } from "./lib";
import { Empty, PageHeader } from "./ui";

type Inquiry = { id: string; name: string; contact: string; interest: string; message: string; source: string; status: "new" | "contacted" | "closed"; notes: string; consentAt: string; createdAt: string };
const statusLabels = { new: "Nueva", contacted: "Contactada", closed: "Cerrada" };
export default function InquiriesAdmin() {
  const [filter, setFilter] = useState("all");
  const baseUrl = `/site/admin/inquiries${filter === "all" ? "" : `?status=${filter}`}`;
  const resource = useResource<{ items: Inquiry[]; nextCursor: string | null }>(baseUrl);
  const [busy, setBusy] = useState("");
  const [moreItems, setMoreItems] = useState<Inquiry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
  const [moreBusy, setMoreBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, { status: Inquiry["status"]; notes: string }>>({});
  const cursor = nextCursor === undefined ? resource.data?.nextCursor : nextCursor;
  const items = [...(resource.data?.items || []), ...moreItems.filter(item => !resource.data?.items.some(first => first.id === item.id))];
  async function loadMore() {
    if (!cursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const separator = baseUrl.includes("?") ? "&" : "?";
      const page = await api<{ items: Inquiry[]; nextCursor: string | null }>(`${baseUrl}${separator}cursor=${encodeURIComponent(cursor)}`);
      setMoreItems(previous => [...previous, ...page.items.filter(item => !previous.some(existing => existing.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (error) { toast.error((error as Error).message); }
    finally { setMoreBusy(false); }
  }
  async function save(item: Inquiry) {
    setBusy(item.id);
    try {
      const updated = await send<Inquiry>(`/site/admin/inquiries/${item.id}`, drafts[item.id] || { status: item.status, notes: item.notes }, "PATCH");
      setMoreItems(previous => previous.flatMap(existing => existing.id === item.id ? (filter === "all" || updated.status === filter ? [updated] : []) : [existing]));
      toast.success("Consulta actualizada");
      await resource.reload();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(""); }
  }
  async function remove(item: Inquiry) {
    if (!window.confirm(`¿Eliminar la consulta de ${item.name}?`)) return;
    setBusy(item.id);
    try { await api(`/site/admin/inquiries/${item.id}`, { method: "DELETE" }); setMoreItems(previous => previous.filter(existing => existing.id !== item.id)); toast.success("Consulta eliminada"); await resource.reload(); }
    catch (error) { toast.error((error as Error).message); }
    finally { setBusy(""); }
  }
  return <>
    <PageHeader eyebrow="CONTACTO DEL CLUB" title="Consultas" description="Mensajes recibidos desde la web. Esta bandeja es independiente de socios y no crea fichas automáticamente." />
    <div className="site-admin-note">Acceso exclusivo para dueño y gerente. Tratá los datos de contacto solo para responder la consulta.</div>
    <div className="inquiry-filters" aria-label="Filtrar consultas">{[["all", "Todas"], ["new", "Nuevas"], ["contacted", "Contactadas"], ["closed", "Cerradas"]].map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => { setFilter(value); setMoreItems([]); setNextCursor(undefined); setDrafts({}); }}>{label}</button>)}</div>
    {resource.error && <div className="form-error" role="alert">{resource.error} <button onClick={() => void resource.reload()}>Reintentar</button></div>}
    {resource.loading && !resource.data && <p role="status">Cargando consultas…</p>}
    {resource.data?.items.length === 0 && <Empty title="No hay consultas en esta vista" description="Las nuevas consultas aparecerán aquí después de guardarse desde la web." />}
    <div className="inquiry-list">{items.map(item => {
      const draft = drafts[item.id] || { status: item.status, notes: item.notes };
      const changed = draft.status !== item.status || draft.notes !== item.notes;
      return <article className="inquiry-card" key={item.id}><div className="inquiry-card-head"><div><span className={`showcase-state ${item.status}`}>{statusLabels[item.status]}</span><small>{new Date(item.createdAt).toLocaleString("es-AR")}</small></div><strong>{item.interest}</strong></div><div className="inquiry-card-body"><div><h2>{item.name}</h2><a href={item.contact.includes("@") ? `mailto:${item.contact}` : `tel:${item.contact.replace(/[^+\d]/g, "")}`}>{item.contact}</a><small>Origen: {item.source}</small></div><p>{item.message}</p></div><div className="inquiry-card-edit"><label>Estado<select value={draft.status} onChange={event => setDrafts({ ...drafts, [item.id]: { ...draft, status: event.target.value as Inquiry["status"] } })}><option value="new">Nueva</option><option value="contacted">Contactada</option><option value="closed">Cerrada</option></select></label><label>Notas internas<textarea value={draft.notes} maxLength={2000} rows={2} onChange={event => setDrafts({ ...drafts, [item.id]: { ...draft, notes: event.target.value } })} placeholder="Seguimiento del equipo" /></label><button className="button primary" disabled={!changed || busy === item.id} onClick={() => void save(item)}>Guardar</button><button className="icon-button" aria-label={`Eliminar consulta de ${item.name}`} disabled={busy === item.id} onClick={() => void remove(item)}><Trash /></button></div></article>;
    })}</div>
    {cursor && <button className="button" type="button" disabled={moreBusy} onClick={() => void loadMore()}>{moreBusy ? "Cargando…" : "Mostrar más consultas"}</button>}
  </>;
}
