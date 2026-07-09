# mim — Agent-Native Linux

A computing environment where AI is the primary operating subject.

This is not "an AI assistant on Linux." It is not a chatbot with shell access, a compliance sandbox, or a remote desktop for a language model. It is the beginning of a different kind of computer. The AI lives here. The human visits.

## The idea

A traditional OS assumes a human sits at the keyboard:

```
user → apps → windows → files
```

An AI-native OS assumes the primary actor is autonomous:

```
intent → operating subject → tools → artifacts → memory
```

The desktop becomes a compatibility layer. Windows become surfaces. Apps become tools. Files become working memory. The UI becomes observability and steering.

The core question is not *"How does an AI use today's computer?"* but *"What does a computer become when the primary user is an autonomous reasoning system?"*

## How it works

One VM, one agent, one desktop. The agent runs inside the box and controls it through accessibility APIs and shell access. A human watches and steers through a browser.

```
Host (browser)
  └── OrbStack VM (agent-desktop, Ubuntu 22.04 arm64)
        ├── bspwm tiling desktop on virtual display :99 (1280×800)
        ├── noVNC/websockify on :6080 (VNC transport)
        ├── Agent server on :7080 (command center + chat + API)
        ├── ttyd on :7681 → tmux session "claude" → Claude Code
        ├── chrome-free VNC embed at :7080/vnc
        ├── optional polybar status strip fed by /tmp/mim/state.*
        ├── atspi — native AT-SPI accessibility tool (C, 1272 lines)
        ├── encrypted secret vault at agent/secrets.vault.json
        ├── shared mailroom at shared/ (mount as /shared in boxes/containers)
        ├── file-based session persistence at agent/sessions/ui/
        └── agent/ — the agent's mutable home
```

The agent perceives through `web` and desktop accessibility trees (`atspi read`, `atspi interact`), acts through clicks, keystrokes, and shell commands, and remembers through files in `agent/`.

Parallelism comes from running more boxes, not more agents in one box. One box = one agent = one display = one keyboard focus. No races.

## The agent

The agent is the principal; auth, keys, `.env`, and admin access are allowed.

An agent is:

```
AGENTS.md + tools + runtime state
```

The server reads `AGENTS.md` as the complete system prompt. `CLAUDE.md` delegates to it. Runtime state lives under `agent/`:

```
agent/
  notes.md     — anything future runs should notice first
  sessions/    — run history and UI-persisted sessions
  tools/       — agent-authored scripts and helpers
```

The agent starts with six tools: `bash`, `readFile`, `writeFile`, `atspi`, `web`, `secret`. If it needs a new ability, it writes a script into `agent/tools/`. No ceremony.

Tool output is compact by default. `bash`, `readFile`, and `atspi` accept command-front output flags such as `--limit 24000 -- ...`, `--offset 12000 --limit 12000 -- ...`, and `--full -- ...`. Truncated outputs are saved under `agent/sessions/tool-output/` so the live LLM context stays small without losing exact evidence.

## Tools

### atspi — desktop accessibility

```bash
atspi apps                    # list running applications
atspi interact <app>          # flat list of clickable elements (primary command)
atspi read <app>              # accessibility tree (filtered)
atspi find <app> <pattern>    # matching tree lines from large pages
atspi click <app> <name>      # click an element by exact name
atspi insert <app> [field] <text> # direct editable text insertion
atspi type <text>             # type into focused element
atspi key <combo>             # send key combo (ctrl+s, Return, alt+F4)
atspi snap [app]              # snapshot + diff from previous
atspi open <command>          # launch an application
atspi focus <app>             # activate by title or WM_CLASS
atspi close <app>             # close by title or WM_CLASS
```

Native C binary. ~48ms startup. Works with any GTK app via AT-SPI accessibility APIs. Web content (WebKit/Surf) produces noisier trees — `interact` exists specifically to cut through that noise.

### web — stateful browser

Persistent Chromium browser tool for websites. Returns readable page observations with short refs for links, buttons, and fields; actions are `open`, `observe`, `click`, `type`, `scroll`, `wait`, `extract`, and `tabs`.

### secret — agent credential vault

The command center has a `Secrets` drawer, and the agent can unlock the encrypted vault through the `secret` tool when it knows the passphrase. Empty passphrase is valid; a no-passphrase vault opens automatically for agent secret actions.

```text
secret status               # vault state
secret unlock [passphrase]  # open/create a vault; empty means no passphrase
secret list                 # metadata only
secret fill <label> password # type into focused desktop field
secret get <label> api_key   # return a field value when it truly needs the string
secret save ...              # create/update credentials
```

The vault file is `agent/secrets.vault.json`, encrypted with AES-256-GCM (scrypt KDF) and ignored by git. Browser transcripts and stored chat history redact `secret` tool arguments/results. The strong path is `fill`, because it gives the agent practical authority without turning passwords into ordinary chat text.

## Browsers

| Browser | Access method | Best for |
|---------|--------------|----------|
| Stateful Chromium | `web` tool — readable refs | Default for web pages |
| Surf (WebKit2GTK) | AT-SPI — full native visibility | Fallback / visible desktop browsing |
| Epiphany (GTK) | AT-SPI | Quick browsing, but crashes on some heavy pages |

Use `web` first for websites. Use AT-SPI for native apps and Surf/Epiphany fallback browsing.

Google Search returns CAPTCHAs from the VM's IP. Use DuckDuckGo (Lite for Surf) or Google Scholar.

## Running

All agent server and desktop processes must run inside the `agent-desktop` OrbStack VM via `orbctl run -m agent-desktop ...`; never start `src/server.ts` or related services directly on the host Mac.

Prerequisites: macOS with OrbStack.

```bash
# One-command setup — creates VM, installs packages, builds tools, starts everything
./setup.sh

# Open in browser
open http://agent-desktop.orb.local:7080  # command center
open http://localhost:6080                # live desktop view (raw noVNC)
open http://agent-desktop.orb.local:7681  # Claude Code terminal
```

Docker is available through OrbStack and `docker-compose.yml` can run a separate containerized copy:

```bash
docker compose up -d --build
open http://localhost:7090  # Docker command center
open http://localhost:6090  # Docker noVNC
open http://localhost:7690  # Docker Claude Code terminal
```

The primary live environment is still the `agent-desktop` OrbStack VM unless explicitly switched. Setup symlinks `/shared` in the VM to `./shared`, Docker compose bind-mounts `./shared:/shared`, and Docker keeps its own agent home in the `agent-data` volume.

To restart the agent server manually:

```bash
orbctl run -m agent-desktop bash -c 'cd /Users/waqr/Desktop/mims/mim-ubuntu && npx tsx src/server.ts'
```

## Stack

TypeScript. Vercel AI SDK with Claude. No Python, no frameworks, no abstractions beyond what the tools need.

```
ai@4.1.66           — Vercel AI SDK (streamText, tool definitions)
@ai-sdk/anthropic@1.2.12 — Claude provider
zod@^3.25           — minimal SDK tool wrappers
tsx                  — TypeScript execution
```

**Version lock:** AI SDK 5 + @ai-sdk/anthropic v2+ has broken Zod schema conversion (missing `type: "object"`). Do not upgrade without testing tool calls end-to-end.

Default model: `claude-sonnet-4-6` (configurable via `MODEL` env var in `.env`). Tool-loop budget defaults to `MAX_STEPS=1000000`; set `MAX_STEPS` only when you intentionally want a smaller cap.

The command center also has a `Chat | Claude Code` panel toggle. `Chat` uses the existing AI SDK server path; `Claude Code` embeds ttyd on port `7681`, attached to the persistent tmux session `claude` in the repo root.

The agent tracks cumulative API usage (`tokensIn` / `tokensOut`) and current live context (`contextTokens`) separately.

The agent server is ~700 lines of TypeScript. The tools are small TypeScript wrappers around command-style interfaces. The atspi C binary is ~1270 lines. Session persistence is ~180 lines. That is the core system.

## Design principles

**One agent per box.** GUI control is inherently global — one display, one mouse, one keyboard focus. Multiple agents sharing one desktop would race. Parallelism happens above the box by running more boxes.

**Shared mailroom, not shared desktop.** Future boxes should communicate through `shared/` mounted as `/shared`, using files in `mailbox/`, `artifacts/`, and `state/`. Do not put secrets there.

**No supervisor (yet).** Each box is self-contained. A supervisor that splits tasks, starts boxes, and merges results may come later, but adding it prematurely would complicate the thing that matters now: making one agent effective in one box.

**Tools, not apps.** Applications are callable tools. `atspi open "surf 'https://example.com'"` is the agent interface; the human rail can run the same raw app commands and open the native XFCE app finder.

**The agent can change itself.** The system prompt is `AGENTS.md`. The agent can edit that file, its notes, and its helper scripts.

**Lean tooling.** Small C binaries over Python scripts. Direct shell commands over RPC. Files over databases. No abstractions beyond what the task requires.

## Where this is going

The current prototype is one agent in one box with a working command center: chat with SSE streaming, compact expandable tool activity rows, status bar, session persistence, encrypted credential vault, and a live chrome-free noVNC desktop tile. The vision (see `SPEC.md`) includes:

- **Kacheln** — tiled surfaces instead of windows, arranged by the agent or supervisor
- **Multi-box** — parameterized boxes with isolated displays, ports, and workspaces
- **Durable identity** — AI-owned accounts and capabilities, not password pasting
- **Shared folders** — mailroom model for cross-box coordination
- **Model selection in UI** — currently hardcoded via env var
- **Agent notes view** — `agent/notes.md` not yet surfaced in the command center

The hard product problem is not "how does an AI safely type a password." It is "what authority should this operating subject have, and how do we make that authority durable, scoped, and revocable?"

## Files

### Source

| File | What |
|------|------|
| `src/agent.ts` | Agent core — loads prompt, calls Claude via AI SDK |
| `src/tools.ts` | Tool definitions (bash, readFile, writeFile, atspi, web, secret) |
| `src/web.ts` | Stateful Chromium web tool: observe/click/type/scroll/extract with refs |
| `src/server.ts` | HTTP server with SSE streaming, session CRUD, secrets API, state |
| `src/sessions.ts` | File-based session persistence at `agent/sessions/ui/` |
| `src/secrets.ts` | Encrypted vault backend (AES-256-GCM, scrypt KDF) and desktop fill |
| `src/state.ts` | File-based agent status feed for polybar/tools |
| `src/cli.ts` | Terminal REPL |
| `src/ui.html` | Browser command center |
| `src/vnc.html` | Chrome-free noVNC/RFB embed used inside the command center |

### Native tools

| File | What |
|------|------|
| `atspi-tool.c` | AT-SPI accessibility tool source (compiled to `/opt/atspi-tool`) |
| `atspi-wrapper.sh` | Shell wrapper installed at `/usr/local/bin/atspi` — resolves D-Bus address |

### Desktop

| File | What |
|------|------|
| `desktop/bspwmrc` | Tiling config: 1px borders, 16px gaps, spiral insertion, accent on focus |
| `desktop/sxhkdrc` | Key bindings: Alt+Tab, Alt+F4, Alt+Space float, Alt+T tile, Alt+M monocle |
| `desktop/polybar.ini` | Optional status bar: identity, agent state, model, tokens, clock |
| `desktop/mim-status.sh` | Polybar adapter reading agent state feed |
| `assets/wallpaper.png` | 1280×800 composited earth/wordmark desktop background |

### Scripts

| File | What |
|------|------|
| `setup.sh` | One-command reproducible setup: VM, packages, tools, desktop, server |
| `start-desktop.sh` | bspwm desktop session launcher: Xvfb, D-Bus, AT-SPI, VNC |
| `scripts/install-desktop.sh` | VM package/config installer for the desktop |
| `scripts/make-wallpaper.sh` | Reproducible wallpaper recipe (host ImageMagick) |
| `scripts/trace-agent.ts` | Run full-stream task traces to Markdown |
| `scripts/reset-desktop-eval.sh` | Clean GUI eval state between runs |

### Agent home

| File | What |
|------|------|
| `agent/notes.md` | Persistent notes for future runs |
| `agent/sessions/` | Run history and UI-persisted sessions |
| `agent/tools/` | Agent-authored scripts (screen-summary, source-snippets, etc.) |

### Documentation

| File | What |
|------|------|
| `AGENTS.md` | Complete system prompt for the AI SDK agent |
| `CLAUDE.md` | Delegates Claude Code to `AGENTS.md` |
| `SPEC.md` | Vision: boxes, kacheln, identity, supervisor, security |
| `HANDOVER.md` | Session handover for continuing work |
| `ATSPI-CHANGELOG.md` | atspi-tool optimization log (21 iterations) |
