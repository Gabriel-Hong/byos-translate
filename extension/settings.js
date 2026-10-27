export const DEFAULT_SETTINGS = {
  model: "haiku",
  targetLang: "ko",
  displayStyle: "dashed",
  maxSegmentsPerRequest: 8,
  maxCharsPerRequest: 3000,
};

// Settings of the HTTP bridge used before native messaging.
export const OBSOLETE_SETTINGS = ["bridgeUrl", "token"];

export const DISPLAY_STYLES = {
  dashed: "점선 밑줄",
  plain: "기본",
  faded: "흐리게",
  highlight: "배경 강조",
};

export async function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}
