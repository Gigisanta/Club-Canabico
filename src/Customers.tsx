import { useState } from "react";
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
  daysBetween,
  shortDate,
  number,
  type Customer,
} from "./lib";
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
  const { state, money, reload, user } = useClub();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") || "");
  const [segment, setSegment] = useState(params.get("segment") || "all");
  const [days, setDays] = useState(
    Number(params.get("days")) || state.settings.inactiveDays,
  );
  const [detail, setDetail] = useState<Customer | null>(null);
  const [edit, setEdit] = useState<Customer | "new" | null>(null);
  const inactive = (c: Customer) =>
    daysBetween(state.today, c.lastPurchase || c.createdAt) >= days;
  const risk = (c: Customer) =>
    daysBetween(state.today, c.lastPurchase || c.createdAt) >=
      Math.floor(days / 2) && !inactive(c);
  const list = state.customers
    .filter(
      (c) =>
        `${c.name} ${c.email}`.toLowerCase().includes(query.toLowerCase()) &&
        (segment === "all" ||
          (segment === "inactive" && inactive(c)) ||
          (segment === "risk" && risk(c)) ||
          (segment === "top" && c.purchases > 0)),
    )
    .sort((a, b) =>
      segment === "top"
        ? b.totalSpent - a.totalSpent
        : a.name.localeCompare(b.name),
    );
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
          <strong>{state.customers.length}</strong> socios
        </span>
        <span>
          <Medal />
          <strong>
            {state.customers.filter((c) => c.tier === "Oro").length}
          </strong>{" "}
          nivel Oro
        </span>
        <span>
          <Clock />
          <strong>{state.customers.filter(inactive).length}</strong> inactivos
        </span>
      </div>
      <Panel title="Tu comunidad">
        <div className="table-toolbar">
          <Search
            value={query}
            onChange={setQuery}
            placeholder="Buscar por nombre o email…"
          />
          <div className="filter-group">
            <select
              aria-label="Segmento de socios"
              value={segment}
              onChange={(e) => setSegment(e.target.value)}
            >
              <option value="all">Todos los socios</option>
              <option value="top">Top por volumen</option>
              <option value="inactive">Inactivos</option>
              <option value="risk">En riesgo de abandono</option>
            </select>
            <select
              aria-label="Umbral de inactividad"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
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
          {!list.length && (
            <Empty
              title="No hay socios en este segmento"
              description="Cambiá los filtros o registrá un nuevo socio."
            />
          )}
        </div>
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
            await reload();
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
          <Field label="Notas internas">
            <textarea
              name="notes"
              defaultValue={editing?.notes}
              placeholder="Preferencias o información útil para el equipo"
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
                  {state.sales
                    .filter((s) => s.customerId === detail.id)
                    .map((s) => (
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
              {!detail.purchases && <Empty title="Todavía no tiene compras" />}
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
