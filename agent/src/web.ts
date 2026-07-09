import { spawn } from "child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { agentPath } from "./paths.js";

export type WebAction =
  | "open"
  | "observe"
  | "click"
  | "type"
  | "scroll"
  | "wait"
  | "extract"
  | "tabs";

export type WebToolInput = {
  action: WebAction;
  url?: string;
  ref?: string;
  text?: string;
  direction?: "down" | "up" | "left" | "right";
  amount?: number;
  ms?: number;
  wait_ms?: number;
  max_chars?: number;
  start_from_char?: number;
};

type ActionRef = {
  ref: string;
  uid: string;
  tag: string;
  role?: string;
  label: string;
  href?: string;
  value?: string;
  disabled?: boolean;
};

type PageCapture = {
  title: string;
  url: string;
  markdown: string;
  refs: ActionRef[];
  signals: {
    visible_text_chars: number;
    ref_count: number;
    link_count: number;
    button_count: number;
    form_control_count: number;
    heading_count: number;
  };
};

type Observation = {
  page: string;
  url: string;
  observation: string;
  refs: Array<{
    ref: string;
    kind: string;
    label: string;
    href?: string;
    disabled?: boolean;
  }>;
  ref_count: number;
  signals: PageCapture["signals"];
  content_length: number;
  truncated?: boolean;
  next_start_char?: number;
  started_from_char?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_MS = 500;
const DEFAULT_MAX_CHARS = 100_000;
const HARD_MAX_CHARS = 300_000;
const MAX_PUBLIC_REFS = 60;
const MAX_REF_LABEL_CHARS = 100;
const MAX_REF_HREF_CHARS = 180;
const DEBUG_HOST = "127.0.0.1";
const DEBUG_PORT = 9222;

let latestRefs = new Map<string, ActionRef>();
let messageId = 0;

type BrowserTarget = {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type BrowserCommandResponse<T> = {
  id: number;
  result?: T;
  error?: { message?: string; data?: string };
};

type RuntimeEvaluateResponse = {
  result?: {
    type?: string;
    value?: unknown;
    unserializableValue?: string;
    description?: string;
  };
  exceptionDetails?: unknown;
};

export async function handleWebAction(input: WebToolInput): Promise<unknown> {
  const action = input.action;
  if (action === "tabs") {
    await ensureBrowser();
    return formatTabs(await browserTabs());
  }

  await ensureBrowser();

  if (action === "open") {
    const url = normalizeUrl(required(input.url, "url"));
    await browserCommand("Page.navigate", { url }, DEFAULT_TIMEOUT_MS);
    await waitForStablePage(positive(input.ms, DEFAULT_TIMEOUT_MS, 120_000));
    return await observe(input);
  }

  if (action === "observe") return await observe(input);

  if (action === "extract") {
    const capture = await capturePage();
    const maxChars = positive(input.max_chars, DEFAULT_MAX_CHARS, HARD_MAX_CHARS);
    const startFromChar = nonNegative(input.start_from_char);
    const chunk = chunkLiveMarkdown(capture.markdown, maxChars, startFromChar);
    return {
      content: chunk.content,
      content_length: capture.markdown.length,
      ...(chunk.hasMore ? { truncated: true } : {}),
      ...(chunk.nextStartChar != null ? { next_start_char: chunk.nextStartChar } : {}),
      ...(startFromChar > 0 ? { started_from_char: startFromChar } : {}),
    };
  }

  if (action === "click") {
    const ref = await resolveRef(required(input.ref, "ref"));
    const result = await browserJson<{ ok: true; message?: string } | { ok: false; error: string }>(
      `JSON.stringify((${browserFunction(performElementAction)})(${JSON.stringify({
        action: "click",
        ref: ref.ref,
        uid: ref.uid,
      })}))`
    );
    assertActionResult(result);
    if (!result.ok) throw new Error(result.error);
    await afterActionWait(input.wait_ms);
    return { action: result, observation: await observe(input) };
  }

  if (action === "type") {
    const ref = await resolveRef(required(input.ref, "ref"));
    const result = await browserJson<{ ok: true; message?: string } | { ok: false; error: string }>(
      `JSON.stringify((${browserFunction(performElementAction)})(${JSON.stringify({
        action: "type",
        ref: ref.ref,
        uid: ref.uid,
        text: required(input.text, "text"),
      })}))`
    );
    assertActionResult(result);
    if (!result.ok) throw new Error(result.error);
    await afterActionWait(input.wait_ms);
    return { action: result, observation: await observe(input) };
  }

  if (action === "scroll") {
    const amount = positive(input.amount, 700, 5_000);
    const direction = input.direction || "down";
    await browserJson<boolean>(scrollScript(direction, amount));
    await afterActionWait(input.wait_ms);
    return {
      action: { changed: true, message: `Scrolled ${direction} ${amount}px.` },
      observation: await observe(input),
    };
  }

  if (action === "wait") {
    await waitForStablePage(positive(input.ms, DEFAULT_WAIT_MS, 30_000));
    return await observe(input);
  }

  throw new Error(`Unsupported web action: ${String(action)}`);
}

async function observe(input: WebToolInput): Promise<Observation> {
  const capture = await capturePage();
  latestRefs = new Map(capture.refs.map((ref) => [ref.ref, ref]));
  return formatObservation(
    capture,
    positive(input.max_chars, DEFAULT_MAX_CHARS, HARD_MAX_CHARS),
    nonNegative(input.start_from_char)
  );
}

async function ensureBrowser(): Promise<void> {
  if (await isBrowserReady()) return;

  const profileDir = process.env.MIM_WEB_PROFILE_DIR || defaultProfileDir();
  prepareProfileDir(profileDir);
  const executable = await browserExecutable();
  if (!executable) {
    throw new Error(
      "No Chromium-compatible browser found. Set MIM_BROWSER_BIN or install chromium-browser."
    );
  }

  const child = spawn(
    executable,
    [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9222",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    {
      detached: true,
      stdio: "ignore",
      env: desktopEnv(),
      cwd: process.env.MIM_AGENT_HOME || process.cwd(),
    }
  );
  let startupError: Error | null = null;
  child.once("error", (error) => {
    startupError = new Error(`Failed to start browser '${executable}': ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    startupError ??= new Error(
      `Browser '${executable}' exited before becoming ready (${signal ?? `code ${code ?? 0}`}).`
    );
  });
  child.unref();

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    sleep(250);
    if (startupError) throw startupError;
    if (await isBrowserReady()) return;
  }
  throw new Error(`Chromium did not expose its browser control port on ${DEBUG_PORT}.`);
}

function prepareProfileDir(profileDir: string): void {
  mkdirSync(profileDir, { recursive: true });
  try {
    chmodSync(profileDir, 0o777);
  } catch {
    /* best effort for bind-mounted profiles */
  }
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      rmSync(join(profileDir, name), { force: true });
    } catch {
      /* stale Chromium lock cleanup is best effort */
    }
  }
}

async function browserExecutable(): Promise<string | null> {
  const candidates = [
    process.env.MIM_BROWSER_BIN,
    await playwrightChromiumExecutable(),
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

async function playwrightChromiumExecutable(): Promise<string | undefined> {
  try {
    const mod = await import("playwright-chromium");
    const executable = mod.chromium.executablePath();
    accessSync(executable, constants.X_OK);
    return executable;
  } catch {
    return undefined;
  }
}

function defaultProfileDir(): string {
  const home = process.env.HOME || homedir();
  const snapCommon = join(home, "snap", "chromium", "common");
  if (existsSync(snapCommon) || existsSync("/snap/bin/chromium")) {
    return join(snapCommon, "mim-web-profile");
  }
  return agentPath("browser-profile");
}

function desktopEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":99",
    GTK_MODULES: process.env.GTK_MODULES || "gail:atk-bridge",
    NO_AT_BRIDGE: "0",
  };
  const dbus = readDbusAddress();
  if (dbus) env.DBUS_SESSION_BUS_ADDRESS = dbus;
  return env;
}

function readDbusAddress(): string {
  try {
    const value = readFileSync("/tmp/mim-desktop.env", "utf-8")
      .split("\n")
      .find((line) => line.startsWith("DBUS_SESSION_BUS_ADDRESS="));
    if (value) return value.slice(value.indexOf("=") + 1).trim();
  } catch {}
  try {
    const lines = readFileSync("/tmp/desktop.log", "utf-8").split("\n").reverse();
    const found = lines.find((line) => line.includes("D-Bus:"));
    if (found) return found.slice(found.indexOf("D-Bus:") + "D-Bus:".length).trim();
  } catch {}
  return process.env.DBUS_SESSION_BUS_ADDRESS || "";
}

async function isBrowserReady(): Promise<boolean> {
  try {
    await browserTabs(2_000);
    return true;
  } catch {
    return false;
  }
}

async function browserTabs(timeoutMs = 10_000): Promise<BrowserTarget[]> {
  return await fetchJson<BrowserTarget[]>(`http://${DEBUG_HOST}:${DEBUG_PORT}/json`, timeoutMs);
}

async function fetchJson<T>(
  url: string,
  timeoutMs = 10_000,
  init: RequestInit = {}
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function websocketCommand<T>(
  url: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<T> {
  const Socket = (globalThis as unknown as { WebSocket?: new (url: string) => any }).WebSocket;
  if (!Socket) throw new Error("No WebSocket implementation available in this Node runtime.");

  const id = ++messageId;
  const payload = JSON.stringify({ id, method, params });

  return await new Promise<T>((resolve, reject) => {
    const socket = new Socket(url);
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error(`Browser command timed out: ${method}`))), timeoutMs);

    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      done();
    };

    socket.addEventListener("open", () => socket.send(payload));
    socket.addEventListener("error", () => finish(() => reject(new Error(`Browser socket failed: ${method}`))));
    socket.addEventListener("message", (event: { data: unknown }) => {
      let data = event.data;
      if (data instanceof ArrayBuffer) {
        data = Buffer.from(data).toString("utf-8");
      } else if (ArrayBuffer.isView(data)) {
        data = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
      } else if (typeof data !== "string") {
        data = String(data);
      }

      let message: BrowserCommandResponse<T>;
      try {
        message = JSON.parse(data as string) as BrowserCommandResponse<T>;
      } catch {
        return;
      }
      if (message.id !== id) return;
      if (message.error) {
        const detail = [message.error.message, message.error.data].filter(Boolean).join(": ");
        finish(() => reject(new Error(detail || `Browser command failed: ${method}`)));
        return;
      }
      finish(() => resolve(message.result as T));
    });
  });
}

function formatTabs(tabs: BrowserTarget[]): string {
  return tabs
    .map((tab, index) => `${index} ${tab.type || "page"} ${tab.title || "(untitled)"} ${tab.url || ""}`.trim())
    .join("\n");
}

async function activePage(): Promise<BrowserTarget> {
  const tabs = await browserTabs();
  const page = tabs.find((tab) => tab.type === "page" && tab.webSocketDebuggerUrl)
    || tabs.find((tab) => tab.webSocketDebuggerUrl);
  if (page) return page;

  await fetchJson<BrowserTarget>(
    `http://${DEBUG_HOST}:${DEBUG_PORT}/json/new?${encodeURIComponent("about:blank")}`,
    DEFAULT_TIMEOUT_MS,
    { method: "PUT" }
  );
  const nextTabs = await browserTabs();
  const nextPage = nextTabs.find((tab) => tab.type === "page" && tab.webSocketDebuggerUrl)
    || nextTabs.find((tab) => tab.webSocketDebuggerUrl);
  if (!nextPage) throw new Error("No controllable Chromium page found.");
  return nextPage;
}

async function browserCommand<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const page = await activePage();
  if (!page.webSocketDebuggerUrl) throw new Error("Current Chromium tab has no control socket.");
  return await websocketCommand<T>(page.webSocketDebuggerUrl, method, params, timeoutMs);
}

async function browserEval(expression: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const value = await browserCommand<RuntimeEvaluateResponse>(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs
  );
  if (value.exceptionDetails) {
    throw new Error(`Browser eval failed: ${truncateOneLine(JSON.stringify(value.exceptionDetails), 800)}`);
  }
  const result = value.result;
  const output = result?.value ?? result?.unserializableValue ?? result?.description ?? "";
  return typeof output === "string" ? output : String(output);
}

async function browserJson<T>(expression: string): Promise<T> {
  const raw = await browserEval(expression, DEFAULT_TIMEOUT_MS);
  return JSON.parse(raw) as T;
}

async function capturePage(): Promise<PageCapture> {
  const value = await browserJson<unknown>(
    `JSON.stringify((${browserFunction(captureWebPage)})())`
  );
  if (!value || typeof value !== "object" || !Array.isArray((value as PageCapture).refs)) {
    throw new Error(`Web capture failed: ${truncateOneLine(JSON.stringify(value), 800)}`);
  }
  return value as PageCapture;
}

function browserFunction(fn: (...args: never[]) => unknown): string {
  return `((__name) => (${fn.toString()}))((fn) => fn)`;
}

async function resolveRef(ref: string): Promise<ActionRef> {
  const existing = latestRefs.get(ref);
  if (existing) return existing;
  const capture = await capturePage();
  latestRefs = new Map(capture.refs.map((item) => [item.ref, item]));
  const found = latestRefs.get(ref);
  if (!found) throw new Error(`No current web ref '${ref}'. Run web observe again.`);
  return found;
}

function assertActionResult(value: unknown): asserts value is { ok: true; message?: string } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || typeof (value as { ok?: unknown }).ok !== "boolean") {
    throw new Error(`Web action failed: ${truncateOneLine(JSON.stringify(value), 800)}`);
  }
}

async function waitForStablePage(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let last = "";
  let stable = 0;
  while (Date.now() < deadline) {
    try {
      const sig = await browserEval(
        `[
          document.readyState,
          document.title,
          document.body ? document.body.innerText.length : 0,
          document.querySelectorAll('a,button,input,textarea,select,[role="button"],[tabindex]').length
        ].join('|')`,
        5_000
      );
      if (sig === last && !sig.startsWith("loading|")) stable++;
      else stable = 0;
      last = sig;
      if (stable >= 2) return;
    } catch {}
    sleep(300);
  }
}

async function afterActionWait(waitMs: unknown): Promise<void> {
  await waitForStablePage(positive(waitMs, DEFAULT_WAIT_MS, 10_000));
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`web action requires ${name}`);
  return value;
}

function positive(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

function nonNegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function truncateOneLine(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxChars ? compact : `${compact.slice(0, maxChars - 3).trimEnd()}...`;
}

function formatObservation(capture: PageCapture, maxChars: number, startFromChar: number): Observation {
  const metadataLines = [
    `Page: ${capture.title || "(untitled)"}`,
    `URL: ${capture.url}`,
    `Capture: ${capture.signals.visible_text_chars} visible chars, ${capture.refs.length} refs`,
  ];
  const metadataPrefix = `${metadataLines.join("\n")}\n\n`;
  const includeMetadata = maxChars >= metadataPrefix.length + 180;
  const markdownBudget = Math.max(1, maxChars - (includeMetadata ? metadataPrefix.length + 140 : 0));
  const chunk = chunkLiveMarkdown(capture.markdown, markdownBudget, startFromChar);
  const mentionedRefs = refsMentionedInMarkdown(chunk.content);
  const refs = capture.refs
    .filter((ref) => mentionedRefs.has(ref.ref))
    .slice(0, MAX_PUBLIC_REFS)
    .map((ref) => ({
      ref: ref.ref,
      kind: ref.role || ref.tag || "control",
      label: truncateOneLine(ref.label || ref.value || "(unlabeled)", MAX_REF_LABEL_CHARS),
      ...(ref.href ? { href: truncateOneLine(ref.href, MAX_REF_HREF_CHARS) } : {}),
      ...(ref.disabled ? { disabled: true } : {}),
    }));

  const chunkLine = includeMetadata && (chunk.hasMore || startFromChar > 0)
    ? `[chunk: chars ${chunk.startChar}-${chunk.endChar} of ${capture.markdown.length}; continue with start_from_char=${chunk.nextStartChar ?? chunk.startChar}]\n\n`
    : "";
  let observation = includeMetadata
    ? `${metadataPrefix}${chunkLine}${chunk.content || "No readable content captured"}`
    : chunk.content || "No readable content captured";
  if (observation.length > maxChars) observation = `${observation.slice(0, maxChars - 12).trimEnd()}\n[truncated]`;

  return {
    page: capture.title || "",
    url: capture.url,
    observation,
    refs,
    ref_count: capture.refs.length,
    signals: capture.signals,
    content_length: capture.markdown.length,
    ...(chunk.hasMore ? { truncated: true } : {}),
    ...(chunk.nextStartChar != null ? { next_start_char: chunk.nextStartChar } : {}),
    ...(startFromChar > 0 ? { started_from_char: startFromChar } : {}),
  };
}

function refsMentionedInMarkdown(markdown: string): Set<string> {
  const refs = new Set<string>();
  for (const match of markdown.matchAll(/\bref:(\d+):/g)) refs.add(match[1]);
  for (const match of markdown.matchAll(/\bref="(\d+)"/g)) refs.add(match[1]);
  return refs;
}

function chunkLiveMarkdown(markdown: string, maxChars: number, startFromChar: number): {
  content: string;
  hasMore: boolean;
  startChar: number;
  endChar: number;
  nextStartChar?: number;
} {
  if (!markdown) {
    return { content: "", hasMore: false, startChar: 0, endChar: 0 };
  }
  if (startFromChar >= markdown.length) {
    throw new Error(`start_from_char (${startFromChar}) exceeds content length ${markdown.length}.`);
  }
  const chunks = chunkMarkdownByStructure(markdown, maxChars);
  const found = chunks.find((chunk) => chunk.end > startFromChar);
  if (!found) {
    const end = Math.min(markdown.length, startFromChar + maxChars);
    return {
      content: markdown.slice(startFromChar, end),
      hasMore: end < markdown.length,
      startChar: startFromChar,
      endChar: end,
      ...(end < markdown.length ? { nextStartChar: end } : {}),
    };
  }
  if (found.text.length > maxChars || found.start < startFromChar) {
    const end = Math.min(markdown.length, startFromChar + maxChars);
    return {
      content: markdown.slice(startFromChar, end),
      hasMore: end < markdown.length,
      startChar: startFromChar,
      endChar: end,
      ...(end < markdown.length ? { nextStartChar: end } : {}),
    };
  }
  return {
    content: found.text,
    hasMore: found.end < markdown.length,
    startChar: found.start,
    endChar: found.end,
    ...(found.end < markdown.length ? { nextStartChar: found.end } : {}),
  };
}

function chunkMarkdownByStructure(markdown: string, maxChars: number): Array<{ text: string; start: number; end: number }> {
  if (!markdown) return [{ text: "", start: 0, end: 0 }];
  const lines = markdown.split("\n");
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let text = "";
  let start = 0;
  let offset = 0;
  let inFence = false;

  const flush = () => {
    if (!text) return;
    chunks.push({ text: text.trim(), start, end: start + text.length });
    text = "";
  };

  for (const line of lines) {
    const withNewline = `${line}\n`;
    const isHeader = /^#{1,6}\s+\S/.test(line);
    const isFence = line.trim().startsWith("```");
    if (isFence) inFence = !inFence;
    if (!inFence && isHeader && text.length > maxChars * 0.55) {
      flush();
      start = offset;
    } else if (!inFence && text.length + withNewline.length > maxChars && text.length > 0) {
      flush();
      start = offset;
    }
    text += withNewline;
    offset += withNewline.length;
  }
  flush();
  return chunks.length ? chunks : [{ text: markdown, start: 0, end: markdown.length }];
}

function scrollScript(direction: string, amount: number): string {
  const signed = direction === "up" || direction === "left" ? -amount : amount;
  const x = direction === "left" || direction === "right" ? signed : 0;
  const y = direction === "up" || direction === "down" ? signed : 0;
  return `JSON.stringify((() => { window.scrollBy({ left: ${x}, top: ${y}, behavior: 'auto' }); return true; })())`;
}

function captureWebPage(): PageCapture {
  const ACTIONABLE_ROLES = new Set([
    "link", "button", "textbox", "searchbox", "checkbox", "radio", "switch",
    "combobox", "listbox", "option", "menuitem", "menuitemcheckbox",
    "menuitemradio", "tab", "slider", "spinbutton",
  ]);
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "meta", "link"]);
  const BLOCK_TAGS = new Set([
    "address", "article", "aside", "blockquote", "details", "div", "dl",
    "fieldset", "figcaption", "figure", "footer", "form", "header", "hr",
    "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table",
    "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  ]);
  const HEADING_RE = /^h[1-6]$/;
  const ELEMENT_UID = "__mimWebElementUid";
  const NEXT_UID = "__mimWebNextElementUid";

  function normalizeText(value: unknown): string {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value: unknown): string {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeMarkdownText(value: unknown): string {
    return String(value ?? "").replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
  }

  function markdownText(value: unknown): string {
    return String(value ?? "").replace(/\s+/g, " ");
  }

  function elementTag(el: Element): string {
    return el.tagName ? el.tagName.toLowerCase() : "";
  }

  function elementRole(el: Element): string | undefined {
    const explicit = el.getAttribute("role")?.trim().toLowerCase();
    if (explicit) return explicit;
    const tag = elementTag(el);
    const inputType = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "a" && (el as HTMLAnchorElement).href) return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "option") return "option";
    if (tag === "input") {
      if (inputType === "search") return "searchbox";
      if (inputType === "checkbox") return "checkbox";
      if (inputType === "radio") return "radio";
      if (inputType === "range") return "slider";
      if (inputType === "number") return "spinbutton";
      if (inputType === "button" || inputType === "submit" || inputType === "reset") return "button";
      return "textbox";
    }
    return undefined;
  }

  function isHidden(el: Element): boolean {
    const tag = elementTag(el);
    if (tag === "html" || tag === "body") return false;
    if ((el as HTMLElement).hidden || el.getAttribute("aria-hidden")?.toLowerCase() === "true") return true;
    try {
      const style = window.getComputedStyle(el);
      const contentVisibility = (style as CSSStyleDeclaration & { contentVisibility?: string }).contentVisibility;
      if (style.display === "none" || style.visibility === "hidden" || contentVisibility === "hidden") return true;
    } catch {}
    return false;
  }

  function visibleText(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";
    if (node.nodeType === Node.ELEMENT_NODE && isHidden(node as Element)) return "";
    return Array.from(node.childNodes || []).map(visibleText).join(" ");
  }

  function labelledByText(el: Element): string {
    const ids = (el.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
    return ids.map((id) => document.getElementById(id)?.textContent || "").join(" ");
  }

  function elementLabel(el: Element): string {
    const tag = elementTag(el);
    const input = el as HTMLInputElement;
    const directLabel = el.getAttribute("aria-label")
      || labelledByText(el)
      || el.getAttribute("alt")
      || el.getAttribute("title")
      || el.getAttribute("placeholder")
      || (tag === "input" ? input.value : "")
      || el.textContent
      || el.getAttribute("name")
      || tag;
    return normalizeText(directLabel);
  }

  function isDisabled(el: Element): boolean {
    return (el as HTMLButtonElement).disabled === true
      || el.hasAttribute("disabled")
      || el.getAttribute("aria-disabled")?.toLowerCase() === "true";
  }

  function isFocusable(el: Element): boolean {
    const tabIndex = (el as HTMLElement).tabIndex;
    if (tabIndex >= 0) return true;
    const tag = elementTag(el);
    if (tag === "a") return Boolean((el as HTMLAnchorElement).href);
    if (["button", "input", "select", "textarea"].includes(tag)) return true;
    return (el as HTMLElement).isContentEditable === true;
  }

  function isActionable(el: Element): boolean {
    const role = elementRole(el);
    return isFocusable(el) || (role != null && ACTIONABLE_ROLES.has(role));
  }

  function uidFor(el: Element): string {
    const anyEl = el as Element & Record<string, string>;
    if (!anyEl[ELEMENT_UID]) {
      const anyWindow = window as unknown as Record<string, number>;
      anyWindow[NEXT_UID] = anyWindow[NEXT_UID] || 1;
      Object.defineProperty(el, ELEMENT_UID, {
        configurable: true,
        enumerable: false,
        value: String(anyWindow[NEXT_UID]++),
      });
    }
    return anyEl[ELEMENT_UID];
  }

  function attr(name: string, value: unknown): string {
    const text = String(value ?? "");
    return text ? ` ${name}="${escapeHtml(text)}"` : "";
  }

  function countVisible(selector: string): number {
    return Array.from(document.querySelectorAll(selector)).filter((el) => !isHidden(el)).length;
  }

  const refs: ActionRef[] = [];
  let refCounter = 0;

  function refFor(el: Element): ActionRef | null {
    if (!isActionable(el)) return null;
    const existing = refs.find((item) => item.uid === uidFor(el));
    if (existing) return existing;
    const ref = String(++refCounter);
    const tag = elementTag(el);
    const role = elementRole(el);
    const htmlEl = el as HTMLInputElement;
    const item: ActionRef = {
      ref,
      uid: uidFor(el),
      tag,
      ...(role ? { role } : {}),
      label: elementLabel(el),
      ...((el as HTMLAnchorElement).href ? { href: (el as HTMLAnchorElement).href } : {}),
      ...(typeof htmlEl.value === "string" ? { value: htmlEl.value } : {}),
      ...(isDisabled(el) ? { disabled: true } : {}),
    };
    refs.push(item);
    return item;
  }

  function renderChildren(parent: Node): string {
    const shadowRoot = (parent as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    const shadow = shadowRoot ? renderChildren(shadowRoot) : "";
    return shadow + Array.from(parent.childNodes || []).map(renderNode).join("");
  }

  function renderNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return markdownText(node.nodeValue || "");
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) return renderChildren(node);

    const el = node as Element;
    const tag = elementTag(el);
    if (!tag || SKIP_TAGS.has(tag) || isHidden(el)) return "";

    const ref = refFor(el);
    const childText = renderChildren(el);
    const label = elementLabel(el);

    if (HEADING_RE.test(tag)) {
      return `\n\n${"#".repeat(Number(tag.slice(1)))} ${childText || escapeMarkdownText(label)}\n\n`;
    }
    if (tag === "a") {
      const href = (el as HTMLAnchorElement).href || el.getAttribute("href") || "";
      const text = childText || escapeMarkdownText(label || href);
      return `[${text}](${ref ? `ref:${ref.ref}:${href}` : href})`;
    }
    if (tag === "button") {
      const disabled = isDisabled(el) ? " disabled" : "";
      const refAttr = ref ? ` ref="${ref.ref}"` : "";
      return `<button${refAttr}${attr("type", el.getAttribute("type") || "")}${disabled}>${escapeHtml(label)}</button>`;
    }
    if (tag === "input") {
      const input = el as HTMLInputElement;
      const disabled = isDisabled(el) ? " disabled" : "";
      const checked = input.checked ? " checked" : "";
      const refAttr = ref ? ` ref="${ref.ref}"` : "";
      return `<input${refAttr}${attr("type", input.type || el.getAttribute("type") || "text")}${attr("name", input.name)}${attr("placeholder", input.placeholder)} value="${escapeHtml(input.value)}"${disabled}${checked}>`;
    }
    if (tag === "textarea") {
      const textarea = el as HTMLTextAreaElement;
      const disabled = isDisabled(el) ? " disabled" : "";
      const refAttr = ref ? ` ref="${ref.ref}"` : "";
      return `<textarea${refAttr}${attr("name", textarea.name)}${attr("placeholder", textarea.placeholder)}${disabled}>${escapeHtml(textarea.value || textarea.textContent || "")}</textarea>`;
    }
    if (tag === "select") {
      const select = el as HTMLSelectElement;
      const disabled = isDisabled(el) ? " disabled" : "";
      const refAttr = ref ? ` ref="${ref.ref}"` : "";
      const selected = select.selectedOptions?.[0]?.textContent || select.value || label;
      return `<select${refAttr}${attr("name", select.name)}${disabled}>${escapeHtml(selected)}</select>`;
    }
    if (tag === "img") {
      const src = (el as HTMLImageElement).src || el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || label;
      return alt || src ? `![${escapeMarkdownText(alt)}](${src})` : "";
    }
    if (tag === "br") return "\n";
    if (tag === "li") return `\n- ${childText}\n`;
    if (tag === "hr") return "\n\n---\n\n";
    if (tag === "pre") return `\n\n\`\`\`\n${el.textContent || ""}\n\`\`\`\n\n`;
    if (BLOCK_TAGS.has(tag)) return `\n\n${childText}\n\n`;
    return childText;
  }

  const root = document.body || document.documentElement;
  const markdown = renderNode(root)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const text = root ? visibleText(root).replace(/\s+/g, " ").trim() : "";

  return {
    title: document.title || "",
    url: document.location.href,
    markdown,
    refs,
    signals: {
      visible_text_chars: text.length,
      ref_count: refs.length,
      link_count: countVisible("a[href]"),
      button_count: countVisible('button, [role="button"]'),
      form_control_count: countVisible("input, select, textarea"),
      heading_count: countVisible('h1, h2, h3, h4, h5, h6, [role="heading"]'),
    },
  };
}

function performElementAction(input: { action: "click" | "type"; ref: string; uid: string; text?: string }): { ok: true; message?: string } | { ok: false; error: string } {
  const ELEMENT_UID = "__mimWebElementUid";

  function isDisabled(el: Element): boolean {
    return (el as HTMLButtonElement).disabled === true
      || el.hasAttribute("disabled")
      || el.getAttribute("aria-disabled")?.toLowerCase() === "true";
  }

  function dispatch(el: Element, type: string): void {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  }

  const captureRefs = (() => {
    const root = document.body || document.documentElement;
    const found: Element[] = [];
    const walk = (node: Node) => {
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        found.push(node as Element);
        const shadow = (node as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (shadow) walk(shadow);
      }
      for (const child of Array.from(node.childNodes || [])) walk(child);
    };
    if (root) walk(root);
    return found;
  })();

  const element = captureRefs.find((el) => (el as Element & Record<string, string>)[ELEMENT_UID] === input.uid) as HTMLElement | undefined;
  if (!element) {
    return { ok: false, error: `Stale ref '${input.ref}'. Run web observe again.` };
  }
  if (isDisabled(element)) return { ok: false, error: `Ref '${input.ref}' is disabled.` };

  if (input.action === "click") {
    element.focus?.();
    element.click();
    return { ok: true, message: `Clicked ref ${input.ref}.` };
  }

  element.focus?.();
  const text = input.text ?? "";
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.value = text;
    dispatch(element, "input");
    dispatch(element, "change");
    return { ok: true, message: `Typed into ref ${input.ref}.` };
  }
  if (element instanceof HTMLSelectElement) {
    const wanted = text.toLowerCase();
    const option = Array.from(element.options).find((opt) =>
      opt.value.toLowerCase() === wanted || (opt.textContent || "").trim().toLowerCase() === wanted
    ) || Array.from(element.options).find((opt) => (opt.textContent || "").toLowerCase().includes(wanted));
    if (!option) return { ok: false, error: `No select option matching '${text}' for ref '${input.ref}'.` };
    element.value = option.value;
    dispatch(element, "input");
    dispatch(element, "change");
    return { ok: true, message: `Selected option for ref ${input.ref}.` };
  }
  if (element.isContentEditable) {
    element.textContent = text;
    dispatch(element, "input");
    return { ok: true, message: `Typed into ref ${input.ref}.` };
  }
  return { ok: false, error: `Ref '${input.ref}' is not text-editable.` };
}
