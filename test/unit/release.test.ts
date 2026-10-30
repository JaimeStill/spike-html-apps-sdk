// The release's integrity: a pnpm pack of the build, extracted, against package.json's files and
// exports and against its license, by release.ts's releaseProblems, as it stands and in scratch
// copies with one fault each; and the pack's public subpaths, resolved through the package's own
// name, with its internal module refused. It packs the dist/ that mise run build writes.
// The pack's runtime files are held to the layer's brotli budget by budget.ts's budgetProblems.
// Adapted from spike-html-packages-sdk (9d10ca6): test/unit/release.test.js, in TypeScript.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { brotliBytes, budgetProblems, runtimeFiles } from "./budget.ts";
import { listFiles, releaseProblems, resolveSelf } from "./release.ts";

const root = join(import.meta.dirname, "../..");
const src = join(root, "src");
const scratches: string[] = [];

// The layer's budget in brotli bytes, a KB being 1,000 bytes: its baseline on 2026-10-29, 11,669 B
// over 7 runtime files, plus 10%, rounded up to a whole KB. A layer over it fails the check;
// a change that needs more raises it here, in the change's own commit.
const layer = "sdk";
const budget = 13_000;

// The public subpaths, which package.json's exports lists: each module an app imports.
const publics = [
  "./api.js",
  "./auth.js",
  "./router.js",
  "./service.js",
  "./events.js",
  "./events/nats.js",
];
// Node's condition sets, its defaults and the types condition TypeScript adds, with the build file
// a public subpath's base resolves to under each.
const conditions: [string[], string][] = [
  [[], ".js"],
  [["--conditions=types"], ".d.ts"],
];

/** A new temporary directory, removed after the run. */
function scratchDir() {
  const scratch = mkdtempSync(join(tmpdir(), "release-"));
  scratches.push(scratch);
  return scratch;
}

// The pack under test: pnpm pack's tarball, extracted, its package/ directory.
let pack: string;
before(() => {
  const scratch = scratchDir();
  execFileSync("pnpm", ["pack", "--pack-destination", scratch], { cwd: root, stdio: "ignore" });
  const [tarball] = listFiles(scratch);
  execFileSync("tar", ["-xzf", join(scratch, tarball), "-C", scratch]);
  pack = join(scratch, "package");
});
after(() => {
  for (const scratch of scratches) rmSync(scratch, { recursive: true, force: true });
});

/** The pack's manifest as package.json writes it, which a fault changes: every export a flat
 * object of condition targets. */
interface PackManifest {
  license: string;
  files: string[];
  exports: Record<string, Record<string, string>>;
}

/** A fault's change to a scratch copy of the pack, given its directory and its manifest. */
type Change = (dir: string, manifest: PackManifest) => void;

/** A scratch copy of the pack, `change` applied to it and its manifest, and its problems. */
function faulted(change: Change) {
  const copy = join(scratchDir(), "package");
  cpSync(pack, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, "package.json"), "utf8")) as PackManifest;
  change(copy, manifest);
  writeFileSync(join(copy, "package.json"), JSON.stringify(manifest));
  return releaseProblems(copy, src, publics);
}

const remove =
  (path: string): Change =>
  (dir) =>
    rmSync(join(dir, path));

describe("release pack", () => {
  test("the pack is package.json, README.md, LICENSE, and the build", () => {
    const built = listFiles(join(root, "dist")).map((path) => `dist/${path}`);
    assert.ok(built.length > 0, "mise run build wrote no dist/");
    assert.deepEqual(listFiles(pack), [...built, "LICENSE", "README.md", "package.json"].sort());
  });

  test("the pack is the release that files and exports declare", () => {
    assert.deepEqual(releaseProblems(pack, src, publics), []);
  });

  test("each public subpath resolves through the package's name to its build", () => {
    for (const [flags, extension] of conditions) {
      assert.deepEqual(
        resolveSelf(pack, publics, flags),
        publics.map((subpath) => ({
          path: `dist/${subpath.slice(2, -".js".length)}${extension}`,
        })),
      );
    }
  });

  test("the internal eventstream.js doesn't resolve through the package's name", () => {
    for (const [flags] of conditions) {
      assert.deepEqual(resolveSelf(pack, ["./eventstream.js"], flags), [
        { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" },
      ]);
    }
  });

  // Each fault: its change, and a problem it must draw.
  const faults: Record<string, [Change, string]> = {
    "a .ts module with no emitted .js": [
      remove("dist/auth.js"),
      "src/auth.ts has no built dist/auth.js",
    ],
    "a .ts module with no emitted .d.ts": [
      remove("dist/service.d.ts"),
      "src/service.ts has no built dist/service.d.ts",
    ],
    "a stray built file": [
      (dir) => writeFileSync(join(dir, "dist/old.js"), ""),
      "dist/old.js is built from no source",
    ],
    "a stray file in the pack": [
      (dir) => writeFileSync(join(dir, "notes.md"), ""),
      "notes.md is packed but isn't the build, LICENSE, README.md, package.json",
    ],
    "a pack without its README": [remove("README.md"), "the pack has no README.md"],
    "an export at a missing file": [
      (_, copy) =>
        (copy.exports["./gone.js"] = { types: "./dist/gone.d.ts", default: "./dist/gone.js" }),
      'exports["./gone.js"] resolves to ./dist/gone.js, which isn\'t built',
    ],
    "a types target outside dist/": [
      (_, copy) => (copy.exports["./api.js"] = { types: "./src/api.ts", default: "./dist/api.js" }),
      'exports["./api.js"] resolves to ./src/api.ts, which isn\'t built',
    ],
    "a public subpath whose types target isn't built": [
      (_, copy) => (copy.exports["./router.js"].types = "./dist/router.ts"),
      'exports["./router.js"] resolves to ./dist/router.ts, which isn\'t built',
    ],
    "a built file no export reaches": [
      (_, copy) => (copy.exports["./auth.js"] = { types: "./dist/auth.d.ts" }),
      "dist/auth.js is reachable through no export",
    ],
    "an export with only a types condition": [
      (_, copy) => (copy.exports["./auth.js"] = { types: "./dist/auth.d.ts" }),
      'exports["./auth.js"] isn\'t a types and a default condition',
    ],
    "an export with a third condition": [
      (_, copy) =>
        (copy.exports["./api.js"] = { import: "./dist/api.js", ...copy.exports["./api.js"] }),
      'exports["./api.js"] isn\'t a types and a default condition',
    ],
    "a public subpath missing from exports": [
      (_, copy) => delete copy.exports["./events/nats.js"],
      'exports has no "./events/nats.js"',
    ],
    "a pattern export, which reaches the internal module": [
      (_, copy) => (copy.exports["./*.js"] = { types: "./dist/*.d.ts", default: "./dist/*.js" }),
      "./eventstream.js is internal, but resolves through the package's name",
    ],
    "an export of the internal module": [
      (_, copy) =>
        (copy.exports["./eventstream.js"] = {
          types: "./dist/eventstream.d.ts",
          default: "./dist/eventstream.js",
        }),
      'exports["./eventstream.js"] isn\'t a public subpath',
    ],
    "a pattern export that reaches nothing": [
      (_, copy) =>
        (copy.exports["./apps/*.js"] = {
          types: "./dist/apps/*.d.ts",
          default: "./dist/apps/*.js",
        }),
      'exports["./apps/*.js"] reaches no built file',
    ],
    "a pack without its LICENSE": [remove("LICENSE"), "LICENSE is missing"],
    "a LICENSE that isn't Apache 2.0": [
      (dir) => writeFileSync(join(dir, "LICENSE"), "All rights reserved.\n"),
      "LICENSE isn't the Apache License 2.0",
    ],
    "a package that declares another license": [
      (_, copy) => (copy.license = "MIT"),
      "package.json declares license MIT, not Apache-2.0",
    ],
    "a build outside files": [
      (_, copy) => (copy.files = ["dist/api.js"]),
      "dist/router.js isn't under package.json's files",
    ],
  };
  for (const [fault, [change, problem]] of Object.entries(faults)) {
    test(`fails on ${fault}`, () => {
      const problems = faulted(change);
      assert.ok(problems.includes(problem), `expected: ${problem}\ngot: ${problems.join("\n")}`);
    });
  }
});

describe("brotli budget", () => {
  test("the pack's runtime files are within the layer's budget", () => {
    assert.ok(runtimeFiles(pack).length > 0, "the pack has no .js or .css");
    assert.deepEqual(budgetProblems(pack, layer, budget), []);
  });

  test("counts a runtime .js, and never a .d.ts", () => {
    const copy = join(scratchDir(), "package");
    cpSync(pack, copy, { recursive: true });
    const measured = brotliBytes(copy);
    const text = "export const added = 1;\n".repeat(64);
    writeFileSync(join(copy, "dist/added.d.ts"), text);
    assert.equal(brotliBytes(copy), measured, "a .d.ts was counted");
    writeFileSync(join(copy, "dist/added.js"), text);
    assert.ok(brotliBytes(copy) > measured, "a .js wasn't counted");
  });

  test("fails a pack one byte over its budget, naming the size and the budget", () => {
    const measured = brotliBytes(pack);
    assert.deepEqual(budgetProblems(pack, layer, measured), []);
    const [problem] = budgetProblems(pack, layer, measured - 1);
    assert.equal(
      problem,
      `${layer}: ${measured.toLocaleString("en-US")} B brotli over its budget of ${(measured - 1).toLocaleString("en-US")} B`,
    );
  });
});
