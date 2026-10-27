// Must match bridge/providers.mjs. An empty model uses the provider's default;
// for Codex that is the model configured in Codex itself.
export const PROVIDERS = {
  claude: { label: "Claude (Claude Code)", suggestions: ["haiku", "sonnet", "opus"] },
  codex: { label: "OpenAI (Codex CLI)", suggestions: [] },
  gemini: { label: "Google (Gemini CLI)", suggestions: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"] },
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
