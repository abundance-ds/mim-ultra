# mim

Agent-native Linux runtime.

## Runtime Model

```text
/app
  Disposable runtime shell: packages, desktop launcher, entrypoint, node_modules.

/agent
  Persistent agent home: instructions, mutable agent code, tools, sessions, state.

/shared
  Persistent shared space: handoffs, artifacts, state, shared encrypted vault.
```

The Docker image can be rebuilt at any time. Anything important must be mounted at `/agent` or `/shared`.

## Docs For New Agents

Read in this order:

1. `README.md` for the runtime model and folder maps.
2. `docs/HANDOVER.md` for the persistence contract and launch path.
3. `docs/MAP.md` for a compact runtime map.

`docs/SPEC.md` is product vision and design notes, not current operational truth.

## Current File Tree

```text
/repo
├── README.md
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── agent/
├── atspi/
├── desktop/
├── scripts/
├── shared/
├── assets/
└── docs/
```

## Runtime File Tree

```text
/app
├── scripts/
│   ├── docker-entrypoint.sh
│   ├── start-desktop.sh
│   └── claude-code-session.sh
├── node_modules/
└── package.json

/agent
├── AGENTS.md
├── CLAUDE.md
├── src/
│   ├── agent.ts
│   ├── tools.ts
│   ├── server.ts
│   ├── web.ts
│   ├── secrets.ts
│   └── sessions.ts
├── tools/
├── scripts/
├── home/
├── browser-profile/
└── sessions/

/shared
├── mailbox/
├── artifacts/
├── state/
└── vault/
    └── secrets.vault.json
```

## Persistence Rules

- `AGENTS.md` lives in `/agent`, so prompt edits persist.
- Agent-editable source lives in `/agent/src`, so tool/server changes persist.
- Agent-authored helper tools live in `/agent/tools`.
- Claude Code home/config lives in `/agent/home`.
- The web tool's Chromium profile lives in `/agent/browser-profile`.
- Sessions and tool output live in `/agent/sessions`.
- Shared passwords live in `/shared/vault/secrets.vault.json`, encrypted.
- Cross-agent files live under `/shared`.
- `/app` can be thrown away and rebuilt.

Running processes may need restart to reload changed prompt or source files. The files themselves persist.

## Running

```bash
docker compose up -d --build
```

Open:

```text
http://localhost:7090  command center
http://localhost:6090  desktop
http://localhost:7690  Claude Code terminal
```

## Docker Mounts

```yaml
volumes:
  - ./agent:/agent
  - ./shared:/shared
```

The container starts the server from `/agent`:

```bash
cd /agent
/app/node_modules/.bin/tsx src/server.ts
```

Claude Code also starts in `/agent`, so it sees `/agent/AGENTS.md` and edits persistent files by default.
