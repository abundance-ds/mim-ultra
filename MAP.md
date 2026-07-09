# Runtime Map

## Layout

```text
/app
  Runtime shell. Disposable.

/agent
  Persistent agent home. Mounted from `./agent`.

/shared
  Persistent shared space. Mounted from `./shared`.
```

## Ports

```text
7090  command center
6090  desktop
7690  Claude Code terminal
```

## Agent Home

```text
/agent
├── AGENTS.md
├── CLAUDE.md
├── src/
├── tools/
├── scripts/
├── sessions/
└── notes.md
```

## Shared Space

```text
/shared
├── mailbox/
├── artifacts/
├── state/
└── vault/
```

## Rule

Rebuild `/app` freely. Preserve `/agent` and `/shared`.
