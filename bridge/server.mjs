// Loopback HTTP server exposing an Anthropic Messages API subset backed by
// ClaudeRunner. Every API route requires the bridge token, and the Host header
// must name the loopback listener so DNS-rebinding pages cannot reach it.
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  BRIDGE_MODELS,
  errorBody,
  messageResponse,
  parseMessagesRequest,
  runnerErrorResponse,
} from "./messages.mjs";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[A-Za-z0-9._-]+$/;
const ALLOWED_HEADERS = "content-type, x-api-key, authorization, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access";

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { tooLarge: true }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createBridgeServer({ config, runner, log = () => {} }) {
  const expectedToken = digest(config.token);

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://bridge.invalid");
    const origin = req.headers.origin;
    const cors = origin && EXTENSION_ORIGIN.test(origin)
      ? { "access-control-allow-origin": origin, vary: "origin" }
      : {};

    const port = server.address()?.port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
    if (!allowedHosts.has(req.headers.host ?? "")) {
      sendJson(res, 403, errorBody("permission_error", "Host header must name the loopback bridge."));
      return;
    }
    if (origin && !cors["access-control-allow-origin"]) {
      sendJson(res, 403, errorBody("permission_error", "Only browser extensions may call the bridge."));
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": ALLOWED_HEADERS,
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "byos-translate-bridge" }, cors);
      return;
    }

    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const presented = req.headers["x-api-key"] ?? bearer;
    if (typeof presented !== "string" || !timingSafeEqual(digest(presented), expectedToken)) {
      sendJson(res, 401, errorBody("authentication_error", "Invalid bridge token."), cors);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data = BRIDGE_MODELS.map((model) => ({ type: "model", created_at: "1970-01-01T00:00:00Z", ...model }));
      sendJson(res, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id }, cors);
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/bridge/status") {
      sendJson(res, 200, { ok: true, defaultModel: config.defaultModel, runner: runner.snapshot() }, cors);
      return;
    }

    if (req.method !== "POST" || url.pathname !== "/v1/messages") {
      sendJson(res, 404, errorBody("not_found_error", `No route for ${req.method} ${url.pathname}.`), cors);
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      const message = error.tooLarge ? `Body exceeds ${MAX_BODY_BYTES} bytes.` : "Body must be valid JSON.";
      sendJson(res, error.tooLarge ? 413 : 400, errorBody("invalid_request_error", message), cors);
      return;
    }

    const parsed = parseMessagesRequest(body, { defaultModel: config.defaultModel });
    if (!parsed.ok) {
      sendJson(res, parsed.error.status, errorBody(parsed.error.type, parsed.error.message), cors);
      return;
    }

    // Kill the Claude Code process when the client goes away before the answer.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    const { model, system, prompt } = parsed.value;
    try {
      const completion = await runner.complete({ model, system, prompt, signal: controller.signal });
      sendJson(res, 200, messageResponse(completion), cors);
      log(`200 ${model} in=${prompt.length}ch out=${completion.text.length}ch ${Date.now() - started}ms`);
    } catch (error) {
      const { status, type } = runnerErrorResponse(error);
      if (!res.destroyed) sendJson(res, status, errorBody(type, error.message), cors);
      log(`${status} ${model} ${error.kind}: ${error.message.slice(0, 200)} ${Date.now() - started}ms`);
    }
  });

  return server;
}
