#!/bin/bash
set -e

mkdir -p /tmp/mim
mkdir -p /agent /shared/vault

if [ ! -f /agent/AGENTS.md ] && [ -d /agent-seed ]; then
    cp -a /agent-seed/. /agent/
fi

if [ ! -e /agent/node_modules ]; then
    ln -s /app/node_modules /agent/node_modules
fi

ln -sfn /agent /app/agent

export MIM_APP_DIR=/app
export MIM_AGENT_HOME=/agent
export MIM_AGENT_DIR=/agent
export MIM_SHARED_HOME=/shared
export MIM_SECRET_VAULT="${MIM_SECRET_VAULT:-/shared/vault/secrets.vault.json}"

# Start desktop in background
bash /app/scripts/start-desktop.sh &

# Wait for D-Bus
for i in $(seq 1 30); do
    [ -f /tmp/mim-desktop.env ] && break
    sleep 1
done

if [ ! -f /tmp/mim-desktop.env ]; then
    echo "ERROR: Desktop failed to start"
    exit 1
fi

set -a
source /tmp/mim-desktop.env
set +a

gsettings set org.gnome.desktop.interface gtk-theme "Adwaita-dark" 2>/dev/null || true
gsettings set org.gnome.desktop.interface color-scheme "prefer-dark" 2>/dev/null || true

cd /agent
exec /app/node_modules/.bin/tsx src/server.ts
