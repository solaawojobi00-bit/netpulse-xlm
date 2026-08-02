import cors from "cors";
import express from "express";
import { buildHealthResponse } from "./metrics.js";
import { startPolling, store } from "./poller.js";
import type { RecentLedgersResponse } from "./types.js";

const PORT = Number(process.env.PORT ?? 4000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 6000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:5173";

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));

app.get("/api/health", (_req, res) => {
  res.json(buildHealthResponse());
});

app.get("/api/ledgers/recent", (_req, res) => {
  const body: RecentLedgersResponse = { ledgers: store.getLedgers() };
  res.json(body);
});

startPolling(POLL_INTERVAL_MS);

app.listen(PORT, () => {
  console.log(`NetPulse backend listening on http://localhost:${PORT}`);
});
