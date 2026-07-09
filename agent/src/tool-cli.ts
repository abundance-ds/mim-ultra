#!/usr/bin/env tsx
// CLI entry point for mim tools — same logic that powers AI SDK tool() definitions.

import { handleWebAction, type WebToolInput } from "./web.js";
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
import { execSync } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const [name, ...args] = process.argv.slice(2);

function out(value: unknown): void {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  process.stdout.write(text + "\n");
}

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function usage(): never {
  out(`Usage: mim <tool> [args...]

  bash <command>              Shell command
  read <path>                 Read file
  write <path> [content]      Write file (stdin if no content arg)
  atspi <command>             AT-SPI desktop control
  web <action> [args]         Stateful Chromium browser
  secret <action> [args]      Credential vault

Web:  open <url> | observe | click <ref> | type <ref> <text>
      scroll [dir] [amount] | extract [max_chars] | wait [ms] | tabs

Secret: status | unlock <pass> | lock | list | get <id> [field]
        fill <id> [field] | save --label L [--password P ...] | delete <id>`);
  process.exit(0);
}

function shell(cmd: string, timeout = 30_000): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    }).trimEnd();
  } catch (e: any) {
    const parts = [e.stdout, e.stderr].filter(Boolean).join("\n").trimEnd();
    const code = e.signal ? `signal ${e.signal}` : `exit ${e.status ?? 1}`;
    return [parts, `[${code}]`].filter(Boolean).join("\n");
  }
}

async function handleWeb(args: string[]): Promise<unknown> {
  const [action, ...rest] = args;
  if (!action) die("Missing web action");

  const input: Record<string, unknown> = { action };
  switch (action) {
    case "open":
      input.url = rest[0] ?? die("Missing URL");
      break;
    case "click":
      input.ref = rest[0] ?? die("Missing ref");
      break;
    case "type":
      input.ref = rest[0] ?? die("Missing ref");
      input.text = rest.slice(1).join(" ") || die("Missing text");
      break;
    case "scroll":
      if (rest[0]) input.direction = rest[0];
      if (rest[1]) input.amount = parseInt(rest[1]);
      break;
    case "wait":
      if (rest[0]) input.ms = parseInt(rest[0]);
      break;
    case "extract":
      if (rest[0]) input.max_chars = parseInt(rest[0]);
      break;
    case "observe":
    case "tabs":
      break;
    default:
      die(`Unknown web action: ${action}`);
  }
  return await handleWebAction(input as WebToolInput);
}

function handleSecretAction(args: string[]): unknown {
  const [action, ...rest] = args;
  if (!action) die("Missing secret action");

  switch (action) {
    case "status":
      return getSecretStatus();
    case "unlock":
      return unlockSecrets(rest[0] ?? "");
    case "lock":
      lockSecrets();
      return "locked";
    case "list":
      return listSecrets();
    case "get":
      return getSecretValue(rest[0] ?? "", rest[1] || "password");
    case "fill":
      return fillSecretField(rest[0] ?? "", rest[1] || "password");
    case "delete":
      return deleteSecret(rest[0] ?? "");
    case "save": {
      const params: Record<string, string | Record<string, string> | undefined> =
        {};
      for (let i = 0; i < rest.length; i++) {
        const key = rest[i]?.replace(/^--/, "");
        if (!key) continue;
        if (key === "fields") {
          const val = rest[++i];
          if (val) {
            params.fields = Object.fromEntries(
              val.split(",").map((p) => {
                const [k, ...v] = p.split("=");
                return [k, v.join("=")];
              })
            );
          }
        } else {
          params[key] = rest[++i];
        }
      }
      return saveSecret(params);
    }
    default:
      die(`Unknown secret action: ${action}`);
  }
}

async function main() {
  if (!name || name === "help" || name === "--help") usage();

  switch (name) {
    case "web":
      out(await handleWeb(args));
      break;
    case "secret":
      out(handleSecretAction(args));
      break;
    case "bash":
      out(shell(args.join(" ")));
      break;
    case "atspi":
      out(shell(`atspi ${args.join(" ")}`));
      break;
    case "read":
    case "readFile":
      out(readFileSync(args[0] ?? die("Missing path"), "utf-8"));
      break;
    case "write":
    case "writeFile": {
      const path = args[0] ?? die("Missing path");
      let content: string;
      if (args.length > 1) {
        content = args.slice(1).join(" ");
      } else {
        content = readFileSync("/dev/stdin", "utf-8");
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      out(`Wrote ${content.length} bytes to ${path}`);
      break;
    }
    default:
      die(`Unknown tool: ${name}. Run 'mim help' for usage.`);
  }
}

main().catch((e: any) => die(`Error: ${e.message}`));
