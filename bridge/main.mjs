#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeRunner } from "./claude-runner.mjs";
import { loadConfig } from "./config.mjs";
import { createBridgeServer } from "./server.mjs";

const args = process.argv.slice(2);
const config = loadConfig();

if (args.includes("--print-token")) {
  console.log(config.token);
  process.exit(0);
}

const portIndex = args.indexOf("--port");
if (portIndex >= 0) config.port = Number(args[portIndex + 1]);

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

// Claude Code runs in an empty, bridge-owned directory so no project
// CLAUDE.md, settings or memory from the caller's working directory apply.
const claudeCwd = join(config.dataDir, "claude-cwd");
mkdirSync(claudeCwd, { recursive: true });

const version = await new Promise((resolve) => {
  execFile(config.claudeCommand, ["--version"], { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
    resolve(error ? null : stdout.trim());
  });
});
if (!version) {
  console.error(`'${config.claudeCommand} --version' failed. Install Claude Code and sign in with 'claude' first,`);
  console.error(`or set claudeCommand in ${config.configFile}.`);
  process.exit(1);
}

const runner = new ClaudeRunner({
  command: config.claudeCommand,
  cwd: claudeCwd,
  maxConcurrent: config.maxConcurrent,
  warmPerKey: config.warmPerKey,
  maxIdleProcesses: config.maxIdleProcesses,
  idleTtlMs: config.idleTtlMs,
  requestTimeoutMs: config.requestTimeoutMs,
});
const server = createBridgeServer({ config, runner, log });

server.on("error", (error) => {
  console.error(`Cannot listen on ${config.host}:${config.port}: ${error.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const { port } = server.address();
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  console.log(`BYOS Translate bridge (${version})`);
  console.log(`  URL      http://${host}:${port}`);
  console.log(`  Messages http://${host}:${port}/v1/messages`);
  console.log(`  Token    ${config.token}`);
  console.log(`  Config   ${config.configFile}`);
  console.log("Press Ctrl+C to stop.");
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  log("stopping...");
  server.close();
  server.closeAllConnections?.();
  await runner.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
