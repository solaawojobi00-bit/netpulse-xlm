import cors from "cors";
import express from "express";
import type { Network } from "./horizon.js";
import { buildHealthResponse } from "./metrics.js";
import { historyExportFilename, historyToCsv } from "./csv.js";
import { db } from "./db.js";
import {
  buildOperationBreakdownResponse,
  buildSorobanResponse,
  startPolling,
  stores,
} from "./poller.js";
import { logger } from "./logger.js";
import { allowedOrigins, allowsAnyOrigin } from "./origins.js";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, createShutdownRunner } from "./shutdown.js";
import type { RecentFeesResponse, RecentLedgersResponse } from "./types.js";

const PORT = Number(process.env.PORT ?? 4000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 6000);
const SHUTDOWN_TIMEOUT_MS = Number(
  process.env.SHUTDOWN_TIMEOUT_MS ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
);

function parseNetwork(req: express.Request): Network {
  return req.query.network === "testnet" ? "testnet" : "mainnet";
}

export function createApp(): express.Express {
  const app = express();
  // Same allowlist the WebSocket upgrade uses, so CORS_ORIGIN governs both.
  app.use(cors({ origin: allowsAnyOrigin() ? true : allowedOrigins }));

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

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

  app.get("/api/history", (req, res) => {
    const network = parseNetwork(req);
    const range = req.query.range === "12h" ? 12 : req.query.range === "6h" ? 6 : 24;
    const history = db.getHistory(network, range);

    /*
     * Export is a representation of the same resource, so it shares this route
     * and its network/range parsing rather than duplicating them in a second
     * endpoint that could drift.
     *
     * Only an explicit format triggers a download. With no format the response
     * is byte-identical to before and carries no Content-Disposition, so the
     * frontend's existing fetch of this endpoint is unaffected.
     */
    const format = typeof req.query.format === "string" ? req.query.format : undefined;

    if (format === "csv") {
      res
        .type("text/csv; charset=utf-8")
        .setHeader(
          "Content-Disposition",
          `attachment; filename="${historyExportFilename(history, "csv")}"`,
        );
      res.send(historyToCsv(history));
      return;
    }

    if (format === "json") {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${historyExportFilename(history, "json")}"`,
      );
      res.json(history);
      return;
    }

    res.json(history);
  });

  app.get("/api/soroban", (req, res) => {
    const network = parseNetwork(req);
    res.json(buildSorobanResponse(network));
  });

  /*
   * A separate route rather than an addition to /api/soroban: that response is
   * specifically about contract invocations, and the breakdown is about all
   * operation types. Folding one into the other would make /api/soroban a
   * grab-bag named after only part of what it returns.
   */
  app.get("/api/operations/breakdown", (req, res) => {
    const network = parseNetwork(req);
    res.json(buildOperationBreakdownResponse(network));
  });

  return app;
}

export const app = createApp();

// Signal handlers are registered only on this path, so the test path in this
// file neither starts a server nor leaks listeners between test files.
if (process.env.NODE_ENV !== "test") {
  const streaming = startPolling(POLL_INTERVAL_MS);

  const server = (await import("http")).createServer(app);
  const { closeWebSocketServer, setupWebSocketServer } = await import("./ws.js");
  const wss = setupWebSocketServer(server);

  server.listen(PORT, () => {
    logger.info(`NetPulse backend listening on http://localhost:${PORT}`, {
      component: "server",
      port: PORT,
    });
  });

  const shutdown = createShutdownRunner({
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    run: async () => {
      /*
       * Ordering matters more than any individual step here:
       *
       * 1. Stop accepting new connections immediately, but only *await* the
       *    close later — in-flight requests still need to finish.
       * 2. Close WebSockets next. They are connections on this same server,
       *    so the close in step 3 cannot complete while they are open.
       * 3. Drop idle keep-alive sockets, which hold the server open despite
       *    having no request in flight, then wait for the drain.
       * 4. Stop the poll interval and the SSE loops.
       * 5. Close the database last, once nothing is left that might write.
       */
      const httpClosed = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });

      await closeWebSocketServer(wss);
      server.closeIdleConnections();
      await httpClosed;

      await streaming.stop();

      db.close();
    },
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
