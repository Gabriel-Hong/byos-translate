import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR = "byos-translate";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const DEFAULT_CONFIG = Object.freeze({
  host: "127.0.0.1",
  port: 18765,
  defaultModel: "haiku",
  claudeCommand: "claude",
  maxConcurrent: 4,
  warmPerKey: 2,
  maxIdleProcesses: 4,
  idleTtlMs: 10 * 60_000,
  requestTimeoutMs: 120_000,
});

export function defaultDataDir() {
  if (process.env.BYOS_DATA_DIR) return process.env.BYOS_DATA_DIR;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), APP_DIR);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_DIR);
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), APP_DIR);
}

// Reads config.json, adding a token on first run. Existing fields are never
// rewritten, and a malformed file is reported instead of being replaced.
export function loadConfig(dataDir = defaultDataDir()) {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "config.json");
  let stored = {};
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Cannot read ${file}: ${error.message}. Fix or remove the file and retry.`);
    }
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(`${file} must contain a JSON object.`);
  }
  if (typeof stored.token !== "string" || stored.token.length < 16) {
    stored = { ...stored, token: randomBytes(24).toString("base64url") };
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }
  const config = { ...DEFAULT_CONFIG, ...stored, dataDir, configFile: file };
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!LOOPBACK_HOSTS.has(config.host)) {
    throw new Error(`host must be a loopback address (127.0.0.1, ::1, localhost), got ${config.host}`);
  }
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`port must be an integer between 0 and 65535, got ${config.port}`);
  }
  for (const key of ["maxConcurrent", "warmPerKey", "maxIdleProcesses", "idleTtlMs", "requestTimeoutMs"]) {
    const value = config[key];
    const min = key === "maxConcurrent" ? 1 : 0;
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${key} must be an integer >= ${min}, got ${value}`);
    }
  }
  if (typeof config.claudeCommand !== "string" || config.claudeCommand.length === 0) {
    throw new Error("claudeCommand must be a non-empty string");
  }
}
