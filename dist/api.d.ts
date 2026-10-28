import type { TokenProvider } from "./auth.ts";
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
 * signal's timeout (AbortSignal.timeout) fired ("Request timed out"). With the response's status:
 * a 2xx body didn't decode as its content type claims, or a stream's 2xx response isn't
 * text/event-stream ("Response not decodable"). A failing response that isn't a problem document
 * becomes an "about:blank" problem titled with the response's status text, or "HTTP <status>"
 * when that text is empty; a problem document with no title is titled "HTTP <status>". */
export type ClientProblemType = "urn:standards-lab:problem:network" | "urn:standards-lab:problem:abort" | "urn:standards-lab:problem:timeout" | "urn:standards-lab:problem:decode" | "urn:standards-lab:problem:encode";
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
export declare class StreamError extends Error {
    readonly problem: Problem;
    constructor(problem: Problem);
}
/** A call's outcome: the decoded body, or the problem that stopped it. A body decodes by its content
 * type: JSON (application/json or any +json type) parsed, text/* a string, any other a Blob, and no
 * body (a 204 or 205, or an empty body) undefined. */
export type Result<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    problem: Problem;
};
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
    query?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[] | undefined>>;
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
    stream(path: string, body?: unknown, options?: RequestOptions): Promise<Result<AsyncIterable<ServerSentEvent>>>;
    upload<T>(path: string, body: unknown, options?: UploadOptions): Promise<Result<T>>;
}
/** Makes a client. */
export declare function createClient(options?: ClientOptions): Client;
