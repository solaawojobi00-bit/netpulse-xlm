import type { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { Network } from "./horizon.js";
import { buildHealthResponse } from "./metrics.js";
import { buildSorobanResponse, onStoreUpdate, stores } from "./poller.js";

interface ClientState {
  network: Network;
}

export function setupWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Map<WebSocket, ClientState>();

  function sendState(ws: WebSocket, network: Network) {
    if (ws.readyState === WebSocket.OPEN) {
      const store = stores[network] ?? stores.mainnet;
      ws.send(
        JSON.stringify({
          type: "snapshot",
          network,
          health: buildHealthResponse(network),
          ledgers: store.getLedgers(),
          fees: store.getFeeSnapshots(),
          soroban: buildSorobanResponse(network),
        }),
      );
    }
  }

  wss.on("connection", (ws) => {
    clients.set(ws, { network: "mainnet" });
    sendState(ws, "mainnet");

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "subscribe" || msg.type === "setNetwork") {
          const network: Network = msg.network === "testnet" ? "testnet" : "mainnet";
          clients.set(ws, { network });
          sendState(ws, network);
        }
      } catch {
        // Ignore malformed client messages
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });
  });

  onStoreUpdate((network) => {
    for (const [ws, state] of clients) {
      if (state.network === network) {
        sendState(ws, network);
      }
    }
  });

  return wss;
}

/**
 * Closes connected clients with a 1001 ("going away") close frame before
 * closing the server, so browsers see a deliberate shutdown and can back off
 * rather than treating it as a dropped connection.
 *
 * Must run before awaiting the HTTP server's close: WebSocket sockets are
 * connections on that same server, and leaving them open would keep
 * `server.close()` pending until the shutdown timeout fired.
 */
export function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    for (const client of wss.clients) {
      client.close(1001, "Server shutting down");
    }
    wss.close(() => resolve());
  });
}
