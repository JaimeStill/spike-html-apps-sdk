// The NATS adapter as a consumer imports it, the package's ./events/nats.js export over the dist/
// mise run build wrote, against a real nats-server (test/unit/nats-server.ts) over WebSocket: the
// sequence contract, its token and refresh, its decoding of go-messaging's binary content mode, a
// server restart mid-read, and the package's other subpaths loading without the @nats-io packages.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, test } from "node:test";

import { headers, wsconnect, type NatsConnection } from "@nats-io/nats-core";
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { anonymous, type TokenProvider } from "@jaimestill/spike-html-apps-sdk/auth.js";
import type { CloudEvent } from "@jaimestill/spike-html-apps-sdk/events.js";
import { natsSequence } from "@jaimestill/spike-html-apps-sdk/events/nats.js";

import { startServer, type NatsServer } from "./nats-server.ts";
import { cloudEvent, forged, sequenceContract } from "./sequence-contract.ts";

const root = join(import.meta.dirname, "../..");
const secret = "nats-tier-token";
/** A provider of the server's token. */
const authorized = { token: async () => secret, refresh: async () => secret };
/** The subjects every test's stream captures: each event type the tier publishes is under lab. */
const subjects = ["lab.>"];

let server: NatsServer;
let publisher: NatsConnection;
let js: JetStreamClient;
let jsm: JetStreamManager;
before(async () => {
  server = await startServer({ token: secret });
  publisher = await wsconnect({ servers: server.url, token: secret });
  js = jetstream(publisher);
  jsm = await jetstreamManager(publisher);
});
after(async () => {
  await publisher?.close();
  await server?.stop();
});

const encoder = new TextEncoder();

/** Publishes `event` as go-messaging nats/v0.2.0 does (nats/broker.go's Publish, over go-core
 * v0.10.0's event/codec.go Encode): the subject the event's type, the context attributes as ce-*
 * headers (time written as the event has it, which Encode would write in UTC with nanoseconds),
 * datacontenttype as content-type, each extension as ce-<name>, Nats-Msg-Id its msgID, the
 * source's length in bytes, ":", the source, and the id, and the body the data's bytes: `body`
 * when given, else data JSON-encoded for a JSON type, a string's UTF-8, or a Uint8Array itself.
 * Resolves once the stream holds it. */
async function publish(event: CloudEvent, body?: string | Uint8Array) {
  const h = headers();
  const attributes = [
    "specversion",
    "id",
    "source",
    "type",
    "dataschema",
    "subject",
    "time",
  ] as const;
  for (const name of attributes) {
    const value = event[name];
    if (value !== undefined) h.set(`ce-${name}`, value);
  }
  if (event.datacontenttype !== undefined) h.set("content-type", event.datacontenttype);
  for (const [name, value] of Object.entries(event.extensions ?? {})) h.set(`ce-${name}`, value);
  h.set("Nats-Msg-Id", `${encoder.encode(event.source).length}:${event.source}${event.id}`);
  let data = body;
  if (data === undefined && event.data !== undefined) {
    if (event.data instanceof Uint8Array) data = event.data;
    else if (typeof event.data === "string") data = encoder.encode(event.data);
    else data = encoder.encode(JSON.stringify(event.data));
  }
  await js.publish(event.type, data, { headers: h });
}

let streams = 0;
/** A fresh stream holding `events`, `keep` its max_msgs, and the sequence over it; close() closes
 * the sequence and deletes the stream, whose subjects the next test's stream takes. */
/** How a fresh stream is made: `keep`, its max_msgs, and the sequence's token provider. */
interface FreshOptions {
  keep?: number;
  token?: TokenProvider;
}

async function fresh(events: CloudEvent[], { keep, token = authorized }: FreshOptions = {}) {
  const stream = `TIER${++streams}`;
  await jsm.streams.add({ name: stream, subjects, max_msgs: keep ?? -1 });
  for (const event of events) await publish(event);
  const sequence = natsSequence({ servers: server.url, stream, token });
  return {
    stream,
    sequence,
    append: (event: CloudEvent) => publish(event),
    async close() {
      await sequence.close();
      await jsm.streams.delete(stream);
    },
  };
}

/** Runs `body` over a fresh stream, closing it afterwards. */
async function using(
  events: CloudEvent[],
  options: FreshOptions,
  body: (made: Awaited<ReturnType<typeof fresh>>) => Promise<void>,
) {
  const made = await fresh(events, options);
  try {
    await body(made);
  } finally {
    await made.close();
  }
}

/** The first `count` deliveries of `iterable`, the read then ended by a break. */
async function take<T>(iterable: AsyncIterable<T>, count: number): Promise<T[]> {
  const deliveries: T[] = [];
  for await (const delivery of iterable) {
    deliveries.push(delivery);
    if (deliveries.length === count) break;
  }
  return deliveries;
}

sequenceContract("the NATS sequence", (events, options) => fresh(events, options));

describe("the NATS sequence's connection", { timeout: 15000 }, () => {
  test("it reads over WebSocket: every client connection the server holds is a WebSocket one", () =>
    using([cloudEvent(1)], {}, async ({ sequence }) => {
      const deliveries = sequence.read()[Symbol.asyncIterator]();
      try {
        await deliveries.next();
        const connz: { connections: { type: string }[] } = await (
          await fetch(`${server.monitor}/connz`)
        ).json();
        // The publisher's and the adapter's.
        assert.deepEqual(
          connz.connections.map(({ type }) => type),
          ["websocket", "websocket"],
        );
      } finally {
        await deliveries.return?.();
      }
    }));

  test("a server URL that doesn't speak WebSocket fails the read", async () => {
    const stream = `TIER${++streams}`;
    await jsm.streams.add({ name: stream, subjects });
    const servers = `ws://127.0.0.1:${server.clientPort}`;
    const sequence = natsSequence({ servers, stream, token: authorized });
    try {
      await assert.rejects(take(sequence.read(), 1), Error);
    } finally {
      await sequence.close();
      await jsm.streams.delete(stream);
    }
  });

  test("a refused token whose refresh gives none fails the read", () =>
    using([cloudEvent(1)], { token: anonymous }, async ({ sequence }) => {
      await assert.rejects(take(sequence.read(), 1), {
        message: "the NATS server refused the token, and its refresh gave none",
      });
    }));

  test("a refused token is refreshed once, and the read goes on with the new one", async () => {
    const calls: string[] = [];
    const token = {
      token: async () => (calls.push("token"), "stale"),
      refresh: async () => (calls.push("refresh"), secret),
    };
    await using([cloudEvent(1)], { token }, async ({ sequence }) => {
      const [{ event }] = await take(sequence.read(), 1);
      assert.deepEqual(event, cloudEvent(1));
      assert.deepEqual(calls, ["token", "refresh"]);
    });
  });

  test("a refresh the server refuses too fails the read, refreshing only once", async () => {
    let refreshes = 0;
    const token = { token: async () => "stale", refresh: async () => (refreshes++, "staler") };
    await using([cloudEvent(1)], { token }, async ({ sequence }) => {
      await assert.rejects(take(sequence.read(), 1), { name: "AuthorizationError" });
      assert.equal(refreshes, 1);
    });
  });

  test("close() ends a waiting read quietly, and a read after it fails", () =>
    using([cloudEvent(1)], {}, async ({ sequence }) => {
      const deliveries = sequence.read()[Symbol.asyncIterator]();
      await deliveries.next();
      const next = deliveries.next();
      await sequence.close();
      assert.deepEqual(await next, { done: true, value: undefined });
      await assert.rejects(take(sequence.read(), 1), { message: "the NATS sequence is closed" });
    }));

  test("a cursor that isn't a positive decimal integer fails the read", () =>
    using([cloudEvent(1)], {}, async ({ sequence }) => {
      for (const after of ["0", "01", "-1", "1.5", "1e3", " 1", "9007199254740993"]) {
        await assert.rejects(take(sequence.read({ after: forged(after) }), 1), {
          message: `the NATS sequence gave out no cursor ${JSON.stringify(after)}`,
        });
      }
    }));

  test("a cursor past the stream's last sequence fails the read; one at it waits", () =>
    using(
      [1, 2, 3].map((n) => cloudEvent(n)),
      {},
      async ({ sequence, append }) => {
        for (const after of ["4", "1000"]) {
          await assert.rejects(take(sequence.read({ after: forged(after) }), 1), {
            message: `the NATS sequence gave out no cursor ${JSON.stringify(after)}`,
          });
        }
        const deliveries = sequence.read({ after: forged("3") })[Symbol.asyncIterator]();
        try {
          const next = deliveries.next();
          await delay(50);
          await append(cloudEvent(4));
          assert.deepEqual((await next).value, { event: cloudEvent(4), cursor: "4" });
        } finally {
          await deliveries.return?.();
        }
      },
    ));

  test("a cursor is the event's stream sequence, as a decimal string", () =>
    using(
      [1, 2].map((n) => cloudEvent(n)),
      {},
      async ({ sequence }) => {
        const deliveries = await take(sequence.read(), 2);
        assert.deepEqual(
          deliveries.map(({ cursor }) => cursor),
          ["1", "2"],
        );
      },
    ));
});

describe("the NATS sequence's decoding", { timeout: 15000 }, () => {
  const base = { specversion: "1.0", source: "/test/decoding", type: "lab.test.decoded" } as const;
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  // Each case: its name, and the attributes and data its event carries beside base's.
  const cases: [string, Partial<CloudEvent>][] = [
    ["JSON", { datacontenttype: "application/json", data: { a: [1, "two", null] } }],
    ["+json", { datacontenttype: "application/vnd.lab.result+json", data: { ok: true } }],
    ["JSON with parameters", { datacontenttype: "Application/JSON; charset=utf-8", data: [1] }],
    ["text", { datacontenttype: "text/plain", data: "plain text, é" }],
    ["text in its charset", { datacontenttype: "text/csv; charset=utf-8", data: "a,b\n1,2" }],
    ["bytes", { datacontenttype: "application/octet-stream", data: bytes }],
    ["no content type", { data: bytes }],
    ["no data", { datacontenttype: "application/json" }],
    [
      "every attribute and two extensions",
      {
        subject: "item-9",
        time: "2026-01-01T00:00:09.123456789Z",
        dataschema: "https://example.test/schema.json",
        datacontenttype: "application/json",
        data: { n: 9 },
        extensions: {
          traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
          x: "y",
        },
      },
    ],
  ];
  const events: CloudEvent[] = cases.map(([, fields], n) => ({
    ...base,
    id: `decoded-${n}`,
    ...fields,
  }));

  test("each content type decodes as go-messaging encoded it", () =>
    using(events, {}, async ({ sequence }) => {
      const deliveries = await take(sequence.read(), events.length);
      deliveries.forEach(({ event }, n) => assert.deepEqual(event, events[n], cases[n][0]));
    }));

  test("a header name matches in any case, a lowercase one winning", () =>
    using([], {}, async ({ sequence }) => {
      const h = headers();
      for (const [name, value] of [
        ["CE-SpecVersion", "1.0"],
        ["Ce-Id", "upper-1"],
        ["ce-source", "/lower"],
        ["Ce-Source", "/upper"],
        ["ce-type", "lab.test.cased"],
        ["Content-Type", "text/plain"],
      ]) {
        h.set(name, value);
      }
      await js.publish("lab.test.cased", encoder.encode("hi"), { headers: h });
      const [{ event }] = await take(sequence.read(), 1);
      assert.deepEqual(event, {
        specversion: "1.0",
        id: "upper-1",
        source: "/lower",
        type: "lab.test.cased",
        datacontenttype: "text/plain",
        data: "hi",
      });
    }));

  test("data that doesn't parse as its type ends the read, naming the event", () =>
    using([], {}, async ({ sequence }) => {
      const good = { ...base, id: "good", datacontenttype: "application/json", data: { ok: 1 } };
      await publish(good);
      await publish({ ...base, id: "broken", datacontenttype: "application/json" }, "{not json");
      await publish({ ...good, id: "after" });
      const seen: string[] = [];
      await assert.rejects(
        (async () => {
          for await (const { event } of sequence.read()) seen.push(event.id);
        })(),
        { message: 'the event "broken" has data that doesn\'t decode as application/json' },
      );
      assert.deepEqual(seen, ["good"]);
    }));

  test("text that isn't its charset ends the read, naming the event", () =>
    using([], {}, async ({ sequence }) => {
      const event = { ...base, id: "bad-utf8", datacontenttype: "text/plain" };
      await publish(event, new Uint8Array([0x61, 0xff, 0x62]));
      await assert.rejects(take(sequence.read(), 1), {
        message: 'the event "bad-utf8" has data that doesn\'t decode as text/plain',
      });
    }));

  test("a message that isn't a CloudEvent ends the read", () =>
    using([], {}, async ({ sequence }) => {
      await js.publish("lab.test.plain", encoder.encode("not an event"));
      await assert.rejects(take(sequence.read(), 1), {
        message: "the stream's message 1 isn't a CloudEvents 1.0 event in binary content mode",
      });
    }));
});

describe("the NATS sequence across a server restart", { timeout: 30000 }, () => {
  test("a read waiting through a restart continues after the last event it delivered", () =>
    using(
      [1, 2, 3].map((n) => cloudEvent(n)),
      {},
      async ({ sequence, append }) => {
        const deliveries = sequence.read()[Symbol.asyncIterator]();
        try {
          const seen: CloudEvent[] = [];
          for (let n = 0; n < 2; n++) seen.push((await deliveries.next()).value.event);
          // The publisher reconnects as the adapter does (nats-core's default, every 2 s); it
          // appends once it has.
          const reconnected = (async () => {
            for await (const status of publisher.status()) if (status.type === "reconnect") return;
          })();
          await server.restart();
          await reconnected;
          await append(cloudEvent(4));
          for (let n = 0; n < 2; n++) seen.push((await deliveries.next()).value.event);
          assert.deepEqual(
            seen,
            [1, 2, 3, 4].map((n) => cloudEvent(n)),
          );
        } finally {
          await deliveries.return?.();
        }
      },
    ));
});

describe("the optional peer dependencies", () => {
  test("every subpath but ./events/nats.js loads without the @nats-io packages", () => {
    // A copy of the package in a scratch node_modules/ with no @nats-io, so nothing resolves them
    // (a link would resolve from the repository, whose node_modules/ holds them).
    const scratch = mkdtempSync(join(tmpdir(), "peers-"));
    try {
      const pkg = join(scratch, "node_modules/@jaimestill/spike-html-apps-sdk");
      mkdirSync(pkg, { recursive: true });
      cpSync(join(root, "package.json"), join(pkg, "package.json"));
      cpSync(join(root, "dist"), join(pkg, "dist"), { recursive: true });
      const { exports } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        exports: Record<string, unknown>;
      };
      const subpaths = Object.keys(exports).map(
        (subpath) => `@jaimestill/spike-html-apps-sdk${subpath.slice(1)}`,
      );
      assert.ok(subpaths.includes("@jaimestill/spike-html-apps-sdk/events/nats.js"));
      const script = join(scratch, "load.mjs");
      writeFileSync(
        script,
        `const results = {};
for (const specifier of process.argv.slice(2)) {
  try { await import(specifier); results[specifier] = "loaded"; }
  catch (error) { results[specifier] = error.code + " " + /'([^']+)'/.exec(error.message)?.[1]; }
}
console.log(JSON.stringify(results));`,
      );
      const output = execFileSync(process.execPath, [script, ...subpaths], {
        cwd: scratch,
        encoding: "utf8",
      });
      const expected = Object.fromEntries(
        subpaths.map((specifier) => [
          specifier,
          specifier.endsWith("/events/nats.js")
            ? "ERR_MODULE_NOT_FOUND @nats-io/nats-core"
            : "loaded",
        ]),
      );
      assert.deepEqual(JSON.parse(output), expected);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
