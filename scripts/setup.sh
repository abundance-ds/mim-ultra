#!/bin/bash
# Docker-first setup for the agent-native Linux runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$SCRIPT_DIR"

if ! command -v docker >/dev/null 2>&1; then
    echo "Error: Docker is not installed or not on PATH."
    exit 1
fi

mkdir -p agent shared/mailbox shared/artifacts shared/state shared/vault
touch shared/mailbox/.gitkeep shared/artifacts/.gitkeep shared/state/.gitkeep shared/vault/.gitkeep

docker compose up -d --build
docker compose ps

echo ""
echo "=== Ready ==="
echo ""
echo "  Command:     http://localhost:${MIM_PORT:-7090}"
echo "  Desktop:     http://localhost:${VNC_PORT:-6090}/vnc.html?autoconnect=true"
echo "  Claude Code: http://localhost:${TTYD_PORT:-7690}"
echo ""
echo "  Persistent agent home: ./agent -> /agent"
echo "  Persistent shared area: ./shared -> /shared"
