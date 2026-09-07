import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:4000",
        ws: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    /*
     * Above vitest's 5s default because the accessibility suite runs axe over
     * the whole assembled App, which walks every node and takes seconds by
     * nature — it exceeds 5s on a loaded machine and then fails as a timeout
     * rather than as a real result. Raising the ceiling costs nothing when
     * tests pass and stops a slow machine from reading as a broken build.
     */
    testTimeout: 30000,

    coverage: {
      provider: "v8",

      /*
       * Explicit, and the most important line here — the same reasoning as
       * `backend/vitest.config.ts`. Without it v8 reports only the files a
       * test actually imported, so a brand-new component that nothing imports
       * is absent from the report rather than counted as zero: the total does
       * not move and the thresholds below wave it through.
       *
       * Measured rather than assumed. Two things were checked.
       *
       * First, on the tree as it stands, `include` already changes the answer
       * — 27 statements live in source files no test imports, usePolling.ts
       * chief among them:
       *
       *   without `include`   362/457 statements = 79.21%
       *   with `include`      362/484 statements = 74.79%
       *
       * Second, with a throwaway module of 14 uncovered functions that
       * nothing imports:
       *
       *   without `include`   absent from the report entirely, run passes
       *   with `include`      362/554 = 65.34%, run fails naming all four
       *                       metrics
       *
       * The first pair is the important one: the higher number is not better
       * coverage, it is a smaller denominator hiding untested code.
       */
      include: ["src/**/*.{ts,tsx}"],

      exclude: [
        "src/**/*.test.{ts,tsx}",
        /*
         * The mount point: one `createRoot().render()` call plus the
         * side-effect import of styles.css. There is nothing to assert that
         * would not amount to testing React itself, and it cannot run under
         * jsdom without a real document root.
         */
        "src/main.tsx",
        /*
         * Test infrastructure, not code under test. `setup.ts` runs as part of
         * every suite, so it would report as covered while asserting nothing.
         */
        "src/test/**",
      ],

      reporter: ["text", "html"],

      /*
       * Set from the measured baseline, deliberately not from a rounder,
       * higher number, for the same reason the backend's are: a threshold
       * above current coverage fails on the commit that introduces it, and
       * the reflex fix is to lower it again — after which nobody trusts it.
       *
       * Measured at the time of writing, over 184 tests in 19 files:
       *
       *   statements 74.79%   branches 76.09%   functions 77.30%   lines 76.27%
       *
       * The floors below sit roughly two points under each — enough slack that
       * moving code between files or deleting a covered branch does not trip
       * them, tight enough that a meaningful block of untested code does.
       *
       * These are materially lower than the backend's (89/81/88/90), and that
       * is a measurement rather than a lowered standard. Four things hold the
       * totals down, in order of size:
       *
       *   usePolling.ts        0% — 63 lines nothing imports (see #173)
       *   api.ts              19% — the fetch helpers; only the parse paths
       *                             are covered, not the request paths
       *   useSubscription.ts  52% — WebSocket lifecycle and reconnect logic
       *   FeeSpreadTrendChart 29% — least-covered chart. Four charts have no
       *                             test file of their own, but the other
       *                             three are exercised through HistoryView
       *                             and the axe suite; this one is not.
       *
       * Ratchet upward as those improve; the gap is slack, not a target to
       * grow into.
       */
      thresholds: {
        statements: 72,
        branches: 74,
        functions: 75,
        lines: 74,
      },
    },
  },
});
