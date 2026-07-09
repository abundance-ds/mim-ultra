# MIM Shared Mailroom

This host-backed folder is the collaboration surface for future multi-box or multi-agent runs.

Mount it at `/shared` in every runtime:

- Docker compose bind-mounts `./shared:/shared`.

Suggested layout:

- `mailbox/` — short handoff notes, requests, and replies between boxes.
- `artifacts/` — files intended for another box to inspect or reuse.
- `state/` — lightweight machine-readable status files such as `agent-name.json`.
- `vault/` — shared encrypted credential vault.

Keep plaintext secrets out of this folder. Shared encrypted vaults belong here.
