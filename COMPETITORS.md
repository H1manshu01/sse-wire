# Competitor scan (M0)

Why `post-sse` exists: reading a `text/event-stream` is well-trodden ground, but
the **LLM-streaming** case needs a specific combination — a `POST` with a body
and custom auth headers, an `AbortSignal` you already hold, a `for await`
async-iterable API, Node **and** browser support, zero dependencies, and
reconnection that understands a *clean* stream end means the answer is
**finished** (not a cue to reconnect). Each existing option covers part of that;
the gaps are exactly where LLM streaming lives.

Where a specific detail of a third-party library could have changed, claims are
dated **"as of early 2026"** and kept general rather than invented. Re-check
current behavior against each project before quoting it. The aim here is a fair
map of the space, not a takedown — several of these are excellent at what they
were built for.

---

## Native `EventSource`

**What it does.** The browser (and, since Node 21, Node) built-in for SSE. You
give it a URL; it opens a `GET`, parses the `text/event-stream`, dispatches
`message` / named events via `addEventListener`, and reconnects automatically
with `Last-Event-ID`. Robust, standardized, zero-install.

**What it misses.**
- **GET only, no custom headers.** This is the dealbreaker for LLM APIs: you
  can't `POST` a request body, and you can't set an `Authorization` header. The
  one shape every chat-completions endpoint requires is the one shape
  `EventSource` can't produce. `post-sse` is `fetch`-based, so POST + headers +
  body are first-class.
- **Always-on reconnection.** It reconnects on *any* stream end, including a
  clean one — wrong for an LLM response, where a clean end means the generation
  is complete. `post-sse` reconnects on transport errors **only**, and opt-in.
- **Callback API, `.close()` cancellation.** No async iteration; you wire up
  listeners and call `.close()`. It doesn't integrate with an `AbortSignal` you
  already have from the rest of your request.
- **Runtime availability.** A browser built-in; in Node it only landed as a
  global in Node 21, so Node 18–20 needs a polyfill. `post-sse` runs on Node
  ≥ 18, the browser, and Bun off a global `fetch`.

## `@microsoft/fetch-event-source`

**What it does.** A `fetch`-based SSE client from Microsoft — the well-known
answer to "`EventSource` can't POST." It supports any HTTP method, custom
headers, and a body, exposes `onopen` / `onmessage` / `onclose` / `onerror`
callbacks, and (as of early 2026) handles page-visibility retry. Battle-tested
and widely used.

**What it misses.**
- **Callback API, not async-iterable.** You pass `onmessage` handlers to a
  `fetchEventSource(url, {...})` call; there's no `for await (const event of …)`.
  `post-sse` is an async generator, so it composes with `break`, `try/finally`,
  and the rest of normal control flow.
- **Reconnection is yours to drive.** Retry behavior is expressed by returning a
  delay from `onclose`/`onerror` (or throwing to stop) — flexible, but you own
  the policy and the `Last-Event-ID` bookkeeping. `post-sse` ships an opt-in
  equal-jitter exponential policy that resumes from the last `id` automatically,
  and treats a clean end as completion for you.
- **Scope.** It is deliberately a transport with hooks; the typed
  `SSEEvent<E>` shape, the `json()` convenience, and the explicit
  clean-end-is-done semantics are things you'd layer on yourself.

It's the closest neighbor in spirit. `post-sse` differs mainly in the
async-iterable surface and the batteries-included, LLM-shaped reconnection
defaults.

## `eventsource` (npm polyfill)

**What it does.** The long-standing npm polyfill that implements the
`EventSource` interface for Node (and as a ponyfill for older browsers). Recent
major versions (as of early 2026) are `fetch`-based and do support custom
headers, so it's a common way to get SSE in Node with the familiar
`EventSource` API.

**What it misses.**
- **`EventSource` semantics by design.** It mirrors the spec interface —
  `onmessage`/`addEventListener`, `.close()`, always-on auto-reconnect — so the
  clean-end-reconnects-anyway behavior and the callback model come along with
  it. `post-sse` intentionally departs from the spec surface for an async
  generator and completion-aware reconnection.
- **Request shape leans GET.** Even where headers are supported, the interface
  is built around the `EventSource` model rather than an arbitrary
  `fetch(method, body, headers)` request; POSTing a chat completion isn't its
  ergonomic path.
- **Dependencies / footprint.** As a fuller polyfill it carries more surface (and
  historically transitive deps) than a single-purpose client. `post-sse` is zero
  runtime dependencies and ~1.4 kB min+brotli.
- **No `AbortSignal` integration or typed events.** Cancellation is `.close()`;
  there's no generic event-name typing.

## `launchdarkly-eventsource`

**What it does.** LaunchDarkly's hardened fork of the `eventsource` polyfill,
tuned for long-lived streaming connections in their SDKs — strong reconnection,
backoff, and read-timeout handling, custom headers, and method support (as of
early 2026). Excellent at keeping a persistent event stream alive.

**What it misses.**
- **Built for always-on streams, not request/response completions.** Its model
  is a connection that *should* stay open and be re-established whenever it
  drops. An LLM completion is the opposite: a one-shot stream that ends cleanly
  when the answer is done. `post-sse`'s clean-end-is-completion default matches
  that; a persistent-stream client fights it.
- **`EventSource`-style callback API.** Listener-based with `.close()`, not a
  `for await` generator with `AbortSignal`.
- **Node-oriented and heavier.** It targets server SDK use and inherits the
  polyfill's footprint and dependencies, versus a zero-dep client that runs the
  same code in Node, the browser, and Bun.
- **No typed `SSEEvent<E>` / `json()` niceties.** Those are left to the caller.

## `sse.js`

**What it does.** A small, popular browser library (as of early 2026) that
explicitly set out to fix "`EventSource` can't POST": it lets you set the method,
headers, and payload, and dispatches events via listeners. A focused,
lightweight single-file option.

**What it misses.**
- **Browser-focused.** It's built around browser globals and the
  `EventSource`-like listener API; it isn't a Node/Bun story the way a
  `fetch`-based client is. `post-sse` runs the same code across all three.
- **Callback API, manual reconnection.** No async iteration, no built-in
  completion-aware reconnection with `Last-Event-ID` resume or equal-jitter
  backoff.
- **Typing.** Not designed around a generic, typed event shape.

`post-sse` shares its core motivation (POST + headers) but targets the
cross-runtime, async-iterable, typed, reconnection-included niche.

## Framework SSE utilities (brief)

**What they do.** Many frameworks and AI SDKs ship their own SSE helpers — e.g.
server-side `EventStream`/`text/event-stream` responders, and client helpers
baked into AI SDKs (parse-and-dispatch a provider's stream). As of early 2026
these are convenient when you're already in that framework.

**What they miss — and why the niche survives.** They're **coupled** to their
framework or SDK: a server-side responder isn't a client at all, and an SDK's
client helper is tied to that SDK's request lifecycle and provider shapes. None
is a standalone, zero-dependency, `fetch`-based SSE client you can drop into any
pipeline — streaming, batch, a mock in a test, or a non-LLM `text/event-stream`.
`post-sse` is that pure, framework-agnostic transport, and it hands clean events
to the rest of the suite ([`trickle-json`](https://github.com/H1manshu01/trickle-json)
then [`coerce-json`](https://github.com/H1manshu01/coerce-json)) regardless of
where the request originated.

---

## The gap, in one line

| Capability | post-sse | native `EventSource` | `@microsoft/fetch-event-source` | `eventsource` (npm) | `launchdarkly-eventsource` | `sse.js` |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| POST + custom headers | ✅ | — | ✅ | ⚠️ | ✅ | ✅ |
| `AbortSignal` cancellation | ✅ | ⚠️ `.close()` | ✅ | ⚠️ `.close()` | ⚠️ `.close()` | ⚠️ `.close()` |
| `for await` async-iterable API | ✅ | — | — | — | — | — |
| Opt-in reconnection, clean end = done | ✅ | — (always-on) | ⚠️ manual | — (always-on) | — (always-on) | ⚠️ manual |
| `Last-Event-ID` resume | ✅ | ✅ | ⚠️ manual | ✅ | ✅ | ⚠️ manual |
| Node **and** browser (+ Bun) | ✅ | ⚠️ Node 21+ | ✅ | ⚠️ | ⚠️ | ⚠️ browser |
| Zero runtime dependencies | ✅ | n/a | ✅ | ⚠️ | ⚠️ | ✅ |
| Typed events (`SSEEvent<E>`) | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |

`post-sse` is the row that is POST-capable, async-iterable, cross-runtime,
zero-dependency, typed, and reconnects **only** on a real transport error — the
exact shape an LLM stream needs.
