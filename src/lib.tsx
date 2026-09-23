import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ClubState, User } from "../shared/types";
export type {
  ClubState,
  User,
  Product,
  Customer,
  Sale,
  Settings,
  Expense,
} from "../shared/types";
export { roleLabels } from "../shared/types";
export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/api${url}`, {
    credentials: "include",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ error: "No se pudo conectar con el servidor" }));
    throw new Error(body.error || "Error de servidor");
  }
  return res.json();
}
export const send = <T,>(url: string, body: unknown, method = "POST") =>
  api<T>(url, { method, body: JSON.stringify(body) });
export function useResource<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!url) {
      setLoading(false);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    try {
      const value = await api<T>(url);
      if (id === seq.current) {
        setData(value);
        setError("");
      }
    } catch (e) {
      if (id === seq.current) setError((e as Error).message);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => {
    setData(null);
    void reload();
    return () => {
      seq.current++;
    };
  }, [reload]);
  return { data, error, loading, reload };
}
export const money = (cents: number, currency = "ARS") =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(cents / 100);
export const number = (n: number) =>
  new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" }).format(
    new Date(`${date.slice(0, 10)}T12:00:00`),
  );
export const initials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((n) => n[0])
    .join("");
export const daysBetween = (a: string, b: string) =>
  Math.floor(
    (Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86400000,
  );
export const offsetDate = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
interface Context {
  state: ClubState;
  reload: () => Promise<void>;
  owner: string;
  setOwner: (id: string) => void;
  money: (n: number) => string;
  canManage: boolean;
  canSell: boolean;
  isManager: boolean;
  user: User;
  logout: () => void;
}
const ClubContext = createContext<Context | null>(null);
export const useClub = () => {
  const c = useContext(ClubContext);
  if (!c) throw new Error("Falta ClubProvider");
  return c;
};
export function ClubProvider({
  value,
  children,
}: {
  value: Context;
  children: ReactNode;
}) {
  return <ClubContext.Provider value={value}>{children}</ClubContext.Provider>;
}
export function download(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.append(a);
  a.click();
  a.remove();
}
