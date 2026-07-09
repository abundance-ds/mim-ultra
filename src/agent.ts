import { streamText, type CoreMessage, type StreamTextResult } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { readFileSync, existsSync } from "fs";
import { allTools } from "./tools.js";
import { parsePositiveInt } from "./command.js";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf-8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

export const MODEL = process.env.MODEL ?? "claude-sonnet-4-6";
export const MAX_STEPS = parsePositiveInt(process.env.MAX_STEPS, 1_000_000);

export const systemPrompt = readFileSync("AGENTS.md", "utf-8");

export function runAgent(
  messages: CoreMessage[],
  abortSignal?: AbortSignal
): StreamTextResult<typeof allTools, never> {
  return streamText({
    model: anthropic(MODEL),
    system: systemPrompt,
    messages,
    tools: allTools,
    maxSteps: MAX_STEPS,
    abortSignal,
  });
}
