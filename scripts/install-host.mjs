#!/usr/bin/env node
// Registers the BYOS Translate native messaging host with Chrome and Edge for
// the current user, or removes it with --uninstall. No administrator rights
// are needed. Run it again after moving this folder.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultDataDir, loadConfig } from "../bridge/config.mjs";
import { HOST_NAME } from "../bridge/native-host.mjs";
import { PROVIDER_IDS } from "../bridge/providers.mjs";
import { resolveCommand } from "../bridge/resolve-command.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOST_SCRIPT = join(ROOT, "bridge", "native-host.mjs");
const WINDOWS_LAUNCHER = join(ROOT, "bridge", "native-host.cmd");
const MIN_NODE_MAJOR = 22;
const REGISTRY_KEYS = {
  Chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
  Edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
};

// Chrome derives an unpacked extension's ID from the manifest key: the first
// 32 hex digits of SHA-256 over the key bytes, with 0-f mapped to a-p.
export function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
  return [...digest.slice(0, 32)].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

export function hostManifest(launcherPath, extensionId) {
  return {
    name: HOST_NAME,
    description: "BYOS Translate bridge to the local Claude Code",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}

// Browser profile folders on macOS and Linux; the host manifest goes in their
// NativeMessagingHosts subfolder.
function browserDirs() {
  const home = homedir();
  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    return {
      Chrome: join(support, "Google", "Chrome"),
      Edge: join(support, "Microsoft Edge"),
      Chromium: join(support, "Chromium"),
    };
  }
  const config = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return {
    Chrome: join(config, "google-chrome"),
    Edge: join(config, "microsoft-edge"),
    Chromium: join(config, "chromium"),
  };
}

function version({ command, prefixArgs }) {
  try {
    return execFileSync(command, [...prefixArgs, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
      windowsHide: true,
    }).trim().split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function registryValue(key) {
  try {
    const output = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return /REG_SZ\s+(.+)$/m.exec(output)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

// The browser starts the host with the user's environment, so the tools are
// resolved the same way the host resolves them.
function checkTools(config) {
  const problems = [];
  // The Windows launcher runs `node` from PATH; elsewhere the launcher names this node.
  const node = process.platform === "win32" ? resolveCommand("node") : { command: process.execPath, prefixArgs: [], found: true };
  const nodeVersion = node.found ? version(node) : null;
  const nodeMajor = Number(/^v(\d+)/.exec(nodeVersion ?? "")?.[1]);
  if (!nodeVersion) problems.push("node was not found on PATH.");
  else if (nodeMajor < MIN_NODE_MAJOR) problems.push(`node on PATH is ${nodeVersion}; ${MIN_NODE_MAJOR} or later is required.`);

  const providers = PROVIDER_IDS.map((id) => {
    const resolved = resolveCommand(config[`${id}Command`]);
    return { id, resolved, version: resolved.found ? version(resolved) : null };
  });
  if (!providers.some(({ resolved }) => resolved.found)) {
    problems.push("None of claude, codex or gemini was found on PATH. Install one of them and sign in first.");
  }
  return { node: node.command, nodeVersion, providers, problems };
}

function install() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension", "manifest.json"), "utf8"));
  const extensionId = extensionIdFromKey(manifest.key);
  const dataDir = defaultDataDir();
  mkdirSync(dataDir, { recursive: true });

  const tools = checkTools(loadConfig(dataDir));
  console.log(`node    ${tools.nodeVersion ? `${tools.node} ${tools.nodeVersion}` : "(missing)"}`);
  for (const { id, resolved, version: found } of tools.providers) {
    console.log(`${id.padEnd(7)} ${resolved.found ? `${resolved.prefixArgs[0] ?? resolved.command} ${found ?? ""}` : "(not installed)"}`);
  }

  const registered = [];
  if (process.platform === "win32") {
    const manifestPath = join(dataDir, `${HOST_NAME}.json`);
    writeFileSync(manifestPath, `${JSON.stringify(hostManifest(WINDOWS_LAUNCHER, extensionId), null, 2)}\n`);
    for (const [browser, key] of Object.entries(REGISTRY_KEYS)) {
      const previous = registryValue(key);
      if (previous && previous !== manifestPath) console.log(`${browser}: replacing previous registration ${previous}`);
      execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "ignore" });
      registered.push(`${browser} (${key})`);
    }
  } else {
    const launcher = join(dataDir, "native-host.sh");
    // Browsers started from the desktop often lack the shell PATH, so the tools found now are added.
    const toolDirs = tools.providers.filter(({ resolved }) => resolved.found).map(({ resolved }) => dirname(resolved.command));
    const path = [...new Set([dirname(process.execPath), ...toolDirs])].join(":");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        "# Generated by `npm run install-host`; started by the browser through native messaging.",
        `PATH=${shellQuote(path)}:"$PATH" exec ${shellQuote(process.execPath)} ${shellQuote(HOST_SCRIPT)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    const body = `${JSON.stringify(hostManifest(launcher, extensionId), null, 2)}\n`;
    for (const [browser, dir] of Object.entries(browserDirs())) {
      if (!existsSync(dir)) continue;
      const hostsDir = join(dir, "NativeMessagingHosts");
      mkdirSync(hostsDir, { recursive: true });
      writeFileSync(join(hostsDir, `${HOST_NAME}.json`), body);
      registered.push(`${browser} (${hostsDir})`);
    }
  }

  console.log(`extension ID  ${extensionId}`);
  console.log(registered.length > 0 ? `registered    ${registered.join(", ")}` : "No Chrome, Edge or Chromium profile was found.");
  for (const problem of tools.problems) console.log(`WARNING: ${problem}`);
  console.log("Next: load the extension folder in chrome://extensions (Developer mode > Load unpacked).");
  return tools.problems.length === 0 && registered.length > 0;
}

function uninstall() {
  const dataDir = defaultDataDir();
  if (process.platform === "win32") {
    for (const [browser, key] of Object.entries(REGISTRY_KEYS)) {
      if (registryValue(key) === null) continue;
      execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
      console.log(`${browser}: removed ${key}`);
    }
    rmSync(join(dataDir, `${HOST_NAME}.json`), { force: true });
  } else {
    for (const [browser, dir] of Object.entries(browserDirs())) {
      const file = join(dir, "NativeMessagingHosts", `${HOST_NAME}.json`);
      if (!existsSync(file)) continue;
      rmSync(file);
      console.log(`${browser}: removed ${file}`);
    }
    rmSync(join(dataDir, "native-host.sh"), { force: true });
  }
  console.log(`Settings and logs remain in ${dataDir}.`);
  return true;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const ok = process.argv.includes("--uninstall") ? uninstall() : install();
  process.exit(ok ? 0 : 1);
}
