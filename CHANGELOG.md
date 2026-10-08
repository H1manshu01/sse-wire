# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/) and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-08

Initial public release — a zero-dependency, fetch-based Server-Sent Events
client with the POST, custom headers, `AbortSignal`, and opt-in reconnection
that the browser's `EventSource` can't do.

### Added
- **`sse(url, init?)`** — a `fetch`-based SSE client returning an
  `AsyncGenerator<SSEEvent>`, consumed with `for await`. Forwards
  method/body/headers to `fetch`, auto-sets `accept: text/event-stream` when
  absent, passes `signal` through to `fetch`, and tracks the last event `id`.
- **`parseSSE(source, options?)`** — the raw parser over any
  `AsyncIterable<string | Uint8Array>`. Handles CR / LF / CRLF terminators
  (including a CRLF split across chunks), multi-line `data:` joined with `\n`,
  one-space stripping after the field colon, comment lines, a leading UTF-8 BOM,
  a NUL-containing `id` (ignored per spec), and a numeric `retry:` directive
  (surfaced via `onRetry`). Buffers across chunk **and** UTF-8 boundaries and
  dispatches a trailing line with no terminator.
- **`json<T>(event)`** — `JSON.parse(event.data)` convenience, typed. Throws on
  non-JSON payloads such as the `[DONE]` sentinel — guard those first.
- **`SSEError`** — thrown on a non-2xx response (carrying `.status` and
  `.response`) or a response with no body. A non-2xx cancels the response body
  before throwing.
- **Opt-in reconnection** (`reconnect: true | ReconnectOptions`, off by
  default): triggers on **transport errors only** — a clean stream end is
  treated as completion and does not reconnect. Resumes via `Last-Event-ID` from
  the last seen event `id`, honors a server `retry:` directive as the backoff
  base delay, and uses equal-jitter exponential backoff by default
  (`maxRetries` 10, `initialDelay` 1000 ms, `maxDelay` 30000 ms, or a custom
  `backoff`).
- **`lastEventId`** option — sent as `Last-Event-ID` on the first request to
  resume an earlier session.
- **Injectable `fetch`** — `fetch` option (default `globalThis.fetch`) for older
  runtimes, tests, or instrumentation. A missing `fetch` throws a clear
  `SSEError`.
- **Abort + cleanup guarantees:** aborting throws the standard `AbortError`
  (or `signal.reason`), cancels the reader, and cancels a pending reconnect
  wait; the reader is always cancelled in a `finally` on clean end, early
  `break`/`return`, abort, or error — no leaked readers.
- **Typed events:** `SSEEvent<E extends string>` so `event.event` can be typed
  to a known event-name union. Exported types `SSEEvent`, `SSEInit`,
  `ReconnectOptions`, `ParseOptions`.

### Verified
- Parser unit tests across the full wire format: basic events, multi-line
  `data:`, `event`/`id` capture, comments, no-`data:` blocks, one-space
  stripping, CR/CRLF, a CRLF split across two chunks, a trailing event with no
  final blank line, `retry:`, NUL-in-`id`, and BOM.
- Property/fuzz parity (`fast-check`): splitting a payload at **every** byte
  offset — including mid-UTF-8 — and at random multi-point splits yields the
  same events as a single-chunk parse.
- Transport tests: header/body forwarding and `accept` default,
  `Last-Event-ID`, non-2xx `SSEError` with status, no-reconnect-by-default,
  reconnect + `Last-Event-ID` resume, a server `retry:` used as the backoff
  base, `maxRetries` exhaustion, abort (reader cancelled), and early-break
  (reader cancelled).
- ESM + CJS builds with type declarations; zero-dependency, under the
  `size-limit` budget.

[0.1.0]: https://github.com/H1manshu01/sse-wire/releases/tag/v0.1.0
