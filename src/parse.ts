/**
 * A tiny, zero-dependency Server-Sent Events (`text/event-stream`) parser.
 *
 * Turns a stream of text/byte chunks (e.g. `response.body`) into discrete
 * events, buffering across chunk boundaries so a split mid-line — or
 * mid-UTF-8-sequence — is handled correctly. Line terminators may be CR, LF,
 * or CRLF, per the SSE spec, including a CRLF split across two chunks.
 *
 * Extracted and hardened from trickle-json's internal SSE parser.
 */

export interface SSEEvent<E extends string = string> {
  /** The `event:` field, if present. */
  event?: E;
  /** The joined `data:` payload (multiple `data:` lines joined with "\n"). */
  data: string;
  /** The `id:` field, if present. */
  id?: string;
}

export interface ParseOptions {
  /** Called when the server sends a `retry:` directive (reconnection time, ms). */
  onRetry?: (retryMs: number) => void;
}

/** Parse a stream of chunks into SSE events. */
export async function* parseSSE<E extends string = string>(
  source: AsyncIterable<string | Uint8Array>,
  options: ParseOptions = {},
): AsyncGenerator<SSEEvent<E>> {
  const decoder = new TextDecoder();
  let buf = "";
  let bomChecked = false;

  let dataLines: string[] = [];
  let eventName: string | undefined;
  let id: string | undefined;
  let hasData = false;

  const take = (): SSEEvent<E> | null => {
    if (!hasData) {
      // A block with no `data:` is not dispatched (per spec); reset fields.
      eventName = undefined;
      id = undefined;
      dataLines = [];
      return null;
    }
    const ev = { data: dataLines.join("\n") } as SSEEvent<E>;
    if (eventName !== undefined) ev.event = eventName as E;
    if (id !== undefined) ev.id = id;
    dataLines = [];
    eventName = undefined;
    id = undefined;
    hasData = false;
    return ev;
  };

  const handleLine = (line: string): SSEEvent<E> | null => {
    if (line === "") return take(); // blank line dispatches the event
    if (line.startsWith(":")) return null; // comment
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        dataLines.push(value);
        hasData = true;
        break;
      case "event":
        eventName = value;
        break;
      case "id":
        // Per spec, an id containing a NUL is ignored.
        if (!value.includes("\u0000")) id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) options.onRetry?.(Number(value));
        break;
    }
    return null;
  };

  const maybeStripBom = () => {
    if (!bomChecked && buf.length > 0) {
      if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
      bomChecked = true;
    }
  };

  // Emit every complete line currently in `buf`. When not `final`, a trailing
  // "\r" at the very end is left buffered — it may be the first half of a CRLF
  // arriving in the next chunk.
  function* drain(final: boolean): Generator<SSEEvent<E>> {
    while (buf.length > 0) {
      const r = buf.indexOf("\r");
      const n = buf.indexOf("\n");
      if (r === -1 && n === -1) break;

      let idx: number;
      let skip: number;
      if (r === -1 || (n !== -1 && n < r)) {
        idx = n;
        skip = 1;
      } else if (r === buf.length - 1) {
        if (!final) break; // might be the CR of a CRLF split across chunks
        idx = r;
        skip = 1;
      } else if (buf[r + 1] === "\n") {
        idx = r;
        skip = 2;
      } else {
        idx = r;
        skip = 1;
      }

      const line = buf.slice(0, idx);
      buf = buf.slice(idx + skip);
      const ev = handleLine(line);
      if (ev) yield ev;
    }
  }

  for await (const chunk of source) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    maybeStripBom();
    yield* drain(false);
  }

  // Flush any bytes held by the decoder, then any complete trailing lines.
  buf += decoder.decode();
  maybeStripBom();
  yield* drain(true);

  // A final line with no terminator, then dispatch a dangling event.
  if (buf.length > 0) {
    const ev = handleLine(buf);
    buf = "";
    if (ev) yield ev;
  }
  const last = take();
  if (last) yield last;
}
