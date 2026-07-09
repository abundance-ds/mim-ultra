#!/bin/bash
set -e

mkdir -p /tmp/mim
chmod a+rwx /tmp/mim
mkdir -p /agent /agent/home /agent/browser-profile /agent/sessions /shared/vault

if id agent >/dev/null 2>&1; then
    mkdir -p /home/agent
    chown -R agent:agent /home/agent
fi

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
export MIM_WEB_PROFILE_DIR="${MIM_WEB_PROFILE_DIR:-/agent/browser-profile}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/root/.cache/ms-playwright}"

if id agent >/dev/null 2>&1; then
    find /agent /shared -type d -exec chmod a+rwx {} + 2>/dev/null || true
    find /agent /shared -type f -exec chmod a+rw {} + 2>/dev/null || true
fi
rm -f /agent/browser-profile/SingletonLock \
      /agent/browser-profile/SingletonSocket \
      /agent/browser-profile/SingletonCookie 2>/dev/null || true

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
if id agent >/dev/null 2>&1 && command -v setpriv >/dev/null 2>&1; then
    export HOME="${MIM_CLAUDE_HOME:-/agent/home}"
    export USER=agent
    export LOGNAME=agent
    exec setpriv --reuid="$(id -u agent)" --regid="$(id -g agent)" --init-groups \
        /app/node_modules/.bin/tsx src/server.ts
fi

exec /app/node_modules/.bin/tsx src/server.ts
