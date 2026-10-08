# Roadmap

`sse-wire` ships `M0–M5` as **v0.1** — the SSE parser, the `fetch` transport
(POST / headers / abort), opt-in reconnection with typed events, the tests, and
the docs are all in place. It is the **first** package in a streaming
structured-output suite (the transport step); the parser it feeds is
[`trickle-json`](https://github.com/H1manshu01/trickle-json) and the schema
repair step after that is
[`coerce-json`](https://github.com/H1manshu01/coerce-json).

```
fetch → SSE (sse-wire) → parse partial JSON (trickle-json) → repair/coerce (coerce-json)
```

## M0 — Validate & name ✅
- [x] Competitor scan: native `EventSource`, `@microsoft/fetch-event-source`,
      `eventsource` (npm), `launchdarkly-eventsource`, `sse.js`, framework SSE
      utils (see [COMPETITORS.md](./COMPETITORS.md))
- [x] Confirmed the gap: an `EventSource` can't POST or send headers — which
      every LLM stream needs — and no option combines POST + headers, a
      `for await` API, Node + browser, zero deps, and reconnection that treats a
      clean end as completion
- [x] Named and scoped as the "fetch → SSE" transport step of the pipeline

## M1 — Core SSE parser ✅
- [x] `parseSSE(source, options?)` over any `AsyncIterable<string | Uint8Array>`
      (`src/parse.ts`)
- [x] Wire format: CR / LF / CRLF terminators (incl. a CRLF split across
      chunks), multi-line `data:` joined with `\n`, one-space stripping, comment
      lines, leading-BOM stripping, NUL-in-`id` ignored, numeric `retry:` surfaced
- [x] Buffers across chunk **and** UTF-8 boundaries (streaming `TextDecoder`);
      dispatches a final line with no trailing terminator; a block with no
      `data:` is not dispatched
- [x] Property/fuzz test: splitting a payload at **every** byte offset (and at
      random multi-point splits) matches a single-chunk parse

## M2 — Fetch transport (POST / headers / abort) ✅
- [x] `sse(url, init?)` async generator over `fetch`; forwards method / body /
      headers; auto-sets `accept: text/event-stream` (`src/transport.ts`)
- [x] Non-2xx → `SSEError` with `.status` / `.response` (and the body cancelled);
      missing body → `SSEError`; missing `fetch` → a clear `SSEError`
- [x] `AbortSignal` passed to `fetch`, races each read, and **always cancels the
      reader in a `finally`** — on clean end, early `break`/`return`, abort, or
      error (no leaked readers)
- [x] Injectable `fetch` (default `globalThis.fetch`); reads via
      `response.body.getReader()` so it runs in Node, the browser, and Bun

## M3 — Reconnection + typed events ✅
- [x] Opt-in `reconnect` (`true` or `ReconnectOptions`), **off by default**
- [x] Transport-error-only semantics: a clean stream end is **completion**, not a
      reconnect; only a dropped connection retries
- [x] Resume via `Last-Event-ID` from the last seen event `id`; `lastEventId`
      option for resuming an earlier session on the first request
- [x] Equal-jitter exponential backoff (`maxRetries` / `initialDelay` /
      `maxDelay` / custom `backoff`); a server `retry:` directive becomes the
      backoff base delay; abort cancels a pending reconnect wait
- [x] Generic `SSEEvent<E extends string>` so `event.event` can be typed to a
      known event-name union

## M4 — Tests & size ✅
- [x] Parser unit tests (basic, multi-line, event/id, comments, no-data block,
      space stripping, CR/CRLF, CRLF-split-across-chunks, trailing event,
      `retry:`, NUL-in-`id`, BOM) — `test/parse.test.ts`
- [x] Fuzz parity: every-byte-offset split and random multi-point splits via
      `fast-check`
- [x] Transport tests: header/body forwarding + `accept`, `Last-Event-ID`,
      non-2xx `SSEError`, no-reconnect-by-default, reconnect + resume, `retry:`
      as backoff base, `maxRetries`, abort (reader cancelled), early-break (reader
      cancelled) — `test/transport.test.ts`
- [x] `size-limit` budget on the built `dist/index.js`

## M5 — Docs / CI / release ✅
- [x] README with the problem, quick start, comparison table, pipeline
      positioning, full API (`sse` / `parseSSE` / `json` / `SSEError`), options
      tables, a Reconnection section, a Guardrails section, and a worked
      three-package composition example
- [x] `COMPETITORS.md`, `CHANGELOG.md`, launch post draft
- [x] ESM + CJS + `.d.ts` build (tsup); zero-dependency
- [ ] npm publish with `--provenance` — needs an `NPM_TOKEN` secret and a
      `v0.1.0` tag (owner action)

## Post-1.0 ideas
- **Auto-retry on specific status codes.** Opt-in retry of a non-2xx response
  (e.g. `429`, `503`) with `Retry-After` honored — distinct from the current
  transport-error-only reconnection, which never retries an HTTP error.
- **EventSource-compatible wrapper.** A thin `new PostEventSource(url, init)`
  façade with `addEventListener`/`onmessage` semantics for drop-in replacement of
  the browser built-in, backed by the same `fetch` core.
- **Built-in OpenAI / Anthropic delta helpers.** First-class helpers that peel
  the `choices[0].delta.content` / `content_block_delta` text out of each event,
  so the common LLM case is one import — mirroring `trickle-json`'s provider
  adapters.
- **Backpressure documentation.** A guide on consuming the generator under
  backpressure (slow consumers, `for await` pause semantics) and how it interacts
  with the fetch reader.
- **Richer reconnection telemetry.** An `onReconnect(attempt, delay, error)`
  callback so apps can surface "reconnecting…" UI without wrapping the loop.

## Known trade-offs (document, don't hide)
- **Reconnection is transport-error-only by design.** A clean stream end is
  treated as completion and never reconnects — correct for LLM responses, but if
  your server closes a still-live stream cleanly on purpose, you'd re-open it
  yourself rather than rely on `reconnect`.
- **Requires a global `fetch` + `ReadableStream`.** Node ≥ 18, modern browsers,
  and Bun qualify; older runtimes need a `fetch` injected via the option.
- **No built-in request timeout.** Compose one with `AbortSignal.timeout(ms)` on
  the `signal` option rather than a bespoke timeout flag.
