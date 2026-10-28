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
    from: `    /** The HTTP status; 0 for a problem the client made itself (no response arrived). */
`,
    to: `    /** The HTTP status; 0 for a problem the client made itself with no response behind it, and the
     * response's status for a 2xx body that didn't decode. */
`,
    reason:
      "a 2xx body that doesn't decode is a problem the client makes with the response's status",
  },
  {
    file: "api.d.ts",
    from: `    request_id?: string;
`,
    to: `    request_id?: string;
    /** Extension members: go-web-sdk merges a Problem's Extras in at the document's top level, and
     * the client keeps every member the document carries. */
    [member: string]: unknown;
`,
    reason:
      "a problem document's extension members, which go-web-sdk merges in at its top level, are kept",
  },
  {
    file: "api.d.ts",
    from: `/** The type of a problem the client makes itself, with no response behind it: the network failed
 * (fetch rejected with a TypeError), the caller's signal aborted the call, or the signal's timeout
 * (AbortSignal.timeout) fired. A response that isn't a problem document becomes an "about:blank"
 * problem with the response's status and status text. */
`,
    to: `/** The type of a problem the client makes itself, each with a fixed title. With no response behind
 * it, status 0: the network failed (fetch rejected; "Network error"), the caller's signal aborted
 * the call ("Request aborted"), or the signal's timeout (AbortSignal.timeout) fired ("Request timed
 * out"). With the response's status: a 2xx body didn't decode as its content type claims
 * ("Response not decodable"). A failing response that isn't a problem document becomes an
 * "about:blank" problem titled with the response's status text, or "HTTP <status>" when it has
 * none, as does a problem document with no title. */
`,
    reason:
      "the client's problems name their fixed titles, the decode problem, and the untitled fallback",
  },
  {
    file: "api.d.ts",
    from: `"urn:standards-lab:problem:timeout";`,
    to: `"urn:standards-lab:problem:timeout" | "urn:standards-lab:problem:decode";`,
    reason:
      "a 2xx body that doesn't decode as its content type claims is the client's decode problem",
  },
  {
    file: "api.d.ts",
    from: `/** A call's outcome: the decoded body, or the problem that stopped it. */
`,
    to: `/** A call's outcome: the decoded body, or the problem that stopped it. A body decodes by its content
 * type: JSON (application/json or any +json type) parsed, text/* a string, any other a Blob, and no
 * body (a 204 or 205, or an empty body) undefined. */
`,
    reason: "a success's data is decoded by content type, which the result names",
  },
  {
    file: "api.d.ts",
    from: `/** A call's options: the signal that aborts it. */
`,
    to: `/** A call's options: the signal that aborts it, the query parameters set on its URL, and the
 * headers added to its request. A query value is set as its string; an array sets its name once per
 * element, in order; an undefined value is left out. The client sets Authorization itself, over any
 * header of that name here, and Content-Type when it sends the body as JSON. */
`,
    reason: "a call's options gain the query and headers, and how each applies",
  },
  {
    file: "api.d.ts",
    from: `    signal?: AbortSignal;
`,
    to: `    signal?: AbortSignal;
    query?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>>;
    headers?: Readonly<Record<string, string>>;
`,
    reason: "a call sets query parameters and adds headers",
  },
  {
    file: "api.d.ts",
    from: `/** How a client is made: the base URL every path is resolved under ("/api" by default), and the
 * token provider whose token each call carries (anonymous by default). */
`,
    to: `/** How a client is made: the base every path joins under ("/api" by default), and the token
 * provider whose token each call carries (anonymous by default). The base may be an absolute URL,
 * on another origin. A path joins the base with one "/" whether or not it begins with one: under
 * "/api", "documents/5" and "/documents/5" both give "/api/documents/5", where URL resolution would
 * drop "/api" for the second. */
`,
    reason:
      "a path joins the base by text, not URL resolution, and the base may be on another origin",
  },
  {
    file: "api.d.ts",
    from: `/** The API client. Each method sends the path under the base URL with
 * \`Authorization: Bearer <token>\` when the provider has a token, and on a 401 asks the provider to
 * refresh and retries once with the refreshed token, if there is one. A body is sent as JSON. */
`,
    to: `/** The API client. Each method sends the path, joined under the base, with
 * \`Authorization: Bearer <token>\` when the provider has a token and none when it doesn't. On a 401
 * it asks the provider to refresh and retries once with the refreshed token, or returns the 401's
 * problem when the refresh gives none; 401s that arrive while a refresh is pending share that one
 * refresh. A FormData, Blob, ArrayBuffer or view, or URLSearchParams body is sent as it is; any
 * other body is sent as JSON. */
`,
    reason: "concurrent 401s share one refresh, and a body is sent as it is or as JSON by its kind",
  },
  {
    file: "api.d.ts",
    from: ` * out"). With the response's status: a 2xx body didn't decode as its content type claims
 * ("Response not decodable"). A failing response that isn't a problem document becomes an
 * "about:blank" problem titled with the response's status text, or "HTTP <status>" when it has
 * none, as does a problem document with no title. */
`,
    to: ` * out"). With the response's status: a 2xx body didn't decode as its content type claims, or a
 * stream's 2xx response isn't text/event-stream ("Response not decodable"). A failing response
 * that isn't a problem document becomes an "about:blank" problem titled with the response's status
 * text, or "HTTP <status>" when it has none, as does a problem document with no title. */
`,
    reason: "a stream's 2xx response that isn't text/event-stream is the client's decode problem",
  },
  {
    file: "api.d.ts",
    from: `/** A call's outcome: the decoded body`,
    to: `/** One event of a text/event-stream response, as the WHATWG HTML standard parses it: its type,
 * "message" when the stream names none; its data, its data lines joined with "\\n"; and the last
 * event id the stream set, when one is set, carried from an earlier event as an EventSource's
 * lastEventId is. A \`retry\` field is parsed and dropped: the client makes no reconnection. */
export interface ServerSentEvent {
    type: string;
    data: string;
    id?: string;
}
/** The error a stream's events throw when the network fails after the stream resolved, its
 * \`problem\` the network problem a call would have resolved to. It is the one error the client
 * throws; the caller's signal ends the events quietly instead. */
export declare class StreamError extends Error {
    readonly problem: Problem;
    constructor(problem: Problem);
}
/** A call's outcome: the decoded body`,
    reason: "a stream's events, and the error that carries a network failure after it resolved",
  },
  {
    file: "api.d.ts",
    from: ` * header of that name here, and Content-Type when it sends the body as JSON. */
`,
    to: ` * header of that name here, Content-Type when it sends the body as JSON, and Accept on a stream. */
`,
    reason: "a stream sets its own Accept header",
  },
  {
    file: "api.d.ts",
    from: ` * other body is sent as JSON. */
`,
    to: ` * other body is sent as JSON.
 *
 * \`stream\` sends a POST with the body when it is given one and a GET when it isn't, with
 * \`Accept: text/event-stream\`, and resolves when the response's headers arrive, before its first
 * event: to the problem, as any call's, or to the events, read as they arrive. A 2xx response that
 * isn't text/event-stream is the decode problem. The caller's signal ends the events quietly; the
 * network failing throws a StreamError; and leaving the loop early cancels the response. */
`,
    reason: "the client's stream, its request, when it resolves, and how its events end",
  },
  {
    file: "api.d.ts",
    from: `    delete<T>(path: string, options?: RequestOptions): Promise<Result<T>>;
`,
    to: `    delete<T>(path: string, options?: RequestOptions): Promise<Result<T>>;
    stream(path: string, body?: unknown, options?: RequestOptions): Promise<Result<AsyncIterable<ServerSentEvent>>>;
`,
    reason: "the client streams a text/event-stream response's events",
  },
  {
    file: "api.d.ts",
    from: `    headers?: Readonly<Record<string, string>>;
}
`,
    to: `    headers?: Readonly<Record<string, string>>;
}
/** An upload's options: a call's, the method, POST by default or PUT, and \`progress\`, called with
 * the bytes of the body sent and its total as the body goes out: at 0 when each send starts, a
 * retry's included, then as bytes are sent, and at the total once the whole body is sent. The
 * total is 0 when the browser can't compute it. */
export interface UploadOptions extends RequestOptions {
    method?: "POST" | "PUT";
    progress?: (sent: number, total: number) => void;
}
`,
    reason: "an upload's options: a call's, its method, and the progress callback",
  },
  {
    file: "api.d.ts",
    from: ` * network failing throws a StreamError; and leaving the loop early cancels the response. */
`,
    to: ` * network failing throws a StreamError; and leaving the loop early cancels the response.
 *
 * \`upload\` sends the body over XMLHttpRequest, as any call's body is sent, reporting its progress,
 * and resolves as any call does, its data decoded and its problems made the same way. Where there
 * is no XMLHttpRequest (on Node, say) it resolves to the network problem. */
`,
    reason: "the client's upload, over XMLHttpRequest, and its Result where there is none",
  },
  {
    file: "api.d.ts",
    from: `    stream(path: string, body?: unknown, options?: RequestOptions): Promise<Result<AsyncIterable<ServerSentEvent>>>;
`,
    to: `    stream(path: string, body?: unknown, options?: RequestOptions): Promise<Result<AsyncIterable<ServerSentEvent>>>;
    upload<T>(path: string, body: unknown, options?: UploadOptions): Promise<Result<T>>;
`,
    reason: "the client uploads a body, reporting its progress",
  },
  {
    file: "api.d.ts",
    from: `/** The type of a problem the client makes itself, each with a fixed title. With no response behind
 * it, status 0: the network failed (fetch rejected; "Network error"), the caller's signal aborted
 * the call ("Request aborted"), or the signal's timeout (AbortSignal.timeout) fired ("Request timed
 * out"). With the response's status: a 2xx body didn't decode as its content type claims, or a
 * stream's 2xx response isn't text/event-stream ("Response not decodable"). A failing response
 * that isn't a problem document becomes an "about:blank" problem titled with the response's status
 * text, or "HTTP <status>" when it has none, as does a problem document with no title. */
`,
    to: `/** The type of a problem the client makes itself, each with a fixed title. With no response behind
 * it, status 0: the request body isn't encodable as JSON, JSON.stringify throwing on it (a BigInt,
 * a cycle) or giving nothing (a function, a symbol), and nothing is sent ("Request not encodable",
 * with the error's message as its detail when there is one); the request failed in flight (fetch
 * rejected; "Network error"); the caller's signal aborted the call ("Request aborted"); or the
 * signal's timeout (AbortSignal.timeout) fired ("Request timed out"). With the response's status:
 * a 2xx body didn't decode as its content type claims, or a stream's 2xx response isn't
 * text/event-stream ("Response not decodable"). A failing response that isn't a problem document
 * becomes an "about:blank" problem titled with the response's status text, or "HTTP <status>"
 * when that text is empty; a problem document with no title is titled "HTTP <status>". */
`,
    reason:
      "the client names the encode problem, the network problem only a failure in flight, and the untitled rule plainly",
  },
  {
    file: "api.d.ts",
    from: `"urn:standards-lab:problem:decode";`,
    to: `"urn:standards-lab:problem:decode" | "urn:standards-lab:problem:encode";`,
    reason: "a request body JSON.stringify can't encode is the client's encode problem, unsent",
  },
  {
    file: "eventstream.d.ts",
    reason: "the event-stream parser, internal: the client's stream reads a response through it",
  },
  {
    file: "events.d.ts",
    reason: "the event-sequence interface: a CloudEvent, its opaque cursor, and the sequence read",
  },
  {
    file: "events/nats.d.ts",
    reason: "the NATS adapter: an event sequence over a JetStream stream, read over WebSocket",
  },
  {
    file: "router.d.ts",
    from: `/** How a router is made: the element it mounts each route's element into, the base path the app
 * is served under ("/" by default), which every pattern and navigate() path is relative to, and
 * the element mounted when nothing matches. */
`,
    to: `/** How a router is made: the element it mounts each route's element into; the base path the app
 * is served under, which every pattern and navigate() path is relative to: this option, else the
 * pathname of the href of the document's <base> element, else "/"; the element mounted when
 * nothing matches; and the element mounted when a route fails. */
`,
    reason:
      'the base falls back to the <base> element\'s href before "/", and a failed route mounts',
  },
  {
    file: "router.d.ts",
    from: `    notFound?: string | Loader;
`,
    to: `    notFound?: string | Loader;
    error?: string | Loader;
`,
    reason: "the error option names the element a failed route mounts, as a route's tag or loader",
  },
  {
    file: "router.d.ts",
    from: `/** An app's router. Once started, it intercepts every same-document navigation (a plain link's
 * click included) through the Navigation API's navigate event, matches the destination with
 * URLPattern, and replaces the outlet's content with the route's element, each path param set on
 * it as an attribute of the same name. */
`,
    to: `/** An app's router. Once started, it intercepts every same-origin navigation under its base (a
 * plain link's click, back and forward, and navigate() included; a download, a fragment-only
 * change, a form post, and a reload are left to the browser) through the Navigation API's navigate
 * event, matches the destination with URLPattern, and replaces the outlet's content with the
 * route's element, each path param set on it as an attribute of the same name. A route fails when
 * its loader rejects or its tag isn't a defined custom element; on a navigation the router didn't
 * start itself, whose URL is already committed, the outlet then holds the error element (or
 * nothing) and the navigation fails (navigateerror). It dispatches "change" after each mount and
 * each query change, with \`current\` already updated. */
`,
    reason:
      "the router names what it leaves to the browser, how a route fails, and its change event",
  },
  {
    file: "router.d.ts",
    from: `export interface Router {`,
    to: `export interface Router extends EventTarget {`,
    reason: "the router is an EventTarget, which dispatches change",
  },
  {
    file: "router.d.ts",
    from: `    /** The route the current location matches, or undefined when none does. */
`,
    to: `    /** The route the current location matches, or undefined when none does or its route failed. */
`,
    reason: "current is undefined after a failed route too",
  },
  {
    file: "router.d.ts",
    from: `    /** Mounts the current location's route and begins intercepting navigations. */
    start(): void;
`,
    to: `    /** Mounts the current location's route and begins intercepting navigations; resolves once the
     * route is mounted, and rejects, with the error element mounted, when the route fails. */
    start(): Promise<void>;
`,
    reason: "start() returns a promise of the first mount, which rejects when the route fails",
  },
  {
    file: "router.d.ts",
    from: `    /** Navigates to \`path\`, relative to the base, and resolves once its element is mounted. */
`,
    to: `    /** Loads the route at \`path\`, relative to the base, then navigates to it, and resolves once its
     * element is mounted. When the route fails it rejects before navigating, leaving the URL, the
     * outlet, and \`current\` unchanged. */
`,
    reason: "navigate() loads the route before it navigates, and fails without navigating",
  },
  {
    file: "router.d.ts",
    from: `     * replacing the history entry by default; the route's element stays mounted. */
    query(changes: Readonly<Record<string, string | undefined>>, options?: NavigateOptions): void;
`,
    to: `     * replacing the history entry by default; the route's element stays mounted. Resolves once
     * \`current.query\` is updated. */
    query(changes: Readonly<Record<string, string | undefined>>, options?: NavigateOptions): Promise<void>;
`,
    reason: "query() returns a promise that resolves once current.query is updated",
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
