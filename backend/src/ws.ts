import type { Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import type { Network } from "./horizon.js";
import { logger } from "./logger.js";
import { buildHealthResponse } from "./metrics.js";
import { isOriginAllowed } from "./origins.js";
import { buildSorobanResponse, onStoreUpdate, stores } from "./poller.js";

const WS_PATH = "/ws";

interface ClientState {
  network: Network;
}

export function setupWebSocketServer(server: Server): WebSocketServer {
  /*
   * `noServer` rather than `{ server }` so the handshake can be refused at the
   * upgrade stage with a real HTTP status. Accepting the socket and closing it
   * afterwards would still run the connection handler and hand the caller an
   * open WebSocket first.
   */
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Map<WebSocket, ClientState>();

  server.on("upgrade", (req, socket, head) => {
    /*
     * `/ws` is the only upgrade endpoint. Anything else is closed rather than
     * left hanging: returning early would leak the socket, since no other
     * handler is listening to finish it.
     */
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    const origin = req.headers.origin;
    if (!isOriginAllowed(origin)) {
      logger.warn("Rejected WebSocket handshake from disallowed origin", {
        component: "ws",
        origin,
        path: pathname,
      });
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

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
