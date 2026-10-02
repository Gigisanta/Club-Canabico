import { useEffect, useState } from "react";
import { apiGet } from "./api";

export function useRemote<T>(path: string | null, refreshKey: number) {
  const [state, setState] = useState<{ path: string | null; refreshKey: number; retryKey: number; data: T | null; loading: boolean; error: string }>({ path: null, refreshKey: -1, retryKey: -1, data: null, loading: false, error: "" });
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!path) {
      setState({ path: null, refreshKey, retryKey, data: null, loading: false, error: "" });
      return;
    }
    const controller = new AbortController();
    setState(previous => ({ path, refreshKey, retryKey, data: previous.path === path ? previous.data : null, loading: true, error: "" }));
    apiGet<T>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setState({ path, refreshKey, retryKey, data: value, loading: false, error: "" });
    }).catch(cause => {
      if (!controller.signal.aborted) setState(previous => ({
        path,
        refreshKey,
        retryKey,
        data: previous.path === path ? previous.data : null,
        loading: false,
        error: cause instanceof Error ? cause.message : "No se pudo cargar esta sección.",
      }));
    });
    return () => controller.abort();
  }, [path, refreshKey, retryKey]);

  const current = state.path === path;
  const currentRequest = current && state.refreshKey === refreshKey && state.retryKey === retryKey;
  return {
    data: current ? state.data : null,
    loading: Boolean(path) && (!currentRequest || state.loading),
    error: currentRequest ? state.error : "",
    retry: () => setRetryKey(key => key + 1),
  };
}
