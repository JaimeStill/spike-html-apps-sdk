// The application SDK's router, declared: spike-html-apps implements it on URLPattern and the
// Navigation API, with no hand-written matcher.
// From spike-html-packages-sdk (9d10ca6): src/router.d.ts.

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

/** How a router is made: the element it mounts each route's element into, the base path the app
 * is served under ("/" by default), which every pattern and navigate() path is relative to, and
 * the element mounted when nothing matches. */
export interface RouterOptions {
  outlet: Element;
  base?: string;
  notFound?: string | Loader;
}

/** How a navigation enters the history: a new entry by default, or in place of the current one. */
export interface NavigateOptions {
  replace?: boolean;
}

/** An app's router. Once started, it intercepts every same-document navigation (a plain link's
 * click included) through the Navigation API's navigate event, matches the destination with
 * URLPattern, and replaces the outlet's content with the route's element, each path param set on
 * it as an attribute of the same name. */
export interface Router {
  /** The route the current location matches, or undefined when none does. */
  readonly current: Match | undefined;
  /** Mounts the current location's route and begins intercepting navigations. */
  start(): void;
  /** Stops intercepting navigations. */
  stop(): void;
  /** Navigates to `path`, relative to the base, and resolves once its element is mounted. */
  navigate(path: string, options?: NavigateOptions): Promise<void>;
  /** Sets the query's parameters in `changes` (undefined deletes one) and keeps the rest,
   * replacing the history entry by default; the route's element stays mounted. */
  query(changes: Readonly<Record<string, string | undefined>>, options?: NavigateOptions): void;
}

/** Makes a router over `routes`. */
export declare function createRouter(routes: Routes, options: RouterOptions): Router;
