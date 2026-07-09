# AI-Native OS Spec Notes

Date: 2026-07-08
Status: working direction, not a committed product spec

## Aim

Build a truly AI-native operating environment where AI is the operating subject, not a user sitting inside a human desktop metaphor.

This is not "an AI controls Ubuntu." That is only the bootstrap implementation.

The larger aim is an OS for persistent machine agency:

```text
perceive -> decide -> act -> remember -> communicate
```

The human is not the default operator, babysitter, or auth loop. The human supplies intent, constraints, resources, and feedback. The AI-native OS turns those into durable work, memory, identities, tool use, and artifacts.

The UI should expose the operating subject's state and work product. It should not make the human operate the machine on the AI's behalf.

## North Star

The future OS is not a safer remote desktop for a chatbot. It is a new class of computing environment where the primary inhabitant is non-human.

The core question is not:

```text
How does an AI use today's computer?
```

The core question is:

```text
What does a computer become when the primary user is an autonomous reasoning system?
```

Implications:

- windows become surfaces
- apps become tools
- files become working memory and artifacts
- accounts become delegated identities
- logs become self-history
- UI becomes observability and steering
- the desktop becomes a compatibility layer
- the box is where work runs, not the whole idea

## Core Product Thesis

Classic OS:

```text
user -> apps -> windows -> files
```

AI-native OS:

```text
intent / standing objective
  -> operating subject
  -> tools
  -> world actions + artifacts
  -> memory + evidence + communication
```

The important primitives are:

- agent
- goal
- task
- identity
- memory
- prompt
- sessions
- workspace
- tool invocation
- surface / tile
- artifact
- event log

Traditional primitives like dock, desktop icons, app launcher, and free-floating windows are secondary or unnecessary.

## Non-Goals

This is not:

- a locked-down compliance VM
- a human-operated remote desktop
- a normal OS with an AI assistant bolted on
- a tool where the human approves every meaningful move
- a password-pasting automation layer
- a safer way to let an untrusted model use the user's personal accounts

The product should eventually feel less like "watching an agent use Linux" and more like interacting with a persistent non-human operator that has its own environment, memory, authority, and work surfaces.

## Agent Kernel

Keep this brutally simple.

An agent is:

```text
AGENTS.md + tools + runtime state
```

`AGENTS.md` is the full system prompt read by the launcher.

Runtime state lives under:

```text
agent/
  notes.md
  sessions/
  tools/
```

The agent mostly needs file read/edit, bash, desktop control, web control, and credentials. If it needs a repeated workflow, it can write a small helper into `agent/tools/`.

## UI Direction

The UI should be text-governed and visually grounded.

Text is primary for:

- goals
- plan
- scratchpad
- commands
- event log
- diffs
- evidence summaries
- handoffs

Visual surfaces are still needed for:

- browsers
- GUI apps
- documents
- images
- PDFs
- dashboards
- screenshots
- layout-sensitive verification

## Kacheln Instead Of Windows

Use tiled surfaces ("Kacheln") instead of free-floating windows.

Likely layouts:

- 1 tile: focused work
- 2 tiles: work plus reference
- 4 tiles: normal operator view
- 6 or 8 tiles: monitoring / comparison / multi-box view

Tiles are not traditional windows. A tile is a visible surface for a task, tool, app, document, browser, terminal, log, or whole agent box.

The user should not need to manage window placement manually. The agent or supervisor should choose layouts based on the task.

Possible user commands:

```text
show me what you see
focus the browser
pin the terminal
compare these pages
make the editor bigger
show the evidence
```

## Persistent Control Rail

Do not default to a dock. A dock is a human memory aid for launching apps. In an AI-native OS, apps are called by command/tool invocation.

Prefer a persistent control rail, probably on the left.

The rail may contain:

- current goal
- plan
- scratchpad
- command input
- active tool calls
- recent actions
- approvals / interrupts
- status / errors

A terminal can appear in the rail or as a tile, but the permanent object should be the control rail, not literally a terminal. The terminal is one tool among others.

## App Model

Apps are not user-launched icons. Apps are callable tools.

Examples:

```text
open browser to URL
open editor on file
inspect accessibility tree
run shell command
render PDF
take screenshot
query Chromium tab
launch native app
```

The user-facing UI should show the result and state of these calls, not expose a normal app launcher as the primary interaction model.

## Parallelism Model

Avoid multiple agents sharing one desktop. GUI control is global: one display, one mouse, one keyboard focus, one active AT-SPI tree. Multiple agents controlling one desktop would race.

Preferred rule:

```text
one box = one agent-owned computer
```

Parallelism happens across boxes, not inside one shared desktop.

Instead of:

```text
one OS
many agents
shared display/mouse/files/apps
```

Use:

```text
many boxes
one agent per box
each box owns its display, files, browser, terminal, memory, and event log
```

The top-level UI can show multiple boxes as Kacheln. Each box is a whole agent computer, not just a window.

## Box Primitive

Each box should contain:

- one agent
- one desktop/display
- one browser profile
- one shell/filesystem workspace
- one event log
- one task/scratchpad state
- one artifact output folder
- one visible noVNC or equivalent surface

Each box is controlled by the operating subject. A human or higher-level orchestrator can inspect, interrupt, fork, kill, or harvest artifacts from the box, but the box is not the whole product.

Possible parameterized boxes:

```text
agent-box-1: DISPLAY=:99,  noVNC=6080, command=7080, browser=9222
agent-box-2: DISPLAY=:100, noVNC=6081, command=7081, browser=9223
agent-box-3: DISPLAY=:101, noVNC=6082, command=7082, browser=9224
```

Implementation could start with separate displays inside one VM, but the conceptual boundary should remain a box. Separate VMs may be cleaner for isolation.

## Shared Folder Model

Boxes can share a drive or folder, but the shared area should behave like a mailroom, not a collaborative desktop.

Each box gets a private workspace and publishes outputs to an exchange area.

Suggested shape:

```text
/boxes/box-001/workspace
/boxes/box-001/inbox
/boxes/box-001/outbox
/boxes/box-002/workspace
/boxes/box-002/inbox
/boxes/box-002/outbox
/shared/sources
/shared/artifacts
/shared/notes
/shared/handoffs
/shared/events.jsonl
/shared/findings.jsonl
/shared/status.jsonl
```

Rules:

- shared inputs are read-only by default
- each box writes to its own outbox
- the supervisor merges or promotes outputs
- final outputs go to `/shared/artifacts`
- shared logs should be append-only JSONL where possible
- avoid multiple boxes editing the same working tree without a lock or supervisor-controlled merge

## Identity And Secret Model

The direction is not "AI is untrusted, so a human watches every move." That would make the box a compliance toy, not an AI-native OS.

The direction is:

```text
the operating subject has durable identities, accounts, credentials, keys, sessions, and capabilities
auth, keys, .env, and admin access are ordinary agent material
the human visits; the agent operates
```

Secrets are part of the agent's authority, not contraband. The agent may possess, inspect, unlock, type, store, rotate, and use raw credential material when that is the direct durable interface. Capability handles and OS services are also good when they preserve agent autonomy.

Good paths:

```text
agent -> capability handle -> trusted OS service -> external account/API
agent -> credential/key/.env -> external account/API
```

Not:

```text
human -> repeated login ceremony -> agent waits
```

Security is scoped authority, recovery, audit, revocation, and identity boundaries. Hiding a password from the agent is not a security model if the agent can already act through the account.

### AI-Owned Identities

Prefer dedicated AI-owned accounts over the user's personal accounts.

Examples:

- `agent-github@...` instead of the user's GitHub identity
- AI Slack user or app installation instead of the user's session
- service account with limited scopes instead of personal cloud credentials
- separate browser profile for the agent box

The operating subject should have real autonomy through these identities. The human should not have to repeatedly complete login ceremonies for routine work.

### Auth Provisioning

Authentication should be provisioned into the runtime as a durable session or capability by the platform layer.

Acceptable mechanisms:

- persistent browser profiles owned by the runtime identity
- API keys in `.env` or agent-owned config files
- vault entries the agent can unlock, read, fill, and rotate
- OAuth refresh handled by a trusted local service
- API capability handles backed by a vault/keychain
- passkey or token use through an OS service
- service accounts designed for automation

Password-field injection is a compatibility path, not the whole architecture. It is brittle, provider-specific, and often impossible to make robust across 2FA, passkeys, device checks, CAPTCHAs, and suspicious-login flows.

### Human Role

The human is the visitor. They arrive to set direction, inspect outcomes, fund accounts, grant new territory, or recover a broken identity. They do not sit in the daily auth loop.

The human may be needed for:

- initial account provisioning
- granting a new class of authority
- recovering a broken or revoked identity
- approving unusually risky authority expansion

The human should not be needed for:

- routine session refresh
- every login form
- every OAuth prompt
- normal use of tools the box already owns

If auth constantly falls back to manual hand-holding, the product is failing the AI-native premise.

### Security Boundary

Inside a box, assume the agent can read anything readable by the box user and can observe anything available through its tools.

Therefore:

- do not place raw long-lived secrets in the box filesystem
- do not expose broad tokens in env vars
- do not rely on hidden text fields as the main protection
- do not share the user's personal browser profile as the default identity
- do grant durable, scoped, revocable capabilities to the box
- do log capability use as OS-level events

The hard product problem is not "how do we let the AI type a password safely?" The hard product problem is "what authority should this operating subject have, and how do we make that authority durable, scoped, inspectable, and revocable?"

## Supervisor Model

There may be a supervisor above the boxes.

The supervisor does not directly compete for GUI control inside a box. It:

- splits tasks
- starts boxes
- assigns goals
- watches progress
- compares outputs
- merges results
- stops, forks, or retries boxes
- presents the human with the important state

This gives multi-agent behavior without multiple agents corrupting one shared GUI session.

## Near-Term MVP

Use the current `agent-desktop` VM as the first box prototype.

Next practical steps:

1. Keep one agent per box as the invariant.
2. Add a web shell UI with a persistent control rail and tiled surfaces.
3. Treat apps as command-invoked tools, not dock-launched GUI programs.
4. Build a small box manager that can start/stop/list boxes.
5. Parameterize display, noVNC, command, and browser ports.
6. Define the shared folder contract and event JSONL schema.
7. Show each running box as a tile in the top-level UI.

## Current Prototype

`src/server.ts` is the single-box command center.

It runs on port `7080` and provides:

- AI SDK chat with streaming tool events
- embedded noVNC desktop view
- Claude Code terminal panel through ttyd/tmux
- launcher controls for apps and desktop actions
- session persistence
- encrypted credential vault UI

This does not replace Ubuntu yet. It reframes Ubuntu as the compatibility substrate below an agent-owned control surface.

## Open Questions

- Separate OrbStack VMs or multiple displays inside one VM for early prototypes?
- Should the left rail include a real terminal, or only a command/scratchpad abstraction?
- What tile counts are worth supporting first: 1, 2, 4, 6, 8?
- How much reasoning trace should the user see by default?
- What is the minimal event schema for cross-box supervision?
- How should boxes be forked, resumed, and snapshotted?
- What is the first useful capability service: GitHub, email, browser session provisioning, or file sync?
