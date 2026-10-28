// The browser tier's driver: chrome-headless-shell over the DevTools Protocol on a pipe, with no
// package between.
// From spike-html-apps-foundation (679e550): test/browser/support/browser-pipe.js.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What every browser runs with, so a reading is the same on any machine. */
const settings = { lang: "en-US", tz: "UTC", width: 1280, height: 720 };

/** Launches the browser BROWSER_EXECUTABLE names, resolving once the protocol answers. */
export async function launch() {
  const executable = process.env.BROWSER_EXECUTABLE;
  if (!executable)
    throw new Error("BROWSER_EXECUTABLE names no browser: run mise run test:browser");
  const profile = mkdtempSync(join(tmpdir(), "browser-pipe."));
  const child = spawn(
    executable,
    [
      "--headless",
      // Ubuntu's AppArmor refuses the user namespaces a downloaded Chrome's sandbox needs; the
      // browser loads only the repository's pages, from the loopback address.
      "--no-sandbox",
      "--remote-debugging-pipe",
      `--user-data-dir=${profile}`,
      `--lang=${settings.lang}`,
      "--no-first-run",
      "--disable-background-networking",
      "--disable-component-update",
      // Every name but the loopback address fails, so no background request leaves the machine.
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      env: { ...process.env, TZ: settings.tz, TMPDIR: profile },
    },
  );
  // Chromium reads commands on its fd 3 and writes replies and events on its fd 4, each message one
  // JSON object ended by a NUL.
  const [, , errors, commands, replies] = child.stdio;
  let log = "";
  errors.setEncoding("utf8");
  errors.on("data", (chunk) => (log = (log + chunk).slice(-2000)));

  let next = 0;
  const waiting = new Map();
  const listeners = new Map();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let gone = false;
  const fail = () => {
    gone = true;
    const last = log.trim().split("\n").at(-1);
    for (const { reject } of waiting.values()) reject(new Error(`Chromium exited: ${last}`));
    waiting.clear();
  };
  exited.then(fail);
  commands.on("error", fail);
  replies.on("error", fail);

  let buffer = "";
  replies.setEncoding("utf8");
  replies.on("data", (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf("\0"); end >= 0; end = buffer.indexOf("\0")) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id === undefined) {
        listeners.get(`${message.sessionId}:${message.method}`)?.(message.params);
        continue;
      }
      const pending = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) pending?.reject(new Error(`${message.error.message} (CDP)`));
      else pending?.resolve(message.result);
    }
  });

  /** Sends one command, resolving to its result. */
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, { resolve, reject });
      if (gone) return fail();
      commands.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    });

  /** Calls the listener with each event of the method in the session, replacing any before it. */
  const on = (sessionId, method, listener) => listeners.set(`${sessionId}:${method}`, listener);

  // A run that ends without closing the browser still ends it.
  const orphan = () => child.kill();
  process.once("exit", orphan);

  /** Ends the browser, by Browser.close or after 5 s by a signal, and removes its profile. */
  const close = async () => {
    process.off("exit", orphan);
    if (!gone) {
      send("Browser.close").catch(() => {});
      const timer = setTimeout(() => child.kill(), 5000);
      await exited;
      clearTimeout(timer);
    }
    rmSync(profile, { recursive: true, force: true });
  };

  try {
    await send("Browser.getVersion");
  } catch (error) {
    await close();
    throw error;
  }

  /** Opens the URL in a new page, resolving to the page once its load event fires. */
  async function open(url) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    // flatten: the page's commands carry its session id on the one pipe.
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    await cdp("Page.enable");
    // A page Target.createTarget opens headless has no size until one is emulated.
    const { width, height } = settings;
    await cdp("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });

    /** Loads the URL, resolving once its load event fires. */
    const goto = async (url) => {
      const loaded = new Promise((resolve) => on(sessionId, "Page.loadEventFired", resolve));
      const { errorText } = await cdp("Page.navigate", { url });
      if (errorText) throw new Error(`${url}: ${errorText}`);
      await loaded;
    };
    await goto(url);

    return {
      goto,
      /** Sends the page one protocol command, resolving to its result. */
      cdp,
      /** Calls the listener with each of the page's events of the method. */
      on: (method, listener) => on(sessionId, method, listener),
      /** The expression's value, awaited when it is a promise, as JSON. */
      async evaluate(expression) {
        const { result, exceptionDetails } = await cdp("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (exceptionDetails) {
          throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        }
        return result.value;
      },
      close: () => send("Target.closeTarget", { targetId }),
    };
  }

  return { open, close };
}
