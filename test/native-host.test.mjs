import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../bridge/config.mjs";
import {
  createDecoder,
  createProviders,
  encodeMessage,
  HOST_NAME,
  PROTOCOL_VERSION,
  serveNativeHost,
} from "../bridge/native-host.mjs";
import { resolveCommand } from "../bridge/resolve-command.mjs";
import { extensionIdFromKey, hostManifest } from "../scripts/install-host.mjs";

const FAKE_CLAUDE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const HOST_SCRIPT = fileURLToPath(new URL("../bridge/native-host.mjs", import.meta.url));
const EXTENSION_DIR = fileURLToPath(new URL("../extension/", import.meta.url));

// Serves the host over in-memory streams; fake-claude.mjs stands in for Claude
// Code and fake-cli.mjs for Codex and the Gemini CLI.
function startHost(t, runnerOptions = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "byos-host-"));
  const fake = (script) => ({ command: process.execPath, prefixArgs: [script], found: true });
  const providers = createProviders({
    config: { ...DEFAULT_CONFIG, dataDir },
    commands: { claude: fake(FAKE_CLAUDE), codex: fake(FAKE_CLI), gemini: { ...fake(FAKE_CLI), found: false } },
    runnerOptions: { requestTimeoutMs: 10_000, warmPerKey: 0, cwd: dataDir, ...runnerOptions },
  });
  const runner = providers.runner("claude");
  const input = new PassThrough();
  const output = new PassThrough();
  const waiters = new Map();
  output.on("data", createDecoder((reply) => waiters.get(reply.id)?.(reply), (error) => { throw error; }));
  const served = serveNativeHost({ input, output, providers });
  let nextId = 1;
  const expect = (id) => new Promise((resolve) => waiters.set(id, resolve));
  let closed = null;
  const host = {
    providers,
    runner,
    expect,
    writeRaw: (bytes) => input.write(bytes),
    request(message) {
      const id = nextId++;
      const reply = expect(id);
      input.write(encodeMessage({ id, protocol: PROTOCOL_VERSION, ...message }));
      return reply;
    },
    close() {
      closed ??= (async () => {
        input.end();
        await served;
        await providers.close();
        rmSync(dataDir, { recursive: true, force: true });
      })();
      return closed;
    },
  };
  t.after(() => host.close());
  return host;
}

function messages(content, extra = {}) {
  return { type: "messages", body: { model: "haiku", messages: [{ role: "user", content }], ...extra } };
}

function echoed(reply) {
  assert.equal(reply.ok, true, JSON.stringify(reply.error));
  return JSON.parse(reply.result.content[0].text);
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
  const host = startHost(t);
  const reply = await host.request(messages("Translate to Korean:\n\nHello", {
    model: "claude-haiku-5-5",
    system: "-- starts with dashes\nsecond line",
    max_tokens: 4096,
    temperature: 0,
  }));
  assert.equal(reply.result.type, "message");
  assert.equal(reply.result.model, "resolved-claude-haiku-5-5");
  assert.equal(reply.result.stop_reason, "end_turn");
  const seen = echoed(reply);
  assert.equal(seen.model, "claude-haiku-5-5");
  assert.equal(seen.system, "-- starts with dashes\nsecond line");
  assert.equal(seen.prompt, "Translate to Korean:\n\nHello");
  assert.equal(seen.tools, "");
});

test("answers through Codex with the instructions and prompt on stdin", async (t) => {
  const host = startHost(t);
  const withDefault = echoed(await host.request(messages("Bonjour", { provider: "codex", model: "", system: "Translate." })));
  assert.equal(withDefault.tool, "codex");
  assert.deepEqual(withDefault.args, ["exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"]);
  assert.equal(withDefault.input, "Translate.\n\nBonjour");
  const chosen = echoed(await host.request(messages("Hallo", { provider: "codex", model: "gpt-5" })));
  assert.deepEqual(chosen.args.slice(-2), ["--model", "gpt-5"]);
});

test("answers through the Gemini CLI with its system prompt replaced", async (t) => {
  const host = startHost(t);
  const reply = await host.request(messages("Hola", { provider: "gemini", model: "", system: "Translate into Korean." }));
  const seen = echoed(reply);
  assert.equal(seen.tool, "gemini");
  assert.deepEqual(seen.args, ["--output-format", "json", "--model", "gemini-2.5-flash"]);
  assert.equal(seen.input, "Hola");
  assert.equal(seen.system, "Translate into Korean.");
  assert.equal(reply.result.model, "gemini-2.5-flash");
});

test("rejects requests the command-line tools cannot represent", async (t) => {
  const host = startHost(t);
  const cases = [
    messages("hi", { stream: true }),
    messages("hi", { model: "--dangerously-skip-permissions" }),
    messages("hi", { provider: "copilot" }),
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

test("refuses requests from another extension version and states its own", async (t) => {
  const host = startHost(t);
  // An extension from before protocol 2 sends no version.
  const older = host.expect(101);
  host.writeRaw(encodeMessage({ id: 101, type: "messages", body: messages("hi").body }));
  const newer = host.expect(102);
  host.writeRaw(encodeMessage({ id: 102, protocol: PROTOCOL_VERSION + 1, type: "status" }));
  for (const reply of [await older, await newer]) {
    assert.equal(reply.ok, false);
    assert.equal(reply.error.type, "version_mismatch");
    assert.match(reply.error.message, /Reload the extension/);
    assert.equal(reply.protocol, PROTOCOL_VERSION);
  }
  assert.equal(host.runner.snapshot().spawned, 0);
  assert.equal((await host.request({ type: "status" })).protocol, PROTOCOL_VERSION);
});

test("a warm-up starts Claude Code processes that serve the next request", async (t) => {
  const host = startHost(t, { warmPerKey: 1 });
  const warm = await host.request({ type: "warmup", provider: "claude", model: "haiku", system: "S" });
  assert.equal(warm.result.providers.claude.idle, 1);
  echoed(await host.request(messages("one", { system: "S" })));
  const stats = host.runner.snapshot();
  assert.equal(stats.warmHits, 1);
  assert.equal(stats.coldStarts, 0);
  // Codex and Gemini start per request, so a warm-up starts nothing for them.
  const codex = await host.request({ type: "warmup", provider: "codex", model: "", system: "S" });
  assert.equal(codex.result.providers.codex.live, 0);
});

test("reports which providers are installed", async (t) => {
  const host = startHost(t);
  const status = await host.request({ type: "status" });
  assert.deepEqual(
    Object.fromEntries(Object.entries(status.result.providers).map(([id, entry]) => [id, [entry.label, entry.available]])),
    { claude: ["Claude Code", true], codex: ["Codex", true], gemini: ["Gemini CLI", false] },
  );
});

test("reports rate limits and crashes from every provider", async (t) => {
  const host = startHost(t);
  assert.equal((await host.request(messages("RATE"))).error.type, "rate_limit_error");
  const crashed = await host.request(messages("CRASH"));
  assert.equal(crashed.error.type, "api_error");
  assert.match(crashed.error.message, /Claude Code exited \(code 3\).*boom/);

  const codex = await host.request(messages("ERROR", { provider: "codex" }));
  assert.match(codex.error.message, /Codex exited \(code 1\).*usage limit reached/s);
  const gemini = await host.request(messages("ERROR", { provider: "gemini" }));
  assert.equal(gemini.error.type, "rate_limit_error");
  assert.match(gemini.error.message, /Quota exceeded/);
  const geminiCrash = await host.request(messages("CRASH", { provider: "gemini" }));
  assert.match(geminiCrash.error.message, /Gemini CLI exited \(code 3\).*boom/);
});

test("kills a tool that does not answer in time", async (t) => {
  const host = startHost(t, { requestTimeoutMs: 300 });
  for (const provider of ["claude", "codex", "gemini"]) {
    const reply = await host.request(messages("HANG", { provider }));
    assert.match(reply.error.message, /did not answer/);
    await waitFor(() => host.providers.runner(provider).snapshot().live === 0);
  }
});

test("stops every tool when the browser disconnects", async (t) => {
  const host = startHost(t);
  host.request(messages("HANG"));
  host.request(messages("HANG", { provider: "codex" }));
  await waitFor(() => host.runner.snapshot().live === 1 && host.providers.runner("codex").snapshot().live === 1);
  await host.close();
  assert.equal(host.runner.snapshot().live, 0);
  assert.equal(host.providers.runner("codex").snapshot().live, 0);
});

test("queues requests beyond the concurrency limit", async (t) => {
  const host = startHost(t, { maxConcurrent: 1 });
  const replies = await Promise.all(["a", "b", "c"].map((text) => host.request(messages(text))));
  assert.deepEqual(replies.map((reply) => reply.ok), [true, true, true]);
});

test("refuses replies above the 1 MB native messaging limit", async (t) => {
  const host = startHost(t);
  // fake-claude echoes the prompt, so the reply carries ~1.2 MB of UTF-8.
  const reply = await host.request(messages("가".repeat(399_000)));
  assert.equal(reply.ok, false);
  assert.match(reply.error.message, /1 MB/);
});

test("starts the entry point of an npm .cmd shim without a shell", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "byos-shim-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const entry = join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
  mkdirSync(join(entry, ".."), { recursive: true });
  writeFileSync(entry, "");
  writeFileSync(
    join(dir, "codex.cmd"),
    '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
  );
  writeFileSync(join(dir, "broken.cmd"), "@echo off\r\nsomething else\r\n");

  const env = { PATH: dir };
  assert.deepEqual(resolveCommand("codex", { platform: "win32", env }), {
    command: process.execPath,
    prefixArgs: [entry],
    found: true,
  });
  assert.equal(resolveCommand("broken", { platform: "win32", env }).found, false);
  assert.deepEqual(resolveCommand("gemini", { platform: "win32", env }), { command: "gemini", prefixArgs: [], found: false });
});

test("the host process answers over stdio and exits when stdin closes", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "byos-host-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const child = spawn(process.execPath, [HOST_SCRIPT, "chrome-extension://test/"], {
    env: { ...process.env, BYOS_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const reply = new Promise((resolve) => child.stdout.on("data", createDecoder(resolve, assert.fail)));
  child.stdin.write(encodeMessage({ id: 7, protocol: PROTOCOL_VERSION, type: "status" }));
  const status = await reply;
  assert.equal(status.id, 7);
  assert.equal(status.ok, true);
  assert.deepEqual(Object.keys(status.result.providers), ["claude", "codex", "gemini"]);
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
  assert.ok(background.includes(`const PROTOCOL_VERSION = ${PROTOCOL_VERSION};`));
  const id = extensionIdFromKey(manifest.key);
  assert.match(id, /^[a-p]{32}$/);
  assert.deepEqual(hostManifest("C:\\launcher.cmd", id).allowed_origins, [`chrome-extension://${id}/`]);
});
