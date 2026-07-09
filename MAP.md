# MIM VM Map

Current as of 2026-07-09.

## Runtime

- Primary environment: OrbStack VM `agent-desktop`, Ubuntu 22.04 arm64.
- Primary command center: `http://agent-desktop.orb.local:7080`.
- Primary desktop transport: Xvfb `:99` -> x11vnc `5900` -> noVNC/websockify `6080`.
- Primary Claude Code terminal: ttyd `7681` -> tmux session `claude` -> `claude` in the repo root.
- Docker is running through OrbStack on the host, but Docker is not the primary live process tree. Docker currently runs a separate compose service `mim-ubuntu-mim-1`.

## Ports

| Runtime | Command | Desktop | Claude Terminal |
|---|---:|---:|---:|
| OrbStack VM | `7080` | `6080` | `7681` |
| Docker compose | `7090` | `6090` | `7690` |

## Filesystems

- Repo root: `/Users/waqr/Desktop/mims/mim-ubuntu`.
- VM sees the same host path under `/Users/waqr/Desktop/mims/mim-ubuntu`.
- Agent home: `agent/`.
- UI sessions: `agent/sessions/ui/`.
- Secret vault: `agent/secrets.vault.json`.
- Shared mailroom: `shared/`, symlinked or mounted as `/shared` for VM/container runtimes.

## Shared Mailroom

Use `shared/` for cross-box collaboration, not for shared GUI control.

- `shared/mailbox/` - handoff notes, requests, replies.
- `shared/artifacts/` - files produced for another box.
- `shared/state/` - small status files, preferably JSON.

Do not store secrets in `shared/`.

## Docker State

- Host Docker engine: OrbStack Docker, running.
- Running container observed: `mim-ubuntu-mim-1`.
- Compose file: `docker-compose.yml`.
- Docker agent data: Docker volume `mim-ubuntu_agent-data`.
- Docker shared folder: host bind mount `./shared:/shared`.

The Docker path is useful for packaging and parallel experiments, but the active command center used by this project remains the VM path unless explicitly switched.

## Tools

- `atspi` - native desktop accessibility wrapper, backed by `/opt/atspi-tool` in the VM.
- `web` - stateful Chromium/CDP browser tool used by the agent server.
- `secret` - encrypted credential vault operations.
- `fetchpage` - host helper at `~/.local/bin/fetchpage` for JS-rendered pages.
- `docker` - host OrbStack Docker CLI.
- `orbctl` - VM lifecycle and command execution.

## Notes

- One box should own one display, one keyboard focus, and one agent runtime.
- Parallelism should happen by running more boxes, not multiple agents sharing one GUI.
- Cross-box coordination should use `/shared` mailroom files and scoped artifacts.
