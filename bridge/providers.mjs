// Drivers for each provider's official command-line tool. Every tool runs with
// the user's own sign-in, and prompts always travel on stdin, never in arguments.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listCodexModels } from "./codex-models.mjs";
import { RunnerError } from "./process-runner.mjs";

const DEFAULT_SYSTEM_PROMPT = "Respond to the user's request directly.";

function tail(text) {
  return text.trim().slice(-1000) || "no error output";
}

// Claude Code: `--input-format stream-json` waits for its prompt after starting,
// so processes can be started ahead of time.
function claudeDriver() {
  return {
    label: "Claude Code",
    defaultModel: "haiku",
    warmable: true,
    args: (model, system) => [
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
    ],
    input: (prompt) => `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`,
    parseEvent(event, model) {
      if (event?.type !== "result") return undefined;
      if (event.is_error || event.subtype !== "success") {
        const message = typeof event.result === "string" && event.result
          ? event.result
          : `Claude Code reported ${event.subtype ?? "an error"}.`;
        throw new RunnerError("upstream", message, { status: event.api_error_status ?? undefined });
      }
      return {
        text: typeof event.result === "string" ? event.result : "",
        stopReason: event.stop_reason ?? "end_turn",
        usage: event.usage ?? {},
        model: Object.keys(event.modelUsage ?? {})[0] ?? model,
      };
    },
  };
}

// Codex CLI (`codex exec`): reads the prompt from stdin when no prompt argument
// is given and prints only the final answer on stdout. Codex has no system
// prompt option, so the instructions lead the prompt.
function codexDriver() {
  return {
    label: "Codex",
    defaultModel: "",
    warmable: false,
    args: (model) => [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--sandbox", "read-only",
      ...(model ? ["--model", model] : []),
    ],
    input: (prompt, system) => (system ? `${system}\n\n${prompt}` : prompt),
    parseExit({ stdout, stderr, code }, model) {
      const text = stdout.trim();
      if (code === 0 && text) return { text, stopReason: "end_turn", usage: {}, model: model || "codex" };
      throw new RunnerError("exited", `Codex exited (code ${code}) without an answer: ${tail(stderr)}`);
    },
    // The models depend on the account and change often, so they come from
    // Codex itself (`codex app-server` model/list) instead of a fixed list.
    async listModels(tool) {
      const models = await listCodexModels(tool);
      return models
        .filter((entry) => !entry.hidden && (entry.model ?? entry.id))
        .map((entry) => ({
          id: entry.model ?? entry.id,
          label: entry.displayName ?? entry.model ?? entry.id,
          isDefault: entry.isDefault === true,
        }));
    },
  };
}

// Gemini CLI: headless when stdin is piped, one JSON object on stdout with
// --output-format json. GEMINI_SYSTEM_MD replaces its coding-agent system
// prompt with ours; the file is named by its content and reused.
function geminiDriver({ dataDir }) {
  const systemDir = join(dataDir, "gemini-system");
  return {
    label: "Gemini CLI",
    defaultModel: "gemini-2.5-flash",
    warmable: false,
    args: (model) => ["--output-format", "json", ...(model ? ["--model", model] : [])],
    env(model, system) {
      if (!system) return {};
      const file = join(systemDir, `${createHash("sha256").update(system).digest("hex").slice(0, 32)}.md`);
      if (!existsSync(file)) {
        mkdirSync(systemDir, { recursive: true });
        writeFileSync(file, system);
      }
      return { GEMINI_SYSTEM_MD: file };
    },
    input: (prompt) => prompt,
    parseExit({ stdout, stderr, code }, model) {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim());
      } catch {
        // Reported below with the error output.
      }
      if (parsed?.error) {
        const status = Number(parsed.error.code) || undefined;
        throw new RunnerError("upstream", `Gemini CLI: ${parsed.error.message ?? JSON.stringify(parsed.error)}`, { status });
      }
      if (code === 0 && typeof parsed?.response === "string") {
        const reported = Object.keys(parsed.stats?.models ?? {})[0];
        return { text: parsed.response, stopReason: "end_turn", usage: {}, model: reported ?? model };
      }
      throw new RunnerError("exited", `Gemini CLI exited (code ${code}) without an answer: ${tail(stderr || stdout)}`);
    },
  };
}

export const PROVIDER_IDS = ["claude", "codex", "gemini"];

export function createDriver(provider, { dataDir }) {
  switch (provider) {
    case "claude":
      return claudeDriver();
    case "codex":
      return codexDriver();
    case "gemini":
      return geminiDriver({ dataDir });
    default:
      throw new Error(`Unknown provider ${provider}`);
  }
}
