// Stand-in for `codex exec`, `codex app-server` and the Gemini CLI, chosen by
// the first argument after any --fake-* flags. For exec and Gemini the prompt
// on stdin selects the behaviour: HANG, CRASH, ERROR, otherwise echo.
// --fake-models-error makes app-server fail model/list.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const flags = process.argv.slice(2).filter((arg) => arg.startsWith("--fake-"));
const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--fake-"));

if (args[0] === "app-server") {
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const pages = {
    first: {
      data: [
        { id: "gpt-a", model: "gpt-a", displayName: "GPT A", hidden: false, isDefault: true },
        { id: "gpt-hidden", model: "gpt-hidden", displayName: "Hidden", hidden: true, isDefault: false },
      ],
      nextCursor: "page-2",
    },
    "page-2": {
      data: [{ id: "gpt-b", model: "gpt-b", displayName: "GPT B", hidden: false, isDefault: false }],
      nextCursor: null,
    },
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      send({ method: "account/updated", params: { authMode: "chatgpt" } });
      send({ id: message.id, result: { userAgent: "fake-codex" } });
    } else if (message.method === "model/list") {
      if (flags.includes("--fake-models-error")) {
        send({ id: message.id, error: { code: -32000, message: "Sign in with ChatGPT first" } });
      } else {
        send({ id: message.id, result: pages[message.params.cursor ?? "first"] });
      }
    }
  });
} else {
  const tool = args[0] === "exec" ? "codex" : "gemini";
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    if (input.includes("HANG")) {
      setInterval(() => {}, 1000);
      return;
    }
    if (input.includes("CRASH")) {
      process.stderr.write("boom");
      process.exit(3);
    }
    const systemFile = process.env.GEMINI_SYSTEM_MD;
    const echo = JSON.stringify({ tool, args, input, system: systemFile ? readFileSync(systemFile, "utf8") : null });
    if (tool === "codex") {
      process.stderr.write("codex progress\n");
      if (input.includes("ERROR")) {
        process.stderr.write("error: usage limit reached");
        process.exit(1);
      }
      process.stdout.write(`${echo}\n`);
      return;
    }
    if (input.includes("ERROR")) {
      process.stdout.write(JSON.stringify({ error: { type: "ApiError", message: "Quota exceeded", code: 429 } }));
      process.exit(1);
    }
    const model = args[args.indexOf("--model") + 1];
    process.stdout.write(JSON.stringify({ response: echo, stats: { models: { [model]: {} } } }));
  });
}
