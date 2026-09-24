import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Plus,
  UsersThree,
  Medal,
  Clock,
  PencilSimple,
  Star,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  useClub,
  send,
  useResource,
  daysBetween,
  shortDate,
  number,
  type Customer,
} from "./lib";
import type { Page, Sale } from "../shared/types";
import {
  PageHeader,
  Panel,
  Search,
  Badge,
  Avatar,
  Modal,
  Form,
  Field,
  Empty,
} from "./ui";
export default function Customers() {
  const { state, money, reload, user, owner } = useClub();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") || "");
  const [segment, setSegment] = useState(params.get("segment") || "all");
  const [days, setDays] = useState(
    Number(params.get("days")) || state.settings.inactiveDays,
  );
  const [detail, setDetail] = useState<Customer | null>(null);
  const [edit, setEdit] = useState<Customer | "new" | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyPrevious, setHistoryPrevious] = useState<(string | null)[]>([]);
  useEffect(() => { const id = window.setTimeout(() => setDebouncedQuery(query), 250); return () => clearTimeout(id); }, [query]);
  useEffect(() => {
    setQuery(params.get("q") || "");
    setSegment(params.get("segment") || "all");
    setDays(Number(params.get("days")) || state.settings.inactiveDays);
  }, [params, state.settings.inactiveDays]);
  const updateParams = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all" && !(key === "days" && value === String(state.settings.inactiveDays))) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  useEffect(() => { setCursor(null); setPrevious([]); }, [debouncedQuery, segment, days, owner]);
  useEffect(() => { setHistoryCursor(null); setHistoryPrevious([]); }, [detail?.id]);
  const listData = useResource<Page<Customer, { total: number; gold: number; inactive: number }>>(
    `/list/customers?q=${encodeURIComponent(debouncedQuery)}&segment=${segment}&days=${days}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`,
  );
  const historyData = useResource<Page<Sale>>(
    detail ? `/customers/${encodeURIComponent(detail.id)}/history${historyCursor ? `?cursor=${encodeURIComponent(historyCursor)}` : ""}` : null,
  );
  const inactive = (c: Customer) =>
    daysBetween(state.today, c.lastPurchase || c.createdAt) >= days;
  const risk = (c: Customer) =>
    daysBetween(state.today, c.lastPurchase || c.createdAt) >=
      Math.floor(days / 2) && !inactive(c);
  const list = listData.data?.items || [];
  const editing = edit && edit !== "new" ? edit : null;
  const canEdit = ["owner", "admin", "cashier"].includes(user.role);
  return (
    <>
      <PageHeader
        eyebrow="RELACIONES QUE CRECEN"
        title="Socios y fidelización"
        description="Conocé a tus socios y construí vínculos que duren."
        actions={
          canEdit && (
            <button className="button primary" onClick={() => setEdit("new")}>
              <Plus />
              Nuevo socio
            </button>
          )
        }
      />
      <div className="mini-stats">
        <span>
          <UsersThree />
          <strong>{listData.data?.summary.total ?? "…"}</strong> socios
        </span>
        <span>
          <Medal />
          <strong>
            {listData.data?.summary.gold ?? "…"}
          </strong>{" "}
          nivel Oro
        </span>
        <span>
          <Clock />
          <strong>{listData.data?.summary.inactive ?? "…"}</strong> inactivos
        </span>
      </div>
      <Panel title="Tu comunidad">
        <div className="table-toolbar">
          <Search
            value={query}
            onChange={(value) => { setQuery(value); updateParams("q", value); }}
            placeholder="Buscar por nombre o email…"
          />
          <div className="filter-group">
            <select
              aria-label="Segmento de socios"
              value={segment}
              onChange={(e) => { setSegment(e.target.value); updateParams("segment", e.target.value); }}
            >
              <option value="all">Todos los socios</option>
              <option value="top">Top por volumen</option>
              <option value="inactive">Inactivos</option>
              <option value="risk">En riesgo de abandono</option>
            </select>
            <select
              aria-label="Umbral de inactividad"
              value={days}
              onChange={(e) => { setDays(Number(e.target.value)); updateParams("days", e.target.value); }}
            >
              {[
                30,
                60,
                90,
                ...(![30, 60, 90].includes(days) ? [days] : []),
              ].map((d) => (
                <option key={d} value={d}>
                  {d} días
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Socio</th>
                <th>Nivel / estado</th>
                <th>Permiso</th>
                <th className="numeric">Puntos</th>
                <th className="numeric">Total gastado</th>
                <th className="numeric">Compras</th>
                <th>Última visita</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td>
                    <button
                      className="person-cell cell-button"
                      onClick={() => setDetail(c)}
                    >
                      <Avatar name={c.name} />
                      <div>
                        <strong>{c.name}</strong>
                        <small>{c.email || "Sin email"}</small>
                      </div>
                    </button>
                  </td>
                  <td>
                    <Badge
                      tone={
                        c.tier === "Oro"
                          ? "gold"
                          : c.tier === "Plata"
                            ? "gray"
                            : "bronze"
                      }
                    >
                      {c.tier}
                    </Badge>
                    {inactive(c) ? (
                      <small className="cell-small warning-text">
                        Inactivo
                      </small>
                    ) : risk(c) ? (
                      <small className="cell-small warning-text">
                        En riesgo
                      </small>
                    ) : null}
                  </td>
                  <td>{["owner", "admin", "cashier"].includes(user.role) ? (c.permitStatus === "verified" && c.permitValidUntil && c.permitValidUntil >= state.today ? "Verificado" : c.permitStatus === "pending" ? "Pendiente" : "Sin verificar / vencido") : "Acceso restringido"}</td>
                  <td className="numeric">{number(c.points)}</td>
                  <td className="numeric amount">{money(c.totalSpent)}</td>
                  <td className="numeric">{c.purchases}</td>
                  <td>
                    {c.lastPurchase ? shortDate(c.lastPurchase) : "Sin compras"}
                  </td>
                  <td>
                    <button
                      className="button small-button"
                      onClick={() => setDetail(c)}
                    >
                      Ver ficha
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {listData.loading && <p role="status" className="table-note">Buscando socios…</p>}
          {!listData.loading && !list.length && (
            <Empty
              title="No hay socios en este segmento"
              description="Cambiá los filtros o registrá un nuevo socio."
            />
          )}
        </div>
        {listData.error && <p role="alert">{listData.error}</p>}
        {(previous.length > 0 || listData.data?.nextCursor) && <div className="table-pagination">
          <button className="button" disabled={!previous.length} onClick={() => { setCursor(previous.at(-1) || null); setPrevious((s) => s.slice(0, -1)); }}>Anterior</button>
          <span>Página {previous.length + 1} · {listData.data?.total || 0} resultados</span>
          <button className="button" disabled={!listData.data?.nextCursor} onClick={() => { setPrevious((s) => [...s, cursor]); setCursor(listData.data!.nextCursor); }}>Siguiente</button>
        </div>}
      </Panel>
      <Modal
        title={editing ? "Editar socio" : "Nuevo socio"}
        open={!!edit}
        onClose={() => setEdit(null)}
      >
        <Form
          onCancel={() => setEdit(null)}
          onSubmit={async (fd) => {
            await send(
              editing ? `/customers/${editing.id}` : "/customers",
              Object.fromEntries(fd),
              editing ? "PATCH" : "POST",
            );
            toast.success("Socio guardado");
            setEdit(null);
            setDetail(null);
            await Promise.all([reload(), listData.reload()]);
          }}
        >
          <Field label="Nombre completo">
            <input name="name" defaultValue={editing?.name} required />
          </Field>
          <Field label="Correo electrónico">
            <input name="email" type="email" defaultValue={editing?.email} />
          </Field>
          <Field label="Teléfono">
            <input name="phone" type="tel" defaultValue={editing?.phone} />
          </Field>
          <Field label="Notas internas (sin datos de salud)">
            <textarea
              name="notes"
              defaultValue={editing?.notes}
              placeholder="Información operativa sin datos de salud"
            />
          </Field>
        </Form>
      </Modal>
      <Modal
        title="Ficha del socio"
        open={!!detail}
        onClose={() => setDetail(null)}
        wide
      >
        {detail && (
          <>
            <div className="customer-profile">
              <Avatar name={detail.name} size={64} />
              <div>
                <h2>{detail.name}</h2>
                <p>
                  {detail.email} {detail.phone && `· ${detail.phone}`}
                </p>
                <small>Socio desde {shortDate(detail.createdAt)}</small>
              </div>
              {canEdit && (
                <button
                  className="icon-button"
                  aria-label="Editar socio"
                  onClick={() => setEdit(detail)}
                >
                  <PencilSimple size={22} />
                </button>
              )}
            </div>
            {["owner", "admin", "cashier"].includes(user.role) && <p className="scope-banner">Permiso: <strong>{detail.permitStatus === "verified" && detail.permitValidUntil && detail.permitValidUntil >= state.today ? `verificado hasta ${detail.permitValidUntil}` : detail.permitStatus === "pending" ? "pendiente" : "sin verificación vigente"}</strong></p>}
            {["owner", "admin"].includes(user.role) && <Form submit="Guardar verificación" onSubmit={async (fd) => {
              await send(`/customers/${detail.id}/permit`, { status: fd.get("status"), validUntil: fd.get("validUntil") || null }, "PATCH");
              toast.success("Estado de permiso actualizado");
              setDetail(null);
              await Promise.all([reload(), listData.reload()]);
            }}>
              <div className="form-grid"><Field label="Estado de verificación"><select name="status" defaultValue={detail.permitStatus}><option value="unverified">Sin verificar</option><option value="pending">Pendiente</option><option value="verified">Verificado</option><option value="expired">Vencido</option></select></Field><Field label="Vigente hasta"><input name="validUntil" type="date" defaultValue={detail.permitValidUntil || ""} /></Field></div>
            </Form>}
            <div className="detail-stats">
              <div>
                <small>Nivel actual</small>
                <strong>{detail.tier}</strong>
              </div>
              <div>
                <small>Puntos disponibles</small>
                <strong>{number(detail.points)}</strong>
              </div>
              <div>
                <small>Total gastado</small>
                <strong>{money(detail.totalSpent)}</strong>
              </div>
              <div>
                <small>Frecuencia</small>
                <strong>
                  {detail.purchases
                    ? `${(detail.purchases / Math.max(1, daysBetween(state.today, detail.createdAt) / 30)).toFixed(1)}/mes`
                    : "Sin compras"}
                </strong>
              </div>
            </div>
            {detail.notes && (
              <div className="note-box">
                <strong>Notas internas</strong>
                <p>{detail.notes}</p>
              </div>
            )}
            <h3 className="section-title">Historial de compras</h3>
            <div className="table-scroll history-table">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Productos</th>
                    <th className="numeric">Importe</th>
                    <th className="numeric">Puntos</th>
                  </tr>
                </thead>
                <tbody>
                  {(historyData.data?.items || []).map((s) => (
                      <tr key={s.id}>
                        <td>{shortDate(s.date)}</td>
                        <td>{s.items.map((i) => i.name).join(", ")}</td>
                        <td className="numeric">{money(s.total)}</td>
                        <td className="numeric">
                          +{s.pointsEarned} / −{s.pointsUsed}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {historyData.loading && <p>Cargando historial…</p>}
              {!historyData.loading && !detail.purchases && <Empty title="Todavía no tiene compras" />}
            </div>
            {(historyPrevious.length > 0 || historyData.data?.nextCursor) && <div className="table-pagination">
              <button className="button" disabled={!historyPrevious.length} onClick={() => { setHistoryCursor(historyPrevious.at(-1) || null); setHistoryPrevious((s) => s.slice(0, -1)); }}>Anterior</button>
              <span>Página {historyPrevious.length + 1} · {historyData.data?.total || 0} compras</span>
              <button className="button" disabled={!historyData.data?.nextCursor} onClick={() => { setHistoryPrevious((s) => [...s, historyCursor]); setHistoryCursor(historyData.data!.nextCursor); }}>Siguiente</button>
            </div>}
          </>
        )}
      </Modal>
    </>
  );
}
