// A release's size budget: the brotli bytes of a pack's runtime files, its .js and .css, against a
// budget in bytes. The dependencies a consumer installs beside the pack are never counted.
// test/unit/release.test.js runs it on a pnpm pack.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { listFiles } from "./release.js";

/** The parameters each file is compressed with: brotli's maximum quality, 11, in text mode, its
 * other parameters node:zlib's defaults. */
export const brotliParams = {
  [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
  [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
};

/** The runtime files of root, a pack's package/: the .js and .css a page loads, relative to it,
 * sorted; never a declaration, the manifest, the README, or the LICENSE. */
export function runtimeFiles(root) {
  return listFiles(root).filter((path) => path.endsWith(".js") || path.endsWith(".css"));
}

/** The sum, over root's runtime files, of each file's size compressed alone with brotliParams. */
export function brotliBytes(root) {
  return runtimeFiles(root).reduce(
    (sum, path) =>
      sum + brotliCompressSync(readFileSync(join(root, path)), { params: brotliParams }).length,
    0,
  );
}

const bytes = (count) => `${count.toLocaleString("en-US")} B`;

/** What keeps root, the `layer`'s pack, within `budget` brotli bytes: one line naming the measured
 * size and the budget, or none. */
export function budgetProblems(root, layer, budget) {
  const measured = brotliBytes(root);
  return measured > budget
    ? [`${layer}: ${bytes(measured)} brotli over its budget of ${bytes(budget)}`]
    : [];
}
