// Batch translation prompt protocol shared by the service worker and tests.
//
// Each request carries several page segments. Every segment is introduced by a
// marker line ([[s0]], [[s1]], ...) and the list ends with [[end]]; the model
// answers with the same markers so each translation maps back to its segment
// even when a segment itself contains blank lines.

export const LANGUAGES = {
  ko: "Korean",
  en: "English",
  ja: "Japanese",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  vi: "Vietnamese",
};

const MARKER = /^\[\[s(\d+)\]\]$/;
const END_MARKER = "[[end]]";
const FENCE = /^```[\w-]*$/;

export function languageName(code) {
  return LANGUAGES[code] ?? code;
}

// The system prompt depends only on the target language so the bridge can keep
// Claude Code processes warm for it; page-specific context goes in the user turn.
export function buildSystemPrompt(targetLang) {
  const language = languageName(targetLang);
  return [
    `You translate web page text into natural, fluent ${language} for a bilingual reader view.`,
    "",
    "Input format: numbered segments. Each segment starts with a marker line such as [[s0]] and continues until the next marker line or the [[end]] line.",
    "",
    "Rules:",
    `- Translate every segment into ${language}. Use the other segments and the page title only as context.`,
    "- Reply with every marker line in the original order, each followed by its translation, then a final [[end]] line.",
    "- Output nothing else: no notes, explanations, apologies or code fences.",
    `- Keep URLs, e-mail addresses, code, file paths, version numbers and text already written in ${language} unchanged.`,
    "- Keep product names, brand names and people's names in their original form unless a well-known translation exists.",
    "- Preserve line breaks inside a segment.",
  ].join("\n");
}

export function buildUserPrompt(texts, { pageTitle } = {}) {
  const lines = [];
  if (pageTitle) lines.push(`Page title (context only): ${pageTitle}`, "");
  texts.forEach((text, index) => {
    lines.push(`[[s${index}]]`, text);
  });
  lines.push(END_MARKER);
  return lines.join("\n");
}

// Returns one translation per segment; segments the reply did not cover are null.
export function parseBatchResponse(reply, count) {
  const translations = new Array(count).fill(null);
  let current = -1;
  let buffer = [];
  const flush = () => {
    if (current >= 0 && current < count && translations[current] === null) {
      while (buffer.length > 0 && (buffer.at(-1).trim() === "" || FENCE.test(buffer.at(-1).trim()))) {
        buffer.pop();
      }
      const text = buffer.join("\n").trim();
      if (text) translations[current] = text;
    }
    buffer = [];
  };
  for (const line of reply.split(/\r?\n/)) {
    const trimmed = line.trim();
    const marker = MARKER.exec(trimmed);
    if (marker) {
      flush();
      current = Number(marker[1]);
      continue;
    }
    if (trimmed === END_MARKER) {
      flush();
      current = -1;
      break;
    }
    if (current >= 0) buffer.push(line);
  }
  flush();
  return translations;
}
