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
  Supplier,
  Location,
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
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const res = await fetch(`/api${url}`, {
    ...options,
    credentials: options.credentials ?? "include",
    cache: "no-store",
    headers,
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
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [errorUrl, setErrorUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [settledUrl, setSettledUrl] = useState<string | null>(null);
  const seq = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    const id = ++seq.current;
    controller.current?.abort();
    if (!url) {
      setData(null);
      setDataUrl(null);
      setError("");
      setErrorUrl(null);
      setSettledUrl(null);
      setLoading(false);
      return;
    }
    const request = new AbortController();
    controller.current = request;
    // Keep the same resource mounted during a refresh. A URL change is hidden
    // by dataUrl below, and a failed refresh removes its previous result.
    setError("");
    setErrorUrl(null);
    setSettledUrl(null);
    setLoading(true);
    try {
      const value = await api<T>(url, { signal: request.signal });
      if (id === seq.current && !request.signal.aborted) {
        setData(value);
        setDataUrl(url);
      }
    } catch (e) {
      if (id === seq.current && !request.signal.aborted) {
        setData(null);
        setDataUrl(null);
        setError((e as Error).message);
        setErrorUrl(url);
      }
    } finally {
      if (controller.current === request) controller.current = null;
      if (id === seq.current && !request.signal.aborted) {
        setSettledUrl(url);
        setLoading(false);
      }
    }
  }, [url]);
  useEffect(() => {
    void reload();
    return () => {
      seq.current++;
      controller.current?.abort();
      controller.current = null;
    };
  }, [reload]);
  return {
    data: url && dataUrl === url ? data : null,
    error: url && errorUrl === url ? error : "",
    loading: Boolean(url) && (loading || settledUrl !== url),
    reload,
  };
}
const currencyFormatters = new Map(["ARS", "USD"].map(currency => [currency,
  new Intl.NumberFormat("es-AR", { style: "currency", currency, maximumFractionDigits: 2 }),
]));
const numberFormatter = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 });
const dateFormatter = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" });
export const money = (cents: number, currency = "ARS") =>
  (currencyFormatters.get(currency) ?? new Intl.NumberFormat("es-AR", {
    style: "currency", currency, maximumFractionDigits: 2,
  })).format(cents / 100);
export const number = (n: number) => numberFormatter.format(n);
export const shortDate = (date: string) =>
  dateFormatter.format(
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
