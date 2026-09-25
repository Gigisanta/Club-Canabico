import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Plus,
  Receipt,
  LockKey,
  Trash,
  Printer,
  ShoppingBag,
  CheckCircle,
  MagnifyingGlass,
  X,
  Minus,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { useClub, send, useResource, number, shortDate, type Sale } from "./lib";
import type { Customer, Product, Page } from "../shared/types";
import type { CustomerInsights } from "../shared/customer-insights";
import { CustomerInsightsPanel } from "./CustomerInsights";
import {
  PageHeader,
  Panel,
  Search,
  Badge,
  Modal,
  Form,
  Field,
  Empty,
} from "./ui";
import { priceSale } from "../shared/domain";
import "./sales.css";
import "./operation.css";
const payments: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
};
type CheckoutCustomer = Pick<Customer, "id" | "name" | "points" | "tier">;
type CheckoutProduct = Pick<Product, "id" | "name" | "lot" | "price" | "stock" | "unit" | "ownerId" | "expires">;
function CustomerPicker({
  query, onQueryChange, selected, items, loading, error, onSelect,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  selected: CheckoutCustomer | null;
  items: CheckoutCustomer[];
  loading: boolean;
  error?: string | null;
  onSelect: (customer: CheckoutCustomer | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const choose = (customer: CheckoutCustomer) => {
    onSelect(customer);
    setExpanded(false);
  };
  return (
    <div className="customer-picker">
      <div className={`customer-picker-input${selected ? " is-selected" : ""}`}>
        {selected ? <CheckCircle size={18} weight="fill" /> : <MagnifyingGlass size={18} />}
        <input
          id="sale-customer-search"
          type="search"
          role="combobox"
          aria-label="Buscar socio"
          aria-autocomplete="list"
          aria-controls="sale-customer-options"
          aria-expanded={expanded}
          aria-activedescendant={expanded && items.length ? `sale-customer-${Math.min(active, items.length - 1)}` : undefined}
          placeholder="Nombre, email o teléfono…"
          autoComplete="off"
          value={query}
          onFocus={() => { setExpanded(true); setActive(0); }}
          onBlur={() => setExpanded(false)}
          onChange={(event) => { onQueryChange(event.target.value); setActive(0); setExpanded(true); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setExpanded(true);
              setActive((current) => Math.max(0, Math.min(items.length - 1, current + (event.key === "ArrowDown" ? 1 : -1))));
            } else if (event.key === "Enter" && expanded && items.length) {
              event.preventDefault();
              choose(items[Math.min(active, items.length - 1)]);
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setExpanded(false);
            }
          }}
        />
        {selected && <button type="button" className="customer-picker-clear" aria-label="Cambiar socio" onMouseDown={(event) => event.preventDefault()} onClick={() => { onSelect(null); setExpanded(true); document.getElementById("sale-customer-search")?.focus(); }}><X size={16} /></button>}
      </div>
      {expanded && (
        <div id="sale-customer-options" className="customer-picker-results" role="listbox" aria-label="Socios encontrados">
          {loading && <p role="status">Buscando socios…</p>}
          {error && <p role="alert">{error}</p>}
          {!loading && !error && !items.length && <p>No encontramos socios. Probá con otro dato.</p>}
          {!loading && !error && items.map((customer, index) => (
            <button
              type="button"
              role="option"
              id={`sale-customer-${index}`}
              aria-selected={selected?.id === customer.id}
              className={index === active ? "is-active" : ""}
              key={customer.id}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(customer)}
            >
              <span className="customer-picker-avatar">{customer.name.trim().charAt(0).toUpperCase()}</span>
              <span><strong>{customer.name}</strong><small>{customer.tier} · {customer.points} puntos</small></span>
              {selected?.id === customer.id && <CheckCircle size={18} />}
            </button>
          ))}
        </div>
      )}
      {selected && <small className="customer-picker-confirmation">Socio seleccionado · {selected.tier} · {selected.points} puntos disponibles</small>}
    </div>
  );
}
export default function Sales({ onSale }: { onSale: () => void }) {
  const { state, money, canSell, user, reload, owner } = useClub();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") || "");
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [date, setDate] = useState(params.get("date") || "");
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  useEffect(() => { const id = window.setTimeout(() => setDebouncedQuery(query), 250); return () => clearTimeout(id); }, [query]);
  useEffect(() => { setQuery(params.get("q") || ""); setDate(params.get("date") || ""); }, [params]);
  const updateParams = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); setParams(next, { replace: true }); };
  useEffect(() => { setCursor(null); setPrevious([]); }, [debouncedQuery, date, owner]);
  const page = useResource<Page<Sale, { pageCount: number }>>(
    `/list/sales?q=${encodeURIComponent(debouncedQuery)}${date ? `&date=${date}` : ""}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`,
  );
  useEffect(() => { const refresh = () => void page.reload(); window.addEventListener("bombo:sale-changed", refresh); return () => window.removeEventListener("bombo:sale-changed", refresh); }, [page.reload]);
  const [ticket, setTicket] = useState<Sale | null>(null);
  const [close, setClose] = useState(false);
  const cash = state.cashExpected;
  const closed = state.closures.find((c) => c.date === state.today);
  const canClose = ["owner", "admin", "cashier"].includes(user.role);
  const sales = page.data?.items || [];
  return (
    <div className="operation-page sales-page">
      <PageHeader
        className="sales-heading"
        eyebrow="UNA CAJA CLARA, CADA DÍA"
        title="Ventas y caja"
        description="Registrá operaciones y consultá cada comprobante."
        actions={
          <>
            {canClose && (
              <button
                className="button"
                disabled={!!closed}
                onClick={() => setClose(true)}
              >
                <LockKey />
                {closed ? "Caja cerrada" : "Cerrar caja"}
              </button>
            )}
            {canSell && (
              <button
                className="button primary"
                onClick={onSale}
                disabled={!!closed}
              >
                <Plus />
                Nueva venta
              </button>
            )}
          </>
        }
      />
      <div className="sales-summary">
        <div>
          <span>Ventas de hoy</span>
          <strong>{money(state.salesTodayTotal)}</strong>
          <small>{state.salesTodayCount} operaciones</small>
        </div>
        <div>
          <span>Efectivo esperado</span>
          <strong>{money(cash)}</strong>
          <small>Saldo anterior más movimientos de efectivo registrados</small>
        </div>
        <div>
          <span>Estado de caja</span>
          <strong className="status-label">
            <span className="live-dot" />
            {closed ? "Cerrada" : "Abierta"}
          </strong>
          <small>
            {shortDate(state.today)}{" "}
            {closed && `· Diferencia ${money(closed.difference)}`}
          </small>
        </div>
      </div>
      <Panel
        className="sales-history-panel"
        title="Historial de ventas"
        action={<span className="muted small">{page.data?.total ?? "…"} operaciones</span>}
      >
        <div className="table-toolbar">
          <Search
            value={query}
            onChange={(value) => { setQuery(value); updateParams("q", value); }}
            placeholder="Buscar socio, producto o ticket…"
          />
          <input
            aria-label="Filtrar ventas por fecha"
            type="date"
            value={date}
            onChange={(e) => { setDate(e.target.value); updateParams("date", e.target.value); }}
          />
          {date && (
            <button className="button" onClick={() => { setDate(""); updateParams("date", ""); }}>
              Todas las fechas
            </button>
          )}
        </div>
        <div className="table-scroll sales-history-table">
          <table>
            <thead>
              <tr>
                <th>Comprobante</th>
                <th>Socio</th>
                <th>Productos</th>
                <th>Pago</th>
                <th className="numeric">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sales.map((s) => (
                <tr key={s.id}>
                  <td data-label="Comprobante">
                    <strong className="ticket-id">
                      {s.id.startsWith("V-")
                        ? s.id
                        : s.id.slice(-8).toUpperCase()}
                    </strong>
                    <small className="cell-small">{shortDate(s.date)}</small>
                  </td>
                  <td data-label="Socio">
                    {s.customerName || "Socio"}
                  </td>
                  <td data-label="Productos">
                    <span className="truncate">
                      {s.items
                        .map((i) => `${i.name} (${number(i.quantity / 1000)})`)
                        .join(", ")}
                    </span>
                  </td>
                  <td data-label="Pago">
                    <Badge tone="gray">{payments[s.payment]}</Badge>
                  </td>
                  <td className="numeric amount" data-label="Total">{money(s.total)}</td>
                  <td data-label="Comprobante">
                    <button
                      className="icon-button"
                      aria-label={`Ver ticket ${s.id}`}
                      onClick={() => setTicket(s)}
                    >
                      <Receipt size={20} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.loading && <p role="status" className="table-note">Buscando comprobantes…</p>}
          {!page.loading && !page.error && !sales.length && (
            <div className="sales-empty-state">
              <Empty
                title={query || date ? "No hay ventas con estos filtros" : "Todavía no hay ventas"}
                description={query || date ? "Probá otra búsqueda o quitá los filtros para ver el historial completo." : "Las ventas registradas van a aparecer en este historial."}
              />
              {query || date ? (
                <button className="button" onClick={() => {
                  setQuery("");
                  setDate("");
                  const next = new URLSearchParams(params);
                  next.delete("q");
                  next.delete("date");
                  setParams(next, { replace: true });
                }}>Quitar filtros</button>
              ) : canSell && !closed ? (
                <button className="button primary" onClick={onSale}><Plus size={17} /> Registrar primera venta</button>
              ) : null}
            </div>
          )}
        </div>
        {page.error && <div className="operation-error" role="alert"><p>{page.error}</p><button className="button small-button" onClick={() => void page.reload()}>Reintentar</button></div>}
        {(previous.length > 0 || page.data?.nextCursor) && <div className="table-pagination">
          <button className="button" disabled={!previous.length} onClick={() => { setCursor(previous.at(-1) || null); setPrevious((s) => s.slice(0, -1)); }}>Anterior</button>
          <span>Página {previous.length + 1} · {page.data?.total || 0} operaciones</span>
          <button className="button" disabled={!page.data?.nextCursor} onClick={() => { setPrevious((s) => [...s, cursor]); setCursor(page.data!.nextCursor); }}>Siguiente</button>
        </div>}
      </Panel>
      {canClose && state.closures.length > 0 && (
        <Panel className="spaced-panel" title="Cierres anteriores">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Esperado</th>
                  <th>Contado</th>
                  <th>Diferencia</th>
                  <th>Nota</th>
                </tr>
              </thead>
              <tbody>
                {state.closures.map((c) => (
                  <tr key={c.id}>
                    <td>{shortDate(c.date)}</td>
                    <td>{money(c.expected)}</td>
                    <td>{money(c.counted)}</td>
                    <td>{money(c.difference)}</td>
                    <td>{c.note || "Sin observaciones"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
      <Modal
        title="Cierre de caja diario"
        description="El cierre bloquea nuevas ventas para el día actual en todo el club."
        open={close}
        onClose={() => setClose(false)}
      >
        <div className="operation-dialog-content sales-close-content">
        <div className="note-box">
          Efectivo esperado: <strong>{money(cash)}</strong>
          <p>
            Contá todo el efectivo en caja. Incluye saldo inicial, cobros y
            pagos en efectivo registrados.
          </p>
        </div>
        <Form
          submit="Confirmar cierre"
          onCancel={() => setClose(false)}
          onSubmit={async (fd) => {
            await send("/closures", {
              counted: Math.round(Number(fd.get("counted")) * 100),
              note: fd.get("note"),
            });
            toast.success("Caja cerrada correctamente");
            setClose(false);
            await reload();
          }}
        >
          <Field label="Efectivo contado">
            <input name="counted" type="number" min="0" step="0.01" required />
          </Field>
          <Field label="Observaciones">
            <textarea name="note" />
          </Field>
        </Form>
        </div>
      </Modal>
      <Ticket sale={ticket} onClose={() => setTicket(null)} />
    </div>
  );
}
export function SaleModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { state, money, reload, user, owner } = useClub();
  const [customerId, setCustomerId] = useState("");
  const [customerSearch, setCustomerSearch] = useState("");
  const [searched, setSearched] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState<CheckoutCustomer | null>(null);
  useEffect(() => { const id = window.setTimeout(() => setSearched(customerSearch), 250); return () => clearTimeout(id); }, [customerSearch]);
  const customerData = useResource<{ items: CheckoutCustomer[] }>(open ? `/checkout/customers?q=${encodeURIComponent(searched)}` : null);
  const insights = useResource<CustomerInsights>(open && customerId ? `/customers/${encodeURIComponent(customerId)}/insights` : null);
  const productData = useResource<{ items: CheckoutProduct[] }>(open ? `/checkout/products${owner ? `?owner=${encodeURIComponent(owner)}` : ""}` : null);
  const products = productData.data?.items || [];
  const customerOptions = customerData.data?.items || [];
  const [lines, setLines] = useState([{ productId: "", quantity: 1 }]);
  const [points, setPoints] = useState(0);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [ticket, setTicket] = useState<Sale | null>(null);
  useEffect(() => {
    if (open) {
      setCustomerId("");
      setCustomerSearch("");
      setSelectedCustomer(null);
      setLines([{ productId: "", quantity: 1 }]);
      setPoints(0);
      setRequestId(crypto.randomUUID());
    }
  }, [open]);
  const customer = selectedCustomer;
  const subtotal = lines.reduce(
    (n, l) =>
      n +
      Math.round(
        (products.find((p) => p.id === l.productId)?.price || 0) *
          l.quantity,
      ),
    0,
  );
  let total = subtotal;
  let discount = 0;
  let pricingError = "";
  try {
    const pricing = priceSale(
      subtotal,
      customer?.tier === "Oro"
        ? state.settings.goldAt
        : customer?.tier === "Plata"
          ? state.settings.silverAt
          : 0,
      customer?.points || 0,
      points,
      state.settings,
    );
    total = pricing.total;
    discount = pricing.discount;
  } catch (e) {
    pricingError = (e as Error).message;
  }
  return (
    <>
      <Modal
        title="Nueva venta"
        description="Stock, puntos y comprobante se actualizan al confirmar."
        open={open}
        onClose={onClose}
        wide
      >
        <div className="operation-dialog-content sales-checkout-content">
        <Form
          submit="Confirmar venta"
          onCancel={onClose}
          onSubmit={async (fd) => {
            if (pricingError) throw new Error(pricingError);
            if (!customerId) throw new Error("Seleccioná un socio para continuar.");
            if (lines.some((line) => {
              const product = products.find((item) => item.id === line.productId);
              return !product || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity * 1000 > product.stock
                || Math.abs(line.quantity * 1000 - Math.round(line.quantity * 1000)) > 1e-6
                || (product.unit === "ud" && !Number.isInteger(line.quantity));
            })) {
              throw new Error("Revisá los productos y las cantidades antes de confirmar.");
            }
            const sale = await send<Sale>("/sales", {
              customerId,
              payment: fd.get("payment"),
              points,
              requestId,
              items: lines.map((l) => ({
                productId: l.productId,
                quantity: Math.round(l.quantity * 1000),
              })),
            });
            toast.success("Venta registrada");
            onClose();
            setTicket({ ...sale, customerName: customer?.name });
            await reload();
            window.dispatchEvent(new Event("bombo:sale-changed"));
          }}
        >
          <section className="sale-section sale-buyer" aria-labelledby="sale-buyer-title">
            <div className="sale-section-head"><span className="sale-step">01</span><div><h3 id="sale-buyer-title">Socio y cobro</h3><p>Encontrá al socio y elegí cómo paga.</p></div></div>
            <div className="form-grid">
              <Field label="Socio">
                <CustomerPicker
                  query={customerSearch}
                  onQueryChange={(value) => { setCustomerSearch(value); setSelectedCustomer(null); setCustomerId(""); setPoints(0); }}
                  selected={selectedCustomer}
                  items={searched === customerSearch ? customerOptions : []}
                  loading={customerData.loading || searched !== customerSearch}
                  error={customerData.error}
                  onSelect={(selected) => { setSelectedCustomer(selected); setCustomerId(selected?.id || ""); setCustomerSearch(selected?.name || ""); setPoints(0); }}
                />
              </Field>
              <Field label="Medio de pago">
                <select name="payment">
                  {Object.entries(payments).map(([key, name]) => (
                    <option key={key} value={key}>{name}</option>
                  ))}
                </select>
              </Field>
            </div>
          </section>
          {insights.data && <CustomerInsightsPanel insights={insights.data} today={state.today} money={money} compact />}
          {insights.loading && customerId && <p role="status" className="table-note">Leyendo historial del socio…</p>}
          {insights.error && customerId && <p role="alert" className="table-note">{insights.error}</p>}
          <section className="sale-section" aria-labelledby="sale-products-title">
          <div className="sale-section-head"><span className="sale-step">02</span><div><h3 id="sale-products-title">Productos</h3><p>Elegí cada lote y ajustá la cantidad.</p></div></div>
          {productData.loading && <p className="operation-inline-status" role="status">Cargando lotes disponibles…</p>}
          {productData.error && <div className="operation-error" role="alert"><p>{productData.error}</p><button type="button" className="button small-button" onClick={() => void productData.reload()}>Reintentar</button></div>}
          {!productData.loading && !productData.error && !products.some((product) => product.stock > 0 && (!product.expires || product.expires >= state.today)) && <div className="sale-products-empty" role="status"><p>No hay lotes disponibles para vender.</p><button type="button" className="button small-button" onClick={() => void productData.reload()}>Actualizar productos</button></div>}
          <div className="sale-lines">
            {lines.map((l, i) => {
              const product = products.find((p) => p.id === l.productId);
              return (
                <div className="sale-line" key={i}>
                  <Field label="Producto / lote">
                    <select
                      required
                      value={l.productId}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((item, index) =>
                            index === i
                              ? { ...item, productId: e.target.value, quantity: Math.min(1, (products.find((p) => p.id === e.target.value)?.stock || 1000) / 1000) }
                              : item,
                          ),
                        )
                      }
                    >
                      <option value="">Seleccionar producto</option>
                      {products
                        .filter(
                          (p) =>
                            p.stock > 0 &&
                            (!p.expires || p.expires >= state.today),
                        )
                        .map((p) => (
                          <option
                            key={p.id}
                            value={p.id}
                            disabled={lines.some(
                              (x, index) => index !== i && x.productId === p.id,
                            )}
                          >
                            {p.name} · {p.lot} · {money(p.price)}/{p.unit}
                          </option>
                        ))}
                    </select>
                    {product && (
                      <small>
                        {
                          state.users.find((u) => u.id === product.ownerId)
                            ?.name
                        }{" "}
                        · {number(product.stock / 1000)} {product.unit}{" "}
                        disponibles
                      </small>
                    )}
                  </Field>
                  <Field label={`Cantidad (${product?.unit || "g"})`}>
                    <div className="sale-quantity">
                      <button type="button" aria-label={`Restar 1 ${product?.unit || "g"} en línea ${i + 1}`} disabled={l.quantity <= 1} onClick={() => setLines((prev) => prev.map((item, index) => index === i ? { ...item, quantity: Math.round((item.quantity - 1) * 1000) / 1000 } : item))}><Minus size={14} /></button>
                      <input
                        aria-label={`Cantidad línea ${i + 1}`}
                        type="number"
                        inputMode="decimal"
                        min={product?.unit === "ud" ? 1 : 0.001}
                        max={product ? product.stock / 1000 : 100000}
                        step="any"
                        value={l.quantity}
                        onChange={(e) => setLines((prev) => prev.map((item, index) => index === i ? { ...item, quantity: Number(e.target.value) } : item))}
                        required
                      />
                      <button type="button" aria-label={`Sumar 1 ${product?.unit || "g"} en línea ${i + 1}`} disabled={!!product && l.quantity + 1 > product.stock / 1000} onClick={() => setLines((prev) => prev.map((item, index) => index === i ? { ...item, quantity: Math.round((item.quantity + 1) * 1000) / 1000 } : item))}><Plus size={14} /></button>
                    </div>
                  </Field>
                  <button
                    className="icon-button remove-line"
                    type="button"
                    aria-label={`Eliminar línea ${i + 1}`}
                    disabled={lines.length === 1}
                    onClick={() =>
                      setLines(lines.filter((_, idx) => idx !== i))
                    }
                  >
                    <Trash size={20} />
                  </button>
                  {product && <div className="sale-line-price">{money(Math.round(product.price * l.quantity))}</div>}
                </div>
              );
            })}
          </div>
          <button
            className="button small-button"
            type="button"
            onClick={() => setLines([...lines, { productId: "", quantity: 1 }])}
          >
            <Plus />
            Agregar producto
          </button>
          </section>
          <section className="sale-section sale-finish" aria-labelledby="sale-finish-title">
          <div className="sale-section-head"><span className="sale-step">03</span><div><h3 id="sale-finish-title">Revisá el total</h3><p>La venta genera un comprobante interno al confirmar.</p></div></div>
          <div className="sale-checkout">
            <div>
              {customer && user.role !== "responsible" && (
                <Field
                  label={`Canjear puntos (${customer.points} disponibles)`}
                >
                  <input
                    type="number"
                    min="0"
                    max={Math.min(
                      customer.points,
                      Math.floor(subtotal / state.settings.pointValue),
                    )}
                    value={points}
                    onChange={(e) => setPoints(Number(e.target.value))}
                  />
                  <small>1 punto = {money(state.settings.pointValue)}</small>
                </Field>
              )}
              {user.role === "responsible" && (
                <small>
                  El servidor aplica el nivel de fidelidad vigente al confirmar.
                </small>
              )}
            </div>
            <div className="sale-totals">
              <div>
                <span>Subtotal</span>
                <span>{money(subtotal)}</span>
              </div>
              <div>
                <span>Descuentos</span>
                <span>−{money(discount)}</span>
              </div>
              <div className="total">
                <strong>Total</strong>
                <strong>{money(total)}</strong>
              </div>
            </div>
          </div>
          </section>
          {pricingError && (
            <p role="alert" className="form-error">
              {pricingError}
            </p>
          )}
        </Form>
        </div>
      </Modal>
      <Ticket sale={ticket} onClose={() => setTicket(null)} />
    </>
  );
}
export function Ticket({
  sale,
  onClose,
}: {
  sale: Sale | null;
  onClose: () => void;
}) {
  const { state, money } = useClub();
  return (
    <Modal title="Comprobante de venta" description="Registro interno de la operación. Disponible para imprimir." open={!!sale} onClose={onClose}>
      {sale && (
        <div className="sales-ticket-content">
          <div className="print-ticket" data-receipt-version="1">
            <div className="ticket-heading">
              <img className="ticket-logo" src="/brand/bombo-olive.webp" alt="Bombo" />
              <span className="ticket-mark"><CheckCircle size={27} weight="fill" /></span>
              <span className="ticket-kicker">VENTA REGISTRADA</span>
              <h2>Comprobante interno</h2>
              <p>{state.settings.clubName} · Registro de venta</p>
            </div>
            <div className="ticket-meta">
              <div><span>Número de operación</span><strong>{sale.id}</strong></div>
              <div><span>Fecha y hora</span><strong>{new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: state.settings.timezone }).format(new Date(sale.createdAt))}</strong></div>
              <div><span>Socio</span><strong>{sale.customerName || "Socio"}</strong></div>
              <div><span>Canal</span><strong>{sale.channel === "delivery" ? "Delivery" : "Local"}</strong></div>
            </div>
            <div className="ticket-items-title"><span>Detalle</span><span>Importe</span></div>
            {sale.items.map((i) => (
              <div className="ticket-line" key={i.id}>
                <span>
                  <strong>{i.name}</strong>
                  <small>
                    {number(i.quantity / 1000)} {i.unit || "g"} × {money(i.price)}
                  </small>
                </span>
                <strong>{money(i.revenue)}</strong>
              </div>
            ))}
            <div className="ticket-breakdown">
              <div><span>Subtotal</span><strong>{money(sale.subtotal)}</strong></div>
              {sale.discount > 0 && <div><span>Descuentos y puntos</span><strong>−{money(sale.discount)}</strong></div>}
            </div>
            <div className="ticket-total">
              <span>Total</span>
              <strong>{money(sale.total)}</strong>
            </div>
            <div className="ticket-payment"><span>Medio de pago</span><strong>{payments[sale.payment] || sale.payment}</strong></div>
            {(sale.pointsEarned > 0 || sale.pointsUsed > 0) && <p className="ticket-points">{sale.pointsEarned > 0 && `+${sale.pointsEarned} puntos acumulados`}{sale.pointsEarned > 0 && sale.pointsUsed > 0 && " · "}{sale.pointsUsed > 0 && `${sale.pointsUsed} puntos canjeados`}</p>}
            <p className="ticket-disclaimer">
              Importes en {state.settings.currency}. Este es un comprobante interno de la operación y no constituye una factura fiscal.
            </p>
          </div>
          <button className="button primary full-width ticket-print" onClick={() => window.print()}>
            <Printer />
            Imprimir comprobante
          </button>
        </div>
      )}
    </Modal>
  );
}
