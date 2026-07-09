import { tool } from "ai";
import { z } from "zod";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { singleCommandValue } from "./command.js";
import { handleWebAction } from "./web.js";
import {
  formatToolOutput,
  mergeOutputOptions,
  parseToolCommand,
  TOOL_MAX_BUFFER,
  type ToolOutputOptions,
} from "./tool-output.js";
import {
  deleteSecret,
  fillSecretField,
  getSecretStatus,
  getSecretValue,
  listSecrets,
  lockSecrets,
  saveSecret,
  unlockSecrets,
} from "./secrets.js";

const run = (
  cmd: string,
  toolName: string,
  timeout = 30_000,
  outputOptions: ToolOutputOptions = {},
  subject = ""
): string => {
  try {
    const output = execSync(cmd, {
      encoding: "utf-8",
      timeout: outputOptions.timeoutMs ?? timeout,
      maxBuffer: TOOL_MAX_BUFFER,
    }).trimEnd();
    return formatToolOutput(toolName, output, outputOptions, subject);
  } catch (e: any) {
    const out = [e.stdout, e.stderr].filter(Boolean).join("\n").trimEnd();
    const status = e.signal
      ? `signal ${e.signal}`
      : `exit code ${e.status ?? 1}`;
    const output = [out, `[${status}]`].filter(Boolean).join("\n");
    return formatToolOutput(toolName, output, outputOptions, subject);
  }
};

export const bash = tool({
  description: "Shell. Optional front flags before --. Compact output by default. Full output saved under `agent/sessions/tool-output/` (unless disabled).",
  parameters: z.object({
    command: z.string(),
  }),
  execute: async ({ command }) => {
    const parsed = parseToolCommand(command);
    if (!parsed.payload.trim()) return "Error: missing shell command";
    return run(parsed.payload, "bash", 30_000, parsed.output, parsed.payload);
  },
});

export const readFile = tool({
  description: "Read text. Optional front flags before --.",
  parameters: z.object({
    command: z.string().optional(),
    path: z.string().optional(),
  }),
  execute: async ({ command, path }) => {
    try {
      const parsed = parseToolCommand(command ?? path ?? "");
      const target = singleCommandValue(parsed.payload);
      if (!target) return "Error: missing path";
      return formatToolOutput(
        "readFile",
        readFileSync(target, "utf-8"),
        parsed.output,
        target
      );
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
});

export const writeFile = tool({
  description: "Write file.",
  parameters: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async ({ path, content }) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return `Wrote ${content.length} bytes to ${path}`;
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
});

export const atspi = tool({
  description: "Native desktop control. Raw atspi command.",
  parameters: z.object({
    command: z.string(),
  }),
  execute: async ({ command }) => {
    const parsed = parseToolCommand(command);
    if (!parsed.payload.trim()) return "Error: missing atspi command";
    return run(
      `atspi ${parsed.payload}`,
      "atspi",
      10_000,
      mergeOutputOptions({ limit: 8_000 }, parsed.output),
      parsed.payload
    );
  },
});

export const web = tool({
  description: "Stateful chromium with ref actions.",
  parameters: z.object({
    action: z.enum(["open", "observe", "click", "type", "scroll", "wait", "extract", "tabs"]),
    url: z.string().optional(),
    ref: z.string().optional(),
    text: z.string().optional(),
    direction: z.enum(["down", "up", "left", "right"]).optional(),
    amount: z.number().optional(),
    ms: z.number().optional(),
    wait_ms: z.number().optional(),
    max_chars: z.number().optional(),
    start_from_char: z.number().optional(),
  }),
  execute: async (args) => {
    try {
      return await handleWebAction(args);
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
});

export const secret = tool({
  description: "Credential vault.",
  parameters: z.object({
    action: z.enum(["status", "unlock", "lock", "list", "get", "fill", "save", "delete"]),
    id: z.string().optional(),
    label: z.string().optional(),
    kind: z.enum(["manual", "ai"]).optional(),
    field: z.string().optional(),
    passphrase: z.string().optional(),
    url: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    otp: z.string().optional(),
    notes: z.string().optional(),
    fields: z.record(z.string()).optional(),
  }),
  execute: async (args) => {
    try {
      const target = args.id || args.label || "";
      if (args.action === "status") return JSON.stringify(getSecretStatus(), null, 2);
      if (args.action === "unlock") {
        const result = unlockSecrets(args.passphrase ?? "");
        return `unlocked secret vault${result.created ? " (created)" : ""}; ${result.count} entries`;
      }
      if (args.action === "lock") {
        lockSecrets();
        return "locked secret vault";
      }
      if (args.action === "list") return JSON.stringify(listSecrets(), null, 2);
      if (args.action === "get") return getSecretValue(target, args.field || "password");
      if (args.action === "fill") {
        const result = fillSecretField(target, args.field || "password");
        return `filled ${result.label}.${result.field} (${result.length} chars)`;
      }
      if (args.action === "save") {
        const meta = saveSecret(args);
        return `saved ${meta.label}`;
      }
      if (args.action === "delete") {
        const result = deleteSecret(target);
        return `deleted ${result.deleted}`;
      }
      return "unknown secret action";
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  },
});

export const allTools = { bash, readFile, writeFile, atspi, web, secret };
