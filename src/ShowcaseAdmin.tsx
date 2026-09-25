import { useState } from "react";
import { ArrowUpRight, ImageSquare, Plus, Trash, PencilSimple, Eye, EyeSlash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, send, useResource } from "./lib";
import { Empty, Field, Form, Modal, PageHeader } from "./ui";

type Item = { id: string; slug: string; title: string; category: string; description: string; status: "draft" | "published"; sortOrder: number; imageUrl: string | null; updatedAt: string };
const slugify = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);

export default function ShowcaseAdmin() {
  const resource = useResource<{ items: Item[] }>("/site/admin/showcase");
  const [editing, setEditing] = useState<Item | null>(null);
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [busyId, setBusyId] = useState("");
  function create() { setEditing(null); setSlug(""); setOpen(true); }
  function edit(item: Item) { setEditing(item); setSlug(item.slug); setOpen(true); }
  async function save(form: FormData) {
    const value = {
      title: String(form.get("title") || ""), slug,
      category: String(form.get("category") || ""),
      description: String(form.get("description") || ""),
      sortOrder: Number(form.get("sortOrder")),
    };
    const item = editing
      ? await send<Item>(`/site/admin/showcase/${editing.id}`, value, "PUT")
      : await send<Item>("/site/admin/showcase", value);
    const file = form.get("image");
    if (file instanceof File && file.size) {
      if (file.size > 6 * 1024 * 1024) throw new Error("La imagen debe pesar menos de 6 MB. La ficha quedó guardada como borrador.");
      if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Elegí una imagen JPEG, PNG o WebP. La ficha quedó guardada como borrador.");
      await api(`/site/admin/showcase/${item.id}/image`, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
    }
    toast.success(editing ? "Ficha actualizada" : "Ficha creada como borrador");
    setOpen(false);
    await resource.reload();
  }
  async function status(item: Item) {
    setBusyId(item.id);
    try {
      await send(`/site/admin/showcase/${item.id}/status`, { status: item.status === "draft" ? "published" : "draft" }, "PATCH");
      toast.success(item.status === "draft" ? "Ficha publicada en la vista previa" : "Ficha devuelta a borrador");
      await resource.reload();
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusyId(""); }
  }
  async function remove(item: Item) {
    if (!window.confirm(`¿Eliminar la ficha “${item.title}”?`)) return;
    setBusyId(item.id);
    try { await api(`/site/admin/showcase/${item.id}`, { method: "DELETE" }); toast.success("Ficha eliminada"); await resource.reload(); }
    catch (error) { toast.error((error as Error).message); }
    finally { setBusyId(""); }
  }
  return <>
    <PageHeader eyebrow="PRESENCIA PÚBLICA" title="Vidriera" description="Creá fichas independientes del inventario. Solo las publicadas aparecen en la web, sin precio ni disponibilidad." actions={<button className="button primary" onClick={create}><Plus /> Nueva ficha</button>} />
    <div className="site-admin-note"><strong>Vista previa.</strong> Las fichas se pueden preparar y publicar localmente. La web pública de producción seguirá oculta hasta aprobar imágenes, textos y canales.</div>
    {resource.error && <div className="form-error" role="alert">{resource.error} <button onClick={() => void resource.reload()}>Reintentar</button></div>}
    {resource.loading && !resource.data && <p role="status">Cargando fichas…</p>}
    {resource.data?.items.length === 0 && <Empty title="Tu vidriera comienza aquí" description="Creá una ficha con imagen y descripción. Después podrás publicarla." />}
    <div className="showcase-admin-grid">{resource.data?.items.map(item => <article className="showcase-admin-card" key={item.id}>
      <div className="showcase-admin-image">{item.imageUrl ? <img src={item.imageUrl} alt={item.title} /> : <ImageSquare size={44} />}</div>
      <div className="showcase-admin-content"><div className="showcase-admin-meta"><span>{item.category}</span><span className={`showcase-state ${item.status}`}>{item.status === "published" ? "Publicada" : "Borrador"}</span></div><h2>{item.title}</h2><p>{item.description}</p><small>Orden {item.sortOrder} · /productos/{item.slug}</small><div className="showcase-admin-actions"><button className="button" onClick={() => edit(item)}><PencilSimple /> Editar</button><button className="button" disabled={busyId === item.id || (item.status === "draft" && !item.imageUrl)} onClick={() => void status(item)}>{item.status === "published" ? <EyeSlash /> : <Eye />}{item.status === "published" ? "Despublicar" : "Publicar"}</button>{item.status === "published" && <a className="button" href={`/productos/${item.slug}`} target="_blank" rel="noopener noreferrer" aria-label={`Ver ficha de ${item.title}`}><ArrowUpRight /></a>}<button className="icon-button" aria-label={`Eliminar ${item.title}`} disabled={busyId === item.id} onClick={() => void remove(item)}><Trash /></button></div></div>
    </article>)}</div>
    <Modal title={editing ? `Editar ${editing.title}` : "Nueva ficha"} description="Contenido público curado; no está vinculado a existencias ni precios." open={open} onClose={() => setOpen(false)} wide>
      <Form onSubmit={save} submit={editing ? "Guardar cambios" : "Crear borrador"} onCancel={() => setOpen(false)}>
        <div className="form-grid"><Field label="Nombre"><input name="title" required minLength={2} maxLength={120} defaultValue={editing?.title || ""} onChange={event => { if (!editing) setSlug(slugify(event.target.value)); }} /></Field><Field label="Categoría"><input name="category" required minLength={2} maxLength={80} list="showcase-categories" defaultValue={editing?.category || ""} /><datalist id="showcase-categories"><option value="Flores" /><option value="Aceites" /><option value="Tópicos" /><option value="Comestibles" /></datalist></Field></div>
        <Field label="Dirección de la ficha" hint="Solo letras minúsculas, números y guiones; debe ser única."><input name="slug" required pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={event => setSlug(event.target.value)} /></Field>
        <Field label="Descripción"><textarea name="description" required minLength={20} maxLength={4000} rows={6} defaultValue={editing?.description || ""} placeholder="Información editorial verificable, sin promesas terapéuticas ni disponibilidad." /></Field>
        <div className="form-grid"><Field label="Orden de presentación" hint="Número menor aparece primero."><input name="sortOrder" type="number" min={0} max={10000} required defaultValue={editing?.sortOrder ?? 0} /></Field><Field label={editing?.imageUrl ? "Reemplazar imagen" : "Imagen de la ficha"} hint="JPEG, PNG o WebP; hasta 6 MB. Se optimiza y guarda en PostgreSQL."><input name="image" type="file" accept="image/jpeg,image/png,image/webp" /></Field></div>
      </Form>
    </Modal>
  </>;
}
