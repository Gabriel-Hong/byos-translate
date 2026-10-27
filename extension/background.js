import { buildSystemPrompt, buildUserPrompt, parseBatchResponse } from "./protocol.js";
import { loadSettings, OBSOLETE_SETTINGS, PROVIDERS, translationKey } from "./settings.js";

const CACHE_LIMIT = 3000;
const MAX_PARALLEL_REQUESTS = 3;
const MENU_ID = "byos-toggle";
// Must match HOST_NAME in bridge/native-host.mjs.
const HOST_NAME = "io.github.byos_translate";
// Closing the idle port lets the bridge and its provider processes exit.
const HOST_IDLE_MS = 10 * 60_000;

class BridgeError extends Error {}

// Translations live only in this worker's memory; the browser may discard them
// when it stops an idle service worker.
const cache = new Map();
let running = 0;
const waiting = [];

function cacheKey(settings, text) {
  return `${translationKey(settings)}\u0000${text}`;
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

// The browser starts the bridge (native messaging host) on the first connect
// and stops it when the port closes. One port carries every request.
let port = null;
let nextRequestId = 1;
let idleTimer = null;
const pendingRequests = new Map();

function hostErrorMessage(detail) {
  if (/not found/i.test(detail)) {
    return "브리지가 설치되지 않았습니다. repo 폴더에서 'npm run install-host'를 실행하세요.";
  }
  if (/forbidden/i.test(detail)) {
    return "이 확장이 브리지에 등록되지 않았습니다. 'npm run install-host'를 다시 실행하세요.";
  }
  return `브리지와 통신하지 못했습니다(${detail}). 데이터 폴더의 native-host.log를 확인하세요.`;
}

function hostPort() {
  if (port) return port;
  const opened = chrome.runtime.connectNative(HOST_NAME);
  opened.onMessage.addListener((message) => {
    const request = pendingRequests.get(message?.id);
    if (!request) return;
    pendingRequests.delete(message.id);
    request.resolve(message);
    scheduleIdleDisconnect();
  });
  opened.onDisconnect.addListener(() => {
    const error = new BridgeError(hostErrorMessage(chrome.runtime.lastError?.message ?? "연결이 끊겼습니다"));
    if (port === opened) port = null;
    clearTimeout(idleTimer);
    for (const request of pendingRequests.values()) request.reject(error);
    pendingRequests.clear();
  });
  port = opened;
  return port;
}

function scheduleIdleDisconnect() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pendingRequests.size > 0 || !port) return;
    port.disconnect();
    port = null;
  }, HOST_IDLE_MS);
}

async function callHost(message) {
  const reply = await new Promise((resolve, reject) => {
    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });
    clearTimeout(idleTimer);
    try {
      hostPort().postMessage({ id, ...message });
    } catch (error) {
      pendingRequests.delete(id);
      reject(new BridgeError(hostErrorMessage(String(error?.message ?? error))));
    }
  });
  if (!reply.ok) throw new BridgeError(`브리지 오류: ${reply.error?.message ?? "알 수 없는 오류"}`);
  return reply.result;
}

async function translateBatch(settings, texts, pageTitle) {
  const body = await withSlot(() =>
    callHost({
      type: "messages",
      body: {
        provider: settings.provider,
        model: settings.models[settings.provider],
        system: buildSystemPrompt(settings.targetLang),
        messages: [{ role: "user", content: buildUserPrompt(texts, { pageTitle }) }],
      },
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

// Reports whether the chosen provider's tool is installed and, for Claude Code,
// starts processes ahead of time so a translation started from the popup does
// not wait for it to boot.
async function checkBridge() {
  const settings = await loadSettings();
  const { label } = PROVIDERS[settings.provider];
  try {
    const status = await callHost({
      type: "warmup",
      provider: settings.provider,
      model: settings.models[settings.provider],
      system: buildSystemPrompt(settings.targetLang),
    });
    const provider = status.providers[settings.provider];
    if (!provider.available) {
      return { ok: false, message: `${label}를 찾을 수 없습니다. 설치하고 로그인한 뒤 브라우저를 다시 시작하세요.` };
    }
    const warm = provider.idle ? ` · 대기 프로세스 ${provider.idle}개` : "";
    return { ok: true, message: `연결됨 · ${label}${warm}` };
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
  chrome.storage.local.remove(OBSOLETE_SETTINGS);
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

// Settings for content scripts, which compare translationKey to decide
// whether existing translations still apply.
async function pageSettings() {
  const settings = await loadSettings();
  return { ...settings, translationKey: translationKey(settings) };
}

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  const relevant = ["provider", "models", "targetLang", "displayStyle", "maxSegmentsPerRequest", "maxCharsPerRequest"];
  if (!relevant.some((key) => key in changes)) return;
  const settings = await pageSettings();
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) sendToTab(tab.id, { type: "byos:settings-changed", settings }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handle = async () => {
    switch (message?.type) {
      case "byos:settings":
        return pageSettings();
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
