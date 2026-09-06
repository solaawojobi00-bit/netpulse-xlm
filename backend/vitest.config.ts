import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    fileParallelism: false,
    /*
     * `dist/` holds compiled copies of the test files, which the default
     * include glob matches just as happily as the sources. Anyone who has run
     * a build then runs two suites at once: the current one, and a snapshot of
     * whatever the tests looked like when that build ran. Those stale copies
     * can report green for behaviour that no longer exists, or fail for
     * reasons that are not in the working tree.
     *
     * Spread `defaultExclude` rather than replacing it — a bare
     * `["dist/**"]` would drop the default `node_modules/**`.
     */
    exclude: [...defaultExclude, "dist/**"],

    coverage: {
      provider: "v8",

      /*
       * Explicit, and the most important line here. Without it v8 reports only
       * the files a test actually imported, so a brand-new module that nothing
       * imports is absent from the report rather than counted as zero -- total
       * coverage does not move and the thresholds below wave it through. That
       * is the exact regression this config exists to catch.
       *
       * Measured rather than assumed, with a throwaway uncovered module that
       * nothing imports:
       *
       *   without `include`   module absent from report, total stays 91.39%
       *   with `include`      module counted at 0%, total falls to 90.73%
       */
      include: ["src/**/*.ts"],

      exclude: [
        "src/**/*.test.ts",
        /*
         * Interfaces and type aliases only. It compiles to an empty module, so
         * it contributes no statements and can never be "covered"; leaving it
         * in just drags the denominator around for no signal.
         */
        "src/types.ts",
      ],

      reporter: ["text", "html"],

      /*
       * Set from the measured baseline, deliberately not from a rounder,
       * higher number. A threshold above current coverage fails on the commit
       * that introduces it, and the reflex fix is to lower it again -- after
       * which nobody trusts it. These sit a couple of points below the real
       * figures so ordinary refactoring does not trip them, while a genuinely
       * untested addition still does.
       *
       * Measured at the time of writing, over 264 tests in 14 files:
       *
       *   statements 91.39%   branches 83.51%   functions 90.36%   lines 92.11%
       *
       * The floors below sit roughly two points under each, which is enough
       * slack that moving code between files or deleting a covered branch does
       * not trip them, and tight enough that a meaningful block of untested
       * code does.
       *
       * Ratchet upward as coverage improves; the gap is slack, not a target to
       * grow into. The obvious candidates are ws.ts (66% statements, 39%
       * branches) and index.ts (72%), which are what hold the totals down.
       */
      thresholds: {
        statements: 89,
        branches: 81,
        functions: 88,
        lines: 90,
      },
    },
  },
});
