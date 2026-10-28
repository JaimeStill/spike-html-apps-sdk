// The layer's import cases as one file tree in the repository's shape: a file per forbidden import
// and form, each with the rules that catch it, and the imports the layer may make in the same
// layout. layers.test.js lints it.
// Adapted from spike-html-packages-sdk (9d10ca6): test/unit/layers-tree.js, renamed.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = join(import.meta.dirname, "../..");

/** The package's manifest as it stands, which the tree carries, so each import is judged against
 * it. */
export const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const sdk = manifest.name;

/** The sibling layers and spike-html-apps' app, which the SDK never imports. */
const siblings = ["foundation", "components"].map((layer) => sdk.replace(/sdk$/, layer));
const app = sdk.replace(/-sdk$/, "");

// The rules a case names: the layer table and the two manifest rules.
export const table = "boundaries/dependencies";
export const extraneous = "import-x/no-extraneous-dependencies";
export const relativePackages = "import-x/no-relative-packages";
/** The rules the lint flags the tree with, no-unresolved among them, which no case may draw. */
export const watched = [table, extraneous, relativePackages, "import-x/no-unresolved"];

/** An edge in each of the four import forms, one file per form, each named for the edge and its
 * form: a side-effect import, a type import, a re-export, and an import(). */
function forms(base, specifier) {
  return {
    [`${base}.ts`]: `import "${specifier}";`,
    [`${base}-type.ts`]: `import type { X } from "${specifier}";`,
    [`${base}-export.ts`]: `export * from "${specifier}";`,
    [`${base}-dynamic.ts`]: `await import("${specifier}");`,
  };
}

/** `files`, each path to its source and the rules that flag it, sorted. */
function by(rules, files) {
  return Object.fromEntries(
    Object.entries(files).map(([path, source]) => [path, { source, rules: [...rules].sort() }]),
  );
}

// Each file holds one import, named for what it imports.
export const violations = {
  // Any package by name: the manifest declares no dependency, and the table allows no package. A
  // devDependency ships nothing, and the package's own name resolves to its build, not its src/.
  ...by([table, extraneous], {
    "src/lit.ts": `import { html } from "lit";`,
    ...forms("src/forms/lit", "lit"),
    ...forms("src/forms/foundation", `${siblings[0]}/dom.js`),
    ...forms("src/forms/components", `${siblings[1]}/status-badge.js`),
    "src/app.ts": `import { define } from "${app}/main.js";`,
    ...forms("src/forms/typescript", "typescript"),
    ...forms("src/forms/self-name", `${sdk}/auth.js`),
  }),
  // The NATS adapter's packages from any file but the adapter: the manifest declares them, as
  // optional peer dependencies, but the table allows them to the adapter alone.
  ...by([table], {
    ...forms("src/forms/nats-core", "@nats-io/nats-core"),
    ...forms("src/forms/jetstream", "@nats-io/jetstream"),
    "src/events/nats-sibling.ts": `import { jetstream } from "@nats-io/jetstream";`,
  }),
  // The adapter from another module of the layer, which would load its packages with it.
  ...by([table], {
    ...forms("src/forms/adapter", "./../events/nats.ts"),
    "src/events/adapter-value.ts": `import { natsSequence } from "./nats.ts";`,
  }),
  // A package by a relative path into node_modules/.
  ...by([table, relativePackages], {
    "src/lit-path.ts": `import "../node_modules/lit/index.js";`,
  }),
  // A value import of a declaration file, in each value form, an inline `type` specifier among
  // them, since verbatimModuleSyntax keeps that import.
  ...by([table], {
    "src/declared-value.ts": `import { createClient } from "./declared.js";`,
    "src/declared-side-effect.ts": `import "./declared.js";`,
    "src/declared-inline-type.ts": `import { type Client } from "./declared.js";`,
    "src/declared-export.ts": `export { createClient } from "./declared.js";`,
    "src/declared-export-all.ts": `export * from "./declared.js";`,
    "src/declared-dynamic.ts": `await import("./declared.js");`,
    "src/nested/declared-value.ts": `import { createClient } from "../declared.js";`,
  }),
};

/** `cases`, each path to its source alone. */
export const sources = (cases) =>
  Object.fromEntries(Object.entries(cases).map(([path, { source }]) => [path, source]));

// Every import the layer may make, in each form, with names that hold dots, which a rule must tell
// from . and .. segments.
export const allowed = {
  "src/api.ts": `export { anonymous } from "./auth.ts";`,
  "src/nested/own.ts": `import type { X } from "../api.ts";\nawait import("../api.ts");`,
  "src/nested/index.ts": `import "..";\nexport * from "./";`,
  "src/dotted.ts": `import "./..x/y.ts";\nimport "./.well-known/a.ts";`,
  "src/declared-type.ts": `import type { Client } from "./declared.js";`,
  "src/declared-export-type.ts": `export type { Result } from "./declared.js";`,
  "src/declared-typeof.ts": `import type { createClient } from "./declared.js";\nexport type F = typeof createClient;`,
  "src/declared-export-all-type.ts": `export type * from "./declared.js";`,
  // The adapter, which may import its packages, in each form, and what the layer may.
  "src/events/nats.ts": [
    `import { html } from "@nats-io/nats-core";`,
    `import type { X } from "@nats-io/jetstream";`,
    `export * from "@nats-io/jetstream";`,
    `await import("@nats-io/nats-core");`,
    `import type { X as Y } from "../api.ts";`,
  ].join("\n"),
};

/** The files the cases import that no case is: the modules, the declaration, and the package's
 * build, which its own name resolves to. */
const targets = {
  "src/auth.ts": "export const anonymous = {};",
  "src/index.ts": "export {};",
  "src/..x/y.ts": "export {};",
  "src/.well-known/a.ts": "export {};",
  "src/declared.d.ts": [
    "export interface Client {}",
    "export type Result<T> = { ok: true; data: T } | { ok: false };",
    "export declare function createClient(): Client;",
  ].join("\n"),
  "dist/auth.js": "export {};",
  "dist/auth.d.ts": "export interface X {}",
};

/** The packages the cases name, as stubs in node_modules/: lit, the siblings, the app,
 * typescript, a devDependency, and the NATS adapter's peer dependencies, each a module and its
 * types at every subpath. */
const externals = [
  "lit",
  ...siblings,
  app,
  "typescript",
  "@nats-io/nats-core",
  "@nats-io/jetstream",
];
const stub = (name) => ({
  "package.json": JSON.stringify({
    name,
    type: "module",
    exports: {
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./*": { types: "./index.d.ts", default: "./index.js" },
    },
  }),
  "index.js": "export const html = () => {};\nexport const define = () => {};",
  "index.d.ts": [
    "export declare const html: () => void;",
    "export declare const define: () => void;",
    "export interface X {}",
  ].join("\n"),
});

/** Writes `files` under `dir` with the manifest, the targets, the externals, and a link to the
 * package itself, as an install of its own name lays it out, so every import resolves and the lint
 * judges it. Returns the code files written under src/. */
export function writeTree(dir, files) {
  const written = { ...files, ...targets, "package.json": JSON.stringify(manifest) };
  for (const name of externals) {
    for (const [path, source] of Object.entries(stub(name))) {
      written[join("node_modules", name, path)] = source;
    }
  }
  for (const [path, source] of Object.entries(written)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), `${source}\n`);
  }
  const self = join(dir, "node_modules", sdk);
  mkdirSync(dirname(self), { recursive: true });
  symlinkSync(relative(dirname(self), dir), self);
  return Object.keys(written).filter((path) => path.startsWith("src/") && /\.(js|ts)$/.test(path));
}

/** ESLint's JSON report on the tree under `dir`'s src/. -c takes the repo's config, whose patterns
 * then match from the working directory, the tree, and whose plugins load from the repo's
 * node_modules. Throws when ESLint doesn't run or exits other than 0 or 1. */
export function lint(dir) {
  const eslint = join(root, "node_modules", ".bin", "eslint");
  const run = spawnSync(eslint, ["-c", join(root, "eslint.config.js"), "-f", "json", "src"], {
    cwd: dir,
    encoding: "utf8",
  });
  if (run.error) throw new Error(`eslint didn't run: ${run.error}`);
  if (run.status !== 0 && run.status !== 1) {
    throw new Error(`eslint exited ${run.status}: ${run.stderr}`);
  }
  return JSON.parse(run.stdout);
}
