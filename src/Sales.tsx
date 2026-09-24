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
const payments: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  transfer: "Transferencia",
};
type CheckoutCustomer = Pick<Customer, "id" | "name" | "points" | "tier" | "permitStatus" | "permitValidUntil">;
type CheckoutProduct = Pick<Product, "id" | "name" | "lot" | "price" | "stock" | "unit" | "ownerId" | "expires">;
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
  useEffect(() => { const refresh = () => void page.reload(); window.addEventListener("raiz:sale-changed", refresh); return () => window.removeEventListener("raiz:sale-changed", refresh); }, [page.reload]);
  const [ticket, setTicket] = useState<Sale | null>(null);
  const [close, setClose] = useState(false);
  const cash = state.cashExpected;
  const closed = state.closures.find((c) => c.date === state.today);
  const canClose = ["owner", "admin", "cashier"].includes(user.role);
  const sales = page.data?.items || [];
  return (
    <>
      <PageHeader
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
        title="Historial de ventas"
        action={<span className="muted small">{page.data?.total ?? "…"} operaciones</span>}
      >
        <div className="table-toolbar">
          <Search
            value={query}
            onChange={(value) => { setQuery(value); updateParams("q", value); }}
            placeholder="Buscar socio o ticket…"
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
        <div className="table-scroll">
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
                  <td>
                    <strong className="ticket-id">
                      {s.id.startsWith("V-")
                        ? s.id
                        : s.id.slice(-8).toUpperCase()}
                    </strong>
                    <small className="cell-small">{shortDate(s.date)}</small>
                  </td>
                  <td>
                    {s.customerName || "Socio"}
                  </td>
                  <td>
                    <span className="truncate">
                      {s.items
                        .map((i) => `${i.name} (${number(i.quantity / 1000)})`)
                        .join(", ")}
                    </span>
                  </td>
                  <td>
                    <Badge tone="gray">{payments[s.payment]}</Badge>
                  </td>
                  <td className="numeric amount">{money(s.total)}</td>
                  <td>
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
          {!page.loading && !sales.length && <Empty title="No hay ventas para mostrar" />}
        </div>
        {page.error && <p role="alert">{page.error}</p>}
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
      </Modal>
      <Ticket sale={ticket} onClose={() => setTicket(null)} />
    </>
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
  const customerOptions = selectedCustomer
    ? [selectedCustomer, ...(customerData.data?.items || []).filter((c) => c.id !== selectedCustomer.id)]
    : customerData.data?.items || [];
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
        <Form
          submit="Confirmar venta"
          onCancel={onClose}
          onSubmit={async (fd) => {
            if (pricingError) throw new Error(pricingError);
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
            window.dispatchEvent(new Event("raiz:sale-changed"));
          }}
        >
          <div className="form-grid">
            <Field label="Socio">
              <input type="search" aria-label="Buscar socio" placeholder="Escribí nombre o email…" value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />
              <select
                aria-label="Socio"
                required
                value={customerId}
                onChange={(e) => {
                  setCustomerId(e.target.value);
                  setSelectedCustomer(customerOptions.find((c) => c.id === e.target.value) || null);
                  setPoints(0);
                }}
              >
                <option value="">Seleccionar socio</option>
                {customerOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.tier}
                  </option>
                ))}
              </select>
              {customerData.loading && <small>Buscando socios…</small>}
              {customerData.error && <small role="alert">{customerData.error}</small>}
            </Field>
            <Field label="Medio de pago">
              <select name="payment">
                {Object.entries(payments).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {insights.data && <CustomerInsightsPanel insights={insights.data} today={state.today} money={money} compact />}
          {insights.loading && customerId && <p role="status" className="table-note">Leyendo historial del socio…</p>}
          {insights.error && customerId && <p role="alert" className="table-note">{insights.error}</p>}
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
                              ? { ...item, productId: e.target.value }
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
                    <input
                      aria-label={`Cantidad línea ${i + 1}`}
                      type="number"
                      min={product?.unit === "ud" ? 1 : 0.001}
                      max={product ? product.stock / 1000 : 100000}
                      step={product?.unit === "ud" ? 1 : 0.001}
                      value={l.quantity}
                      onChange={(e) =>
                        setLines((prev) =>
                          prev.map((item, index) =>
                            index === i
                              ? { ...item, quantity: Number(e.target.value) }
                              : item,
                          ),
                        )
                      }
                      required
                    />
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
          {pricingError && (
            <p role="alert" className="form-error">
              {pricingError}
            </p>
          )}
        </Form>
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
    <Modal title="Comprobante de venta" open={!!sale} onClose={onClose}>
      {sale && (
        <>
          <div className="print-ticket">
            <div className="ticket-heading">
              <CheckCircle size={36} weight="duotone" />
              <h2>{state.settings.clubName}</h2>
              <p>Comprobante interno · {sale.id.slice(-10).toUpperCase()}</p>
              <small>
                {shortDate(sale.date)} ·{" "}
                {sale.customerName || "Socio"}
              </small>
            </div>
            {sale.items.map((i) => (
              <div className="ticket-line" key={i.id}>
                <span>
                  {i.name}
                  <small>
                    {number(i.quantity / 1000)} × {money(i.price)}
                  </small>
                </span>
                <strong>{money(i.revenue)}</strong>
              </div>
            ))}
            <div className="ticket-total">
              <span>Total</span>
              <strong>{money(sale.total)}</strong>
            </div>
            <p className="muted small">
              {payments[sale.payment]} · {sale.pointsEarned} puntos obtenidos
            </p>
            <p className="ticket-disclaimer">
              Importes en {state.settings.currency}. Documento interno. No
              constituye factura fiscal.
            </p>
          </div>
          <button className="button full-width" onClick={() => window.print()}>
            <Printer />
            Imprimir comprobante
          </button>
        </>
      )}
    </Modal>
  );
}
