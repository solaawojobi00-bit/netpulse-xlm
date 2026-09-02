import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "./useTheme";

const STORAGE_KEY = "netpulse:theme";

type Listener = (event: { matches: boolean }) => void;

let emitPreferenceChange: ((matches: boolean) => void) | null = null;

function stubPrefersLight(matches: boolean) {
  const listeners: Listener[] = [];
  emitPreferenceChange = (next) => {
    for (const listener of listeners) listener({ matches: next });
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("prefers-color-scheme: light") ? matches : false,
      media: query,
      addEventListener: (_: string, listener: Listener) => listeners.push(listener),
      removeEventListener: (_: string, listener: Listener) => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      },
    })),
  );
}

function Probe() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" onClick={toggleTheme}>
      {theme}
    </button>
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  emitPreferenceChange = null;
  vi.unstubAllGlobals();
});

describe("useTheme", () => {
  it("defaults to dark when nothing is stored and the system prefers dark", () => {
    stubPrefersLight(false);
    render(<Probe />);

    expect(screen.getByRole("button")).toHaveTextContent("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("defaults to light when the system prefers light", () => {
    stubPrefersLight(true);
    render(<Probe />);

    expect(screen.getByRole("button")).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("prefers a stored choice over the system preference", () => {
    stubPrefersLight(true);
    localStorage.setItem(STORAGE_KEY, "dark");
    render(<Probe />);

    expect(screen.getByRole("button")).toHaveTextContent("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores an unrecognised stored value", () => {
    stubPrefersLight(false);
    localStorage.setItem(STORAGE_KEY, "solarized");
    render(<Probe />);

    expect(screen.getByRole("button")).toHaveTextContent("dark");
  });

  it("toggles the theme and persists the new preference", () => {
    stubPrefersLight(false);
    render(<Probe />);
    const button = screen.getByRole("button");

    act(() => button.click());

    expect(button).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");

    act(() => button.click());

    expect(button).toHaveTextContent("dark");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });

  it("still renders when localStorage is unavailable", () => {
    stubPrefersLight(false);
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    expect(() => render(<Probe />)).not.toThrow();
    expect(screen.getByRole("button")).toHaveTextContent("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it("falls back to dark when matchMedia is unsupported", () => {
    vi.stubGlobal("matchMedia", undefined);
    render(<Probe />);

    expect(screen.getByRole("button")).toHaveTextContent("dark");
  });

  it("stores nothing until the visitor makes an explicit choice", () => {
    // Persisting the resolved theme on mount would freeze the system
    // preference and make later OS theme changes have no effect.
    stubPrefersLight(true);
    render(<Probe />);

    expect(screen.getByRole("button")).toHaveTextContent("light");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("follows later OS changes while no choice has been stored", () => {
    stubPrefersLight(false);
    render(<Probe />);
    expect(screen.getByRole("button")).toHaveTextContent("dark");

    act(() => emitPreferenceChange?.(true));

    expect(screen.getByRole("button")).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("stops following the OS once a choice has been stored", () => {
    stubPrefersLight(false);
    render(<Probe />);
    const button = screen.getByRole("button");

    act(() => button.click()); // explicit choice: light
    expect(button).toHaveTextContent("light");

    act(() => emitPreferenceChange?.(false)); // OS flips to dark

    expect(button).toHaveTextContent("light");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
  });

  it("adopts the theme already painted by the inline script", () => {
    // The inline script resolves the preference before first paint; React must
    // not disagree with what is on screen.
    stubPrefersLight(false);
    document.documentElement.setAttribute("data-theme", "light");
    render(<Probe />);

    expect(screen.getByRole("button")).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("ignores a malformed painted value and resolves the preference itself", () => {
    stubPrefersLight(true);
    document.documentElement.setAttribute("data-theme", "neon");
    render(<Probe />);

    expect(screen.getByRole("button")).toHaveTextContent("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
