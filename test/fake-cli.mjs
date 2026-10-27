// Stand-in for `codex exec` and the Gemini CLI, chosen by the first argument.
// The prompt on stdin selects the behaviour: HANG, CRASH, ERROR, otherwise echo.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
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
