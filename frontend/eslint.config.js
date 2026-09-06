import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/*
 * Kept separate from backend/eslint.config.js rather than shared at the root:
 * this package runs in a browser, compiles JSX, and needs the React plugins
 * below, none of which apply to the Node backend. Two small configs that each
 * say what they mean beat one config full of per-directory overrides.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "a11y-shots/**"],
  },

  js.configs.recommended,

  // Scoped to `src` for the same reason as the backend config: tsconfig.json
  // includes only `src`, and a type-checked rule loaded against an unincluded
  // file (vite.config.ts, this file) aborts the run instead of reporting.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.{ts,tsx}"],
  })),

  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      /*
       * The rule this package most needs. A missing dependency in a
       * useEffect/useMemo array is a stale closure: the chart keeps rendering
       * the values from an earlier poll and looks perfectly healthy doing it.
       * That failure mode is invisible in review and invisible in tests that
       * only mount once, so it has to be caught mechanically.
       */
      "react-hooks/exhaustive-deps": "error",

      // Fast Refresh silently degrades to a full reload when a module exports
      // anything but components. Warn, not error -- it costs dev ergonomics,
      // not correctness, and shouldn't fail a build.
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],

      /*
       * Warn rather than error, deliberately and temporarily. Three call sites
       * trip this today: App.tsx clearing history state when the network or
       * range changes, SyncStatus re-basing its clock when new props arrive,
       * and useSubscription's socket-construction catch.
       *
       * All three are the "reset state when a prop changes" pattern, and the
       * real fixes (a `key`, or deriving during render) each change when a
       * re-render happens in the live-update path -- get one wrong and the
       * dashboard shows a stale reading while looking perfectly healthy.
       * That is not a change to make blind inside the PR that introduces the
       * linter, so the rule reports without blocking and the sites are tracked
       * separately. Raise this to "error" once they are fixed.
       */
      "react-hooks/set-state-in-effect": "warn",

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    files: ["src/**/*.test.{ts,tsx}", "src/test/**/*.{ts,tsx}"],
    languageOptions: {
      // Tests import describe/it/expect from "vitest" explicitly, but they run
      // under Node and reach for its globals (process, Buffer) in setup and
      // fixtures, so both sets apply here and only here.
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Same reasoning as backend/eslint.config.js: mocks must be async to
      // match the API they stand in for, awaiting nothing.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Test helpers and fixtures live beside the components they exercise.
      "react-refresh/only-export-components": "off",
    },
  },

  {
    /*
     * Build-time scripts: plain Node ESM, not part of the app bundle and not
     * covered by tsconfig. They get Node globals and no React or type-checked
     * rules -- without this they report every `process` and `console` as
     * undefined, which is 40-odd findings that say nothing.
     */
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      /*
       * Node *and* browser globals. These scripts run under Node, but
       * a11y-browser-check.mjs passes callbacks to `page.evaluate`, whose
       * bodies are serialised and run inside the real browser -- so `document`
       * and `window` are genuinely in scope there even though nothing in the
       * Node file declares them.
       */
      globals: { ...globals.node, ...globals.browser },
      sourceType: "module",
    },
  },

  prettier,
);
