---
title: "EventSource can't POST. Your LLM stream needs it to."
published: false
description: "The browser's EventSource only does GET, with no custom headers — and every LLM streaming endpoint wants a POST with an Authorization header and a JSON body. Here's post-sse: a zero-dependency, fetch-based SSE client you consume with for await, that aborts without leaking a reader and reconnects only when the connection actually drops."
tags: javascript, typescript, ai, opensource
cover_image: https://raw.githubusercontent.com/H1manshu01/post-sse/main/assets/cover.png
series: "Streaming structured output"
canonical_url: https://dev.to/h1manshu01/eventsource-cant-post-your-llm-stream-needs-it-to
---

You want to stream a chat completion. The response is a `text/event-stream`, so
the browser's built-in `EventSource` seems like the obvious tool:

```ts
const es = new EventSource("https://api.openai.com/v1/chat/completions");
```

Except that line can't work, and not for a small reason. `EventSource` can only
issue a **GET**, and it **can't set a single header**. The chat-completions
endpoint needs the exact opposite: a `POST`, an `Authorization: Bearer …`
header, and a JSON body with your messages. The one tool the platform gives you
for SSE is structurally incapable of making an LLM request.

So you drop to `fetch` — and now you own the parser:

```ts
const res = await fetch(url, { method: "POST", headers, body });
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buf = "";
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  // now split on \n\n... or was it \r\n\r\n? what about a \r\n split
  // across two chunks? and a multibyte character split mid-sequence?
  // and when I break early, did I cancel the reader, or leak the connection?
}
```

Every one of those comments is a real bug people ship. This is the part of every
streaming integration nobody writes a blog post about. Let's fix it properly.

## The usual options (and where they hurt)

**1. Native `EventSource`.** GET only, no headers — a non-starter for LLM APIs.
And when it *does* work, it reconnects on **any** stream end, including a clean
one. For an LLM response that's wrong: a clean end means the model *finished*.

**2. `@microsoft/fetch-event-source`.** The well-known "fetch SSE that can POST."
Genuinely good — but it's a callback API (`onmessage`, `onclose`), and you drive
the reconnection policy and the `Last-Event-ID` bookkeeping yourself.

**3. Polyfills — `eventsource`, `launchdarkly-eventsource`.** These bring the
`EventSource` *interface* to Node. That's the catch: you inherit the callback
model, `.close()` cancellation, and always-on reconnection — the semantics built
for a persistent stream that *should* reconnect, not a one-shot completion that
ends when the answer is done.

The common thread: either you can't POST, or you get a callback API with
reconnection tuned for the wrong shape of stream.

## post-sse

[`post-sse`](https://www.npmjs.com/package/post-sse) is a zero-dependency,
`fetch`-based SSE client you consume with `for await`:

```ts
import { sse } from "post-sse";

const controller = new AbortController();

for await (const event of sse("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ model, stream: true, messages }),
  signal: controller.signal,
})) {
  if (event.data === "[DONE]") break;      // provider sentinel — not JSON
  const delta = JSON.parse(event.data);     // { event?, data, id? }
  render(delta);
}
```

That's the whole surface for the common case. Three things make it pull its
weight:

- **It POSTs with headers.** It's `fetch` underneath, so method, body, and
  headers are first-class. It auto-sets `accept: text/event-stream` if you
  didn't, and passes your `signal` straight through — so the `AbortController`
  you already have cancels the request *and* the stream.
- **It's an async generator.** `for await (const event of sse(...))`. `break`
  when you hit `[DONE]`, wrap it in `try/finally`, compose it like any other
  iterable. No listener wiring, no `.close()`.
- **A clean end means done.** When the stream closes normally, the loop ends —
  because the model finished. It does **not** silently reconnect and re-request a
  completed generation.

### Cancellation that doesn't leak

Abort, and `post-sse` throws the standard `AbortError`, cancels the in-flight
`fetch`, and cancels the stream reader. Same if you just `break` out of the loop
early — the reader is cancelled in a `finally`, so the connection is never left
dangling. It's covered by tests that assert the reader's `cancel()` actually ran
on abort *and* on early break.

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000); // or AbortSignal.timeout(5_000)
```

### Reconnection, only when it's real

Reconnection is **opt-in** and fires on **transport errors only** — a dropped
connection mid-answer, never a clean end:

```ts
for await (const event of sse(url, { method: "POST", headers, body, reconnect: true })) {
  handle(event);
}
```

When the connection actually drops, it waits an equal-jitter exponential backoff
(a server `retry:` directive becomes the base delay), re-issues the request with
`Last-Event-ID` set to the last event it saw, and keeps yielding into the same
loop. Your consumer never notices the seam.

### The parser is the hard-won part

The wire format is fiddly, and `post-sse` handles it so you don't: CR / LF /
CRLF terminators (including a **CRLF split across two chunks**), multi-line
`data:` joined with `\n`, comments, a leading BOM, a NUL-in-`id`, and a final
line with no newline. It buffers across chunk **and** UTF-8 boundaries, so a
multibyte character split mid-sequence decodes correctly. There's a property
test that splits the same payload at **every single byte offset** and asserts the
events come out identical to a one-shot parse.

You can use that parser directly on any byte/text stream, not just a fetch body:

```ts
import { parseSSE } from "post-sse";

for await (const event of parseSSE(someByteStream)) {
  // { event?, data, id? }
}
```

## It's the front of a pipeline

`post-sse` is the **transport** step of a streaming structured-output flow — and
it sits first. Its two siblings pick up from the events it yields:

```
fetch → SSE (post-sse) → parse partial JSON (trickle-json) → repair/coerce to schema (coerce-json) → validate
```

- **[`post-sse`](https://www.npmjs.com/package/post-sse)** — POST the request,
  stream the events. *(this one)*
- **[`trickle-json`](https://www.npmjs.com/package/trickle-json)** — assemble the
  streamed token deltas into the best valid partial value available on every
  chunk, without throwing.
- **[`coerce-json`](https://www.npmjs.com/package/coerce-json)** — repair and
  coerce that value to your Zod / JSON Schema, logging every fix.

Here's all three together — stream a completion, assemble the JSON as it arrives,
and coerce the result to a schema:

```ts
import { sse } from "post-sse";
import { StreamingJsonParser } from "trickle-json";
import { coerce } from "coerce-json/zod";
import { z } from "zod";

const Answer = z.object({
  sentiment: z.enum(["positive", "neutral", "negative"]),
  score: z.number(),
  tags: z.array(z.string()).default([]),
});

const parser = new StreamingJsonParser();
parser.on("snapshot", renderPreview); // progressive UI, every chunk

for await (const event of sse(endpoint, { method: "POST", headers, body })) {
  if (event.data === "[DONE]") break;
  const text = JSON.parse(event.data).choices?.[0]?.delta?.content;
  if (text) parser.write(text);
}

const { value, ok, changes } = coerce(parser.end(), Answer);
if (ok) save(value);
else console.warn("could not fully repair:", changes);
```

`post-sse` owns the transport; `trickle-json` gives you the best value on every
chunk without throwing; `coerce-json` makes it fit your schema and hands you the
receipts. Each is zero-dependency and works on its own — adopt only the piece you
need.

"But doesn't provider structured output / the official SDK already do this?" The
SDKs help, but they couple the stream to their request lifecycle and their
provider's shapes. `post-sse` is a pure, framework-agnostic `fetch` SSE client:
drop it into any pipeline, point it at any `text/event-stream` (LLM or not), mock
it in a test, and hand clean events to whatever's next.

## Try it

```sh
npm install post-sse
```

- **npm:** https://www.npmjs.com/package/post-sse
- **GitHub:** https://github.com/H1manshu01/post-sse
- Zero runtime dependencies, ESM + CJS, full types, ~1.4 kB min+brotli,
  published with provenance. Runs on Node ≥ 18, the browser, and Bun.

If it mishandles some stream it shouldn't — a terminator edge case, a chunk
boundary, an abort that leaks — open an issue with a repro. The parser-parity and
no-leaked-reader guarantees are the whole point, so I want to know. ⭐ appreciated
if it saves you a hand-rolled fetch loop.
