/// <reference types="vite/client" />

/*
 * Typing these makes a misspelled variable a `tsc -b` failure rather than a
 * runtime `undefined` that silently resolves to the same-origin default and
 * only shows up as failing requests in a deployed browser.
 *
 * Both are optional: unset means same origin. See config.ts for what that
 * means and frontend/.env.example for when to set them.
 */
interface ImportMetaEnv {
  /** Absolute backend origin for REST calls, e.g. `https://api.example.com`. */
  readonly VITE_API_URL?: string;
  /** Optional WebSocket origin override; derived from VITE_API_URL when unset. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
