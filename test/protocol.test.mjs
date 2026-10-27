import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt, buildUserPrompt, parseBatchResponse } from "../extension/protocol.js";

test("builds a marker-delimited batch with page context", () => {
  const prompt = buildUserPrompt(["First paragraph.", "Line one\n\nLine two"], { pageTitle: "Docs" });
  assert.equal(
    prompt,
    "Page title (context only): Docs\n\n[[s0]]\nFirst paragraph.\n[[s1]]\nLine one\n\nLine two\n[[end]]",
  );
  assert.match(buildSystemPrompt("ko"), /into natural, fluent Korean/);
  assert.match(buildSystemPrompt("pt-BR"), /pt-BR/);
});

test("maps each translation back to its segment", () => {
  const reply = "[[s0]]\n첫 문단.\n[[s1]]\n첫 줄\n\n둘째 줄\n[[end]]";
  assert.deepEqual(parseBatchResponse(reply, 2), ["첫 문단.", "첫 줄\n\n둘째 줄"]);
});

test("tolerates fences, reordering and chatter outside markers", () => {
  const reply = "Here you go:\n```\n[[s1]]\n둘\n[[s0]]\n하나\n```";
  assert.deepEqual(parseBatchResponse(reply, 2), ["하나", "둘"]);
});

test("reports skipped, empty, duplicate and out-of-range segments as missing", () => {
  const reply = "[[s0]]\n하나\n[[s0]]\n중복\n[[s2]]\n\n[[s7]]\n범위 밖\n[[end]]\n[[s1]]\n끝 뒤";
  assert.deepEqual(parseBatchResponse(reply, 3), ["하나", null, null]);
});
