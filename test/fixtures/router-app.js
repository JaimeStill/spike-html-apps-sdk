// The router fixture's app: its elements, its route table, and the hooks the browser tier calls.
// setup() makes the router over the table, with the base and the notFound and error elements a test
// asks for, and links under the prefix; snapshot() reads the URL, the outlet, and current.

import { createRouter } from "@jaimestill/spike-html-apps-sdk/router.js";

for (const tag of ["x-home", "x-about", "x-user", "x-not-found", "x-error"]) {
  customElements.define(tag, class extends HTMLElement {});
}

/** How many times the lazy route's loader has run. */
window.loads = 0;

/** The route table: defined tags, a loader that defines its tag, a loader that rejects, and a loader
 * whose tag nothing defines. users/me comes after users/:user, so it never wins. */
const routes = {
  "": "x-home",
  about: "x-about",
  "users/:user": "x-user",
  "users/me": "x-about",
  lazy: () => {
    window.loads += 1;
    return import("/test/fixtures/router-lazy.js").then((module) => module.tag);
  },
  broken: () => Promise.reject(new Error("the broken route's loader failed")),
  ghost: async () => "x-ghost",
};

/** The links setup() writes, by id, each relative to the prefix, but for the ones that leave it. */
const links = {
  home: "",
  about: "about",
  user: "users/42",
  me: "users/me",
  lazy: "lazy",
  broken: "broken",
  ghost: "ghost",
  nowhere: "nowhere",
};

const outlet = document.getElementById("outlet");

/** Makes the router, as `window.router`, without starting it. `base` is the base option,
 * `baseElement` a <base> element's href, and `prefix` the path the links are under. */
window.setup = ({ base, baseElement, prefix = "/", notFound = false, error = false } = {}) => {
  if (baseElement !== undefined) {
    const element = document.createElement("base");
    element.href = baseElement;
    document.head.prepend(element);
  }
  const nav = document.getElementById("links");
  nav.replaceChildren(
    ...Object.entries(links).map(([id, path]) => {
      const link = document.createElement("a");
      link.id = id;
      link.href = prefix + path;
      link.textContent = id;
      return link;
    }),
  );
  const extra = [
    ["outside", "/outside/page"],
    ["fragment", "#section"],
    ["download", `${prefix}file`],
  ];
  for (const [id, href] of extra) {
    const link = document.createElement("a");
    link.id = id;
    link.href = href;
    link.textContent = id;
    if (id === "download") link.download = "file.txt";
    nav.append(link);
  }
  document.getElementById("post").action = `${prefix}posted`;

  window.router = createRouter(routes, {
    outlet,
    base,
    notFound: notFound ? "x-not-found" : undefined,
    error: error ? "x-error" : undefined,
  });
  window.changes = [];
  window.router.addEventListener("change", () => window.changes.push(window.snapshot()));
  window.navigateErrors = [];
  navigation.addEventListener("navigateerror", (event) =>
    window.navigateErrors.push(event.error.message),
  );
  // Every navigate event, by its type, so a test can wait for one the router leaves alone.
  window.navigates = [];
  navigation.addEventListener("navigate", (event) => window.navigates.push(event.navigationType));
};

/** The URL's path, query, and fragment, the outlet's markup, and current, its query as a string,
 * or "undefined" when it is, which JSON would drop. */
window.snapshot = () => {
  const { current: match } = window.router;
  const current = match === undefined ? "undefined" : { ...match, query: match.query.toString() };
  return {
    url: location.pathname + location.search + location.hash,
    outlet: outlet.innerHTML,
    current,
  };
};

/** Resolves to the snapshot at the router's next change. */
window.nextChange = () =>
  new Promise((resolve) => {
    window.router.addEventListener("change", () => resolve(window.snapshot()), { once: true });
  });

/** The promise's outcome as JSON: "resolved", or the rejection's message. */
window.settle = (promise) =>
  promise.then(
    () => "resolved",
    (error) => `rejected: ${error.message}`,
  );
