// The NATS adapter: an EventSequence over a JetStream stream, read over WebSocket, of the CloudEvents
// go-messaging's NATS broker (nats/v0.2.0) publishes in binary content mode. It is the one module
// that imports the @nats-io packages, which are optional peer dependencies: an app that reads no
// NATS stream never loads them.

import { AuthorizationError, tokenAuthenticator, wsconnect } from "@nats-io/nats-core";
import type { NatsConnection } from "@nats-io/nats-core";
import { DeliverPolicy, jetstream } from "@nats-io/jetstream";
import type { ConsumerMessages, JsMsg, OrderedConsumerOptions } from "@nats-io/jetstream";

import type { TokenProvider } from "../auth.ts";
import { anonymous } from "../auth.ts";
import type { CloudEvent, Cursor, Delivery, EventSequence, ReadOptions } from "../events.ts";

/** How a NATS sequence is made: the servers it connects to, the stream it reads, and where its
 * token comes from. */
export interface NatsSequenceOptions {
  /** The server's WebSocket URL (ws:// or wss://), or several, which the connection tries in turn
   * and reconnects among. */
  servers: string | readonly string[];
  /** The JetStream stream that holds the events, each on a subject that is its type. */
  stream: string;
  /** Where the connection's token comes from: `token()` before it connects, and `refresh()` once
   * when the server refuses that token, the connection then retried with the new one. A refresh
   * that gives no token fails the read. anonymous, connecting with no token, by default. */
  token?: TokenProvider;
}

/** An EventSequence over a NATS stream, with the close that ends it. */
export interface NatsSequence<T = unknown> extends EventSequence<T> {
  /** Ends every read, each quietly, as its signal would, and closes the connection; a read begun
   * after it fails. Resolves once the connection is closed. */
  close(): Promise<void>;
}

/** The CloudEvents context attributes binary content mode carries as ce-* headers (go-core
 * v0.10.0's event.Encode); any other ce-* header is an extension. datacontenttype rides in
 * content-type instead. */
const attributes = new Set([
  "specversion",
  "id",
  "source",
  "type",
  "subject",
  "time",
  "dataschema",
]);

/** A cursor this adapter writes: a stream sequence, a positive decimal integer. */
const cursorPattern = /^[1-9][0-9]*$/;

/** The stream sequence `cursor` marks; throws on a string the adapter never writes. */
function sequenceOf(cursor: string): number {
  const seq = Number(cursor);
  if (!cursorPattern.test(cursor) || !Number.isSafeInteger(seq)) {
    throw new Error(`the NATS sequence gave out no cursor ${JSON.stringify(cursor)}`);
  }
  return seq;
}

/** `data`, the bytes of the event `id`, decoded by `contentType`: application/json and any +json
 * type parsed, any text/* type decoded in its charset (UTF-8 by default), and any other type, or
 * none, the bytes themselves. Throws, naming the event, on bytes that don't decode as their type. */
function decodeData(id: string, contentType: string | undefined, data: Uint8Array): unknown {
  const [essence = "", ...parameters] = (contentType ?? "").split(";");
  const type = essence.trim().toLowerCase();
  const json = type === "application/json" || type.endsWith("+json");
  if (!json && !type.startsWith("text/")) return data.slice();
  const charset = parameters
    .map((parameter) => parameter.trim().match(/^charset\s*=\s*"?([^";]+)"?$/i)?.[1])
    .find((value) => value !== undefined);
  try {
    // fatal: a byte sequence that isn't the charset's fails, rather than decoding as U+FFFD.
    const text = new TextDecoder(json ? "utf-8" : (charset ?? "utf-8"), { fatal: true }).decode(
      data,
    );
    return json ? JSON.parse(text) : text;
  } catch (cause) {
    throw new Error(`the event "${id}" has data that doesn't decode as ${contentType}`, { cause });
  }
}

/** The CloudEvent `msg` carries in binary content mode, as go-messaging's broker publishes it: the
 * ce-* headers the attributes and extensions, content-type the datacontenttype, and the body the
 * data, absent when empty. Header names match case-insensitively, a lowercase name winning over
 * another spelling of it, as go-core's event.Decode reads them. Throws on a message that isn't a
 * CloudEvents 1.0 event, or whose data doesn't decode. */
function decode(msg: JsMsg): CloudEvent {
  const headers = new Map<string, string>();
  for (const key of msg.headers?.keys() ?? []) {
    const lower = key.toLowerCase();
    if (lower !== key && msg.headers?.has(lower)) continue;
    headers.set(lower, msg.headers?.get(key) ?? "");
  }
  const event: Record<string, unknown> = {};
  const extensions: Record<string, string> = {};
  for (const [key, value] of headers) {
    if (key === "content-type") event.datacontenttype = value;
    else if (key.startsWith("ce-")) {
      const name = key.slice("ce-".length);
      if (attributes.has(name)) event[name] = value;
      else extensions[name] = value;
    }
  }
  if (event.specversion !== "1.0" || !event.id || !event.source || !event.type) {
    throw new Error(
      `the stream's message ${msg.seq} isn't a CloudEvents 1.0 event in binary content mode`,
    );
  }
  if (msg.data.length > 0) {
    event.data = decodeData(event.id as string, event.datacontenttype as string, msg.data);
  }
  if (Object.keys(extensions).length > 0) event.extensions = extensions;
  return event as unknown as CloudEvent;
}

/** An EventSequence over the JetStream stream `options.stream`, read over WebSocket. Each read is
 * an ordered consumer of its own: deliver-all with no cursor, which starts at the oldest event the
 * stream keeps, or from the stream sequence after the cursor, which the server moves up to the
 * oldest kept when it is gone. A cursor is the delivered message's stream sequence as a decimal
 * string; any string that isn't a positive decimal integer fails the read. A read's `types` are
 * its consumer's filter subjects, since an event's type is its subject, and the read also checks
 * each event's type against them, so a type holding a NATS wildcard still matches exactly.
 *
 * The reads share one connection, opened by the first and reopened by a read after it is lost.
 * Across a server restart the connection reconnects (nats-core's defaults: 10 attempts, 2 s
 * apart) and each ordered consumer resumes after the last message it delivered, so a read
 * continues with no gap or duplicate. When the connection is lost for good, every read fails, and
 * a read from the last cursor delivered resumes the sequence. */
export function natsSequence<T = unknown>(options: NatsSequenceOptions): NatsSequence<T> {
  const { stream, token: provider = anonymous } = options;
  const servers = typeof options.servers === "string" ? [options.servers] : [...options.servers];
  // The token the connection presents, read on every (re)connect.
  let token: string | undefined;
  let connecting: Promise<NatsConnection> | undefined;
  let closed = false;
  // Each read's messages, with what it fails with when the connection is lost.
  const reads = new Map<ConsumerMessages, { failure?: Error }>();

  /** Opens a connection with the current token. */
  const open = () =>
    wsconnect({
      servers,
      ...(token === undefined ? {} : { authenticator: tokenAuthenticator(() => token ?? "") }),
    });

  /** Opens the connection, refreshing the token once when the server refuses it, and watches it:
   * when it closes but by close(), every read fails, and the next read reconnects. */
  async function connect(): Promise<NatsConnection> {
    token = await provider.token();
    let nc: NatsConnection;
    try {
      nc = await open();
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      token = await provider.refresh();
      if (token === undefined) {
        throw new Error("the NATS server refused the token, and its refresh gave none", {
          cause: error,
        });
      }
      nc = await open();
    }
    nc.closed().then((cause) => {
      connecting = undefined;
      if (closed) return;
      const failure = new Error("the NATS connection was lost", { cause });
      for (const [messages, read] of reads) {
        read.failure = failure;
        messages.stop();
      }
    });
    return nc;
  }

  /** The shared connection, opened when there is none; a failed open is forgotten, so the next
   * read tries again. */
  function connection(): Promise<NatsConnection> {
    connecting ??= connect().catch((error: unknown) => {
      connecting = undefined;
      throw error;
    });
    return connecting;
  }

  async function* read(readOptions: ReadOptions = {}): AsyncGenerator<Delivery<T>> {
    const { after, types = [], signal } = readOptions;
    const start = after === undefined ? undefined : sequenceOf(after);
    if (closed) throw new Error("the NATS sequence is closed");
    if (signal?.aborted) return;
    const nc = await connection();
    const consumerOptions: Partial<OrderedConsumerOptions> =
      start === undefined
        ? { deliver_policy: DeliverPolicy.All }
        : { deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: start + 1 };
    if (types.length > 0) consumerOptions.filter_subjects = [...types];
    const consumer = await jetstream(nc).consumers.get(stream, consumerOptions);
    const messages = await consumer.consume();
    const state: { failure?: Error } = {};
    reads.set(messages, state);
    const stop = () => messages.stop();
    signal?.addEventListener("abort", stop, { once: true });
    try {
      // The signal may have aborted, or close() run, while the consumer was made.
      if (signal?.aborted || closed) return;
      const wanted = new Set(types);
      for await (const msg of messages) {
        const event = decode(msg);
        if (wanted.size > 0 && !wanted.has(event.type)) continue;
        yield { event: event as CloudEvent<T>, cursor: String(msg.seq) as Cursor };
      }
      if (state.failure) throw state.failure;
    } finally {
      signal?.removeEventListener("abort", stop);
      reads.delete(messages);
      messages.stop();
    }
  }

  async function close(): Promise<void> {
    closed = true;
    for (const messages of reads.keys()) messages.stop();
    const nc = await connecting?.catch(() => undefined);
    await nc?.close();
  }

  return { read, close };
}
