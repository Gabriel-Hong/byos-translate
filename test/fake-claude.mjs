// Stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// The prompt selects the behaviour: HANG, RATE, CRASH, otherwise echo.
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const model = args.find((arg) => arg.startsWith("--model="))?.slice("--model=".length);
const system = args.find((arg) => arg.startsWith("--system-prompt="))?.slice("--system-prompt=".length);
const toolsIndex = args.indexOf("--tools");

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.once("line", (line) => {
  const prompt = JSON.parse(line).message.content;
  emit({ type: "system", subtype: "init", model });
  if (prompt.includes("HANG")) {
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes("CRASH")) {
    process.stderr.write("boom");
    process.exit(3);
  }
  if (prompt.includes("RATE")) {
    emit({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "Rate limited" });
    return;
  }
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    result: JSON.stringify({ model, system, prompt, tools: args[toolsIndex + 1], pid: process.pid }),
    usage: { input_tokens: 3, output_tokens: 5 },
    modelUsage: { [`resolved-${model}`]: {} },
  });
});
