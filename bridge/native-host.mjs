// Native messaging host. Chrome or Edge starts it when the extension connects
// and closes stdin when the extension disconnects or the browser exits.
// Every message is a 4-byte little-endian length followed by UTF-8 JSON.
//
// Requests:  { id, protocol, type: "messages", body }                  Anthropic Messages body plus provider
//            { id, protocol, type: "warmup", provider, model, system }  start processes ahead of use
//            { id, protocol, type: "status" }
// Responses: { id, protocol, ok: true, result } or { id, protocol, ok: false, error: { type, message } }
//
// Both sides state PROTOCOL_VERSION in every message. The extension and the
// bridge update separately (the bridge runs from disk, the extension until it
// is reloaded), so a request from another version is refused, not guessed at.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDataDir, loadConfig } from "./config.mjs";
import { messageResponse, parseMessagesRequest, parseProcessKey, runnerErrorType } from "./messages.mjs";
import { ProcessRunner } from "./process-runner.mjs";
import { createDriver, PROVIDER_IDS } from "./providers.mjs";
import { resolveCommand } from "./resolve-command.mjs";

export const HOST_NAME = "io.github.byos_translate";
// 1: single-provider native messaging without the field; 2: providers.
export const PROTOCOL_VERSION = 2;
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

// One runner per provider, created on first use. `commands` maps each provider
// to the resolved { command, prefixArgs, found } of its command-line tool.
export function createProviders({ config, commands, runnerOptions = {} }) {
  const drivers = Object.fromEntries(PROVIDER_IDS.map((id) => [id, createDriver(id, { dataDir: config.dataDir })]));
  const runners = new Map();
  return {
    defaultModels: Object.fromEntries(PROVIDER_IDS.map((id) => [id, drivers[id].defaultModel])),
    runner(provider) {
      if (!runners.has(provider)) {
        runners.set(provider, new ProcessRunner({
          driver: drivers[provider],
          command: commands[provider].command,
          prefixArgs: commands[provider].prefixArgs,
          // An empty folder, so no project instruction or settings files apply.
          cwd: join(config.dataDir, "empty-cwd"),
          maxConcurrent: config.maxConcurrent,
          warmPerKey: config.warmPerKey,
          maxIdleProcesses: config.maxIdleProcesses,
          idleTtlMs: config.idleTtlMs,
          requestTimeoutMs: config.requestTimeoutMs,
          ...runnerOptions,
        }));
      }
      return runners.get(provider);
    },
    status() {
      return Object.fromEntries(PROVIDER_IDS.map((id) => [id, {
        label: drivers[id].label,
        available: commands[id].found,
        ...runners.get(id)?.snapshot(),
      }]));
    },
    async close() {
      await Promise.all([...runners.values()].map((runner) => runner.close()));
    },
  };
}

function failure(type, message) {
  return { ok: false, error: { type, message } };
}

// Serves requests until the input ends; resolves when the browser disconnects.
export function serveNativeHost({ input, output, providers, log = () => {} }) {
  const { defaultModels } = providers;
  const send = (id, reply) => {
    let frame = encodeMessage({ id, protocol: PROTOCOL_VERSION, ...reply });
    if (frame.length - 4 > MAX_OUTPUT_BYTES) {
      frame = encodeMessage({
        id,
        protocol: PROTOCOL_VERSION,
        ...failure("api_error", "The reply exceeds the 1 MB native messaging limit."),
      });
    }
    output.write(frame);
  };

  const handle = async (message) => {
    const id = message?.id ?? null;
    if (message?.type !== "malformed" && message?.protocol !== PROTOCOL_VERSION) {
      return send(id, failure(
        "version_mismatch",
        `The extension uses bridge protocol ${message?.protocol ?? 1} but this bridge uses ${PROTOCOL_VERSION}. ` +
          "Reload the extension in chrome://extensions or restart the browser.",
      ));
    }
    switch (message?.type) {
      case "status":
        return send(id, { ok: true, result: { providers: providers.status() } });
      case "warmup": {
        const key = parseProcessKey(message, { defaultModels });
        if (!key.ok) return send(id, key);
        providers.runner(key.value.provider).warm(key.value);
        return send(id, { ok: true, result: { providers: providers.status() } });
      }
      case "messages": {
        const parsed = parseMessagesRequest(message.body, { defaultModels });
        if (!parsed.ok) return send(id, parsed);
        const { provider, model, prompt } = parsed.value;
        const started = Date.now();
        try {
          const completion = await providers.runner(provider).complete(parsed.value);
          send(id, { ok: true, result: messageResponse(completion) });
          log(`ok ${provider} ${model} in=${prompt.length}ch out=${completion.text.length}ch ${Date.now() - started}ms`);
        } catch (error) {
          send(id, failure(runnerErrorType(error), error.message));
          log(`${error.kind ?? "error"} ${provider} ${model}: ${String(error.message).slice(0, 200)} ${Date.now() - started}ms`);
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
  mkdirSync(join(dataDir, "empty-cwd"), { recursive: true });
  const log = fileLogger(join(dataDir, "native-host.log"));
  try {
    log(`started by ${process.argv[2] ?? "unknown caller"}`);
    const config = loadConfig(dataDir);
    const commands = Object.fromEntries(PROVIDER_IDS.map((id) => [id, resolveCommand(config[`${id}Command`])]));
    const providers = createProviders({ config, commands });
    await serveNativeHost({ input: process.stdin, output: process.stdout, providers, log });
    log("disconnected; stopping provider processes");
    await providers.close();
    process.exit(0);
  } catch (error) {
    log(`fatal: ${error.stack ?? error}`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
