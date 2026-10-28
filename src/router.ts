// The application SDK's router, on URLPattern and the Navigation API with no hand-written matcher:
// it matches each navigation under its base against the route table and mounts the route's
// element in its outlet.
// Adapted from spike-html-packages-sdk (9d10ca6): src/router.d.ts, its declarations made a module
// and given a runtime.
// test/fixtures/v0.1.0/router.d.ts is that file, which the emitted declaration matches but for the
// differences test/unit/declarations.test.js expects.

/** Imports the module that defines a route's element and resolves to the element's tag, so the
 * element's code loads on the route's first visit. */
export type Loader = () => Promise<string>;

/** An app's route table: a URLPattern pathname pattern, relative to the router's base, to the tag
 * of the element it mounts, defined already, or the loader that defines it. The first pattern
 * that matches wins, in the table's order. */
export type Routes = Readonly<Record<string, string | Loader>>;

/** The route the location matches: its pattern and tag, the pattern's named groups (the path
 * params), and the location's query. */
export interface Match {
  pattern: string;
  tag: string;
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
}

/** How a router is made: the element it mounts each route's element into; the base path the app
 * is served under, which every pattern and navigate() path is relative to: this option, else the
 * pathname of the href of the document's <base> element, else "/"; the element mounted when
 * nothing matches; and the element mounted when a route fails. */
export interface RouterOptions {
  outlet: Element;
  base?: string;
  notFound?: string | Loader;
  error?: string | Loader;
}

/** How a navigation enters the history: a new entry by default, or in place of the current one. */
export interface NavigateOptions {
  replace?: boolean;
}

/** An app's router. Once started, it intercepts every same-origin navigation under its base (a
 * plain link's click, back and forward, and navigate() included; a download, a fragment-only
 * change, a form post, and a reload are left to the browser) through the Navigation API's navigate
 * event, matches the destination with URLPattern, and replaces the outlet's content with the
 * route's element, each path param set on it as an attribute of the same name. A route fails when
 * its loader rejects or its tag isn't a defined custom element; on a navigation the router didn't
 * start itself, whose URL is already committed, the outlet then holds the error element (or
 * nothing) and the navigation fails (navigateerror). It dispatches "change" after each mount and
 * each query change, with `current` already updated. */
export interface Router extends EventTarget {
  /** The route the current location matches, or undefined when none does or its route failed. */
  readonly current: Match | undefined;
  /** Mounts the current location's route and begins intercepting navigations; resolves once the
   * route is mounted, and rejects, with the error element mounted, when the route fails. */
  start(): Promise<void>;
  /** Stops intercepting navigations. */
  stop(): void;
  /** Loads the route at `path`, relative to the base, then navigates to it, and resolves once its
   * element is mounted. When the route fails it rejects before navigating, leaving the URL, the
   * outlet, and `current` unchanged. */
  navigate(path: string, options?: NavigateOptions): Promise<void>;
  /** Sets the query's parameters in `changes` (undefined deletes one) and keeps the rest,
   * replacing the history entry by default; the route's element stays mounted. Resolves once
   * `current.query` is updated. */
  query(
    changes: Readonly<Record<string, string | undefined>>,
    options?: NavigateOptions,
  ): Promise<void>;
}

/** Makes a router over `routes`. */
export function createRouter(routes: Routes, options: RouterOptions): Router {
  return new AppRouter(routes, options);
}

/** A navigation's outcome, ready to mount: the route's match and its element, created with its
 * params set; or, for a path nothing matches, the notFound element, or null for an empty outlet. */
interface Mount {
  match: Match | undefined;
  element: Element | null;
}

/** The info a navigate() navigation carries, so its navigate event mounts what navigate() loaded
 * rather than loading it again. */
const preloaded = Symbol("preloaded");
interface Preloaded {
  [preloaded]: Mount;
}

/** The base's path, ending in "/": the option, else the <base> element's href, else "/". */
function baseOf(option: string | undefined): string {
  const element = document.querySelector("base");
  const path =
    option ?? (element?.hasAttribute("href") ? new URL(element.href).pathname : undefined) ?? "/";
  return path.endsWith("/") ? path : `${path}/`;
}

/** The text escaped so URLPattern reads each of its characters as itself. */
const literal = (text: string) => text.replace(/[\\:*?+(){}]/g, "\\$&");

/** The tag, defined, that a route's entry names or its loader resolves to; rejects when the loader
 * does, or when the tag isn't a defined custom element. */
async function defined(entry: string | Loader): Promise<string> {
  const tag = typeof entry === "string" ? entry : await entry();
  if (!customElements.get(tag)) throw new Error(`<${tag}> is not a defined custom element`);
  return tag;
}

class AppRouter extends EventTarget implements Router {
  readonly #outlet: Element;
  readonly #base: string;
  readonly #notFound: string | Loader | undefined;
  readonly #error: string | Loader | undefined;
  readonly #table: { pattern: string; entry: string | Loader; matcher: URLPattern }[];
  #current: Match | undefined;
  // The pathname whose route or notFound element is mounted: a navigation that keeps it changes
  // only the query. Undefined before the first mount and after a failed one, so either mounts.
  #mountedPath: string | undefined;
  #started = false;
  // Each mount takes the next turn and commits only while it is the latest, so a slow loader never
  // overwrites a later navigation's element.
  #turn = 0;

  constructor(routes: Routes, options: RouterOptions) {
    super();
    this.#outlet = options.outlet;
    this.#base = baseOf(options.base);
    this.#notFound = options.notFound;
    this.#error = options.error;
    this.#table = Object.entries(routes).map(([pattern, entry]) => ({
      pattern,
      entry,
      matcher: new URLPattern({ pathname: literal(this.#base) + pattern.replace(/^\/+/, "") }),
    }));
  }

  get current(): Match | undefined {
    return this.#current;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    navigation.addEventListener("navigate", this.#onNavigate);
    const turn = ++this.#turn;
    try {
      const mount = await this.#prepare(new URL(location.href));
      if (turn === this.#turn) this.#commit(mount, location.pathname);
    } catch (error) {
      if (turn === this.#turn) await this.#fail(turn);
      throw error;
    }
  }

  stop(): void {
    this.#started = false;
    navigation.removeEventListener("navigate", this.#onNavigate);
  }

  async navigate(path: string, options: NavigateOptions = {}): Promise<void> {
    // Unstarted, nothing would intercept the navigation, and the browser would load the page.
    if (!this.#started) throw new Error("the router isn't started: call start() first");
    const url = new URL(path.replace(/^\/+/, ""), new URL(this.#base, location.origin));
    // A destination at the mounted pathname changes only the query, which loads nothing.
    const info: Preloaded | undefined =
      url.pathname === this.#mountedPath ? undefined : { [preloaded]: await this.#prepare(url) };
    const history = options.replace ? "replace" : "push";
    await navigation.navigate(url.href, { history, info }).finished;
  }

  async query(
    changes: Readonly<Record<string, string | undefined>>,
    options: NavigateOptions = {},
  ): Promise<void> {
    if (!this.#started) throw new Error("the router isn't started: call start() first");
    const url = new URL(location.href);
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) url.searchParams.delete(name);
      else url.searchParams.set(name, value);
    }
    const history = options.replace === false ? "push" : "replace";
    await navigation.navigate(url.href, { history }).finished;
  }

  /** Intercepts the navigation when it is the router's: same-origin, under the base, and neither a
   * download, a fragment-only change, a form post, nor a reload. */
  #onNavigate = (event: NavigateEvent) => {
    const url = new URL(event.destination.url);
    if (
      !event.canIntercept ||
      event.hashChange ||
      event.downloadRequest !== null ||
      event.formData !== null ||
      // A reload reloads the page, which starts its router again.
      event.navigationType === "reload" ||
      url.origin !== location.origin ||
      !url.pathname.startsWith(this.#base)
    ) {
      return;
    }
    const turn = ++this.#turn;
    if (url.pathname === this.#mountedPath) {
      // Only the query changes: the element stays, and so do focus and scroll.
      event.intercept({
        focusReset: "manual",
        scroll: "manual",
        handler: async () => {
          if (turn !== this.#turn) return;
          if (this.#current) this.#current = { ...this.#current, query: url.searchParams };
          this.dispatchEvent(new Event("change"));
        },
      });
      return;
    }
    const info = event.info as Partial<Preloaded> | undefined;
    event.intercept({
      handler: async () => {
        try {
          const mount = info?.[preloaded] ?? (await this.#prepare(url));
          if (turn === this.#turn) this.#commit(mount, url.pathname);
        } catch (error) {
          // The URL is already committed: the error element stands in for the route, and the
          // rejection fails the navigation (navigateerror).
          if (turn === this.#turn) await this.#fail(turn);
          throw error;
        }
      },
    });
  };

  /** The route the URL matches, loaded and its element created; rejects when the route fails. */
  async #prepare(url: URL): Promise<Mount> {
    const { pathname, searchParams: query } = url;
    const route = pathname.startsWith(this.#base)
      ? this.#table.find(({ matcher }) => matcher.test({ pathname }))
      : undefined;
    if (!route) {
      const element = this.#notFound ? document.createElement(await defined(this.#notFound)) : null;
      return { match: undefined, element };
    }
    const groups = route.matcher.exec({ pathname })?.pathname.groups ?? {};
    // The named groups alone: an unnamed group's key is its index, never an attribute's name, and
    // an optional group that didn't match is undefined.
    const params: Record<string, string> = {};
    for (const [name, value] of Object.entries(groups)) {
      if (value !== undefined && !/^\d+$/.test(name)) params[name] = value;
    }
    const tag = await defined(route.entry);
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(params)) element.setAttribute(name, value);
    return { match: { pattern: route.pattern, tag, params, query }, element };
  }

  /** Mounts the outcome as the location's at `path`, and dispatches change. */
  #commit({ match, element }: Mount, path: string) {
    this.#outlet.replaceChildren(...(element ? [element] : []));
    this.#current = match;
    this.#mountedPath = path;
    this.dispatchEvent(new Event("change"));
  }

  /** Mounts the error element, or empties the outlet when there is none or it fails too, and
   * dispatches change, current undefined; unless a later turn has begun meanwhile. */
  async #fail(turn: number) {
    let element: Element | null = null;
    if (this.#error) {
      try {
        element = document.createElement(await defined(this.#error));
      } catch {
        // The error element failing too leaves the outlet empty.
      }
    }
    if (turn !== this.#turn) return;
    this.#outlet.replaceChildren(...(element ? [element] : []));
    this.#current = undefined;
    this.#mountedPath = undefined;
    this.dispatchEvent(new Event("change"));
  }
}
