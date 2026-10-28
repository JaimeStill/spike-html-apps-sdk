import type { TokenProvider } from "../auth.ts";
import type { EventSequence } from "../events.ts";
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
/** An EventSequence over the JetStream stream `options.stream`, read over WebSocket. Each read is
 * an ordered consumer of its own: deliver-all with no cursor, which starts at the oldest event the
 * stream keeps, or from the stream sequence after the cursor, which the server moves up to the
 * oldest kept when it is gone. A cursor is the delivered message's stream sequence as a decimal
 * string; any string that isn't a positive decimal integer, or one past the stream's last sequence,
 * fails the read. A read's `types` are its consumer's filter subjects, since an event's type is
 * its subject, and the read also checks each event's type against them, so a type holding a NATS
 * wildcard still matches exactly.
 *
 * The reads share one connection, opened by the first and reopened by a read after it is lost.
 * Across a server restart the connection reconnects (nats-core's defaults: 10 attempts, 2 s
 * apart) and each ordered consumer resumes after the last message it delivered, so a read
 * continues with no gap or duplicate. When the connection is lost for good, every read fails, and
 * a read from the last cursor delivered resumes the sequence. */
export declare function natsSequence<T = unknown>(options: NatsSequenceOptions): NatsSequence<T>;
