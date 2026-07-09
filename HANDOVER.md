# Handover

What a fresh session needs to know to continue this project.

## What this is

An AI-native OS prototype. Not "an AI assistant on Linux" — a computing environment where AI is the primary operating subject. The human supplies intent, constraints, and feedback. The AI perceives, decides, acts, and remembers.

Ubuntu plus a minimal bspwm session is bootstrap plumbing. The desktop is a compatibility layer for legacy GUI apps. The actual interface is a web-based command center on port `7080`.

## Architecture

One OrbStack VM (`agent-desktop`, Ubuntu 22.04 arm64) runs everything:

```
Host Mac (watches via browser)
  └── OrbStack VM: agent-desktop
        ├── Xvfb :99 (virtual display, 1280×800)
        ├── bspwm + sxhkd tiling session
        ├── optional polybar status strip fed by /tmp/mim/state.* (MIM_DESKTOP_BAR=1)
        ├── xfsettingsd for GTK theme/font settings
        ├── x11vnc → noVNC on :6080 (live desktop view)
        ├── ttyd :7681 → tmux session "claude" → Claude Code
        ├── shared mailroom at repo `shared/` (mount/symlink as /shared)
        ├── atspi-tool (C binary at /opt/atspi-tool) — AT-SPI accessibility
        ├── atspi wrapper at /usr/local/bin/atspi — D-Bus address resolution
        ├── encrypted secret vault at agent/secrets.vault.json
        └── Agent server (TypeScript, port 7080)
              ├── Vercel AI SDK (ai@4.1.66 + @ai-sdk/anthropic@1.2.12)
              ├── streamText() with Claude, MAX_STEPS default 1000000
              ├── Default model: claude-sonnet-4-6 (MODEL env var)
              ├── File-based session persistence at agent/sessions/ui/
              └── 6 tools: bash, readFile, writeFile, atspi, web, secret
```

The agent runs INSIDE the VM. The host Mac connects by browser to the command center at `http://agent-desktop.orb.local:7080`; the command center embeds a chrome-free RFB viewer at `/vnc` and uses noVNC/websockify on `:6080` only as transport. Direct raw noVNC remains available at `http://localhost:6080` or `http://agent-desktop.orb.local:6080`. If a host process occupies `localhost:7080`, use the `.orb.local` URL directly.

Docker is also available through OrbStack. `docker-compose.yml` runs a separate containerized copy on host ports `7090` (command center), `6090` (noVNC), and `7690` (ttyd/Claude Code). That Docker copy is not the same process tree as the primary `agent-desktop` VM on `7080`/`6080`/`7681`.

## Key invariants

- **One agent per box.** Parallelism happens by running more boxes, not multiple agents sharing one desktop.
- **No supervisor.** Each box is self-contained. A supervisor layer may come later but is explicitly out of scope now.
- **System prompt** is exactly `AGENTS.md`; `CLAUDE.md` delegates to it.
- **Agent folder** at `agent/` stores runtime notes, sessions, secrets, and helper scripts. It is not prompt-loaded.

## Current state

### Working
- **Agent server** (`src/server.ts`, ~700 lines) runs on port 7080 inside the VM
- **SSE streaming** of text, tool calls, and tool results to browser UI
- **Command center** (`src/ui.html`) with fixed app layout: header bar (quick-launch buttons for terminal/files/apps/vault, window controls, status pill, chat toggle) + main area (VNC desktop iframe + dockable/detachable chat panel). Chat can be docked as a right-side panel or detached as a floating draggable window. Includes launcher palette with quick-launch grid, session history, and encrypted vault UI.
- **Claude Code terminal view** in the command center. The panel has a `Chat | Claude Code` toggle; Claude Code is embedded from `ttyd` on port `7681`, attaching to persistent tmux session `claude`. The AI SDK chat remains available as the fallback path.
- **Shared mailroom** at `shared/`, symlinked as `/shared` in the primary VM and bind-mounted as `/shared` in Docker. Current subdirs: `mailbox/`, `artifacts/`, and `state/`. Keep secrets out.
- **Docker compose path** for a separate containerized copy. Compose bind-mounts `./shared:/shared`, keeps `/app/agent` in Docker volume `agent-data`, and maps container ports `7080/6080/7681` to host `7090/6090/7690`.
- **Session persistence** (`src/sessions.ts`, ~180 lines) — file-based at `agent/sessions/ui/`, with session create/save/load/delete, active session tracking across server restarts, and full UI for browsing/loading/deleting sessions
- **Encrypted credential vault** (`src/secrets.ts`, ~280 lines) stored at `agent/secrets.vault.json`; command-center UI can create/unlock/save/fill entries, and the agent has a `secret` tool for status/unlock/lock/list/get/fill/save/delete. Empty passphrase is valid; no-passphrase vaults auto-open for agent secret actions.
- **Agent state feed** (`src/state.ts`) writes `/tmp/mim/state.json` and `/tmp/mim/state.line`
- **bspwm desktop session** with deterministic tiling, dark GTK settings, reproducible earth/wordmark wallpaper, and optional polybar via `MIM_DESKTOP_BAR=1`
- **CLI REPL** (`src/cli.ts`) for terminal-based interaction
- **6 tools** execute directly inside the VM: bash, readFile, writeFile, atspi, web, secret
- **`web` tool** — stateful Chromium browser for websites; returns readable observations with refs and supports open/observe/click/type/scroll/wait/extract.
- **Compact-first tool output** for bash/readFile/atspi. Put flags at the front before `--`: `--limit N -- ...`, `--offset N --limit N -- ...`, or `--full -- ...`. Truncated full outputs are saved under `agent/sessions/tool-output/`.
- **Context accounting** tracks cumulative API usage separately from current live context.
- **Secret tool display** is redacted in browser tool rows and in stored chat history. Prefer `secret fill` for login fields; use `secret get` only when the agent truly needs the string (e.g. API key).
- **`atspi focus` / `atspi close`** search both X window title and WM_CLASS, then activate before close
- **Human guest controls** call `/api/desktop` for quick-launch (terminal, files, browser, editor, calculator), raw app command launch, focus-prev/next/tile/monocle/close actions. `sxhkdrc` also binds `Alt+Tab`, `Alt+Shift+Tab`, `Alt+T`, `Alt+M`, `Alt+Space`, and `Alt+F4` for direct VNC control focus.
- **`atspi interact <app>`** — flat deduped list of clickable/editable elements (much less noisy than `read`); deeper WebKit walk preserves editable embedded controls so login fields appear
- **`atspi find <app> <pattern>`** — targeted matching lines for large pages / "is X mentioned?" tasks
- **`atspi insert <app> [field] <text>`** — direct editable-text insertion for AT-SPI text fields
- **`atspi read`** — improved filtering: skips unnamed structural nodes, strips U+FFFC/bullet chars, truncates long names
- **`atspi` wrapper** is resilient when `/tmp/desktop.log` is missing: resolves the desktop D-Bus address from `/tmp/mim-desktop.env`, `/tmp/desktop.log`, or the running desktop process environment
- **`scripts/trace-agent.ts`** — run full-stream task traces to Markdown under `agent/sessions/`
- **`scripts/reset-desktop-eval.sh`** — clean GUI eval state, disable/kill screensaver, clear stale snapshots/temp eval files
- **`agent/tools/source-snippets.js`** — compact HTML/PDF evidence extraction from source URLs
- **`agent/tools/screen-summary.js`** — XWD pixel summary for visual verification
- **`setup.sh`** — one-command reproducible setup: creates VM, installs packages, fixes DNS, builds C tools, installs desktop, starts server

### Not yet built
- **Model selection in UI** — currently hardcoded via `MODEL` env var in `.env`
- **Agent notes view in command center** — `agent/notes.md` is not surfaced yet

## Version compatibility (hard-won)

AI SDK 5 + @ai-sdk/anthropic v2+ has broken Zod schema conversion (missing `type: "object"`). The working combination is:

```
ai@4.1.66 + @ai-sdk/anthropic@1.2.12 + zod@^3.25
```

Do not upgrade without testing tool calls end-to-end.

## Browsers

| Browser | Access | Notes |
|---------|--------|-------|
| Stateful Chromium | `web` tool | Default for websites; persistent profile plus ref-based observe/click/type/scroll/extract. |
| Claude Code terminal | Command center panel / `http://agent-desktop.orb.local:7681` | ttyd attaches browser clients to tmux session `claude` in the repo root. |
| Surf (WebKit2GTK) | AT-SPI | Fallback / visible desktop browsing. |
| Epiphany (GTK) | AT-SPI | Works but crashes on heavy pages |

Use `web` first for websites. Keep AT-SPI for native apps and Surf/Epiphany fallback browsing.

## atspi optimization (ongoing)

The atspi-tool is a compiled C binary. Source is `atspi-tool.c` in the project root (~1270 lines). Changes require recompiling on the VM:

```bash
orbctl run -m agent-desktop bash -c 'sudo gcc -O2 -o /opt/atspi-tool atspi-tool.c $(pkg-config --cflags --libs atspi-2 gobject-2.0 dbus-1)'
```

Key problem: web pages (especially Reddit via Surf) produce enormous accessibility trees. A single Reddit page was 1185 lines from `atspi read`. After optimization: `read` is ~537 lines, `interact` shows ~98 elements.

See `ATSPI-CHANGELOG.md` for detailed optimization log with 21 iterations of measured impact.

Recent evaluation loop tested Mousepad editing/saving, Surf + DuckDuckGo Lite, DB Regio/RB24 disruption checks, generated visual display, evidence scans, PDF extraction, and chart artifact creation. The trace artifacts were purged with old session history.

2026-07-09 fix: If Surf is visibly loaded but `atspi read surf` returns only the app/frame, check the wrapper D-Bus address. A missing `/tmp/desktop.log` used to make `/usr/local/bin/atspi` export `DBUS_SESSION_BUS_ADDRESS=""`, so Surf/WebKit inherited no usable session bus and did not publish web content to AT-SPI. The wrapper now falls back to `/tmp/mim-desktop.env` and the running bspwm/xfsettingsd process environment.

Still needs work:
- `read` could collapse single-child chains
- No scroll position indicator (agent can't tell what's visible vs offscreen)
- `snap` diffs are noisy on full page loads
- Most noise comes from WebKit's a11y mapping, not native GTK apps
- More workflow coverage is needed for forms/settings changes, document editing, spreadsheet-style analysis, and multi-page research synthesis.

## Files that matter

### Source (src/)

| File | Purpose |
|------|---------|
| `src/agent.ts` | Core agent: loads `.env`, reads `AGENTS.md` as system prompt, exports `runAgent()` |
| `src/tools.ts` | 6 tools with direct execution (no host wrapping) |
| `src/web.ts` | Stateful Chromium web tool with readable refs |
| `src/server.ts` | HTTP server + SSE + session CRUD + secrets API + state events |
| `src/sessions.ts` | File-based session persistence: create/save/load/delete + active tracking |
| `src/secrets.ts` | AES-256-GCM vault backend plus AT-SPI fill helper |
| `src/state.ts` | Writes `/tmp/mim/state.json` and `/tmp/mim/state.line` |
| `src/cli.ts` | Interactive REPL + one-shot CLI |
| `src/ui.html` | Static command center UI (~1800 lines) |
| `src/vnc.html` | Chrome-free RFB viewer embedded by the command center |

### Native tools

| File | Purpose |
|------|---------|
| `atspi-tool.c` | AT-SPI accessibility tool (C, ~1270 lines, compiled to /opt/atspi-tool) |
| `atspi-wrapper.sh` | Shell wrapper at /usr/local/bin/atspi — D-Bus address resolution with fallbacks |

### Desktop and scripts

| File | Purpose |
|------|---------|
| `desktop/` | bspwm/sxhkd/optional polybar config and bar status script |
| `setup.sh` | One-command reproducible setup: VM + packages + tools + desktop + server |
| `start-desktop.sh` | bspwm desktop session launcher |
| `scripts/claude-code-session.sh` | ttyd/tmux entrypoint for Claude Code in the repo root |
| `scripts/install-desktop.sh` | Installs VM packages and `/usr/local/share/mim` desktop config |
| `scripts/make-wallpaper.sh` | Rebuilds `assets/wallpaper.png` from source image/wordmark |
| `scripts/trace-agent.ts` | Full-stream task traces to Markdown |
| `scripts/reset-desktop-eval.sh` | Clean GUI eval state between runs |
| `shared/` | Host-backed mailroom for future multi-box collaboration |

### Agent home

| File | Purpose |
|------|---------|
| `agent/notes.md` | Persistent notes for future runs |
| `agent/sessions/` | Run history and UI-persisted sessions |
| `agent/tools/` | Agent-authored scripts (screen-summary.js, source-snippets.js, etc.) |

### Documentation

| File | Purpose |
|------|---------|
| `AGENTS.md` | Complete system prompt for the AI SDK agent |
| `CLAUDE.md` | Delegates Claude Code to `AGENTS.md` |
| `SPEC.md` | Vision: boxes, kacheln, identity model, supervisor, security |
| `ATSPI-CHANGELOG.md` | atspi-tool optimization log (21 iterations) |

## How to start

```bash
# First time — full setup from scratch
./setup.sh

# Then open in browser
open http://agent-desktop.orb.local:7080
open http://agent-desktop.orb.local:7681

# Optional separate Docker copy
docker compose up -d --build
open http://localhost:7090
open http://localhost:6090
open http://localhost:7690

# To restart just the agent server
orbctl run -m agent-desktop bash -c 'cd /Users/waqr/Desktop/mims/mim-ubuntu && npx tsx src/server.ts'

# To restart just the desktop
orbctl run -m agent-desktop bash -c 'cd /Users/waqr/Desktop/mims/mim-ubuntu && bash start-desktop.sh'
```

## Suggested next steps

1. Add model selection to the command center UI
2. Surface `agent/notes.md` in the command center
3. Continue atspi optimization based on real browsing sessions
4. Explore multi-box parameterization (see `SPEC.md`)
