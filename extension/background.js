import { buildSystemPrompt, buildUserPrompt, parseBatchResponse } from "./protocol.js";
import { loadSettings, pageSettings } from "./settings.js";

const CACHE_LIMIT = 3000;
const MAX_PARALLEL_REQUESTS = 3;
const MENU_ID = "byos-toggle";

class BridgeError extends Error {}

// Translations live only in this worker's memory; the browser may discard them
// when it stops an idle service worker.
const cache = new Map();
let running = 0;
const waiting = [];

function cacheKey(settings, text) {
  return `${settings.model}\u0000${settings.targetLang}\u0000${text}`;
}

function cacheGet(key) {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

async function withSlot(task) {
  if (running >= MAX_PARALLEL_REQUESTS) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

async function bridgeFetch(settings, path, init = {}) {
  if (!settings.token) {
    throw new BridgeError("브리지 토큰이 없습니다. 확장 옵션에 'npm run token' 출력값을 입력하세요.");
  }
  let response;
  try {
    response = await fetch(new URL(path, settings.bridgeUrl), {
      ...init,
      headers: { "x-api-key": settings.token, "anthropic-version": "2023-06-01", ...init.headers },
    });
  } catch {
    throw new BridgeError(`브리지(${settings.bridgeUrl})에 연결할 수 없습니다. 'npm run bridge'로 실행했는지 확인하세요.`);
  }
  const body = await response.json().catch(() => null);
  if (response.status === 401) {
    throw new BridgeError("브리지 토큰이 맞지 않습니다. 'npm run token' 값으로 옵션을 갱신하세요.");
  }
  if (!response.ok) {
    throw new BridgeError(`브리지 오류 ${response.status}: ${body?.error?.message ?? response.statusText}`);
  }
  return body;
}

async function translateBatch(settings, texts, pageTitle) {
  const body = await withSlot(() =>
    bridgeFetch(settings, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 8192,
        system: buildSystemPrompt(settings.targetLang),
        messages: [{ role: "user", content: buildUserPrompt(texts, { pageTitle }) }],
      }),
    }),
  );
  const reply = body?.content?.find?.((block) => block.type === "text")?.text ?? "";
  return parseBatchResponse(reply, texts.length);
}

// Translates one batch chosen by the content script. Cached segments are
// answered locally; segments the model skipped are retried once on their own.
async function translateTexts(texts, pageTitle) {
  const settings = await loadSettings();
  const results = texts.map((text) => cacheGet(cacheKey(settings, text)) ?? null);
  const store = (indexes, translations) => {
    const missing = [];
    translations.forEach((translation, position) => {
      const index = indexes[position];
      if (translation === null) {
        missing.push(index);
      } else {
        results[index] = translation;
        cacheSet(cacheKey(settings, texts[index]), translation);
      }
    });
    return missing;
  };

  const pending = results.flatMap((value, index) => (value === null ? [index] : []));
  let error = null;
  if (pending.length > 0) {
    try {
      const missing = store(pending, await translateBatch(settings, pending.map((i) => texts[i]), pageTitle));
      const retries = await Promise.allSettled(
        missing.map(async (index) => store([index], await translateBatch(settings, [texts[index]], pageTitle))),
      );
      error = retries.find((outcome) => outcome.status === "rejected")?.reason ?? null;
    } catch (caught) {
      error = caught;
    }
  }
  if (!error && results.includes(null)) error = new BridgeError("모델이 일부 문단에 답하지 않았습니다.");
  return { translations: results, error: error ? String(error.message ?? error) : null };
}

async function checkBridge() {
  const settings = await loadSettings();
  try {
    const status = await bridgeFetch(settings, "/v1/bridge/status");
    return { ok: true, message: `연결됨 · 대기 프로세스 ${status.runner.idle}개`, runner: status.runner };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

async function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

// Injects the content script on first use; activeTab grants access after the
// shortcut, the context menu or the popup.
async function toggleTab(tabId) {
  try {
    return await sendToTab(tabId, { type: "byos:toggle" });
  } catch {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return sendToTab(tabId, { type: "byos:toggle" });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "BYOS Translate 켜기/끄기",
    contexts: ["page", "selection", "link"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID && tab?.id !== undefined) toggleTab(tab.id).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-translation" && tab?.id !== undefined) toggleTab(tab.id).catch(() => {});
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  const relevant = ["model", "targetLang", "displayStyle", "maxSegmentsPerRequest", "maxCharsPerRequest"];
  if (!relevant.some((key) => key in changes)) return;
  const settings = pageSettings(await loadSettings());
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) sendToTab(tab.id, { type: "byos:settings-changed", settings }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    switch (message?.type) {
      case "byos:settings":
        return pageSettings(await loadSettings());
      case "byos:translate":
        return translateTexts(message.texts, message.pageTitle);
      case "byos:check":
        return checkBridge();
      case "byos:toggle-tab":
        return toggleTab(message.tabId);
      default:
        return undefined;
    }
  };
  handle().then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
  return true;
});
