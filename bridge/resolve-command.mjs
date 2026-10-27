// Resolves a command name to something spawn() can start without a shell.
//
// On Windows, npm installs CLIs as .cmd shims, and Node refuses to spawn .cmd
// files without a shell. Running through cmd.exe would need command-line
// escaping, so the shim's JavaScript entry point is started with node instead.
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, win32 } from "node:path";

const WINDOWS_EXTENSIONS = [".exe", ".cmd"];
// npm's cmd-shim ends with: "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*
const SHIM_ENTRY = /"%dp0%\\([^"]+\.(?:c|m)?js)"\s+%\*/i;

// Returns { command, prefixArgs } for the entry point of an npm .cmd shim.
export function resolveShim(shimPath) {
  const match = SHIM_ENTRY.exec(readFileSync(shimPath, "utf8"));
  if (!match) return null;
  const dir = dirname(shimPath);
  const bundledNode = join(dir, "node.exe");
  return {
    command: existsSync(bundledNode) ? bundledNode : process.execPath,
    prefixArgs: [win32.join(dir, match[1])],
  };
}

function searchPath(name, { platform, env }) {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const extensions = platform === "win32" && !/\.[a-z0-9]+$/i.test(name) ? WINDOWS_EXTENSIONS : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// Returns { command, prefixArgs, found }. A command that cannot be found is
// returned unchanged so spawn() reports it, and found is false.
export function resolveCommand(command, { platform = process.platform, env = process.env } = {}) {
  const isPath = /[\\/]/.test(command);
  const path = isPath ? (existsSync(command) ? command : null) : searchPath(command, { platform, env });
  if (!path) return { command, prefixArgs: [], found: false };
  if (platform === "win32" && /\.(cmd|bat)$/i.test(path)) {
    const shim = resolveShim(path);
    if (!shim) return { command: path, prefixArgs: [], found: false, unsupported: true };
    return { ...shim, found: true };
  }
  return { command: path, prefixArgs: [], found: true };
}
