#!/usr/bin/env node
// End-to-end check in the installed Google Chrome with the installed bridge.
//
// Branded Chrome ignores --load-extension since 137, so the unmodified
// extension is installed with CDP Extensions.loadUnpacked over
// --remote-debugging-pipe in a throwaway profile. Translation is started by
// invoking the toolbar action (Extensions.triggerAction) and pressing the popup
// button, which is the same activeTab path a user takes; Chrome then starts the
// bridge through native messaging.
//
// With --interactive the automated steps are skipped and the window stays open
// for manual testing until it is closed; the temporary profile is then deleted.
//
// Usage: npm run install-host   (once)
//        npm run e2e:chrome [-- [<page-url>] [--fallback] [--lang=<code>]]
//          --fallback: the browser translates instead of the AI
//          --lang: Chrome's UI language, which the extension's menus follow (Windows and Linux)
//        npm run try:chrome [-- <page-url>] [--lang=<code>]   (same as --interactive)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extensionIdFromKey } from "./install-host.mjs";

const EXTENSION_DIR = fileURLToPath(new URL("../extension/", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../test/fixtures/article.html", import.meta.url));
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, { timeoutMs = 30_000, label }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(250);
  }
}

// CDP over --remote-debugging-pipe: NUL-separated JSON on fds 3 (to Chrome) and 4.
function connect(child) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();
  child.stdio[4].setEncoding("utf8");
  child.stdio[4].on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const waiter = message.id && pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
      else waiter.resolve(message.result);
    }
  });
  return (method, params = {}, sessionId) => {
    const id = nextId++;
    child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
  };
}

const expectedExtensionId = extensionIdFromKey(
  JSON.parse(readFileSync(join(EXTENSION_DIR, "manifest.json"), "utf8")).key,
);
const chromePath = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
if (!chromePath) {
  console.error("Google Chrome was not found. Set CHROME_PATH.");
  process.exit(1);
}

const args = process.argv.slice(2);
const interactive = args.includes("--interactive");
// The AI is made to fail with a model name no provider has, so every block
// must come from the browser's translator after one click fetches its model.
const fallback = args.includes("--fallback");
const lang = args.filter((arg) => arg.startsWith("--lang="));
let fixtureServer;
let pageUrl = args.find((arg) => !arg.startsWith("--"));
if (!pageUrl) {
  const html = readFileSync(FIXTURE);
  fixtureServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  // The manifest has no host permissions, so the page is reachable only
  // through the activeTab grant.
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${fixtureServer.address().port}/article.html`;
}

const profile = mkdtempSync(join(tmpdir(), "byos-e2e-chrome-"));
const child = spawn(chromePath, [
  "--remote-debugging-pipe",
  "--enable-unsafe-extension-debugging",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-search-engine-choice-screen",
  "--window-size=1200,950",
  ...lang,
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
const exited = new Promise((resolve) => child.once("exit", resolve));
// Writing to the pipe after the window is closed must not crash the script.
child.stdio[3].on("error", () => {});
const send = connect(child);

async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value;
}

async function findTarget(predicate, label) {
  return waitFor(async () => (await send("Target.getTargets")).targetInfos.find(predicate), { label });
}

async function attach(targetId) {
  return (await send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
}

// The extension's text in the browser's UI language, read in the popup the
// first time it opens.
let ui = null;

// `duplicates` counts translations identical to their source block, which
// should be hidden rather than shown twice. `model` counts blocks waiting for
// a click to download the browser's translation model, and `machine` the
// translations the browser's translator made.
const pageState = () => `(() => {
  const nodes = [...document.querySelectorAll("byos-tr")];
  const count = (name) => nodes.filter((node) => node.classList.contains(name)).length;
  const normalize = (text) => text.replace(/\\s+/g, " ").trim();
  const duplicates = nodes.filter((node) => node.classList.contains("byos-done") && normalize(node.textContent) ===
    normalize([...node.parentElement.childNodes].filter((child) => child !== node).map((child) => child.textContent).join(""))).length;
  const model = nodes.filter((node) => node.classList.contains("byos-error") && node.textContent === ${JSON.stringify(ui.modelNeeded)}).length;
  const machine = nodes.filter((node) => node.classList.contains("byos-done") && node.title.startsWith(${JSON.stringify(ui.browserTranslator)})).length;
  return { total: nodes.length, loading: count("byos-loading"), done: count("byos-done"), error: count("byos-error"), duplicates, model, machine };
})()`;

// Clicks the first block that asks for the translation model, as a user would;
// the browser downloads a model only during a click on the page.
async function clickModelPrompt(page) {
  const point = await evaluate(page, `(() => {
    const node = [...document.querySelectorAll("byos-tr.byos-error")].find((n) => n.textContent === ${JSON.stringify(ui.modelNeeded)});
    node.scrollIntoView({ block: "center" });
    const rect = node.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 };
  })()`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }, page);
  }
}

// Opens the popup through the toolbar action and presses its toggle button,
// which must show the message `expectedKey`.
async function pressPopupToggle(extensionId, expectedKey) {
  const { targetInfos } = await send("Target.getTargets", { filter: [{ type: "tab" }] });
  const tab = targetInfos.find((target) => target.url === pageUrl);
  if (!tab) throw new Error(`no tab target for ${pageUrl}`);
  await send("Extensions.triggerAction", { id: extensionId, targetId: tab.targetId });
  const popup = await findTarget((target) => target.url === `chrome-extension://${extensionId}/popup.html`, "popup");
  const session = await attach(popup.targetId);
  // The bridge status is written after the toggle handler is attached.
  const ready = await waitFor(
    () => evaluate(session, `(async () => {
      const status = document.getElementById("bridge")?.textContent;
      if (!status || status === chrome.i18n.getMessage("checkingBridge")) return null;
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return {
        label: document.getElementById("toggle").textContent,
        expected: chrome.i18n.getMessage(${JSON.stringify(expectedKey)}),
        ui: {
          modelNeeded: chrome.i18n.getMessage("modelNeeded"),
          browserTranslator: chrome.i18n.getMessage("browserTranslator"),
        },
        status,
        tabs: tabs.map((t) => (t.active ? "*" : "") + t.id + ":" + (t.url ?? "(no access)")).join(" "),
      };
    })()`).catch(() => null),
    { label: "popup" },
  );
  ui ??= ready.ui;
  console.log(`popup: "${ready.label}" | ${ready.status} | tabs ${ready.tabs}`);
  if (ready.label !== ready.expected) throw new Error(`popup button says "${ready.label}", expected "${ready.expected}"`);
  await evaluate(session, `document.getElementById("toggle").click(), true`).catch(() => {});
  await sleep(500);
  const popupError = await evaluate(session, `document.getElementById("pageError").hidden ? "" : document.getElementById("pageError").textContent`)
    .catch(() => "");
  if (popupError) throw new Error(`popup reported: ${popupError}`);
}

// Translates the page, scrolls, and switches translation off again.
async function runScenario(extensionId, targetId) {
  const page = await attach(targetId);
  // A new tab starts on about:blank, which is also "complete"; wait for the real
  // document, because navigating away revokes the activeTab grant.
  const origin = JSON.stringify(new URL(pageUrl).origin);
  await waitFor(
    () => evaluate(page, `location.origin === ${origin} && document.readyState === "complete"`).catch(() => false),
    { timeoutMs: 60_000, label: "page load" },
  );
  // The action grants activeTab only once the tab has really become active.
  await send("Target.activateTarget", { targetId });
  await waitFor(() => evaluate(page, `document.visibilityState === "visible" && document.hasFocus()`), { label: "active tab" });
  await sleep(300);

  const started = Date.now();
  await pressPopupToggle(extensionId, "translatePage");
  const settled = () => waitFor(async () => {
    const state = await evaluate(page, pageState());
    return state.total > 0 && state.loading === 0 ? state : null;
  }, { timeoutMs: 180_000, label: "translations" });
  let first = await settled();
  if (fallback && first.model > 0) {
    console.log(`AI failed as intended; ${first.model} blocks ask for the translation model (${Date.now() - started} ms)`);
    await clickModelPrompt(page);
    first = await waitFor(async () => {
      const state = await evaluate(page, pageState());
      return state.loading === 0 && state.model === 0 ? state : null;
    }, { timeoutMs: 300_000, label: "model download and translation" });
  }
  console.log(`first screen: ${first.done} translated (${first.machine} by the browser), ${first.error} failed, ${Date.now() - started} ms`);
  const sample = await evaluate(page, `[...document.querySelectorAll("byos-tr.byos-done")].slice(0, 5).map((n) => n.textContent.slice(0, 50))`);
  for (const line of sample) console.log(`  ${line}`);
  const screenshot = join(tmpdir(), `byos-e2e-chrome-${Date.now()}.png`);
  writeFileSync(screenshot, Buffer.from((await send("Page.captureScreenshot", { format: "png" }, page)).data, "base64"));
  console.log(`screenshot: ${screenshot}`);

  await evaluate(page, `window.scrollBy(0, 2500), true`);
  const scrolled = await waitFor(async () => {
    const state = await evaluate(page, pageState());
    return state.total > first.total && state.loading === 0 ? state : null;
  }, { timeoutMs: 120_000, label: "translation after scrolling" }).catch(() => evaluate(page, pageState()));
  console.log(`after scrolling: ${scrolled.done} translated (${scrolled.machine} by the browser), ${scrolled.error} failed`);

  await pressPopupToggle(extensionId, "showOriginal");
  await waitFor(async () => (await evaluate(page, pageState())).total === 0, { label: "translations removed" });
  console.log("toggle off: all translations removed");

  if (first.error > 0 || scrolled.error > 0) throw new Error("some blocks failed to translate");
  if (first.duplicates > 0 || scrolled.duplicates > 0) throw new Error("some translations repeat their source");
  if (fallback && (first.machine !== first.done || scrolled.machine !== scrolled.done)) {
    throw new Error("some translations did not come from the browser's translator");
  }
  if (!fallback && (first.machine > 0 || scrolled.machine > 0)) throw new Error("the AI did not answer some blocks");
  console.log("PASS");
}

let failed = false;
try {
  console.log(`browser: ${(await send("Browser.getVersion")).product}`);
  const { id: extensionId } = await send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
  // The bridge registration allows only the ID derived from the manifest key.
  if (extensionId !== expectedExtensionId) {
    throw new Error(`extension ID ${extensionId} differs from the manifest key's ${expectedExtensionId}`);
  }
  const worker = await findTarget(
    (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
    "extension service worker",
  );
  const values = {
    // The checks expect Korean translations, whatever language the menus use.
    ...(!interactive && { targetLang: "ko" }),
    ...(fallback && { provider: "claude", models: { claude: "byos-e2e-unavailable" } }),
  };
  if (Object.keys(values).length > 0) {
    // Extensions.setStorageItems needs a session attached to the extension.
    await send("Extensions.setStorageItems", { id: extensionId, storageArea: "local", values }, await attach(worker.targetId));
  }
  const { targetId } = await send("Target.createTarget", { url: pageUrl });

  if (interactive) {
    console.log(`Chrome is open with BYOS Translate on ${pageUrl}`);
    console.log("Use Alt+Q, the puzzle-piece menu, or the right-click menu.");
    console.log("Close the Chrome window (or press Ctrl+C here) to finish; the temporary profile is then deleted.");
    await Promise.race([exited, new Promise((resolve) => process.once("SIGINT", resolve))]);
  } else {
    await runScenario(extensionId, targetId);
  }
} catch (error) {
  failed = true;
  console.error(`FAIL: ${error.message}`);
} finally {
  if (child.exitCode === null) {
    await Promise.race([send("Browser.close").catch(() => {}), sleep(3000)]);
    await Promise.race([exited, sleep(5000)]);
    child.kill();
  }
  fixtureServer?.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
