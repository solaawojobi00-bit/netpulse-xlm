import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * `API_BASE_URL` is a module-level constant, because Vite substitutes
 * `import.meta.env.VITE_*` statically at build time and reading it per call
 * would misrepresent that. So a test cannot stub the variable and re-read the
 * export — it has to re-import the module after stubbing, which is what this
 * helper does. `resetModules` is the important half: without it the second
 * import returns the first one's cached evaluation and every case after the
 * first silently asserts the same value.
 */
async function loadConfig(env: { api?: string; ws?: string }) {
  vi.resetModules();
  vi.stubEnv("VITE_API_URL", env.api ?? "");
  vi.stubEnv("VITE_WS_URL", env.ws ?? "");
  return await import("./config");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("API_BASE_URL", () => {
  it("is empty when VITE_API_URL is unset, preserving same-origin requests", async () => {
    const { API_BASE_URL } = await loadConfig({});
    expect(API_BASE_URL).toBe("");
    // The property that keeps every existing call site working untouched.
    expect(`${API_BASE_URL}/api/health`).toBe("/api/health");
  });

  it("uses an absolute origin when set", async () => {
    const { API_BASE_URL } = await loadConfig({ api: "https://api.example" });
    expect(`${API_BASE_URL}/api/health`).toBe("https://api.example/api/health");
  });

  it("strips trailing slashes so the joined path never doubles up", async () => {
    const { API_BASE_URL } = await loadConfig({ api: "https://api.example//" });
    expect(`${API_BASE_URL}/api/health`).toBe("https://api.example/api/health");
  });

  it("ignores surrounding whitespace", async () => {
    const { API_BASE_URL } = await loadConfig({
      api: "  https://api.example  ",
    });
    expect(API_BASE_URL).toBe("https://api.example");
  });
});

describe("wsUrl", () => {
  it("falls back to the page origin when nothing is configured", async () => {
    const { wsUrl } = await loadConfig({});
    // jsdom serves the suite over http://localhost:3000 by default.
    expect(wsUrl()).toBe(`ws://${window.location.host}/ws`);
  });

  it("derives ws from an http API origin", async () => {
    const { wsUrl } = await loadConfig({ api: "http://localhost:4000" });
    expect(wsUrl()).toBe("ws://localhost:4000/ws");
  });

  it("derives wss from an https API origin", async () => {
    const { wsUrl } = await loadConfig({ api: "https://api.example" });
    expect(wsUrl()).toBe("wss://api.example/ws");
  });

  it("prefers an explicit VITE_WS_URL over the derived value", async () => {
    const { wsUrl } = await loadConfig({
      api: "https://api.example",
      ws: "wss://sockets.example",
    });
    expect(wsUrl()).toBe("wss://sockets.example/ws");
  });

  it("does not double the path when the override already names it", async () => {
    const { wsUrl } = await loadConfig({ ws: "wss://sockets.example/ws" });
    expect(wsUrl()).toBe("wss://sockets.example/ws");
  });
});
