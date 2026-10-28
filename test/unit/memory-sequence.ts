// An in-memory EventSequence, the contract's reference implementation: events appended to an array,
// each read a generator over it that waits for the next append. It is test code, never exported by
// the package: test/unit/events.test.js runs the sequence contract against it, and type-checks it
// with tsc.

import type {
  CloudEvent,
  Cursor,
  Delivery,
  EventSequence,
  ReadOptions,
} from "@jaimestill/spike-html-apps-sdk/events.js";

/** How the sequence is made: `keep`, the most events it keeps, the oldest discarded past it; every
 * event when absent. */
export interface MemoryOptions {
  keep?: number;
}

/** An in-memory sequence holding `events`, in order, and the append that adds one, waking every
 * read that waits. Its cursor is an event's position, from 1, as a decimal string: one never given
 * out (not a position, or past the last event appended) is unknown, and fails the read. */
export function memorySequence(events: readonly CloudEvent[] = [], options: MemoryOptions = {}) {
  // The events kept, oldest first, and the position of the first.
  const kept: CloudEvent[] = [];
  let first = 1;
  // The wakes of the reads waiting for an append.
  const waiting = new Set<() => void>();

  async function append(event: CloudEvent): Promise<void> {
    kept.push(event);
    if (options.keep !== undefined && kept.length > options.keep) {
      kept.shift();
      first += 1;
    }
    for (const wake of waiting) wake();
  }

  /** Resolves on the next append or when `signal` aborts, its wake and listener removed either
   * way. */
  function appended(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        waiting.delete(wake);
        signal?.removeEventListener("abort", wake);
        resolve();
      };
      waiting.add(wake);
      signal?.addEventListener("abort", wake);
    });
  }

  // The generator's body runs on the first next(), so an unknown cursor rejects the iteration, and a
  // break's return() ends it at its yield, where no wake is registered.
  async function* read({ after, types, signal }: ReadOptions = {}): AsyncGenerator<Delivery> {
    let next = first;
    if (after !== undefined) {
      const position = /^[1-9]\d*$/.test(after) ? Number(after) : 0;
      if (position === 0 || position >= first + kept.length) {
        throw new Error(`the sequence gave out no cursor ${JSON.stringify(after)}`);
      }
      next = position + 1;
    }
    while (!signal?.aborted) {
      // An event discarded before the read reached it is skipped: the read goes on from the oldest.
      next = Math.max(next, first);
      if (next >= first + kept.length) {
        await appended(signal);
        continue;
      }
      const event = kept[next - first];
      const cursor = String(next) as Cursor;
      next += 1;
      if (!types?.length || types.includes(event.type)) yield { event, cursor };
    }
  }

  for (const event of events) void append(event);
  const sequence = { read } satisfies EventSequence;
  return { sequence, append };
}
