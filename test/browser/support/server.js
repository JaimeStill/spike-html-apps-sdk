// The browser tier's static server: the repository root over plain http on the loopback address,
// every file sent as it is on disk, and the shell page for every path with no extension, as an
// app's server sends its shell for each of the app's deep links. The pages load the package's
// built dist/, so nothing needs transforming.
// Adapted from spike-html-apps-foundation (679e550): test/browser/support/server.js, given the
// shell page.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

/** The repository root, which the server serves. */
export const root = join(import.meta.dirname, "../../..");

/** The page the server sends for a path with no extension, under any method. */
export const shell = "/test/fixtures/router.html";

/** The content type of each extension served; any other file is a 404. */
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

/** Serves the root on a free loopback port, resolving to its origin, the requests it has answered
 * (as "METHOD pathname"), and a stop(). */
export async function serve() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    requests.push(`${request.method} ${pathname}`);
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
