/**
 * `sse()` — a fetch-based Server-Sent Events client.
 *
 * Does what the browser's `EventSource` refuses to: POST, custom headers, a
 * request body, and `AbortSignal` cancellation. Works in Node 18+ and the
 * browser. Reconnection (with `Last-Event-ID` resume and backoff) is opt-in.
 */
import { type ParseOptions, type SSEEvent, parseSSE } from "./parse.js";

export interface ReconnectOptions {
  /** Max reconnect attempts after a transport error. Default 10. */
  maxRetries?: number;
  /** Base delay (ms) before the first retry; overridden by a server `retry:`. Default 1000. */
  initialDelay?: number;
  /** Ceiling (ms) for the backoff delay. Default 30000. */
  maxDelay?: number;
  /** Custom backoff. Receives the 0-based attempt and the current base delay; returns ms. */
  backoff?: (attempt: number, baseDelay: number) => number;
}

export interface SSEInit extends Omit<RequestInit, "signal"> {
  /** Abort the request (and any pending reconnect) — standard `AbortSignal`. */
  signal?: AbortSignal | null;
  /** Opt-in reconnection: `true` for defaults, or an options object. Off by default. */
  reconnect?: boolean | ReconnectOptions;
  /** Resume from this id on the first request (sent as `Last-Event-ID`). */
  lastEventId?: string;
  /** Inject a custom `fetch` (default: `globalThis.fetch`). */
  fetch?: typeof fetch;
}

/** Thrown when the server responds with a non-2xx status or has no body. */
export class SSEError extends Error {
  readonly status?: number;
  readonly response?: Response;
  constructor(message: string, opts?: { status?: number; response?: Response }) {
    super(message);
    this.name = "SSEError";
    this.status = opts?.status;
    this.response = opts?.response;
  }
}

interface NormReconnect {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoff?: (attempt: number, baseDelay: number) => number;
}

function normalizeReconnect(r: SSEInit["reconnect"]): NormReconnect | null {
  if (!r) return null;
  const o = r === true ? {} : r;
  return {
    maxRetries: o.maxRetries ?? 10,
    initialDelay: o.initialDelay ?? 1000,
    maxDelay: o.maxDelay ?? 30000,
    backoff: o.backoff,
  };
}

function abortError(signal?: AbortSignal | null): unknown {
  return signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function isAbort(err: unknown, signal?: AbortSignal | null): boolean {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === "AbortError");
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function nextDelay(cfg: NormReconnect, attempt: number, base: number): number {
  if (cfg.backoff) return cfg.backoff(attempt, base);
  const exp = Math.min(base * 2 ** attempt, cfg.maxDelay);
  // Equal-jitter: half fixed, half random, to avoid reconnect thundering herds.
  return exp / 2 + Math.random() * (exp / 2);
}

/** Reject `p` if `signal` aborts first; otherwise settle with `p`. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      },
    );
  });
}

/**
 * Read a web `ReadableStream` as an async iterable. Aborting surfaces as a
 * thrown `AbortError`, and the reader is always cancelled on exit (clean end,
 * early break, or error) so the underlying connection is never leaked.
 */
async function* streamToIterable(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal | null,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      const read = reader.read();
      const { done, value } = signal ? await raceAbort(read, signal) : await read;
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * Open an SSE stream over `fetch` and yield `{ event, data, id }` events.
 *
 * ```ts
 * const stream = sse("https://api.example.com/v1/chat", {
 *   method: "POST",
 *   headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
 *   body: JSON.stringify({ stream: true, messages }),
 *   signal: controller.signal,
 * });
 * for await (const event of stream) {
 *   if (event.data === "[DONE]") break;
 *   handle(JSON.parse(event.data));
 * }
 * ```
 */
export async function* sse<E extends string = string>(
  url: string | URL,
  init: SSEInit = {},
): AsyncGenerator<SSEEvent<E>> {
  const {
    reconnect,
    lastEventId,
    fetch: fetchImpl = globalThis.fetch,
    signal,
    headers,
    ...rest
  } = init;

  if (typeof fetchImpl !== "function") {
    throw new SSEError(
      "No fetch implementation found (pass `fetch` in options on older runtimes).",
    );
  }

  const cfg = normalizeReconnect(reconnect);
  let lastId = lastEventId;
  let retryMs = cfg?.initialDelay ?? 1000;
  let attempt = 0;

  const parseOpts: ParseOptions = {
    onRetry: (ms) => {
      retryMs = ms;
    },
  };

  while (true) {
    if (signal?.aborted) throw abortError(signal);

    const h = new Headers(headers);
    if (!h.has("accept")) h.set("accept", "text/event-stream");
    if (lastId !== undefined) h.set("last-event-id", lastId);

    let response: Response;
    try {
      response = await fetchImpl(url, { ...rest, headers: h, signal: signal ?? undefined });
    } catch (err) {
      if (isAbort(err, signal) || !cfg || attempt >= cfg.maxRetries) throw err;
      await sleep(nextDelay(cfg, attempt++, retryMs), signal);
      continue;
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new SSEError(`SSE request failed: ${response.status} ${response.statusText}`, {
        status: response.status,
        response,
      });
    }
    if (!response.body) {
      throw new SSEError("SSE response has no body to stream.");
    }

    try {
      const src = streamToIterable(response.body, signal);
      for await (const ev of parseSSE<E>(src, parseOpts)) {
        if (ev.id !== undefined) lastId = ev.id;
        yield ev;
      }
      // The stream ended cleanly — for an LLM response that means completion.
      return;
    } catch (err) {
      if (isAbort(err, signal) || !cfg || attempt >= cfg.maxRetries) throw err;
      await sleep(nextDelay(cfg, attempt++, retryMs), signal);
      // continue → reconnect, resuming from `lastId` via Last-Event-ID.
    }
  }
}
