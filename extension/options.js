import { LANGUAGES } from "./protocol.js";
import { DISPLAY_STYLES, loadSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = ["bridgeUrl", "token", "model", "targetLang", "displayStyle"];
const NUMBER_FIELDS = ["maxSegmentsPerRequest", "maxCharsPerRequest"];

function readForm() {
  const values = {};
  for (const id of TEXT_FIELDS) values[id] = $(id).value.trim();
  for (const id of NUMBER_FIELDS) values[id] = Number($(id).value);
  values.bridgeUrl = values.bridgeUrl.replace(/\/+$/, "");
  return values;
}

async function init() {
  const settings = await loadSettings();
  for (const [code, name] of Object.entries(LANGUAGES)) $("targetLang").add(new Option(`${name} (${code})`, code));
  for (const [value, label] of Object.entries(DISPLAY_STYLES)) $("displayStyle").add(new Option(label, value));
  for (const id of [...TEXT_FIELDS, ...NUMBER_FIELDS]) $(id).value = settings[id];

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await chrome.storage.local.set(readForm());
    $("saved").textContent = "저장했습니다.";
    setTimeout(() => ($("saved").textContent = ""), 2000);
  });

  $("check").addEventListener("click", async () => {
    await chrome.storage.local.set({ bridgeUrl: readForm().bridgeUrl, token: readForm().token });
    $("checkResult").textContent = "확인 중…";
    const result = await chrome.runtime.sendMessage({ type: "byos:check" });
    $("checkResult").textContent = result.message;
    $("checkResult").className = `status ${result.ok ? "ok" : "bad"}`;
  });
}

init();
