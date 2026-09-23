import { useEffect, useState, lazy, Suspense } from "react";
import {
  NavLink,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  SquaresFour,
  Package,
  Users,
  Receipt,
  Wallet,
  Plant,
  ChartBar,
  GearSix,
  Bell,
  MagnifyingGlass,
  CaretDown,
  Plus,
  SignOut,
  List,
  ArrowSquareOut,
  CircleNotch,
  ShieldCheck,
  ArrowRight,
  X,
  UploadSimple,
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
import { Dashboard } from "./Dashboard";
import Sales, { SaleModal } from "./Sales";
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
const navigation = [
  { path: "/", label: "Resumen general", icon: SquaresFour },
  { path: "/inventario", label: "Inventario", icon: Package },
  { path: "/socios", label: "Socios y fidelización", icon: Users },
  { path: "/ventas", label: "Ventas y caja", icon: Receipt },
  { path: "/gastos", label: "Gastos", icon: Wallet },
  { path: "/finanzas", label: "Caja y planificación", icon: ChartBar },
  { path: "/responsables", label: "Responsables", icon: Plant },
  { path: "/reportes", label: "Reportes", icon: ChartBar },
];
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
        <small>Gestión con raíces. Visión de futuro.</small>
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
  const [menu, setMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [notifications, setNotifications] = useState(false);
  const [profile, setProfile] = useState(false);
  const resource = useResource<ClubState>(
    `/state${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`,
  );
  const state = resource.data;
  const location = useLocation();
  const navigate = useNavigate();
  const isManager = ["owner", "admin"].includes(user.role);
  const canManage = ["owner", "admin", "responsible"].includes(user.role);
  const canSell = user.role !== "viewer" && Boolean(state?.operationsEnabled);
  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);
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
  const low = state.products.filter((p) => p.stock <= p.minimum);
  const alerts = low.length;
  const nav = navigation.filter(
    (n) =>
      (user.role !== "cashier" || !["/gastos", "/finanzas", "/reportes", "/responsables"].includes(n.path)) &&
      (isManager || n.path !== "/finanzas"),
  );
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
            onClick={() => setMenu(false)}
          />
        )}
        <aside className={`sidebar ${menu ? "open" : ""}`}>
          <Brand />
          <button
            className="club-switch"
            onClick={() => navigate("/configuracion")}
          >
            <span className="club-avatar">
              <Plant weight="duotone" size={23} />
            </span>
            <span>
              <strong>{state.settings.clubName}</strong>
              <small>Espacio de trabajo</small>
            </span>
            <CaretDown size={14} />
          </button>
          <div className="nav-label">PRINCIPAL</div>
          <nav>
            {nav.map(({ path, label, icon: Icon }) => (
              <NavLink key={path} to={path} end={path === "/"}>
                <Icon size={21} />
                <span>{label}</span>
                {path === "/inventario" && alerts > 0 && (
                  <span className="nav-count">{alerts}</span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="club-health">
              <span className="live-dot" />
              <strong>Todo tu club, conectado</strong>
              <p>
                La información que necesitás,
                <br />
                justo donde la necesitás.
              </p>
            </div>
            <NavLink className="settings-link" to="/configuracion">
              <GearSix size={21} />
              Configuración
            </NavLink>
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
        <div className="workspace">
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon-button mobile-menu"
                aria-label="Abrir navegación"
                onClick={() => setMenu(true)}
              >
                <List size={23} />
              </button>
              <span>Mi club</span>
              <span className="breadcrumb-slash">/</span>
              <strong>
                {navigation.find((n) => n.path === location.pathname)?.label ||
                  "Configuración"}
              </strong>
            </div>
            <div className="top-actions">
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
          <main className="main-content">
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
                  Vista de reprogram:{" "}
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
              <Routes key={location.pathname + location.search}>
                <Route
                  path="/"
                  element={<Dashboard onSale={() => setSaleOpen(true)} />}
                />
                <Route path="/inventario" element={<Inventory />} />
                <Route path="/socios" element={<Customers />} />
                <Route path="/finanzas" element={isManager ? <Finance /> : <Navigate to="/" replace />} />
                <Route
                  path="/ventas"
                  element={<Sales onSale={() => setSaleOpen(true)} />}
                />
                <Route
                  path="/gastos"
                  element={
                    user.role === "cashier" ? <Navigate to="/" /> : <Expenses />
                  }
                />
                <Route
                  path="/responsables"
                  element={
                    user.role === "cashier" ? (
                      <Navigate to="/" />
                    ) : (
                      <Responsibles />
                    )
                  }
                />
                <Route
                  path="/reportes"
                  element={
                    user.role === "cashier" ? <Navigate to="/" /> : <Reports />
                  }
                />
                <Route path="/configuracion" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
            <footer className="app-footer">
              <span>Raíz · Cada dato, una mejor decisión.</span>
              <span>
                <span className="live-dot" />{" "}
                {resource.loading ? "Actualizando…" : "Datos conectados"}
              </span>
            </footer>
          </main>
        </div>
      </div>
      <SaleModal open={saleOpen} onClose={() => setSaleOpen(false)} />
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
            ...nav.map((n) => ({
              name: n.label,
              type: "Sección",
              path: n.path,
            })),
            ...state.products.map((p) => ({
              name: p.name,
              type: p.lot,
              path: "/inventario",
            })),
            ...state.customers.map((c) => ({
              name: c.name,
              type: "Socio",
              path: "/socios",
            })),
          ]
            .filter((x) => x.name.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 12)
            .map((x, i) => (
              <button
                key={i}
                onClick={() => {
                  navigate(
                    `${x.path}${query ? "?q=" + encodeURIComponent(query) : ""}`,
                  );
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
        </div>
      </Modal>
      <Modal
        title="Centro de notificaciones"
        description="Alertas actuales del inventario."
        open={notifications}
        onClose={() => setNotifications(false)}
      >
        {low.length ? (
          low.map((p) => (
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
                  navigate("/inventario?q=" + encodeURIComponent(p.name));
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
                { id: "r1", name: "Lucía · solo su reprogram" },
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
                        navigate("/");
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
