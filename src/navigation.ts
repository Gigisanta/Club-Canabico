import {
  ChartBar, ChatCircleDots, GearSix, House, Package, Receipt,
  Storefront, Users,
} from "@phosphor-icons/react";
import type { Role } from "../shared/types";

const managers: Role[] = ["owner", "admin"];
const exceptCashier: Role[] = ["owner", "admin", "responsible", "viewer"];
const everyone: Role[] = ["owner", "admin", "responsible", "cashier", "viewer"];

export const navigationHubs = [
  {
    id: "inicio", label: "Inicio", icon: House,
    items: [
      { path: "/app", label: "Resumen de hoy", aliases: ["Resumen", "Inicio"], roles: everyone },
      { path: "/app/panorama", label: "Panorama general", aliases: ["Dashboard"], roles: everyone },
      { path: "/app/decisiones", label: "Centro de decisiones", aliases: ["Decisiones"], roles: managers },
    ],
  },
  {
    id: "ventas", label: "Ventas y caja", icon: Receipt,
    items: [
      { path: "/app/ventas", label: "Ventas", aliases: ["Ventas y caja", "Registrar venta"], roles: everyone },
      { path: "/app/gastos", label: "Gastos", aliases: [], roles: exceptCashier },
      { path: "/app/finanzas", label: "Caja y planificación", aliases: ["Finanzas"], roles: managers },
      { path: "/app/decisiones/comercial", label: "Precios y promociones", aliases: ["Análisis comercial"], roles: managers },
      { path: "/app/decisiones/caja", label: "Análisis de caja", aliases: [], roles: managers },
    ],
  },
  {
    id: "stock", label: "Stock", icon: Package,
    items: [
      { path: "/app/inventario", label: "Inventario", aliases: ["Productos", "Movimientos", "Proveedores", "Ubicaciones"], roles: everyone },
      { path: "/app/decisiones/stock", label: "Análisis de stock", aliases: [], roles: managers },
    ],
  },
  {
    id: "socios", label: "Socios", icon: Users,
    items: [
      { path: "/app/socios", label: "Directorio", aliases: ["Socios y fidelización", "Fichas"], roles: everyone },
      { path: "/app/decisiones/socios", label: "Segmentos de socios", aliases: [], roles: managers },
    ],
  },
  {
    id: "web", label: "Web pública", icon: Storefront,
    items: [
      { path: "/app/consultas", label: "Consultas", aliases: ["Bandeja de consultas"], roles: managers },
      { path: "/app/vidriera", label: "Vidriera", aliases: [], roles: managers },
      { path: "/app/configuracion?tab=public", label: "Canales públicos", aliases: ["Canales del club"], roles: managers },
    ],
  },
  {
    id: "administracion", label: "Administración", icon: GearSix,
    items: [
      { path: "/app/responsables", label: "Responsables", aliases: [], roles: exceptCashier },
      { path: "/app/reportes", label: "Reportes", aliases: [], roles: exceptCashier },
      { path: "/app/preparar", label: "Preparar decisiones", aliases: [], roles: managers },
      { path: "/app/importar", label: "Importar y conciliar", aliases: [], roles: managers },
      { path: "/app/configuracion", label: "Configuración", aliases: ["Ajustes", "Equipo y permisos"], roles: everyone },
    ],
  },
] as const;

export function hubsForRole(role: Role) {
  return navigationHubs.map((hub) => ({
    ...hub,
    items: hub.items.filter((item) => item.roles.some((allowed) => allowed === role)),
  })).filter((hub) => hub.items.length > 0);
}

export function canVisit(path: string, role: Role) {
  return navigationHubs.some((hub) => hub.items.some((item) =>
    item.path.split("?")[0] === path && item.roles.some((allowed) => allowed === role)));
}

export function currentDestination(pathname: string, search: string, role: Role) {
  const path = pathname.replace(/\/$/, "") || "/app";
  const tab = new URLSearchParams(search).get("tab");
  const hubs = hubsForRole(role);
  for (const hub of hubs) {
    const item = hub.items.find((entry) => entry.path === `${path}?tab=${tab}`);
    if (item) return { hub, item };
  }
  for (const hub of hubs) {
    const item = hub.items.find((entry) => entry.path === path);
    if (item) return { hub, item };
  }
  return null;
}

export function searchDestinations(role: Role, query: string) {
  const needle = query.trim().toLocaleLowerCase("es-AR");
  return hubsForRole(role).flatMap((hub) => hub.items
    .filter((item) => [hub.label, item.label, ...item.aliases].some((label) => label.toLocaleLowerCase("es-AR").includes(needle)))
    .map((item) => ({ name: item.label, type: hub.label, path: item.path })));
}
