import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./operations-console.css";
import { CommandDialog } from "./operations-ui/CommandDialog";
import { apiGet, CommandRunner, hasCapability, loadOperationsContext } from "./operations-ui/api";
import { ErrorState, LoadingState, StatusTag } from "./operations-ui/Primitives";
import { OperationalWorkspace } from "./operations-ui/OperationalWorkspace";
import type { CommandAction, OperationsContext } from "./operations-ui/types";

export interface OperationsConsoleProps {
  onExit?: () => void;
  profile?: string;
}

type NavGroup = { label: string; items: Array<{ id: string; label: string; icon: string; capability?: string }> };

const groups: NavGroup[] = [
  { label: "Inicio", items: [{ id: "home", label: "Resumen", icon: "◷" }] },
  { label: "Operación", items: [
    { id: "orders", label: "Pedidos", icon: "▤", capability: "operations.read" },
    { id: "catalog", label: "Catálogo y stock", icon: "▦", capability: "stock.read" },
    { id: "purchases", label: "Compras y recepción", icon: "⇣", capability: "purchases.write" },
    { id: "routes", label: "Rutas y entregas", icon: "⌖", capability: "logistics.write" },
    { id: "tasks", label: "Tareas", icon: "✓", capability: "operations.read" },
  ] },
  { label: "Personas", items: [
    { id: "members", label: "Socios", icon: "◎", capability: "members.read" },
    { id: "permissions", label: "Permisos y documentos", icon: "▧", capability: "documents.read" },
  ] },
  { label: "Control", items: [
    { id: "collections", label: "Cobros", icon: "$", capability: "finance.read" },
    { id: "accounts", label: "Cuentas y saldos", icon: "◫", capability: "finance.read" },
    { id: "payables", label: "Obligaciones", icon: "⇢", capability: "finance.read" },
    { id: "settlements", label: "Rendiciones", icon: "↔", capability: "finance.read" },
    { id: "reports", label: "Informes", icon: "▥", capability: "reports.read" },
  ] },
  { label: "Gestión", items: [
    { id: "commercial", label: "Políticas y promociones", icon: "◇", capability: "prices.propose" },
    { id: "configuration", label: "Configuración", icon: "⚙", capability: "prices.propose" },
    { id: "imports", label: "Importación legado", icon: "⇧", capability: "imports.write" },
    { id: "access", label: "Accesos", icon: "⌘", capability: "access.manage" },
    { id: "gates", label: "Habilitación y auditoría", icon: "◈", capability: "cutover.approve" },
  ] },
];

export default function OperationsConsole({ onExit, profile }: OperationsConsoleProps) {
  const [context, setContext] = useState<OperationsContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activePage, setActivePage] = useState("home");
  const [action, setAction] = useState<CommandAction | null>(null);
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const runner = useRef(new CommandRunner());

  const reloadContext = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setContext(await loadOperationsContext()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo leer el contexto operativo."); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void reloadContext(); }, [reloadContext]);

  const visibleGroups = useMemo(() => groups.map(group => ({
    ...group,
    items: group.items.filter(item => {
      if (item.id === "permissions") return ["documents.read", "documents.write", "permissions.verify"].some(capability => hasCapability(context, capability));
      if (item.id === "imports") return ["imports.write", "imports.review"].some(capability => hasCapability(context, capability));
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
    if (page && page.id !== activePage) setActivePage(page.id);
  }, [activePage, page]);

  const runCommand = useCallback((command: string, targetId: string, expectedVersion: number, data: Record<string, unknown>, requestIdIsTarget?: boolean) =>
    runner.current.run(command, targetId, expectedVersion, data, requestIdIsTarget), []);
  const openAction = useCallback((next: CommandAction) => setAction(next), []);
  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 5200);
  }, []);
  const refreshAll = useCallback(() => {
    setRefreshKey(key => key + 1);
    void reloadContext();
  }, [reloadContext]);

  if (loading && !context) return <div className="ops-loading-screen"><LoadingState label="Conectando con Operaciones…" /></div>;
  if (error && !context) return <div className="ops-loading-screen"><ErrorState message={error} retry={() => void reloadContext()} /></div>;
  if (!context) return null;

  return (
    <div className="ops-console">
      <button className={`ops-nav-scrim${mobileNavOpen ? " is-open" : ""}`} aria-label="Cerrar menú" onClick={() => setMobileNavOpen(false)} tabIndex={mobileNavOpen ? 0 : -1} />
      <aside className={`ops-sidebar${mobileNavOpen ? " is-open" : ""}`} aria-label="Navegación de Operaciones">
        <div className="ops-brand-row">
          <div className="ops-brand-mark" aria-hidden="true">b.</div>
          <div><strong>bombo</strong><span>operaciones</span></div>
          <button className="ops-icon-button ops-mobile-close" aria-label="Cerrar menú" onClick={() => setMobileNavOpen(false)}>×</button>
        </div>
        <div className="ops-club-switch"><span className="ops-club-dot" /><div><small>ESPACIO ACTIVO</small><strong>Club · Operación</strong></div><span aria-hidden="true">⌄</span></div>
        <nav className="ops-nav">
          {visibleGroups.map(group => <div className="ops-nav-group" key={group.label}>
            <span className="ops-nav-label">{group.label}</span>
            {group.items.map(item => <button key={item.id} className={`ops-nav-item${activePage === item.id ? " is-active" : ""}`} aria-current={activePage === item.id ? "page" : undefined} onClick={() => { setActivePage(item.id); setMobileNavOpen(false); }}>
              <span className="ops-nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
            </button>)}
          </div>)}
        </nav>
        <div className="ops-sidebar-foot">
          <div className="ops-profile-line"><span className="ops-avatar">{(profile ?? context.profile).slice(0, 1).toUpperCase()}</span><span><strong>{profile ?? context.profile}</strong><small>Perfil vigente</small></span></div>
          {onExit && <button className="ops-exit-button" onClick={onExit}>← Volver a Bombo</button>}
        </div>
      </aside>
      <div className="ops-main">
        <header className="ops-topbar">
          <button className="ops-icon-button ops-mobile-menu" aria-label="Abrir menú" onClick={() => setMobileNavOpen(true)}>☰</button>
          <div className="ops-crumb"><span>Operaciones</span><span aria-hidden="true">/</span><strong>{page?.label ?? "Resumen"}</strong></div>
          <div className="ops-top-actions">
            <StatusTag tone={context.rehearsal ? "warn" : context.authority.mode === "active" ? "good" : "warn"}>{context.rehearsal ? "Ensayo · datos sintéticos" : context.authority.mode === "active" ? "Circuito activo" : "Modo sombra"}</StatusTag>
            <button type="button" className="ops-icon-button" aria-label="Actualizar consola" title="Actualizar" onClick={refreshAll}>↻</button>
          </div>
        </header>
        {context.rehearsal
          ? <div className="ops-shadow-strip"><span aria-hidden="true">●</span> Ensayo habilitado · los cambios afectan datos sintéticos</div>
          : context.authority.mode !== "active" && <div className="ops-shadow-strip"><span aria-hidden="true">●</span> Vista de consulta · los cambios todavía no están habilitados</div>}
        <main className="ops-content" id="operations-main" tabIndex={-1}>
          {page && <OperationalWorkspace pageId={page.id} context={context} refreshKey={refreshKey} runCommand={runCommand} openAction={openAction} onNotice={showNotice} onRefresh={() => setRefreshKey(key => key + 1)} />}
        </main>
        {notice && <div className="ops-toast" role="status" aria-live="polite"><span aria-hidden="true">✓</span>{notice}<button onClick={() => setNotice("")} aria-label="Cerrar aviso">×</button></div>}
      </div>
      {action && <CommandDialog action={action} runCommand={runCommand} onClose={() => setAction(null)} onSuccess={message => { setAction(null); showNotice(message); setRefreshKey(key => key + 1); }} />}
    </div>
  );
}
