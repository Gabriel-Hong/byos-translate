import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_DIR = "byos-translate";

export const DEFAULT_CONFIG = Object.freeze({
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

function readStored(file) {
  let stored;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`Cannot read ${file}: ${error.message}. Fix or remove the file and retry.`);
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error(`${file} must contain a JSON object.`);
  }
  return stored;
}

// config.json holds optional overrides of DEFAULT_CONFIG; unknown keys are ignored.
export function loadConfig(dataDir = defaultDataDir()) {
  const configFile = join(dataDir, "config.json");
  const stored = readStored(configFile);
  const config = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (stored[key] !== undefined) config[key] = stored[key];
  }
  validateConfig(config);
  return { ...config, dataDir, configFile };
}

export function validateConfig(config) {
  for (const key of ["maxConcurrent", "warmPerKey", "maxIdleProcesses", "idleTtlMs", "requestTimeoutMs"]) {
    const value = config[key];
    const min = key === "maxConcurrent" ? 1 : 0;
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${key} must be an integer >= ${min}, got ${value}`);
    }
  }
  for (const key of ["claudeCommand", "defaultModel"]) {
    if (typeof config[key] !== "string" || config[key].length === 0) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
}
