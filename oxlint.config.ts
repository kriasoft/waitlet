import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "import", "promise", "node"],
  categories: {
    correctness: "error",
    suspicious: "error",
    perf: "warn",
  },
  rules: {
    // Waiting for a slot is inherently sequential.
    "no-await-in-loop": "off",
    // node:sqlite returns untyped rows; casting them to row types is the intended pattern.
    "typescript/no-unsafe-type-assertion": "off",
    // Allow `const { omitted, ...rest } = obj`.
    "no-unused-vars": ["error", { ignoreRestSiblings: true }],
    // Stylesheets are imported for their side effect.
    "import/no-unassigned-import": ["error", { allow: ["**/*.css"] }],
  },
  options: {
    // Needs oxlint-tsgolint; catches floating promises and other async misuse.
    typeAware: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
  env: {
    builtin: true,
    node: true,
  },
  ignorePatterns: ["dist", "coverage"],
});
