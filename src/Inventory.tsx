import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
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
  Truck,
  Star,
  MapPin,
  CaretDown,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  useClub,
  send,
  useResource,
  number,
  money as formatMoney,
  shortDate,
  type Product,
  type Supplier,
  type Location,
} from "./lib";
import type { Movement, Page } from "../shared/types";
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
import "./operation.css";

type CatalogProduct = Pick<Product, "name" | "strain" | "type" | "unit">;
type ProductCatalog = { products: CatalogProduct[]; profiles: string[]; nextCursor: string | null; cursor: string | null };

function ProductIdentityFields({ edit }: { edit: Product | null }) {
  const pickerId = useId();
  const pickerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(edit?.name || "");
  const [profile, setProfile] = useState(edit?.strain || "");
  const [type, setType] = useState(edit?.type || "Flor");
  const [unit, setUnit] = useState(edit?.unit || "g");
  const [profileEdited, setProfileEdited] = useState(false);
  const [typeEdited, setTypeEdited] = useState(false);
  const [lookup, setLookup] = useState(name);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [browseAll, setBrowseAll] = useState(false);
  const [browseCursor, setBrowseCursor] = useState("");
  const [browseItems, setBrowseItems] = useState<CatalogProduct[]>([]);
  const [browseNext, setBrowseNext] = useState<string | null>(null);
  const [activeOption, setActiveOption] = useState(-1);
  useEffect(() => {
    const id = window.setTimeout(() => setLookup(name.trim()), 180);
    return () => window.clearTimeout(id);
  }, [name]);
  const catalog = useResource<ProductCatalog>(`/product-catalog?q=${encodeURIComponent(lookup)}`);
  const fullCatalog = useResource<ProductCatalog>(browseAll
    ? `/product-catalog?all=1&cursor=${encodeURIComponent(browseCursor)}` : null);
  useEffect(() => {
    if (!browseAll || !fullCatalog.data || fullCatalog.data.cursor !== browseCursor) return;
    const page = fullCatalog.data;
    setBrowseItems((current) => {
      if (!browseCursor) return page.products;
      const known = new Set(current.map((product) => product.name.toLocaleLowerCase()));
      return [...current, ...page.products.filter((product) => !known.has(product.name.toLocaleLowerCase()))];
    });
    setBrowseNext(page.nextCursor);
  }, [browseAll, browseCursor, fullCatalog.data]);
  useEffect(() => {
    if (pickerOpen && activeOption >= 0) {
      document.getElementById(`${pickerId}-option-${activeOption}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeOption, pickerId, pickerOpen]);
  useEffect(() => {
    if (edit || lookup !== name.trim()) return;
    const known = catalog.data?.products.find((p) => p.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
    if (!profileEdited) setProfile(known?.strain || (/\bcbd\b/i.test(name) ? "CBD" : ""));
    if (!typeEdited) {
      if (known) { setType(known.type); setUnit(known.unit); }
      else if (/\baceite\b/i.test(name)) { setType("Aceite"); setUnit("ud"); }
      else { setType("Flor"); setUnit("g"); }
    }
  }, [catalog.data, edit, lookup, name, profileEdited, typeEdited]);
  const selectProduct = (product: CatalogProduct) => {
    setName(product.name);
    setProfile(product.strain);
    setType(product.type);
    setUnit(product.unit);
    setProfileEdited(true);
    setTypeEdited(true);
    setPickerOpen(false);
    setBrowseAll(false);
    setActiveOption(-1);
  };
  const products = browseAll ? browseItems : lookup === name.trim() ? catalog.data?.products || [] : [];
  const pickerBusy = browseAll ? fullCatalog.loading && !browseItems.length : catalog.loading || lookup !== name.trim();
  const startBrowse = () => {
    if (pickerOpen && browseAll) { setPickerOpen(false); setBrowseAll(false); return; }
    setBrowseCursor("");
    setBrowseItems([]);
    setBrowseNext(null);
    setActiveOption(-1);
    setBrowseAll(true);
    setPickerOpen(true);
    inputRef.current?.focus();
  };
  const onProductKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && pickerOpen) {
      event.preventDefault();
      setPickerOpen(false);
      setBrowseAll(false);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setPickerOpen(true);
      setActiveOption((current) => products.length
        ? event.key === "ArrowDown" ? Math.min(current + 1, products.length - 1) : current < 0 ? products.length - 1 : Math.max(current - 1, 0)
        : -1);
    } else if (event.key === "Enter" && pickerOpen) {
      event.preventDefault();
      if (activeOption >= 0 && products[activeOption]) selectProduct(products[activeOption]);
    }
  };
  return (
    <>
      <div className="field product-picker" ref={pickerRef} onBlur={(event) => {
        if (!pickerRef.current?.contains(event.relatedTarget)) { setPickerOpen(false); setBrowseAll(false); }
      }}>
        <label htmlFor={`${pickerId}-input`}>Nombre del producto</label>
        <div className="product-picker-shell"><div className="product-picker-control">
          <input id={`${pickerId}-input`} ref={inputRef} name="name" value={name}
            role="combobox" aria-autocomplete="list" aria-expanded={pickerOpen}
            aria-controls={`${pickerId}-options`}
            aria-activedescendant={pickerOpen && activeOption >= 0 ? `${pickerId}-option-${activeOption}` : undefined}
            onFocus={() => setPickerOpen(true)}
            onChange={(e) => { setName(e.target.value); setProfileEdited(false); setTypeEdited(false); setBrowseAll(false); setPickerOpen(true); setActiveOption(-1); }}
            onKeyDown={onProductKeyDown} placeholder="Buscá o escribí un producto" autoComplete="off" maxLength={180} required />
          <button type="button" className="product-picker-toggle" aria-label={pickerOpen && browseAll ? "Cerrar productos guardados" : "Ver todos los productos guardados"}
            aria-expanded={pickerOpen && browseAll} onClick={startBrowse}><CaretDown size={16} weight="bold" /></button>
        </div>
        {pickerOpen && <div id={`${pickerId}-options`} className="product-picker-options" role="listbox" aria-label="Productos guardados">
          <div className="product-picker-heading">{browseAll ? "Todos los productos" : name.trim() ? "Coincidencias guardadas" : "Productos recientes"}</div>
          {products.map((product, index) => <button key={`${product.name}-${product.type}`} id={`${pickerId}-option-${index}`}
            type="button" role="option" aria-selected={activeOption === index}
            className={activeOption === index ? "is-active" : ""}
            onMouseEnter={() => setActiveOption(index)} onClick={() => selectProduct(product)}>
            <strong>{product.name}</strong><span>{[product.type, product.strain].filter(Boolean).join(" · ")}</span>
          </button>)}
          {pickerBusy && <p role="status">Buscando productos…</p>}
          {!pickerBusy && !products.length && <p>{catalog.error || fullCatalog.error || (browseAll ? "Todavía no hay productos guardados." : name.trim() ? "Sin coincidencias. Podés guardar este nombre nuevo." : "Todavía no hay productos guardados.")}</p>}
          {browseAll && browseNext && <button type="button" className="product-picker-more" disabled={fullCatalog.loading}
            onClick={() => { setBrowseCursor(browseNext); setActiveOption(-1); }}>
            {fullCatalog.loading ? "Cargando más…" : "Mostrar más productos"}
          </button>}
        </div>}
        </div>
        <small>Escribí para buscar; elegí uno guardado o usá un nombre nuevo.</small>
      </div>
      <Field label="Perfil (opcional)" hint="Ej.: Sativa, Índica, Híbrida o CBD. No repitas el nombre; dejalo vacío si no aplica.">
        <input name="strain" value={profile} onChange={(e) => { setProfile(e.target.value); setProfileEdited(true); }} maxLength={180} placeholder="Sativa, CBD…" autoComplete="off" />
        {!!catalog.data?.profiles.length && <div className="profile-suggestions" aria-label="Perfiles guardados">
          {catalog.data.profiles.slice(0, 5).map((saved) =>
            <button key={saved} type="button" className={profile === saved ? "selected" : ""} aria-pressed={profile === saved} onClick={() => { setProfile(saved); setProfileEdited(true); }}>{saved}</button>)}
        </div>}
      </Field>
      <Field label="Tipo">
        <select name="type" value={type} onChange={(e) => { setType(e.target.value); setTypeEdited(true); if (!edit) setUnit(["Aceite", "Accesorio"].includes(e.target.value) ? "ud" : "g"); }}>
          {["Flor", "Extracto", "Aceite", "Accesorio"].map((t) => <option key={t}>{t}</option>)}
        </select>
      </Field>
      <Field label="Unidad">
        <select name="unit" value={unit} onChange={(e) => { setUnit(e.target.value); setTypeEdited(true); }}>
          <option value="g">Gramos</option>
          <option value="ud">Unidades</option>
        </select>
      </Field>
    </>
  );
}

function PriceFields({ edit }: { edit: Product | null }) {
  const id = useId();
  const [cost, setCost] = useState(edit ? String(edit.cost / 100) : "");
  const [price, setPrice] = useState(edit ? String(edit.price / 100) : "");
  const cents = (value: string) => value && Number.isFinite(Number(value))
    ? Math.round(Number(value) * 100) : null;
  const costCents = cents(cost);
  const priceCents = cents(price);
  const preventExponent = (event: KeyboardEvent<HTMLInputElement>) => {
    if (["e", "E", "+", "-"].includes(event.key)) event.preventDefault();
  };
  const warning = costCents !== null && priceCents !== null && priceCents > 0 && costCents > 0
    ? priceCents < costCents
      ? `Revisá los importes: la venta queda ${formatMoney(costCents - priceCents)} por debajo del costo.`
      : priceCents >= costCents * 10
        ? "Revisá los importes: la venta supera diez veces el costo."
        : ""
    : "";
  return (
    <fieldset className="price-section">
      <legend>Precios</legend>
      <p>Importes en ARS por g o unidad. Sin separador de miles; usá punto para centavos.</p>
      <div className="price-pair">
        <div className="field">
          <label htmlFor={`${id}-cost`}>Precio de costo</label>
          <div className="price-input-shell">
            <span aria-hidden="true">$</span>
            <input id={`${id}-cost`} name="cost" type="number" inputMode="decimal"
              min="0" max="10000000" step="0.01" value={cost}
              onChange={(e) => { if (!/[eE+-]/.test(e.target.value)) setCost(e.target.value); }}
              onFocus={(e) => e.currentTarget.select()} onKeyDown={preventExponent}
              onWheel={(e) => e.currentTarget.blur()} placeholder="0.00" required />
          </div>
          <small>{costCents === null ? "Ingresá el costo" : `Vas a guardar ${formatMoney(costCents)}`}</small>
        </div>
        <div className="field">
          <label htmlFor={`${id}-price`}>Precio de venta</label>
          <div className="price-input-shell">
            <span aria-hidden="true">$</span>
            <input id={`${id}-price`} name="price" type="number" inputMode="decimal"
              min="0.01" max="10000000" step="0.01" value={price}
              onChange={(e) => { if (!/[eE+-]/.test(e.target.value)) setPrice(e.target.value); }}
              onFocus={(e) => e.currentTarget.select()} onKeyDown={preventExponent}
              onWheel={(e) => e.currentTarget.blur()} placeholder="0.00" required />
          </div>
          <small>{priceCents === null ? "Ingresá el precio de venta" : `Vas a guardar ${formatMoney(priceCents)}`}</small>
        </div>
      </div>
      {warning && <p className="price-warning" role="status">{warning}</p>}
      {edit && <p className="price-previous">Valores anteriores: costo {formatMoney(edit.cost)} · venta {formatMoney(edit.price)}</p>}
    </fieldset>
  );
}

export default function Inventory() {
  const { state, money, canManage, isManager, reload, user, owner } = useClub();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") || "");
  const [filter, setFilter] = useState(params.get("filter") === "low" ? "low" : "all");
  const [view, setView] = useState<"cards" | "table">("table");
  const [type, setType] = useState(params.get("type") || "all");
  const [supplierFilter, setSupplierFilter] = useState(params.get("supplier") || "all");
  const [showSuppliers, setShowSuppliers] = useState(false);
  const [supplierEditor, setSupplierEditor] = useState<Supplier | "new" | null>(null);
  const [lotSupplierId, setLotSupplierId] = useState("");
  const [showLocations, setShowLocations] = useState(false);
  const [locationEditor, setLocationEditor] = useState<Location | "new" | null>(null);
  const [lotLocationId, setLotLocationId] = useState("");
  const [locationTouched, setLocationTouched] = useState(false);
  const [quickLocation, setQuickLocation] = useState(false);
  const [quickLocationName, setQuickLocationName] = useState("");
  const [savingQuickLocation, setSavingQuickLocation] = useState(false);
  const [editor, setEditor] = useState<Product | "new" | null>(null);
  const [movement, setMovement] = useState<Product | null>(null);
  const [history, setHistory] = useState(false);
  const [moveType, setMoveType] = useState("entry");
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyPrevious, setHistoryPrevious] = useState<(string | null)[]>([]);
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  useEffect(() => { const id = window.setTimeout(() => setDebouncedQuery(query), 250); return () => clearTimeout(id); }, [query]);
  useEffect(() => {
    setQuery(params.get("q") || "");
    setFilter(params.get("filter") === "low" ? "low" : params.get("filter") === "expired" ? "expired" : "all");
    setType(params.get("type") || "all");
    setSupplierFilter(params.get("supplier") || "all");
  }, [params]);
  const updateParams = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  useEffect(() => { setCursor(null); setPrevious([]); }, [debouncedQuery, filter, type, supplierFilter, owner]);
  useEffect(() => { setHistoryCursor(null); setHistoryPrevious([]); }, [owner, history]);
  const page = useResource<Page<Product, { total: number; low: number; value: number }>>(
    `/list/products?q=${encodeURIComponent(debouncedQuery)}&filter=${filter}&type=${encodeURIComponent(type)}&supplier=${encodeURIComponent(supplierFilter)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}`,
  );
  const suppliers = useResource<{ items: Supplier[]; total: number }>(canManage ? "/suppliers" : null);
  const locations = useResource<{ items: Location[]; total: number }>(canManage ? "/locations" : null);
  useEffect(() => {
    if (editor) setLotSupplierId(editor === "new"
      ? suppliers.data?.items.find((s) => s.active && s.isDefault)?.id || ""
      : editor.supplierId || "");
  }, [editor, suppliers.data]);
  useEffect(() => { setLocationTouched(false); setLotLocationId(""); setQuickLocation(false); setQuickLocationName(""); }, [editor]);
  useEffect(() => {
    if (!editor || locationTouched || !locations.data) return;
    setLotLocationId(editor === "new"
      ? locations.data.items.find((l) => l.active && l.isDefault)?.id || ""
      : editor.locationId || locations.data.items.find((l) => l.name === editor.location)?.id || "");
  }, [editor, locationTouched, locations.data]);
  const historyData = useResource<Page<Movement>>(
    history
      ? `/movements?${new URLSearchParams({ ...(historyCursor ? { cursor: historyCursor } : {}), ...(owner ? { owner } : {}) })}`
      : null,
  );
  const products = page.data?.items || [];
  const hasFilters = !!query || filter !== "all" || type !== "all" || supplierFilter !== "all";
  const clearFilters = () => {
    setQuery("");
    setFilter("all");
    setType("all");
    setSupplierFilter("all");
    const next = new URLSearchParams(params);
    ["q", "filter", "type", "supplier"].forEach((key) => next.delete(key));
    setParams(next, { replace: true });
  };
  const handleViewTabsKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const nextView = event.key === "Home"
      ? "cards"
      : event.key === "End"
        ? "table"
        : event.key === "ArrowRight"
          ? (view === "cards" ? "table" : "cards")
          : event.key === "ArrowLeft"
            ? (view === "table" ? "cards" : "table")
            : null;
    if (!nextView) return;
    event.preventDefault();
    setView(nextView);
    document.getElementById(`inventory-tab-${nextView}`)?.focus();
  };
  async function save(fd: FormData) {
    const existing = editor !== "new" ? editor : null;
    const data = {
      ...Object.fromEntries(fd),
      ...(existing ? {} : { ownerId: user.id }),
      supplier: "",
      supplierId: lotSupplierId || null,
      locationId: lotLocationId || null,
      location: locations.data?.items.find((l) => l.id === lotLocationId)?.name || existing?.location || "",
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
    await Promise.all([reload(), page.reload(), suppliers.reload(), locations.reload()]);
  }
  async function saveSupplier(fd: FormData) {
    const existing = supplierEditor !== "new" ? supplierEditor : null;
    await send(
      existing ? `/suppliers/${existing.id}` : "/suppliers",
      { name: fd.get("name"), contactName: fd.get("contactName"), phone: fd.get("phone"), email: fd.get("email"), notes: fd.get("notes"), isDefault: fd.get("isDefault") === "on" },
      existing ? "PATCH" : "POST",
    );
    toast.success(existing ? "Proveedor actualizado" : "Proveedor guardado");
    setSupplierEditor(null);
    await suppliers.reload();
  }
  async function toggleSupplier(supplier: Supplier) {
    await send(`/suppliers/${supplier.id}/status`, { active: !supplier.active }, "PATCH");
    toast.success(supplier.active ? "Proveedor archivado" : "Proveedor activado");
    await suppliers.reload();
  }
  async function saveLocation(fd: FormData) {
    const existing = locationEditor !== "new" ? locationEditor : null;
    await send(existing ? `/locations/${existing.id}` : "/locations",
      { name: fd.get("name"), isDefault: fd.get("isDefault") === "on" }, existing ? "PATCH" : "POST");
    toast.success(existing ? "Ubicación actualizada" : "Ubicación guardada");
    setLocationEditor(null);
    await Promise.all([locations.reload(), page.reload(), reload()]);
  }
  async function toggleLocation(location: Location) {
    await send(`/locations/${location.id}/status`, { active: !location.active }, "PATCH");
    toast.success(location.active ? "Ubicación archivada" : "Ubicación activada");
    await locations.reload();
  }
  async function addQuickLocation() {
    if (!quickLocationName.trim() || savingQuickLocation) return;
    setSavingQuickLocation(true);
    try {
      const created = await send<Location>("/locations", { name: quickLocationName.trim(), isDefault: false });
      setLocationTouched(true);
      setLotLocationId(created.id);
      setQuickLocation(false);
      setQuickLocationName("");
      await locations.reload();
      toast.success("Ubicación guardada y seleccionada");
    } catch (error) { toast.error((error as Error).message); }
    finally { setSavingQuickLocation(false); }
  }
  const edit = editor && editor !== "new" ? editor : null;
  return (
    <div className="operation-page inventory-page">
      <PageHeader
        className="inventory-heading"
        eyebrow="CADA LOTE, EN SU LUGAR"
        title="Inventario"
        description="Cada lote, su stock y su responsable. Importes en pesos argentinos (ARS)."
        actions={
          <>
            {canManage && (
              <button
                className="button primary"
                onClick={() => setEditor("new")}
              >
                <Plus size={18} />
                Nuevo stock
              </button>
            )}
          </>
        }
      />
      {state.lowStockCount > 0 && <button className="inventory-low-alert" onClick={() => { setFilter("low"); updateParams("filter", "low"); }}><WarningCircle size={18} />{state.lowStockCount} {state.lowStockCount === 1 ? "lote con stock bajo" : "lotes con stock bajo"} · Ver alertas</button>}
      <Panel
        className="inventory-products-panel"
        title="Todos los productos"
        action={
          <div className="inventory-view">
            <span className="muted small">{page.data?.total ?? "…"} lotes</span>
            <div
              className="segmented"
              role="tablist"
              aria-label="Vista del inventario"
            >
              <button
                id="inventory-tab-cards"
                type="button"
                role="tab"
                className={view === "cards" ? "active" : ""}
                aria-label="Vista de tarjetas"
                aria-selected={view === "cards"}
                aria-controls="inventory-panel-cards"
                tabIndex={view === "cards" ? 0 : -1}
                onKeyDown={handleViewTabsKeyDown}
                onClick={() => setView("cards")}
              >
                <SquaresFour size={17} />
              </button>
              <button
                id="inventory-tab-table"
                type="button"
                role="tab"
                className={view === "table" ? "active" : ""}
                aria-label="Vista de tabla"
                aria-selected={view === "table"}
                aria-controls="inventory-panel-table"
                tabIndex={view === "table" ? 0 : -1}
                onKeyDown={handleViewTabsKeyDown}
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
            onChange={(value) => { setQuery(value); updateParams("q", value); }}
            placeholder="Buscar producto, lote o responsable…"
          />
          <div className="filter-group inventory-status-filter">
            <select
              aria-label="Estado del stock"
              value={filter}
              onChange={(e) => { setFilter(e.target.value); updateParams("filter", e.target.value); }}
            >
              <option value="all">Todo el stock</option>
              <option value="low">Stock bajo</option>
              <option value="expired">Vencidos</option>
            </select>
          </div>
          <details className="inventory-advanced">
            <summary>Filtros avanzados{type !== "all" || supplierFilter !== "all" ? " · activos" : ""}</summary>
            <div className="filter-group">
              <select aria-label="Tipo de producto" value={type} onChange={(e) => { setType(e.target.value); updateParams("type", e.target.value); }}>
                <option value="all">Todos los tipos</option>
                {["Flor", "Extracto", "Aceite", "Accesorio"].map((t) => <option key={t}>{t}</option>)}
              </select>
            {canManage && <select aria-label="Filtrar por proveedor" value={supplierFilter}
              onChange={(e) => { setSupplierFilter(e.target.value); updateParams("supplier", e.target.value); }}>
              <option value="all">Todos los proveedores</option>
              {suppliers.data?.items.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? "" : " (archivado)"}</option>)}
              <option value="unassigned">Sin proveedor</option>
            </select>}
            </div>
          </details>
        </div>
        <div id="inventory-panel-cards" role="tabpanel" aria-labelledby="inventory-tab-cards" tabIndex={0} className="inventory-view-panel" hidden={view !== "cards"}>
          {view === "cards" && <>
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
            {!page.loading && !page.error && !products.length && (
              <div className="inventory-empty-state">
                <Empty
                  title={hasFilters ? "No hay lotes con estos filtros" : "Todavía no hay lotes"}
                  description={hasFilters ? "Ajustá la búsqueda o quitá los filtros para ver el inventario completo." : "Los lotes que registres van a aparecer acá."}
                />
                {hasFilters ? <button className="button" onClick={clearFilters}>Quitar filtros</button> : canManage ? <button className="button primary" onClick={() => setEditor("new")}><Plus size={17} /> Crear primer lote</button> : null}
              </div>
            )}
          </>}
        </div>
        <div id="inventory-panel-table" role="tabpanel" aria-labelledby="inventory-tab-table" tabIndex={0} className="table-scroll inventory-table" hidden={view !== "table"}>
          {view === "table" && <>
            <div className="inventory-compact-list" aria-label="Lotes de inventario">
              {products.map((p) => <article key={p.id} className="inventory-compact-row">
                <div><strong>{p.name}</strong><small>{p.lot} · {state.users.find((member) => member.id === p.ownerId)?.name || "Sin responsable"}</small></div>
                <div className="inventory-compact-meta"><strong>{number(p.stock / 1000)} {p.unit}</strong><Badge tone={p.expires && p.expires <= state.today ? "red" : p.stock <= p.minimum ? "amber" : "green"}>{p.expires && p.expires <= state.today ? "Vencido" : p.stock <= p.minimum ? "Stock bajo" : "Disponible"}</Badge></div>
                {canManage && <div className="inventory-compact-actions"><button className="button small-button" onClick={() => setEditor(p)}>Editar</button><button className="button small-button" onClick={() => { setMoveType("entry"); setMovement(p); }}>Movimiento</button></div>}
              </article>)}
            </div>
            <table>
              <thead>
                <tr>
                  <th>Producto / lote</th>
                  <th>Responsable</th>
                  <th>Proveedor</th>
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
                              {[p.lot, p.strain, p.type].filter(Boolean).join(" · ")}
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
                      <td>{p.supplier || <span className="missing-value">Sin proveedor</span>}</td>
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
            {!page.loading && !page.error && !products.length && <div className="inventory-empty-state"><Empty title={hasFilters ? "No hay lotes con estos filtros" : "Todavía no hay lotes"} description={hasFilters ? "Ajustá la búsqueda o quitá los filtros para ver el inventario completo." : "Los lotes que registres van a aparecer acá."} />{hasFilters ? <button className="button" onClick={clearFilters}>Quitar filtros</button> : canManage ? <button className="button primary" onClick={() => setEditor("new")}><Plus size={17} /> Crear primer lote</button> : null}</div>}
          </>}
        </div>
        {page.loading && <p role="status" className="table-note">Buscando lotes…</p>}
        {page.error && <div className="operation-error" role="alert"><p>{page.error}</p><button className="button small-button" onClick={() => void page.reload()}>Reintentar</button></div>}
        {(previous.length > 0 || page.data?.nextCursor) && <div className="table-pagination">
          <button className="button" disabled={!previous.length} onClick={() => { setCursor(previous.at(-1) || null); setPrevious((s) => s.slice(0, -1)); }}>Anterior</button>
          <span>Página {previous.length + 1} · {page.data?.total || 0} lotes</span>
          <button className="button" disabled={!page.data?.nextCursor} onClick={() => { setPrevious((s) => [...s, cursor]); setCursor(page.data!.nextCursor); }}>Siguiente</button>
        </div>}
      </Panel>
      <div className="mini-stats inventory-summary">
        <span>
          <Package /> <strong>{page.data?.summary.total ?? "…"}</strong> lotes registrados
        </span>
        <span>
          <WarningCircle />{" "}
          <strong>
            {page.data?.summary.low ?? "…"}
          </strong>{" "}
          con stock bajo
        </span>
        {user.role !== "cashier" && (
          <span>
            Valor de inventario{" "}
            <strong>
              {money(page.data?.summary.value || 0)}
            </strong>
          </span>
        )}
      </div>
      <details className="operation-secondary inventory-tools">
        <summary>Movimientos, proveedores y ubicaciones</summary>
        <div className="inventory-tool-actions">
          <button className="button" onClick={() => setHistory(true)}><ClockCounterClockwise size={18} /> Movimientos</button>
          {user.role === "owner" && <button className="button" onClick={() => setShowSuppliers((value) => !value)} aria-expanded={showSuppliers}><Truck size={18} /> Proveedores</button>}
          {user.role === "owner" && <button className="button" onClick={() => setShowLocations((value) => !value)} aria-expanded={showLocations}><MapPin size={18} /> Ubicaciones</button>}
        </div>
      </details>
      {showSuppliers && user.role === "owner" && (
        <Panel title="Proveedores guardados" sub="Elegí uno al crear cada lote. El predeterminado se selecciona automáticamente."
          action={<button className="button primary" onClick={() => setSupplierEditor("new")}><Plus size={17} /> Nuevo proveedor</button>}>
          {suppliers.loading && <p role="status" className="table-note">Cargando proveedores…</p>}
        {suppliers.error && <div className="operation-error" role="alert"><p>{suppliers.error}</p><button className="button small-button" onClick={() => void suppliers.reload()}>Reintentar</button></div>}
          {!suppliers.loading && !suppliers.error && !suppliers.data?.items.length && <Empty title="Todavía no hay proveedores" description="Guardá el primero para seleccionarlo al crear un lote." />}
          <div className="supplier-grid">
            {suppliers.data?.items.map((supplier) => (
              <article className={`supplier-card${supplier.active ? "" : " is-archived"}`} key={supplier.id}>
                <div className="supplier-card-top"><span className="supplier-icon"><Truck size={19} /></span>
                  <div><strong>{supplier.name}</strong><small>{supplier.active ? `${supplier.lotCount} ${supplier.lotCount === 1 ? "lote vinculado" : "lotes vinculados"}` : "Archivado"}</small></div>
                  {supplier.isDefault && <span className="supplier-default"><Star size={13} weight="fill" /> Predeterminado</span>}
                </div>
                {(supplier.contactName || supplier.phone || supplier.email) && <p className="supplier-contact">{[supplier.contactName, supplier.phone, supplier.email].filter(Boolean).join(" · ")}</p>}
                {supplier.notes && <p className="supplier-note">{supplier.notes}</p>}
                <div className="supplier-actions">
                  <button className="button" onClick={() => setSupplierEditor(supplier)}>Editar</button>
                  <button className="button" onClick={() => void toggleSupplier(supplier).catch((e) => toast.error(e.message))}>{supplier.active ? "Archivar" : "Activar"}</button>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      )}
      {showLocations && user.role === "owner" && (
        <Panel title="Ubicaciones guardadas" sub="Organizá depósitos, estantes o sectores. Elegí una predeterminada para el stock nuevo."
          action={<button className="button primary" onClick={() => setLocationEditor("new")}><Plus size={17} /> Nueva ubicación</button>}>
          {locations.loading && <p role="status" className="table-note">Cargando ubicaciones…</p>}
        {locations.error && <div className="operation-error" role="alert"><p>{locations.error}</p><button className="button small-button" onClick={() => void locations.reload()}>Reintentar</button></div>}
          {!locations.loading && !locations.error && !locations.data?.items.length && <Empty title="Todavía no hay ubicaciones" description="Guardá la primera para seleccionarla al crear stock." />}
          <div className="supplier-grid">
            {locations.data?.items.map((location) => (
              <article className={`supplier-card${location.active ? "" : " is-archived"}`} key={location.id}>
                <div className="supplier-card-top"><span className="supplier-icon"><MapPin size={19} /></span>
                  <div><strong>{location.name}</strong><small>{location.active ? `${location.lotCount} ${location.lotCount === 1 ? "lote vinculado" : "lotes vinculados"}` : "Archivada"}</small></div>
                  {location.isDefault && <span className="supplier-default"><Star size={13} weight="fill" /> Predeterminada</span>}
                </div>
                <div className="supplier-actions">
                  <button className="button" onClick={() => setLocationEditor(location)}>Editar</button>
                  <button className="button" onClick={() => void toggleLocation(location).catch((e) => toast.error(e.message))}>{location.active ? "Archivar" : "Activar"}</button>
                </div>
              </article>
            ))}
          </div>
        </Panel>
      )}
      <Modal
        title={edit ? "Editar producto" : "Nuevo stock"}
        description="Precios en pesos argentinos (ARS), por unidad o gramo."
        open={!!editor}
        onClose={() => setEditor(null)}
        wide
      >
        <div className="operation-dialog-content inventory-dialog-content">
        <Form onSubmit={save} onCancel={() => setEditor(null)}>
          <div className="form-grid">
            <ProductIdentityFields key={edit?.id || "new"} edit={edit} />
            <Field label="Código de lote">
              <input
                name="lot"
                defaultValue={edit?.lot}
                placeholder="RC-26-013"
                required
              />
            </Field>
            <Field label="Proveedor" hint={suppliers.error || "Elegí un proveedor guardado; podés dejarlo sin asignar."}>
              <select name="supplierId" value={lotSupplierId} onChange={(e) => setLotSupplierId(e.target.value)}>
                <option value="">Sin proveedor</option>
                {suppliers.data?.items.filter((s) => s.active || s.id === edit?.supplierId).map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? "" : " (archivado)"}</option>)}
              </select>
            </Field>
            <Field label="Ubicación" hint={locations.error || (locations.loading ? "Cargando ubicaciones…" : !locations.data?.items.some((l) => l.active) ? "Guardá una ubicación para poder registrar el stock." : "Elegí dónde se guarda este stock.")}>
              <select name="locationId" value={lotLocationId} onChange={(e) => { setLotLocationId(e.target.value); setLocationTouched(true); }} required>
                <option value="">Elegí una ubicación</option>
                {locations.data?.items.filter((l) => l.active || l.id === edit?.locationId).map((l) =>
                  <option key={l.id} value={l.id}>{l.name}{l.active ? "" : " (archivada)"}</option>)}
              </select>
              {user.role === "owner" && !quickLocation && <button type="button" className="location-add-link" onClick={() => setQuickLocation(true)}><Plus size={14} /> Agregar ubicación</button>}
              {user.role === "owner" && quickLocation && <div className="location-quick-add">
                <input aria-label="Nombre de la nueva ubicación" value={quickLocationName} onChange={(e) => setQuickLocationName(e.target.value)} placeholder="Ej.: Depósito · Estante A" maxLength={180} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addQuickLocation(); } }} />
                <button type="button" className="button" disabled={!quickLocationName.trim() || savingQuickLocation} onClick={() => void addQuickLocation()}>Guardar</button>
                <button type="button" className="button" onClick={() => { setQuickLocation(false); setQuickLocationName(""); }}>Cancelar</button>
              </div>}
            </Field>
            {!edit && (
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
            <PriceFields key={edit?.id || "new"} edit={edit} />
          </div>
        </Form>
        </div>
      </Modal>
      <Modal title={supplierEditor === "new" ? "Nuevo proveedor" : "Editar proveedor"}
        description="Estos datos quedan guardados para los próximos lotes."
        open={!!supplierEditor} onClose={() => setSupplierEditor(null)}>
        <div className="operation-dialog-content inventory-dialog-content">
        <Form onSubmit={saveSupplier} onCancel={() => setSupplierEditor(null)}>
          <div className="form-grid">
            <Field label="Nombre del proveedor"><input name="name" defaultValue={supplierEditor !== "new" ? supplierEditor?.name : ""} required maxLength={180} /></Field>
            <Field label="Persona de contacto"><input name="contactName" defaultValue={supplierEditor !== "new" ? supplierEditor?.contactName : ""} maxLength={180} /></Field>
            <Field label="Teléfono"><input name="phone" type="tel" defaultValue={supplierEditor !== "new" ? supplierEditor?.phone : ""} maxLength={40} /></Field>
            <Field label="Correo electrónico"><input name="email" type="email" defaultValue={supplierEditor !== "new" ? supplierEditor?.email : ""} /></Field>
            <Field label="Notas"><textarea name="notes" defaultValue={supplierEditor !== "new" ? supplierEditor?.notes : ""} maxLength={2000} rows={3} /></Field>
            <label className="supplier-default-choice"><input name="isDefault" type="checkbox" defaultChecked={supplierEditor !== "new" ? !!supplierEditor?.isDefault : false} /> Seleccionar por defecto en lotes nuevos</label>
          </div>
        </Form>
        </div>
      </Modal>
      <Modal title={locationEditor === "new" ? "Nueva ubicación" : "Editar ubicación"}
        description="Se guarda para los próximos lotes. Si cambiás el nombre, también se actualizan los lotes vinculados."
        open={!!locationEditor} onClose={() => setLocationEditor(null)}>
        <div className="operation-dialog-content inventory-dialog-content">
        <Form onSubmit={saveLocation} onCancel={() => setLocationEditor(null)}>
          <Field label="Nombre de la ubicación"><input name="name" defaultValue={locationEditor !== "new" ? locationEditor?.name : ""} required maxLength={180} placeholder="Ej.: Depósito · Estante A" /></Field>
          <label className="supplier-default-choice"><input name="isDefault" type="checkbox" disabled={locationEditor !== "new" && !locationEditor?.active} defaultChecked={locationEditor !== "new" ? !!locationEditor?.isDefault : false} /> Seleccionar por defecto al crear stock</label>
        </Form>
        </div>
      </Modal>
      <Modal
        title={`Movimiento · ${movement?.name || ""}`}
        description="Cada cambio queda registrado con su fecha y usuario."
        open={!!movement}
        onClose={() => setMovement(null)}
      >
        <div className="operation-dialog-content inventory-dialog-content">
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
            await Promise.all([reload(), page.reload()]);
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
        </div>
      </Modal>
      <Modal
        title="Historial de movimientos"
        description="Historial completo de tu ámbito, paginado y ordenado por fecha."
        open={history}
        onClose={() => setHistory(false)}
        wide
      >
        <div className="operation-dialog-content inventory-history-content">
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
              {(historyData.data?.items || []).map((m) => (
                <tr key={m.id}>
                  <td>{shortDate(m.createdAt)}</td>
                  <td>
                    {m.product?.name ||
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
        {historyData.loading && <p role="status" className="table-note">Cargando movimientos…</p>}
        {!historyData.loading && !historyData.error && !historyData.data?.items.length && <Empty title="Todavía no hay movimientos" description="Las entradas, salidas, ajustes y traspasos aparecerán acá." />}
        {historyData.error && <div className="operation-error" role="alert"><p>{historyData.error}</p><button className="button small-button" onClick={() => void historyData.reload()}>Reintentar</button></div>}
        <div className="pagination">
          <span>
            {historyData.loading
              ? "Cargando…"
              : `${historyData.data?.total || 0} movimientos · Página ${historyPrevious.length + 1}`}
          </span>
          <div>
            <button
              className="button small-button"
              disabled={!historyPrevious.length || historyData.loading}
              onClick={() => { setHistoryCursor(historyPrevious.at(-1) || null); setHistoryPrevious((rows) => rows.slice(0, -1)); }}
            >
              Anterior
            </button>
            <button
              className="button small-button"
              disabled={
                historyData.loading ||
                !historyData.data?.nextCursor
              }
              onClick={() => { setHistoryPrevious((rows) => [...rows, historyCursor]); setHistoryCursor(historyData.data!.nextCursor); }}
            >
              Siguiente
            </button>
          </div>
        </div>
        </div>
      </Modal>
    </div>
  );
}
