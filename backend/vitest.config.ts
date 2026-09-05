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
  },
});
