import cors from "cors";
import express from "express";
import type { Network } from "./horizon.js";
import { buildHealthResponse } from "./metrics.js";
import { startPolling, stores } from "./poller.js";
import type { RecentFeesResponse, RecentLedgersResponse } from "./types.js";

const PORT = Number(process.env.PORT ?? 4000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 6000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";

function parseNetwork(req: express.Request): Network {
  return req.query.network === "testnet" ? "testnet" : "mainnet";
}

export function createApp(): express.Express {
  const app = express();
  app.use(cors({ origin: CORS_ORIGIN }));

  app.get("/api/health", (req, res) => {
    const network = parseNetwork(req);
    res.json(buildHealthResponse(network));
  });

  app.get("/api/ledgers/recent", (req, res) => {
    const network = parseNetwork(req);
    const store = stores[network] ?? stores.mainnet;
    const body: RecentLedgersResponse = { ledgers: store.getLedgers() };
    res.json(body);
  });

  app.get("/api/fees/recent", (req, res) => {
    const network = parseNetwork(req);
    const store = stores[network] ?? stores.mainnet;
    const body: RecentFeesResponse = { snapshots: store.getFeeSnapshots() };
    res.json(body);
  });

  return app;
}

export const app = createApp();

if (process.env.NODE_ENV !== "test") {
  startPolling(POLL_INTERVAL_MS);

  const server = (await import("http")).createServer(app);
  const { setupWebSocketServer } = await import("./ws.js");
  setupWebSocketServer(server);

  server.listen(PORT, () => {
    console.log(`NetPulse backend listening on http://localhost:${PORT}`);
  });
}
