// The application SDK's API client's types: the problem, the result, the page, and the client's
// options and shape. Its runtime, on fetch and AbortSignal, comes in a later slice; until then the
// module carries types alone. Every call resolves to a Result and never rejects.
// Adapted from spike-html-packages-sdk (9d10ca6): src/api.d.ts, its declarations made a module.
// test/fixtures/v0.1.0/api.d.ts is that file, which the emitted declaration matches but for the
// differences test/unit/declarations.test.js expects.

import type { TokenProvider } from "./auth.ts";

/** An RFC 9457 problem document, as go-web-sdk's Problem writes it, with `title` always present:
 * go-web-sdk's Write defaults it to the status phrase, but omits it for a status outside net/http's
 * table, where the client fills it. `detail` and `instance` are omitted when empty, and
 * `request_id` is present when the server's request carried a correlation id. */
export interface Problem {
  /** A URI naming the problem's kind: "about:blank" for a status with no further meaning, or one
   * of the ClientProblemType URIs for a problem the client made itself. */
  type: string;
  /** The HTTP status; 0 for a problem the client made itself (no response arrived). */
  status: number;
  title: string;
  detail?: string;
  instance?: string;
  request_id?: string;
}

/** The type of a problem the client makes itself, with no response behind it: the network failed
 * (fetch rejected with a TypeError), the caller's signal aborted the call, or the signal's timeout
 * (AbortSignal.timeout) fired. A response that isn't a problem document becomes an "about:blank"
 * problem with the response's status and status text. */
export type ClientProblemType =
  | "urn:standards-lab:problem:network"
  | "urn:standards-lab:problem:abort"
  | "urn:standards-lab:problem:timeout";

/** A call's outcome: the decoded body, or the problem that stopped it. */
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

/** A call's options: the signal that aborts it. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/** How a client is made: the base URL every path is resolved under ("/api" by default), and the
 * token provider whose token each call carries (anonymous by default). */
export interface ClientOptions {
  base?: string;
  auth?: TokenProvider;
}

/** The API client. Each method sends the path under the base URL with
 * `Authorization: Bearer <token>` when the provider has a token, and on a 401 asks the provider to
 * refresh and retries once with the refreshed token, if there is one. A body is sent as JSON. */
export interface Client {
  get<T>(path: string, options?: RequestOptions): Promise<Result<T>>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<Result<T>>;
  delete<T>(path: string, options?: RequestOptions): Promise<Result<T>>;
}
