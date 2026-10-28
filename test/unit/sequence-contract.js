// The EventSequence contract as a suite any implementation runs: src/events.ts's semantics, each a
// test against a sequence a factory makes. test/unit/events.test.js runs it against the in-memory
// sequence; an adapter's suite runs it against the adapter, over a live server. Every test has a
// timeout, so a read that hangs, never delivering or never ending, fails rather than stalls.

import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { describe, test } from "node:test";

/** How long a test may run before it fails as a hang. */
const timeout = 5000;
/** How long a test waits before an append, so the read it races is waiting when it lands. */
const settle = 50;

/** A CloudEvent numbered `n`, of `type`. Every event carries data and an extension attribute, so a
 * sequence that round-trips them through a wire format is held to giving them back as appended. */
export function cloudEvent(n, type = "lab.test.created") {
  return {
    specversion: "1.0",
    id: `event-${n}`,
    source: "/test/sequence",
    type,
    subject: `item-${n}`,
    time: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    datacontenttype: "application/json",
    data: { n },
    extensions: { traceparent: `00-${String(n).padStart(32, "0")}-${"1".repeat(16)}-01` },
  };
}

/** The first `count` deliveries of `iterable`, the read then ended by a break. */
async function take(iterable, count) {
  const deliveries = [];
  for await (const delivery of iterable) {
    deliveries.push(delivery);
    if (deliveries.length === count) break;
  }
  return deliveries;
}

/** The events of `deliveries`. */
const eventsOf = (deliveries) => deliveries.map(({ event }) => event);

/**
 * Registers the contract's tests under `name`. `factory(events, options)` makes a fresh sequence
 * holding `events`, appended in order, and resolves (or returns) `{ sequence, append, close? }`:
 * `append(event)` resolves once a read can deliver the event, and `close()`, when given, frees the
 * sequence after its test. `options.keep`, when given, is the most events the sequence keeps, the
 * oldest discarded past it.
 */
export function sequenceContract(name, factory) {
  /** Runs `body` over a fresh sequence, closing it afterwards whether `body` passes or not. */
  async function using(events, options, body) {
    const made = await factory(events, options);
    try {
      await body(made);
    } finally {
      await made.close?.();
    }
  }

  describe(name, { timeout }, () => {
    test("a read with no cursor delivers every event in order, each with a string cursor", () =>
      using(
        [1, 2, 3].map((n) => cloudEvent(n)),
        {},
        async ({ sequence }) => {
          const deliveries = await take(sequence.read(), 3);
          assert.deepEqual(
            eventsOf(deliveries),
            [1, 2, 3].map((n) => cloudEvent(n)),
          );
          const cursors = deliveries.map(({ cursor }) => cursor);
          for (const cursor of cursors) assert.equal(typeof cursor, "string");
          assert.equal(new Set(cursors).size, 3, "each delivery has a cursor of its own");
        },
      ));

    test("a read after a cursor resumes at the next event, with no gap or duplicate", () =>
      using(
        [1, 2, 3, 4].map((n) => cloudEvent(n)),
        {},
        async ({ sequence, append }) => {
          const first = await take(sequence.read(), 2);
          const second = await take(sequence.read({ after: first[1].cursor }), 2);
          await append(cloudEvent(5));
          const third = await take(sequence.read({ after: second[1].cursor }), 1);
          assert.deepEqual(
            eventsOf([...first, ...second, ...third]),
            [1, 2, 3, 4, 5].map((n) => cloudEvent(n)),
          );
          // The same cursor resumes at the same place each time.
          const again = await take(sequence.read({ after: first[1].cursor }), 1);
          assert.deepEqual(eventsOf(again), [cloudEvent(3)]);
        },
      ));

    test("a read with types delivers only those types, matched exactly", () => {
      const events = [
        cloudEvent(1, "lab.test.a"),
        cloudEvent(2, "lab.test.b"),
        cloudEvent(3, "lab.test.a.more"),
        cloudEvent(4, "lab.test"),
        cloudEvent(5, "lab.test.c"),
        cloudEvent(6, "lab.test.a"),
      ];
      return using(events, {}, async ({ sequence }) => {
        const deliveries = await take(sequence.read({ types: ["lab.test.a", "lab.test.c"] }), 3);
        assert.deepEqual(eventsOf(deliveries), [events[0], events[4], events[5]]);
        // A filtered read resumes after its last delivery, still filtered.
        const resumed = await take(
          sequence.read({ after: deliveries[0].cursor, types: ["lab.test.a"] }),
          1,
        );
        assert.deepEqual(eventsOf(resumed), [events[5]]);
      });
    });

    test("a waiting read delivers each event appended while it waits", () =>
      using([cloudEvent(1)], {}, async ({ sequence, append }) => {
        const deliveries = sequence.read()[Symbol.asyncIterator]();
        try {
          assert.deepEqual((await deliveries.next()).value.event, cloudEvent(1));
          for (const n of [2, 3]) {
            const next = deliveries.next();
            await delay(settle);
            await append(cloudEvent(n));
            assert.deepEqual((await next).value.event, cloudEvent(n));
          }
        } finally {
          await deliveries.return?.();
        }
      }));

    test("a signal that aborts while the read waits ends it without a rejection", () =>
      using([cloudEvent(1)], {}, async ({ sequence, append }) => {
        const controller = new AbortController();
        const deliveries = sequence.read({ signal: controller.signal })[Symbol.asyncIterator]();
        assert.deepEqual((await deliveries.next()).value.event, cloudEvent(1));
        const next = deliveries.next();
        await delay(settle);
        controller.abort();
        assert.deepEqual(await next, { done: true, value: undefined });
        // The ended read delivers nothing appended after it.
        await append(cloudEvent(2));
        assert.equal((await deliveries.next()).done, true);
      }));

    test("a signal already aborted delivers nothing", () =>
      using([cloudEvent(1)], {}, async ({ sequence }) => {
        const deliveries = [];
        for await (const delivery of sequence.read({ signal: AbortSignal.abort() })) {
          deliveries.push(delivery);
        }
        assert.deepEqual(deliveries, []);
      }));

    test("a break ends the read, and the sequence reads on", () =>
      using(
        [1, 2].map((n) => cloudEvent(n)),
        {},
        async ({ sequence, append }) => {
          const iterable = sequence.read();
          const seen = [];
          for await (const { event } of iterable) {
            seen.push(event);
            break;
          }
          assert.deepEqual(seen, [cloudEvent(1)]);
          await append(cloudEvent(3));
          const all = await take(sequence.read(), 3);
          assert.deepEqual(
            eventsOf(all),
            [1, 2, 3].map((n) => cloudEvent(n)),
          );
        },
      ));

    test("a read with no cursor starts at the oldest event the sequence keeps", () =>
      using(
        [1, 2, 3].map((n) => cloudEvent(n)),
        { keep: 2 },
        async ({ sequence, append }) => {
          const deliveries = await take(sequence.read(), 2);
          assert.deepEqual(
            eventsOf(deliveries),
            [2, 3].map((n) => cloudEvent(n)),
          );
          // A cursor whose event is no longer kept resumes at the oldest kept.
          await append(cloudEvent(4));
          await append(cloudEvent(5));
          const resumed = await take(sequence.read({ after: deliveries[0].cursor }), 1);
          assert.deepEqual(eventsOf(resumed), [cloudEvent(4)]);
        },
      ));

    test("a cursor the sequence never gave out fails the read", () =>
      using([cloudEvent(1)], {}, async ({ sequence }) => {
        await assert.rejects(take(sequence.read({ after: "not a cursor" }), 1), Error);
      }));
  });
}
