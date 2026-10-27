// Anthropic Messages API request parsing and response formatting.
//
// Claude Code accepts one user turn per process and has no sampling flags, so
// the bridge accepts exactly one user message and ignores sampling fields such
// as max_tokens, temperature and thinking.
import { randomUUID } from "node:crypto";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/;
// The system prompt travels on the command line (Windows caps it at 32767 chars).
export const MAX_SYSTEM_CHARS = 20_000;
export const MAX_PROMPT_CHARS = 400_000;

export const BRIDGE_MODELS = [
  { id: "haiku", display_name: "Claude Haiku (latest, via Claude Code)" },
  { id: "sonnet", display_name: "Claude Sonnet (latest, via Claude Code)" },
  { id: "opus", display_name: "Claude Opus (latest, via Claude Code)" },
];

function invalid(message) {
  return { ok: false, error: { status: 400, type: "invalid_request_error", message } };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Returns the text of a string or an array of text blocks, or null when the
// content holds anything other than text.
function textContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const block of content) {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return null;
    parts.push(block.text);
  }
  return parts.join("\n\n");
}

export function parseMessagesRequest(body, { defaultModel }) {
  if (!isObject(body)) return invalid("Request body must be a JSON object.");
  if (body.stream === true) return invalid("stream=true is not supported by this bridge.");

  const model = body.model ?? defaultModel;
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    return invalid("model must be a Claude model name or alias such as haiku, sonnet or claude-haiku-4-5.");
  }

  let system = "";
  if (body.system !== undefined && body.system !== null) {
    const text = textContent(body.system);
    if (text === null) return invalid("system must be a string or an array of text blocks.");
    system = text;
  }
  if (system.length > MAX_SYSTEM_CHARS) {
    return invalid(`system must be at most ${MAX_SYSTEM_CHARS} characters.`);
  }

  if (!Array.isArray(body.messages) || body.messages.length !== 1) {
    return invalid("messages must contain exactly one user message.");
  }
  const [message] = body.messages;
  if (!isObject(message) || message.role !== "user") {
    return invalid("messages[0].role must be user.");
  }
  const prompt = textContent(message.content);
  if (prompt === null) return invalid("messages[0].content must be text.");
  if (prompt.trim().length === 0) return invalid("messages[0].content must not be empty.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    return invalid(`messages[0].content must be at most ${MAX_PROMPT_CHARS} characters.`);
  }

  return { ok: true, value: { model, system, prompt } };
}

export function messageResponse(completion) {
  const usage = completion.usage ?? {};
  return {
    id: `msg_bridge_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: completion.model,
    content: [{ type: "text", text: completion.text }],
    stop_reason: completion.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    },
  };
}

export function errorBody(type, message) {
  return { type: "error", error: { type, message } };
}

// Maps a RunnerError to an HTTP status and Anthropic error type. Upstream login
// problems are reported as 502 so clients do not blame the bridge token.
export function runnerErrorResponse(error) {
  switch (error.kind) {
    case "busy":
      return { status: 429, type: "rate_limit_error" };
    case "timeout":
      return { status: 504, type: "api_error" };
    case "aborted":
      return { status: 499, type: "api_error" };
    case "closed":
      return { status: 503, type: "overloaded_error" };
    case "upstream":
      if (error.status === 429) return { status: 429, type: "rate_limit_error" };
      if (error.status === 529 || error.status === 503) return { status: 529, type: "overloaded_error" };
      return { status: 502, type: "api_error" };
    default:
      return { status: 502, type: "api_error" };
  }
}
