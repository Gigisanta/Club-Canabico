import { useRef, useState } from "react";
import { CircleNotch, Tray, Trash } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api, send, useResource } from "./lib";
import { PageHeader } from "./ui";
import "./site-admin.css";

type Inquiry = {
  id: string;
  name: string;
  contact: string;
  interest: string;
  message: string;
  source: string;
  status: "new" | "contacted" | "closed";
  notes: string;
  consentAt: string;
  createdAt: string;
};
type InquiryDraft = { status: Inquiry["status"]; notes: string };

const statusLabels: Record<Inquiry["status"], string> = {
  new: "Nueva",
  contacted: "Contactada",
  closed: "Cerrada",
};
const filters = [
  ["all", "Todas"],
  ["new", "Nuevas"],
  ["contacted", "Contactadas"],
  ["closed", "Cerradas"],
] as const;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Ocurrió un error inesperado.";
}

export default function InquiriesAdmin() {
  const [filter, setFilter] = useState("all");
  const baseUrl = `/site/admin/inquiries${filter === "all" ? "" : `?status=${filter}`}`;
  const resource = useResource<{ items: Inquiry[]; nextCursor: string | null }>(baseUrl);
  const [busy, setBusy] = useState("");
  const [moreItems, setMoreItems] = useState<Inquiry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>(undefined);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, InquiryDraft>>({});
  const filterGeneration = useRef(0);

  const cursor = nextCursor === undefined ? resource.data?.nextCursor : nextCursor;
  const firstPage = resource.data?.items || [];
  const items = [
    ...firstPage,
    ...moreItems.filter((item) => !firstPage.some((first) => first.id === item.id)),
  ];

  function selectFilter(value: string) {
    if (value === filter) return;
    filterGeneration.current++;
    setFilter(value);
    setMoreItems([]);
    setNextCursor(undefined);
    setMoreBusy(false);
    setMoreError("");
  }

  async function loadMore() {
    if (!cursor || moreBusy) return;
    const generation = filterGeneration.current;
    setMoreBusy(true);
    setMoreError("");
    try {
      const separator = baseUrl.includes("?") ? "&" : "?";
      const page = await api<{ items: Inquiry[]; nextCursor: string | null }>(
        `${baseUrl}${separator}cursor=${encodeURIComponent(cursor)}`,
      );
      if (generation !== filterGeneration.current) return;
      setMoreItems((previous) => [
        ...previous,
        ...page.items.filter((item) => !previous.some((existing) => existing.id === item.id)),
      ]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      if (generation === filterGeneration.current) setMoreError(errorMessage(error));
    } finally {
      if (generation === filterGeneration.current) setMoreBusy(false);
    }
  }

  async function save(item: Inquiry) {
    const draft = drafts[item.id] || { status: item.status, notes: item.notes };
    const generation = filterGeneration.current;
    setBusy(item.id);
    try {
      const updated = await send<Inquiry>(
        `/site/admin/inquiries/${item.id}`,
        draft,
        "PATCH",
      );
      setDrafts((previous) => ({
        ...previous,
        [item.id]: { status: updated.status, notes: updated.notes },
      }));
      if (generation === filterGeneration.current) {
        setMoreItems((previous) =>
          previous.flatMap((existing) =>
            existing.id !== item.id || filter === "all" || updated.status === filter
              ? [existing.id === item.id ? updated : existing]
              : [],
          ),
        );
      }
      toast.success("Consulta actualizada");
      if (generation === filterGeneration.current) await resource.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function remove(item: Inquiry) {
    if (!window.confirm(`¿Eliminar la consulta de ${item.name}? Esta acción no se puede deshacer.`)) {
      return;
    }
    const generation = filterGeneration.current;
    setBusy(item.id);
    try {
      await api(`/site/admin/inquiries/${item.id}`, { method: "DELETE" });
      setMoreItems((previous) => previous.filter((existing) => existing.id !== item.id));
      setDrafts((previous) => {
        const next = { ...previous };
        delete next[item.id];
        return next;
      });
      toast.success("Consulta eliminada");
      if (generation === filterGeneration.current) await resource.reload();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="presence-admin presence-inquiries-admin">
      <PageHeader
        eyebrow="PRESENCIA PÚBLICA · CONTACTO"
        title="Consultas"
        description="Una bandeja privada para responder, registrar el seguimiento y cerrar cada conversación."
        className="presence-page-heading"
      />

      <aside className="site-admin-note presence-notice">
        <span className="presence-notice-mark" aria-hidden="true">02</span>
        <div>
          <strong>Seguimiento del equipo</strong>
          <p>El contacto y el mensaje quedan en esta bandeja. Las notas son internas y no se comparten en la web.</p>
        </div>
      </aside>

      <div className="presence-section-heading presence-inquiries-heading">
        <div>
          <span className="presence-kicker">BANDEJA PRIVADA</span>
          <h2>Conversaciones</h2>
          <p>Filtrá por etapa y guardá cada cambio antes de continuar.</p>
        </div>
        {resource.data && (
          <span className="presence-count" aria-live="polite">
            {items.length} {items.length === 1 ? "consulta cargada" : "consultas cargadas"}
          </span>
        )}
      </div>

      <div className="inquiry-filters presence-filter-list" aria-label="Filtrar consultas">
        {filters.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={filter === value ? "active" : ""}
            aria-pressed={filter === value}
            onClick={() => selectFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {resource.loading && !resource.data && (
        <div className="presence-feedback presence-loading" role="status">
          <CircleNotch className="presence-spinner" aria-hidden="true" />
          <span>Cargando consultas…</span>
        </div>
      )}
      {resource.loading && resource.data && (
        <p className="presence-refreshing" role="status">Actualizando esta vista…</p>
      )}
      {resource.error && (
        <div className="presence-feedback presence-error" role="alert">
          <div>
            <strong>No se pudieron actualizar las consultas</strong>
            <p>{resource.error}</p>
          </div>
          <button className="button" type="button" onClick={() => void resource.reload()}>
            Reintentar
          </button>
        </div>
      )}

      {resource.data && items.length === 0 && !resource.error && (
        <div className="presence-empty presence-inquiry-empty">
          <div className="presence-empty-art" aria-hidden="true">
            <Tray size={34} />
            <span>02</span>
          </div>
          <div>
            <span className="presence-kicker">BANDEJA PRIVADA</span>
            <h3>{filter === "all" ? "Aún no hay consultas" : "Sin resultados en esta etapa"}</h3>
            <p>
              {filter === "all"
                ? "Las consultas aparecerán después de enviarse desde la vista previa. Podés volver a actualizar esta bandeja."
                : "Probá otra etapa para revisar las conversaciones disponibles."}
            </p>
            <button
              className="button"
              type="button"
              onClick={() => (filter === "all" ? void resource.reload() : selectFilter("all"))}
            >
              {filter === "all" ? "Actualizar bandeja" : "Ver todas las consultas"}
            </button>
          </div>
        </div>
      )}

      <div className="inquiry-list presence-inquiry-list">
        {items.map((item) => {
          const draft = drafts[item.id] || { status: item.status, notes: item.notes };
          const changed = draft.status !== item.status || draft.notes !== item.notes;
          const isBusy = busy === item.id;

          return (
            <article className="inquiry-card presence-inquiry-card" key={item.id}>
              <div className="inquiry-card-head presence-inquiry-head">
                <div className="presence-inquiry-state-line">
                  <span
                    className={`showcase-state presence-state is-${item.status}`}
                    aria-label={`Estado: ${statusLabels[item.status]}`}
                  >
                    {statusLabels[item.status]}
                  </span>
                  <time dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleString("es-AR")}
                  </time>
                </div>
                <span className="presence-interest">{item.interest}</span>
              </div>

              <div className="inquiry-card-body presence-inquiry-body">
                <div className="presence-contact-block">
                  <h3>{item.name}</h3>
                  <a
                    href={
                      item.contact.includes("@")
                        ? `mailto:${item.contact}`
                        : `tel:${item.contact.replace(/[^+\d]/g, "")}`
                    }
                  >
                    {item.contact}
                  </a>
                  <small>Origen · {item.source}</small>
                </div>
                <div className="presence-message">
                  <span className="presence-field-caption">MENSAJE RECIBIDO</span>
                  <p>{item.message}</p>
                </div>
              </div>

              <div className="inquiry-card-edit presence-inquiry-edit">
                <label className="presence-field">
                  Estado
                  <select
                    value={draft.status}
                    onChange={(event) =>
                      setDrafts((previous) => ({
                        ...previous,
                        [item.id]: {
                          ...draft,
                          status: event.target.value as Inquiry["status"],
                        },
                      }))
                    }
                  >
                    <option value="new">Nueva</option>
                    <option value="contacted">Contactada</option>
                    <option value="closed">Cerrada</option>
                  </select>
                </label>
                <label className="presence-field">
                  Notas internas
                  <textarea
                    value={draft.notes}
                    maxLength={2000}
                    rows={2}
                    onChange={(event) =>
                      setDrafts((previous) => ({
                        ...previous,
                        [item.id]: { ...draft, notes: event.target.value },
                      }))
                    }
                    placeholder="Próximo paso o contexto para el equipo"
                  />
                  <small>{draft.notes.length}/2000 · Sólo visible para el equipo</small>
                </label>
                <div className="presence-inquiry-actions">
                  {changed && (
                    <span className="presence-unsaved" role="status">
                      Cambios sin guardar
                    </span>
                  )}
                  <button
                    className="button primary"
                    type="button"
                    disabled={!changed || isBusy}
                    onClick={() => void save(item)}
                  >
                    {isBusy ? "Guardando…" : "Guardar cambios"}
                  </button>
                  <button
                    className="icon-button presence-delete-action"
                    type="button"
                    aria-label={`Eliminar consulta de ${item.name}`}
                    disabled={isBusy}
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

      {moreError && (
        <div className="presence-feedback presence-error presence-more-error" role="alert">
          <div>
            <strong>No se pudo cargar la página siguiente</strong>
            <p>{moreError}</p>
          </div>
          <button className="button" type="button" onClick={() => void loadMore()}>
            Reintentar
          </button>
        </div>
      )}
      {cursor && (
        <button
          className="button presence-load-more"
          type="button"
          disabled={moreBusy}
          onClick={() => void loadMore()}
        >
          {moreBusy ? (
            <>
              <CircleNotch className="presence-spinner" aria-hidden="true" />
              Cargando…
            </>
          ) : (
            "Mostrar más consultas"
          )}
        </button>
      )}
    </div>
  );
}
