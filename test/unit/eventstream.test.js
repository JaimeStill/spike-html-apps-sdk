// The event-stream parser, against the WHATWG HTML standard's event-stream format: a sample stream
// split at every byte boundary, and each rule of the format on its own. The parser is internal, so
// the suite imports the built module by its path in dist/, which mise run build wrote, never by an
// export the package means.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { EventStreamParser } from "../../dist/eventstream.js";

const encoder = new TextEncoder();

/** The events a fresh parser dispatches over `chunks` (strings encoded, or bytes), and the parser. */
function parse(...chunks) {
  const parser = new EventStreamParser();
  const events = [];
  for (const chunk of chunks) {
    events.push(...parser.push(typeof chunk === "string" ? encoder.encode(chunk) : chunk));
  }
  events.push(...parser.end());
  return { events, parser };
}

// Every rule at once: a BOM, CRLF, CR, and LF line ends, a comment, multi-line data, multi-byte
// UTF-8, a field with no ":", an id that carries and one that clears, an id with NUL, retry, an
// event with no data, and an event a blank line never ends.
const sample = [
  "\uFEFF: a comment\r\n",
  "event: greeting\r\ndata: héllo\r\ndata: wörld 🌍\r\nid: 1\r\n\r\n",
  "data:no space\rdata:  two spaces\r\r",
  "retry: 3000\nid\ndata\n\n",
  "event: dropped\n\n",
  "data: after\n\n",
  "id: a\0b\ndata: nul\nretry: 12a\n\n",
  "data: unterminated\n",
].join("");

const expected = [
  { type: "greeting", data: "héllo\nwörld 🌍", id: "1" },
  { type: "message", data: "no space\n two spaces", id: "1" },
  { type: "message", data: "" },
  { type: "message", data: "after" },
  { type: "message", data: "nul" },
];

describe("the sample stream", () => {
  const bytes = encoder.encode(sample);

  test("parses whole", () => {
    const { events, parser } = parse(bytes);
    assert.deepEqual(events, expected);
    assert.equal(parser.retry, 3000);
  });

  test("parses the same split at every byte boundary", () => {
    for (let at = 0; at <= bytes.length; at++) {
      const { events } = parse(bytes.subarray(0, at), bytes.subarray(at));
      assert.deepEqual(events, expected, `split at byte ${at}`);
    }
  });

  test("parses the same a byte at a time", () => {
    const { events, parser } = parse(...Array.from(bytes, (byte) => Uint8Array.of(byte)));
    assert.deepEqual(events, expected);
    assert.equal(parser.retry, 3000);
  });
});

describe("the format's rules", () => {
  for (const [name, end] of [
    ["LF", "\n"],
    ["CR", "\r"],
    ["CRLF", "\r\n"],
  ]) {
    test(`${name} ends a line`, () => {
      const { events } = parse(`data: a${end}data: b${end}${end}data: c${end}${end}`);
      assert.deepEqual(events, [
        { type: "message", data: "a\nb" },
        { type: "message", data: "c" },
      ]);
    });
  }

  test("a CRLF split across chunks is one line end, not a line and a blank", () => {
    assert.deepEqual(parse("data: a\r", "\ndata: b\r\n\r\n").events, [
      { type: "message", data: "a\nb" },
    ]);
    assert.deepEqual(parse("data: a\r", "\n", "\n").events, [{ type: "message", data: "a" }]);
  });

  test("a leading BOM is stripped, even split across chunks", () => {
    const bom = encoder.encode("\uFEFFdata: x\n\n");
    assert.deepEqual(parse(bom).events, [{ type: "message", data: "x" }]);
    assert.deepEqual(parse(bom.subarray(0, 1), bom.subarray(1, 2), bom.subarray(2)).events, [
      { type: "message", data: "x" },
    ]);
  });

  test("only a leading BOM: a later one is part of the line", () => {
    // A BOM then "data" names no field the format knows, so the second event has no data.
    assert.deepEqual(parse("\uFEFFdata: x\n\n", "\uFEFFdata: y\n\n").events, [
      { type: "message", data: "x" },
    ]);
  });

  test("a line beginning with : is a comment", () => {
    assert.deepEqual(parse(":keep-alive\n: data: no\ndata: yes\n\n").events, [
      { type: "message", data: "yes" },
    ]);
  });

  test("data lines join with \\n", () => {
    assert.deepEqual(parse("data: 1\ndata: 2\ndata: 3\n\n").events, [
      { type: "message", data: "1\n2\n3" },
    ]);
  });

  test("one space after the : is stripped, and only one", () => {
    assert.deepEqual(parse("data:a\n\ndata: b\n\ndata:  c\n\n").events, [
      { type: "message", data: "a" },
      { type: "message", data: "b" },
      { type: "message", data: " c" },
    ]);
  });

  test("a field with no : has an empty value", () => {
    assert.deepEqual(parse("data\ndata\n\n").events, [{ type: "message", data: "\n" }]);
    assert.deepEqual(parse("event: x\nevent\ndata: d\n\n").events, [
      { type: "message", data: "d" },
    ]);
  });

  test("an event with empty data isn't dispatched, and its type doesn't carry", () => {
    assert.deepEqual(parse("event: x\nid: 1\n\ndata: d\n\n").events, [
      { type: "message", data: "d", id: "1" },
    ]);
  });

  test("an unknown field is ignored", () => {
    assert.deepEqual(parse("foo: bar\ndata: d\n\n").events, [{ type: "message", data: "d" }]);
  });

  test("an id carries to later events until an empty id clears it", () => {
    assert.deepEqual(parse("id: 7\ndata: a\n\ndata: b\n\nid:\ndata: c\n\n").events, [
      { type: "message", data: "a", id: "7" },
      { type: "message", data: "b", id: "7" },
      { type: "message", data: "c" },
    ]);
  });

  test("an id holding NUL is ignored", () => {
    assert.deepEqual(parse("id: 1\ndata: a\n\nid: 2\0\ndata: b\n\n").events, [
      { type: "message", data: "a", id: "1" },
      { type: "message", data: "b", id: "1" },
    ]);
  });

  test("retry sets the reconnection time when its value is ASCII digits, and is ignored otherwise", () => {
    assert.equal(parse("retry: 1500\n").parser.retry, 1500);
    assert.equal(parse("retry: 1500\nretry: 1.5\nretry: -1\nretry:\n").parser.retry, 1500);
    assert.equal(parse("retry: soon\n").parser.retry, undefined);
  });

  test("an event a blank line never ends is discarded at the end of the stream", () => {
    assert.deepEqual(parse("data: a\n\ndata: b\n").events, [{ type: "message", data: "a" }]);
    assert.deepEqual(parse("data: a\n\ndata: b").events, [{ type: "message", data: "a" }]);
  });

  test("a UTF-8 sequence split across chunks decodes whole", () => {
    const bytes = encoder.encode("data: 🌍\n\n");
    assert.deepEqual(parse(bytes.subarray(0, 8), bytes.subarray(8)).events, [
      { type: "message", data: "🌍" },
    ]);
  });
});
