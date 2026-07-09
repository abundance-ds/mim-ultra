import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { type CoreMessage } from "ai";
import { runAgent, systemPrompt } from "../src/agent.js";
import {
  recordExactPromptTokens,
  setContextRuntime,
  updateContextSnapshot,
} from "../src/context.js";

function usage(): never {
  console.error("Usage: npx tsx scripts/trace-agent.ts --out <path> <task>");
  process.exit(1);
}

const args = process.argv.slice(2);
let outPath = "";
const taskParts: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") {
    outPath = args[++i] ?? "";
  } else {
    taskParts.push(args[i]);
  }
}

const task = taskParts.join(" ").trim();
if (!outPath || !task) usage();

function fence(text: string): string {
  return "```text\n" + text.replaceAll("```", "` ` `") + "\n```";
}

function resultText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

const maxResultChars = Number.parseInt(process.env.TRACE_RESULT_MAX ?? "24000", 10);
const model = process.env.MODEL ?? "claude-sonnet-4-6";
const messages: CoreMessage[] = [{ role: "user", content: task }];
setContextRuntime({
  getMessages: () => messages,
  getSystemPrompt: () => systemPrompt,
});
const lines: string[] = [
  `# Agent Trace`,
  ``,
  `- Model: \`${model}\``,
  `- Started: ${new Date().toISOString()}`,
  ``,
  `## Task`,
  ``,
  fence(task),
  ``,
  `## Events`,
  ``,
];

let assistantText = "";
let toolCalls = 0;
let toolResults = 0;
const started = Date.now();

function flush() {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n"));
}

function handleSignal(signal: string) {
  if (assistantText.trim()) {
    lines.push(`### Assistant Text`, ``, fence(assistantText.trim()), ``);
    assistantText = "";
  }
  lines.push(`## Interrupted`, ``, `- Signal: ${signal}`, `- Elapsed ms: ${Date.now() - started}`, ``);
  flush();
  process.exit(130);
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));

try {
  updateContextSnapshot(messages, systemPrompt);
  const run = runAgent(messages);

  for await (const chunk of run.fullStream as AsyncIterable<any>) {
    if (chunk.type === "text-delta") {
      assistantText += chunk.textDelta;
      continue;
    }

    if (assistantText.trim()) {
      lines.push(`### Assistant Text`, ``, fence(assistantText.trim()), ``);
      assistantText = "";
    }

    if (chunk.type === "tool-call") {
      toolCalls++;
      lines.push(
        `### Tool Call ${toolCalls}: ${chunk.toolName}`,
        ``,
        fence(JSON.stringify(chunk.args, null, 2)),
        ``
      );
    } else if (chunk.type === "tool-result") {
      toolResults++;
      const text = resultText(chunk.result);
      const shown =
        text.length > maxResultChars
          ? text.slice(0, maxResultChars) + `\n...[truncated ${text.length - maxResultChars} chars]`
          : text;
      lines.push(
        `### Tool Result ${toolResults}: ${chunk.toolName}`,
        ``,
        `- Characters: ${text.length}`,
        `- Lines: ${text ? text.split("\n").length : 0}`,
        ``,
        fence(shown),
        ``
      );
    } else if (chunk.type === "error") {
      lines.push(`### Error`, ``, fence(String(chunk.error)), ``);
    }
    flush();
  }

  if (assistantText.trim()) {
    lines.push(`### Assistant Text`, ``, fence(assistantText.trim()), ``);
  }

  const response = await run.response;
  const usage = await run.usage;
  recordExactPromptTokens(usage.promptTokens);
  for (const msg of response.messages) messages.push(msg as CoreMessage);
  const finalContext = updateContextSnapshot(messages, systemPrompt);
  lines.push(
    `## Summary`,
    ``,
    `- Elapsed ms: ${Date.now() - started}`,
    `- Tool calls: ${toolCalls}`,
    `- Tool results: ${toolResults}`,
    `- Response messages: ${response.messages.length}`,
    `- Input tokens: ${usage.promptTokens}`,
    `- Output tokens: ${usage.completionTokens}`,
    `- Context tokens: ${finalContext.contextTokens}`,
    ``
  );
} catch (error: any) {
  lines.push(`## Fatal Error`, ``, fence(error?.stack ?? String(error)), ``);
  process.exitCode = 1;
} finally {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join("\n"));
  console.error(`wrote ${outPath}`);
}
