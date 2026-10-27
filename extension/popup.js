import { bindModelPicker } from "./model-picker.js";
import { LANGUAGES } from "./protocol.js";
import { loadSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);

function fillLanguages(select, selected) {
  for (const [code, name] of Object.entries(LANGUAGES)) {
    select.add(new Option(`${name} (${code})`, code, false, code === selected));
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showToggle(enabled) {
  $("toggle").textContent = enabled ? "원문만 보기" : "이 페이지 번역";
}

async function showBridgeStatus() {
  $("bridge").textContent = "브리지 확인 중…";
  $("bridge").className = "status";
  const check = await chrome.runtime.sendMessage({ type: "byos:check" });
  $("bridge").textContent = `● ${check.message}`;
  $("bridge").className = `status ${check.ok ? "ok" : "bad"}`;
}

async function init() {
  const settings = await loadSettings();
  fillLanguages($("targetLang"), settings.targetLang);
  bindModelPicker(
    { provider: $("provider"), model: $("model"), customModel: $("customModel") },
    settings,
    showBridgeStatus,
  );

  $("targetLang").addEventListener("change", (event) => chrome.storage.local.set({ targetLang: event.target.value }));
  $("openOptions").addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const tab = await activeTab();
  try {
    showToggle((await chrome.tabs.sendMessage(tab.id, { type: "byos:status" }))?.enabled);
  } catch {
    showToggle(false);
  }

  $("toggle").addEventListener("click", async () => {
    $("pageError").hidden = true;
    const result = await chrome.runtime.sendMessage({ type: "byos:toggle-tab", tabId: tab.id });
    if (result?.error) {
      $("pageError").textContent = `이 페이지에서는 실행할 수 없습니다: ${result.error}`;
      $("pageError").hidden = false;
      return;
    }
    showToggle(result?.enabled);
    if (result?.enabled) window.close();
  });

  await showBridgeStatus();
}

init();
