// The application SDK's router, on URLPattern and the Navigation API with no hand-written matcher:
// it matches each navigation under its base against the route table and mounts the route's
// element in its outlet.
// Adapted from spike-html-packages-sdk (9d10ca6): src/router.d.ts, its declarations made a module
// and given a runtime.
// test/fixtures/v0.1.0/router.d.ts is that file, which the emitted declaration matches but for the
// differences test/unit/declarations.test.js expects.
/** Makes a router over `routes`. */
export function createRouter(routes, options) {
    return new AppRouter(routes, options);
}
/** The info a navigate() navigation carries, so its navigate event mounts what navigate() loaded
 * rather than loading it again. */
const preloaded = Symbol("preloaded");
/** The base's path, ending in "/": the option, else the <base> element's href, else "/". */
function baseOf(option) {
    const element = document.querySelector("base");
    const path = option ?? (element?.hasAttribute("href") ? new URL(element.href).pathname : undefined) ?? "/";
    return path.endsWith("/") ? path : `${path}/`;
}
/** The text escaped so URLPattern reads each of its characters as itself. */
const literal = (text) => text.replace(/[\\:*?+(){}]/g, "\\$&");
/** The tag, defined, that a route's entry names or its loader resolves to; rejects when the loader
 * does, or when the tag isn't a defined custom element. */
async function defined(entry) {
    const tag = typeof entry === "string" ? entry : await entry();
    if (!customElements.get(tag))
        throw new Error(`<${tag}> is not a defined custom element`);
    return tag;
}
class AppRouter extends EventTarget {
    #outlet;
    #base;
    #notFound;
    #error;
    #table;
    #current;
    // The pathname whose route or notFound element is mounted: a navigation that keeps it changes
    // only the query. Undefined before the first mount and after a failed one, so either mounts.
    #mountedPath;
    #started = false;
    // Each mount takes the next turn and commits only while it is the latest, so a slow loader never
    // overwrites a later navigation's element.
    #turn = 0;
    constructor(routes, options) {
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
    get current() {
        return this.#current;
    }
    async start() {
        if (this.#started)
            return;
        this.#started = true;
        navigation.addEventListener("navigate", this.#onNavigate);
        const turn = ++this.#turn;
        try {
            const mount = await this.#prepare(new URL(location.href));
            if (turn === this.#turn)
                this.#commit(mount, location.pathname);
        }
        catch (error) {
            if (turn === this.#turn)
                await this.#fail(turn);
            throw error;
        }
    }
    stop() {
        this.#started = false;
        navigation.removeEventListener("navigate", this.#onNavigate);
    }
    async navigate(path, options = {}) {
        // Unstarted, nothing would intercept the navigation, and the browser would load the page.
        if (!this.#started)
            throw new Error("the router isn't started: call start() first");
        const url = new URL(path.replace(/^\/+/, ""), new URL(this.#base, location.origin));
        // A destination at the mounted pathname changes only the query, which loads nothing.
        const info = url.pathname === this.#mountedPath ? undefined : { [preloaded]: await this.#prepare(url) };
        const history = options.replace ? "replace" : "push";
        await navigation.navigate(url.href, { history, info }).finished;
    }
    async query(changes, options = {}) {
        if (!this.#started)
            throw new Error("the router isn't started: call start() first");
        const url = new URL(location.href);
        for (const [name, value] of Object.entries(changes)) {
            if (value === undefined)
                url.searchParams.delete(name);
            else
                url.searchParams.set(name, value);
        }
        const history = options.replace === false ? "push" : "replace";
        await navigation.navigate(url.href, { history }).finished;
    }
    /** Intercepts the navigation when it is the router's: same-origin, under the base, and neither a
     * download, a fragment-only change, a form post, nor a reload. */
    #onNavigate = (event) => {
        const url = new URL(event.destination.url);
        if (!event.canIntercept ||
            event.hashChange ||
            event.downloadRequest !== null ||
            event.formData !== null ||
            // A reload reloads the page, which starts its router again.
            event.navigationType === "reload" ||
            url.origin !== location.origin ||
            !url.pathname.startsWith(this.#base)) {
            return;
        }
        const turn = ++this.#turn;
        if (url.pathname === this.#mountedPath) {
            // Only the query changes: the element stays, and so do focus and scroll.
            event.intercept({
                focusReset: "manual",
                scroll: "manual",
                handler: async () => {
                    if (turn !== this.#turn)
                        return;
                    if (this.#current)
                        this.#current = { ...this.#current, query: url.searchParams };
                    this.dispatchEvent(new Event("change"));
                },
            });
            return;
        }
        const info = event.info;
        event.intercept({
            handler: async () => {
                try {
                    const mount = info?.[preloaded] ?? (await this.#prepare(url));
                    if (turn === this.#turn)
                        this.#commit(mount, url.pathname);
                }
                catch (error) {
                    // The URL is already committed: the error element stands in for the route, and the
                    // rejection fails the navigation (navigateerror).
                    if (turn === this.#turn)
                        await this.#fail(turn);
                    throw error;
                }
            },
        });
    };
    /** The route the URL matches, loaded and its element created; rejects when the route fails. */
    async #prepare(url) {
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
        const params = {};
        for (const [name, value] of Object.entries(groups)) {
            if (value !== undefined && !/^\d+$/.test(name))
                params[name] = value;
        }
        const tag = await defined(route.entry);
        const element = document.createElement(tag);
        for (const [name, value] of Object.entries(params))
            element.setAttribute(name, value);
        return { match: { pattern: route.pattern, tag, params, query }, element };
    }
    /** Mounts the outcome as the location's at `path`, and dispatches change. */
    #commit({ match, element }, path) {
        this.#outlet.replaceChildren(...(element ? [element] : []));
        this.#current = match;
        this.#mountedPath = path;
        this.dispatchEvent(new Event("change"));
    }
    /** Mounts the error element, or empties the outlet when there is none or it fails too, and
     * dispatches change, current undefined; unless a later turn has begun meanwhile. */
    async #fail(turn) {
        let element = null;
        if (this.#error) {
            try {
                element = document.createElement(await defined(this.#error));
            }
            catch {
                // The error element failing too leaves the outlet empty.
            }
        }
        if (turn !== this.#turn)
            return;
        this.#outlet.replaceChildren(...(element ? [element] : []));
        this.#current = undefined;
        this.#mountedPath = undefined;
        this.dispatchEvent(new Event("change"));
    }
}
