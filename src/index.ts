/**
 * sse-wire — a zero-dependency, fetch-based Server-Sent Events client.
 *
 * The POST + headers + reconnection that the browser's `EventSource` can't do,
 * for Node 18+ and the browser. The step before a partial-JSON parser
 * (trickle-json) in a streaming structured-output pipeline:
 *
 *   fetch → **SSE (sse-wire)** → parse partial JSON (trickle-json) → repair/coerce (coerce-json)
 *
 * ```ts
 * import { sse } from "sse-wire";
 *
 * for await (const event of sse(url, { method: "POST", headers, body })) {
 *   // event: { event?, data, id? }
 * }
 * ```
 */
export { parseSSE } from "./parse.js";
export type { ParseOptions, SSEEvent } from "./parse.js";
export { SSEError, sse } from "./transport.js";
export type { ReconnectOptions, SSEInit } from "./transport.js";

import type { SSEEvent } from "./parse.js";

/**
 * Parse an event's `data` as JSON. Convenience for the common case where each
 * SSE event carries a JSON chunk (OpenAI/Anthropic deltas). Throws if `data`
 * is not valid JSON (e.g. a `[DONE]` sentinel) — guard those first.
 */
export function json<T = unknown>(event: SSEEvent): T {
  return JSON.parse(event.data) as T;
}
