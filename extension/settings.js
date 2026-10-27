export const DEFAULT_SETTINGS = {
  bridgeUrl: "http://127.0.0.1:18765",
  token: "",
  model: "haiku",
  targetLang: "ko",
  displayStyle: "dashed",
  maxSegmentsPerRequest: 8,
  maxCharsPerRequest: 3000,
};

export const DISPLAY_STYLES = {
  dashed: "점선 밑줄",
  plain: "기본",
  faded: "흐리게",
  highlight: "배경 강조",
};

export async function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

// Settings a content script needs; the bridge token never leaves the worker.
export function pageSettings(settings) {
  return {
    model: settings.model,
    targetLang: settings.targetLang,
    displayStyle: settings.displayStyle,
    maxSegmentsPerRequest: settings.maxSegmentsPerRequest,
    maxCharsPerRequest: settings.maxCharsPerRequest,
  };
}
