import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "../bridge/claude-runner.mjs";
import { createBridgeServer } from "../bridge/server.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const TOKEN = "test-token-0123456789";

async function startBridge(runnerOptions = {}) {
  const runner = new ClaudeRunner({
    command: process.execPath,
    prefixArgs: [FAKE_CLAUDE],
    requestTimeoutMs: 10_000,
    ...runnerOptions,
  });
  const server = createBridgeServer({ config: { token: TOKEN, defaultModel: "haiku" }, runner });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    runner,
    port,
    base: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await runner.close();
    },
  };
}

// A header set to undefined is omitted.
function post(bridge, body, { headers = {}, signal } = {}) {
  const merged = { "content-type": "application/json", "x-api-key": TOKEN, ...headers };
  for (const [name, value] of Object.entries(merged)) if (value === undefined) delete merged[name];
  return fetch(`${bridge.base}/v1/messages`, {
    method: "POST",
    headers: merged,
    body: JSON.stringify(body),
    signal,
  });
}

function userMessage(content, extra = {}) {
  return { model: "haiku", messages: [{ role: "user", content }], ...extra };
}

// node:http lets the test set Host and Origin exactly as a browser page would.
function rawRequest(port, { method = "GET", path = "/health", headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("answers an Immersive Translate shaped Claude request", async (t) => {
  const bridge = await startBridge({ warmPerKey: 0 });
  t.after(() => bridge.close());
  const response = await post(
    bridge,
    {
      max_tokens: 4096,
      thinking: { type: "disabled" },
      model: "claude-haiku-5-5",
      messages: [{ role: "user", content: "Translate to Korean:\n\nHello" }],
      system: "-- starts with dashes\nsecond line",
      temperature: 0,
    },
    { headers: { "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" } },
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.type, "message");
  assert.equal(body.model, "resolved-claude-haiku-5-5");
  assert.equal(body.stop_reason, "end_turn");
  assert.deepEqual(body.usage, {
    input_tokens: 3,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
  const seen = JSON.parse(body.content[0].text);
  assert.equal(seen.model, "claude-haiku-5-5");
  assert.equal(seen.system, "-- starts with dashes\nsecond line");
  assert.equal(seen.prompt, "Translate to Korean:\n\nHello");
  assert.equal(seen.tools, "");
});

test("requires the bridge token", async (t) => {
  const bridge = await startBridge({ warmPerKey: 0 });
  t.after(() => bridge.close());
  assert.equal((await post(bridge, userMessage("hi"), { headers: { "x-api-key": "" } })).status, 401);
  assert.equal((await post(bridge, userMessage("hi"), { headers: { "x-api-key": "wrong" } })).status, 401);
  const bearer = await post(bridge, userMessage("hi"), {
    headers: { "x-api-key": undefined, authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(bearer.status, 200);
  assert.equal(bridge.runner.snapshot().completed, 1);
});

test("refuses foreign hosts and web page origins but allows extensions", async (t) => {
  const bridge = await startBridge({ warmPerKey: 0 });
  t.after(() => bridge.close());
  const rebound = await rawRequest(bridge.port, { headers: { host: `evil.example:${bridge.port}` } });
  assert.equal(rebound.statusCode, 403);
  const page = await rawRequest(bridge.port, {
    method: "OPTIONS",
    path: "/v1/messages",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(page.statusCode, 403);
  const extension = await rawRequest(bridge.port, {
    method: "OPTIONS",
    path: "/v1/messages",
    headers: { origin: "chrome-extension://abcdefghijklmnop" },
  });
  assert.equal(extension.statusCode, 204);
  assert.equal(extension.headers["access-control-allow-origin"], "chrome-extension://abcdefghijklmnop");
});

test("rejects requests Claude Code cannot represent", async (t) => {
  const bridge = await startBridge({ warmPerKey: 0 });
  t.after(() => bridge.close());
  const cases = [
    userMessage("hi", { stream: true }),
    userMessage("hi", { model: "--dangerously-skip-permissions" }),
    { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] },
    { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] },
    { messages: [{ role: "user", content: "   " }] },
  ];
  for (const body of cases) {
    const response = await post(bridge, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.type, "invalid_request_error");
  }
  assert.equal(bridge.runner.snapshot().spawned, 0);
});

test("serves later requests from a pre-started process, one prompt per process", async (t) => {
  const bridge = await startBridge({ warmPerKey: 1 });
  t.after(() => bridge.close());
  const first = JSON.parse((await (await post(bridge, userMessage("one"))).json()).content[0].text);
  await waitFor(() => bridge.runner.snapshot().idle === 1);
  const second = JSON.parse((await (await post(bridge, userMessage("two"))).json()).content[0].text);
  const stats = bridge.runner.snapshot();
  assert.equal(stats.coldStarts, 1);
  assert.equal(stats.warmHits, 1);
  assert.notEqual(first.pid, second.pid);
  assert.equal(second.prompt, "two");
});

test("maps upstream rate limits and crashes", async (t) => {
  const bridge = await startBridge({ warmPerKey: 0 });
  t.after(() => bridge.close());
  const limited = await post(bridge, userMessage("RATE"));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.type, "rate_limit_error");
  const crashed = await post(bridge, userMessage("CRASH"));
  assert.equal(crashed.status, 502);
  assert.match((await crashed.json()).error.message, /code 3.*boom/);
});

test("kills Claude Code when a request times out", async (t) => {
  const bridge = await startBridge({ warmPerKey: 0, requestTimeoutMs: 300 });
  t.after(() => bridge.close());
  const response = await post(bridge, userMessage("HANG"));
  assert.equal(response.status, 504);
  await waitFor(() => bridge.runner.snapshot().live === 0);
});

test("kills Claude Code when the client disconnects", async (t) => {
  const bridge = await startBridge({ warmPerKey: 0 });
  t.after(() => bridge.close());
  const controller = new AbortController();
  const pending = post(bridge, userMessage("HANG"), { signal: controller.signal });
  await waitFor(() => bridge.runner.snapshot().live === 1);
  controller.abort();
  await assert.rejects(pending);
  await waitFor(() => bridge.runner.snapshot().live === 0 && bridge.runner.snapshot().failed === 1);
});

test("queues requests beyond the concurrency limit", async (t) => {
  const bridge = await startBridge({ warmPerKey: 0, maxConcurrent: 1 });
  t.after(() => bridge.close());
  const responses = await Promise.all(["a", "b", "c"].map((text) => post(bridge, userMessage(text))));
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200]);
  assert.equal(bridge.runner.snapshot().completed, 3);
});
