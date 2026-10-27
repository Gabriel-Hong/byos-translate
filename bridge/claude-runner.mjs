// Runs one-shot Claude Code (`claude -p`) processes for text completions.
//
// Starting Claude Code dominates latency (~4-6 s on Windows) while the model call
// itself is ~1-2 s. A process started with `--input-format stream-json` finishes
// its startup and then waits for stdin without calling the API, so the runner
// keeps a few started processes per (model, system prompt) and hands each one
// exactly one prompt. Context therefore never accumulates between requests.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const STDERR_TAIL_CHARS = 4096;
const MAX_STDOUT_BUFFER_CHARS = 32 * 1024 * 1024;
const EXIT_GRACE_MS = 10_000;
const DEFAULT_SYSTEM_PROMPT = "Respond to the user's request directly.";

export class RunnerError extends Error {
  // kind: spawn | exited | timeout | aborted | upstream | protocol | busy | closed
  constructor(kind, message, { status, cause } = {}) {
    super(message, { cause });
    this.name = "RunnerError";
    this.kind = kind;
    this.status = status;
  }
}

export function claudeArgs(model, system) {
  return [
    "-p",
    `--model=${model}`,
    // A plain completion: no tools, MCP servers, hooks, settings files or saved sessions.
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--setting-sources", "",
    "--settings", '{"disableAllHooks":true}',
    "--no-session-persistence",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    // The `=` form keeps a prompt that starts with "-" from being read as a flag.
    `--system-prompt=${system || DEFAULT_SYSTEM_PROMPT}`,
  ];
}

function processKey(model, system) {
  return createHash("sha256").update(model).update("\0").update(system ?? "").digest("hex");
}

class ClaudeProcess {
  constructor({ command, args, cwd, env, key }) {
    this.key = key;
    this.exitInfo = null;
    this.stderrTail = "";
    this.onEvent = null;
    this.idleTimer = null;
    this.child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    // 'close' is emitted after 'exit', and also after 'error' when spawning fails.
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.exitInfo = { code, signal };
        resolve(this.exitInfo);
      });
    });
    this.child.once("error", (error) => {
      this.spawnError = error;
    });
    this.child.stdin.on("error", () => {});
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_STDOUT_BUFFER_CHARS) {
        this.protocolError = `stdout line exceeded ${MAX_STDOUT_BUFFER_CHARS} characters`;
        this.kill();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        this.onEvent?.(event);
      }
    });
  }

  get alive() {
    return this.exitInfo === null && !this.spawnError;
  }

  kill() {
    if (this.exitInfo === null) this.child.kill();
  }

  // Sends one prompt and resolves with Claude Code's `result` event.
  run(prompt, { signal, timeoutMs }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (settle, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.onEvent = null;
        settle(value);
      };
      const onAbort = () => {
        this.kill();
        finish(reject, new RunnerError("aborted", "The request was cancelled."));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (!this.alive) {
        finish(reject, this.#exitError());
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        this.kill();
        finish(reject, new RunnerError("timeout", `Claude Code did not answer within ${timeoutMs} ms.`));
      }, timeoutMs);
      this.onEvent = (event) => {
        if (event?.type === "result") finish(resolve, event);
      };
      this.exited.then(() => finish(reject, this.#exitError()));
      const message = { type: "user", message: { role: "user", content: prompt } };
      this.child.stdin.end(`${JSON.stringify(message)}\n`);
    });
  }

  // The process exits by itself after answering because stdin is closed.
  retire() {
    if (this.exitInfo !== null) return;
    setTimeout(() => this.kill(), EXIT_GRACE_MS).unref();
  }

  #exitError() {
    if (this.spawnError) {
      return new RunnerError("spawn", `Cannot start Claude Code: ${this.spawnError.message}`, {
        cause: this.spawnError,
      });
    }
    if (this.protocolError) return new RunnerError("protocol", this.protocolError);
    const detail = this.stderrTail.trim() || "no stderr output";
    return new RunnerError("exited", `Claude Code exited (code ${this.exitInfo?.code}) before answering: ${detail}`);
  }
}

export class ClaudeRunner {
  #idle = [];
  #live = new Set();
  #waiters = [];
  #active = 0;
  #closed = false;
  #stats = { spawned: 0, warmHits: 0, coldStarts: 0, completed: 0, failed: 0 };

  constructor({
    command = "claude",
    prefixArgs = [],
    cwd,
    env = process.env,
    maxConcurrent = 4,
    maxQueued = 64,
    warmPerKey = 2,
    maxIdleProcesses = 4,
    idleTtlMs = 600_000,
    requestTimeoutMs = 120_000,
  } = {}) {
    this.options = {
      command, prefixArgs, cwd, env, maxConcurrent, maxQueued,
      warmPerKey, maxIdleProcesses, idleTtlMs, requestTimeoutMs,
    };
  }

  snapshot() {
    return {
      live: this.#live.size,
      idle: this.#idle.length,
      active: this.#active,
      queued: this.#waiters.length,
      ...this.#stats,
    };
  }

  async complete({ model, system, prompt, signal }) {
    if (this.#closed) throw new RunnerError("closed", "The bridge is shutting down.");
    await this.#acquire(signal);
    const key = processKey(model, system);
    let proc;
    try {
      proc = this.#takeIdle(key);
      if (proc) {
        this.#stats.warmHits++;
      } else {
        this.#stats.coldStarts++;
        proc = this.#spawn(model, system, key);
      }
      this.#replenish(model, system, key);
      const event = await proc.run(prompt, { signal, timeoutMs: this.options.requestTimeoutMs });
      const completion = toCompletion(event, model);
      this.#stats.completed++;
      return completion;
    } catch (error) {
      this.#stats.failed++;
      throw error;
    } finally {
      proc?.retire();
      this.#release();
    }
  }

  async close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(new RunnerError("closed", "The bridge is shutting down."));
    }
    const exits = [...this.#live].map((proc) => {
      clearTimeout(proc.idleTimer);
      proc.kill();
      return proc.exited;
    });
    this.#idle = [];
    await Promise.all(exits);
  }

  #acquire(signal) {
    if (signal?.aborted) return Promise.reject(new RunnerError("aborted", "The request was cancelled."));
    if (this.#active < this.options.maxConcurrent) {
      this.#active++;
      return Promise.resolve();
    }
    if (this.#waiters.length >= this.options.maxQueued) {
      return Promise.reject(new RunnerError("busy", "Too many queued requests; retry later."));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new RunnerError("aborted", "The request was cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }

  #release() {
    const next = this.#waiters.shift();
    if (next) {
      next.resolve();
    } else {
      this.#active--;
    }
  }

  #spawn(model, system, key) {
    const proc = new ClaudeProcess({
      command: this.options.command,
      args: [...this.options.prefixArgs, ...claudeArgs(model, system)],
      cwd: this.options.cwd,
      env: this.options.env,
      key,
    });
    this.#stats.spawned++;
    this.#live.add(proc);
    proc.exited.then(() => {
      this.#live.delete(proc);
      clearTimeout(proc.idleTimer);
      const index = this.#idle.indexOf(proc);
      if (index >= 0) this.#idle.splice(index, 1);
    });
    return proc;
  }

  #takeIdle(key) {
    const index = this.#idle.findIndex((proc) => proc.key === key && proc.alive);
    if (index < 0) return undefined;
    const [proc] = this.#idle.splice(index, 1);
    clearTimeout(proc.idleTimer);
    return proc;
  }

  #replenish(model, system, key) {
    if (this.#closed) return;
    let warm = this.#idle.filter((proc) => proc.key === key).length;
    while (warm < this.options.warmPerKey) {
      if (this.#idle.length >= this.options.maxIdleProcesses) {
        // Evict the least recently started idle process of another key.
        const victimIndex = this.#idle.findIndex((proc) => proc.key !== key);
        if (victimIndex < 0) return;
        const [victim] = this.#idle.splice(victimIndex, 1);
        clearTimeout(victim.idleTimer);
        victim.kill();
      }
      const proc = this.#spawn(model, system, key);
      proc.idleTimer = setTimeout(() => {
        const index = this.#idle.indexOf(proc);
        if (index >= 0) this.#idle.splice(index, 1);
        proc.kill();
      }, this.options.idleTtlMs);
      proc.idleTimer.unref();
      this.#idle.push(proc);
      warm++;
    }
  }
}

function toCompletion(event, requestedModel) {
  if (event.is_error || event.subtype !== "success") {
    const message = typeof event.result === "string" && event.result
      ? event.result
      : `Claude Code reported ${event.subtype ?? "an error"}.`;
    throw new RunnerError("upstream", message, { status: event.api_error_status ?? undefined });
  }
  const models = Object.keys(event.modelUsage ?? {});
  return {
    text: typeof event.result === "string" ? event.result : "",
    stopReason: event.stop_reason ?? "end_turn",
    usage: event.usage ?? {},
    model: models[0] ?? requestedModel,
  };
}
