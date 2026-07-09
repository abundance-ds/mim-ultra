# Handover

## What Matters

The project is now Docker-first.

There are three runtime areas:

```text
/app     disposable runtime shell
/agent   persistent agent home
/shared  persistent cross-agent shared space
```

If a file changes agent behavior or memory, it belongs in `/agent`. If multiple agents must see it, it belongs in `/shared`.

## Current Ports

```text
7090  command center
6090  desktop
7690  Claude Code terminal
```

## Persistence Contract

- `/agent/AGENTS.md` is the system instruction file.
- `/agent/CLAUDE.md` delegates Claude Code to `AGENTS.md`.
- `/agent/src` is mutable agent/server/tool code.
- `/agent/tools` is for agent-authored helper scripts.
- `/agent/home` is Claude Code's persistent home/config.
- `/agent/sessions` stores UI sessions and tool output.
- `/shared/vault/secrets.vault.json` is the shared encrypted password vault.
- `/shared/mailbox`, `/shared/artifacts`, and `/shared/state` are for collaboration.
- `/app` is disposable and may be replaced by any rebuild.

## Launch Path

The server starts from `/agent`:

```bash
cd /agent
/app/node_modules/.bin/tsx src/server.ts
```

Claude Code starts from `/agent` through:

```text
/app/scripts/claude-code-session.sh
```

## Docker

`docker-compose.yml` bind-mounts:

```text
./agent  -> /agent
./shared -> /shared
```

This means edits made by the human on the host and edits made by the agent in the container are the same files.

## Important Files

```text
Dockerfile
docker-compose.yml
scripts/docker-entrypoint.sh
scripts/start-desktop.sh
scripts/claude-code-session.sh
agent/AGENTS.md
agent/src/server.ts
agent/src/tools.ts
agent/src/secrets.ts
agent/src/sessions.ts
shared/README.md
```

## Restart Rules

- File edits persist immediately if they are under `/agent` or `/shared`.
- The running AI SDK server must restart to reload `AGENTS.md` or `agent/src`.
- Claude Code sees file changes immediately, but its internal prompt context may need a new session to fully reflect instruction changes.
- Docker rebuilds do not erase `/agent` or `/shared`.
