import { mkdirSync, writeFileSync } from "fs";

const STATE_DIR = process.env.MIM_STATE_DIR ?? "/tmp/mim";
const STATE_JSON = `${STATE_DIR}/state.json`;
const STATE_LINE = `${STATE_DIR}/state.line`;

export type AgentState = {
  status: string;
  tool: string | null;
  detail: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  contextTokens: number;
  messages: number;
  updatedAt: string;
};

let currentState: AgentState = {
  status: "offline",
  tool: null,
  detail: "offline",
  model: process.env.MODEL ?? "claude-sonnet-4-6",
  tokensIn: 0,
  tokensOut: 0,
  contextTokens: 0,
  messages: 0,
  updatedAt: new Date(0).toISOString(),
};

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 96);
}

function stateLine(state: AgentState): string {
  if (state.status.startsWith("tool:")) {
    const tool = state.tool ?? state.status.slice("tool:".length);
    const detail = compact(state.detail);
    return detail ? `${tool} - ${detail}` : `${tool} running`;
  }

  if (state.status === "thinking") return "thinking";
  if (state.status === "responding") return "responding";
  if (state.status === "idle") return "idle";
  if (state.status === "offline") return "offline";
  return compact(state.detail) || state.status;
}

function writeCurrentState() {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_JSON, JSON.stringify(currentState));
  writeFileSync(STATE_LINE, stateLine(currentState));
}

export function setAgentState(patch: Partial<Omit<AgentState, "updatedAt">>): AgentState {
  currentState = {
    ...currentState,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  writeCurrentState();
  return currentState;
}

export function getAgentState(): AgentState {
  return currentState;
}

export function markAgentOffline() {
  setAgentState({
    status: "offline",
    tool: null,
    detail: "offline",
  });
}
