# MIM Shared Mailroom

This host-backed folder is the collaboration surface for future multi-box or multi-agent runs.

Mount it at `/shared` in every runtime:

- Docker compose already bind-mounts `./shared:/shared`.
- OrbStack VMs can use the same host path at `/Users/waqr/Desktop/mims/mim-ubuntu/shared`, or symlink/mount that path to `/shared` inside each VM.

Suggested layout:

- `mailbox/` — short handoff notes, requests, and replies between boxes.
- `artifacts/` — files intended for another box to inspect or reuse.
- `state/` — lightweight machine-readable status files such as `agent-name.json`.

Keep secrets out of this folder. Use per-agent vaults or explicit scoped credentials instead.
