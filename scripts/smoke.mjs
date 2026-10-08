// Cross-runtime smoke test against the BUILT output (dist/).
// Runs under both Node and Bun to confirm the published package loads and works.
// No real network: a fake `fetch` returns a Response wrapping a ReadableStream.
import assert from "node:assert/strict";
import { SSEError, json, parseSSE, sse } from "../dist/index.js";

// Turn an array of string chunks into an async iterable, as a source for parseSSE.
async function* fromChunks(chunks) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// Build a fake fetch that streams the given text as `text/event-stream` bytes.
// It records the request it was called with so the test can assert on it.
function makeFakeFetch(body) {
  const calls = [];
  const fetch = (url, init) => {
    calls.push({ url, init });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body));
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return { fetch, calls };
}

// parseSSE over string chunks: named event, multi-line data, CRLF framing.
{
  const chunks = [
    "event: greeting\n",
    "data: hello\n",
    "id: 1\n",
    "\n",
    "data: one\ndata: two\n\n",
    "event: bye\r\ndata: goodbye\r\nid: 3\r\n\r\n",
  ];
  const events = [];
  for await (const ev of parseSSE(fromChunks(chunks))) {
    events.push(ev);
  }
  assert.deepEqual(events, [
    { event: "greeting", data: "hello", id: "1" },
    { data: "one\ntwo" },
    { event: "bye", data: "goodbye", id: "3" },
  ]);
}

// sse() with an injected fetch: POST, custom headers, streamed events.
{
  const body = "event: token\ndata: hi\nid: 7\n\n" + "data: done\n\n";
  const { fetch, calls } = makeFakeFetch(body);
  const headers = { "content-type": "application/json", authorization: "Bearer test" };

  const events = [];
  for await (const ev of sse("https://example.test/stream", {
    fetch,
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "hi" }),
  })) {
    events.push(ev);
  }
  assert.deepEqual(events, [{ event: "token", data: "hi", id: "7" }, { data: "done" }]);

  // The fake fetch was called once, with method POST and an accept header the client adds.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/stream");
  assert.equal(calls[0].init.method, "POST");
  const sent = new Headers(calls[0].init.headers);
  assert.equal(sent.get("accept"), "text/event-stream");
  assert.equal(sent.get("authorization"), "Bearer test");
}

// json(): parses an event's data payload.
{
  const parsed = json({ data: '{"a":1}' });
  assert.deepEqual(parsed, { a: 1 });
}

// SSEError is exported and is a constructor.
{
  assert.equal(typeof SSEError, "function");
  const err = new SSEError("boom", { status: 503 });
  assert.ok(err instanceof Error);
  assert.equal(err.status, 503);
}

console.log(`smoke ok (${typeof Bun !== "undefined" ? "bun" : "node"})`);
