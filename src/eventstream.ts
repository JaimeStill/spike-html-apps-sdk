// The application SDK's event-stream parser: the bytes of a text/event-stream body to the events it
// dispatches, by the WHATWG HTML standard's "Parsing an event stream" and "Interpreting an event
// stream" (§9.2.5–9.2.6), written here so the SDK takes no dependency for it. It is internal: the
// client's stream reads a response through it, and an app reads the events stream resolves to,
// never this module, which package.json's exports pattern reaches only because it reaches every
// built module.

import type { ServerSentEvent } from "./api.ts";

/** An incremental parser of one event stream. `push` takes each chunk of the body's bytes as it
 * arrives, split anywhere, a UTF-8 sequence or a CRLF included, and returns the events its lines
 * complete; `end` takes the end of the body. One leading BOM is stripped. A line ends at CR, LF, or
 * CRLF. A blank line dispatches the event its fields built, unless its data is empty; a line that
 * begins with ":" is a comment; a line with no ":" is a field with an empty value; and one space
 * after the ":" is stripped from the value. Data lines join with "\n". An `id` holding NUL is
 * ignored, and the last id set carries to every later event, as an EventSource's lastEventId does,
 * until an `id` with an empty value clears it. */
export class EventStreamParser {
  // ignoreBOM keeps the BOM in the text, so the parser strips it itself, as the standard says.
  #decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  // Whether any text has arrived, so a BOM is stripped only at the stream's start.
  #started = false;
  // The text after the last line end, a line not yet ended.
  #line = "";
  // Whether the last text ended with CR, so an LF that begins the next is that CRLF's end.
  #cr = false;
  #type = "";
  #data = "";
  #id = "";

  /** The reconnection time, in ms, that the stream's last valid `retry` field set; undefined when
   * none has. The client makes no reconnection, so it reads none, and the events carry none. */
  retry: number | undefined;

  /** The events that `bytes`, the body's next chunk, completes. */
  push(bytes: Uint8Array): ServerSentEvent[] {
    return this.#text(this.#decoder.decode(bytes, { stream: true }));
  }

  /** The end of the body: any bytes the decoder holds are decoded, and the event a blank line never
   * ended, with the line that never ended, is discarded, as the standard says. Returns the events a
   * line end in that last text completes. */
  end(): ServerSentEvent[] {
    const events = this.#text(this.#decoder.decode());
    this.#line = "";
    this.#type = "";
    this.#data = "";
    return events;
  }

  #text(chunk: string): ServerSentEvent[] {
    let text = chunk;
    if (!this.#started && text.length > 0) {
      this.#started = true;
      if (text.startsWith("\uFEFF")) text = text.slice(1);
    }
    if (text.length > 0) {
      if (this.#cr && text.startsWith("\n")) text = text.slice(1);
      this.#cr = false;
    }
    const events: ServerSentEvent[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c !== "\r" && c !== "\n") continue;
      this.#field(this.#line + text.slice(start, i), events);
      this.#line = "";
      if (c === "\r") {
        if (i + 1 === text.length) this.#cr = true;
        else if (text[i + 1] === "\n") i++;
      }
      start = i + 1;
    }
    this.#line += text.slice(start);
    return events;
  }

  /** One line: a blank line dispatches, a comment is ignored, and any other sets its field. */
  #field(line: string, events: ServerSentEvent[]): void {
    if (line === "") {
      this.#dispatch(events);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (name) {
      case "event":
        this.#type = value;
        break;
      case "data":
        this.#data += `${value}\n`;
        break;
      case "id":
        if (!value.includes("\0")) this.#id = value;
        break;
      case "retry":
        if (/^[0-9]+$/.test(value)) this.retry = Number(value);
        break;
      // Any other field is ignored.
    }
  }

  /** The event the fields built, unless its data is empty, and the buffers reset for the next. The
   * last id isn't reset: it carries. */
  #dispatch(events: ServerSentEvent[]): void {
    if (this.#data !== "") {
      const event: ServerSentEvent = {
        type: this.#type || "message",
        data: this.#data.slice(0, -1),
      };
      if (this.#id !== "") event.id = this.#id;
      events.push(event);
    }
    this.#type = "";
    this.#data = "";
  }
}
