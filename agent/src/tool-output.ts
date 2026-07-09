import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  parseBooleanEnv,
  parseNonNegativeInt,
  parsePositiveInt,
  tokenizeCommand,
} from "./command.js";
import { agentPath } from "./paths.js";

export type ToolOutputOptions = {
  limit?: number;
  offset?: number;
  full?: boolean;
  saveOutput?: boolean;
  timeoutMs?: number;
};

export type ParsedToolCommand = {
  payload: string;
  output: ToolOutputOptions;
};

export const DEFAULT_TOOL_OUTPUT_LIMIT = parsePositiveInt(
  process.env.MIM_TOOL_OUTPUT_LIMIT,
  12_000
);

export const TOOL_MAX_BUFFER = parsePositiveInt(
  process.env.MIM_TOOL_MAX_BUFFER,
  16 * 1024 * 1024
);

const OUTPUT_DIR = process.env.MIM_TOOL_OUTPUT_DIR ?? agentPath("sessions", "tool-output");
const SAVE_TRUNCATED_OUTPUTS = parseBooleanEnv(process.env.MIM_SAVE_TRUNCATED_OUTPUTS, true);

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "output";
}

function compactOneLine(value: string, max = 120): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function saveOutput(toolName: string, raw: string): string {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const path = join(OUTPUT_DIR, `${timestamp()}-${slug(toolName)}-${randomUUID().slice(0, 8)}.txt`);
  writeFileSync(path, raw);
  return path;
}

export function parseToolCommand(input: string): ParsedToolCommand {
  const original = input ?? "";
  const trimmedStart = original.trimStart();
  if (!trimmedStart.startsWith("--")) {
    return { payload: original, output: {} };
  }

  const tokens = tokenizeCommand(trimmedStart);
  const output: ToolOutputOptions = {};
  let recognized = false;
  let lastEnd = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token.value === "--") {
      return { payload: trimmedStart.slice(token.end).trimStart(), output };
    }

    if (token.value === "--limit") {
      const next = tokens[++i];
      if (!next) break;
      output.limit = parsePositiveInt(next.value, DEFAULT_TOOL_OUTPUT_LIMIT);
      recognized = true;
      lastEnd = next.end;
      continue;
    }

    if (token.value === "--offset") {
      const next = tokens[++i];
      if (!next) break;
      output.offset = parseNonNegativeInt(next.value, 0);
      recognized = true;
      lastEnd = next.end;
      continue;
    }

    if (token.value === "--timeout-ms") {
      const next = tokens[++i];
      if (!next) break;
      output.timeoutMs = parsePositiveInt(next.value, 30_000);
      recognized = true;
      lastEnd = next.end;
      continue;
    }

    if (token.value === "--full") {
      output.full = true;
      recognized = true;
      lastEnd = token.end;
      continue;
    }

    if (token.value === "--save-output") {
      output.saveOutput = true;
      recognized = true;
      lastEnd = token.end;
      continue;
    }

    if (token.value === "--no-save-output") {
      output.saveOutput = false;
      recognized = true;
      lastEnd = token.end;
      continue;
    }

    break;
  }

  if (!recognized) return { payload: original, output: {} };
  return { payload: trimmedStart.slice(lastEnd).trimStart(), output };
}

export function mergeOutputOptions(
  base: ToolOutputOptions,
  override: ToolOutputOptions
): ToolOutputOptions {
  return { ...base, ...override };
}

export function formatToolOutput(
  toolName: string,
  raw: string,
  options: ToolOutputOptions = {},
  subject = ""
): string {
  const text = raw ?? "";
  const total = text.length;
  const offset = options.full ? 0 : Math.min(Math.max(options.offset ?? 0, 0), total);
  const limit = options.full
    ? total
    : Math.max(options.limit ?? DEFAULT_TOOL_OUTPUT_LIMIT, 1);
  const end = options.full ? total : Math.min(offset + limit, total);
  const shown = text.slice(offset, end);
  const truncated = offset > 0 || end < total;
  const lines = text ? text.split("\n").length : 0;
  const shownLines = shown ? shown.split("\n").length : 0;

  let savedPath: string | null = null;
  if ((truncated && options.saveOutput !== false && SAVE_TRUNCATED_OUTPUTS) || options.saveOutput) {
    savedPath = saveOutput(toolName, text);
  }

  const header = [
    `${toolName}${subject ? ` ${compactOneLine(subject)}` : ""}`,
    `chars ${offset}-${end} of ${total}`,
    `${shownLines}/${lines} lines shown`,
    truncated ? "truncated" : "complete",
  ].join("; ");

  const footer: string[] = [];
  if (truncated) {
    footer.push(`next window: --offset ${end} --limit ${limit}`);
    footer.push("use --full only when the exact full output is worth the context");
  }
  if (savedPath) {
    footer.push(`full output saved: ${savedPath}`);
  }

  return [
    `[${header}]`,
    shown,
    footer.length ? `[${footer.join("; ")}]` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
