import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowClockwise, CheckCircle, Plus, WarningCircle, X } from "@phosphor-icons/react";
import { send, useResource } from "./lib";
import "./decision-inputs.css";

type Scenario = "low" | "base" | "high";
type Account = "cash" | "bank";
type MappingStatus = "shared" | "separate";
type AttestationDomain = "delivery_sales" | "cash_plan";

type Product = {
  id: string;
  name: string;
  lot: string;
  unit: string;
  locationId: string | null;
  supplierId: string | null;
};

type Location = { id: string; name: string };
type Supplier = { id: string; name: string };

type Mapping = {
  status: MappingStatus | string;
  sharedLocationIds: string[];
  localLocationIds: string[];
  deliveryLocationIds: string[];
  reference: string;
  confirmedAt: string;
};

type Rule = {
  productId: string;
  leadTimeDays: number;
  minimumOrderQuantityMilliunits: number;
  reviewPeriodDays: number;
  sourceReference: string;
};

type Quote = {
  id: string;
  productId: string;
  quotedOn: string;
  validUntil: string | null;
  unitCostCentsPerUnit: string;
  sourceReference: string;
  status: "active" | "cancelled" | string;
};

type Inbound = {
  id: string;
  productId: string;
  locationId: string | null;
  quantityMilliunits: number;
  arrivalDate: string;
  status: string;
  sourceReference: string;
};

type CashSnapshot = {
  id: string;
  asOf: string;
  floorCents: string;
  sourceReference: string;
  complete: boolean;
  accounts: Array<{ account: string; amountCents: string }>;
};

type CashPlan = {
  id: string;
  scenario: Scenario;
  date: string;
  account: string;
  category: string;
  amountCents: string;
  sourceReference: string;
  status: "active" | "cancelled" | string;
};

type Attestation = {
  id: string;
  domain: AttestationDomain;
  scenario: Scenario | null;
  fromDate: string;
  throughDate: string;
  complete: boolean;
  sourceReference: string;
};

type DecisionInputsPayload = {
  products: Product[];
  locations: Location[];
  suppliers: Supplier[];
  mapping: Mapping | null;
  rules: Rule[];
  quotes: Quote[];
  inbounds: Inbound[];
  cashSnapshots: CashSnapshot[];
  cashPlans: CashPlan[];
  attestations: Attestation[];
};

type Filters = { productId: string; from: string; through: string; search: string };

const scenarios: Array<{ value: Scenario; label: string }> = [
  { value: "low", label: "Bajo" },
  { value: "base", label: "Base" },
  { value: "high", label: "Alto" },
];

const cashCategories = [
  ["sale", "Venta local"],
  ["operating_expense", "Gasto operativo"],
  ["stock_purchase", "Compra de stock"],
  ["local_investment", "Inversión en el local"],
  ["capital_contribution", "Aporte de capital"],
  ["owner_draw", "Retiro personal"],
  ["delivery_receipt", "Cobro de delivery"],
  ["other_income", "Otro ingreso"],
  ["other_outflow", "Otro egreso"],
  ["adjustment", "Ajuste documentado"],
] as const;

const centsFormatter = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
const decimalSeparator =
  new Intl.NumberFormat("es-AR").formatToParts(1.1).find((part) => part.type === "decimal")?.value || ",";

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "Sin fecha informada";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T12:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("es-AR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(parsed);
}

function centsLabel(value: string): string {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) return `Centavos inválidos: ${value}`;
  try {
    const cents = BigInt(value);
    const negative = cents < 0n;
    const absolute = negative ? -cents : cents;
    return `${negative ? "−" : ""}${centsFormatter.format(absolute / 100n)}${decimalSeparator}${(absolute % 100n).toString().padStart(2, "0")}`;
  } catch {
    return `Centavos inválidos: ${value}`;
  }
}

function quantityLabel(value: number, unit = ""): string {
  if (!Number.isSafeInteger(value)) return "Cantidad inválida";
  const milliunits = BigInt(value);
  const whole = milliunits / 1000n;
  const fraction = (milliunits % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  const localizedWhole = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(whole);
  const amount = fraction ? `${localizedWhole}${decimalSeparator}${fraction}` : localizedWhole;
  return `${amount}${unit.trim() ? ` ${unit.trim()}` : ""}`;
}

function textValue(form: FormData, name: string, label: string): string {
  const value = String(form.get(name) ?? "").trim();
  if (!value) throw new Error(`${label}: completá este campo.`);
  return value;
}

function referenceValue(form: FormData, name: string, label: string): string {
  const value = textValue(form, name, label);
  if (value.length < 3 || value.length > 240) throw new Error(`${label}: usá entre 3 y 240 caracteres.`);
  return value;
}

function optionalValue(form: FormData, name: string): string | null {
  const value = String(form.get(name) ?? "").trim();
  return value || null;
}

function integerValue(
  form: FormData,
  name: string,
  label: string,
  { minimum = 0, maximum = 2_147_483_647 }: { minimum?: number; maximum?: number } = {},
): number {
  const raw = String(form.get(name) ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) throw new Error(`${label}: ingresá un número entero en milésimas/días.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${label}: ingresá un entero entre ${minimum.toLocaleString("es-AR")} y ${maximum.toLocaleString("es-AR")}.`);
  return value;
}

function centsValue(
  form: FormData,
  name: string,
  label: string,
  { signed = false, nonZero = false }: { signed?: boolean; nonZero?: boolean } = {},
): string {
  const raw = textValue(form, name, label);
  const pattern = signed ? /^-?(?:0|[1-9]\d*)$/ : /^(?:0|[1-9]\d*)$/;
  if (!pattern.test(raw))
    throw new Error(`${label}: usá centavos como cadena de enteros, sin punto ni coma (por ejemplo, 125050).`);
  const amount = BigInt(raw);
  if (amount < -(2n ** 63n) || amount > 2n ** 63n - 1n) throw new Error(`${label}: el importe excede el rango de 64 bits.`);
  if (nonZero && amount === 0n) throw new Error(`${label}: el importe no puede ser cero.`);
  return raw;
}

function dateValue(form: FormData, name: string, label: string): string {
  const value = textValue(form, name, label);
  if (!isCalendarDate(value)) throw new Error(`${label}: indicá una fecha válida.`);
  return value;
}

function reviewed(form: FormData, message: string) {
  if (form.get("humanReview") !== "on") throw new Error(message);
}

function productName(products: Product[], productId: string): string {
  const product = products.find((item) => item.id === productId);
  return product ? `${product.name}${product.lot ? ` · lote ${product.lot}` : ""}` : "Producto sin nombre";
}

function locationName(locations: Location[], locationId: string | null): string {
  if (!locationId) return "Sin ubicación informada";
  return locations.find((item) => item.id === locationId)?.name || "Ubicación sin nombre";
}

function accountName(account: string): string {
  if (account === "cash") return "Efectivo";
  if (account === "bank") return "Banco";
  return account;
}

function scenarioName(scenario: Scenario): string {
  return scenarios.find((item) => item.value === scenario)?.label || scenario;
}

function statusName(status: string): string {
  if (status === "active") return "Activo";
  if (status === "cancelled") return "Cancelado";
  if (status === "pending") return "Pendiente";
  if (status === "received") return "Recibido";
  return status || "Sin estado informado";
}

function statusClass(status: string): string {
  if (status === "active" || status === "received") return "di-status--good";
  if (status === "cancelled") return "di-status--muted";
  return "di-status--pending";
}

function sourceText(source: string): string {
  return source.trim() || "Fuente sin informar";
}

function matchesSearch(search: string, ...values: Array<string | null | undefined>): boolean {
  const term = search.trim().toLocaleLowerCase("es-AR");
  if (!term) return true;
  return values.some((value) => value?.toLocaleLowerCase("es-AR").includes(term));
}

function matchesDate(date: string, filters: Filters): boolean {
  const day = date.slice(0, 10);
  if (filters.from && day < filters.from) return false;
  if (filters.through && day > filters.through) return false;
  return true;
}

function matchesProduct(productId: string, filters: Filters): boolean {
  return !filters.productId || filters.productId === productId;
}

function SectionHeading({
  id,
  eyebrow,
  title,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="di-section-heading">
      <div>
        <span className="di-eyebrow">{eyebrow}</span>
        <h2 id={id}>{title}</h2>
        {children && <p>{children}</p>}
      </div>
    </header>
  );
}

function ReviewConsent({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  return (
    <label className="di-review" htmlFor={id}>
      <input id={id} name="humanReview" type="checkbox" required />
      <span>{children}</span>
    </label>
  );
}

function Field({
  label,
  name,
  children,
  hint,
}: {
  label: string;
  name?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="di-field">
      <label htmlFor={name}>{label}</label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}

function LocationChoices({
  name,
  title,
  locations,
  selected,
}: {
  name: string;
  title: string;
  locations: Location[];
  selected: string[];
}) {
  return (
    <fieldset className="di-choice-group">
      <legend>{title}</legend>
      {locations.length ? (
        <div className="di-choice-list">
          {locations.map((location) => (
            <label key={location.id}>
              <input
                type="checkbox"
                name={name}
                value={location.id}
                defaultChecked={selected.includes(location.id)}
              />
              <span>{location.name}</span>
            </label>
          ))}
        </div>
      ) : (
        <p className="di-inline-empty">No hay ubicaciones disponibles en la respuesta del servidor.</p>
      )}
    </fieldset>
  );
}

export default function DecisionInputs() {
  const resource = useResource<DecisionInputsPayload>("/decision-inputs");
  const [view, setView] = useState<"stock" | "replenishment" | "cash">("stock");
  const data = resource.data;
  const [filters, setFilters] = useState<Filters>({ productId: "", from: "", through: "", search: "" });
  const [cashScenario, setCashScenario] = useState<Scenario>("base");
  const [attestationDomain, setAttestationDomain] = useState<AttestationDomain>("delivery_sales");
  const [accountRows, setAccountRows] = useState<Array<{ id: number; account: Account }>>([{ id: 1, account: "cash" }]);
  const [nextAccountRow, setNextAccountRow] = useState(2);
  const [saving, setSaving] = useState("");
  const [notice, setNotice] = useState("");
  const [mutationError, setMutationError] = useState("");

  const filterDatesValid = !filters.from || !filters.through || filters.from <= filters.through;
  const recordsEmpty = Boolean(data && !data.mapping && !data.rules.length && !data.quotes.length &&
    !data.inbounds.length && !data.cashSnapshots.length && !data.cashPlans.length && !data.attestations.length);
  const activeQuoteCount = data?.quotes.filter((quote) => quote.status === "active").length || 0;
  const activePlanCount = data?.cashPlans.filter((plan) => plan.status === "active").length || 0;
  const completeSnapshotCount = data?.cashSnapshots.filter((snapshot) => snapshot.complete &&
    snapshot.sourceReference.trim() && snapshot.accounts.length > 0).length || 0;
  const completeCashScenarios = scenarios.filter(({ value }) => data?.attestations.some((attestation) =>
    attestation.domain === "cash_plan" && attestation.scenario === value && attestation.complete &&
    attestation.sourceReference.trim() && isCalendarDate(attestation.fromDate) && isCalendarDate(attestation.throughDate))).length;

  async function saveForm(
    event: FormEvent<HTMLFormElement>,
    endpoint: string,
    key: string,
    savedLabel: string,
    createBody: (form: FormData) => unknown,
    afterSuccess?: () => void,
  ) {
    event.preventDefault();
    const form = event.currentTarget;
    setSaving(key);
    setNotice("");
    setMutationError("");
    try {
      const body = createBody(new FormData(form));
      await send(endpoint, body);
      form.reset();
      afterSuccess?.();
      setNotice(`${savedLabel} guardado. La pantalla vuelve a consultar los datos del servidor.`);
      await resource.reload();
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : "No se pudo guardar esta entrada.");
    } finally {
      setSaving("");
    }
  }

  function filteredProductRecords<T extends { productId: string; sourceReference: string }>(rows: T[], dateOf: (row: T) => string): T[] {
    if (!filterDatesValid) return [];
    return rows.filter((row) => matchesProduct(row.productId, filters) && matchesDate(dateOf(row), filters) &&
      matchesSearch(filters.search, productName(data?.products || [], row.productId), row.sourceReference));
  }

  const visibleRules = (data?.rules || []).filter((rule) => matchesProduct(rule.productId, filters) &&
    matchesSearch(filters.search, productName(data?.products || [], rule.productId), rule.sourceReference));
  const visibleQuotes = filteredProductRecords(data?.quotes || [], (row) => row.quotedOn);
  const visibleInbounds = filteredProductRecords(data?.inbounds || [], (row) => row.arrivalDate);
  const visibleSnapshots = !filterDatesValid ? [] : (data?.cashSnapshots || []).filter((row) =>
    matchesDate(row.asOf, filters) && matchesSearch(filters.search, row.sourceReference, ...row.accounts.map((account) => account.account)));
  const visiblePlans = !filterDatesValid ? [] : (data?.cashPlans || []).filter((row) =>
    row.scenario === cashScenario && matchesDate(row.date, filters) &&
    matchesSearch(filters.search, row.sourceReference, row.account, row.category));
  const visibleAttestations = !filterDatesValid ? [] : (data?.attestations || []).filter((row) => {
    const overlaps = (!filters.from || row.throughDate >= filters.from) && (!filters.through || row.fromDate <= filters.through);
    return overlaps && matchesSearch(filters.search, row.sourceReference, row.domain, row.scenario || "");
  });

  return (
    <main className="decision-inputs">
      <header className="di-header">
        <div className="di-header-copy">
          <span className="di-eyebrow">DECISIONES · FUENTES Y SUPUESTOS</span>
          <h1>Preparar decisiones</h1>
          <p>Reuní los datos y las fuentes antes de evaluar stock, precios y caja. Cada alta exige revisión humana; ninguna registra compras ni pagos.</p>
        </div>
        <button className="di-button di-button--quiet" type="button" onClick={() => void resource.reload()} disabled={resource.loading}>
          <ArrowClockwise size={17} aria-hidden="true" />
          {resource.loading ? "Actualizando…" : "Actualizar"}
        </button>
      </header>

      <div className="di-safety-note" role="note">
        <WarningCircle size={19} weight="fill" aria-hidden="true" />
        <p><strong>Preparar datos no autoriza una decisión.</strong> La app mostrará las fuentes y estados informados; el servidor valida las reglas de cada registro.</p>
      </div>
      <nav className="di-view-nav" aria-label="Áreas para preparar decisiones">
        <button type="button" className={view === "stock" ? "active" : ""} aria-current={view === "stock" ? "page" : undefined} onClick={() => setView("stock")}>Alcance de stock</button>
        <button type="button" className={view === "replenishment" ? "active" : ""} aria-current={view === "replenishment" ? "page" : undefined} onClick={() => setView("replenishment")}>Reposición</button>
        <button type="button" className={view === "cash" ? "active" : ""} aria-current={view === "cash" ? "page" : undefined} onClick={() => setView("cash")}>Caja</button>
      </nav>

      {resource.loading && !data && <div className="di-loading" role="status">Cargando fuentes del servidor…</div>}
      {resource.error && (
        <div className="di-error" role="alert">
          <div><strong>No se pudieron cargar las fuentes.</strong><p>{resource.error}</p></div>
          <button type="button" className="di-button" onClick={() => void resource.reload()}>Reintentar</button>
        </div>
      )}
      {notice && <div className="di-success" role="status"><CheckCircle size={18} weight="fill" aria-hidden="true" />{notice}</div>}
      {mutationError && <div className="di-error" role="alert"><div><strong>No se guardó la entrada.</strong><p>{mutationError}</p></div><button className="di-icon-button" type="button" aria-label="Cerrar mensaje" onClick={() => setMutationError("")}><X size={17} /></button></div>}
      {recordsEmpty && (
        <div className="di-empty-banner">
          <span>Sin datos de decisión cargados</span>
          <p>Esta respuesta no contiene todavía registros de fuentes o supuestos. Los formularios empiezan vacíos y no presentan datos de demostración como reales.</p>
        </div>
      )}

      <details className="di-overview-details"><summary>Estado general de las entradas</summary>
      <section className="di-readiness" aria-labelledby="di-readiness-title">
        <div className="di-readiness-heading">
          <div><span className="di-eyebrow">ESTADO DE ENTRADAS</span><h2 id="di-readiness-title">Qué falta para evaluar</h2></div>
          <span className={`di-status ${data?.mapping ? "di-status--pending" : "di-status--muted"}`}>
            {data?.mapping ? "Mapeo informado · requiere revisión" : "Mapeo pendiente"}
          </span>
        </div>
        <div className="di-readiness-grid">
          <div><span>Reposición</span><strong>{data?.rules.length || 0} reglas</strong><small>Plazo, mínimo, revisión y fuente</small></div>
          <div><span>Cotizaciones activas</span><strong>{activeQuoteCount}</strong><small>Canceladas quedan fuera del motor</small></div>
          <div><span>Entregas pendientes</span><strong>{data?.inbounds.filter((item) => item.status === "pending").length || 0}</strong><small>Con fecha y referencia</small></div>
          <div><span>Caja · saldos completos declarados</span><strong>{completeSnapshotCount}</strong><small>Un saldo no prueba por sí solo obligaciones completas</small></div>
        </div>
        <div className="di-cash-requirement">
          <strong>Caja necesita tres piezas completas:</strong>
          <span>snapshot conciliado y con fecha</span><span>fuente trazable</span><span>obligaciones completas por escenario</span>
          <small>{completeCashScenarios}/3 escenarios tienen una atestación marcada completa. “Completa” refleja la declaración guardada; la conciliación y la coincidencia de fecha las valida el servidor.</small>
        </div>
      </section>
      </details>

      <details className="di-filter-details"><summary>Filtrar registros por producto, fecha o fuente</summary>
      <section className="di-filters" aria-label="Filtros de registros">
        <div className="di-filter-heading"><div><span className="di-eyebrow">VISTAS</span><strong>Filtrar registros</strong></div>{(filters.productId || filters.from || filters.through || filters.search) && <button type="button" className="di-text-button" onClick={() => setFilters({ productId: "", from: "", through: "", search: "" })}>Limpiar filtros</button>}</div>
        <div className="di-filter-grid">
          <Field label="Producto" name="di-filter-product">
            <select id="di-filter-product" value={filters.productId} onChange={(event) => setFilters((current) => ({ ...current, productId: event.target.value }))}>
              <option value="">Todos los productos</option>
              {(data?.products || []).map((product) => <option key={product.id} value={product.id}>{product.name}{product.lot ? ` · lote ${product.lot}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Desde" name="di-filter-from"><input id="di-filter-from" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} /></Field>
          <Field label="Hasta" name="di-filter-through"><input id="di-filter-through" type="date" value={filters.through} onChange={(event) => setFilters((current) => ({ ...current, through: event.target.value }))} /></Field>
          <Field label="Fuente o texto" name="di-filter-search"><input id="di-filter-search" type="search" value={filters.search} placeholder="Buscar referencia…" onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} /></Field>
        </div>
        {!filterDatesValid && <p className="di-filter-error" role="alert">La fecha “Desde” debe ser anterior o igual a “Hasta”.</p>}
        <small>El producto filtra reglas, cotizaciones y entregas. Fechas y referencia filtran todas las listas. Las reglas no tienen una fecha en este contrato.</small>
      </section>
      </details>

      {view === "stock" &&
      <section className="di-section" aria-labelledby="di-mapping-title">
        <SectionHeading id="di-mapping-title" eyebrow="01 · ALCANCE DEL STOCK" title="Confirmar ubicaciones compartidas">
          La decisión de stock compartido la confirma Tiziano. No combinamos inventario local y delivery por una suposición.
        </SectionHeading>
        <div className="di-content-grid">
          <article className="di-card">
            <h3>{data?.mapping ? "Actualizar el mapeo" : "Registrar la decisión de Tiziano"}</h3>
            {data?.mapping && <div className="di-existing-record"><span>Última confirmación informada</span><strong>{data.mapping.status === "shared" ? "Stock compartido" : data.mapping.status === "separate" ? "Stock separado" : data.mapping.status}</strong><small>Confirmada: {dateLabel(data.mapping.confirmedAt)} · Fuente: {sourceText(data.mapping.reference)}</small></div>}
            <form key={data?.mapping?.confirmedAt || "mapping-empty"} className="di-form" onSubmit={(event) => void saveForm(event, "/decision-inputs/mapping", "mapping", "Mapeo", (form) => {
              reviewed(form, "Marcá que Tiziano confirmó esta decisión antes de guardarla.");
              const status = textValue(form, "status", "Estado") as MappingStatus;
              if (status !== "shared" && status !== "separate") throw new Error("Elegí stock compartido o separado.");
              const sharedLocationIds = form.getAll("sharedLocationIds").map(String);
              const localLocationIds = form.getAll("localLocationIds").map(String);
              const deliveryLocationIds = form.getAll("deliveryLocationIds").map(String);
              if (!localLocationIds.length || !deliveryLocationIds.length) throw new Error("Elegí al menos una ubicación para el local y otra para delivery.");
              if (status === "shared") {
                const shared = new Set(sharedLocationIds);
                if (!shared.size || [...localLocationIds, ...deliveryLocationIds].some((locationId) => !shared.has(locationId)))
                  throw new Error("Con stock compartido, todas las ubicaciones del local y delivery deben estar incluidas en el conjunto compartido.");
              } else if (sharedLocationIds.length || localLocationIds.some((locationId) => deliveryLocationIds.includes(locationId))) {
                throw new Error("Con stock separado, dejá vacío el conjunto compartido y elegí ubicaciones distintas por canal.");
              }
              return {
                status,
                sharedLocationIds,
                localLocationIds,
                deliveryLocationIds,
                reference: referenceValue(form, "reference", "Referencia de la decisión"),
              };
            })}>
              <fieldset className="di-fields" disabled={Boolean(saving) || !data}>
                <Field label="Decisión de Tiziano" name="di-mapping-status">
                  <select id="di-mapping-status" name="status" defaultValue={data?.mapping?.status === "separate" ? "separate" : "shared"} required>
                    <option value="shared">Stock compartido</option><option value="separate">Stock separado</option>
                  </select>
                </Field>
                <Field label="Acta, nota o referencia" name="di-mapping-reference" hint="La referencia queda visible junto con quién y cuándo confirmó el servidor.">
                  <input id="di-mapping-reference" name="reference" type="text" required defaultValue={data?.mapping?.reference || ""} placeholder="Ej.: reunión de operación del 25/09" />
                </Field>
                <LocationChoices name="sharedLocationIds" title="Ubicaciones consideradas compartidas" locations={data?.locations || []} selected={data?.mapping?.sharedLocationIds || []} />
                <div className="di-choice-grid">
                  <LocationChoices name="localLocationIds" title="Ubicaciones del local" locations={data?.locations || []} selected={data?.mapping?.localLocationIds || []} />
                  <LocationChoices name="deliveryLocationIds" title="Ubicaciones de delivery" locations={data?.locations || []} selected={data?.mapping?.deliveryLocationIds || []} />
                </div>
                <ReviewConsent id="di-review-mapping">Tiziano confirmó esta clasificación y revisé la referencia y las ubicaciones.</ReviewConsent>
                <button className="di-button di-button--primary" type="submit" disabled={Boolean(saving) || !data}>{saving === "mapping" ? "Guardando…" : "Guardar mapeo"}</button>
              </fieldset>
            </form>
          </article>

          <article className="di-card">
            <h3>Reglas de reposición por producto</h3>
            <p className="di-muted">El mínimo se expresa en milésimas de la unidad. 1 unidad equivale a 1000 milésimas.</p>
            <div className="di-table-scroll">
              <table><thead><tr><th>Producto</th><th>Plazo</th><th>Mínimo</th><th>Revisión</th><th>Fuente</th></tr></thead><tbody>
                {visibleRules.map((rule) => {
                  const product = data?.products.find((item) => item.id === rule.productId);
                  const supplier = data?.suppliers.find((item) => item.id === product?.supplierId);
                  return <tr key={rule.productId}><th scope="row">{productName(data?.products || [], rule.productId)}<small>{supplier?.name || "Proveedor sin informar"}</small></th><td>{rule.leadTimeDays} días</td><td>{quantityLabel(rule.minimumOrderQuantityMilliunits, product?.unit)}</td><td>{rule.reviewPeriodDays} días</td><td>{sourceText(rule.sourceReference)}</td></tr>;
                })}
                {!visibleRules.length && <tr><td colSpan={5} className="di-empty-cell">Sin reglas que coincidan con los filtros.</td></tr>}
              </tbody></table>
            </div>
            <form className="di-form di-form--topline" onSubmit={(event) => void saveForm(event, "/decision-inputs/rules", "rules", "Regla de reposición", (form) => {
              reviewed(form, "Confirmá que revisaste la regla y su fuente.");
              return {
                productId: textValue(form, "productId", "Producto"),
                leadTimeDays: integerValue(form, "leadTimeDays", "Plazo de entrega", { maximum: 365 }),
                minimumOrderQuantityMilliunits: integerValue(form, "minimumOrderQuantityMilliunits", "Pedido mínimo"),
                reviewPeriodDays: integerValue(form, "reviewPeriodDays", "Período de revisión", { minimum: 1, maximum: 365 }),
                sourceReference: referenceValue(form, "sourceReference", "Fuente de la regla"),
              };
            })}>
              <div className="di-form-grid">
                <Field label="Producto" name="di-rule-product"><select id="di-rule-product" name="productId" required defaultValue=""><option value="" disabled>Elegir producto</option>{(data?.products || []).map((item) => <option key={item.id} value={item.id}>{item.name}{item.lot ? ` · ${item.lot}` : ""}</option>)}</select></Field>
                <Field label="Plazo (días)" name="di-rule-lead" hint="Entero entre 0 y 365 días."><input id="di-rule-lead" name="leadTimeDays" type="number" min="0" max="365" step="1" required /></Field>
                <Field label="Pedido mínimo (milésimas)" name="di-rule-minimum" hint="1 unidad = 1000 milésimas."><input id="di-rule-minimum" name="minimumOrderQuantityMilliunits" type="number" min="0" max="2147483647" step="1" required /></Field>
                <Field label="Revisión (días)" name="di-rule-review"><input id="di-rule-review" name="reviewPeriodDays" type="number" min="1" max="365" step="1" required /></Field>
                <Field label="Fuente" name="di-rule-source"><input id="di-rule-source" name="sourceReference" type="text" required placeholder="Lista del proveedor, fecha…" /></Field>
              </div>
              <ReviewConsent id="di-review-rule">Revisé el plazo, el mínimo y la fuente del proveedor.</ReviewConsent>
              <button className="di-button di-button--primary" type="submit" disabled={Boolean(saving) || !data?.products.length}>{saving === "rules" ? "Guardando…" : "Guardar regla"}</button>
              {!data?.products.length && <p className="di-inline-empty">Cargá productos en el catálogo para agregar reglas.</p>}
            </form>
          </article>
        </div>
      </section>
      }

      {view === "replenishment" &&
      <section className="di-section" aria-labelledby="di-market-title">
        <SectionHeading id="di-market-title" eyebrow="02 · COSTOS Y ENTREGAS" title="Registrar evidencia de reposición">
          Las cotizaciones y recepciones aportan evidencia. Guardarlas no crea una orden ni recibe mercadería.
        </SectionHeading>
        <div className="di-content-grid">
          <article className="di-card">
            <h3>Cotizaciones</h3>
            <div className="di-table-scroll"><table><thead><tr><th>Producto</th><th>Fecha</th><th>Vigencia</th><th>Costo / unidad</th><th>Estado</th><th>Fuente</th></tr></thead><tbody>
              {visibleQuotes.map((quote) => <tr key={quote.id}><th scope="row">{productName(data?.products || [], quote.productId)}</th><td>{dateLabel(quote.quotedOn)}</td><td>{quote.validUntil ? dateLabel(quote.validUntil) : "Sin fecha informada"}</td><td>{centsLabel(quote.unitCostCentsPerUnit)}</td><td><span className={`di-status ${statusClass(quote.status)}`}>{statusName(quote.status)}</span></td><td>{sourceText(quote.sourceReference)}</td></tr>)}
              {!visibleQuotes.length && <tr><td colSpan={6} className="di-empty-cell">Sin cotizaciones que coincidan con los filtros.</td></tr>}
            </tbody></table></div>
            <form className="di-form di-form--topline" onSubmit={(event) => void saveForm(event, "/decision-inputs/quotes", "quotes", "Cotización", (form) => {
              reviewed(form, "Confirmá que revisaste la fecha, el costo y la referencia de la cotización.");
              const quotedOn = dateValue(form, "quotedOn", "Fecha de cotización");
              const validUntil = optionalValue(form, "validUntil");
              if (validUntil && (!isCalendarDate(validUntil) || validUntil < quotedOn)) throw new Error("La vigencia debe ser una fecha válida igual o posterior a la cotización.");
              return {
                productId: textValue(form, "productId", "Producto"),
                quotedOn,
                validUntil,
                unitCostCentsPerUnit: centsValue(form, "unitCostCentsPerUnit", "Costo por unidad"),
                sourceReference: referenceValue(form, "sourceReference", "Fuente de la cotización"),
              };
            })}>
              <div className="di-form-grid">
                <Field label="Producto" name="di-quote-product"><select id="di-quote-product" name="productId" required defaultValue=""><option value="" disabled>Elegir producto</option>{(data?.products || []).map((item) => <option key={item.id} value={item.id}>{item.name}{item.lot ? ` · ${item.lot}` : ""}</option>)}</select></Field>
                <Field label="Cotizada el" name="di-quote-date"><input id="di-quote-date" name="quotedOn" type="date" required /></Field>
                <Field label="Válida hasta (opcional)" name="di-quote-valid"><input id="di-quote-valid" name="validUntil" type="date" /></Field>
                <Field label="Costo por unidad · centavos" name="di-quote-cost" hint="Cadena de dígitos enteros; por ejemplo, 125050 = $1.250,50."><input id="di-quote-cost" name="unitCostCentsPerUnit" type="text" inputMode="numeric" pattern="(?:0|[1-9][0-9]*)" required /></Field>
                <Field label="Fuente" name="di-quote-source"><input id="di-quote-source" name="sourceReference" type="text" required placeholder="Proveedor, presupuesto, fecha…" /></Field>
              </div>
              <ReviewConsent id="di-review-quote">Revisé la cotización y su fuente antes de registrarla.</ReviewConsent>
              <button className="di-button di-button--primary" type="submit" disabled={Boolean(saving) || !data?.products.length}>{saving === "quotes" ? "Guardando…" : "Guardar cotización"}</button>
            </form>
          </article>

          <article className="di-card">
            <h3>Entregas previstas</h3>
            <div className="di-table-scroll"><table><thead><tr><th>Producto</th><th>Ubicación</th><th>Cantidad</th><th>Llegada</th><th>Estado</th><th>Fuente</th></tr></thead><tbody>
              {visibleInbounds.map((inbound) => {
                const product = data?.products.find((item) => item.id === inbound.productId);
                return <tr key={inbound.id}><th scope="row">{productName(data?.products || [], inbound.productId)}</th><td>{locationName(data?.locations || [], inbound.locationId)}</td><td>{quantityLabel(inbound.quantityMilliunits, product?.unit)}</td><td>{dateLabel(inbound.arrivalDate)}</td><td><span className={`di-status ${statusClass(inbound.status)}`}>{statusName(inbound.status)}</span></td><td>{sourceText(inbound.sourceReference)}</td></tr>;
              })}
              {!visibleInbounds.length && <tr><td colSpan={6} className="di-empty-cell">Sin entregas que coincidan con los filtros.</td></tr>}
            </tbody></table></div>
            <form className="di-form di-form--topline" onSubmit={(event) => void saveForm(event, "/decision-inputs/inbounds", "inbounds", "Entrega prevista", (form) => {
              reviewed(form, "Confirmá que revisaste la cantidad, la fecha y el comprobante de entrega.");
              return {
                productId: textValue(form, "productId", "Producto"),
                locationId: optionalValue(form, "locationId"),
                quantityMilliunits: integerValue(form, "quantityMilliunits", "Cantidad en milésimas", { minimum: 1 }),
                arrivalDate: dateValue(form, "arrivalDate", "Fecha de llegada"),
                sourceReference: referenceValue(form, "sourceReference", "Fuente de la entrega"),
              };
            })}>
              <div className="di-form-grid">
                <Field label="Producto" name="di-inbound-product"><select id="di-inbound-product" name="productId" required defaultValue=""><option value="" disabled>Elegir producto</option>{(data?.products || []).map((item) => <option key={item.id} value={item.id}>{item.name}{item.lot ? ` · ${item.lot}` : ""}</option>)}</select></Field>
                <Field label="Ubicación (opcional)" name="di-inbound-location"><select id="di-inbound-location" name="locationId" defaultValue=""><option value="">Sin ubicación informada</option>{(data?.locations || []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
                <Field label="Cantidad (milésimas)" name="di-inbound-quantity" hint="Usá un entero: 1250 = 1,250 unidades."><input id="di-inbound-quantity" name="quantityMilliunits" type="number" min="1" max="2147483647" step="1" required /></Field>
                <Field label="Fecha de llegada" name="di-inbound-date"><input id="di-inbound-date" name="arrivalDate" type="date" required /></Field>
                <Field label="Fuente o comprobante" name="di-inbound-source"><input id="di-inbound-source" name="sourceReference" type="text" required placeholder="Pedido, remito, mensaje del proveedor…" /></Field>
              </div>
              <ReviewConsent id="di-review-inbound">Revisé la fecha, cantidad y referencia de esta entrega prevista.</ReviewConsent>
              <button className="di-button di-button--primary" type="submit" disabled={Boolean(saving) || !data?.products.length}>{saving === "inbounds" ? "Guardando…" : "Guardar entrega prevista"}</button>
            </form>
          </article>
        </div>
      </section>
      }

      {view === "cash" &&
      <section className="di-section" aria-labelledby="di-cash-title">
        <SectionHeading id="di-cash-title" eyebrow="03 · CAJA Y OBLIGACIONES" title="Completar saldos, fuentes y escenarios">
          No se genera un saldo confiable si falta una apertura conciliada, una fuente trazable o la cobertura completa de obligaciones.
        </SectionHeading>
        <div className="di-cash-rule" role="note"><strong>Regla de caja:</strong> para generar saldo, el servidor exige un snapshot conciliado de la misma fecha de apertura y obligaciones completas. Podés guardar una atestación de caja antes de tener ese snapshot; guardarla no genera un saldo.</div>
        <div className="di-content-grid">
          <article className="di-card">
            <h3>Saldos por cuenta</h3>
            <div className="di-table-scroll"><table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Saldo</th><th>Piso mínimo</th><th>Declaración</th><th>Fuente</th></tr></thead><tbody>
              {(visibleSnapshots.length ? visibleSnapshots : []).flatMap((snapshot) => snapshot.accounts.map((account, index) => <tr key={`${snapshot.id}-${index}`}><th scope="row">{dateLabel(snapshot.asOf)}</th><td>{accountName(account.account)}</td><td>{centsLabel(account.amountCents)}</td><td>{index === 0 ? centsLabel(snapshot.floorCents) : "—"}</td><td><span className={`di-status ${snapshot.complete ? "di-status--pending" : "di-status--muted"}`}>{snapshot.complete ? "Declarado completo" : "Incompleto"}</span></td><td>{sourceText(snapshot.sourceReference)}</td></tr>))}
              {!visibleSnapshots.some((snapshot) => snapshot.accounts.length) && <tr><td colSpan={6} className="di-empty-cell">Sin saldos por cuenta para estos filtros.</td></tr>}
            </tbody></table></div>
            <form className="di-form di-form--topline" onSubmit={(event) => void saveForm(event, "/decision-inputs/cash-snapshots", "cash-snapshots", "Snapshot de caja", (form) => {
              reviewed(form, "Confirmá que revisaste la fecha, las cuentas, los saldos y la fuente.");
              const accountNames = form.getAll("account").map(String);
              const amounts = accountNames.map((_, index) => centsValue(form, `amountCents-${index}`, `Saldo de cuenta ${index + 1}`, { signed: true }));
              if (!accountNames.length || accountNames.length !== amounts.length) throw new Error("Agregá al menos una cuenta y su saldo en centavos.");
              if (new Set(accountNames.map((account) => account.toLowerCase())).size !== accountNames.length) throw new Error("Cada cuenta puede aparecer una sola vez en el snapshot.");
              const totalCents = amounts.reduce((sum, amount) => sum + BigInt(amount), 0n);
              if (totalCents < -(2n ** 63n) || totalCents > 2n ** 63n - 1n)
                throw new Error("El saldo total excede el rango de 64 bits.");
              return {
                asOf: (() => { const value = dateValue(form, "asOf", "Fecha del saldo"); if (value > today()) throw new Error("El saldo conciliado no puede tener fecha futura."); return value; })(),
                floorCents: centsValue(form, "floorCents", "Piso mínimo"),
                sourceReference: referenceValue(form, "sourceReference", "Fuente del saldo"),
                complete: form.get("complete") === "on",
                accounts: accountNames.map((account, index) => ({ account, amountCents: amounts[index] })),
              };
            }, () => { setAccountRows([{ id: Date.now(), account: "cash" }]); })}>
              <div className="di-form-grid">
                <Field label="Fecha de corte" name="di-cash-asof"><input id="di-cash-asof" name="asOf" type="date" max={today()} required defaultValue={today()} /></Field>
                <Field label="Piso mínimo · centavos" name="di-cash-floor" hint="Entero sin separadores, por ejemplo 5000000 = $50.000,00."><input id="di-cash-floor" name="floorCents" type="text" inputMode="numeric" pattern="(?:0|[1-9][0-9]*)" required /></Field>
                <Field label="Fuente de conciliación" name="di-cash-source"><input id="di-cash-source" name="sourceReference" type="text" required placeholder="Extracto y corte revisado…" /></Field>
              </div>
              <div className="di-account-editor">
                <div className="di-subheading"><strong>Cuentas incluidas</strong><button className="di-text-button" type="button" onClick={() => { setAccountRows((rows) => [...rows, { id: nextAccountRow, account: rows.some((row) => row.account === "cash") ? "bank" : "cash" }]); setNextAccountRow((value) => value + 1); }} disabled={Boolean(saving) || accountRows.length >= 2}><Plus size={15} /> Agregar cuenta</button></div>
                {accountRows.map((row, index) => <div className="di-account-row" key={row.id}>
                  <Field label={`Cuenta ${index + 1}`} name={`di-cash-account-${row.id}`}><select id={`di-cash-account-${row.id}`} name="account" value={row.account} onChange={(event) => setAccountRows((rows) => rows.map((item) => item.id === row.id ? { ...item, account: event.target.value as Account } : item))}><option value="cash" disabled={accountRows.some((item) => item.id !== row.id && item.account === "cash")}>Efectivo</option><option value="bank" disabled={accountRows.some((item) => item.id !== row.id && item.account === "bank")}>Banco</option></select></Field>
                  <Field label="Saldo · centavos" name={`di-cash-amount-${row.id}`} hint="Cadena de enteros; puede ser negativo si la cuenta está en descubierto."><input id={`di-cash-amount-${row.id}`} name={`amountCents-${index}`} type="text" inputMode="text" pattern="-?(?:0|[1-9][0-9]*)" required /></Field>
                  <button className="di-icon-button" type="button" aria-label={`Quitar cuenta ${index + 1}`} disabled={accountRows.length < 2 || Boolean(saving)} onClick={() => setAccountRows((rows) => rows.filter((item) => item.id !== row.id))}><X size={17} /></button>
                </div>)}
              </div>
              <label className="di-review"><input name="complete" type="checkbox" /><span>Declaro completos los saldos de todas las cuentas incluidas en esta fuente.</span></label>
              <ReviewConsent id="di-review-cash-snapshot">Revisé el corte, el piso mínimo y la fuente; entiendo que el servidor valida la conciliación.</ReviewConsent>
              <button className="di-button di-button--primary" type="submit" disabled={Boolean(saving) || !data}>{saving === "cash-snapshots" ? "Guardando…" : "Guardar snapshot"}</button>
            </form>
          </article>

          <article className="di-card">
            <div className="di-subheading"><div><h3>Obligaciones por escenario</h3><p className="di-muted">{activePlanCount} partidas activas entre todos los escenarios; las canceladas quedan fuera del motor.</p></div><Field label="Escenario" name="di-cash-scenario"><select id="di-cash-scenario" value={cashScenario} onChange={(event) => setCashScenario(event.target.value as Scenario)}>{scenarios.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field></div>
            <div className="di-table-scroll"><table><thead><tr><th>Fecha</th><th>Cuenta</th><th>Categoría</th><th>Importe</th><th>Estado</th><th>Fuente</th></tr></thead><tbody>
              {visiblePlans.map((plan) => <tr key={plan.id}><th scope="row">{dateLabel(plan.date)}</th><td>{accountName(plan.account)}</td><td>{cashCategories.find(([key]) => key === plan.category)?.[1] || plan.category}</td><td>{centsLabel(plan.amountCents)}</td><td><span className={`di-status ${statusClass(plan.status)}`}>{statusName(plan.status)}</span></td><td>{sourceText(plan.sourceReference)}</td></tr>)}
              {!visiblePlans.length && <tr><td colSpan={6} className="di-empty-cell">Sin partidas activas o canceladas para este escenario y filtros.</td></tr>}
            </tbody></table></div>
            <p className="di-muted">Las partidas canceladas permanecen visibles con su estado, pero el motor usa únicamente partidas activas.</p>
            <form className="di-form di-form--topline" onSubmit={(event) => void saveForm(event, "/decision-inputs/cash-plans", "cash-plans", "Partida de caja", (form) => {
              reviewed(form, "Confirmá que revisaste el escenario, la obligación y su fuente.");
              const amountCents = centsValue(form, "amountCents", "Importe", { signed: true, nonZero: true });
              const category = textValue(form, "category", "Categoría");
              if (!cashCategories.some(([key]) => key === category)) throw new Error("Elegí una categoría disponible.");
              const scenario = textValue(form, "scenario", "Escenario");
              if (scenario !== "low" && scenario !== "base" && scenario !== "high") throw new Error("Elegí un escenario válido.");
              const account = textValue(form, "account", "Cuenta");
              if (account !== "cash" && account !== "bank") throw new Error("Elegí efectivo o banco.");
              const planDate = dateValue(form, "date", "Fecha");
              if (planDate <= today()) throw new Error("La partida planificada debe tener una fecha futura.");
              const positiveCategories = ["sale", "capital_contribution", "delivery_receipt", "other_income"];
              const negativeCategories = ["operating_expense", "stock_purchase", "local_investment", "owner_draw", "other_outflow"];
              const value = BigInt(amountCents);
              if ((positiveCategories.includes(category) && value < 0n) || (negativeCategories.includes(category) && value > 0n))
                throw new Error("El signo del importe no coincide con la categoría de cobro o pago.");
              return {
                scenario,
                date: planDate,
                account,
                category,
                amountCents,
                sourceReference: referenceValue(form, "sourceReference", "Fuente de la obligación"),
              };
            })}>
              <div className="di-form-grid">
                <Field label="Escenario" name="di-plan-scenario"><select id="di-plan-scenario" name="scenario" defaultValue={cashScenario}>{scenarios.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
                <Field label="Fecha" name="di-plan-date"><input id="di-plan-date" name="date" type="date" min={tomorrow()} required /></Field>
                <Field label="Cuenta" name="di-plan-account"><select id="di-plan-account" name="account"><option value="cash">Efectivo</option><option value="bank">Banco</option></select></Field>
                <Field label="Categoría" name="di-plan-category"><select id="di-plan-category" name="category">{cashCategories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
                <Field label="Importe · centavos" name="di-plan-amount" hint="Positivo: entrada. Negativo: salida. Ejemplo: -125050 = -$1.250,50."><input id="di-plan-amount" name="amountCents" type="text" inputMode="text" pattern="-?(?:0|[1-9][0-9]*)" required /></Field>
                <Field label="Fuente descriptiva" name="di-plan-source"><input id="di-plan-source" name="sourceReference" type="text" required placeholder="Planilla, acuerdo o comprobante…" /></Field>
              </div>
              <ReviewConsent id="di-review-cash-plan">Revisé el importe, el escenario, la fecha y la referencia.</ReviewConsent>
              <button className="di-button di-button--primary" type="submit" disabled={Boolean(saving)}>{saving === "cash-plans" ? "Guardando…" : "Guardar obligación"}</button>
            </form>
          </article>
        </div>

        <article className="di-card di-card--attestations">
          <div className="di-subheading"><div><h3>Cobertura de fuentes</h3><p className="di-muted">La atestación registra un período y una declaración de cobertura; no completa ni concilia datos por sí sola.</p></div></div>
          <div className="di-table-scroll"><table><thead><tr><th>Dominio</th><th>Escenario</th><th>Período</th><th>Declaración</th><th>Fuente exigida</th></tr></thead><tbody>
            {visibleAttestations.map((item) => <tr key={item.id}><th scope="row">{item.domain === "delivery_sales" ? "Ventas de delivery" : "Plan de caja"}</th><td>{item.scenario ? scenarioName(item.scenario) : "—"}</td><td>{dateLabel(item.fromDate)} – {dateLabel(item.throughDate)}</td><td><span className={`di-status ${item.complete ? "di-status--pending" : "di-status--muted"}`}>{item.complete ? "Declarado completo" : "Parcial / incompleto"}</span></td><td><code>{sourceText(item.sourceReference)}</code></td></tr>)}
            {!visibleAttestations.length && <tr><td colSpan={5} className="di-empty-cell">Sin atestaciones para estos filtros.</td></tr>}
          </tbody></table></div>
          <form className="di-form di-form--topline" onSubmit={(event) => void saveForm(event, "/decision-inputs/attestations", "attestations", "Atestación", (form) => {
            reviewed(form, "Confirmá que revisaste el período, la cobertura y la fuente.");
            const domain = textValue(form, "domain", "Dominio");
            if (domain !== "delivery_sales" && domain !== "cash_plan") throw new Error("Elegí ventas de delivery o plan de caja.");
            const fromDate = dateValue(form, "fromDate", "Desde");
            const throughDate = dateValue(form, "throughDate", "Hasta");
            if (fromDate > throughDate) throw new Error("La fecha Desde debe ser anterior o igual a Hasta.");
            if ((Date.parse(`${throughDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000 > 730)
              throw new Error("El período de cobertura no puede superar dos años.");
            if (domain === "cash_plan" && fromDate <= today()) throw new Error("El plan de caja certificado debe empezar después de hoy.");
            if (domain === "delivery_sales" && throughDate > today()) throw new Error("No se puede certificar historia futura.");
            const sourceReference = referenceValue(form, "sourceReference", "Referencia de la fuente");
            if (domain === "delivery_sales" && !/^batch:[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(sourceReference))
              throw new Error("Para ventas de delivery, usá batch:<id UUID> de un lote conciliado. Al marcar completa, el servidor valida el lote y su rango.");
            const scenario = domain === "cash_plan" ? textValue(form, "scenario", "Escenario") : null;
            if (scenario !== null && scenario !== "low" && scenario !== "base" && scenario !== "high") throw new Error("Elegí un escenario válido para el plan de caja.");
            return { domain, scenario, fromDate, throughDate, complete: form.get("complete") === "on", sourceReference };
          })}>
            <div className="di-form-grid">
              <Field label="Dominio" name="di-attestation-domain"><select id="di-attestation-domain" name="domain" value={attestationDomain} onChange={(event) => setAttestationDomain(event.target.value as AttestationDomain)}><option value="delivery_sales">Ventas de delivery</option><option value="cash_plan">Plan de caja</option></select></Field>
              {attestationDomain === "cash_plan" && <Field label="Escenario" name="di-attestation-scenario"><select id="di-attestation-scenario" name="scenario" defaultValue="base">{scenarios.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>}
              <Field label="Desde" name="di-attestation-from"><input id="di-attestation-from" name="fromDate" type="date" min={attestationDomain === "cash_plan" ? tomorrow() : undefined} required /></Field>
              <Field label="Hasta" name="di-attestation-through"><input id="di-attestation-through" name="throughDate" type="date" max={attestationDomain === "delivery_sales" ? today() : undefined} required /></Field>
              <Field label={attestationDomain === "delivery_sales" ? "Lote conciliado · batch:<id>" : "Referencia descriptiva"} name="di-attestation-source" hint={attestationDomain === "delivery_sales" ? "La referencia debe identificar un lote delivery_sales conciliado. Si declarás cobertura completa, el servidor valida el lote y el período." : "Podés guardar esta atestación antes del snapshot; por sí sola no genera saldo."}>
                <input id="di-attestation-source" name="sourceReference" type="text" required placeholder={attestationDomain === "delivery_sales" ? "batch:ID-del-lote" : "Planilla de pagos y cobros · corte…"} />
              </Field>
            </div>
            <label className="di-review"><input name="complete" type="checkbox" /><span>Declaro completa la cobertura de esta fuente durante todo el período.</span></label>
            <ReviewConsent id="di-review-attestation">Revisé las fechas, la cobertura y la referencia de esta fuente.</ReviewConsent>
            <button className="di-button di-button--primary" type="submit" disabled={Boolean(saving)}>{saving === "attestations" ? "Guardando…" : "Guardar atestación"}</button>
          </form>
        </article>
      </section>
      }

      {data && !recordsEmpty && <p className="di-footer-note">Las cotizaciones y partidas canceladas se conservan en el historial y no participan del motor. Los estados se muestran tal como los devuelve el servidor.</p>}
      {saving && <p className="di-saving-note" role="status">Guardando {saving.replaceAll("-", " ")}…</p>}
    </main>
  );
}
