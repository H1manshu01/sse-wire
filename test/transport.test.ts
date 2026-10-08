import { describe, expect, it } from "vitest";
import { type SSEEvent, sse } from "../src/index.js";

const URL = "https://api.example.com/v1/stream";

interface Step {
  chunk?: string;
  error?: unknown;
}

/** A ReadableStream that emits one scripted step per read, then closes. */
function scriptedStream(steps: Step[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= steps.length) {
        c.close();
        return;
      }
      const s = steps[i++]!;
      if (s.error !== undefined) c.error(s.error);
      else c.enqueue(enc.encode(s.chunk ?? ""));
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** A ReadableStream that emits `chunk` forever (until cancelled). */
function infiniteStream(chunk: string, onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(c) {
      c.enqueue(enc.encode(chunk));
    },
    cancel() {
      onCancel?.();
    },
  });
}

function resp(stream: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    ...init,
  });
}

function mockFetch(thunks: Array<() => Response>) {
  const calls: Array<{ url: unknown; init: RequestInit }> = [];
  const fn = (async (url: unknown, init: RequestInit) => {
    calls.push({ url, init });
    const make = thunks[Math.min(calls.length - 1, thunks.length - 1)]!;
    return make();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

async function drain<E extends string>(gen: AsyncGenerator<SSEEvent<E>>): Promise<SSEEvent<E>[]> {
  const out: SSEEvent<E>[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("sse() transport", () => {
  it("forwards method, body, and headers, and sets accept", async () => {
    const { fn, calls } = mockFetch([() => resp(scriptedStream([{ chunk: "data: hi\n\n" }]))]);
    const events = await drain(
      sse(URL, {
        method: "POST",
        headers: { authorization: "Bearer k", "content-type": "application/json" },
        body: "{}",
        fetch: fn,
      }),
    );
    expect(events).toEqual([{ data: "hi" }]);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe("{}");
    const h = new Headers(calls[0]!.init.headers);
    expect(h.get("authorization")).toBe("Bearer k");
    expect(h.get("accept")).toBe("text/event-stream");
  });

  it("sends lastEventId as Last-Event-ID on the first request", async () => {
    const { fn, calls } = mockFetch([() => resp(scriptedStream([{ chunk: "data: x\n\n" }]))]);
    await drain(sse(URL, { fetch: fn, lastEventId: "42" }));
    expect(new Headers(calls[0]!.init.headers).get("last-event-id")).toBe("42");
  });

  it("throws SSEError with the status on a non-2xx response", async () => {
    const { fn } = mockFetch([
      () => resp(scriptedStream([]), { status: 500, statusText: "Server Error" }),
    ]);
    await expect(drain(sse(URL, { fetch: fn }))).rejects.toMatchObject({
      name: "SSEError",
      status: 500,
    });
  });

  it("does not reconnect by default (clean end completes)", async () => {
    const { fn, calls } = mockFetch([() => resp(scriptedStream([{ chunk: "data: a\n\n" }]))]);
    expect(await drain(sse(URL, { fetch: fn }))).toEqual([{ data: "a" }]);
    expect(calls.length).toBe(1);
  });

  it("reconnects on a transport error and resumes from Last-Event-ID", async () => {
    const { fn, calls } = mockFetch([
      () => resp(scriptedStream([{ chunk: "id: 1\ndata: a\n\n" }, { error: new Error("drop") }])),
      () => resp(scriptedStream([{ chunk: "data: b\n\n" }])),
    ]);
    const events = await drain(sse(URL, { fetch: fn, reconnect: { backoff: () => 0 } }));
    expect(events).toEqual([{ id: "1", data: "a" }, { data: "b" }]);
    expect(calls.length).toBe(2);
    expect(new Headers(calls[1]!.init.headers).get("last-event-id")).toBe("1");
  });

  it("honors a server retry: directive as the backoff base delay", async () => {
    let baseSeen = -1;
    const { fn } = mockFetch([
      () =>
        resp(
          scriptedStream([
            { chunk: "retry: 777\nid: 9\ndata: a\n\n" },
            { error: new Error("drop") },
          ]),
        ),
      () => resp(scriptedStream([{ chunk: "data: b\n\n" }])),
    ]);
    await drain(
      sse(URL, {
        fetch: fn,
        reconnect: {
          backoff: (_attempt, base) => {
            baseSeen = base;
            return 0;
          },
        },
      }),
    );
    expect(baseSeen).toBe(777);
  });

  it("gives up after maxRetries", async () => {
    const err = () => resp(scriptedStream([{ error: new Error("drop") }]));
    const { fn, calls } = mockFetch([err, err, err, err]);
    await expect(
      drain(sse(URL, { fetch: fn, reconnect: { maxRetries: 2, backoff: () => 0 } })),
    ).rejects.toThrow("drop");
    expect(calls.length).toBe(3); // initial + 2 retries
  });

  it("aborts: throws AbortError and cancels the reader (no leak)", async () => {
    let cancelled = false;
    const controller = new AbortController();
    const onCancel = () => {
      cancelled = true;
    };
    const { fn } = mockFetch([() => resp(infiniteStream("data: x\n\n", onCancel))]);
    const gen = sse(URL, { fetch: fn, signal: controller.signal });

    const first = await gen.next();
    expect(first.value).toEqual({ data: "x" });

    controller.abort();
    await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toBe(true);
  });

  it("cancels the reader when the consumer breaks early (no leak)", async () => {
    let cancelled = false;
    const onCancel = () => {
      cancelled = true;
    };
    const { fn } = mockFetch([() => resp(infiniteStream("data: x\n\n", onCancel))]);
    const gen = sse(URL, { fetch: fn });
    await gen.next();
    await gen.return(undefined);
    expect(cancelled).toBe(true);
  });
});
