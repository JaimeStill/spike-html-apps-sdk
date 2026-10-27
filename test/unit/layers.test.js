// The layer's import rules: eslint.config.js run over test/unit/layers-tree.js's tree, passing only
// when ESLint flags exactly the files that break a rule, each with exactly the rules its case names.
// From spike-html-packages-sdk (9d10ca6): test/unit/layers.test.js.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { allowed, lint, manifest, sources, violations, watched, writeTree } from "./layers-tree.js";

const root = join(import.meta.dirname, "../..");

describe("layer imports", () => {
  test("the eslint installed is the one package.json pins", () => {
    const eslint = join(root, "node_modules", ".bin", "eslint");
    const run = spawnSync(eslint, ["--version"], { encoding: "utf8" });
    assert.equal(run.stdout.trim(), `v${manifest.devDependencies.eslint}`);
  });

  // One tree, so each case is judged beside the others, as the package's files are.
  const files = { ...sources(violations), ...allowed };
  let scratch;
  let found;
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "layers-"));
    const code = writeTree(scratch, files);
    const report = lint(scratch);
    assert.deepEqual(
      report.map((file) => file.filePath.slice(scratch.length + 1)).sort(),
      code.sort(),
      "ESLint lints every code file under src/",
    );
    const fatal = report.filter((file) => file.messages.some((m) => m.fatal));
    assert.deepEqual(
      fatal.map((file) => file.filePath),
      [],
      "every file parses, so each import is judged",
    );
    found = {};
    for (const file of report) {
      const rules = [...new Set(file.messages.map((m) => m.ruleId))].filter((id) =>
        watched.includes(id),
      );
      if (rules.length > 0) found[file.filePath.slice(scratch.length + 1)] = rules.sort();
    }
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("every forbidden import draws exactly the rules its case names", () => {
    const expected = Object.fromEntries(
      Object.entries(violations).map(([path, { rules }]) => [path, rules]),
    );
    const caught = Object.fromEntries(Object.keys(expected).map((path) => [path, found[path]]));
    assert.deepEqual(caught, expected);
  });

  test("a tree of allowed imports draws none", () => {
    assert.deepEqual(
      Object.keys(allowed).filter((path) => path in found),
      [],
    );
  });

  test("no file outside the cases draws a rule", () => {
    assert.deepEqual(
      Object.keys(found).filter((path) => !(path in files)),
      [],
    );
  });
});
