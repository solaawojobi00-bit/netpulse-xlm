import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { isOriginAllowed, parseAllowedOrigins } from "./origins.js";
import { setupWebSocketServer } from "./ws.js";

describe("parseAllowedOrigins", () => {
  it("falls back to the Vite dev server so local development needs no config", () => {
    expect(parseAllowedOrigins(undefined)).toEqual(["http://localhost:5173"]);
    expect(parseAllowedOrigins("   ")).toEqual(["http://localhost:5173"]);
  });

  it("splits a comma-separated list and trims whitespace", () => {
    expect(parseAllowedOrigins("https://a.example, https://b.example")).toEqual([
      "https://a.example",
      "https://b.example",
    ]);
  });

  it("normalises trailing slashes so both spellings match", () => {
    expect(parseAllowedOrigins("https://a.example/")).toEqual(["https://a.example"]);
  });
});

describe("isOriginAllowed", () => {
  const origins = ["http://localhost:5173", "https://netpulse.example"];

  it("allows a listed origin", () => {
    expect(isOriginAllowed("http://localhost:5173", origins)).toBe(true);
    expect(isOriginAllowed("https://netpulse.example", origins)).toBe(true);
  });

  it("rejects an unlisted origin", () => {
    expect(isOriginAllowed("https://evil.example", origins)).toBe(false);
  });

  it("allows a request with no Origin header (non-browser clients)", () => {
    // Documented decision: browsers always send Origin, so cross-site
    // hijacking cannot happen without one; anything else can forge it anyway.
    expect(isOriginAllowed(undefined, origins)).toBe(true);
  });

  it("allows every origin when configured with *", () => {
    expect(isOriginAllowed("https://evil.example", ["*"])).toBe(true);
  });
});

describe("WebSocket handshake origin validation", () => {
  let server: Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function listen(): Promise<number> {
    server = createServer();
    setupWebSocketServer(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    return (server.address() as AddressInfo).port;
  }

  function connect(port: number, origin?: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    return new Promise<{ opened: boolean; status?: number }>((resolve) => {
      ws.on("open", () => {
        ws.close();
        resolve({ opened: true });
      });
      // `ws` surfaces an upgrade rejection as an "unexpected-response" event
      // carrying the HTTP status, which is what proves the connection was
      // refused during the handshake rather than accepted and closed after.
      ws.on("unexpected-response", (_req, res) => {
        resolve({ opened: false, status: res.statusCode });
      });
      ws.on("error", () => resolve({ opened: false }));
    });
  }

  it("accepts a connection from the default allowed origin", async () => {
    const port = await listen();
    await expect(connect(port, "http://localhost:5173")).resolves.toMatchObject({
      opened: true,
    });
  });

  it("refuses a disallowed origin at the upgrade stage with 403", async () => {
    const port = await listen();
    const result = await connect(port, "https://evil.example");

    expect(result.opened).toBe(false);
    expect(result.status).toBe(403);
  });

  it("accepts a client that sends no Origin header", async () => {
    const port = await listen();
    await expect(connect(port)).resolves.toMatchObject({ opened: true });
  });

  it("closes upgrades on unknown paths instead of leaking the socket", async () => {
    const port = await listen();
    const other = new WebSocket(`ws://127.0.0.1:${port}/not-ws`, {
      origin: "http://localhost:5173",
    });

    const outcome = await new Promise<{ kind: string; status?: number }>((resolve) => {
      other.on("open", () => resolve({ kind: "opened" }));
      other.on("unexpected-response", (_req, res) =>
        resolve({ kind: "rejected", status: res.statusCode }),
      );
      other.on("error", () => resolve({ kind: "error" }));
    });

    expect(outcome.kind).toBe("rejected");
    expect(outcome.status).toBe(404);
  });
});
