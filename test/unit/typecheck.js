// tsc run as a consumer of the build: scratch files and the repository's test sources compiled
// together, the package's name mapped to the dist/ mise run build wrote, under the repository's
// tsconfig.json without allowImportingTsExtensions, which only its own sources need.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

/** Each "file:line code" tsc reports, in order, for `files` (names to sources, written to a
 * scratch directory) compiled with `sources` (paths under the repository root). A consumer doesn't
 * import .ts specifiers, so allowImportingTsExtensions is off: the emitted declarations' own .ts
 * specifiers must resolve without it. */
export function typecheck(files, sources = []) {
  const scratch = mkdtempSync(join(tmpdir(), "typecheck-"));
  try {
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(scratch, name), source);
    }
    const paths = { "@jaimestill/spike-html-apps-sdk/*": [join(root, "dist/*")] };
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        compilerOptions: {
          rootDir: "/",
          noEmit: true,
          allowImportingTsExtensions: false,
          paths,
        },
        files: [
          ...sources.map((path) => join(root, path)),
          ...Object.keys(files).map((name) => join(scratch, name)),
        ],
      }),
    );
    const run = spawnSync("tsc", ["-p", "."], { cwd: scratch, encoding: "utf8" });
    assert.equal(run.error, undefined, `tsc didn't run: ${run.error}`);
    const errors = [...run.stdout.matchAll(/^(\S+?)\((\d+),\d+\): error (TS\d+)/gm)].map(
      ([, path, line, code]) => `${path.split("/").pop()}:${line} ${code}`,
    );
    // An error tsc reports without a location (a config it can't read, say) would leave the list
    // empty and pass a case that expects none, so every error must be one of these.
    assert.equal(run.stdout.match(/error TS\d+/g)?.length ?? 0, errors.length, run.stdout);
    return errors;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
