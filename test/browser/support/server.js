// The browser tier's static server: the repository root over plain http on the loopback address,
// every file sent as it is on disk, and the shell page for every path with no extension, as an
// app's server sends its shell for each of the app's deep links; and, under /upload/, the routes
// the upload's cases send to. The pages load the package's built dist/, so nothing needs
// transforming.
// Adapted from spike-html-apps-foundation (679e550): test/browser/support/server.js, given the
// shell page and the upload's routes.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

/** The repository root, which the server serves. */
export const root = join(import.meta.dirname, "../../..");

/** The page the server sends for a path with no extension, under any method. */
export const shell = "/test/fixtures/router.html";

/** The content type of each extension served; any other file is a 404. */
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/** Writes `body` (an object as JSON, a string as it is) with `status` and, when given, `type`. */
function send(response, status, type, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  response.writeHead(status, type ? { "content-type": type } : {}).end(text);
}

/** The request's body, read whole, a pause of 5 ms after each chunk, so a body of a few MB arrives
 * over long enough for the browser to report its upload's progress several times. */
async function slowly(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Buffer.concat(chunks);
}

/** The upload routes, by the path under /upload/: each reads the body whole before it answers, but
 * drop, which destroys the socket after the body's first chunk, and hang, which never answers. */
async function upload(route, request, response) {
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

/** Serves the root on a free loopback port, resolving to its origin, the requests it has answered
 * (as "METHOD pathname"), and a stop(). */
export async function serve() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname.startsWith("/upload/")) {
      // A body the client stops sending (an abort, say) fails its read, and the response with it.
      return upload(pathname.slice(8), request, response).catch(() => response.destroy());
    }
    const file = extname(pathname) === "" ? shell : pathname;
    // normalize() of an absolute path never climbs above its root, so no request leaves the tree.
    const path = join(root, normalize(decodeURIComponent(file)));
    const type = types[extname(path)];
    const body = type && (await readFile(path).catch(() => undefined));
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    requests,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}
