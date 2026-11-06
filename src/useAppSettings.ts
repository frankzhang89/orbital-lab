import { useCallback, useEffect, useState } from "react";
import { isAppSettings, type AppSettings } from "./settings";

type SettingsState =
  | { status: "loading" | "error"; settings: null }
  | { status: "ready"; settings: AppSettings };

/** Fail closed for configuration writes without blocking the simulation. */
export function useAppSettings() {
  const [state, setState] = useState<SettingsState>({ status: "loading", settings: null });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: "loading", settings: null });
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // An unresponsive server must still expose a retry instead of loading forever.
    const timer = setTimeout(() => {
      controller.abort();
      setState({ status: "error", settings: null });
    }, 10000);
    void (async () => {
      try {
        const response = await fetch("/api/settings", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Settings request failed.");
        const settings: unknown = await response.json();
        if (!isAppSettings(settings)) throw new Error("Invalid settings response.");
        if (!controller.signal.aborted) setState({ status: "ready", settings });
      } catch {
        if (!controller.signal.aborted) setState({ status: "error", settings: null });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [attempt]);
  return { ...state, retry, readOnly: state.status !== "ready" || state.settings.demoMode };
}
