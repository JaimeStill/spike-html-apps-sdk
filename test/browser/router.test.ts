// The router from the package's dist/, on test/fixtures/router.html, driven with real clicks and
// history traversals through the DevTools Protocol: its base, the navigations it intercepts and the
// ones it leaves to the browser, its params, query, notFound, and failing routes, and stop().

import assert from "node:assert/strict";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

import { launch, type Browser, type Page } from "@jaimestill/spike-html-apps-tooling/browser.js";
import { serve, type Server } from "@jaimestill/spike-html-apps-tooling/server.js";

import { routes } from "./support/upload.ts";

/** The server's routes, whose log holds every request the server is asked. */
const { handler, requests } = routes();
let server: Server;
let browser: Browser;
const pages: Page[] = [];

before(async () => {
  // The repository root, whose fixtures load the package's built dist/, and the router's page for
  // every path with no extension, as an app's server sends its shell for each deep link.
  server = await serve({
    root: join(import.meta.dirname, "../.."),
    shell: "/test/fixtures/router.html",
    handler,
  });
  browser = await launch();
});
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close();
});
after(async () => {
  await browser?.close();
  await server?.stop();
});

/** The fixture's setup() options: test/fixtures/router-app.js's setup() names each. */
interface Setup {
  base?: string;
  baseElement?: string;
  prefix?: string;
  notFound?: boolean;
  error?: boolean;
}

/** The fixture's snapshot(), by value: the URL's path, query, and fragment, the outlet's markup,
 * and router.current, its query as a string, or "undefined" when there is none. */
interface Snapshot {
  url: string;
  outlet: string;
  current:
    { pattern: string; tag: string; params: Record<string, string>; query: string } | "undefined";
}

/** The fixture's setup under /app/, its base from a <base> element. */
const APP: Setup = { baseElement: "/app/", prefix: "/app/" };

/** Opens the path, makes the router with the setup options, and, unless asked not to, starts it. */
async function open(path: string, options: Setup = APP, { start = true } = {}) {
  const page = await browser.open(server.origin + path);
  pages.push(page);
  // A download the router leaves to the browser goes nowhere.
  await page.cdp("Page.setDownloadBehavior", { behavior: "deny" });
  await page.evaluate(`setup(${JSON.stringify(options)})`);
  if (start) await page.evaluate("router.start()");
  return page;
}

/** The page's URL path, outlet markup, and router.current. */
const snapshot = (page: Page): Promise<Snapshot> => page.evaluate("snapshot()");

/** Clicks the element with the id as a mouse does, at its center. */
async function click(page: Page, id: string) {
  const { x, y }: { x: number; y: number } = await page.evaluate(`(() => {
    const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

/** Runs the action, resolving to the snapshot at the router's next change. */
async function changeOn(page: Page, action: () => Promise<unknown>): Promise<Snapshot> {
  await page.evaluate("window.pending = nextChange(), 0");
  await action();
  return page.evaluate("pending");
}

/** Runs the action, resolving once the page has loaded a new document, and rejecting when none
 * loads within 2 s: a navigation the router intercepted loads none. */
async function loadOn(page: Page, action: () => Promise<unknown>) {
  const loaded = new Promise((resolve) => page.on("Page.loadEventFired", resolve));
  await action();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no new document loaded")), 2000);
  });
  await Promise.race([loaded, deadline]).finally(() => clearTimeout(timer));
}

/** Runs the action, resolving once the page has fired one more navigate event, and a task after. */
async function navigateOn(page: Page, action: () => Promise<unknown>) {
  const count: number = await page.evaluate("navigates.length");
  await action();
  await page.evaluate(`new Promise((resolve) => {
    const poll = () => (navigates.length > ${count} ? setTimeout(resolve, 50) : setTimeout(poll, 10));
    poll();
  })`);
}

/** Goes back (-1) or forward (+1) through the browser, as its buttons do. */
async function traverse(page: Page, delta: number) {
  const { currentIndex, entries }: { currentIndex: number; entries: { id: number }[] } =
    await page.cdp("Page.getNavigationHistory");
  await page.cdp("Page.navigateToHistoryEntry", { entryId: entries[currentIndex + delta].id });
}

/** The number of entries in the page's history. */
const entries = (page: Page): Promise<number> => page.evaluate("navigation.entries().length");

/** Marks the outlet's element, so a test can tell whether it is the same one later. */
const mark = (page: Page): Promise<true> => page.evaluate("outlet.firstElementChild.marked = true");
const marked = (page: Page): Promise<boolean> =>
  page.evaluate("outlet.firstElementChild?.marked === true");

/** The snapshot of a mounted x-user for the user, at the URL. */
const user = (name: string, url: string, query = ""): Snapshot => ({
  url,
  outlet: `<x-user user="${name}"></x-user>`,
  current: { pattern: "users/:user", tag: "x-user", params: { user: name }, query },
});

describe("the router's base", () => {
  test("is the base option, over a <base> element", async () => {
    const options = { base: "/opt", baseElement: "/app/", prefix: "/opt/" };
    const page = await open("/opt/users/7", options);
    assert.deepEqual(await snapshot(page), user("7", "/opt/users/7"));
  });

  test("is the pathname of the <base> element's href without the option", async () => {
    const page = await open("/app/users/7");
    assert.deepEqual(await snapshot(page), user("7", "/app/users/7"));
  });

  test('is "/" with neither', async () => {
    const page = await open("/users/7", {});
    assert.deepEqual(await snapshot(page), user("7", "/users/7"));
  });
});

describe("the router's navigations", () => {
  test("a link's click mounts its route's element", async () => {
    const page = await open("/app/");
    assert.equal((await snapshot(page)).outlet, "<x-home></x-home>");
    const changed = await changeOn(page, () => click(page, "about"));
    assert.deepEqual(changed, {
      url: "/app/about",
      outlet: "<x-about></x-about>",
      current: { pattern: "about", tag: "x-about", params: {}, query: "" },
    });
  });

  test("a loader runs on its route's first visit and defines the element", async () => {
    const page = await open("/app/");
    const changed = await changeOn(page, () => click(page, "lazy"));
    assert.equal(changed.outlet, "<x-lazy></x-lazy>");
    assert.equal(await page.evaluate("loads"), 1);
  });

  test("start() mounts a deep link's route, its query included, and resolves once it has", async () => {
    const page = await open("/app/users/42?tab=posts", APP, { start: false });
    assert.equal(await page.evaluate("settle(router.start())"), "resolved");
    assert.deepEqual(await snapshot(page), user("42", "/app/users/42?tab=posts", "tab=posts"));
  });

  test("a reload loads the page again, whose router mounts the location's route", async () => {
    const page = await open("/app/");
    await changeOn(page, () => click(page, "about"));
    await loadOn(page, () => page.cdp("Page.reload"));
    assert.equal(await page.evaluate("typeof router"), "undefined");
    await page.evaluate(`setup(${JSON.stringify(APP)}); router.start()`);
    assert.equal((await snapshot(page)).outlet, "<x-about></x-about>");
  });

  // The browser's own reload never reaches the router's navigate listener; a script's does, and the
  // router leaves it to the browser too.
  test("a script's location.reload() loads the page again", async () => {
    const page = await open("/app/about");
    await loadOn(page, () => page.evaluate("setTimeout(() => location.reload()), 0"));
    assert.equal(await page.evaluate("typeof router"), "undefined");
  });

  test("back and forward mount each entry's route", async () => {
    const page = await open("/app/");
    await changeOn(page, () => click(page, "about"));
    await changeOn(page, () => click(page, "user"));
    assert.equal((await changeOn(page, () => traverse(page, -1))).outlet, "<x-about></x-about>");
    assert.equal((await changeOn(page, () => traverse(page, -1))).outlet, "<x-home></x-home>");
    const forward = await changeOn(page, () => traverse(page, 1));
    assert.deepEqual([forward.url, forward.outlet], ["/app/about", "<x-about></x-about>"]);
  });

  test("the first pattern in the table's order that matches wins", async () => {
    const page = await open("/app/users/me");
    assert.deepEqual(await snapshot(page), user("me", "/app/users/me"));
  });

  test("each path param is set on the element as an attribute", async () => {
    const page = await open("/app/");
    const changed = await changeOn(page, () => click(page, "user"));
    assert.deepEqual(changed, user("42", "/app/users/42"));
  });

  test("navigate() pushes an entry, or replaces one, and resolves once the element is mounted", async () => {
    const page = await open("/app/");
    const before = await entries(page);
    assert.equal(await page.evaluate("settle(router.navigate('users/5'))"), "resolved");
    assert.deepEqual(await snapshot(page), user("5", "/app/users/5"));
    assert.equal(await entries(page), before + 1);
    assert.equal(
      await page.evaluate("settle(router.navigate('/about', { replace: true }))"),
      "resolved",
    );
    assert.equal((await snapshot(page)).outlet, "<x-about></x-about>");
    assert.equal(await entries(page), before + 1);
  });

  test("navigate() loads its route once", async () => {
    const page = await open("/app/");
    assert.equal(await page.evaluate("settle(router.navigate('lazy'))"), "resolved");
    assert.equal((await snapshot(page)).outlet, "<x-lazy></x-lazy>");
    assert.equal(await page.evaluate("loads"), 1);
  });

  test("query() sets and deletes parameters, keeps the element, and fires change", async () => {
    const page = await open("/app/users/42?keep=1");
    await mark(page);
    const before = await entries(page);
    await page.evaluate("changes.length = 0");

    assert.equal(await page.evaluate("settle(router.query({ tab: 'posts' }))"), "resolved");
    const replaced = user("42", "/app/users/42?keep=1&tab=posts", "keep=1&tab=posts");
    assert.deepEqual(await snapshot(page), replaced);
    assert.deepEqual(await page.evaluate("changes"), [replaced]);
    assert.equal(await entries(page), before);
    assert.ok(await marked(page));

    const push = "router.query({ tab: undefined, page: '2' }, { replace: false })";
    assert.equal(await page.evaluate(`settle(${push})`), "resolved");
    assert.deepEqual(
      await snapshot(page),
      user("42", "/app/users/42?keep=1&page=2", "keep=1&page=2"),
    );
    assert.equal(await entries(page), before + 1);
    assert.ok(await marked(page));
  });
});

describe("a path no pattern matches", () => {
  test("mounts the notFound element", async () => {
    const page = await open("/app/", { ...APP, notFound: true });
    const changed = await changeOn(page, () => click(page, "nowhere"));
    assert.deepEqual(changed, {
      url: "/app/nowhere",
      outlet: "<x-not-found></x-not-found>",
      current: "undefined",
    });
  });

  test("empties the outlet without a notFound option", async () => {
    const page = await open("/app/");
    const changed = await changeOn(page, () => click(page, "nowhere"));
    assert.deepEqual(changed, { url: "/app/nowhere", outlet: "", current: "undefined" });
  });
});

describe("a failing route", () => {
  const failed = "the broken route's loader failed";

  test("on a link's click, mounts the error element at the committed URL and fires navigateerror", async () => {
    const page = await open("/app/", { ...APP, error: true });
    const changed = await changeOn(page, () => click(page, "broken"));
    assert.deepEqual(changed, {
      url: "/app/broken",
      outlet: "<x-error></x-error>",
      current: "undefined",
    });
    assert.deepEqual(await page.evaluate("navigateErrors"), [failed]);
  });

  test("on a link's click, empties the outlet without an error option", async () => {
    const page = await open("/app/");
    const changed = await changeOn(page, () => click(page, "broken"));
    assert.deepEqual(changed, { url: "/app/broken", outlet: "", current: "undefined" });
    assert.deepEqual(await page.evaluate("navigateErrors"), [failed]);
  });

  test("on another script's navigation.navigate(), mounts the error element and fails it", async () => {
    const page = await open("/app/", { ...APP, error: true });
    const outcome = await page.evaluate("settle(navigation.navigate('/app/broken').finished)");
    assert.equal(outcome, `rejected: ${failed}`);
    assert.deepEqual(await snapshot(page), {
      url: "/app/broken",
      outlet: "<x-error></x-error>",
      current: "undefined",
    });
  });

  test("through navigate(), rejects and leaves the URL, the outlet, and current unchanged", async () => {
    const page = await open("/app/about", { ...APP, error: true });
    const before = await snapshot(page);
    const length = await entries(page);
    await page.evaluate("changes.length = 0");
    assert.equal(await page.evaluate("settle(router.navigate('broken'))"), `rejected: ${failed}`);
    assert.deepEqual(await snapshot(page), before);
    assert.equal(await entries(page), length);
    assert.deepEqual(await page.evaluate("[changes, navigateErrors]"), [[], []]);
  });

  test("on start(), mounts the error element and rejects", async () => {
    const page = await open("/app/broken", { ...APP, error: true }, { start: false });
    assert.equal(await page.evaluate("settle(router.start())"), `rejected: ${failed}`);
    assert.deepEqual(await snapshot(page), {
      url: "/app/broken",
      outlet: "<x-error></x-error>",
      current: "undefined",
    });
  });

  test("is a loader's tag no element defines, the error naming it", async () => {
    const page = await open("/app/", { ...APP, error: true });
    const outcome = await page.evaluate("settle(router.navigate('ghost'))");
    assert.match(outcome, /^rejected: .*<x-ghost>/);
    assert.equal((await snapshot(page)).outlet, "<x-home></x-home>");
    const changed = await changeOn(page, () => click(page, "ghost"));
    assert.deepEqual([changed.url, changed.outlet], ["/app/ghost", "<x-error></x-error>"]);
    assert.match((await page.evaluate("navigateErrors"))[0], /<x-ghost>/);
  });
});

describe("the navigations the router leaves to the browser", () => {
  test("a link outside the base loads its page", async () => {
    const page = await open("/app/");
    await loadOn(page, () => click(page, "outside"));
    assert.equal(
      await page.evaluate("location.pathname + ' ' + typeof router"),
      "/outside/page undefined",
    );
  });

  test("a download", async () => {
    const page = await open("/app/");
    await mark(page);
    await navigateOn(page, () => click(page, "download"));
    assert.equal((await snapshot(page)).url, "/app/");
    assert.ok(await marked(page));
    assert.equal(await page.evaluate("changes.length"), 1);
  });

  test("a fragment-only change", async () => {
    const page = await open("/app/");
    await mark(page);
    await navigateOn(page, () => click(page, "fragment"));
    assert.equal((await snapshot(page)).url, "/app/#section");
    assert.ok(await marked(page));
    assert.equal(await page.evaluate("changes.length"), 1);
  });

  test("a form's post", async () => {
    const page = await open("/app/");
    await loadOn(page, () => click(page, "submit"));
    assert.equal(
      await page.evaluate("location.pathname + ' ' + typeof router"),
      "/app/posted undefined",
    );
    assert.ok(requests.includes("POST /app/posted"));
  });

  test("every navigation once stop() is called", async () => {
    const page = await open("/app/");
    await page.evaluate("router.stop()");
    await loadOn(page, () => click(page, "about"));
    assert.equal(
      await page.evaluate("location.pathname + ' ' + typeof router"),
      "/app/about undefined",
    );
  });
});
