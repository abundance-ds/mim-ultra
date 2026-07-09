import { existsSync } from "fs";
import { join, resolve } from "path";

export const AGENT_HOME = resolve(process.env.MIM_AGENT_HOME ?? process.cwd());
export const SHARED_HOME = resolve(process.env.MIM_SHARED_HOME ?? "/shared");

export function agentPath(...parts: string[]): string {
  return join(AGENT_HOME, ...parts);
}

export function sharedPath(...parts: string[]): string {
  return join(SHARED_HOME, ...parts);
}

export function defaultSecretVaultPath(): string {
  if (existsSync(SHARED_HOME)) return sharedPath("vault", "secrets.vault.json");
  return agentPath("secrets.vault.json");
}
