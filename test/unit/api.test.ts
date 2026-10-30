// The API client as a consumer imports it, the package's ./api.js export over the dist/ mise run
// build wrote, against a loopback node:http server each suite starts, its event streams written in
// chunks with delays between; and the sample documents service over it, at runtime and under tsc.

import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import {
  createClient,
  StreamError,
  type Client,
  type Problem,
  type Result,
  type ServerSentEvent,
} from "@jaimestill/spike-html-apps-sdk/api.js";
import type { TokenProvider } from "@jaimestill/spike-html-apps-sdk/auth.js";
import { documents } from "./documents.ts";
import { typecheck } from "./typecheck.ts";

/** Writes `body` (an object as JSON, a string or Buffer as it is) with `status`, `type`, and, when
 * given, the status text `message`. */
function send(
  res: ServerResponse,
  status: number,
  type: string | undefined,
  body: object | string,
  message?: string,
) {
  if (message !== undefined) res.statusMessage = message;
  const bytes = typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
  res.writeHead(status, type ? { "Content-Type": type } : {});
  res.end(bytes);
}

/** Starts a text/event-stream response, its headers sent at once so the client's stream resolves
 * before the first event; the response's close counted in `state.closed`. */
function startEvents(res: ServerResponse, state: State) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.flushHeaders();
  res.on("close", () => state.closed++);
}

/** Writes `chunks` to a started event stream, `delay` ms apart, then ends it. */
function writeEvents(res: ServerResponse, chunks: string[], delay = 10) {
  let at = 0;
  const next = () => {
    if (res.destroyed) return;
    if (at === chunks.length) return res.end();
    res.write(chunks[at++]);
    setTimeout(next, delay);
  };
  next();
}

/** The request's body, read whole, as text. */
async function text(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** An event stream's chunks: a "request" event echoing the method, Accept, and body, then three
 * "tick" events, split mid-line, mid-field, and inside a CRLF. */
function ticks(req: IncomingMessage, body: string) {
  const request = JSON.stringify({ method: req.method, accept: req.headers.accept, body });
  return [
    `event: request\ndata: ${request}\n\n`,
    "event: tick\nid: 1\nda",
    "ta: one\n\nevent: tick\r",
    "\ndata: two\r\n\r",
    "\nevent: tick\nid: 3\r\ndata: three\r\n\r",
    "\n",
  ];
}

const docs = [
  { id: 1, title: "one" },
  { id: 2, title: "two" },
  { id: 3, title: "three" },
];

/** A server's state: the requests it has received, those to /api/auth, the event-stream responses
 * that have closed, and the gate /api/events/gate waits on before its first event. */
interface State {
  authHits: number;
  closed: number;
  requests: number;
  gate: Promise<void>;
}

/** What /api/echo answers: the request as the server received it. */
interface Echo {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  bytes: number[];
}

/** The sample server's routes, by path under /api: each kind of body and failure the client
 * decodes, an echo of the request, a route behind a bearer token, and the documents service's. */
function handle(req: IncomingMessage, res: ServerResponse, state: State) {
  const url = new URL(req.url ?? "/", "http://loopback");
  const path = url.pathname.replace(/^\/api/, "");
  const chat = /^\/documents\/(\d+)\/chat$/.exec(path);
  if (chat) {
    text(req).then((body) => {
      const { prompt } = JSON.parse(body) as { prompt: string };
      startEvents(res, state);
      writeEvents(res, [
        `event: answer\ndata: document ${chat[1]}: ${prompt}\n\n`,
        "event: done\ndata: {}\n\n",
      ]);
    });
    return;
  }
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
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
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
    case "/events":
      text(req).then((body) => {
        startEvents(res, state);
        writeEvents(res, ticks(req, body));
      });
      return;
    case "/events/auth":
      if (req.headers.authorization !== "Bearer fresh") {
        return send(res, 401, "application/problem+json", {
          type: "about:blank",
          status: 401,
          title: "Unauthorized",
        });
      }
      startEvents(res, state);
      return writeEvents(res, ["data: authorized\n\n"]);
    case "/events/gate":
      // The first event waits for the test to open state.gate.
      startEvents(res, state);
      state.gate.then(() => writeEvents(res, ["data: through\n\n"]));
      return;
    case "/events/endless": {
      // A tick every 10 ms until the client goes.
      startEvents(res, state);
      let n = 0;
      const timer = setInterval(() => res.write(`data: ${++n}\n\n`), 10);
      res.on("close", () => clearInterval(timer));
      return;
    }
    case "/events/drop":
      // Two events, then the socket destroyed with the response unfinished.
      startEvents(res, state);
      res.write("data: 1\n\n");
      setTimeout(() => res.write("data: 2\n\n"), 10);
      setTimeout(() => req.socket.destroy(), 30);
      return;
    default:
      return send(res, 404, "text/plain", "no route", "Not Found");
  }
}

/** A loopback server over handle, listening; its origin and its per-server state, which counts
 * the requests it receives. */
async function serve() {
  const state: State = { authHits: 0, closed: 0, requests: 0, gate: Promise.resolve() };
  const server = createServer((req, res) => {
    state.requests++;
    handle(req, res, state);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  // A server listening on a TCP port has an AddressInfo for its address.
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, origin, state };
}

let loopback: Awaited<ReturnType<typeof serve>>;
let client: Client;

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
function provider(token: string, fresh: string | undefined, delay = 0) {
  const p: TokenProvider & { current: string | undefined; refreshes: number } = {
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

/** The data of `result`, which the case expects to succeed; the case fails, with the problem,
 * otherwise. */
function dataOf<T>(result: Result<T>): T {
  assert.ok(result.ok, JSON.stringify(result.ok ? undefined : result.problem));
  return result.data;
}

/** The problem of `result`, which the case expects to fail; the case fails otherwise. */
function problemOf(result: Result<unknown>): Problem {
  assert.ok(!result.ok, "the call succeeded");
  return result.problem;
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

  const cyclic: { title: string; self?: unknown } = { title: "loop" };
  cyclic.self = cyclic;
  const unencodable: [string, unknown, RegExp | undefined][] = [
    ["a BigInt", { n: 1n }, /BigInt/],
    ["a cycle", cyclic, /circular/],
    ["a function", () => {}, undefined],
  ];
  for (const [name, body, detail] of unencodable) {
    test(`a body JSON.stringify can't encode (${name}) is the encode problem, nothing sent`, async () => {
      const before = loopback.state.requests;
      for (const result of [await client.post("echo", body), await client.stream("events", body)]) {
        assert.equal(result.ok, false);
        const { detail: given, ...problem } = result.problem;
        assert.deepEqual(problem, {
          type: "urn:standards-lab:problem:encode",
          status: 0,
          title: "Request not encodable",
        });
        if (detail === undefined) assert.equal(given, undefined);
        else assert.match(given ?? "", detail);
      }
      assert.equal(loopback.state.requests, before);
    });
  }

  test("an undefined body is no body, sent as any call without one", async () => {
    const before = loopback.state.requests;
    const result = await client.post<Echo>("echo", undefined);
    assert.equal(dataOf(result).method, "POST");
    assert.equal(dataOf(result).headers["content-type"], undefined);
    assert.equal(dataOf(result).body, "");
    assert.equal(loopback.state.requests, before + 1);
  });
});

describe("the request", () => {
  test("a path joins the base whether or not it begins with /", async () => {
    for (const path of ["echo", "/echo"]) {
      const result = await client.get<Echo>(path);
      assert.equal(dataOf(result).url, "/api/echo");
    }
  });

  test("a base with a trailing / joins with one /", async () => {
    const result = await createClient({ base: `${loopback.origin}/api/` }).get<Echo>("/echo");
    assert.equal(dataOf(result).url, "/api/echo");
  });

  test("the base defaults to /api", async () => {
    const original = globalThis.fetch;
    const urls: unknown[] = [];
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
      const result = await createClient({ base: `${other.origin}/api` }).get<Echo>("/echo");
      assert.equal(dataOf(result).url, "/api/echo");
      assert.equal(dataOf(result).headers.host, new URL(other.origin).host);
    } finally {
      other.server.closeAllConnections();
      other.server.close();
    }
  });

  test("query sets parameters: an array once per element, undefined left out", async () => {
    const query = { q: "a b", page: 2, all: true, tag: ["x", "y"], skip: undefined };
    const result = await client.get<Echo>("echo", { query });
    assert.equal(dataOf(result).url, "/api/echo?q=a+b&page=2&all=true&tag=x&tag=y");
  });

  test("query appends to a path that has a query already", async () => {
    const result = await client.get<Echo>("echo?a=1", { query: { b: 2 } });
    assert.equal(dataOf(result).url, "/api/echo?a=1&b=2");
  });

  test("headers are added to the request", async () => {
    const result = await client.get<Echo>("echo", { headers: { "X-Trace": "t-1" } });
    assert.equal(dataOf(result).headers["x-trace"], "t-1");
  });

  for (const method of ["post", "put", "patch"] as const) {
    test(`${method} sends a plain body as JSON`, async () => {
      const result = await client[method]<Echo>("echo", { title: "new" });
      assert.equal(dataOf(result).method, method.toUpperCase());
      assert.equal(dataOf(result).headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(dataOf(result).body), { title: "new" });
    });
  }

  test("delete sends no body", async () => {
    const result = await client.delete<Echo>("echo");
    assert.equal(dataOf(result).method, "DELETE");
    assert.equal(dataOf(result).body, "");
  });

  test("a FormData body is sent as it is", async () => {
    const form = new FormData();
    form.set("title", "new");
    const result = await client.post<Echo>("echo", form);
    assert.match(dataOf(result).headers["content-type"] ?? "", /^multipart\/form-data; boundary=/);
    assert.match(dataOf(result).body, /name="title"\r\n\r\nnew\r\n/);
  });

  test("a Blob body is sent as it is, with its type", async () => {
    const result = await client.post<Echo>("echo", new Blob(["raw"], { type: "text/csv" }));
    assert.equal(dataOf(result).headers["content-type"], "text/csv");
    assert.equal(dataOf(result).body, "raw");
  });

  test("an ArrayBuffer, or a view of one, is sent as it is", async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    for (const body of [bytes, bytes.buffer, new DataView(bytes.buffer)]) {
      const result = await client.post<Echo>("echo", body);
      assert.equal(dataOf(result).headers["content-type"], undefined);
      assert.deepEqual(dataOf(result).bytes, [7, 8, 9]);
    }
  });

  test("a URLSearchParams body is sent as it is", async () => {
    const result = await client.post<Echo>("echo", new URLSearchParams({ a: "1" }));
    assert.match(
      dataOf(result).headers["content-type"] ?? "",
      /^application\/x-www-form-urlencoded/,
    );
    assert.equal(dataOf(result).body, "a=1");
  });
});

describe("the token", () => {
  test("a call carries Authorization: Bearer <token> when the provider gives one", async () => {
    const auth = provider("t-1", undefined);
    const result = await createClient({ base: `${loopback.origin}/api`, auth }).get<Echo>("echo");
    assert.equal(dataOf(result).headers.authorization, "Bearer t-1");
  });

  test("and none when it doesn't, as under anonymous, the default", async () => {
    const result = await client.get<Echo>("echo", { headers: { Authorization: "Bearer forged" } });
    assert.equal(dataOf(result).headers.authorization, undefined);
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
    assert.equal(problemOf(result).status, 401);
    assert.equal(auth.refreshes, 1);
    assert.equal(loopback.state.authHits - hits, 2);
  });

  test("anonymous returns the 401's problem", async () => {
    const result = await client.get("auth");
    assert.equal(result.ok, false);
    assert.equal(problemOf(result).status, 401);
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
    const echo = await rejecting.get<Echo>("echo");
    assert.equal(dataOf(echo).headers.authorization, undefined);
    const result = await rejecting.get("auth");
    assert.equal(problemOf(result).status, 401);
  });
});

/** Every event of a stream's Result, read to its end. */
async function collect(result: Result<AsyncIterable<ServerSentEvent>>) {
  assert.equal(result.ok, true, JSON.stringify(result.ok ? undefined : result.problem));
  const events: ServerSentEvent[] = [];
  for await (const event of result.data) events.push(event);
  return events;
}

/** Runs `fn` with a client over a server of its own, so no other test's response closes on it, and
 * the server's state. */
async function alone(fn: (client: Client, state: State) => Promise<void>) {
  const own = await serve();
  try {
    await fn(createClient({ base: `${own.origin}/api` }), own.state);
  } finally {
    own.server.closeAllConnections();
    own.server.close();
  }
}

/** Resolves once the server has seen a response close; fails when it hasn't within a second. */
async function closed(state: State) {
  const deadline = Date.now() + 1000;
  while (state.closed === 0) {
    assert.ok(Date.now() < deadline, "the server never saw the response close");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const ticked = [
  { type: "tick", data: "one", id: "1" },
  { type: "tick", data: "two", id: "1" },
  { type: "tick", data: "three", id: "3" },
];

// An endless stream that a defect leaves unended would stall the run: the timeout fails it instead.
describe("the stream", { timeout: 5000 }, () => {
  test("with no body, a GET with Accept: text/event-stream, its events parsed as they arrive", async () => {
    const [request, ...rest] = await collect(await client.stream("events"));
    assert.equal(request.type, "request");
    assert.deepEqual(JSON.parse(request.data), {
      method: "GET",
      accept: "text/event-stream",
      body: "",
    });
    assert.deepEqual(rest, ticked);
  });

  test("with a body, a POST that sends it as JSON", async () => {
    const options = { headers: { Accept: "application/json" } };
    const [request, ...rest] = await collect(await client.stream("events", { q: 1 }, options));
    assert.deepEqual(JSON.parse(request.data), {
      method: "POST",
      accept: "text/event-stream",
      body: '{"q":1}',
    });
    assert.deepEqual(rest, ticked);
  });

  test("resolves when the headers arrive, before the first event", async () => {
    await alone(async (own, state) => {
      const { promise, resolve: open } = Promise.withResolvers<void>();
      state.gate = promise;
      const result = await own.stream("events/gate");
      assert.equal(result.ok, true);
      open();
      assert.deepEqual(await collect(result), [{ type: "message", data: "through" }]);
    });
  });

  test("a problem document before the stream is the Result's problem", async () => {
    const result = await client.stream("documents/9");
    assert.equal(result.ok, false);
    assert.equal(result.problem.status, 404);
    assert.equal(result.problem.detail, "no document");
  });

  test("a 2xx response that isn't text/event-stream is the decode problem", async () => {
    const result = await client.stream("json");
    assert.equal(result.ok, false);
    assert.equal(result.problem.type, "urn:standards-lab:problem:decode");
    assert.equal(result.problem.status, 200);
  });

  test("a rejected fetch is the network problem, as any call's", async () => {
    const closed = await serve();
    closed.server.close();
    await once(closed.server, "close");
    const result = await createClient({ base: closed.origin }).stream("events");
    assert.equal(result.ok, false);
    assert.equal(result.problem.type, "urn:standards-lab:problem:network");
  });

  test("a 401 refreshes and retries once, then streams", async () => {
    const auth = provider("stale", "fresh");
    const streaming = createClient({ base: `${loopback.origin}/api`, auth });
    const events = await collect(await streaming.stream("events/auth"));
    assert.deepEqual(events, [{ type: "message", data: "authorized" }]);
    assert.equal(auth.refreshes, 1);
  });

  test("the caller's signal aborting mid-stream ends the events quietly", async () => {
    await alone(async (own, state) => {
      const controller = new AbortController();
      const result = await own.stream("events/endless", undefined, { signal: controller.signal });
      const events: ServerSentEvent[] = [];
      for await (const event of dataOf(result)) {
        events.push(event);
        if (events.length === 2) controller.abort();
      }
      assert.deepEqual(events.slice(0, 2), [
        { type: "message", data: "1" },
        { type: "message", data: "2" },
      ]);
      await closed(state);
    });
  });

  test("an abort while no read is pending ends the events quietly too", async () => {
    await alone(async (own, state) => {
      const controller = new AbortController();
      const result = await own.stream("events/endless", undefined, { signal: controller.signal });
      const iterator = dataOf(result)[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.data, "1");
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Ticks parsed already may still come; the abort ends the events after them, with no throw.
      let next;
      do next = await iterator.next();
      while (!next.done);
      await closed(state);
    });
  });

  test("the socket destroyed mid-stream throws a StreamError with the network problem", async () => {
    const result = await client.stream("events/drop");
    const events: string[] = [];
    await assert.rejects(
      async () => {
        for await (const event of dataOf(result)) events.push(event.data);
      },
      (error) => {
        assert.ok(error instanceof StreamError);
        assert.ok(error instanceof Error);
        assert.equal(error.name, "StreamError");
        assert.equal(error.problem.type, "urn:standards-lab:problem:network");
        assert.equal(error.problem.status, 0);
        assert.equal(error.problem.title, "Network error");
        return true;
      },
    );
    assert.deepEqual(events, ["1", "2"]);
  });

  test("breaking out of the loop cancels the response", async () => {
    await alone(async (own, state) => {
      const result = await own.stream("events/endless");
      for await (const event of dataOf(result)) {
        assert.equal(event.data, "1");
        break;
      }
      // The server sees the response close, which an endless stream does only when the client goes.
      await closed(state);
    });
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

  test("chat streams its answer", async () => {
    assert.deepEqual(await collect(await documents(client).chat(2, "summarize")), [
      { type: "answer", data: "document 2: summarize" },
      { type: "done", data: "{}" },
    ]);
  });

  // Node has no XMLHttpRequest, so the upload's own cases run in the browser tier.
  test("upload resolves to the network problem where there is no XMLHttpRequest", async () => {
    assert.equal(typeof XMLHttpRequest, "undefined");
    let progressed = false;
    const result = await documents(client).upload(2, new Blob(["text"]), () => {
      progressed = true;
    });
    assert.deepEqual(result, {
      ok: false,
      problem: {
        type: "urn:standards-lab:problem:network",
        status: 0,
        title: "Network error",
        detail: "XMLHttpRequest is not available here; upload needs a browser",
      },
    });
    assert.equal(progressed, false);
  });

  test("list resolves a Page", async () => {
    // The server echoes the page number it was sent.
    const result = await documents(client).list(2);
    assert.deepEqual(result, { ok: true, data: { items: docs, page: 2, size: 3, more: false } });
  });

  test("satisfies Service under tsc, which refuses a member that isn't an endpoint", () => {
    const bad = [
      `import type { Service } from "@jaimestill/spike-html-apps-sdk/service.js";`,
      `export const bad = { count: 1 } satisfies Service;`,
    ].join("\n");
    assert.deepEqual(typecheck({ "bad.ts": bad }, ["test/unit/documents.ts"]), ["bad.ts:2 TS2322"]);
  });
});
