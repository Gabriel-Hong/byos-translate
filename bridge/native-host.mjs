// Native messaging host. Chrome or Edge starts it when the extension connects
// and closes stdin when the extension disconnects or the browser exits.
// Every message is a 4-byte little-endian length followed by UTF-8 JSON.
//
// Requests:  { id, type: "messages", body }        Anthropic Messages body
//            { id, type: "warmup", model, system }  start processes ahead of use
//            { id, type: "status" }
// Responses: { id, ok: true, result } or { id, ok: false, error: { type, message } }
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeRunner } from "./claude-runner.mjs";
import { defaultDataDir, loadConfig } from "./config.mjs";
import { messageResponse, parseMessagesRequest, parseProcessKey, runnerErrorType } from "./messages.mjs";

export const HOST_NAME = "io.github.byos_translate";
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
// Chrome rejects host-to-browser messages above 1 MB and closes the port.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_LOG_BYTES = 1024 * 1024;

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Returns a chunk handler that emits each complete message. A length over the
// limit leaves the stream unsynchronised, so it is reported as fatal.
export function createDecoder(onMessage, onFatal) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_INPUT_BYTES) {
        onFatal(new Error(`message of ${length} bytes exceeds ${MAX_INPUT_BYTES}`));
        buffer = Buffer.alloc(0);
        return;
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        message = { type: "malformed" };
      }
      onMessage(message);
    }
  };
}

function failure(type, message) {
  return { ok: false, error: { type, message } };
}

// Serves requests until the input ends; resolves when the browser disconnects.
export function serveNativeHost({ input, output, runner, defaultModel, log = () => {} }) {
  const send = (id, reply) => {
    let frame = encodeMessage({ id, ...reply });
    if (frame.length - 4 > MAX_OUTPUT_BYTES) {
      frame = encodeMessage({ id, ...failure("api_error", "The reply exceeds the 1 MB native messaging limit.") });
    }
    output.write(frame);
  };

  const handle = async (message) => {
    const id = message?.id ?? null;
    switch (message?.type) {
      case "status":
        return send(id, { ok: true, result: { runner: runner.snapshot() } });
      case "warmup": {
        const key = parseProcessKey(message, { defaultModel });
        if (!key.ok) return send(id, key);
        runner.warm(key.value);
        return send(id, { ok: true, result: { runner: runner.snapshot() } });
      }
      case "messages": {
        const parsed = parseMessagesRequest(message.body, { defaultModel });
        if (!parsed.ok) return send(id, parsed);
        const started = Date.now();
        try {
          const completion = await runner.complete(parsed.value);
          send(id, { ok: true, result: messageResponse(completion) });
          log(`ok ${parsed.value.model} in=${parsed.value.prompt.length}ch out=${completion.text.length}ch ${Date.now() - started}ms`);
        } catch (error) {
          send(id, failure(runnerErrorType(error), error.message));
          log(`${error.kind ?? "error"} ${parsed.value.model}: ${String(error.message).slice(0, 200)} ${Date.now() - started}ms`);
        }
        return undefined;
      }
      case "malformed":
        return send(id, failure("invalid_request_error", "The message is not valid JSON."));
      default:
        return send(id, failure("invalid_request_error", `Unknown message type: ${message?.type}`));
    }
  };

  return new Promise((resolve) => {
    const decode = createDecoder(
      (message) => {
        handle(message).catch((error) => log(`handler failed: ${error.stack ?? error}`));
      },
      (error) => {
        log(`protocol error: ${error.message}`);
        input.destroy();
        resolve();
      },
    );
    input.on("data", decode);
    input.once("end", resolve);
    input.once("close", resolve);
  });
}

// Appends to a log file in the data folder, keeping one previous file.
function fileLogger(file) {
  return (line) => {
    try {
      if (statSync(file, { throwIfNoEntry: false })?.size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
    } catch {
      // Logging must never break the protocol on stdout.
    }
  };
}

async function main() {
  const dataDir = defaultDataDir();
  mkdirSync(join(dataDir, "claude-cwd"), { recursive: true });
  const log = fileLogger(join(dataDir, "native-host.log"));
  try {
    log(`started by ${process.argv[2] ?? "unknown caller"}`);
    const config = loadConfig(dataDir);
    // Claude Code runs in an empty folder so no project CLAUDE.md, settings or memory apply.
    const runner = new ClaudeRunner({
      command: config.claudeCommand,
      cwd: join(config.dataDir, "claude-cwd"),
      maxConcurrent: config.maxConcurrent,
      warmPerKey: config.warmPerKey,
      maxIdleProcesses: config.maxIdleProcesses,
      idleTtlMs: config.idleTtlMs,
      requestTimeoutMs: config.requestTimeoutMs,
    });
    await serveNativeHost({
      input: process.stdin,
      output: process.stdout,
      runner,
      defaultModel: config.defaultModel,
      log,
    });
    log("disconnected; stopping Claude Code processes");
    await runner.close();
    process.exit(0);
  } catch (error) {
    log(`fatal: ${error.stack ?? error}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
