// Parsing of the extension's requests (an Anthropic Messages body) and the
// matching response shape.
//
// Claude Code accepts one user turn per process and has no sampling flags, so
// exactly one user message is accepted and sampling fields such as max_tokens,
// temperature and thinking are ignored.
import { randomUUID } from "node:crypto";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-[\]]{0,99}$/;
// The system prompt travels on the command line (Windows caps it at 32767 chars).
export const MAX_SYSTEM_CHARS = 20_000;
export const MAX_PROMPT_CHARS = 400_000;

function invalid(message) {
  return { ok: false, error: { type: "invalid_request_error", message } };
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

// Model and system prompt select a Claude Code process, for requests and warm-ups alike.
export function parseProcessKey({ model, system }, { defaultModel }) {
  const chosen = model ?? defaultModel;
  if (typeof chosen !== "string" || !MODEL_PATTERN.test(chosen)) {
    return invalid("model must be a Claude model name or alias such as haiku, sonnet or claude-haiku-4-5.");
  }
  let text = "";
  if (system !== undefined && system !== null) {
    text = textContent(system);
    if (text === null) return invalid("system must be a string or an array of text blocks.");
  }
  if (text.length > MAX_SYSTEM_CHARS) {
    return invalid(`system must be at most ${MAX_SYSTEM_CHARS} characters.`);
  }
  return { ok: true, value: { model: chosen, system: text } };
}

export function parseMessagesRequest(body, { defaultModel }) {
  if (!isObject(body)) return invalid("Request body must be a JSON object.");
  if (body.stream === true) return invalid("stream=true is not supported by this bridge.");

  const key = parseProcessKey(body, { defaultModel });
  if (!key.ok) return key;

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

  return { ok: true, value: { ...key.value, prompt } };
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

// Maps a RunnerError to an Anthropic error type.
export function runnerErrorType(error) {
  switch (error.kind) {
    case "busy":
      return "rate_limit_error";
    case "closed":
      return "overloaded_error";
    case "upstream":
      if (error.status === 429) return "rate_limit_error";
      if (error.status === 529 || error.status === 503) return "overloaded_error";
      return "api_error";
    default:
      return "api_error";
  }
}
