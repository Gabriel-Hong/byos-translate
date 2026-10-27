import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "../bridge/claude-runner.mjs";
import { createDecoder, encodeMessage, HOST_NAME, serveNativeHost } from "../bridge/native-host.mjs";
import { extensionIdFromKey, hostManifest } from "../scripts/install-host.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const HOST_SCRIPT = fileURLToPath(new URL("../bridge/native-host.mjs", import.meta.url));
const EXTENSION_DIR = fileURLToPath(new URL("../extension/", import.meta.url));

// Serves the host over in-memory streams with fake-claude.mjs as Claude Code.
function startHost(runnerOptions = {}) {
  const runner = new ClaudeRunner({
    command: process.execPath,
    prefixArgs: [FAKE_CLAUDE],
    requestTimeoutMs: 10_000,
    ...runnerOptions,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const waiters = new Map();
  output.on("data", createDecoder((reply) => waiters.get(reply.id)?.(reply), (error) => { throw error; }));
  const served = serveNativeHost({ input, output, runner, defaultModel: "haiku" });
  let nextId = 1;
  const expect = (id) => new Promise((resolve) => waiters.set(id, resolve));
  return {
    runner,
    expect,
    writeRaw: (bytes) => input.write(bytes),
    request(message) {
      const id = nextId++;
      const reply = expect(id);
      input.write(encodeMessage({ id, ...message }));
      return reply;
    },
    async close() {
      input.end();
      await served;
      await runner.close();
    },
  };
}

function messages(content, extra = {}) {
  return { type: "messages", body: { model: "haiku", messages: [{ role: "user", content }], ...extra } };
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("decodes frames split across and joined within chunks", () => {
  const seen = [];
  const decode = createDecoder((message) => seen.push(message), (error) => assert.fail(error));
  const bytes = Buffer.concat([encodeMessage({ id: 1, text: "한국어" }), encodeMessage({ id: 2 })]);
  for (let offset = 0; offset < bytes.length; offset += 3) decode(bytes.subarray(offset, offset + 3));
  assert.deepEqual(seen, [{ id: 1, text: "한국어" }, { id: 2 }]);

  let fatal = null;
  createDecoder(() => assert.fail("no message expected"), (error) => (fatal = error))(Buffer.from([0, 0, 0, 0x7f]));
  assert.match(fatal.message, /exceeds/);
});

test("answers an extension request through Claude Code", async (t) => {
  const host = startHost({ warmPerKey: 0 });
  t.after(() => host.close());
  const reply = await host.request(messages("Translate to Korean:\n\nHello", {
    model: "claude-haiku-5-5",
    system: "-- starts with dashes\nsecond line",
    max_tokens: 4096,
    temperature: 0,
  }));
  assert.equal(reply.ok, true);
  assert.equal(reply.result.type, "message");
  assert.equal(reply.result.model, "resolved-claude-haiku-5-5");
  assert.equal(reply.result.stop_reason, "end_turn");
  const seen = JSON.parse(reply.result.content[0].text);
  assert.equal(seen.model, "claude-haiku-5-5");
  assert.equal(seen.system, "-- starts with dashes\nsecond line");
  assert.equal(seen.prompt, "Translate to Korean:\n\nHello");
  assert.equal(seen.tools, "");
});

test("rejects requests Claude Code cannot represent", async (t) => {
  const host = startHost({ warmPerKey: 0 });
  t.after(() => host.close());
  const cases = [
    messages("hi", { stream: true }),
    messages("hi", { model: "--dangerously-skip-permissions" }),
    { type: "messages", body: { messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] } },
    { type: "messages", body: { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] } },
    messages("   "),
    { type: "warmup", model: "-x" },
    { type: "unknown" },
  ];
  for (const message of cases) {
    const reply = await host.request(message);
    assert.equal(reply.ok, false, JSON.stringify(message));
    assert.equal(reply.error.type, "invalid_request_error");
  }
  const malformed = Buffer.from("{not json", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(malformed.length, 0);
  const malformedReply = host.expect(null);
  host.writeRaw(Buffer.concat([header, malformed]));
  assert.equal((await malformedReply).error.type, "invalid_request_error");
  assert.equal(host.runner.snapshot().spawned, 0);
});

test("a warm-up starts processes that serve the next request", async (t) => {
  const host = startHost({ warmPerKey: 1 });
  t.after(() => host.close());
  const warm = await host.request({ type: "warmup", model: "haiku", system: "S" });
  assert.equal(warm.ok, true);
  assert.equal(warm.result.runner.idle, 1);
  const reply = await host.request(messages("one", { system: "S" }));
  assert.equal(reply.ok, true);
  const stats = host.runner.snapshot();
  assert.equal(stats.warmHits, 1);
  assert.equal(stats.coldStarts, 0);
});

test("reports upstream rate limits and crashes", async (t) => {
  const host = startHost({ warmPerKey: 0 });
  t.after(() => host.close());
  const limited = await host.request(messages("RATE"));
  assert.equal(limited.error.type, "rate_limit_error");
  const crashed = await host.request(messages("CRASH"));
  assert.equal(crashed.error.type, "api_error");
  assert.match(crashed.error.message, /code 3.*boom/);
});

test("kills Claude Code when a request times out", async (t) => {
  const host = startHost({ warmPerKey: 0, requestTimeoutMs: 300 });
  t.after(() => host.close());
  const reply = await host.request(messages("HANG"));
  assert.match(reply.error.message, /did not answer/);
  await waitFor(() => host.runner.snapshot().live === 0);
});

test("stops Claude Code when the browser disconnects", async () => {
  const host = startHost({ warmPerKey: 0 });
  host.request(messages("HANG"));
  await waitFor(() => host.runner.snapshot().live === 1);
  await host.close();
  assert.equal(host.runner.snapshot().live, 0);
});

test("queues requests beyond the concurrency limit", async (t) => {
  const host = startHost({ warmPerKey: 0, maxConcurrent: 1 });
  t.after(() => host.close());
  const replies = await Promise.all(["a", "b", "c"].map((text) => host.request(messages(text))));
  assert.deepEqual(replies.map((reply) => reply.ok), [true, true, true]);
});

test("refuses replies above the 1 MB native messaging limit", async (t) => {
  const host = startHost({ warmPerKey: 0 });
  t.after(() => host.close());
  // fake-claude echoes the prompt, so the reply carries ~1.2 MB of UTF-8.
  const reply = await host.request(messages("가".repeat(399_000)));
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /1 MB/);
});

test("the host process answers over stdio and exits when stdin closes", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "byos-host-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [HOST_SCRIPT, "chrome-extension://test/"], {
    env: { ...process.env, BYOS_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const reply = new Promise((resolve) => child.stdout.on("data", createDecoder(resolve, assert.fail)));
  child.stdin.write(encodeMessage({ id: 7, type: "status" }));
  const status = await reply;
  assert.equal(status.id, 7);
  assert.equal(status.ok, true);
  assert.equal(status.result.runner.live, 0);
  child.stdin.end();
  const [code] = await new Promise((resolve) => child.once("exit", (...args) => resolve(args)));
  assert.equal(code, 0);
  assert.match(readFileSync(join(dataDir, "native-host.log"), "utf8"), /started by chrome-extension:\/\/test\//);
});

test("the extension and the bridge registration agree", () => {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("nativeMessaging"));
  assert.equal(manifest.host_permissions, undefined);
  const background = readFileSync(join(EXTENSION_DIR, "background.js"), "utf8");
  assert.ok(background.includes(`const HOST_NAME = "${HOST_NAME}";`));
  const id = extensionIdFromKey(manifest.key);
  assert.match(id, /^[a-p]{32}$/);
  assert.deepEqual(hostManifest("C:\\launcher.cmd", id).allowed_origins, [`chrome-extension://${id}/`]);
});
