// The release's integrity: a pnpm pack of the build, extracted, against package.json's files and
// exports and against its license, by release.js's releaseProblems, as it stands and in scratch
// copies with one fault each. It packs the dist/ that mise run build writes.
// From spike-html-packages-sdk (9d10ca6): test/unit/release.test.js.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { listFiles, releaseProblems } from "./release.js";

const root = join(import.meta.dirname, "../..");
const src = join(root, "src");
const scratches = [];

/** A new temporary directory, removed after the run. */
function scratchDir() {
  const scratch = mkdtempSync(join(tmpdir(), "release-"));
  scratches.push(scratch);
  return scratch;
}

// The pack under test: pnpm pack's tarball, extracted, its package/ directory.
let pack;
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

/** A scratch copy of the pack, `change` applied to it and its manifest, and its problems. */
function faulted(change) {
  const copy = join(scratchDir(), "package");
  cpSync(pack, copy, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(copy, "package.json"), "utf8"));
  change(copy, manifest);
  writeFileSync(join(copy, "package.json"), JSON.stringify(manifest));
  return releaseProblems(copy, src);
}

const remove = (path) => (dir) => rmSync(join(dir, path));

describe("release pack", () => {
  test("the pack is package.json, README.md, LICENSE, and the build", () => {
    const built = listFiles(join(root, "dist")).map((path) => `dist/${path}`);
    assert.ok(built.length > 0, "mise run build wrote no dist/");
    assert.deepEqual(listFiles(pack), [...built, "LICENSE", "README.md", "package.json"].sort());
  });

  test("the pack is the release that files and exports declare", () => {
    assert.deepEqual(releaseProblems(pack, src), []);
  });

  const faults = {
    "a .d.ts source with no copy": [
      remove("dist/auth.d.ts"),
      "src/auth.d.ts has no built dist/auth.d.ts",
    ],
    "a runtime module in the build": [
      (dir) => writeFileSync(join(dir, "dist/api.js"), ""),
      "dist/api.js is built from no source",
    ],
    "a stray file in the pack": [
      (dir) => writeFileSync(join(dir, "notes.md"), ""),
      "notes.md is packed but isn't the build, LICENSE, README.md, package.json",
    ],
    "a pack without its README": [remove("README.md"), "the pack has no README.md"],
    "an export at a missing file": [
      (_, copy) => (copy.exports["./gone.js"] = { types: "./dist/gone.d.ts" }),
      'exports["./gone.js"] resolves to ./dist/gone.d.ts, which isn\'t built',
    ],
    "a types target outside dist/": [
      (_, copy) => (copy.exports["./api.js"] = { types: "./src/api.d.ts" }),
      'exports["./api.js"] resolves to ./src/api.d.ts, which isn\'t built',
    ],
    "a declaration exported as a runtime module": [
      (_, copy) => (copy.exports["./*.js"] = { types: "./dist/*.d.ts", default: "./dist/*.js" }),
      'exports["./router.js"] resolves to ./dist/router.js, which isn\'t built',
    ],
    "a built file no export reaches": [
      (_, copy) => delete copy.exports["./*.js"],
      "dist/service.d.ts is reachable through no export",
    ],
    "a pattern export that reaches nothing": [
      (_, copy) => (copy.exports["./apps/*.js"] = { types: "./dist/apps/*.d.ts" }),
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
      (_, copy) => (copy.files = ["dist/api.d.ts"]),
      "dist/router.d.ts isn't under package.json's files",
    ],
  };
  for (const [fault, [change, problem]] of Object.entries(faults)) {
    test(`fails on ${fault}`, () => {
      const problems = faulted(change);
      assert.ok(problems.includes(problem), `expected: ${problem}\ngot: ${problems.join("\n")}`);
    });
  }
});
