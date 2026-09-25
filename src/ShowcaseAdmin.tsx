import { useState } from "react";
import {
  ArrowUpRight,
  CircleNotch,
  Eye,
  EyeSlash,
  ImageSquare,
  PencilSimple,
  Plus,
  Trash,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, send, useResource } from "./lib";
import { Empty, Field, Form, Modal, PageHeader } from "./ui";
import "./site-admin.css";

type Item = {
  id: string;
  slug: string;
  title: string;
  category: string;
  description: string;
  status: "draft" | "published";
  sortOrder: number;
  imageUrl: string | null;
  updatedAt: string;
};
type ItemContent = Pick<Item, "title" | "slug" | "category" | "description" | "sortOrder">;

const slugify = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);

function contentOf(item: Item): ItemContent {
  return {
    title: item.title,
    slug: item.slug,
    category: item.category,
    description: item.description,
    sortOrder: item.sortOrder,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Ocurrió un error inesperado.";
}

async function validateImage(file: File) {
  if (file.size > 6 * 1024 * 1024) {
    throw new Error("La imagen debe pesar menos de 6 MB. No se guardó ningún cambio.");
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Elegí una imagen JPEG, PNG o WebP. No se guardó ningún cambio.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("El archivo no se pudo leer como imagen. No se guardó ningún cambio.");
  }

  const tooLarge = bitmap.width * bitmap.height > 40_000_000;
  bitmap.close();
  if (tooLarge) {
    throw new Error("La imagen supera el tamaño de procesamiento permitido. No se guardó ningún cambio.");
  }
}

export default function ShowcaseAdmin() {
  const resource = useResource<{ items: Item[] }>("/site/admin/showcase");
  const [editing, setEditing] = useState<Item | null>(null);
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [busyId, setBusyId] = useState("");

  function create() {
    setEditing(null);
    setSlug("");
    setOpen(true);
  }

  function edit(item: Item) {
    setEditing(item);
    setSlug(item.slug);
    setOpen(true);
  }

  async function save(form: FormData) {
    const fileValue = form.get("image");
    const file = fileValue instanceof File && fileValue.size > 0 ? fileValue : null;

    // Reject invalid files before the ficha itself is created or updated.
    if (file) await validateImage(file);

    const value: ItemContent = {
      title: String(form.get("title") || ""),
      slug,
      category: String(form.get("category") || ""),
      description: String(form.get("description") || ""),
      sortOrder: Number(form.get("sortOrder")),
    };
    const item = editing
      ? await send<Item>(`/site/admin/showcase/${editing.id}`, value, "PUT")
      : await send<Item>("/site/admin/showcase", value);

    if (file) {
      try {
        await api(`/site/admin/showcase/${item.id}/image`, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });
      } catch (uploadError) {
        if (editing) {
          try {
            await send(`/site/admin/showcase/${editing.id}`, contentOf(editing), "PUT");
          } catch (rollbackError) {
            await resource.reload();
            throw new Error(
              `No se pudo guardar la imagen (${errorMessage(uploadError)}). También falló la reversión del texto (${errorMessage(rollbackError)}); revisá el contenido y el estado público actual de la ficha.`,
            );
          }
          await resource.reload();
          throw new Error(
            `No se pudo guardar la imagen (${errorMessage(uploadError)}). Los cambios de texto se revirtieron.`,
          );
        }

        try {
          await api(`/site/admin/showcase/${item.id}`, { method: "DELETE" });
        } catch (rollbackError) {
          await resource.reload();
          throw new Error(
            `No se pudo guardar la imagen (${errorMessage(uploadError)}). También falló la eliminación de la ficha nueva (${errorMessage(rollbackError)}); revisá el borrador.`,
          );
        }
        await resource.reload();
        throw new Error(
          `No se pudo guardar la imagen (${errorMessage(uploadError)}). La ficha nueva se eliminó.`,
        );
      }
    }

    toast.success(editing ? "Ficha actualizada" : "Ficha creada como borrador");
    setOpen(false);
    await resource.reload();
  }

  async function status(item: Item) {
    setBusyId(item.id);
    try {
      await send(
        `/site/admin/showcase/${item.id}/status`,
        { status: item.status === "draft" ? "published" : "draft" },
        "PATCH",
      );
      toast.success(
        item.status === "draft"
          ? "Ficha publicada en la vista previa"
          : "Ficha devuelta a borrador",
      );
      await resource.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyId("");
    }
  }

  async function remove(item: Item) {
    if (!window.confirm(`¿Eliminar la ficha “${item.title}”? Esta acción no se puede deshacer.`)) {
      return;
    }
    setBusyId(item.id);
    try {
      await api(`/site/admin/showcase/${item.id}`, { method: "DELETE" });
      toast.success("Ficha eliminada");
      await resource.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyId("");
    }
  }

  const items = resource.data?.items || [];

  return (
    <div className="presence-admin presence-showcase-admin">
      <PageHeader
        eyebrow="PRESENCIA PÚBLICA"
        title="Vidriera"
        description="Fichas editoriales independientes del inventario. Sólo las publicadas aparecen en la vista previa; no muestran precio ni disponibilidad."
        className="presence-page-heading"
        actions={
          <button className="button primary" type="button" onClick={create}>
            <Plus aria-hidden="true" />
            Nueva ficha
          </button>
        }
      />

      <aside className="site-admin-note presence-notice">
        <span className="presence-notice-mark" aria-hidden="true">01</span>
        <div>
          <strong>Vista previa privada</strong>
          <p>Publicar hace visible la ficha en esta vista previa local. El sitio público sigue pendiente de aprobación.</p>
        </div>
      </aside>

      <div className="presence-section-heading">
        <div>
          <span className="presence-kicker">CONTENIDO CURADO</span>
          <h2>Fichas del club</h2>
          <p>Revisá el estado, la imagen y el destino antes de publicar.</p>
        </div>
        {resource.data && (
          <span className="presence-count" aria-live="polite">
            {items.length} {items.length === 1 ? "ficha" : "fichas"}
          </span>
        )}
      </div>

      {resource.loading && !resource.data && (
        <div className="presence-feedback presence-loading" role="status">
          <CircleNotch className="presence-spinner" aria-hidden="true" />
          <span>Cargando fichas…</span>
        </div>
      )}

      {resource.error && (
        <div className="presence-feedback presence-error" role="alert">
          <div>
            <strong>No se pudieron cargar las fichas</strong>
            <p>{resource.error}</p>
          </div>
          <button className="button" type="button" onClick={() => void resource.reload()}>
            Reintentar
          </button>
        </div>
      )}

      {resource.data && items.length === 0 && !resource.error && (
        <div className="presence-empty">
          <div className="presence-empty-art" aria-hidden="true">
            <ImageSquare size={34} />
            <span>01</span>
          </div>
          <div>
            <span className="presence-kicker">EL PRIMER PASO</span>
            <h3>Tu vidriera comienza aquí</h3>
            <p>Prepará una ficha con imagen y descripción. Después podrás revisarla y publicarla en la vista previa.</p>
            <button className="button primary" type="button" onClick={create}>
              <Plus aria-hidden="true" />
              Crear primera ficha
            </button>
          </div>
        </div>
      )}

      <div className="showcase-admin-grid presence-card-grid">
        {items.map((item) => {
          const isDraft = item.status === "draft";
          const cannotPublish = isDraft && !item.imageUrl;
          return (
            <article className="showcase-admin-card presence-item-card" key={item.id}>
              <div className="showcase-admin-image presence-item-image">
                {item.imageUrl ? (
                  <img src={item.imageUrl} alt={item.title} loading="lazy" />
                ) : (
                  <div className="presence-image-empty">
                    <ImageSquare size={34} aria-hidden="true" />
                    <span>Sin imagen</span>
                  </div>
                )}
                <span className={`presence-image-index ${isDraft ? "is-draft" : "is-published"}`}>
                  {isDraft ? "EN PREPARACIÓN" : "EN VISTA PREVIA"}
                </span>
              </div>

              <div className="showcase-admin-content presence-item-content">
                <div className="showcase-admin-meta presence-item-meta">
                  <span className="presence-category">{item.category}</span>
                  <span
                    className={`showcase-state presence-state ${isDraft ? "is-draft" : "is-published"}`}
                  >
                    {isDraft ? "Borrador" : "Publicada"}
                  </span>
                </div>
                <h3>{item.title}</h3>
                <p className="presence-item-description">{item.description}</p>
                <div className="presence-item-details">
                  <div>
                    <span>Dirección de vista previa</span>
                    <code>/productos/{item.slug}</code>
                  </div>
                  <small>
                    Orden {item.sortOrder} · Actualizada{" "}
                    {new Date(item.updatedAt).toLocaleDateString("es-AR")}
                  </small>
                </div>
                {cannotPublish && (
                  <p className="presence-inline-hint">
                    Agregá una imagen para habilitar la publicación.
                  </p>
                )}
                <div className="showcase-admin-actions presence-item-actions">
                  <button className="button" type="button" onClick={() => edit(item)}>
                    <PencilSimple aria-hidden="true" />
                    Editar
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={busyId === item.id || cannotPublish}
                    title={cannotPublish ? "Agregá una imagen antes de publicar" : undefined}
                    onClick={() => void status(item)}
                  >
                    {isDraft ? (
                      <Eye aria-hidden="true" />
                    ) : (
                      <EyeSlash aria-hidden="true" />
                    )}
                    {isDraft ? "Publicar" : "Despublicar"}
                  </button>
                  {!isDraft && (
                    <a
                      className="button presence-preview-link"
                      href={`/productos/${item.slug}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`Abrir vista previa de ${item.title} en una pestaña nueva`}
                    >
                      Ver vista previa
                      <ArrowUpRight aria-hidden="true" />
                    </a>
                  )}
                  <button
                    className="icon-button presence-delete-action"
                    type="button"
                    aria-label={`Eliminar ${item.title}`}
                    disabled={busyId === item.id}
                    onClick={() => void remove(item)}
                  >
                    <Trash aria-hidden="true" />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <Modal
        title={editing ? `Editar ${editing.title}` : "Nueva ficha"}
        description="Contenido público curado, sin vínculo con existencias ni precios."
        open={open}
        onClose={() => setOpen(false)}
        wide
      >
        <Form
          onSubmit={save}
          submit={editing ? "Guardar cambios" : "Crear borrador"}
          onCancel={() => setOpen(false)}
        >
          <div className="form-grid">
            <Field label="Nombre">
              <input
                name="title"
                required
                minLength={2}
                maxLength={120}
                defaultValue={editing?.title || ""}
                onChange={(event) => {
                  if (!editing) setSlug(slugify(event.target.value));
                }}
              />
            </Field>
            <Field label="Categoría">
              <input
                name="category"
                required
                minLength={2}
                maxLength={80}
                list="showcase-categories"
                defaultValue={editing?.category || ""}
              />
              <datalist id="showcase-categories">
                <option value="Flores" />
                <option value="Aceites" />
                <option value="Tópicos" />
                <option value="Comestibles" />
              </datalist>
            </Field>
          </div>
          <Field
            label="Dirección de la ficha"
            hint="Sólo letras minúsculas, números y guiones; debe ser única."
          >
            <input
              name="slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
          </Field>
          <Field
            label="Descripción"
            hint="Información editorial verificable, sin promesas terapéuticas ni disponibilidad."
          >
            <textarea
              name="description"
              required
              minLength={20}
              maxLength={4000}
              rows={6}
              defaultValue={editing?.description || ""}
            />
          </Field>
          <div className="form-grid">
            <Field label="Orden de presentación" hint="El número menor aparece primero.">
              <input
                name="sortOrder"
                type="number"
                min={0}
                max={10000}
                required
                defaultValue={editing?.sortOrder ?? 0}
              />
            </Field>
            <Field
              label={editing?.imageUrl ? "Reemplazar imagen" : "Imagen de la ficha"}
              hint="JPEG, PNG o WebP; hasta 6 MB. La imagen se optimiza y se guarda en el club."
            >
              <input name="image" type="file" accept="image/jpeg,image/png,image/webp" />
            </Field>
          </div>
        </Form>
      </Modal>
    </div>
  );
}
