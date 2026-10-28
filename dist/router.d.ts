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
    query(changes: Readonly<Record<string, string | undefined>>, options?: NavigateOptions): Promise<void>;
}
/** Makes a router over `routes`. */
export declare function createRouter(routes: Routes, options: RouterOptions): Router;
