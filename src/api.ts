// The application SDK's API client, on fetch and AbortSignal, and on XMLHttpRequest for an upload,
// whose progress fetch doesn't report: the problem, the result, the page, the server-sent event,
// the client's options and shape, and createClient. Every call resolves to a Result and never
// rejects; a stream's events, read after it resolves, are the one place an error is thrown.
// Adapted from spike-html-packages-sdk (9d10ca6): src/api.d.ts, its declarations made a module.
// test/fixtures/v0.1.0/api.d.ts is that file, which the emitted declaration matches but for the
// differences test/unit/declarations.test.js expects.

import type { TokenProvider } from "./auth.ts";
import { anonymous } from "./auth.ts";
import { EventStreamParser } from "./eventstream.ts";

/** An RFC 9457 problem document, as go-web-sdk's Problem writes it, with `title` always present:
 * go-web-sdk's Write defaults it to the status phrase, but omits it for a status outside net/http's
 * table, where the client fills it. `detail` and `instance` are omitted when empty, and
 * `request_id` is present when the server's request carried a correlation id. */
export interface Problem {
  /** A URI naming the problem's kind: "about:blank" for a status with no further meaning, or one
   * of the ClientProblemType URIs for a problem the client made itself. */
  type: string;
  /** The HTTP status; 0 for a problem the client made itself with no response behind it, and the
   * response's status for a 2xx body that didn't decode. */
  status: number;
  title: string;
  detail?: string;
  instance?: string;
  request_id?: string;
  /** Extension members: go-web-sdk merges a Problem's Extras in at the document's top level, and
   * the client keeps every member the document carries. */
  [member: string]: unknown;
}

/** The type of a problem the client makes itself, each with a fixed title. With no response behind
 * it, status 0: the request body isn't encodable as JSON, JSON.stringify throwing on it (a BigInt,
 * a cycle) or giving nothing (a function, a symbol), and nothing is sent ("Request not encodable",
 * with the error's message as its detail when there is one); the request failed in flight (fetch
 * rejected; "Network error"); the caller's signal aborted the call ("Request aborted"); or the
 * signal's timeout (AbortSignal.timeout) fired ("Request timed out"). With the response's status: a 2xx body didn't decode as its content type claims, or a
 * stream's 2xx response isn't text/event-stream ("Response not decodable"). A failing response
 * that isn't a problem document becomes an "about:blank" problem titled with the response's status
 * text, or "HTTP <status>" when it has none, as does a problem document with no title. */
export type ClientProblemType =
  | "urn:standards-lab:problem:network"
  | "urn:standards-lab:problem:abort"
  | "urn:standards-lab:problem:timeout"
  | "urn:standards-lab:problem:decode"
  | "urn:standards-lab:problem:encode";

/** One event of a text/event-stream response, as the WHATWG HTML standard parses it: its type,
 * "message" when the stream names none; its data, its data lines joined with "\n"; and the last
 * event id the stream set, when one is set, carried from an earlier event as an EventSource's
 * lastEventId is. A `retry` field is parsed and dropped: the client makes no reconnection. */
export interface ServerSentEvent {
  type: string;
  data: string;
  id?: string;
}

/** The error a stream's events throw when the network fails after the stream resolved, its
 * `problem` the network problem a call would have resolved to. It is the one error the client
 * throws; the caller's signal ends the events quietly instead. */
export class StreamError extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail === undefined ? problem.title : `${problem.title}: ${problem.detail}`);
    this.name = "StreamError";
    this.problem = problem;
  }
}

/** A call's outcome: the decoded body, or the problem that stopped it. A body decodes by its content
 * type: JSON (application/json or any +json type) parsed, text/* a string, any other a Blob, and no
 * body (a 204 or 205, or an empty body) undefined. */
export type Result<T> = { ok: true; data: T } | { ok: false; problem: Problem };

/** go-web-sdk's paginated read envelope, the whole response body. `page` is the 1-based number of
 * a read addressed by number and `total` the row count when the read counted one; both are absent
 * under a cursor. `next`, when present, is the cursor that continues from this page; `more` with
 * no `next` is a further page reachable only by number. */
export interface Page<T> {
  items: T[];
  page?: number;
  size: number;
  total?: number;
  more: boolean;
  next?: string;
}

/** A call's options: the signal that aborts it, the query parameters set on its URL, and the
 * headers added to its request. A query value is set as its string; an array sets its name once per
 * element, in order; an undefined value is left out. The client sets Authorization itself, over any
 * header of that name here, Content-Type when it sends the body as JSON, and Accept on a stream. */
export interface RequestOptions {
  signal?: AbortSignal;
  query?: Readonly<
    Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>
  >;
  headers?: Readonly<Record<string, string>>;
}

/** An upload's options: a call's, the method, POST by default or PUT, and `progress`, called with
 * the bytes of the body sent and its total as the body goes out: at 0 when each send starts, a
 * retry's included, then as bytes are sent, and at the total once the whole body is sent. The
 * total is 0 when the browser can't compute it. */
export interface UploadOptions extends RequestOptions {
  method?: "POST" | "PUT";
  progress?: (sent: number, total: number) => void;
}

/** How a client is made: the base every path joins under ("/api" by default), and the token
 * provider whose token each call carries (anonymous by default). The base may be an absolute URL,
 * on another origin. A path joins the base with one "/" whether or not it begins with one: under
 * "/api", "documents/5" and "/documents/5" both give "/api/documents/5", where URL resolution would
 * drop "/api" for the second. */
export interface ClientOptions {
  base?: string;
  auth?: TokenProvider;
}

/** The API client. Each method sends the path, joined under the base, with
 * `Authorization: Bearer <token>` when the provider has a token and none when it doesn't. On a 401
 * it asks the provider to refresh and retries once with the refreshed token, or returns the 401's
 * problem when the refresh gives none; 401s that arrive while a refresh is pending share that one
 * refresh. A FormData, Blob, ArrayBuffer or view, or URLSearchParams body is sent as it is; any
 * other body is sent as JSON.
 *
 * `stream` sends a POST with the body when it is given one and a GET when it isn't, with
 * `Accept: text/event-stream`, and resolves when the response's headers arrive, before its first
 * event: to the problem, as any call's, or to the events, read as they arrive. A 2xx response that
 * isn't text/event-stream is the decode problem. The caller's signal ends the events quietly; the
 * network failing throws a StreamError; and leaving the loop early cancels the response.
 *
 * `upload` sends the body over XMLHttpRequest, as any call's body is sent, reporting its progress,
 * and resolves as any call does, its data decoded and its problems made the same way. Where there
 * is no XMLHttpRequest (on Node, say) it resolves to the network problem. */
export interface Client {
  get<T>(path: string, options?: RequestOptions): Promise<Result<T>>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  delete<T>(path: string, options?: RequestOptions): Promise<Result<T>>;
  stream(
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<Result<AsyncIterable<ServerSentEvent>>>;
  upload<T>(path: string, body: unknown, options?: UploadOptions): Promise<Result<T>>;
}

/** Makes a client. */
export function createClient(options: ClientOptions = {}): Client {
  const base = options.base ?? "/api";
  const auth = options.auth ?? anonymous;
  // The refresh pending, which every 401 that arrives meanwhile awaits instead of starting its own.
  let refreshing: Promise<string | undefined> | undefined;

  function refresh(): Promise<string | undefined> {
    refreshing ??= settle(auth.refresh()).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  /** The response that `send` gives, sending the request with its headers, which carry the
   * provider's token, and once more with the refreshed token after a 401; it rejects as `send`
   * does. Every request, a call's, a stream's, and an upload's, is sent through it. `accept`, when
   * given, is the Accept header, over any of the caller's. */
  async function respond(
    path: string,
    body: unknown,
    request: RequestOptions,
    send: (
      url: string,
      headers: Headers,
      payload: XMLHttpRequestBodyInit | undefined,
    ) => Promise<Response>,
    accept?: string,
  ): Promise<Response> {
    const url = join(base, path, request.query);
    const headers = new Headers(request.headers);
    if (accept !== undefined) headers.set("Accept", accept);
    const payload = encode(body, headers);
    const authorized = (token: string | undefined) => {
      if (token === undefined) headers.delete("Authorization");
      else headers.set("Authorization", `Bearer ${token}`);
      return send(url, headers, payload);
    };
    let response = await authorized(await settle(auth.token()));
    if (response.status === 401) {
      const token = await refresh();
      if (token !== undefined) {
        await response.body?.cancel();
        response = await authorized(token);
      }
    }
    return response;
  }

  /** `respond` over fetch, for a call and a stream. */
  function fetched(
    method: string,
    path: string,
    body: unknown,
    request: RequestOptions,
    accept?: string,
  ): Promise<Response> {
    const send = (url: string, headers: Headers, payload: BodyInit | undefined) =>
      fetch(url, { method, headers, body: payload, signal: request.signal });
    return respond(path, body, request, send, accept);
  }

  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    request: RequestOptions = {},
  ): Promise<Result<T>> {
    try {
      return await decode<T>(await fetched(method, path, body, request));
    } catch (error) {
      return { ok: false, problem: failure(error, request.signal) };
    }
  }

  async function stream(
    path: string,
    body: unknown,
    request: RequestOptions = {},
  ): Promise<Result<AsyncIterable<ServerSentEvent>>> {
    const method = body === undefined ? "GET" : "POST";
    try {
      const response = await fetched(method, path, body, request, "text/event-stream");
      if (!response.ok) return { ok: false, problem: await problem(response) };
      const type = mediaType(response);
      if (type !== "text/event-stream" || response.body === null) {
        await response.body?.cancel();
        return {
          ok: false,
          problem: {
            type: "urn:standards-lab:problem:decode",
            status: response.status,
            title: "Response not decodable",
            detail: `${type || "no content type"} is not text/event-stream`,
          },
        };
      }
      return { ok: true, data: events(response.body, request.signal) };
    } catch (error) {
      return { ok: false, problem: failure(error, request.signal) };
    }
  }

  async function upload<T>(
    path: string,
    body: unknown,
    request: UploadOptions = {},
  ): Promise<Result<T>> {
    try {
      if (typeof XMLHttpRequest === "undefined") {
        throw new TypeError("XMLHttpRequest is not available here; upload needs a browser");
      }
      const method = request.method ?? "POST";
      const send = (url: string, headers: Headers, payload: XMLHttpRequestBodyInit | undefined) =>
        transmit(method, url, headers, payload, request);
      return await decode<T>(await respond(path, body, request, send));
    } catch (error) {
      return { ok: false, problem: failure(error, request.signal) };
    }
  }

  return {
    get: (path, options) => call("GET", path, undefined, options),
    post: (path, body, options) => call("POST", path, body, options),
    put: (path, body, options) => call("PUT", path, body, options),
    patch: (path, body, options) => call("PATCH", path, body, options),
    delete: (path, options) => call("DELETE", path, undefined, options),
    stream: (path, body, options) => stream(path, body, options),
    upload: (path, body, options) => upload(path, body, options),
  };
}

/** One send of an upload over XMLHttpRequest, resolving to its response as a Response, so it
 * decodes, and makes its problem, as fetch's does. It rejects as fetch does: with the signal's
 * reason when the signal aborts it, and with a TypeError when the network fails. */
function transmit(
  method: string,
  url: string,
  headers: Headers,
  payload: XMLHttpRequestBodyInit | undefined,
  request: UploadOptions,
): Promise<Response> {
  const { signal, progress } = request;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.responseType = "blob";
    headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    if (progress !== undefined) {
      // loadstart reports 0 as each send starts, a retry's too, and load the total once the whole
      // body is sent. A listener on xhr.upload makes a cross-origin upload preflighted.
      const report = (event: ProgressEvent) => progress(event.loaded, event.total);
      for (const type of ["loadstart", "progress", "load"]) {
        xhr.upload.addEventListener(type, report as EventListener);
      }
    }
    const abort = () => xhr.abort();
    signal?.addEventListener("abort", abort, { once: true });
    xhr.addEventListener("loadend", () => signal?.removeEventListener("abort", abort));
    xhr.addEventListener("load", () => {
      try {
        resolve(response(xhr));
      } catch (error) {
        reject(error);
      }
    });
    xhr.addEventListener("error", () => reject(new TypeError(`${method} ${url} failed`)));
    xhr.addEventListener("abort", () => reject(signal?.reason));
    xhr.send(payload ?? null);
  });
}

/** A finished XMLHttpRequest's response as a Response: its status, status text, headers, and its
 * body, none for a status that may carry none. */
function response(xhr: XMLHttpRequest): Response {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const empty = [204, 205, 304].includes(xhr.status);
  return new Response(empty ? null : (xhr.response as Blob), {
    status: xhr.status,
    statusText: xhr.statusText,
    headers,
  });
}

/** The events of a text/event-stream body, parsed as its chunks arrive. A read that fails ends
 * the events quietly when `signal` aborted it, and throws a StreamError with the network problem
 * otherwise. However the loop ends, a break or a throw in it included, the body is cancelled. */
async function* events(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const reader = body.getReader();
  const parser = new EventStreamParser();
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) return;
        throw new StreamError(failure(error, undefined));
      }
      if (chunk.done) break;
      yield* parser.push(chunk.value);
    }
    yield* parser.end();
  } finally {
    // A body read to its end, or one that failed, has nothing left to cancel, and its cancel
    // settles at once; a cancel that rejects has no caller to tell.
    await reader.cancel().catch(() => {});
  }
}

/** A provider's token, or undefined when the provider rejects, which the client treats as having
 * none rather than rejecting itself. */
async function settle(token: Promise<string | undefined>): Promise<string | undefined> {
  try {
    return await token;
  } catch {
    return undefined;
  }
}

/** `path` joined under `base` with one "/", by text, since URL resolution drops the base's path
 * for a path that begins with "/", and the query's parameters appended. */
function join(base: string, path: string, query: RequestOptions["query"]): string {
  let url = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    for (const each of Array.isArray(value) ? value : [value]) params.append(name, String(each));
  }
  if (params.size > 0) url += `${url.includes("?") ? "&" : "?"}${params}`;
  return url;
}

/** The error `encode` throws for a body JSON.stringify can't encode, which `failure` makes the encode
 * problem; its message is the stringify error's, or empty when stringify gave nothing. */
class Unencodable extends Error {}

/** The request body for `body`: none for undefined, the kinds fetch and XMLHttpRequest send as they
 * are, and JSON, with its Content-Type set on `headers`, for any other. A body JSON.stringify throws
 * on, or gives nothing for, throws Unencodable before anything is sent. */
function encode(body: unknown, headers: Headers): XMLHttpRequestBodyInit | undefined {
  if (body === undefined) return undefined;
  if (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams
  ) {
    return body as XMLHttpRequestBodyInit;
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(body);
  } catch (error) {
    throw new Unencodable(error instanceof Error ? error.message : String(error));
  }
  // JSON.stringify's type claims a string, but it gives undefined for a function or a symbol.
  if (json === undefined) throw new Unencodable();
  headers.set("Content-Type", "application/json");
  return json;
}

/** The response's media type, lowercased, without its parameters; "" when it has none. */
function mediaType(response: Response): string {
  return (response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
}

function isJSON(type: string): boolean {
  return type === "application/json" || type.endsWith("+json");
}

/** A response's Result: its body decoded by content type when it succeeded, its problem when it
 * didn't. */
async function decode<T>(response: Response): Promise<Result<T>> {
  if (!response.ok) return { ok: false, problem: await problem(response) };
  const type = mediaType(response);
  const blob = await response.blob();
  if (response.status === 204 || response.status === 205 || blob.size === 0) {
    return { ok: true, data: undefined as T };
  }
  if (isJSON(type)) {
    const text = await blob.text();
    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch (error) {
      return {
        ok: false,
        problem: {
          type: "urn:standards-lab:problem:decode",
          status: response.status,
          title: "Response not decodable",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
  if (type.startsWith("text/")) return { ok: true, data: (await blob.text()) as T };
  return { ok: true, data: blob as T };
}

/** A failing response's problem: its problem document, every member kept, or an "about:blank"
 * problem titled with the status text when it carries none. */
async function problem(response: Response): Promise<Problem> {
  const fallback = `HTTP ${response.status}`;
  if (mediaType(response) === "application/problem+json") {
    let document: unknown;
    try {
      document = JSON.parse(await response.text());
    } catch {
      // Not a document after all: the about:blank problem below.
    }
    if (typeof document === "object" && document !== null && !Array.isArray(document)) {
      const members = document as Record<string, unknown>;
      return {
        ...members,
        type: typeof members.type === "string" ? members.type : "about:blank",
        status: typeof members.status === "number" ? members.status : response.status,
        title: typeof members.title === "string" && members.title ? members.title : fallback,
      };
    }
  } else {
    await response.body?.cancel();
  }
  return { type: "about:blank", status: response.status, title: response.statusText || fallback };
}

/** The problem for an error the call threw: a body that isn't encodable, the signal's abort, its
 * timeout, or the network. */
function failure(error: unknown, signal: AbortSignal | undefined): Problem {
  if (error instanceof Unencodable) {
    // Thrown before any send, so it is the cause even under a signal that has since aborted.
    const problem: Problem = {
      type: "urn:standards-lab:problem:encode",
      status: 0,
      title: "Request not encodable",
    };
    if (error.message) problem.detail = error.message;
    return problem;
  }
  if (signal?.aborted) {
    // AbortSignal.timeout aborts with a DOMException named TimeoutError; any other reason is the
    // caller's abort.
    const reason: unknown = signal.reason;
    if (
      typeof reason === "object" &&
      reason !== null &&
      "name" in reason &&
      reason.name === "TimeoutError"
    ) {
      return { type: "urn:standards-lab:problem:timeout", status: 0, title: "Request timed out" };
    }
    return { type: "urn:standards-lab:problem:abort", status: 0, title: "Request aborted" };
  }
  return {
    type: "urn:standards-lab:problem:network",
    status: 0,
    title: "Network error",
    detail: error instanceof Error ? error.message : String(error),
  };
}
