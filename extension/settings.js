// Must match bridge/providers.mjs. None of the command-line tools lists its
// models non-interactively, so each list is fixed here:
// - Claude Code aliases always resolve to the latest model of that family.
// - Gemini CLI models are the ones its documentation offers.
// - An empty model uses the provider's default; for Codex, the one configured in Codex.
// Any other model name can be typed in through "직접 입력".
export const PROVIDERS = {
  claude: {
    label: "Claude (Claude Code)",
    models: [
      { value: "haiku", label: "Haiku · 최신, 빠름" },
      { value: "sonnet", label: "Sonnet · 최신" },
      { value: "opus", label: "Opus · 최신" },
      { value: "fable", label: "Fable · 최신" },
    ],
  },
  codex: {
    label: "OpenAI (Codex CLI)",
    models: [{ value: "", label: "Codex 기본 모델" }],
  },
  gemini: {
    label: "Google (Gemini CLI)",
    models: [
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash · 빠름" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-3-flash-preview", label: "Gemini 3 Flash · 미리보기" },
      { value: "gemini-3-pro-preview", label: "Gemini 3 Pro · 미리보기" },
    ],
  },
};

export const DEFAULT_SETTINGS = {
  provider: "claude",
  models: { claude: "haiku", codex: "", gemini: "gemini-2.5-flash" },
  targetLang: "ko",
  displayStyle: "dashed",
  maxSegmentsPerRequest: 8,
  maxCharsPerRequest: 3000,
};

// Settings of earlier versions: the HTTP bridge and a single Claude model.
export const OBSOLETE_SETTINGS = ["bridgeUrl", "token", "model"];

export const DISPLAY_STYLES = {
  dashed: "점선 밑줄",
  plain: "기본",
  faded: "흐리게",
  highlight: "배경 강조",
};

export async function loadSettings() {
  const settings = await chrome.storage.local.get(DEFAULT_SETTINGS);
  settings.models = { ...DEFAULT_SETTINGS.models, ...settings.models };
  if (!Object.hasOwn(PROVIDERS, settings.provider)) settings.provider = DEFAULT_SETTINGS.provider;
  return settings;
}

// What a translation depends on besides the text: provider, model and language.
export function translationKey(settings) {
  return [settings.provider, settings.models[settings.provider], settings.targetLang].join("\u0000");
}
