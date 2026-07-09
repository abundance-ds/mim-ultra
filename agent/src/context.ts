import type { CoreMessage } from "ai";
import { parsePositiveInt } from "./command.js";

const CONTEXT_WINDOW_TOKENS = parsePositiveInt(process.env.CONTEXT_WINDOW_TOKENS, 200_000);
const CONTEXT_WARN_RATIO = Number.parseFloat(process.env.CONTEXT_WARN_RATIO ?? "0.75");
const CONTEXT_DANGER_RATIO = Number.parseFloat(process.env.CONTEXT_DANGER_RATIO ?? "0.9");

export type ContextLevel = "ok" | "warn" | "danger";

export type ContextStats = {
  estimatedTokens: number;
  exactPromptTokens: number | null;
  contextTokens: number;
  contextWindowTokens: number;
  pressure: number;
  level: ContextLevel;
  messages: number;
  systemChars: number;
  messageChars: number;
  updatedAt: string;
};

type ContextRuntime = {
  getMessages: () => CoreMessage[];
  getSystemPrompt: () => string;
};

let runtime: ContextRuntime | null = null;
let lastExactPromptTokens: number | null = null;
let lastStats: ContextStats = makeContextStats([], "");

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageText(message: CoreMessage): string {
  if (typeof message.content === "string") return message.content;
  return JSON.stringify(message.content);
}

function messageArrayText(messages: CoreMessage[]): string {
  return messages
    .map((message, index) => {
      return `#${index + 1} ${message.role}\n${messageText(message)}`;
    })
    .join("\n\n");
}

function levelFor(pressure: number): ContextLevel {
  if (pressure >= CONTEXT_DANGER_RATIO) return "danger";
  if (pressure >= CONTEXT_WARN_RATIO) return "warn";
  return "ok";
}

export function makeContextStats(
  messages: CoreMessage[],
  systemPrompt: string,
  exactPromptTokens = lastExactPromptTokens
): ContextStats {
  const messageChars = messageArrayText(messages).length;
  const systemChars = systemPrompt.length;
  const estimatedTokens = estimateTokens(systemPrompt) + estimateTokens(messageArrayText(messages));
  const contextTokens = estimatedTokens;
  const pressure = contextTokens / CONTEXT_WINDOW_TOKENS;

  return {
    estimatedTokens,
    exactPromptTokens,
    contextTokens,
    contextWindowTokens: CONTEXT_WINDOW_TOKENS,
    pressure,
    level: levelFor(pressure),
    messages: messages.length,
    systemChars,
    messageChars,
    updatedAt: new Date().toISOString(),
  };
}

export function setContextRuntime(nextRuntime: ContextRuntime) {
  runtime = nextRuntime;
  updateContextSnapshot();
}

export function updateContextSnapshot(
  messages = runtime?.getMessages() ?? [],
  systemPrompt = runtime?.getSystemPrompt() ?? ""
): ContextStats {
  lastStats = makeContextStats(messages, systemPrompt);
  return lastStats;
}

export function recordExactPromptTokens(promptTokens: number) {
  if (Number.isFinite(promptTokens) && promptTokens > 0) {
    lastExactPromptTokens = promptTokens;
  }
  updateContextSnapshot();
}

export function resetExactPromptTokens() {
  lastExactPromptTokens = null;
  updateContextSnapshot();
}

export function getContextStats(): ContextStats {
  return lastStats;
}
