/*
 * Where the backend lives.
 *
 * Until this module existed the frontend could only talk to a backend on its
 * own origin: `api.ts` used bare relative paths and `useSubscription.ts` built
 * the socket URL from `window.location.host`. That works in development only
 * because of the proxy in vite.config.ts, which applies to `vite dev` and
 * `vite preview` and never to a static production build — so a build deployed
 * to Vercel asked Vercel for `/api/*` and `/ws` and got nothing back.
 *
 * Both values are resolved once, here, rather than at each call site, so there
 * is a single place to reason about what an unset variable means.
 */

/** The path the backend serves the WebSocket on. Mirrors WS_PATH in backend/src/ws.ts. */
const WS_PATH = "/ws";

function normalizeOrigin(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

/**
 * Prefix for every REST call, with no trailing slash.
 *
 * Empty string means same origin, which is both the default and the behaviour
 * this app had before: `${API_BASE_URL}/api/health` collapses to
 * `/api/health`, so the dev proxy, `vite preview`, and the existing tests are
 * all unaffected when `VITE_API_URL` is unset. A deployment that needs a
 * cross-origin backend sets it to an absolute origin including the protocol,
 * e.g. `https://netpulse-backend-6myk.onrender.com`.
 *
 * Read at module scope on purpose: Vite substitutes `import.meta.env.VITE_*`
 * statically at build time, so these are build-time constants rather than
 * runtime lookups. Changing one in a host's dashboard requires a rebuild.
 */
export const API_BASE_URL = normalizeOrigin(import.meta.env.VITE_API_URL);

/**
 * Append the socket path unless the configured value already carries it, so
 * that both `wss://host` and `wss://host/ws` resolve to the same endpoint.
 * Someone setting a variable named `VITE_WS_URL` will reasonably write either.
 */
function withWsPath(origin: string): string {
  return origin.endsWith(WS_PATH) ? origin : `${origin}${WS_PATH}`;
}

/**
 * The WebSocket endpoint to connect to.
 *
 * Derived from `API_BASE_URL` by protocol swap rather than requiring a second
 * variable, because the socket shares the backend's single port (see the
 * `noServer: true` upgrade handler in backend/src/ws.ts) — so in every normal
 * deployment the two origins are the same, and two independently-set variables
 * could only drift apart. `VITE_WS_URL` remains as an explicit override for the
 * case where the socket genuinely is served elsewhere.
 *
 * With neither set this reproduces the previous same-origin behaviour exactly,
 * including deriving `wss:` from a page served over `https:`.
 */
export function wsUrl(): string {
  const override = normalizeOrigin(import.meta.env.VITE_WS_URL);
  if (override) return withWsPath(override);

  // `^http` covers both schemes in one step: http -> ws, https -> wss.
  if (API_BASE_URL) return withWsPath(API_BASE_URL.replace(/^http/, "ws"));

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${WS_PATH}`;
}
