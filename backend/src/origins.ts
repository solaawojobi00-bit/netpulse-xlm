const DEFAULT_CORS_ORIGIN = "http://localhost:5173";

/**
 * Allowed origins, parsed from CORS_ORIGIN. The variable was single-valued;
 * it now accepts a comma-separated list so the REST API and the WebSocket
 * upgrade share one place to configure who may connect.
 *
 * `*` disables origin checking entirely, for deployments that intentionally
 * serve a public read-only feed.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const value = raw?.trim() ? raw : DEFAULT_CORS_ORIGIN;
  return value
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => origin.length > 0);
}

export const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGIN);

export function allowsAnyOrigin(origins: string[] = allowedOrigins): boolean {
  return origins.includes("*");
}

/**
 * A browser always sends `Origin` on a WebSocket handshake, so the
 * cross-site hijacking this guards against cannot happen without one.
 * Non-browser clients (curl, monitoring scripts, container health checks)
 * send no Origin at all, and blocking them would break those callers while
 * stopping no attack — anything outside a browser can set Origin to whatever
 * it likes. So an absent Origin is allowed, and only a present-but-unlisted
 * one is refused.
 */
export function isOriginAllowed(
  origin: string | undefined,
  origins: string[] = allowedOrigins,
): boolean {
  if (allowsAnyOrigin(origins)) return true;
  if (origin === undefined) return true;
  return origins.includes(origin.trim().replace(/\/+$/, ""));
}
