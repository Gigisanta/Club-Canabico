import { useEffect, useRef, useState, lazy, Suspense } from "react";
import {
  NavLink,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  Package,
  Plant,
  GearSix,
  Bell,
  MagnifyingGlass,
  Plus,
  SignOut,
  List,
  ArrowSquareOut,
  CircleNotch,
  ShieldCheck,
  ArrowRight,
  X,
  DotsThree,
  CaretDown,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  api,
  send,
  useResource,
  ClubProvider,
  money,
  roleLabels,
  type User,
  type ClubState,
} from "./lib";
import { Avatar, Brand, Modal, Field, Form, Empty } from "./ui";
import { canVisit, currentDestination, hubsForRole, searchDestinations } from "./navigation";
const Today = lazy(() => import("./Today"));
const Dashboard = lazy(() => import("./Dashboard").then((m) => ({ default: m.Dashboard })));
const DecisionCenter = lazy(() => import("./DecisionCenter"));
const DecisionAnalysis = lazy(() => import("./DecisionAnalysis"));
const DecisionInputs = lazy(() => import("./DecisionInputs"));
const DataImportStudio = lazy(() => import("./DataImportStudio"));
const Sales = lazy(() => import("./Sales"));
const SaleModal = lazy(() => import("./Sales").then((m) => ({ default: m.SaleModal })));
const Inventory = lazy(() => import("./Inventory"));
const Customers = lazy(() => import("./Customers"));

const Expenses = lazy(() =>
  import("./Management").then((m) => ({ default: m.Expenses })),
);
const Responsibles = lazy(() =>
  import("./Management").then((m) => ({ default: m.Responsibles })),
);
const Reports = lazy(() =>
  import("./Management").then((m) => ({ default: m.Reports })),
);
const Settings = lazy(() => import("./Settings"));
const Finance = lazy(() => import("./Finance"));
const ShowcaseAdmin = lazy(() => import("./ShowcaseAdmin"));
const InquiriesAdmin = lazy(() => import("./InquiriesAdmin"));
function Login({
  onLogin,
  demo,
}: {
  onLogin: (u: User) => void;
  demo: boolean;
}) {
  return (
    <main className="login-page">
      <div className="login-story">
        <Brand />
        <div>
          <span className="eyebrow">MENOS PLANILLAS. MÁS CLARIDAD.</span>
          <h1>
            Tu club, en
            <br />
            su mejor versión.
          </h1>
          <p>
            Un lugar para tu inventario, tus socios y todas las decisiones que
            hacen crecer tu club.
          </p>
          <div className="login-decoration">
            <Plant size={150} weight="duotone" />
          </div>
        </div>
        <small>Gestión clara. Visión de futuro.</small>
      </div>
      <section className="login-form">
        <Brand />
        <h2>Bienvenido a tu club</h2>
        <p>Ingresá con tu cuenta para continuar.</p>
        <Form
          submit="Iniciar sesión"
          onSubmit={async (fd) =>
            onLogin(
              (
                await send<{ user: User }>(
                  "/auth/login",
                  Object.fromEntries(fd),
                )
              ).user,
            )
          }
        >
          <Field label="Correo electrónico">
            <input
              type="email"
              name="email"
              autoComplete="username"
              required
              placeholder="nombre@tuclub.com"
            />
          </Field>
          <Field label="Contraseña">
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              placeholder="Tu contraseña"
            />
          </Field>
        </Form>
        {demo && (
          <button
            className="button demo-login"
            onClick={() =>
              void send<{ user: User }>("/auth/demo", { id: "owner" })
                .then((r) => onLogin(r.user))
                .catch((e) => toast.error(e.message))
            }
          >
            Explorar club de demostración <ArrowRight />
          </button>
        )}
        <p className="login-note">
          <ShieldCheck />
          Acceso privado para miembros del equipo.
        </p>
      </section>
    </main>
  );
}
export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const [demo, setDemo] = useState(false);
  const [bootError, setBootError] = useState("");
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const config = await api<{ demo: boolean }>("/config");
        if (!active) return;
        setDemo(config.demo);
        try {
          const r = await api<{ user: User }>("/auth/me");
          if (active) setUser(r.user);
        } catch {
          /* Unauthenticated users see the sign-in screen. */
        }
      } catch (e) {
        if (active) setBootError((e as Error).message);
      } finally {
        if (active) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  if (checking)
    return (
      <div className="boot">
        <Brand />
        <CircleNotch className="spin" />
        Preparando tu espacio…
      </div>
    );
  if (bootError)
    return (
      <div className="boot">
        <Brand />
        <h2>No pudimos conectar con el servidor</h2>
        <p>{bootError}</p>
        <button className="button" onClick={() => window.location.reload()}>
          Reintentar
        </button>
      </div>
    );
  if (!user) return <Login onLogin={setUser} demo={demo} />;
  return (
    <Workspace
      key={user.id}
      user={user}
      onLogout={() => setUser(null)}
      onUser={setUser}
    />
  );
}
function Workspace({
  user,
  onLogout,
  onUser,
}: {
  user: User;
  onLogout: () => void;
  onUser: (u: User) => void;
}) {
  const [owner, setOwner] = useState("");
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleLoaded, setSaleLoaded] = useState(false);
  const openSale = () => { setSaleLoaded(true); setSaleOpen(true); };
  const [menu, setMenu] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const mainRegion = useRef<HTMLElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [notifications, setNotifications] = useState(false);
  const [profile, setProfile] = useState(false);
  const location = useLocation();
  const [openHub, setOpenHub] = useState<string | null>("inicio");
  const hubs = hubsForRole(user.role);
  const current = currentDestination(location.pathname, location.search, user.role);
  useEffect(() => {
    const destination = currentDestination(location.pathname, location.search, user.role);
    if (destination) setOpenHub(destination.hub.id);
  }, [location.pathname, location.search, user.role]);
  const view = ({
    "/app": "dashboard", "/app/": "dashboard", "/app/panorama": "dashboard", "/app/decisiones": "dashboard", "/app/inventario": "inventory", "/app/socios": "customers",
    "/app/ventas": "sales", "/app/gastos": "expenses", "/app/finanzas": "finance",
    "/app/decisiones/stock": "dashboard", "/app/decisiones/comercial": "dashboard", "/app/decisiones/caja": "dashboard", "/app/decisiones/socios": "dashboard",
    "/app/responsables": "responsibles", "/app/reportes": "reports", "/app/configuracion": "settings", "/app/importar": "settings", "/app/preparar": "settings",
    "/app/vidriera": "settings", "/app/consultas": "settings",
  } as Record<string, string>)[location.pathname] || "dashboard";
  const resource = useResource<ClubState>(
    `/views/${view}?${new URLSearchParams({ ...(owner ? { owner } : {}), ...(view === "expenses" && new URLSearchParams(location.search).get("month") ? { month: new URLSearchParams(location.search).get("month")! } : {}) })}`,
  );
  useEffect(() => { const id = window.setTimeout(() => setSearchTerm(query.trim()), 220); return () => clearTimeout(id); }, [query]);
  const searchData = useResource<{ items: { name: string; type: string; path: string }[] }>(
    searchOpen && searchTerm ? `/search?q=${encodeURIComponent(searchTerm)}${owner ? `&owner=${encodeURIComponent(owner)}` : ""}` : null,
  );
  const state = resource.data;
  const navigate = useNavigate();
  const isManager = ["owner", "admin"].includes(user.role);
  const canManage = ["owner", "admin", "responsible"].includes(user.role);
  const canSell = user.role !== "viewer" && Boolean(state?.operationsEnabled);
  useEffect(() => {
    if (menu) requestAnimationFrame(() => mainRegion.current?.focus());
    setMenu(false);
  }, [location.pathname]);
  const closeMenu = () => {
    setMenu(false);
    requestAnimationFrame(() => menuTrigger.current?.focus());
  };
  const finishMenuNavigation = () => {
    if (!menu) return;
    setMenu(false);
    requestAnimationFrame(() => mainRegion.current?.focus());
  };
  const openMenu = (trigger: HTMLButtonElement) => {
    menuTrigger.current = trigger;
    setMenu(true);
  };
  useEffect(() => {
    if (!menu) return;
    document.querySelector<HTMLButtonElement>("#app-navigation .sidebar-close")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
        return;
      }
      if (event.key === "Tab") {
        const focusable = [...document.querySelectorAll<HTMLElement>("#app-navigation a, #app-navigation button:not([disabled])")];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!document.getElementById("app-navigation")?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); document.body.style.overflow = previousOverflow; };
  }, [menu]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  async function logout() {
    await send("/auth/logout", {});
    onLogout();
  }
  if (!state)
    return (
      <div className="boot">
        <Brand />
        {resource.error ? (
          <>
            <p role="alert">{resource.error}</p>
            <button className="button" onClick={() => void resource.reload()}>
              Reintentar
            </button>
            <button className="button" onClick={() => void logout()}>
              Volver al inicio
            </button>
          </>
        ) : (
          <>
            <CircleNotch className="spin" />
            Cargando tu club…
          </>
        )}
      </div>
    );
  const alerts = state.lowStockCount;
  const mobilePrimary = hubs.filter((hub) => ["inicio", "ventas", "stock", "socios"].includes(hub.id));
  const mobileLabels: Record<string, string> = { inicio: "Inicio", ventas: "Ventas", stock: "Stock", socios: "Socios" };
  const moreActive = !mobilePrimary.some((hub) => hub.id === current?.hub.id);
  return (
    <ClubProvider
      value={{
        state,
        reload: resource.reload,
        owner,
        setOwner,
        money: (n) => money(n, state.settings.currency),
        canManage,
        canSell,
        isManager,
        user,
        logout,
      }}
    >
      <div className="app-shell">
        {menu && (
          <button
            className="sidebar-scrim"
            aria-label="Cerrar navegación"
            onClick={closeMenu}
          />
        )}
        <aside id="app-navigation" className={`sidebar ${menu ? "open" : ""}`} role={menu ? "dialog" : undefined} aria-modal={menu || undefined} aria-label={menu ? "Navegación del club" : undefined} onClickCapture={(event) => {
          if ((event.target as HTMLElement).closest("a")) finishMenuNavigation();
        }}>
          <Brand />
          <button type="button" className="sidebar-close icon-button" aria-label="Cerrar navegación" onClick={closeMenu}><X size={21} /></button>
          <button
            className="club-switch"
            aria-label={`Configurar ${state.settings.clubName}`}
            onClick={() => { navigate("/app/configuracion"); finishMenuNavigation(); }}
          >
            <span className="club-avatar">
              <img src="/brand/bombo-symbol.png" alt="" />
            </span>
            <span>
              <strong>{state.settings.clubName}</strong>
              <small>Configurar espacio</small>
            </span>
            <ArrowRight size={14} />
          </button>
          <nav className="hub-navigation" aria-label="Áreas del club">
            {hubs.map((hub) => {
              const Icon = hub.icon;
              const expanded = openHub === hub.id;
              const selected = current?.hub.id === hub.id;
              const main = hub.items[0];
              return <div className={`hub-group${selected ? " is-current" : ""}`} key={hub.id}>
                <div className="hub-heading">
                  <NavLink className="hub-link" to={main.path} aria-label={hub.label}>
                    <Icon size={20} weight="duotone" aria-hidden="true" />
                    <span>{hub.label}</span>
                    {hub.id === "stock" && alerts > 0 && <span className="nav-count" aria-label={`${alerts} alertas`}>{alerts}</span>}
                  </NavLink>
                  <h2 className="hub-toggle-heading"><button id={`hub-toggle-${hub.id}`} type="button" className="hub-toggle" aria-label={`Opciones de ${hub.label}`} aria-expanded={expanded} aria-controls={`hub-items-${hub.id}`} onClick={() => setOpenHub(expanded ? null : hub.id)}><CaretDown size={16} aria-hidden="true" /></button></h2>
                </div>
                <div id={`hub-items-${hub.id}`} className="hub-items" role="region" aria-labelledby={`hub-toggle-${hub.id}`} hidden={!expanded}>
                  {hub.items.map((item) => <NavLink key={item.path} to={item.path} end={item.path === "/app"} className={current?.item.path === item.path ? "is-selected" : ""} aria-current={current?.item.path === item.path ? "page" : undefined}>{item.label}</NavLink>)}
                </div>
              </div>;
            })}
          </nav>
          <div className="sidebar-bottom">
            {alerts > 0 ? (
              <button className="club-health" onClick={() => { navigate("/app/inventario?filter=low"); finishMenuNavigation(); }}>
                <span className="club-health-icon"><Package size={20} /></span>
                <span><strong>{alerts} {alerts === 1 ? "lote necesita" : "lotes necesitan"} atención</strong><small>Revisar stock bajo <ArrowRight size={13} /></small></span>
              </button>
            ) : (
              <div className="club-health is-clear">
                <span className="club-health-icon"><ShieldCheck size={20} /></span>
                <span><strong>Stock al día</strong><small>Sin lotes bajo el mínimo</small></span>
              </div>
            )}
            <div className="sidebar-user">
              <Avatar name={user.name} color={user.color} />
              <div>
                <strong>{user.name}</strong>
                <small>{roleLabels[user.role]}</small>
              </div>
              <button
                aria-label="Cerrar sesión"
                className="icon-button"
                onClick={() => void logout()}
              >
                <SignOut size={19} />
              </button>
            </div>
          </div>
        </aside>
        <div className="workspace" inert={menu}>
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label={menu ? "Cerrar navegación" : "Abrir navegación"}
                aria-expanded={menu}
                aria-controls="app-navigation"
                onClick={(event) => menu ? closeMenu() : openMenu(event.currentTarget)}
              >
                <List size={23} />
              </button>
              <span>{current?.hub.label || "Inicio"}</span>
              <span className="breadcrumb-slash">/</span>
              <strong aria-current="page">{current?.item.label || "Resumen de hoy"}</strong>
            </div>
            <div className="top-actions">
              <span className="topbar-date">{new Date(`${state.today}T12:00:00`).toLocaleDateString("es-AR", { day: "numeric", month: "long", year: "numeric" })}</span>
              <button
                className="global-search"
                aria-label="Buscar en el club"
                onClick={() => setSearchOpen(true)}
              >
                <MagnifyingGlass size={18} />
                <span>Buscar en el club</span>
                <kbd>Ctrl K</kbd>
              </button>
              <span className="top-divider" />
              <button
                className="icon-button notification-button"
                aria-label={`Notificaciones, ${alerts} alertas`}
                onClick={() => setNotifications(true)}
              >
                <Bell size={21} />
                {alerts > 0 && <i />}
              </button>
              <button
                className="profile-button"
                aria-label="Mi perfil"
                onClick={() => setProfile(true)}
              >
                <Avatar name={user.name} color={user.color} size={33} />
              </button>
            </div>
          </header>
          <main className="main-content" ref={mainRegion} tabIndex={-1}>
            {state.demo && (
              <div className="demo-ribbon">
                <span>
                  <span className="live-dot" />
                  Club de demostración{" "}
                  <span className="demo-extra">
                    · Datos de ejemplo persistentes
                  </span>
                </span>
                <button onClick={() => setProfile(true)}>
                  Probar otro rol <ArrowSquareOut size={13} />
                </button>
              </div>
            )}
            {resource.error && (
              <div className="form-error" role="alert">
                {resource.error}{" "}
                <button onClick={() => void resource.reload()}>
                  Reintentar
                </button>
              </div>
            )}
            {!state.operationsEnabled && <div className="scope-banner" role="status">Operaciones con cannabis deshabilitadas hasta la validación legal del club. Inventario, socios y planificación siguen disponibles.</div>}
            {(owner || user.role === "responsible") && (
              <div className="scope-banner">
                <span>
                  Vista de:{" "}
                  <strong>
                    {user.role === "responsible"
                      ? user.name
                      : state.users.find((u) => u.id === owner)?.name}
                  </strong>
                </span>
                {user.role !== "responsible" && (
                  <button onClick={() => setOwner("")}>Ver todo el club</button>
                )}
              </div>
            )}
            <Suspense
              fallback={
                <div className="page-loading">
                  <CircleNotch className="spin" /> Cargando módulo…
                </div>
              }
            >
              <Routes key={location.pathname}>
                <Route index element={<Today onSale={openSale} />} />
                <Route path="panorama" element={<Dashboard onSale={openSale} />} />
                <Route path="decisiones" element={canVisit("/app/decisiones", user.role) ? <DecisionCenter /> : <Navigate to="/app" replace />} />
                <Route path="importar" element={canVisit("/app/importar", user.role) ? <DataImportStudio /> : <Navigate to="/app" replace />} />
                <Route path="preparar" element={canVisit("/app/preparar", user.role) ? <DecisionInputs /> : <Navigate to="/app" replace />} />
                <Route path="decisiones/stock" element={canVisit("/app/decisiones/stock", user.role) ? <DecisionAnalysis section="stock" /> : <Navigate to="/app" replace />} />
                <Route path="decisiones/comercial" element={canVisit("/app/decisiones/comercial", user.role) ? <DecisionAnalysis section="commercial" /> : <Navigate to="/app" replace />} />
                <Route path="decisiones/caja" element={canVisit("/app/decisiones/caja", user.role) ? <DecisionAnalysis section="cash" /> : <Navigate to="/app" replace />} />
                <Route path="decisiones/socios" element={canVisit("/app/decisiones/socios", user.role) ? <DecisionAnalysis section="members" /> : <Navigate to="/app" replace />} />
                <Route path="inventario" element={<Inventory />} />
                <Route path="socios" element={<Customers />} />
                <Route path="finanzas" element={canVisit("/app/finanzas", user.role) ? <Finance /> : <Navigate to="/app" replace />} />
                <Route
                  path="ventas"
                  element={<Sales onSale={openSale} />}
                />
                <Route
                  path="gastos"
                  element={canVisit("/app/gastos", user.role) ? <Expenses /> : <Navigate to="/app" replace />}
                />
                <Route
                  path="responsables"
                  element={canVisit("/app/responsables", user.role) ? <Responsibles /> : <Navigate to="/app" replace />}
                />
                <Route
                  path="reportes"
                  element={canVisit("/app/reportes", user.role) ? <Reports /> : <Navigate to="/app" replace />}
                />
                <Route path="configuracion" element={canVisit("/app/configuracion", user.role) ? <Settings /> : <Navigate to="/app" replace />} />
                <Route path="vidriera" element={canVisit("/app/vidriera", user.role) ? <ShowcaseAdmin /> : <Navigate to="/app" replace />} />
                <Route path="consultas" element={canVisit("/app/consultas", user.role) ? <InquiriesAdmin /> : <Navigate to="/app" replace />} />
                <Route path="*" element={<Navigate to="/app" replace />} />
              </Routes>
            </Suspense>
            <footer className="app-footer">
              <span>Bombo cannabis club · Cada dato, una mejor decisión.</span>
              <span>
                <span className="live-dot" />{" "}
                {resource.loading ? "Actualizando…" : "Datos conectados"}
              </span>
            </footer>
          </main>
        </div>
        <nav className="mobile-tabbar" aria-label="Accesos principales" inert={menu}>
          {mobilePrimary.map((hub) => {
            const Icon = hub.icon;
            const path = hub.items[0].path;
            return <NavLink key={hub.id} to={path} end={path === "/app"} className={current?.hub.id === hub.id ? "active" : ""} aria-label={hub.id === "stock" && alerts > 0 ? `${mobileLabels[hub.id]}, ${alerts} alertas` : mobileLabels[hub.id]}>
              <Icon size={23} weight="duotone" aria-hidden="true" />
              <span>{mobileLabels[hub.id]}</span>
              {hub.id === "stock" && alerts > 0 && <i className="mobile-tabbar-alert" aria-hidden="true" />}
            </NavLink>;
          })}
          <button
            type="button"
            className={moreActive || menu ? "active" : ""}
            aria-label="Más secciones"
            aria-expanded={menu}
            aria-controls="app-navigation"
            onClick={(event) => menu ? closeMenu() : openMenu(event.currentTarget)}
          >
            <DotsThree size={23} weight="bold" aria-hidden="true" />
            <span>Más</span>
          </button>
        </nav>
      </div>
      <Suspense fallback={null}>
        {saleLoaded && <SaleModal open={saleOpen} onClose={() => setSaleOpen(false)} />}
      </Suspense>
      <Modal
        title="Buscar en el club"
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      >
        <div className="command-search">
          <MagnifyingGlass />
          <input
            autoFocus
            placeholder="Buscar socio, producto o sección…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="search-results">
          {[
            ...searchDestinations(user.role, query),
            ...(searchData.data?.items || []).filter((x) => x.name.toLocaleLowerCase("es-AR").includes(query.toLocaleLowerCase("es-AR"))),
          ]
            .slice(0, 12)
            .map((x, i) => (
              <button
                key={i}
                onClick={() => {
                  navigate(x.type === "Sección" || hubs.some((hub) => hub.label === x.type) ? x.path : `${x.path}${query ? "?q=" + encodeURIComponent(query) : ""}`);
                  setSearchOpen(false);
                }}
              >
                <span>
                  {x.name}
                  <small>{x.type}</small>
                </span>
                <ArrowRight />
              </button>
            ))}
          {searchData.loading && searchTerm && <p role="status" className="table-note">Buscando…</p>}
          {searchData.error && <p role="alert">{searchData.error}</p>}
        </div>
      </Modal>
      <Modal
        title="Centro de notificaciones"
        description="Alertas actuales del inventario."
        open={notifications}
        onClose={() => setNotifications(false)}
      >
        {state.lowStockAlerts.length ? (
          state.lowStockAlerts.map((p) => (
            <div className="notification-row" key={p.id}>
              <span className="alert-symbol">
                <Package />
              </span>
              <div>
                <strong>{p.name}</strong>
                <p>
                  Stock bajo: {p.stock / 1000} {p.unit}. Mínimo:{" "}
                  {p.minimum / 1000} {p.unit}.
                </p>
              </div>
              <button
                className="icon-button"
                aria-label={`Ver ${p.name}`}
                onClick={() => {
                  navigate("/app/inventario?q=" + encodeURIComponent(p.name));
                  setNotifications(false);
                }}
              >
                <ArrowRight />
              </button>
            </div>
          ))
        ) : (
          <Empty
            title="Todo en orden"
            description="No hay alertas de stock bajo."
          />
        )}
      </Modal>
      <Modal
        title="Tu espacio de trabajo"
        open={profile}
        onClose={() => setProfile(false)}
      >
        <div className="profile-detail">
          <Avatar name={user.name} color={user.color} size={56} />
          <div>
            <h3>{user.name}</h3>
            <p>{user.email}</p>
            <small>{roleLabels[user.role]}</small>
          </div>
        </div>
        {state.demo && (
          <>
            <h3>Explorar permisos</h3>
            <p className="muted">
              Cada sesión aplica las restricciones reales de la API.
            </p>
            <div className="role-options">
              {[
                { id: "owner", name: "Dueño · vista consolidada" },
                { id: "admin", name: "Gerente · operación del club" },
                { id: "r1", name: "Lucía · sus lotes y ventas" },
                { id: "cashier", name: "Cajero · ventas y stock" },
                { id: "viewer", name: "Solo lectura" },
              ].map((r) => (
                <button
                  className="button"
                  key={r.id}
                  onClick={() =>
                    void send<{ user: User }>("/auth/demo", { id: r.id })
                      .then(({ user }) => {
                        onUser(user);
                        navigate("/app");
                      })
                      .catch((e) => toast.error(e.message))
                  }
                >
                  {r.name}
                  <ArrowRight />
                </button>
              ))}
            </div>
          </>
        )}
      </Modal>
    </ClubProvider>
  );
}
