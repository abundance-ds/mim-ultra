import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { CoreMessage } from "ai";

const SESSIONS_DIR = process.env.MIM_SESSIONS_DIR ?? "agent/sessions/ui";
const ACTIVE_SESSION_FILE = ".active-session";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  active?: boolean;
};

export type Session = SessionMeta & { messages: CoreMessage[] };

function ensureDir() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
}

function titleFromMessages(messages: CoreMessage[], fallback = "untitled"): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const text =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    const single = text.replace(/\s+/g, " ").trim();
    if (!single) continue;
    return single.length > 60 ? single.slice(0, 59) + "…" : single;
  }
  return fallback;
}

function safeId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("invalid session id");
  return id;
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${safeId(id)}.json`);
}

function activeSessionPath(): string {
  return join(SESSIONS_DIR, ACTIVE_SESSION_FILE);
}

function normalizeSession(data: any, fallbackId: string): Session {
  const messages = Array.isArray(data.messages) ? data.messages : [];
  return {
    id: data.id ?? fallbackId,
    title: data.title ?? titleFromMessages(messages),
    createdAt: data.createdAt ?? data.updatedAt ?? "",
    updatedAt: data.updatedAt ?? data.createdAt ?? "",
    messageCount: messages.length,
    messages,
  };
}

function metaFromSession(session: Session, activeId?: string | null): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    active: activeId === session.id || undefined,
  };
}

export function createSession(messages: CoreMessage[]): SessionMeta | null {
  if (!messages.length) return null;
  ensureDir();
  const now = new Date().toISOString();
  const id = `${now.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const meta: SessionMeta = {
    id,
    title: titleFromMessages(messages),
    createdAt: now,
    updatedAt: now,
    messageCount: messages.length,
  };
  const session: Session = { ...meta, messages };
  writeFileSync(sessionPath(id), JSON.stringify(session, null, 2));
  return meta;
}

export function saveSession(id: string, messages: CoreMessage[]): SessionMeta | null {
  if (!messages.length) return null;
  ensureDir();
  const existing = getSession(id);
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    id: safeId(id),
    title: titleFromMessages(messages, existing?.title),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    messageCount: messages.length,
  };
  const session: Session = { ...meta, messages };
  writeFileSync(sessionPath(id), JSON.stringify(session, null, 2));
  return meta;
}

export function archiveSession(messages: CoreMessage[]): SessionMeta | null {
  return createSession(messages);
}

export function listSessions(activeId = getActiveSessionId()): SessionMeta[] {
  ensureDir();
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  const metas: SessionMeta[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
      const session = normalizeSession(data, f.replace(/\.json$/, ""));
      metas.push(metaFromSession(session, activeId));
    } catch {
      /* skip corrupt files */
    }
  }
  return metas.sort((a, b) => {
    if (a.active && !b.active) return -1;
    if (!a.active && b.active) return 1;
    return (b.updatedAt || b.createdAt || "").localeCompare(a.updatedAt || a.createdAt || "");
  });
}

export function getSession(id: string): Session | null {
  const path = sessionPath(id);
  if (!existsSync(path)) return null;
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return normalizeSession(data, safeId(id));
}

export function deleteSession(id: string) {
  const path = sessionPath(id);
  if (existsSync(path)) rmSync(path);
  return { ok: true, id };
}

export function getActiveSessionId(): string | null {
  ensureDir();
  const path = activeSessionPath();
  if (!existsSync(path)) return null;
  try {
    const id = safeId(readFileSync(path, "utf-8").trim());
    return existsSync(sessionPath(id)) ? id : null;
  } catch {
    return null;
  }
}

export function setActiveSessionId(id: string) {
  ensureDir();
  writeFileSync(activeSessionPath(), safeId(id));
}

export function clearActiveSessionId() {
  const path = activeSessionPath();
  if (existsSync(path)) rmSync(path);
}

export function loadActiveSession(): Session | null {
  const id = getActiveSessionId();
  return id ? getSession(id) : null;
}
