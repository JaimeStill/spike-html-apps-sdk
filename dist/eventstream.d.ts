import type { ServerSentEvent } from "./api.ts";
/** An incremental parser of one event stream. `push` takes each chunk of the body's bytes as it
 * arrives, split anywhere, a UTF-8 sequence or a CRLF included, and returns the events its lines
 * complete; `end` takes the end of the body. One leading BOM is stripped. A line ends at CR, LF, or
 * CRLF. A blank line dispatches the event its fields built, unless its data is empty; a line that
 * begins with ":" is a comment; a line with no ":" is a field with an empty value; and one space
 * after the ":" is stripped from the value. Data lines join with "\n". An `id` holding NUL is
 * ignored, and the last id set carries to every later event, as an EventSource's lastEventId does,
 * until an `id` with an empty value clears it. */
export declare class EventStreamParser {
    #private;
    /** The reconnection time, in ms, that the stream's last valid `retry` field set; undefined when
     * none has. The client makes no reconnection, so it reads none, and the events carry none. */
    retry: number | undefined;
    /** The events that `bytes`, the body's next chunk, completes. */
    push(bytes: Uint8Array): ServerSentEvent[];
    /** The end of the body: any bytes the decoder holds are decoded, and the event a blank line never
     * ended, with the line that never ended, is discarded, as the standard says. Returns the events a
     * line end in that last text completes. */
    end(): ServerSentEvent[];
}
