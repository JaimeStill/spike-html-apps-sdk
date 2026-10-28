// The lint the check runs: the recommended rules and the layer's imports in src/.
// test/unit/layers.test.js runs it over test/unit/layers-tree.js.
// From spike-html-packages-sdk (9d10ca6): eslint.config.js.

import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import boundaries from "eslint-plugin-boundaries";
import importX from "eslint-plugin-import-x";
import globals from "globals";
import tseslint from "typescript-eslint";

const code = ["**/*.js", "**/*.ts"];

// The layer table cut to the SDK: its sources, which may import nothing but themselves.
export const layers = [{ name: "sdk", path: "src", may: ["sdk"] }];

// The layer is an element by its directory, matched from the root (partialMatch false), with a
// second pattern for a file in a directory whose name starts with a dot, which micromatch's **
// never enters, so ./.well-known/ and ./..x/ stay in the layer.
const elements = layers.map(({ name, path }) => ({
  type: name,
  pattern: [path, `${path}/**/.*`],
  partialMatch: false,
}));

// The rule's default is disallow, and it checks every origin (a package is external) and local
// files no element holds: an import passes only when a policy names its target.
const policies = layers.map(({ name, may }) => ({
  from: { element: { type: name } },
  allow: { to: may.map((target) => ({ element: { type: target } })) },
}));

// A declaration file (a handwritten .d.ts) has no runtime, so an import that resolves to one passes
// only as a type import, `import type` or `export type`, which tsc erases: the last policy refuses
// any other kind, and as the last whose selector matches it overrides the allow before it. The
// dependency's kind is the declaration's, so `import { type X }` is a value import here, as it is
// to verbatimModuleSyntax, which keeps it as `import {}` and so loads the file. checkInternals has
// the rule judge an import within the layer too, which the layer's policy allows.
const declarations = {
  disallow: { to: { internalPath: "**/*.d.ts" }, dependency: { kind: "value" } },
  message:
    "A .d.ts file is a declaration with no runtime: import it with `import type` (or export " +
    "from it with `export type`), never as a value, a side effect, or an import().",
};

export default defineConfig([
  // The build, gitignored, which ESLint doesn't read.
  { ignores: ["dist/"] },
  { files: code, extends: [js.configs.recommended, tseslint.configs.recommended] },
  { files: code, languageOptions: { globals: globals.browser } },
  // The suite and the scripts run on node.
  { files: ["test/**/*.js", "scripts/**"], languageOptions: { globals: globals.node } },
  {
    files: ["src/**"],
    plugins: { boundaries, "import-x": importX },
    settings: {
      "import/resolver": { typescript: true },
      "import-x/resolver": { typescript: true },
      "boundaries/elements": elements,
    },
    // The rule judges the file an import resolves to, never the specifier's text, and
    // no-unresolved fails a specifier that names no file, so no import passes by naming none.
    rules: {
      "import-x/no-unresolved": "error",
      // Each judges an import against package.json: a package name it doesn't declare in
      // dependencies, which it holds none of (a devDependency ships nothing, and includeInternal
      // holds the package's own name, which resolves inside it, to the same), in every import form
      // (includeTypes), and a relative path that reaches another package's files.
      "import-x/no-extraneous-dependencies": [
        "error",
        { devDependencies: false, includeInternal: true, includeTypes: true },
      ],
      "import-x/no-relative-packages": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          checkAllOrigins: true,
          checkUnknownLocals: true,
          checkInternals: true,
          policies: [...policies, declarations],
        },
      ],
    },
  },
]);
