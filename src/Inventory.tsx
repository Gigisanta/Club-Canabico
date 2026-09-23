import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Plus,
  SquaresFour,
  ListBullets,
  Package,
  ArrowsLeftRight,
  ClockCounterClockwise,
  PencilSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  useClub,
  send,
  useResource,
  number,
  shortDate,
  type Product,
} from "./lib";
import type { Movement } from "../shared/types";
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
import { StockCard } from "./StockCard";
export default function Inventory() {
  const { state, money, canManage, isManager, reload, user, owner } = useClub();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") || "");
  const [filter, setFilter] = useState(params.get("filter") === "low" ? "low" : "all");
  const [view, setView] = useState<"cards" | "table">("cards");
  const [type, setType] = useState("all");
  const [editor, setEditor] = useState<Product | "new" | null>(null);
  const [movement, setMovement] = useState<Product | null>(null);
  const [history, setHistory] = useState(false);
  const [moveType, setMoveType] = useState("entry");
  const [historyPage, setHistoryPage] = useState(1);
  const historyData = useResource<{ rows: Movement[]; total: number }>(
    history
      ? `/movements?page=${historyPage}${owner ? "&owner=" + encodeURIComponent(owner) : ""}`
      : null,
  );
  const products = state.products.filter(
    (p) =>
      `${p.name} ${p.strain} ${p.lot} ${state.users.find((u) => u.id === p.ownerId)?.name}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (type === "all" || p.type === type) &&
      (filter === "all" ||
        (filter === "low" && p.stock <= p.minimum) ||
        (filter === "expired" && p.expires && p.expires <= state.today)),
  );
  async function save(fd: FormData) {
    const existing = editor !== "new" ? editor : null;
    const data = {
      ...Object.fromEntries(fd),
      stock: Math.round(Number(fd.get("stock")) * 1000),
      minimum: Math.round(Number(fd.get("minimum")) * 1000),
      cost: Math.round(Number(fd.get("cost")) * 100),
      price: Math.round(Number(fd.get("price")) * 100),
      expires: fd.get("expires") || null,
    };
    await send(
      existing ? `/products/${existing.id}` : "/products",
      data,
      existing ? "PATCH" : "POST",
    );
    toast.success(existing ? "Producto actualizado" : "Lote creado");
    setEditor(null);
    await reload();
  }
  const edit = editor && editor !== "new" ? editor : null;
  return (
    <>
      <PageHeader
        eyebrow="CADA LOTE, EN SU LUGAR"
        title="Inventario"
        description="Cada lote, su stock y su responsable. Importes en pesos argentinos (ARS)."
        actions={
          <>
            <button className="button" onClick={() => setHistory(true)}>
              <ClockCounterClockwise size={18} />
              Movimientos
            </button>
            {canManage && (
              <button
                className="button primary"
                onClick={() => setEditor("new")}
              >
                <Plus size={18} />
                Nuevo lote
              </button>
            )}
          </>
        }
      />
      <div className="mini-stats inventory-summary">
        <span>
          <Package /> <strong>{state.products.length}</strong> lotes registrados
        </span>
        <span>
          <WarningCircle />{" "}
          <strong>
            {state.products.filter((p) => p.stock <= p.minimum).length}
          </strong>{" "}
          con stock bajo
        </span>
        {user.role !== "cashier" && (
          <span>
            Valor de inventario{" "}
            <strong>
              {money(
                state.products.reduce(
                  (n, p) => n + (p.stock * p.cost) / 1000,
                  0,
                ),
              )}
            </strong>
          </span>
        )}
      </div>
      <Panel
        title="Todos los productos"
        action={
          <div className="inventory-view">
            <span className="muted small">{products.length} lotes</span>
            <div
              className="segmented"
              role="group"
              aria-label="Vista del inventario"
            >
              <button
                className={view === "cards" ? "active" : ""}
                aria-label="Vista de tarjetas"
                aria-pressed={view === "cards"}
                onClick={() => setView("cards")}
              >
                <SquaresFour size={17} />
              </button>
              <button
                className={view === "table" ? "active" : ""}
                aria-label="Vista de tabla"
                aria-pressed={view === "table"}
                onClick={() => setView("table")}
              >
                <ListBullets size={17} />
              </button>
            </div>
          </div>
        }
      >
        <div className="table-toolbar">
          <Search
            value={query}
            onChange={setQuery}
            placeholder="Buscar producto, lote o responsable…"
          />
          <div className="filter-group">
            <select
              aria-label="Tipo de producto"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="all">Todos los tipos</option>
              {["Flor", "Extracto", "Aceite", "Accesorio"].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <select
              aria-label="Estado del stock"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">Todo el stock</option>
              <option value="low">Stock bajo</option>
              <option value="expired">Vencidos</option>
            </select>
          </div>
        </div>
        {view === "cards" ? (
          <>
            <div className="stock-grid">
              {products.map((p) => (
                <StockCard
                  key={p.id}
                  product={p}
                  onEdit={() => setEditor(p)}
                  onMove={() => {
                    setMoveType("entry");
                    setMovement(p);
                  }}
                />
              ))}
            </div>
            {!products.length && (
              <Empty
                title="No encontramos productos"
                description="Probá con otra búsqueda o creá el primer lote."
              />
            )}
          </>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Producto / lote</th>
                  <th>Responsable</th>
                  <th className="numeric">Stock</th>
                  <th>Estado</th>
                  <th className="numeric">Precio</th>
                  <th>Ubicación</th>
                  <th aria-label="Acciones" />
                </tr>
              </thead>
              <tbody>
                {products.map((p) => {
                  const owner = state.users.find((u) => u.id === p.ownerId);
                  return (
                    <tr key={p.id}>
                      <td>
                        <div className="product-cell">
                          <span
                            className={`product-symbol ${p.type === "Extracto" ? "gold" : ""}`}
                          >
                            <Package size={22} weight="duotone" />
                          </span>
                          <div>
                            <strong>{p.name}</strong>
                            <small>
                              {p.lot} · {p.strain} · {p.type}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div className="person-cell">
                          <Avatar
                            name={owner?.name || "?"}
                            color={owner?.color}
                            size={28}
                          />
                          <span>{owner?.name || p.ownerId}</span>
                        </div>
                      </td>
                      <td className="numeric">
                        <strong>{number(p.stock / 1000)}</strong>{" "}
                        <span className="muted">{p.unit}</span>
                        <div className="stock-meter">
                          <i
                            className={p.stock <= p.minimum ? "low" : ""}
                            style={{
                              width: `${Math.min(100, (p.stock / Math.max(p.minimum * 4, 1)) * 100)}%`,
                            }}
                          />
                        </div>
                      </td>
                      <td>
                        <Badge
                          tone={
                            p.expires && p.expires <= state.today
                              ? "red"
                              : p.stock <= p.minimum
                                ? "amber"
                                : "green"
                          }
                        >
                          {p.expires && p.expires <= state.today
                            ? "Vencido"
                            : p.stock <= p.minimum
                              ? "Stock bajo"
                              : "Disponible"}
                        </Badge>
                      </td>
                      <td className="numeric amount">
                        {money(p.price)}
                        <small className="cell-small">/ {p.unit}</small>
                      </td>
                      <td>
                        {p.location}
                        {p.expires && (
                          <small className="cell-small">
                            Vence {shortDate(p.expires)}
                          </small>
                        )}
                      </td>
                      <td>
                        {canManage && (
                          <div className="row-actions">
                            <button
                              className="icon-button"
                              title="Editar producto"
                              aria-label={`Editar ${p.name}`}
                              onClick={() => setEditor(p)}
                            >
                              <PencilSimple size={17} />
                            </button>
                            <button
                              className="icon-button"
                              title="Registrar movimiento"
                              aria-label={`Mover ${p.name}`}
                              onClick={() => {
                                setMoveType("entry");
                                setMovement(p);
                              }}
                            >
                              <ArrowsLeftRight size={18} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!products.length && (
              <Empty
                title="No encontramos productos"
                description="Probá con otra búsqueda o creá el primer lote."
              />
            )}
          </div>
        )}
      </Panel>
      <Modal
        title={edit ? "Editar producto" : "Nuevo lote"}
        description="Precios en pesos argentinos (ARS), por unidad o gramo."
        open={!!editor}
        onClose={() => setEditor(null)}
        wide
      >
        <Form onSubmit={save} onCancel={() => setEditor(null)}>
          <div className="form-grid">
            <Field label="Nombre del producto">
              <input name="name" defaultValue={edit?.name} required />
            </Field>
            <Field label="Cepa / strain">
              <input name="strain" defaultValue={edit?.strain} required />
            </Field>
            <Field label="Tipo">
              <select name="type" defaultValue={edit?.type || "Flor"}>
                {["Flor", "Extracto", "Aceite", "Accesorio"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Unidad">
              <select name="unit" defaultValue={edit?.unit || "g"}>
                <option value="g">Gramos</option>
                <option value="ud">Unidades</option>
              </select>
            </Field>
            <Field label="Código de lote">
              <input
                name="lot"
                defaultValue={edit?.lot}
                placeholder="RC-26-013"
                required
              />
            </Field>
            <Field label="Proveedor">
              <input name="supplier" defaultValue={edit?.supplier || ""} placeholder="Proveedor del lote" />
            </Field>
            <Field label="Ubicación">
              <input
                name="location"
                defaultValue={edit?.location}
                placeholder="Almacén A"
                required
              />
            </Field>
            {!edit && (
              <>
                <Field label="Responsable de reprogram">
                  <select
                    name="ownerId"
                    defaultValue={
                      user.role === "responsible" ? user.id : undefined
                    }
                  >
                    {state.users
                      .filter((u) =>
                        ["responsible", "owner", "admin"].includes(u.role),
                      )
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                  </select>
                </Field>
                <Field label="Stock inicial">
                  <input
                    name="stock"
                    type="number"
                    min="0"
                    max="100000"
                    step="0.001"
                    defaultValue="0"
                    required
                  />
                </Field>
              </>
            )}
            <Field label="Stock mínimo">
              <input
                name="minimum"
                type="number"
                min="0"
                step="0.001"
                defaultValue={edit ? edit.minimum / 1000 : 10}
                required
              />
            </Field>
            <Field label="Fecha de vencimiento (opcional)">
              <input
                name="expires"
                type="date"
                defaultValue={edit?.expires || ""}
              />
            </Field>
            <Field label="Precio de costo">
              <input
                name="cost"
                type="number"
                min="0"
                step="0.01"
                defaultValue={edit ? edit.cost / 100 : 0}
                required
              />
            </Field>
            <Field label="Precio de venta">
              <input
                name="price"
                type="number"
                min="0.01"
                step="0.01"
                defaultValue={edit ? edit.price / 100 : 0}
                required
              />
            </Field>
          </div>
        </Form>
      </Modal>
      <Modal
        title={`Movimiento · ${movement?.name || ""}`}
        description="Cada cambio queda registrado con su fecha y usuario."
        open={!!movement}
        onClose={() => setMovement(null)}
      >
        <Form
          onCancel={() => setMovement(null)}
          onSubmit={async (fd) => {
            await send(`/products/${movement!.id}/movements`, {
              type: moveType,
              quantity: Math.round(Number(fd.get("quantity") || 0) * 1000),
              ownerId: fd.get("ownerId") || undefined,
              note: fd.get("note"),
            });
            toast.success("Movimiento registrado");
            setMovement(null);
            await reload();
          }}
        >
          <Field label="Tipo de movimiento">
            <select
              value={moveType}
              onChange={(e) => setMoveType(e.target.value)}
            >
              <option value="entry">Entrada de stock</option>
              <option value="exit">Salida de stock</option>
              <option value="adjustment">Ajuste por conteo</option>
              {isManager && (
                <option value="transfer">Traspasar lote completo</option>
              )}
            </select>
          </Field>
          {moveType === "transfer" ? (
            <Field label="Nuevo responsable">
              <select name="ownerId">
                {state.users
                  .filter(
                    (u) =>
                      ["owner", "admin", "responsible"].includes(u.role) &&
                      u.id !== movement?.ownerId,
                  )
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </Field>
          ) : (
            <Field
              label={
                moveType === "adjustment" ? "Stock total contado" : "Cantidad"
              }
              hint={`Stock actual: ${(movement?.stock || 0) / 1000} ${movement?.unit}`}
            >
              <input
                name="quantity"
                type="number"
                min={moveType === "adjustment" ? 0 : 0.001}
                step={movement?.unit === "ud" ? "1" : "0.001"}
                required
              />
            </Field>
          )}
          <Field label="Motivo">
            <textarea
              name="note"
              minLength={3}
              required
              placeholder="Describí el motivo del movimiento"
            />
          </Field>
        </Form>
      </Modal>
      <Modal
        title="Historial de movimientos"
        description="Historial completo de tu ámbito, paginado y ordenado por fecha."
        open={history}
        onClose={() => setHistory(false)}
        wide
      >
        <div className="table-scroll history-table">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Producto</th>
                <th>Tipo</th>
                <th className="numeric">Cambio</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              {(historyData.data?.rows || []).map((m) => (
                <tr key={m.id}>
                  <td>{shortDate(m.createdAt)}</td>
                  <td>
                    {state.products.find((p) => p.id === m.productId)?.name ||
                      "Lote traspasado"}
                  </td>
                  <td>
                    {
                      (
                        {
                          entry: "Entrada",
                          exit: "Salida",
                          adjustment: "Ajuste",
                          transfer: "Traspaso",
                          sale: "Venta",
                        } as Record<string, string>
                      )[m.type]
                    }
                  </td>
                  <td className="numeric">
                    {m.type === "transfer"
                      ? "Lote completo"
                      : `${m.quantity > 0 ? "+" : ""}${number(m.quantity / 1000)}`}
                  </td>
                  <td>
                    <span className="truncate">{m.note}</span>
                    {m.type === "transfer" && (
                      <small className="cell-small">
                        {state.users.find((u) => u.id === m.fromOwner)?.name ||
                          m.fromOwner}{" "}
                        →{" "}
                        {state.users.find((u) => u.id === m.toOwner)?.name ||
                          m.toOwner}
                      </small>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {historyData.error && <p className="form-error">{historyData.error}</p>}
        <div className="pagination">
          <span>
            {historyData.loading
              ? "Cargando…"
              : `${historyData.data?.total || 0} movimientos · Página ${historyPage}`}
          </span>
          <div>
            <button
              className="button small-button"
              disabled={historyPage === 1 || historyData.loading}
              onClick={() => setHistoryPage((p) => p - 1)}
            >
              Anterior
            </button>
            <button
              className="button small-button"
              disabled={
                historyData.loading ||
                historyPage * 100 >= (historyData.data?.total || 0)
              }
              onClick={() => setHistoryPage((p) => p + 1)}
            >
              Siguiente
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
