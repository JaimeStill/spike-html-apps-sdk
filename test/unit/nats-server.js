// The NATS tier's server: the nats-server NATS_SERVER names (mise.toml's pin, which mise run
// test:unit passes), started with a generated config on the loopback address, its WebSocket
// listener without TLS, JetStream in a temporary store, and an authorization token. The process
// management follows @jaimestill/spike-html-apps-tooling/browser.js's launch().

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How long a start may take before it fails, and a stop before the server is killed. */
const patience = 5000;

/** Starts a server that accepts `token`, resolving once it is ready, to its WebSocket URL, its
 * monitoring URL, a restart on the same ports and store, and a stop that removes the store. */
export async function startServer({ token }) {
  const executable = process.env.NATS_SERVER;
  if (!executable) throw new Error("NATS_SERVER names no nats-server: run mise run test:unit");
  const dir = mkdtempSync(join(tmpdir(), "nats-server."));
  const config = join(dir, "nats.conf");
  // Port -1 is a free port the server picks; a restart keeps the ones it picked, so a client
  // reconnects to the same URL.
  const ports = { client: -1, websocket: -1, monitor: -1 };
  const write = () =>
    writeFileSync(
      config,
      [
        `listen: "127.0.0.1:${ports.client}"`,
        `http: "127.0.0.1:${ports.monitor}"`,
        `authorization { token: ${JSON.stringify(token)} }`,
        `websocket { listen: "127.0.0.1:${ports.websocket}", no_tls: true }`,
        `jetstream { store_dir: ${JSON.stringify(join(dir, "store"))} }`,
      ].join("\n"),
    );

  let child;
  let exited;
  // A run that ends without stopping the server still ends it.
  const orphan = () => child?.kill("SIGKILL");
  process.once("exit", orphan);

  /** Runs the server on the config, resolving once its log says it is ready, and taking the ports
   * it listens on from the log. */
  async function run() {
    write();
    child = spawn(executable, ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
    exited = new Promise((resolve) => child.once("exit", resolve));
    let log = "";
    child.stderr.setEncoding("utf8");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`nats-server didn't start: ${log}`)),
        patience,
      );
      exited.then((code) => reject(new Error(`nats-server exited ${code}: ${log}`)));
      child.stderr.on("data", (chunk) => {
        log = (log + chunk).slice(-8000);
        if (!log.includes("Server is ready")) return;
        clearTimeout(timer);
        resolve();
      });
    });
    ports.client = Number(log.match(/client connections on 127\.0\.0\.1:(\d+)/)[1]);
    ports.websocket = Number(log.match(/websocket clients on ws:\/\/127\.0\.0\.1:(\d+)/)[1]);
    ports.monitor = Number(log.match(/http monitor on 127\.0\.0\.1:(\d+)/)[1]);
  }

  /** Ends the server, by SIGTERM or after the patience by SIGKILL. */
  async function halt() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), patience);
    await exited;
    clearTimeout(timer);
  }

  try {
    await run();
  } catch (error) {
    await halt();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    /** The WebSocket listener's URL. */
    url: `ws://127.0.0.1:${ports.websocket}`,
    /** The client (TCP) listener's port, which speaks NATS's protocol without WebSocket. */
    clientPort: ports.client,
    /** The monitoring endpoint's URL. */
    monitor: `http://127.0.0.1:${ports.monitor}`,
    /** Stops the server and starts it again on the same ports and store. */
    async restart() {
      await halt();
      await run();
    },
    /** Stops the server and removes its config and store. */
    async stop() {
      process.off("exit", orphan);
      await halt();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
