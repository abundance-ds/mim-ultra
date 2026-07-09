#!/bin/bash
set -e

mkdir -p /tmp/mim

# Start desktop in background
bash /app/start-desktop.sh &

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

cd /app
exec npx tsx src/server.ts
