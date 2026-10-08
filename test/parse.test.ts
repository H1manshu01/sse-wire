import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type SSEEvent, parseSSE } from "../src/parse.js";

async function collect(
  chunks: (string | Uint8Array)[],
  opts?: Parameters<typeof parseSSE>[1],
): Promise<SSEEvent[]> {
  async function* src() {
    for (const c of chunks) yield c;
  }
  const out: SSEEvent[] = [];
  for await (const ev of parseSSE(src(), opts)) out.push(ev);
  return out;
}

describe("SSE parsing", () => {
  it("parses a basic event", async () => {
    expect(await collect(["data: hello\n\n"])).toEqual([{ data: "hello" }]);
  });

  it("joins multi-line data with \\n", async () => {
    expect(await collect(["data: a\ndata: b\ndata: c\n\n"])).toEqual([{ data: "a\nb\nc" }]);
  });

  it("captures event and id fields", async () => {
    expect(await collect(["event: ping\nid: 7\ndata: x\n\n"])).toEqual([
      { event: "ping", id: "7", data: "x" },
    ]);
  });

  it("ignores comments and dispatches on blank line", async () => {
    expect(await collect([": keep-alive\ndata: y\n\n"])).toEqual([{ data: "y" }]);
  });

  it("does not dispatch a block with no data", async () => {
    expect(await collect(["event: ping\n\ndata: z\n\n"])).toEqual([{ data: "z" }]);
  });

  it("strips exactly one leading space after the colon", async () => {
    expect(await collect(["data:  two-spaces\n\n"])).toEqual([{ data: " two-spaces" }]);
  });

  it("handles a value with no space and no colon", async () => {
    expect(await collect(["data\n\n"])).toEqual([{ data: "" }]);
  });

  it("handles CRLF and lone CR line terminators", async () => {
    expect(await collect(["data: a\r\ndata: b\r\n\r\n"])).toEqual([{ data: "a\nb" }]);
    expect(await collect(["data: a\rdata: b\r\r"])).toEqual([{ data: "a\nb" }]);
  });

  it("reassembles a CRLF split across two chunks", async () => {
    expect(await collect(["data: a\r", "\ndata: b\r\n\r\n"])).toEqual([{ data: "a\nb" }]);
  });

  it("dispatches a trailing event with no final blank line", async () => {
    expect(await collect(["data: tail"])).toEqual([{ data: "tail" }]);
  });

  it("invokes onRetry for a numeric retry field", async () => {
    const seen: number[] = [];
    await collect(["retry: 2500\ndata: x\n\n"], { onRetry: (ms) => seen.push(ms) });
    expect(seen).toEqual([2500]);
  });

  it("ignores an id containing a NUL", async () => {
    expect(await collect(["id: a\u0000b\ndata: x\n\n"])).toEqual([{ data: "x" }]);
  });

  it("strips a leading UTF-8 BOM (string input)", async () => {
    expect(await collect(["﻿data: x\n\n"])).toEqual([{ data: "x" }]);
  });
});

describe("chunk-boundary parity (fuzz)", () => {
  const SAMPLE =
    "retry: 1000\n" +
    ": a comment\n" +
    "event: delta\nid: 1\ndata: Hello 🚀\n\n" +
    "data: line one\ndata: naïve café — 日本語\n\n" +
    "event: done\ndata: [DONE]\n\n";

  it("byte-splitting at every offset (incl. mid-UTF-8) matches a single-chunk parse", async () => {
    const bytes = new TextEncoder().encode(SAMPLE);
    const whole = await collect([bytes]);
    expect(whole.length).toBe(3);

    for (let i = 0; i <= bytes.length; i++) {
      const parts = [bytes.slice(0, i), bytes.slice(i)];
      const split = await collect(parts);
      expect(split, `split at byte ${i}`).toEqual(whole);
    }
  });

  it("random multi-point byte splits match the single-chunk parse", async () => {
    const bytes = new TextEncoder().encode(SAMPLE);
    const whole = await collect([bytes]);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: bytes.length }), { maxLength: 8 }),
        async (cuts) => {
          const points = [...new Set(cuts)].sort((a, b) => a - b);
          const parts: Uint8Array[] = [];
          let prev = 0;
          for (const p of points) {
            parts.push(bytes.slice(prev, p));
            prev = p;
          }
          parts.push(bytes.slice(prev));
          expect(await collect(parts)).toEqual(whole);
        },
      ),
      { numRuns: 200 },
    );
  });
});
