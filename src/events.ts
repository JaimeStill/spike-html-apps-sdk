// The application SDK's event-sequence interface: a CloudEvent, the opaque cursor that marks a place
// in a sequence, and the sequence an app reads, from its oldest kept event or from after a cursor,
// live as events are appended. It is the contract only, types with no runtime and no dependency:
// an implementation (the NATS adapter, a test's in-memory sequence) meets the semantics its doc
// comments state.

/** A CloudEvent (CloudEvents 1.0), its context attributes as members and its payload as `data`. The
 * four required attributes are always present; the optional ones are absent when the event has
 * none. */
export interface CloudEvent<T = unknown> {
  /** The CloudEvents version the event follows; always "1.0". */
  readonly specversion: "1.0";
  /** The event's id, unique within its source: two events with the same source and id are the same
   * event. */
  readonly id: string;
  /** The context the event happened in, a URI-reference (a pipeline stage's path, say). */
  readonly source: string;
  /** The kind of event, which a read's `types` matches exactly (e.g.
   * "lab.standards.document.indexed"). */
  readonly type: string;
  /** The event's subject within its source (a document's id, say). */
  readonly subject?: string;
  /** When the event happened, an RFC 3339 timestamp. */
  readonly time?: string;
  /** The media type of `data` as the event carries it (e.g. "application/json"). */
  readonly datacontenttype?: string;
  /** A URI of the schema `data` adheres to. */
  readonly dataschema?: string;
  /** The event's payload. */
  readonly data?: T;
  /** The extension attributes, each by its name, its value in the attribute's canonical string
   * form. They have a member of their own, where the JSON format writes them beside the context
   * attributes, so that no extension can shadow a context attribute and the type stays closed:
   * tsc still refuses a misspelled attribute, which an index signature would let through. An
   * implementation moves them between this member and its wire format. */
  readonly extensions?: Readonly<Record<string, string>>;
}

// The brand that makes a Cursor opaque: it exists only in the types, so no value has it but one a
// sequence gave out.
declare const cursor: unique symbol;

/** A place in an event sequence: the position of the event a delivery carries. It is opaque: an app
 * stores it (in its state, a URL, storage) and passes it back as a read's `after`, and never builds,
 * parses, or compares one. It is a string at runtime, so it serializes as one, and only a cursor
 * that came from the sequence it is passed back to is valid there; the brand keeps any other string
 * from passing for one under tsc. */
export type Cursor = string & { readonly [cursor]: true };

/** One event a read delivers, with the cursor of its place in the sequence. Passing `cursor` back as
 * a later read's `after` resumes the sequence at the next event, with no gap and no duplicate. */
export interface Delivery<T = unknown> {
  readonly event: CloudEvent<T>;
  readonly cursor: Cursor;
}

/** How a read starts, what it delivers, and what ends it. */
export interface ReadOptions {
  /** Where the read starts: absent, at the oldest event the sequence keeps; given, at the event
   * after the one this cursor marks. A cursor whose event the sequence no longer keeps starts at
   * the oldest event it does. A cursor the sequence never gave out fails the read: its iteration
   * rejects with an Error. */
  readonly after?: Cursor;
  /** The event types the read delivers, each matched exactly against an event's `type`; the events
   * of any other type are skipped, their cursors with them. Absent or empty, every type. */
  readonly types?: readonly string[];
  /** Ends the read when it aborts: the iteration finishes, without a rejection, whether it is
   * waiting for an event or not. A signal already aborted delivers nothing. */
  readonly signal?: AbortSignal;
}

/** An append-only sequence of CloudEvents that an app reads. A read delivers events in the
 * sequence's order, each once, from where its options start it, through the events already kept
 * and then each appended while it waits, live, until it ends. It ends when its signal aborts or the
 * consumer stops iterating (a `break` out of its for-await, which calls the iterator's return()),
 * either quietly, and frees what it held. Each read is independent: reads run concurrently, and
 * one ending ends no other. */
export interface EventSequence<T = unknown> {
  /** Reads the sequence, its deliveries an async iterable that runs until the read ends. It fails
   * only as ReadOptions says, and when the sequence itself fails (its connection lost, say), by
   * rejecting the iteration with an Error. */
  read(options?: ReadOptions): AsyncIterable<Delivery<T>>;
}
