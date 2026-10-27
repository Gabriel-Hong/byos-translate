// Lists the models Codex offers to the signed-in account through the
// documented `codex app-server` JSON-RPC interface (JSON lines on stdio):
// initialize, initialized, then model/list pages. Codex uses its own saved
// sign-in; nothing here reads or forwards credentials.
import { spawn } from "node:child_process";
import { RunnerError } from "./process-runner.mjs";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export function listCodexModels({ command, prefixArgs = [], cwd, env = process.env, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefixArgs, "app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const pending = new Map();
    let nextId = 1;
    let stderr = "";
    let buffer = "";
    let settled = false;

    const finish = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(models);
    };
    const timer = setTimeout(
      () => finish(new RunnerError("timeout", `Codex did not list its models within ${timeoutMs} ms.`)),
      timeoutMs,
    );
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method, params) => new Promise((ok, fail) => {
      const id = nextId++;
      pending.set(id, { ok, fail });
      send({ method, id, params });
    });

    child.once("error", (error) => {
      const hint = error.code === "ENOENT" ? " Is it installed and on PATH?" : "";
      finish(new RunnerError("spawn", `Cannot start Codex: ${error.message}.${hint}`, { cause: error }));
    });
    child.once("close", (code) => {
      finish(new RunnerError("exited", `Codex app-server exited (code ${code}): ${stderr.trim().slice(-500) || "no error output"}`));
    });
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        // Notifications and server-initiated requests carry a method; only
        // responses to our requests are needed.
        if (message.method !== undefined) continue;
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.fail(new RunnerError("upstream", `Codex: ${message.error.message ?? "request failed"}`));
        else waiter.ok(message.result);
      }
    });

    (async () => {
      await request("initialize", { clientInfo: { name: "byos_translate", title: "BYOS Translate", version: "0.1.0" } });
      send({ method: "initialized", params: {} });
      const models = [];
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await request("model/list", { limit: PAGE_SIZE, includeHidden: false, ...(cursor ? { cursor } : {}) });
        models.push(...(Array.isArray(result?.data) ? result.data : []));
        cursor = result?.nextCursor ?? null;
        if (!cursor) break;
      }
      return models;
    })().then((models) => finish(null, models), (error) => finish(error));
  });
}
