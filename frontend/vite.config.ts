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
  },
});
