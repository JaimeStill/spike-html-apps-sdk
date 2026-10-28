// The API client as a consumer imports it, the package's ./api.js export over the dist/ mise run
// build wrote, against a loopback node:http server each suite starts; and the sample documents
// service over it, at runtime and under tsc.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { createClient } from "@jaimestill/spike-html-apps-sdk/api.js";
import { documents } from "./documents.ts";

const root = join(import.meta.dirname, "../..");

/** Writes `body` (an object as JSON, a string or Buffer as it is) with `status`, `type`, and, when
 * given, the status text `message`. */
function send(res, status, type, body, message) {
  if (message !== undefined) res.statusMessage = message;
  const bytes = typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
  res.writeHead(status, type ? { "Content-Type": type } : {});
  res.end(bytes);
}

const docs = [
  { id: 1, title: "one" },
  { id: 2, title: "two" },
  { id: 3, title: "three" },
];

/** The sample server's routes, by path under /api: each kind of body and failure the client
 * decodes, an echo of the request, a route behind a bearer token, and the documents service's. */
function handle(req, res, state) {
  const url = new URL(req.url, "http://loopback");
  const path = url.pathname.replace(/^\/api/, "");
  const doc = /^\/documents\/(\d+)$/.exec(path);
  if (doc) {
    const found = docs.find(({ id }) => id === Number(doc[1]));
    if (found) return send(res, 200, "application/json", found);
    const missing = { type: "about:blank", status: 404, title: "Not Found", detail: "no document" };
    return send(res, 404, "application/problem+json", missing);
  }
  switch (path) {
    case "/documents": {
      const page = Number(url.searchParams.get("page") ?? 1);
      return send(res, 200, "application/json", { items: docs, page, size: 3, more: false });
    }
    case "/json":
      return send(res, 200, "application/json; charset=utf-8", { a: 1 });
    case "/vendor":
      return send(res, 200, "application/vnd.lab.thing+json", { b: [2] });
    case "/text":
      return send(res, 200, "text/plain; charset=utf-8", "hello");
    case "/bytes":
      return send(res, 200, "application/octet-stream", Buffer.from([1, 2, 3]));
    case "/no-content":
      return send(res, 204, undefined, "");
    case "/reset":
      return send(res, 205, undefined, "");
    case "/empty":
      return send(res, 200, "application/json", "");
    case "/malformed":
      return send(res, 200, "application/json", "{");
    case "/problem":
      return send(res, 422, "application/problem+json", {
        type: "urn:lab:invalid",
        status: 422,
        title: "Invalid document",
        detail: "title is required",
        instance: "/api/problem",
        request_id: "req-1",
        errors: [{ field: "title", message: "required" }],
      });
    case "/untitled":
      return send(res, 499, "application/problem+json", { type: "about:blank", status: 499 });
    case "/failure":
      return send(res, 503, "text/plain", "down", "Service Unavailable");
    case "/silent":
      // Node fills an empty status message in, so the response is written to the socket raw.
      return req.socket.end("HTTP/1.1 599 \r\nContent-Length: 4\r\nConnection: close\r\n\r\ndown");
    case "/slow": {
      const timer = setTimeout(() => send(res, 200, "application/json", { late: true }), 2000);
      res.on("close", () => clearTimeout(timer));
      return;
    }
    case "/auth":
      state.authHits++;
      if (req.headers.authorization === "Bearer fresh") {
        return send(res, 200, "application/json", { authorized: true });
      }
      return send(res, 401, "application/problem+json", {
        type: "about:blank",
        status: 401,
        title: "Unauthorized",
      });
    case "/echo": {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        send(res, 200, "application/json", {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body.toString("utf8"),
          bytes: [...body],
        });
      });
      return;
    }
    default:
      return send(res, 404, "text/plain", "no route", "Not Found");
  }
}

/** A loopback server over handle, listening; its origin and its per-server state. */
async function serve() {
  const state = { authHits: 0 };
  const server = createServer((req, res) => handle(req, res, state));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, state };
}

let loopback;
let client;

before(async () => {
  loopback = await serve();
  client = createClient({ base: `${loopback.origin}/api` });
});

after(() => {
  loopback.server.closeAllConnections();
  loopback.server.close();
});

/** A token provider that holds `token`, whose refresh, after `delay` ms, gives `fresh` (and holds
 * it), counting its calls. */
function provider(token, fresh, delay = 0) {
  const p = {
    current: token,
    refreshes: 0,
    token: async () => p.current,
    refresh: async () => {
      p.refreshes++;
      await new Promise((resolve) => setTimeout(resolve, delay));
      p.current = fresh;
      return fresh;
    },
  };
  return p;
}

describe("a success's data, decoded by content type", () => {
  test("application/json is parsed", async () => {
    assert.deepEqual(await client.get("json"), { ok: true, data: { a: 1 } });
  });

  test("a +json type is parsed", async () => {
    assert.deepEqual(await client.get("vendor"), { ok: true, data: { b: [2] } });
  });

  test("text/* is a string", async () => {
    assert.deepEqual(await client.get("text"), { ok: true, data: "hello" });
  });

  test("any other type is a Blob", async () => {
    const result = await client.get("bytes");
    assert.ok(result.ok);
    assert.ok(result.data instanceof Blob);
    assert.equal(result.data.type, "application/octet-stream");
    assert.deepEqual([...new Uint8Array(await result.data.arrayBuffer())], [1, 2, 3]);
  });

  for (const path of ["no-content", "reset", "empty"]) {
    test(`no body (${path}) is undefined`, async () => {
      assert.deepEqual(await client.get(path), { ok: true, data: undefined });
    });
  }

  test("a 2xx body that doesn't decode as its type claims is the decode problem, its status kept", async () => {
    const result = await client.get("malformed");
    assert.equal(result.ok, false);
    assert.equal(result.problem.type, "urn:standards-lab:problem:decode");
    assert.equal(result.problem.status, 200);
    assert.equal(result.problem.title, "Response not decodable");
  });
});

describe("a failing response's problem", () => {
  test("a problem document keeps every member, extension members included", async () => {
    assert.deepEqual(await client.get("problem"), {
      ok: false,
      problem: {
        type: "urn:lab:invalid",
        status: 422,
        title: "Invalid document",
        detail: "title is required",
        instance: "/api/problem",
        request_id: "req-1",
        errors: [{ field: "title", message: "required" }],
      },
    });
  });

  test("a problem document with no title is titled HTTP <status>", async () => {
    assert.deepEqual(await client.get("untitled"), {
      ok: false,
      problem: { type: "about:blank", status: 499, title: "HTTP 499" },
    });
  });

  test("any other failing response is about:blank, titled with its status text", async () => {
    assert.deepEqual(await client.get("failure"), {
      ok: false,
      problem: { type: "about:blank", status: 503, title: "Service Unavailable" },
    });
  });

  test("or HTTP <status> when its status text is empty", async () => {
    assert.deepEqual(await client.get("silent"), {
      ok: false,
      problem: { type: "about:blank", status: 599, title: "HTTP 599" },
    });
  });
});

describe("the problems the client makes itself", () => {
  test("a rejected fetch is the network problem, status 0", async () => {
    const closed = await serve();
    closed.server.close();
    await once(closed.server, "close");
    const result = await createClient({ base: closed.origin }).get("json");
    assert.equal(result.ok, false);
    assert.equal(result.problem.type, "urn:standards-lab:problem:network");
    assert.equal(result.problem.status, 0);
    assert.equal(result.problem.title, "Network error");
  });

  test("the caller's signal aborting is the abort problem", async () => {
    const controller = new AbortController();
    const pending = client.get("slow", { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    assert.deepEqual(await pending, {
      ok: false,
      problem: { type: "urn:standards-lab:problem:abort", status: 0, title: "Request aborted" },
    });
  });

  test("a signal aborted before the call is the abort problem too", async () => {
    const result = await client.get("json", { signal: AbortSignal.abort() });
    assert.equal(result.ok, false);
    assert.equal(result.problem.type, "urn:standards-lab:problem:abort");
  });

  test("an AbortSignal.timeout firing is the timeout problem", async () => {
    assert.deepEqual(await client.get("slow", { signal: AbortSignal.timeout(50) }), {
      ok: false,
      problem: { type: "urn:standards-lab:problem:timeout", status: 0, title: "Request timed out" },
    });
  });
});

describe("the request", () => {
  test("a path joins the base whether or not it begins with /", async () => {
    for (const path of ["echo", "/echo"]) {
      const result = await client.get(path);
      assert.equal(result.data.url, "/api/echo");
    }
  });

  test("a base with a trailing / joins with one /", async () => {
    const result = await createClient({ base: `${loopback.origin}/api/` }).get("/echo");
    assert.equal(result.data.url, "/api/echo");
  });

  test("the base defaults to /api", async () => {
    const original = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(url);
      return new Response(null, { status: 204 });
    };
    try {
      await createClient().get("documents/5");
      await createClient().get("/documents/5");
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(urls, ["/api/documents/5", "/api/documents/5"]);
  });

  test("an absolute base on another origin", async () => {
    const other = await serve();
    try {
      assert.notEqual(other.origin, loopback.origin);
      const result = await createClient({ base: `${other.origin}/api` }).get("/echo");
      assert.equal(result.data.url, "/api/echo");
      assert.equal(result.data.headers.host, new URL(other.origin).host);
    } finally {
      other.server.closeAllConnections();
      other.server.close();
    }
  });

  test("query sets parameters: an array once per element, undefined left out", async () => {
    const query = { q: "a b", page: 2, all: true, tag: ["x", "y"], skip: undefined };
    const result = await client.get("echo", { query });
    assert.equal(result.data.url, "/api/echo?q=a+b&page=2&all=true&tag=x&tag=y");
  });

  test("query appends to a path that has a query already", async () => {
    const result = await client.get("echo?a=1", { query: { b: 2 } });
    assert.equal(result.data.url, "/api/echo?a=1&b=2");
  });

  test("headers are added to the request", async () => {
    const result = await client.get("echo", { headers: { "X-Trace": "t-1" } });
    assert.equal(result.data.headers["x-trace"], "t-1");
  });

  for (const method of ["post", "put", "patch"]) {
    test(`${method} sends a plain body as JSON`, async () => {
      const result = await client[method]("echo", { title: "new" });
      assert.equal(result.data.method, method.toUpperCase());
      assert.equal(result.data.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(result.data.body), { title: "new" });
    });
  }

  test("delete sends no body", async () => {
    const result = await client.delete("echo");
    assert.equal(result.data.method, "DELETE");
    assert.equal(result.data.body, "");
  });

  test("a FormData body is sent as it is", async () => {
    const form = new FormData();
    form.set("title", "new");
    const result = await client.post("echo", form);
    assert.match(result.data.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.match(result.data.body, /name="title"\r\n\r\nnew\r\n/);
  });

  test("a Blob body is sent as it is, with its type", async () => {
    const result = await client.post("echo", new Blob(["raw"], { type: "text/csv" }));
    assert.equal(result.data.headers["content-type"], "text/csv");
    assert.equal(result.data.body, "raw");
  });

  test("an ArrayBuffer, or a view of one, is sent as it is", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    for (const body of [bytes, bytes.buffer, new DataView(bytes.buffer)]) {
      const result = await client.post("echo", body);
      assert.equal(result.data.headers["content-type"], undefined);
      assert.deepEqual(result.data.bytes, [7, 8, 9]);
    }
  });

  test("a URLSearchParams body is sent as it is", async () => {
    const result = await client.post("echo", new URLSearchParams({ a: "1" }));
    assert.match(result.data.headers["content-type"], /^application\/x-www-form-urlencoded/);
    assert.equal(result.data.body, "a=1");
  });
});

describe("the token", () => {
  test("a call carries Authorization: Bearer <token> when the provider gives one", async () => {
    const auth = provider("t-1", undefined);
    const result = await createClient({ base: `${loopback.origin}/api`, auth }).get("echo");
    assert.equal(result.data.headers.authorization, "Bearer t-1");
  });

  test("and none when it doesn't, as under anonymous, the default", async () => {
    const result = await client.get("echo", { headers: { Authorization: "Bearer forged" } });
    assert.equal(result.data.headers.authorization, undefined);
  });

  test("a 401 refreshes and retries once with the new token", async () => {
    const auth = provider("stale", "fresh");
    const hits = loopback.state.authHits;
    const result = await createClient({ base: `${loopback.origin}/api`, auth }).get("auth");
    assert.deepEqual(result, { ok: true, data: { authorized: true } });
    assert.equal(auth.refreshes, 1);
    assert.equal(loopback.state.authHits - hits, 2);
  });

  test("a refresh that gives no token returns the 401's problem, with no retry", async () => {
    const auth = provider("stale", undefined);
    const hits = loopback.state.authHits;
    const result = await createClient({ base: `${loopback.origin}/api`, auth }).get("auth");
    assert.deepEqual(result, {
      ok: false,
      problem: { type: "about:blank", status: 401, title: "Unauthorized" },
    });
    assert.equal(auth.refreshes, 1);
    assert.equal(loopback.state.authHits - hits, 1);
  });

  test("a retry's 401 is returned, never refreshed again", async () => {
    const auth = provider("stale", "still-stale");
    const hits = loopback.state.authHits;
    const result = await createClient({ base: `${loopback.origin}/api`, auth }).get("auth");
    assert.equal(result.problem.status, 401);
    assert.equal(auth.refreshes, 1);
    assert.equal(loopback.state.authHits - hits, 2);
  });

  test("anonymous returns the 401's problem", async () => {
    const result = await client.get("auth");
    assert.equal(result.ok, false);
    assert.equal(result.problem.status, 401);
  });

  test("401s arriving while a refresh is pending share that one refresh", async () => {
    const auth = provider("stale", "fresh", 200);
    const coalesced = createClient({ base: `${loopback.origin}/api`, auth });
    const results = await Promise.all([1, 2, 3, 4].map(() => coalesced.get("auth")));
    for (const result of results)
      assert.deepEqual(result, { ok: true, data: { authorized: true } });
    assert.equal(auth.refreshes, 1);
  });

  test("a refresh after the pending one settled is a refresh of its own", async () => {
    const auth = provider("stale", "fresh");
    const twice = createClient({ base: `${loopback.origin}/api`, auth });
    await twice.get("auth");
    auth.current = "stale";
    await twice.get("auth");
    assert.equal(auth.refreshes, 2);
  });

  test("a provider that rejects is taken as giving no token", async () => {
    const auth = {
      token: async () => {
        throw new Error("no store");
      },
      refresh: async () => {
        throw new Error("no store");
      },
    };
    const rejecting = createClient({ base: `${loopback.origin}/api`, auth });
    const echo = await rejecting.get("echo");
    assert.equal(echo.data.headers.authorization, undefined);
    const result = await rejecting.get("auth");
    assert.equal(result.problem.status, 401);
  });
});

describe("the sample documents service", () => {
  test("get resolves a document", async () => {
    assert.deepEqual(await documents(client).get(2), { ok: true, data: docs[1] });
  });

  test("get resolves a missing document's problem", async () => {
    const result = await documents(client).get(9);
    assert.equal(result.ok, false);
    assert.equal(result.problem.status, 404);
    assert.equal(result.problem.detail, "no document");
  });

  test("list resolves a Page", async () => {
    // The server echoes the page number it was sent.
    const result = await documents(client).list(2);
    assert.deepEqual(result, { ok: true, data: { items: docs, page: 2, size: 3, more: false } });
  });

  test("satisfies Service under tsc, which refuses a member that isn't an endpoint", () => {
    const scratch = mkdtempSync(join(tmpdir(), "documents-"));
    try {
      writeFileSync(
        join(scratch, "bad.ts"),
        [
          `import type { Service } from "@jaimestill/spike-html-apps-sdk/service.js";`,
          `export const bad = { count: 1 } satisfies Service;`,
        ].join("\n"),
      );
      const paths = { "@jaimestill/spike-html-apps-sdk/*": [join(root, "dist/*")] };
      writeFileSync(
        join(scratch, "tsconfig.json"),
        JSON.stringify({
          extends: join(root, "tsconfig.json"),
          compilerOptions: { rootDir: "/", noEmit: true, paths },
          files: [join(root, "test/unit/documents.ts"), join(scratch, "bad.ts")],
        }),
      );
      const run = spawnSync("tsc", ["-p", "."], { cwd: scratch, encoding: "utf8" });
      assert.equal(run.error, undefined, `tsc didn't run: ${run.error}`);
      const errors = [...run.stdout.matchAll(/^(\S+?)\(\d+,\d+\): error (TS\d+)/gm)].map(
        ([, path, code]) => `${path.split("/").pop()} ${code}`,
      );
      assert.equal(run.stdout.match(/error TS\d+/g)?.length ?? 0, errors.length, run.stdout);
      assert.deepEqual(errors, ["bad.ts TS2322"], run.stdout);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
