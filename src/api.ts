// The application SDK's API client, on fetch and AbortSignal: the problem, the result, the page,
// the client's options and shape, and createClient. Every call resolves to a Result and never
// rejects.
// Adapted from spike-html-packages-sdk (9d10ca6): src/api.d.ts, its declarations made a module.
// test/fixtures/v0.1.0/api.d.ts is that file, which the emitted declaration matches but for the
// differences test/unit/declarations.test.js expects.

import type { TokenProvider } from "./auth.ts";
import { anonymous } from "./auth.ts";

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
 * it, status 0: the network failed (fetch rejected; "Network error"), the caller's signal aborted
 * the call ("Request aborted"), or the signal's timeout (AbortSignal.timeout) fired ("Request timed
 * out"). With the response's status: a 2xx body didn't decode as its content type claims
 * ("Response not decodable"). A failing response that isn't a problem document becomes an
 * "about:blank" problem titled with the response's status text, or "HTTP <status>" when it has
 * none, as does a problem document with no title. */
export type ClientProblemType =
  | "urn:standards-lab:problem:network"
  | "urn:standards-lab:problem:abort"
  | "urn:standards-lab:problem:timeout"
  | "urn:standards-lab:problem:decode";

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
 * header of that name here, and Content-Type when it sends the body as JSON. */
export interface RequestOptions {
  signal?: AbortSignal;
  query?: Readonly<
    Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>
  >;
  headers?: Readonly<Record<string, string>>;
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
 * other body is sent as JSON. */
export interface Client {
  get<T>(path: string, options?: RequestOptions): Promise<Result<T>>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  delete<T>(path: string, options?: RequestOptions): Promise<Result<T>>;
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

  async function call<T>(
    method: string,
    path: string,
    body: unknown,
    request: RequestOptions = {},
  ): Promise<Result<T>> {
    const { signal } = request;
    try {
      const url = join(base, path, request.query);
      const headers = new Headers(request.headers);
      const payload = encode(body, headers);
      const send = (token: string | undefined) => {
        if (token === undefined) headers.delete("Authorization");
        else headers.set("Authorization", `Bearer ${token}`);
        return fetch(url, { method, headers, body: payload, signal });
      };
      let response = await send(await settle(auth.token()));
      if (response.status === 401) {
        const token = await refresh();
        if (token !== undefined) {
          await response.body?.cancel();
          response = await send(token);
        }
      }
      return await decode<T>(response);
    } catch (error) {
      return { ok: false, problem: failure(error, signal) };
    }
  }

  return {
    get: (path, options) => call("GET", path, undefined, options),
    post: (path, body, options) => call("POST", path, body, options),
    put: (path, body, options) => call("PUT", path, body, options),
    patch: (path, body, options) => call("PATCH", path, body, options),
    delete: (path, options) => call("DELETE", path, undefined, options),
  };
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

/** The request body for `body`: none for undefined, the kinds fetch sends as they are, and JSON,
 * with its Content-Type set on `headers`, for any other. */
function encode(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams
  ) {
    return body as BodyInit;
  }
  headers.set("Content-Type", "application/json");
  return JSON.stringify(body);
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

/** The problem for an error the call threw: the signal's abort, its timeout, or the network. */
function failure(error: unknown, signal: AbortSignal | undefined): Problem {
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
