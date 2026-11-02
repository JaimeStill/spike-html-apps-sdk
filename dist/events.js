// The application SDK's event-sequence interface: a CloudEvent, the opaque cursor that marks a place
// in a sequence, and the sequence an app reads, from its oldest kept event or from after a cursor,
// live as events are appended. It is the contract only, types and the one error a read's start
// rejects with, with no dependency: an implementation (the NATS adapter, a test's in-memory
// sequence) meets the semantics its doc comments state.
/** The error a read rejects with when its start cursor, `after`, is one the sequence can tell it
 * never gave out: the NATS adapter knows a cursor that isn't a sequence number, or one past the
 * stream's last event. A cursor stored before the stream was recreated, and at or below the new
 * stream's last event, looks like one it gave out, and the read resumes after it; no adapter here
 * detects a recreated stream. Reading again from an unknown cursor fails the same way, so an app
 * that holds it forgets it and reads from the oldest event. `cursor` is the `after` the read was
 * given. It is the one error the contract names: every other failure of a read is a plain Error. */
export class UnknownCursorError extends Error {
    cursor;
    /** An UnknownCursorError for `cursor`, its message `message`, by default one that names the
     * cursor. */
    constructor(cursor, message = `the sequence gave out no cursor ${JSON.stringify(cursor)}`) {
        super(message);
        this.name = "UnknownCursorError";
        this.cursor = cursor;
    }
}
