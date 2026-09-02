import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

// Kept in sync with the pre-paint inline script in index.html.
const STORAGE_KEY = "netpulse:theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/*
 * The inline script in index.html has already resolved stored-preference →
 * system-preference and stamped the result on <html>, so adopting that value
 * keeps React's state identical to what the user is actually looking at.
 */
function paintedTheme(): Theme | null {
  const painted = document.documentElement.getAttribute("data-theme");
  return isTheme(painted) ? painted : null;
}

function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isTheme(stored) ? stored : null;
  } catch {
    // Storage can throw when cookies/site data are blocked; fall back to the
    // system preference rather than failing to render.
    return null;
  }
}

function systemTheme(): Theme {
  if (typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => paintedTheme() ?? readStoredTheme() ?? systemTheme(),
  );

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  /*
   * Keep following the OS for as long as the visitor has not made a choice of
   * their own. Without this, the first render would pin whatever the system
   * preference happened to be at load time.
   */
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (event: MediaQueryListEvent) => {
      if (readStoredTheme() === null) setTheme(event.matches ? "light" : "dark");
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  /*
   * Only an explicit toggle is written to storage. Persisting the resolved
   * theme on mount instead would turn an implicit system preference into a
   * stored choice, and the app would then ignore later OS theme changes.
   */
  const toggleTheme = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this session; it just is not remembered.
    }
    setTheme(next);
  }, [theme]);

  return { theme, toggleTheme };
}
