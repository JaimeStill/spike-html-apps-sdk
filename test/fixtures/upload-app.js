// The upload page's app: upload() makes a client under /upload/, uploads a generated body to a
// route of test/browser/support/upload.ts, and reports the Result and every progress call, in a
// form the DevTools Protocol returns by value.

import { createClient } from "@jaimestill/spike-html-apps-sdk/api.js";

/** A body of `size` bytes: a Blob, a File, or a FormData holding a File and a field; or, for
 * "bigint", an object JSON.stringify can't encode. */
function body(kind, size) {
  const bytes = new Uint8Array(size).fill(97);
  switch (kind) {
    case "bigint":
      return { size: BigInt(size) };
    case "file":
      return new File([bytes], "upload.bin", { type: "application/octet-stream" });
    case "form": {
      const form = new FormData();
      form.append("note", "hello");
      form.append("file", new File([bytes], "upload.txt", { type: "text/plain" }));
      return form;
    }
    default:
      return new Blob([bytes], { type: "application/octet-stream" });
  }
}

/** A token provider that holds `token` and whose refresh gives `fresh`, counting its refreshes. */
function provider(token, fresh) {
  const p = {
    refreshes: 0,
    token: async () => token,
    refresh: async () => {
      p.refreshes++;
      token = fresh;
      return fresh;
    },
  };
  return p;
}

/** The Result's data as JSON can carry it: a Blob as its type, size, and text. */
async function plain(result) {
  if (!result.ok || !(result.data instanceof Blob)) return result;
  const { type, size } = result.data;
  return { ok: true, data: { blob: { type, size, text: await result.data.text() } } };
}

/** Uploads a body of `size` bytes of `kind` to /upload/<route>, with the token provider's `token`
 * and `fresh` when given, the method when given, and the signal `abort` names: "progress" aborts
 * at the first progress past 0, a number is AbortSignal.timeout's ms. Resolves to the Result, the
 * progress calls as [sent, total] pairs, and the provider's refreshes. */
window.upload = async ({ route, kind = "blob", size, token, fresh, method, abort }) => {
  const auth = token === undefined && fresh === undefined ? undefined : provider(token, fresh);
  const client = createClient({ base: "/upload", auth });
  const controller = new AbortController();
  const signal = typeof abort === "number" ? AbortSignal.timeout(abort) : controller.signal;
  const progress = [];
  const result = await client.upload(route, body(kind, size), {
    method,
    signal,
    progress: (sent, total) => {
      progress.push([sent, total]);
      if (abort === "progress" && sent > 0) controller.abort();
    },
  });
  return { result: await plain(result), progress, refreshes: auth?.refreshes ?? 0 };
};
