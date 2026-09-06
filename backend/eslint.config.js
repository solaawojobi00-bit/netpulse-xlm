import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

/*
 * Flat config rather than the `.eslintrc.json` this started out as: ESLint 10
 * reads no other format. The eslintrc loader was removed in this major, so a
 * `.eslintrc.json` here would be silently ignored -- worse than absent, since
 * `npm run lint` would still exit 0 while linting nothing.
 *
 * Backend and frontend keep separate configs on purpose. This one has no React
 * plugins and no DOM globals; forcing a shared root config would drag JSX rules
 * into a package that has no JSX, and pull React plugins into its dependency
 * tree for nothing.
 */
export default tseslint.config(
  {
    // Compiled output is a copy of src. Linting it doubles every finding and
    // reports them against paths nobody edits.
    ignores: ["dist/**", "coverage/**"],
  },

  js.configs.recommended,

  /*
   * Type-checked rules, not the plain `recommended` set. The whole reason to
   * add a linter on top of `tsc --noEmit` is the class of bug tsc accepts:
   * chiefly a floating promise in the poller or WebSocket paths, where a
   * dropped rejection shows up as a silent gap in metrics rather than a crash.
   * Those rules need type information, so they need the project service.
   *
   * Scoped to `src` explicitly. tsconfig.json includes only `src`, so the
   * config files at the package root have no type information to offer and a
   * type-checked rule loaded against them crashes the whole run rather than
   * reporting anything.
   */
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["src/**/*.ts"],
  })),

  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /*
       * Underscore-prefixed args are the conventional "required by the
       * signature, deliberately unused" marker -- Express error middleware
       * must accept four parameters to be recognised as error middleware at
       * all, whether or not it reads `next`.
       */
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
    files: ["src/**/*.test.ts"],
    rules: {
      /*
       * Test doubles stand in for async APIs, so they must return promises
       * whether or not they await anything -- a `fetch` mock's `json()` is an
       * async function whose whole body is a literal. Requiring an await there
       * would mean `Promise.resolve` wrappers written purely to satisfy a rule
       * about a shape that is already correct.
       */
      "@typescript-eslint/require-await": "off",

      /*
       * The `any` family, off for tests only. This was worth trying to avoid,
       * and the attempt is what settled it: leaving these on produced ~200
       * errors, essentially all of them in `vi.mock` factories and partial
       * store doubles -- `(...args: any[]) => actual.fn(...args)` passthroughs
       * and object literals standing in for a few fields of a larger type.
       *
       * Typing those precisely means restating implementation types in the
       * tests, which is both a large diff and a worse suite: the mock then has
       * to be updated whenever the real signature changes, for no extra
       * safety, since the assertions are what actually check behaviour.
       *
       * Production code keeps all of these. That boundary is the point --
       * `horizon.ts` and `ws.ts` each had a genuine unsafe-`any` path that
       * these same rules caught and this PR fixes.
       */
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // Last, always: switches off every stylistic rule that would otherwise
  // disagree with Prettier. Anything before this can be re-enabled by it.
  prettier,
);
