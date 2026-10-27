#!/usr/bin/env node
// End-to-end check in the installed Google Chrome against the running bridge.
//
// Branded Chrome ignores --load-extension since 137, so the unmodified
// extension is installed with CDP Extensions.loadUnpacked over
// --remote-debugging-pipe in a throwaway profile. Translation is started by
// invoking the toolbar action (Extensions.triggerAction) and pressing the popup
// button, which is the same activeTab path a user takes.
//
// Usage: npm run bridge   (in another terminal)
//        npm run e2e:chrome [-- <page-url>]
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../bridge/config.mjs";

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

const config = loadConfig();
const bridgeUrl = `http://127.0.0.1:${config.port}`;
try {
  await fetch(`${bridgeUrl}/health`);
} catch {
  console.error(`The bridge is not reachable at ${bridgeUrl}. Start it with 'npm run bridge' first.`);
  process.exit(1);
}
const chromePath = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
if (!chromePath) {
  console.error("Google Chrome was not found. Set CHROME_PATH.");
  process.exit(1);
}

let fixtureServer;
let pageUrl = process.argv[2];
if (!pageUrl) {
  const html = readFileSync(FIXTURE);
  fixtureServer = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  // 127.0.0.2 is outside the manifest's 127.0.0.1/localhost host permissions,
  // so the page is reachable only through the activeTab grant.
  await new Promise((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(0, "127.0.0.2", resolve);
  });
  pageUrl = `http://127.0.0.2:${fixtureServer.address().port}/article.html`;
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
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
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

const STATE = `(() => {
  const nodes = [...document.querySelectorAll("byos-tr")];
  const count = (name) => nodes.filter((node) => node.classList.contains(name)).length;
  return { total: nodes.length, loading: count("byos-loading"), done: count("byos-done"), error: count("byos-error") };
})()`;

// Opens the popup through the toolbar action and presses its toggle button.
async function pressPopupToggle(extensionId, expectedLabel) {
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
      if (!status || status.includes("확인 중")) return null;
      const tabs = await chrome.tabs.query({ currentWindow: true });
      return {
        label: document.getElementById("toggle").textContent,
        status,
        tabs: tabs.map((t) => (t.active ? "*" : "") + t.id + ":" + (t.url ?? "(no access)")).join(" "),
      };
    })()`).catch(() => null),
    { label: "popup" },
  );
  console.log(`popup: "${ready.label}" | ${ready.status} | tabs ${ready.tabs}`);
  if (ready.label !== expectedLabel) throw new Error(`popup button says "${ready.label}", expected "${expectedLabel}"`);
  await evaluate(session, `document.getElementById("toggle").click(), true`).catch(() => {});
  await sleep(500);
  const popupError = await evaluate(session, `document.getElementById("pageError").hidden ? "" : document.getElementById("pageError").textContent`)
    .catch(() => "");
  if (popupError) throw new Error(`popup reported: ${popupError}`);
}

let failed = false;
try {
  console.log(`browser: ${(await send("Browser.getVersion")).product}`);
  const { id: extensionId } = await send("Extensions.loadUnpacked", { path: EXTENSION_DIR });
  const worker = await findTarget(
    (target) => target.type === "service_worker" && target.url.startsWith(`chrome-extension://${extensionId}/`),
    "extension service worker",
  );
  const workerSession = await attach(worker.targetId);
  await send(
    "Extensions.setStorageItems",
    { id: extensionId, storageArea: "local", values: { bridgeUrl, token: config.token } },
    workerSession,
  );

  const { targetId } = await send("Target.createTarget", { url: pageUrl });
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
  await pressPopupToggle(extensionId, "이 페이지 번역");
  const first = await waitFor(async () => {
    const state = await evaluate(page, STATE);
    return state.total > 0 && state.loading === 0 ? state : null;
  }, { timeoutMs: 180_000, label: "translations" });
  console.log(`first screen: ${first.done} translated, ${first.error} failed, ${Date.now() - started} ms`);
  const sample = await evaluate(page, `[...document.querySelectorAll("byos-tr.byos-done")].slice(0, 5).map((n) => n.textContent.slice(0, 50))`);
  for (const line of sample) console.log(`  ${line}`);
  const screenshot = join(tmpdir(), `byos-e2e-chrome-${Date.now()}.png`);
  writeFileSync(screenshot, Buffer.from((await send("Page.captureScreenshot", { format: "png" }, page)).data, "base64"));
  console.log(`screenshot: ${screenshot}`);

  await evaluate(page, `window.scrollBy(0, 2500), true`);
  const scrolled = await waitFor(async () => {
    const state = await evaluate(page, STATE);
    return state.total > first.total && state.loading === 0 ? state : null;
  }, { timeoutMs: 120_000, label: "translation after scrolling" }).catch(() => evaluate(page, STATE));
  console.log(`after scrolling: ${scrolled.done} translated, ${scrolled.error} failed`);

  await pressPopupToggle(extensionId, "원문만 보기");
  await waitFor(async () => (await evaluate(page, STATE)).total === 0, { label: "translations removed" });
  console.log("toggle off: all translations removed");

  if (first.error > 0 || scrolled.error > 0) throw new Error("some blocks failed to translate");
  console.log("PASS");
} catch (error) {
  failed = true;
  console.error(`FAIL: ${error.message}`);
} finally {
  await send("Browser.close").catch(() => {});
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(5000)]);
  child.kill();
  fixtureServer?.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
