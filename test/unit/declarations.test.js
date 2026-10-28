// The modules' emitted declarations against v0.1.0's handwritten ones, both printed by tsc, but for
// the differences listed here, and tsc, under tsconfig.json, refusing runtime code in a declaration
// file, run against scratch trees.
// Adapted from spike-html-packages-sdk (9d10ca6): test/unit/declarations.test.js.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "node:test";
import { listFiles } from "./release.js";

const root = join(import.meta.dirname, "../..");
const fixtures = join(root, "test/fixtures/v0.1.0");
// The check's own tsc, mise.toml's TypeScript-Go pin, not the typescript package in node_modules.
const tsc = "tsc";

/** v0.1.0's handwritten declarations as tsc's declaration printer writes them, as { "x.d.ts":
 * text }: the files compiled together as .ts sources in scratch, under tsconfig.json, their
 * declarations emitted, so the comparison with the build's emit is one printer's against the same
 * printer's, layout aside. */
function printed() {
  const scratch = mkdtempSync(join(tmpdir(), "declarations-"));
  try {
    mkdirSync(join(scratch, "src"));
    const names = readdirSync(fixtures).filter((name) => name.endsWith(".d.ts"));
    for (const name of names) {
      copyFileSync(join(fixtures, name), join(scratch, "src", `${basename(name, ".d.ts")}.ts`));
    }
    const compilerOptions = { rootDir: "src", outDir: "out", emitDeclarationOnly: true };
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({ extends: join(root, "tsconfig.json"), compilerOptions, include: ["src"] }),
    );
    const run = spawnSync(tsc, ["-p", "."], { cwd: scratch, encoding: "utf8" });
    assert.equal(run.error, undefined, `tsc didn't run: ${run.error}`);
    assert.equal(run.status, 0, run.stdout);
    return Object.fromEntries(
      names.map((name) => [name, readFileSync(join(scratch, "out", name), "utf8")]),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Where the build's declarations may differ from v0.1.0's, each with its reason. An entry with
// `from` and `to` replaces `from`, which must occur in the printed fixture exactly once, with `to`
// (an empty `to` removes it; a `to` that holds `from` adds beside it); an entry with neither is a
// module v0.1.0 didn't have, whose declaration nothing compares. The emit must equal the fixtures
// with every entry applied, so each change to the contract is one entry here, and an entry that no
// longer applies fails the test.
const differences = [
  {
    file: "api.d.ts",
    from: `import type { TokenProvider } from "./auth.js";`,
    to: `import type { TokenProvider } from "./auth.ts";`,
    reason: "the sources import each other by .ts, which tsc keeps and a consumer's tsc resolves",
  },
  {
    file: "service.d.ts",
    from: `import type { Client, Result } from "./api.js";`,
    to: `import type { Client, Result } from "./api.ts";`,
    reason: "the sources import each other by .ts, which tsc keeps and a consumer's tsc resolves",
  },
  {
    file: "api.d.ts",
    from: "/** Makes a client. */\nexport declare function createClient(options?: ClientOptions): Client;\n",
    to: "",
    reason: "createClient has no runtime yet, and a declaration of it would promise an export",
  },
  {
    file: "router.d.ts",
    from: "/** Makes a router over `routes`. */\nexport declare function createRouter(routes: Routes, options: RouterOptions): Router;\n",
    to: "",
    reason: "createRouter has no runtime yet, and a declaration of it would promise an export",
  },
];

/** The printed fixtures with every difference applied, as { "x.d.ts": text }, and the modules the
 * differences add; fails on an entry that doesn't apply. */
function expected(fixturesPrinted) {
  const texts = { ...fixturesPrinted };
  const added = [];
  for (const { file, from, to, reason } of differences) {
    assert.ok(reason, `the difference in ${file} gives no reason`);
    if (from === undefined) {
      assert.ok(!(file in texts), `${file} is added, but v0.1.0 has it`);
      added.push(file);
      continue;
    }
    assert.ok(file in texts, `${file} has a difference, but v0.1.0 has no ${file}`);
    const occurrences = texts[file].split(from).length - 1;
    assert.equal(occurrences, 1, `${file}: the difference "${reason}" doesn't apply once`);
    texts[file] = texts[file].replace(from, () => to);
  }
  return { texts, added };
}

/** Each "path code" tsc reports, sorted, for `files` (paths under layers/ to sources) in scratch. */
function check(files) {
  const scratch = mkdtempSync(join(tmpdir(), "declarations-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(join(scratch, "layers", path, ".."), { recursive: true });
      writeFileSync(join(scratch, "layers", path), `${source}\n`);
    }
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({ extends: join(root, "tsconfig.json"), include: ["layers"] }),
    );
    const run = spawnSync(tsc, ["--noEmit", "-p", "."], { cwd: scratch, encoding: "utf8" });
    assert.equal(run.error, undefined, `tsc didn't run: ${run.error}`);
    const errors = [...run.stdout.matchAll(/^layers\/(\S+)\(\d+,\d+\): error (TS\d+)/gm)];
    // An error outside the scratch layers/ (a config tsc can't read, say) would leave the list
    // empty and pass the cases that expect none, so every error tsc reports must be one of these.
    assert.equal(run.stdout.match(/error TS\d+/g)?.length ?? 0, errors.length, run.stdout);
    return errors.map(([, path, code]) => `${path} ${code}`).sort();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const runtime = {
  "statement.d.ts": `export interface A {}\nconsole.log("runs");`,
  "body.d.ts": `export declare function f(): number;\nexport function g(): number { return 1; }`,
  "binding.d.ts": `let count = 0;`,
  "method.d.ts": `export declare class C { m(): void { } }`,
  "auth.d.ts": `export interface TokenProvider {}\nexport const anonymous: TokenProvider = {};`,
};

// skipLibCheck off is the guard: with it on, tsc skips every .d.ts, and these errors with them.
describe("SDK declarations", () => {
  // v0.1.0's declarations, kept as the fixtures, are the contract the build's emit keeps, JSDoc
  // included, but for the differences listed. It reads the dist/ mise run build wrote.
  describe("the build against v0.1.0", () => {
    const { texts, added } = expected(printed());
    const built = listFiles(join(root, "dist")).filter((path) => path.endsWith(".d.ts"));

    test("the build declares v0.1.0's modules and the ones the differences add", () => {
      assert.deepEqual(built, [...Object.keys(texts), ...added].sort());
    });

    for (const [file, text] of Object.entries(texts)) {
      test(`the built ${file} declares v0.1.0's, but for the differences listed`, () => {
        assert.equal(readFileSync(join(root, "dist", file), "utf8"), text);
      });
    }
  });

  test("tsc, under tsconfig.json, refuses runtime code in a declaration file", () => {
    assert.deepEqual(check(runtime), [
      "auth.d.ts TS1039",
      "binding.d.ts TS1039",
      "binding.d.ts TS1046",
      "body.d.ts TS1183",
      "method.d.ts TS1183",
      "statement.d.ts TS1036",
    ]);
  });

  test("tsc, under tsconfig.json, checks a declaration file's types", () => {
    assert.deepEqual(check({ "types.d.ts": `export type A = Missing;` }), ["types.d.ts TS2304"]);
  });

  test("tsc accepts declarations alone", () => {
    assert.deepEqual(
      check({
        "ok.d.ts": [
          `export interface A { token(): Promise<string | undefined> }`,
          `export type B<T> = { ok: true; data: T } | { ok: false };`,
          `export declare const a: A;`,
          `export declare function f(x: number): string;`,
        ].join("\n"),
      }),
      [],
    );
  });
});
