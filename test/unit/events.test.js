// The event-sequence interface as a consumer imports it, the package's ./events.js export over the
// dist/ mise run build wrote: the sequence contract run against the in-memory sequence, its own
// cursor rules, and, under tsc, the sequence satisfying EventSequence and a Cursor opaque to apps.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { memorySequence } from "./memory-sequence.ts";
import { cloudEvent, sequenceContract } from "./sequence-contract.js";

const root = join(import.meta.dirname, "../..");

sequenceContract("the in-memory sequence", (events, options) => memorySequence(events, options));

describe("the in-memory sequence's cursors", () => {
  test("a cursor past the last event appended fails the read", async () => {
    const { sequence } = memorySequence([cloudEvent(1)]);
    await assert.rejects(sequence.read({ after: "2" })[Symbol.asyncIterator]().next(), {
      message: 'the sequence gave out no cursor "2"',
    });
  });

  test("the cursor of an event no longer kept is still one the sequence gave out", async () => {
    const { sequence, append } = memorySequence([cloudEvent(1)], { keep: 1 });
    const {
      value: { cursor },
    } = await sequence.read()[Symbol.asyncIterator]().next();
    await append(cloudEvent(2));
    await append(cloudEvent(3));
    const {
      value: { event },
    } = await sequence.read({ after: cursor })[Symbol.asyncIterator]().next();
    assert.deepEqual(event, cloudEvent(3));
  });
});

describe("the event-sequence types", () => {
  test("the in-memory sequence satisfies EventSequence, and a string is no Cursor", () => {
    const scratch = mkdtempSync(join(tmpdir(), "events-"));
    try {
      writeFileSync(
        join(scratch, "bad.ts"),
        [
          `import type { Cursor, EventSequence } from "@jaimestill/spike-html-apps-sdk/events.js";`,
          `export const cursor: Cursor = "1";`,
          `export const sequence = { read: () => [] } satisfies EventSequence;`,
        ].join("\n"),
      );
      const paths = { "@jaimestill/spike-html-apps-sdk/*": [join(root, "dist/*")] };
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          extends: join(root, "tsconfig.json"),
          compilerOptions: { rootDir: "/", noEmit: true, paths },
          files: [join(root, "test/unit/memory-sequence.ts"), join(scratch, "bad.ts")],
        }),
      );
      const run = spawnSync("tsc", ["-p", "."], { cwd: scratch, encoding: "utf8" });
      assert.equal(run.error, undefined, `tsc didn't run: ${run.error}`);
      const errors = [...run.stdout.matchAll(/^(\S+?)\((\d+),\d+\): error (TS\d+)/gm)].map(
        ([, path, line, code]) => `${path.split("/").pop()}:${line} ${code}`,
      );
      assert.equal(run.stdout.match(/error TS\d+/g)?.length ?? 0, errors.length, run.stdout);
      assert.deepEqual(errors, ["bad.ts:2 TS2322", "bad.ts:3 TS2741"], run.stdout);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
