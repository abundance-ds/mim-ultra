import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { extname, resolve, sep } from "path";
import { type CoreMessage } from "ai";
import { MAX_STEPS, MODEL, runAgent, systemPrompt } from "./agent.js";
import {
  getContextStats,
  recordExactPromptTokens,
  resetExactPromptTokens,
  setContextRuntime,
  updateContextSnapshot,
} from "./context.js";
import {
  deleteSecret,
  fillSecretField,
  getSecretStatus,
  listSecrets,
  lockSecrets,
  saveSecret,
  unlockSecrets,
} from "./secrets.js";
import { getAgentState, markAgentOffline, setAgentState, type AgentState } from "./state.js";
import {
  clearActiveSessionId,
  createSession,
  deleteSession,
  getSession,
  listSessions,
  loadActiveSession,
  saveSession,
  setActiveSessionId,
} from "./sessions.js";

const PORT = parseInt(process.env.PORT ?? "7080", 10);
const PUBLIC_CONFIG = {
  mimPort: process.env.MIM_PUBLIC_PORT ?? "7090",
  vncPort: process.env.VNC_PUBLIC_PORT ?? "6090",
  ttydPort: process.env.TTYD_PUBLIC_PORT ?? "7690",
};
const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf-8");
const VNC_HTML = readFileSync(new URL("./vnc.html", import.meta.url), "utf-8");
const NOVNC_ROOT = resolve("/usr/share/novnc");

const initialSession = loadActiveSession();
const messages: CoreMessage[] = initialSession ? [...initialSession.messages] : [];
let activeSessionId: string | null = initialSession?.id ?? null;
let totalInputTokens = 0;
let totalOutputTokens = 0;

setContextRuntime({
  getMessages: () => messages,
  getSystemPrompt: () => systemPrompt,
});

function summarizeToolArgs(name: string, args: unknown): string {
  const data = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (name === "secret") {
    const action = typeof data.action === "string" ? data.action : "action";
    const target =
      typeof data.label === "string"
        ? data.label
        : typeof data.id === "string"
          ? data.id
          : typeof data.field === "string"
            ? data.field
            : "";
    return `secret ${action}${target ? ` - ${target}` : ""}`;
  }
  if (name === "web") {
    const action = typeof data.action === "string" ? data.action : "action";
    const target =
      typeof data.url === "string"
        ? data.url
        : typeof data.ref === "string"
          ? `ref ${data.ref}`
          : "";
    return `web ${action}${target ? ` - ${target}` : ""}`.slice(0, 96);
  }
  const preferred =
    (name === "bash" || name === "atspi") &&
    typeof data.command === "string"
      ? data.command
      : name === "readFile" && typeof data.command === "string"
        ? data.command
        : typeof data.path === "string"
          ? data.path
          : typeof data.command === "string"
            ? data.command
            : JSON.stringify(args);
  return preferred.replace(/\s+/g, " ").trim().slice(0, 96);
}

function redactSecretArgs(args: unknown): unknown {
  if (!args || typeof args !== "object") return args;
  const data = { ...(args as Record<string, unknown>) };
  for (const key of ["passphrase", "password", "otp", "notes"]) {
    if (key in data) data[key] = "[redacted]";
  }
  if (data.fields && typeof data.fields === "object") {
    data.fields = Object.fromEntries(
      Object.keys(data.fields as Record<string, unknown>).map((key) => [key, "[redacted]"])
    );
  }
  return data;
}

function scrubSecretToolData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSecretToolData);
  if (!value || typeof value !== "object") return value;

  const data = { ...(value as Record<string, unknown>) };
  const toolName =
    typeof data.toolName === "string"
      ? data.toolName
      : typeof data.name === "string"
        ? data.name
        : undefined;

  for (const [key, item] of Object.entries(data)) {
    data[key] = scrubSecretToolData(item);
  }

  if (toolName === "secret") {
    if ("args" in data) data.args = redactSecretArgs(data.args);
    if ("result" in data) data.result = "[secret redacted]";
    if ("output" in data) data.output = "[secret redacted]";
  }

  return data;
}

function stateLine(state: AgentState): string {
  if (state.status.startsWith("tool:")) {
    const tool = state.tool ?? state.status.slice("tool:".length);
    return state.detail ? `${tool} - ${state.detail}` : `${tool} running`;
  }
  return state.detail || state.status;
}

function writeStateEvent(res: ServerResponse, state: AgentState) {
  const active = state.status !== "idle" && state.status !== "offline";
  res.write(
    `data: ${JSON.stringify({
      type: "state",
      state,
      line: stateLine(state),
      active,
    })}\n\n`
  );
}

function cors(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function persistActiveSession() {
  if (!messages.length) {
    activeSessionId = null;
    clearActiveSessionId();
    return null;
  }

  const meta = activeSessionId
    ? saveSession(activeSessionId, messages)
    : createSession(messages);
  if (meta) {
    activeSessionId = meta.id;
    setActiveSessionId(meta.id);
  }
  return meta;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runOpenCommand(command?: string): string {
  const trimmed = command?.trim();
  if (!trimmed) throw new Error("missing command");

  return execFileSync(
    "bash",
    ["-lc", `atspi open ${shellQuote(trimmed)} >/tmp/mim-open-app.log 2>&1`],
    {
      encoding: "utf-8",
      timeout: 8000,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
    }
  ).trimEnd();
}

function runDesktopAction(action: string, command?: string): string {
  if (action === "open-command" || action === "open-app") {
    return runOpenCommand(command);
  }

  if (action === "open-launcher") {
    return execFileSync(
      "bash",
      [
        "-lc",
        [
          "if command -v xfce4-appfinder >/dev/null 2>&1; then",
          "  atspi open xfce4-appfinder;",
          "elif command -v xfrun4 >/dev/null 2>&1; then",
          "  atspi open xfrun4;",
          "else",
          "  atspi open xfce4-terminal;",
          "fi >/tmp/mim-open-app.log 2>&1",
        ].join(" "),
      ],
      {
        encoding: "utf-8",
        timeout: 8000,
        env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
      }
    ).trimEnd();
  }

  const scripts: Record<string, string> = {
    "focus-prev":
      "bspc node -f prev.local.!hidden.window 2>/dev/null || bspc node -f last.local.!hidden.window",
    "focus-next":
      "bspc node -f next.local.!hidden.window 2>/dev/null || bspc node -f first.local.!hidden.window",
    tile:
      "bspc desktop -l tiled; for id in $(bspc query -N -n .floating); do bspc node \"$id\" -t tiled; done",
    monocle: "bspc desktop -l monocle",
    float: "bspc node -t ~floating",
    close: "bspc node -c",
  };

  const script = scripts[action];
  if (!script) throw new Error(`unknown desktop action: ${action}`);

  return execFileSync("bash", ["-lc", script], {
    encoding: "utf-8",
    timeout: 3000,
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
  }).trimEnd();
}

async function handleChat(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const text = body.message ?? body.content ?? "";
  if (!text) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "missing message" }));
    return;
  }

  messages.push({ role: "user", content: text });
  persistActiveSession();
  const contextStats = updateContextSnapshot(messages, systemPrompt);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const controller = new AbortController();
  let aborted = false;
  const onClose = () => {
    if (!res.writableEnded) {
      aborted = true;
      controller.abort();
    }
  };
  req.on("close", onClose);

  let state = setAgentState({
    status: "thinking",
    tool: null,
    detail: "thinking",
    model: MODEL,
    tokensIn: totalInputTokens,
    tokensOut: totalOutputTokens,
    contextTokens: contextStats.contextTokens,
    messages: messages.length,
  });
  writeStateEvent(res, state);

  const result = runAgent(messages, controller.signal);
  let responseStarted = false;

  const safeWrite = (payload: unknown) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    for await (const chunk of result.fullStream) {
      if (aborted) break;
      if (chunk.type === "text-delta") {
        if (!responseStarted) {
          responseStarted = true;
          state = setAgentState({
            status: "responding",
            tool: null,
            detail: "responding",
            messages: messages.length,
          });
          writeStateEvent(res, state);
        }
        safeWrite({ type: "text", text: chunk.textDelta });
      } else if (chunk.type === "tool-call") {
        responseStarted = false;
        const summary = summarizeToolArgs(chunk.toolName, chunk.args);
        const displayArgs =
          chunk.toolName === "secret" ? redactSecretArgs(chunk.args) : chunk.args;
        state = setAgentState({
          status: `tool:${chunk.toolName}`,
          tool: chunk.toolName,
          detail: summary,
          messages: messages.length,
        });
        writeStateEvent(res, state);
        safeWrite({
          type: "tool-call",
          name: chunk.toolName,
          args: displayArgs,
          summary,
        });
      } else if (chunk.type === "tool-result") {
        responseStarted = false;
        const textResult =
          chunk.toolName === "secret"
            ? "[secret result redacted]"
            : typeof chunk.result === "string"
              ? chunk.result
              : JSON.stringify(chunk.result);
        state = setAgentState({
          status: "thinking",
          tool: null,
          detail: "thinking",
          messages: messages.length,
        });
        writeStateEvent(res, state);
        safeWrite({
          type: "tool-result",
          name: chunk.toolName,
          result: textResult.length > 2000 ? textResult.slice(0, 2000) + "..." : textResult,
        });
      }
    }

    if (aborted) {
      persistActiveSession();
      state = setAgentState({
        status: "idle",
        tool: null,
        detail: "stopped",
        tokensIn: totalInputTokens,
        tokensOut: totalOutputTokens,
        contextTokens: getContextStats().contextTokens,
        messages: messages.length,
      });
      writeStateEvent(res, state);
      safeWrite({ type: "aborted" });
    } else {
      const response = await result.response;
      for (const msg of response.messages) {
        messages.push(scrubSecretToolData(msg) as CoreMessage);
      }

      const usage = await result.usage;
      totalInputTokens += usage.promptTokens;
      totalOutputTokens += usage.completionTokens;
      recordExactPromptTokens(usage.promptTokens);

      const nextContextStats = updateContextSnapshot(messages, systemPrompt);
      const sessionMeta = persistActiveSession();

      state = setAgentState({
        status: "idle",
        tool: null,
        detail: "idle",
        tokensIn: totalInputTokens,
        tokensOut: totalOutputTokens,
        contextTokens: nextContextStats.contextTokens,
        messages: messages.length,
      });
      writeStateEvent(res, state);
      safeWrite({
        type: "done",
        usage: { input: totalInputTokens, output: totalOutputTokens },
        context: nextContextStats,
        messageCount: messages.length,
        session: sessionMeta,
      });
    }
    res.end();
  } catch (e: any) {
    if (aborted) {
      persistActiveSession();
      setAgentState({
        status: "idle",
        tool: null,
        detail: "stopped",
        tokensIn: totalInputTokens,
        tokensOut: totalOutputTokens,
        contextTokens: getContextStats().contextTokens,
        messages: messages.length,
      });
      try {
        res.end();
      } catch {
        /* already ended */
      }
      return;
    }
    state = setAgentState({
      status: "idle",
      tool: null,
      detail: "error",
      contextTokens: getContextStats().contextTokens,
      messages: messages.length,
    });
    persistActiveSession();
    writeStateEvent(res, state);
    safeWrite({ type: "error", error: e.message ?? String(e) });
    res.end();
  } finally {
    req.off("close", onClose);
  }
}

function handleStatus(_req: IncomingMessage, res: ServerResponse) {
  const activeSession = activeSessionId ? getSession(activeSessionId) : null;
  const context = updateContextSnapshot(messages, systemPrompt);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      model: MODEL,
      maxSteps: MAX_STEPS,
      messages: messages.length,
      activeSession: activeSession
        ? {
            id: activeSession.id,
            title: activeSession.title,
            createdAt: activeSession.createdAt,
            updatedAt: activeSession.updatedAt,
            messageCount: activeSession.messageCount,
            active: true,
          }
        : null,
      system: systemPrompt.slice(0, 200),
      context,
      state: getAgentState(),
    })
  );
}

function handleReset(_req: IncomingMessage, res: ServerResponse) {
  let archived: { id: string; title: string } | null = null;
  if (messages.length) {
    const meta = persistActiveSession();
    if (meta) archived = { id: meta.id, title: meta.title };
  }
  messages.length = 0;
  activeSessionId = null;
  clearActiveSessionId();
  totalInputTokens = 0;
  totalOutputTokens = 0;
  resetExactPromptTokens();
  const context = updateContextSnapshot(messages, systemPrompt);
  setAgentState({
    status: "idle",
    tool: null,
    detail: "idle",
    tokensIn: 0,
    tokensOut: 0,
    contextTokens: context.contextTokens,
    messages: 0,
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, archived, context }));
}

function handleNoVncAsset(pathname: string, res: ServerResponse) {
  const relative = decodeURIComponent(pathname.slice("/novnc/".length));
  const assetPath = resolve(NOVNC_ROOT, relative);

  if (assetPath !== NOVNC_ROOT && !assetPath.startsWith(NOVNC_ROOT + sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  const type = contentTypes[extname(assetPath)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(readFileSync(assetPath));
}

function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): boolean {
  if (pathname === "/api/sessions" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listSessions(activeSessionId)));
    return true;
  }

  if (pathname === "/api/sessions/current" && req.method === "GET") {
    const session = activeSessionId ? getSession(activeSessionId) : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(session ? { ...session, active: true } : null));
    return true;
  }

  const loadMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/load$/);
  if (loadMatch && req.method === "POST") {
    persistActiveSession();
    const session = getSession(loadMatch[1]);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "session not found" }));
      return true;
    }
    messages.length = 0;
    for (const m of session.messages) messages.push(m);
    activeSessionId = session.id;
    setActiveSessionId(session.id);
    totalInputTokens = 0;
    totalOutputTokens = 0;
    resetExactPromptTokens();
    const context = updateContextSnapshot(messages, systemPrompt);
    setAgentState({
      status: "idle",
      tool: null,
      detail: `loaded: ${session.title}`,
      tokensIn: 0,
      tokensOut: 0,
      contextTokens: context.contextTokens,
      messages: messages.length,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        messageCount: messages.length,
        context,
        session: { ...session, active: true },
      })
    );
    return true;
  }

  const getMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (getMatch) {
    const id = getMatch[1];
    if (req.method === "GET") {
      const session = getSession(id);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return true;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(session));
      return true;
    }
    if (req.method === "DELETE") {
      deleteSession(id);
      const activeCleared = activeSessionId === id;
      if (activeCleared) {
        messages.length = 0;
        activeSessionId = null;
        clearActiveSessionId();
        resetExactPromptTokens();
        const context = updateContextSnapshot(messages, systemPrompt);
        setAgentState({
          status: "idle",
          tool: null,
          detail: "idle",
          tokensIn: 0,
          tokensOut: 0,
          contextTokens: context.contextTokens,
          messages: 0,
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          activeCleared,
          context: updateContextSnapshot(messages, systemPrompt),
        })
      );
      return true;
    }
  }

  return false;
}

async function handleDesktopAction(req: IncomingMessage, res: ServerResponse) {
  const body = JSON.parse(await readBody(req));
  const action = String(body.action ?? "");
  const command =
    body.command === undefined
      ? body.app === undefined
        ? undefined
        : String(body.app)
      : String(body.command);
  const output = runDesktopAction(action, command);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, action, command, output }));
}

async function handleSecrets(req: IncomingMessage, res: ServerResponse, pathname: string) {
  if (req.method === "GET" && pathname === "/api/secrets") {
    const status = getSecretStatus();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...status, entries: status.unlocked ? listSecrets() : [] }));
    return;
  }

  const body = req.method === "POST" ? JSON.parse(await readBody(req)) : {};
  let result: unknown;

  if (pathname === "/api/secrets/unlock" && req.method === "POST") {
    result = unlockSecrets(String(body.passphrase ?? ""));
  } else if (pathname === "/api/secrets/lock" && req.method === "POST") {
    result = lockSecrets();
  } else if (pathname === "/api/secrets/save" && req.method === "POST") {
    result = saveSecret({
      id: body.id === undefined ? undefined : String(body.id),
      label: body.label === undefined ? undefined : String(body.label),
      kind: body.kind === undefined ? undefined : String(body.kind),
      url: body.url === undefined ? undefined : String(body.url),
      username: body.username === undefined ? undefined : String(body.username),
      password: body.password === undefined ? undefined : String(body.password),
      otp: body.otp === undefined ? undefined : String(body.otp),
      notes: body.notes === undefined ? undefined : String(body.notes),
      fields:
        body.fields && typeof body.fields === "object"
          ? Object.fromEntries(
              Object.entries(body.fields as Record<string, unknown>).map(([key, value]) => [
                key,
                String(value),
              ])
            )
          : undefined,
    });
  } else if (pathname === "/api/secrets/delete" && req.method === "POST") {
    result = deleteSecret(String(body.id ?? body.label ?? ""));
  } else if (pathname === "/api/secrets/fill" && req.method === "POST") {
    result = fillSecretField(String(body.id ?? body.label ?? ""), String(body.field ?? "password"));
  } else {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, result, status: getSecretStatus() }));
}

const server = createServer(async (req, res) => {
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (pathname === "/api/chat" && req.method === "POST") {
      await handleChat(req, res);
    } else if (pathname === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(PUBLIC_CONFIG));
    } else if (pathname === "/api/status") {
      handleStatus(req, res);
    } else if (pathname === "/api/reset" && req.method === "POST") {
      handleReset(req, res);
    } else if (pathname === "/api/desktop" && req.method === "POST") {
      await handleDesktopAction(req, res);
    } else if (pathname === "/api/sessions" || pathname.startsWith("/api/sessions/")) {
      handleSessionRoutes(req, res, pathname);
    } else if (pathname === "/api/secrets" || pathname.startsWith("/api/secrets/")) {
      await handleSecrets(req, res, pathname);
    } else if (pathname === "/vnc" || pathname === "/vnc.html") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(VNC_HTML.replaceAll("__VNC_PUBLIC_PORT__", PUBLIC_CONFIG.vncPort));
    } else if (pathname.startsWith("/novnc/")) {
      handleNoVncAsset(pathname, res);
    } else if (pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      res.end(UI_HTML);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  } catch (e: any) {
    console.error(e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
});

server.on("clientError", (error, socket) => {
  console.error("http client error:", error.message);
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, () => {
  console.log(`mim agent server on http://localhost:${PORT}`);
  console.log(`model: ${MODEL}`);
  console.log(`maxSteps: ${MAX_STEPS}`);
  const context = updateContextSnapshot(messages, systemPrompt);
  setAgentState({
    status: "idle",
    tool: null,
    detail: "idle",
    model: MODEL,
    tokensIn: totalInputTokens,
    tokensOut: totalOutputTokens,
    contextTokens: context.contextTokens,
    messages: messages.length,
  });
});

function markInternalError(reason: unknown) {
  try {
    console.error(reason);
    setAgentState({
      status: "idle",
      tool: null,
      detail: "internal error",
      contextTokens: getContextStats().contextTokens,
      messages: messages.length,
    });
  } catch (stateError) {
    console.error("failed to record internal error:", stateError);
  }
}

process.on("uncaughtException", (error) => {
  markInternalError(error);
});

process.on("unhandledRejection", (reason) => {
  markInternalError(reason);
});

process.once("exit", () => markAgentOffline());
process.once("SIGINT", () => {
  markAgentOffline();
  process.exit(0);
});
process.once("SIGTERM", () => {
  markAgentOffline();
  process.exit(0);
});
