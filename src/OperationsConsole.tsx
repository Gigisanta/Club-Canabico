import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowSquareOut, ArrowsLeftRight, ChartBar, CheckSquare, ClipboardText, CreditCard, Gear, House, List, MapPin, Package, Receipt, ShieldCheck, ShoppingCart, SignOut, Tag, UploadSimple, UserCircleGear, Users, Wallet, X, type Icon } from "@phosphor-icons/react";
import { roleLabels, type User } from "./lib";
import { useLocation, useNavigationType, useSearchParams } from "react-router-dom";
import "./operations-console.css";
import { CommandDialog } from "./operations-ui/CommandDialog";
import { apiGet, CommandRunner, hasCapability, onOperationsSessionExpired, OperationsApiError } from "./operations-ui/api";
import { ErrorState, LoadingState, StatusTag } from "./operations-ui/Primitives";
import { OperationalWorkspace } from "./operations-ui/OperationalWorkspace";
import type { CommandAction, OperationsContext } from "./operations-ui/types";

export interface OperationsConsoleProps {
  onExit?: () => void;
  exitLabel?: string;
  user: User;
  initialContext?: OperationsContext;
}

type NavGroup = { label: string; items: Array<{ id: string; label: string; icon: Icon; capability?: string }> };

const groups: NavGroup[] = [
  { label: "Inicio", items: [{ id: "home", label: "Resumen", icon: House }] },
  { label: "Operación", items: [
    { id: "orders", label: "Pedidos", icon: ShoppingCart, capability: "operations.read" },
    { id: "catalog", label: "Catálogo y stock", icon: Package, capability: "stock.read" },
    { id: "purchases", label: "Compras y recepción", icon: ArrowDown, capability: "purchases.write" },
    { id: "routes", label: "Rutas y entregas", icon: MapPin, capability: "logistics.write" },
    { id: "tasks", label: "Tareas", icon: CheckSquare, capability: "operations.read" },
  ] },
  { label: "Personas", items: [
    { id: "members", label: "Socios", icon: Users, capability: "members.read" },
    { id: "permissions", label: "Permisos y documentos", icon: ClipboardText, capability: "documents.read" },
  ] },
  { label: "Control", items: [
    { id: "finance", label: "Finanzas", icon: ChartBar, capability: "reports.read" },
    { id: "collections", label: "Cobros", icon: CreditCard, capability: "finance.read" },
    { id: "accounts", label: "Cuentas y saldos", icon: Wallet, capability: "finance.read" },
    { id: "payables", label: "Obligaciones", icon: Receipt, capability: "finance.read" },
    { id: "settlements", label: "Rendiciones", icon: ArrowsLeftRight, capability: "finance.read" },
    { id: "reports", label: "Informes", icon: ChartBar, capability: "reports.read" },
  ] },
  { label: "Gestión", items: [
    { id: "sources", label: "Datos cargados", icon: ClipboardText, capability: "imports.review" },
    { id: "commercial", label: "Políticas y promociones", icon: Tag, capability: "prices.propose" },
    { id: "configuration", label: "Configuración", icon: Gear, capability: "prices.propose" },
    { id: "imports", label: "Importación legado", icon: UploadSimple, capability: "imports.write" },
    { id: "access", label: "Accesos", icon: UserCircleGear, capability: "access.manage" },
    { id: "gates", label: "Habilitación y auditoría", icon: ShieldCheck, capability: "cutover.approve" },
  ] },
];

export default function OperationsConsole({ onExit, exitLabel = "Volver al panel", user, initialContext }: OperationsConsoleProps) {
  const verifiedInitialContext = initialContext?.userId === user.id ? initialContext : undefined;
  const [context, setContext] = useState<OperationsContext | null>(verifiedInitialContext ?? null);
  const [loading, setLoading] = useState(!verifiedInitialContext);
  const [error, setError] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const financeAlias = location.pathname === "/app/finanzas" && hasCapability(context, "reports.read") && hasCapability(context, "finance.read");
  const activePage = searchParams.get("section") ?? (financeAlias ? "finance" : "home");
  const [action, setAction] = useState<CommandAction | null>(null);
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mobileViewport, setMobileViewport] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const runner = useRef(new CommandRunner());
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const contextRequest = useRef<AbortController | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const accountName = user.name.trim() || user.username || "Mi cuenta";
  const avatarIndex = user.username?.toLowerCase() === "tiziano" || accountName.toLowerCase() === "tiziano"
    ? 1
    : Array.from(user.id).reduce((seed, character) => (seed * 31 + character.charCodeAt(0)) >>> 0, 0) % 4;
  const avatarPosition = ["0% 0%", "100% 0%", "0% 100%", "100% 100%"][avatarIndex];

  const closeMenu = useCallback(() => {
    setMobileNavOpen(false);
    menuButton.current?.focus();
  }, []);

  const invalidateSession = useCallback((cause: OperationsApiError) => {
    contextRequest.current?.abort();
    setContext(null);
    setAction(null);
    setNotice("");
    setLoading(false);
    setError(cause.message);
  }, []);

  useEffect(() => onOperationsSessionExpired(invalidateSession), [invalidateSession]);

  useEffect(() => {
    const viewport = window.matchMedia("(max-width: 760px)");
    const update = () => setMobileViewport(viewport.matches);
    viewport.addEventListener("change", update);
    return () => viewport.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen || !mobileViewport) return;
    sidebar.current?.querySelector<HTMLButtonElement>(".ops-nav-item[aria-current='page']")?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeMenu(); }
      if (event.key === "Tab") {
        const controls = Array.from(sidebar.current?.querySelectorAll<HTMLButtonElement>("button") ?? []).filter(control => control.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen, mobileViewport, closeMenu]);

  const reloadContext = useCallback(async () => {
    contextRequest.current?.abort();
    const controller = new AbortController();
    contextRequest.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await apiGet<OperationsContext>("/api/operations/context", { signal: controller.signal });
      if (!controller.signal.aborted) setContext(next);
    }
    catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof OperationsApiError && (cause.status === 401 || cause.status === 403)) {
        setContext(null);
        setAction(null);
        setNotice("");
      }
      setError(cause instanceof Error ? cause.message : "No se pudo leer el contexto operativo.");
    }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);

  useEffect(() => {
    if (verifiedInitialContext) {
      setContext(verifiedInitialContext);
      setError("");
      setLoading(false);
    } else {
      void reloadContext();
    }
    return () => { contextRequest.current?.abort(); window.clearTimeout(noticeTimer.current); };
  }, [verifiedInitialContext, reloadContext, user.id]);

  const visibleGroups = useMemo(() => groups.map(group => ({
    ...group,
    items: group.items.filter(item => {
      if (item.id === "permissions") return ["documents.read", "documents.write", "permissions.verify"].some(capability => hasCapability(context, capability));
      if (item.id === "imports") return ["imports.write", "imports.review"].some(capability => hasCapability(context, capability));
      if (item.id === "finance") return hasCapability(context, "reports.read") && hasCapability(context, "finance.read");
      if (item.id === "collections") return hasCapability(context, "finance.read");
      if (item.id === "tasks") return ["operations.read", "tasks.write"].some(capability => hasCapability(context, capability));
      if (item.id === "commercial") return ["prices.propose", "prices.approve"].some(capability => hasCapability(context, capability));
      if (item.id === "configuration") return ["prices.propose", "stock.read", "stock.prepare"].some(capability => hasCapability(context, capability));
      if (item.id === "payables") return ["finance.read", "payables.write"].some(capability => hasCapability(context, capability));
      return !item.capability || hasCapability(context, item.capability);
    }),
  })).filter(group => group.items.length), [context]);
  const page = visibleGroups.flatMap(group => group.items).find(item => item.id === activePage) ?? visibleGroups[0]?.items[0];

  useEffect(() => {
    if (context && page && page.id !== activePage) setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      next.delete("section");
      return next;
    }, { replace: true });
  }, [activePage, context, page, setSearchParams]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${page?.label ?? "Operaciones"} · Bombo`;
    return () => { document.title = previous; };
  }, [page?.label]);

  useEffect(() => {
    if (navigationType === "PUSH") window.scrollTo(0, 0);
  }, [activePage, navigationType]);

  const selectPage = (id: string) => {
    if (id !== activePage) setSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (id === "home" && !financeAlias) next.delete("section");
      else next.set("section", id);
      return next;
    });
    if (mobileViewport) closeMenu();
  };

  const runCommand = useCallback((command: string, targetId: string, expectedVersion: number, data: Record<string, unknown>, requestIdIsTarget?: boolean) =>
    runner.current.run(command, targetId, expectedVersion, data, requestIdIsTarget), []);
  const openAction = useCallback((next: CommandAction) => setAction(next), []);
  const showNotice = useCallback((message: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 8000);
  }, []);
  const refreshAll = useCallback(() => {
    setRefreshKey(key => key + 1);
    void reloadContext();
  }, [reloadContext]);

  if (loading && !context) return <div className="ops-loading-screen"><LoadingState label="Conectando con Operaciones…" /></div>;
  if (error && !context) return <div className="ops-loading-screen"><ErrorState message={error} retry={() => void reloadContext()} />{onExit && <button type="button" className="ops-button ops-button-quiet" onClick={onExit}>{exitLabel}</button>}</div>;
  if (!context) return null;

  return (
    <div className="ops-console">
      <a className="ops-skip-link" href="#operations-main">Ir al contenido</a>
      <button className={`ops-nav-scrim${mobileNavOpen ? " is-open" : ""}`} aria-label="Cerrar menú" onClick={closeMenu} tabIndex={-1} />
      <aside ref={sidebar} id="operations-navigation" className={`ops-sidebar${mobileNavOpen ? " is-open" : ""}`} inert={mobileViewport && !mobileNavOpen} aria-hidden={mobileViewport && !mobileNavOpen || undefined} aria-label="Navegación de Operaciones">
        <div className="ops-brand-row">
          <div><img className="ops-brand-logo" src="/brand/bombo-white.webp" alt="Bombo" width="128" height="42" /><span>Gestión del club</span></div>
          <button className="ops-icon-button ops-mobile-close" aria-label="Cerrar menú" onClick={closeMenu}><X size={20} /></button>
        </div>
        <nav className="ops-nav" aria-label="Secciones de Bombo">
          {visibleGroups.map(group => <div className="ops-nav-group" key={group.label}>
            <span className="ops-nav-label">{group.label}</span>
            {group.items.map(item => <button key={item.id} className={`ops-nav-item${activePage === item.id ? " is-active" : ""}`} aria-current={activePage === item.id ? "page" : undefined} onClick={() => selectPage(item.id)}>
              <span className="ops-nav-icon" aria-hidden="true"><item.icon size={20} weight={activePage === item.id ? "fill" : "regular"} /></span><span>{item.label}</span>
            </button>)}
          </div>)}
        </nav>
        <div className="ops-sidebar-foot">
          <div className="ops-profile-line"><span className="ops-avatar" style={{ backgroundPosition: avatarPosition }} aria-hidden="true" /><span className="ops-profile-copy"><strong title={accountName}>{accountName}</strong><small>{roleLabels[user.role]}</small></span></div>
          {onExit && <button className="ops-exit-button" onClick={onExit}>{exitLabel === "Cerrar sesión" ? <SignOut size={18} /> : <ArrowSquareOut size={18} />}{exitLabel}</button>}
        </div>
      </aside>
      <div className="ops-main">
        <header className="ops-topbar">
          <button ref={menuButton} className="ops-icon-button ops-mobile-menu" aria-label="Abrir menú" aria-expanded={mobileNavOpen} aria-controls="operations-navigation" onClick={() => setMobileNavOpen(true)}><List size={22} /></button>
          <div className="ops-crumb"><span>Operaciones</span><span aria-hidden="true">/</span><strong>{page?.label ?? "Resumen"}</strong></div>
          <div className="ops-top-actions">
            <StatusTag tone={context.rehearsal ? "warn" : context.authority.mode === "active" ? "good" : "warn"}>{context.rehearsal ? "Ensayo · datos sintéticos" : context.authority.mode === "active" ? "Circuito activo" : "Solo consulta"}</StatusTag>
            <button type="button" className="ops-icon-button" aria-label={loading ? "Actualizando consola" : "Actualizar consola"} title="Actualizar" disabled={loading} aria-busy={loading} onClick={refreshAll}>↻</button>
          </div>
        </header>
        {context.rehearsal
          ? <div className="ops-shadow-strip"><span aria-hidden="true">●</span> Ensayo habilitado · los cambios afectan datos sintéticos</div>
          : context.authority.mode !== "active" && <div className="ops-shadow-strip"><span aria-hidden="true">●</span> Las ventas y los movimientos operativos requieren habilitación. Podés gestionar los datos y controles disponibles para tu perfil.</div>}
        <main className="ops-content" id="operations-main" tabIndex={-1}>
          {error && <ErrorState message={`No pudimos actualizar el acceso. ${error}`} retry={() => void reloadContext()} />}
          {page && <OperationalWorkspace key={page.id} pageId={page.id} context={context} refreshKey={refreshKey} runCommand={runCommand} openAction={openAction} onNotice={showNotice} onRefresh={() => {
            setRefreshKey(key => key + 1);
            if (page.id === "gates") void reloadContext();
          }} />}
        </main>
        {notice && <div className="ops-toast" role="status" aria-live="polite"><span aria-hidden="true">✓</span>{notice}<button onClick={() => setNotice("")} aria-label="Cerrar aviso">×</button></div>}
      </div>
      {action && <CommandDialog action={action} runCommand={runCommand} onClose={() => setAction(null)} onSuccess={message => {
        const completedAuthorityActivation = action.command === "AuthorityActivated";
        setAction(null);
        showNotice(message);
        setRefreshKey(key => key + 1);
        if (completedAuthorityActivation) void reloadContext();
      }} />}
    </div>
  );
}
