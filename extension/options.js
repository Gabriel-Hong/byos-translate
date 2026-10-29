import { localizePage, t } from "./i18n.js";
import { bindModelPicker } from "./model-picker.js";
import { LANGUAGES } from "./protocol.js";
import { DISPLAY_STYLES, loadSettings } from "./settings.js";

const $ = (id) => document.getElementById(id);
localizePage();
const TEXT_FIELDS = ["targetLang", "displayStyle"];
const NUMBER_FIELDS = ["maxSegmentsPerRequest", "maxCharsPerRequest"];
const CHECK_FIELDS = ["machineFallback"];

function readForm() {
  const values = {};
  for (const id of TEXT_FIELDS) values[id] = $(id).value.trim();
  for (const id of NUMBER_FIELDS) values[id] = Number($(id).value);
  for (const id of CHECK_FIELDS) values[id] = $(id).checked;
  return values;
}

async function init() {
  const settings = await loadSettings();
  for (const [code, name] of Object.entries(LANGUAGES)) $("targetLang").add(new Option(`${name} (${code})`, code));
  for (const [value, label] of Object.entries(DISPLAY_STYLES)) $("displayStyle").add(new Option(label, value));
  for (const id of [...TEXT_FIELDS, ...NUMBER_FIELDS]) $(id).value = settings[id];
  for (const id of CHECK_FIELDS) $(id).checked = settings[id];

  const check = async () => {
    $("checkResult").textContent = t("checking");
    $("checkResult").className = "status";
    const result = await chrome.runtime.sendMessage({ type: "byos:check" });
    $("checkResult").textContent = result.message;
    $("checkResult").className = `status ${result.ok ? "ok" : "bad"}`;
  };
  bindModelPicker({ provider: $("provider"), model: $("model"), customModel: $("customModel") }, settings, check);
  $("check").addEventListener("click", check);

  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await chrome.storage.local.set(readForm());
    $("saved").textContent = t("saved");
    setTimeout(() => ($("saved").textContent = ""), 2000);
  });
}

init();
