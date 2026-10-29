import { t } from "./i18n.js";
import { LANGUAGES } from "./protocol.js";

// Must match bridge/providers.mjs. Model choices per provider:
// - Claude Code aliases always resolve to the latest model of that family.
// - Codex lists the models the signed-in account can use (codex app-server
//   model/list); `listsModels` adds them after the fixed entries.
// - Gemini CLI models are the ones its documentation offers; it cannot list them.
// - An empty model uses the provider's default; for Codex, the one configured in Codex.
// Any other model name can be typed in through the custom entry.
export const PROVIDERS = {
  claude: {
    label: "Claude (Claude Code)",
    models: [
      { value: "haiku", label: `Haiku · ${t("modelLatestFast")}` },
      { value: "sonnet", label: `Sonnet · ${t("modelLatest")}` },
      { value: "opus", label: `Opus · ${t("modelLatest")}` },
      { value: "fable", label: `Fable · ${t("modelLatest")}` },
    ],
  },
  codex: {
    label: "OpenAI (Codex CLI)",
    models: [{ value: "", label: t("codexDefaultModel") }],
    listsModels: true,
  },
  gemini: {
    label: "Google (Gemini CLI)",
    models: [
      { value: "gemini-2.5-flash", label: `Gemini 2.5 Flash · ${t("modelFast")}` },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { value: "gemini-3-flash-preview", label: `Gemini 3 Flash · ${t("modelPreview")}` },
      { value: "gemini-3-pro-preview", label: `Gemini 3 Pro · ${t("modelPreview")}` },
    ],
  },
};

// The browser's language when LANGUAGES has it, otherwise English.
function browserLanguage() {
  const tag = chrome.i18n.getUILanguage();
  if (Object.hasOwn(LANGUAGES, tag)) return tag;
  const [base] = tag.split("-");
  if (base === "zh") return /tw|hk|mo|hant/i.test(tag) ? "zh-TW" : "zh-CN";
  return Object.hasOwn(LANGUAGES, base) ? base : "en";
}

export const DEFAULT_SETTINGS = {
  provider: "claude",
  models: { claude: "haiku", codex: "", gemini: "gemini-2.5-flash" },
  targetLang: browserLanguage(),
  displayStyle: "dashed",
  maxSegmentsPerRequest: 8,
  maxCharsPerRequest: 3000,
  // When the AI cannot answer, the browser's on-device translator fills in.
  machineFallback: true,
};

// Settings of earlier versions: the HTTP bridge and a single Claude model.
export const OBSOLETE_SETTINGS = ["bridgeUrl", "token", "model"];

export const DISPLAY_STYLES = {
  dashed: t("displayDashed"),
  plain: t("displayPlain"),
  faded: t("displayFaded"),
  highlight: t("displayHighlight"),
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
