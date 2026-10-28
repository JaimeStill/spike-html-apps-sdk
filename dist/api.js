// The application SDK's API client, on fetch and AbortSignal, and on XMLHttpRequest for an upload,
// whose progress fetch doesn't report: the problem, the result, the page, the server-sent event,
// the client's options and shape, and createClient. Every call resolves to a Result and never
// rejects; a stream's events, read after it resolves, are the one place an error is thrown.
// Adapted from spike-html-packages-sdk (9d10ca6): src/api.d.ts, its declarations made a module.
// test/fixtures/v0.1.0/api.d.ts is that file, which the emitted declaration matches but for the
// differences test/unit/declarations.test.js expects.
import { anonymous } from "./auth.js";
import { EventStreamParser } from "./eventstream.js";
/** The error a stream's events throw when the network fails after the stream resolved, its
 * `problem` the network problem a call would have resolved to. It is the one error the client
 * throws; the caller's signal ends the events quietly instead. */
export class StreamError extends Error {
    problem;
    constructor(problem) {
        super(problem.detail === undefined ? problem.title : `${problem.title}: ${problem.detail}`);
        this.name = "StreamError";
        this.problem = problem;
    }
}
/** Makes a client. */
export function createClient(options = {}) {
    const base = options.base ?? "/api";
    const auth = options.auth ?? anonymous;
    // The refresh pending, which every 401 that arrives meanwhile awaits instead of starting its own.
    let refreshing;
    function refresh() {
        refreshing ??= settle(auth.refresh()).finally(() => {
            refreshing = undefined;
        });
        return refreshing;
    }
    /** The response that `send` gives, sending the request with its headers, which carry the
     * provider's token, and once more with the refreshed token after a 401; it rejects as `send`
     * does. Every request, a call's, a stream's, and an upload's, is sent through it. `accept`, when
     * given, is the Accept header, over any of the caller's. */
    async function respond(path, body, request, send, accept) {
        const url = join(base, path, request.query);
        const headers = new Headers(request.headers);
        if (accept !== undefined)
            headers.set("Accept", accept);
        const payload = encode(body, headers);
        const authorized = (token) => {
            if (token === undefined)
                headers.delete("Authorization");
            else
                headers.set("Authorization", `Bearer ${token}`);
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
    function fetched(method, path, body, request, accept) {
        const send = (url, headers, payload) => fetch(url, { method, headers, body: payload, signal: request.signal });
        return respond(path, body, request, send, accept);
    }
    async function call(method, path, body, request = {}) {
        try {
            return await decode(await fetched(method, path, body, request));
        }
        catch (error) {
            return { ok: false, problem: failure(error, request.signal) };
        }
    }
    async function stream(path, body, request = {}) {
        const method = body === undefined ? "GET" : "POST";
        try {
            const response = await fetched(method, path, body, request, "text/event-stream");
            if (!response.ok)
                return { ok: false, problem: await problem(response) };
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
        }
        catch (error) {
            return { ok: false, problem: failure(error, request.signal) };
        }
    }
    async function upload(path, body, request = {}) {
        try {
            if (typeof XMLHttpRequest === "undefined") {
                throw new TypeError("XMLHttpRequest is not available here; upload needs a browser");
            }
            const method = request.method ?? "POST";
            const send = (url, headers, payload) => transmit(method, url, headers, payload, request);
            return await decode(await respond(path, body, request, send));
        }
        catch (error) {
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
function transmit(method, url, headers, payload, request) {
    const { signal, progress } = request;
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(signal.reason);
        const xhr = new XMLHttpRequest();
        xhr.open(method, url);
        xhr.responseType = "blob";
        headers.forEach((value, name) => xhr.setRequestHeader(name, value));
        if (progress !== undefined) {
            // loadstart reports 0 as each send starts, a retry's too, and load the total once the whole
            // body is sent. A listener on xhr.upload makes a cross-origin upload preflighted.
            const report = (event) => progress(event.loaded, event.total);
            for (const type of ["loadstart", "progress", "load"]) {
                xhr.upload.addEventListener(type, report);
            }
        }
        const abort = () => xhr.abort();
        signal?.addEventListener("abort", abort, { once: true });
        xhr.addEventListener("loadend", () => signal?.removeEventListener("abort", abort));
        xhr.addEventListener("load", () => {
            try {
                resolve(response(xhr));
            }
            catch (error) {
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
function response(xhr) {
    const headers = new Headers();
    for (const line of xhr.getAllResponseHeaders().trim().split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon > 0)
            headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    const empty = [204, 205, 304].includes(xhr.status);
    return new Response(empty ? null : xhr.response, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers,
    });
}
/** The events of a text/event-stream body, parsed as its chunks arrive. A read that fails ends
 * the events quietly when `signal` aborted it, and throws a StreamError with the network problem
 * otherwise. However the loop ends, a break or a throw in it included, the body is cancelled. */
async function* events(body, signal) {
    const reader = body.getReader();
    const parser = new EventStreamParser();
    try {
        for (;;) {
            let chunk;
            try {
                chunk = await reader.read();
            }
            catch (error) {
                if (signal?.aborted)
                    return;
                throw new StreamError(failure(error, undefined));
            }
            if (chunk.done)
                break;
            yield* parser.push(chunk.value);
        }
        yield* parser.end();
    }
    finally {
        // A body read to its end, or one that failed, has nothing left to cancel, and its cancel
        // settles at once; a cancel that rejects has no caller to tell.
        await reader.cancel().catch(() => { });
    }
}
/** A provider's token, or undefined when the provider rejects, which the client treats as having
 * none rather than rejecting itself. */
async function settle(token) {
    try {
        return await token;
    }
    catch {
        return undefined;
    }
}
/** `path` joined under `base` with one "/", by text, since URL resolution drops the base's path
 * for a path that begins with "/", and the query's parameters appended. */
function join(base, path, query) {
    let url = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query ?? {})) {
        if (value === undefined)
            continue;
        for (const each of Array.isArray(value) ? value : [value])
            params.append(name, String(each));
    }
    if (params.size > 0)
        url += `${url.includes("?") ? "&" : "?"}${params}`;
    return url;
}
/** The error `encode` throws for a body JSON.stringify can't encode, which `failure` makes the encode
 * problem; its message is the stringify error's, or empty when stringify gave nothing. */
class Unencodable extends Error {
}
/** The request body for `body`: none for undefined, the kinds fetch and XMLHttpRequest send as they
 * are, and JSON, with its Content-Type set on `headers`, for any other. A body JSON.stringify throws
 * on, or gives nothing for, throws Unencodable before anything is sent. */
function encode(body, headers) {
    if (body === undefined)
        return undefined;
    if (body instanceof FormData ||
        body instanceof Blob ||
        body instanceof ArrayBuffer ||
        ArrayBuffer.isView(body) ||
        body instanceof URLSearchParams) {
        return body;
    }
    let json;
    try {
        json = JSON.stringify(body);
    }
    catch (error) {
        throw new Unencodable(error instanceof Error ? error.message : String(error));
    }
    // JSON.stringify's type claims a string, but it gives undefined for a function or a symbol.
    if (json === undefined)
        throw new Unencodable();
    headers.set("Content-Type", "application/json");
    return json;
}
/** The response's media type, lowercased, without its parameters; "" when it has none. */
function mediaType(response) {
    return (response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
}
function isJSON(type) {
    return type === "application/json" || type.endsWith("+json");
}
/** A response's Result: its body decoded by content type when it succeeded, its problem when it
 * didn't. */
async function decode(response) {
    if (!response.ok)
        return { ok: false, problem: await problem(response) };
    const type = mediaType(response);
    const blob = await response.blob();
    if (response.status === 204 || response.status === 205 || blob.size === 0) {
        return { ok: true, data: undefined };
    }
    if (isJSON(type)) {
        const text = await blob.text();
        try {
            return { ok: true, data: JSON.parse(text) };
        }
        catch (error) {
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
    if (type.startsWith("text/"))
        return { ok: true, data: (await blob.text()) };
    return { ok: true, data: blob };
}
/** A failing response's problem: its problem document, every member kept, or an "about:blank"
 * problem titled with the status text when it carries none. */
async function problem(response) {
    const fallback = `HTTP ${response.status}`;
    if (mediaType(response) === "application/problem+json") {
        let document;
        try {
            document = JSON.parse(await response.text());
        }
        catch {
            // Not a document after all: the about:blank problem below.
        }
        if (typeof document === "object" && document !== null && !Array.isArray(document)) {
            const members = document;
            return {
                ...members,
                type: typeof members.type === "string" ? members.type : "about:blank",
                status: typeof members.status === "number" ? members.status : response.status,
                title: typeof members.title === "string" && members.title ? members.title : fallback,
            };
        }
    }
    else {
        await response.body?.cancel();
    }
    return { type: "about:blank", status: response.status, title: response.statusText || fallback };
}
/** The problem for an error the call threw: a body that isn't encodable, the signal's abort, its
 * timeout, or the network. */
function failure(error, signal) {
    if (error instanceof Unencodable) {
        // Thrown before any send, so it is the cause even under a signal that has since aborted.
        const problem = {
            type: "urn:standards-lab:problem:encode",
            status: 0,
            title: "Request not encodable",
        };
        if (error.message)
            problem.detail = error.message;
        return problem;
    }
    if (signal?.aborted) {
        // AbortSignal.timeout aborts with a DOMException named TimeoutError; any other reason is the
        // caller's abort.
        const reason = signal.reason;
        if (typeof reason === "object" &&
            reason !== null &&
            "name" in reason &&
            reason.name === "TimeoutError") {
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
