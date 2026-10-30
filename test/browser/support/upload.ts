// The browser tier's own routes, the handler it passes to the tooling's serve: under /upload/, the
// routes the upload's cases send to, and, over every request, a log of what the server was asked.
// The rest, the repository's files and the shell page, the tooling's server sends.
// Adapted from spike-html-apps-sdk (ca3089e): test/browser/support/server.js, its upload routes
// and request log made a handler for @jaimestill/spike-html-apps-tooling/server.js, in TypeScript.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { Handler } from "@jaimestill/spike-html-apps-tooling/server.js";

/** Writes `body` (an object as JSON, a string as it is) with `status` and, when given, `type`. */
function send(
  response: ServerResponse,
  status: number,
  type: string | undefined,
  body: object | string,
) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, type ? { "content-type": type } : {}).end(text);
}

/** The request's body, read whole, a pause of 5 ms after each chunk, so a body of a few MB arrives
 * over long enough for the browser to report its upload's progress several times. */
async function slowly(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Buffer.concat(chunks);
}

/** The upload routes, by the path under /upload/: each reads the body whole before it answers, but
 * drop, which destroys the socket after the body's first chunk, and hang, which never answers. */
async function upload(route: string, request: IncomingMessage, response: ServerResponse) {
  if (route === "drop") {
    request.once("data", () => request.socket.destroy());
    return;
  }
  if (route === "hang") {
    request.resume();
    return;
  }
  const body = await slowly(request);
  const { method, headers } = request;
  switch (route) {
    case "echo":
      return send(response, 200, "application/json", {
        method,
        type: headers["content-type"],
        authorization: headers.authorization ?? null,
        size: body.length,
        // A small body, as text, so a FormData's parts can be read.
        text: body.length <= 4096 ? body.toString("latin1") : null,
      });
    case "text":
      return send(response, 200, "text/plain; charset=utf-8", `received ${body.length}`);
    case "bytes":
      return send(response, 200, "application/octet-stream", "abc");
    case "empty":
      return send(response, 204, undefined, "");
    case "malformed":
      return send(response, 200, "application/json", "{");
    case "problem":
      return send(response, 413, "application/problem+json", {
        type: "urn:lab:too-large",
        status: 413,
        title: "Upload too large",
        detail: `${body.length} bytes`,
      });
    case "failure":
      return send(response, 503, "text/plain", "down");
    case "auth":
      if (headers.authorization === "Bearer fresh") {
        return send(response, 200, "application/json", { authorized: true, size: body.length });
      }
      return send(response, 401, "application/problem+json", {
        type: "about:blank",
        status: 401,
        title: "Unauthorized",
      });
    default:
      return send(response, 404, "text/plain", "no route");
  }
}

/**
 * A handler for serve, and the log it keeps: `requests` holds every request the server is asked,
 * as "METHOD pathname", in order. The handler claims each request under /upload/, resolving to
 * true once its route has answered (or, for drop and hang, has left it unanswered), and returns
 * false for any other, leaving its body and response to the server.
 */
export function routes() {
  const requests: string[] = [];
  const handler: Handler = (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    requests.push(`${request.method} ${pathname}`);
    if (!pathname.startsWith("/upload/")) return false;
    // A body the client stops sending (an abort, say) rejects its read, and serve destroys the
    // response.
    return upload(pathname.slice("/upload/".length), request, response).then(() => true);
  };
  return { handler, requests };
}
