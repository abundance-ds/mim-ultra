#!/bin/bash
# Reproducible setup for agent-native Linux prototype.
# Prerequisites: OrbStack installed.
# Usage: ./setup.sh
set -e

VM_NAME="agent-desktop"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Agent-Native Linux Setup ==="

if ! command -v orbctl &>/dev/null; then
    echo "Error: OrbStack not installed. Install from https://orbstack.dev"
    exit 1
fi

# --- VM Creation ---
if orbctl list 2>/dev/null | grep -q "$VM_NAME"; then
    echo "VM '$VM_NAME' already exists."
else
    echo "Creating OrbStack VM..."
    orbctl create ubuntu:jammy "$VM_NAME"
fi
orbctl start "$VM_NAME" 2>/dev/null || true

# --- System Packages ---
echo "Installing system packages..."
orbctl run -m "$VM_NAME" bash -c '
export DEBIAN_FRONTEND=noninteractive
if [ "$(dpkg --print-architecture)" = "arm64" ] && dpkg --print-foreign-architectures | grep -qx amd64; then
    if ! dpkg --get-selections | grep -q ":amd64[[:space:]]*install"; then
        sudo dpkg --remove-architecture amd64
    fi
fi
sudo apt-get update -qq
sudo apt-get install -y -qq \
    xvfb xfce4 xfce4-terminal \
    dbus-x11 at-spi2-core \
    x11vnc novnc websockify \
    ttyd tmux \
    python3-pyatspi python3-pip \
    gnome-calculator \
    epiphany-browser \
    chromium-browser \
    mousepad \
    socat \
    xdotool \
    2>&1 | tail -5
sudo systemctl disable --now ttyd 2>/dev/null || true
pip3 install -q websockets
echo "System packages done."
'

# --- DNS Fix for Snap Apps ---
echo "Fixing DNS for snap apps (OrbStack symlink workaround)..."
orbctl run -m "$VM_NAME" bash -c '
sudo rm -f /etc/resolv.conf
echo -e "nameserver 8.8.8.8\nnameserver 1.1.1.1" | sudo tee /etc/resolv.conf > /dev/null
echo "DNS fix applied."
'

# --- Node.js + Claude Code ---
echo "Installing Node.js and Claude Code..."
orbctl run -m "$VM_NAME" bash -c '
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>&1 | tail -2
    sudo apt-get install -y -qq nodejs 2>&1 | tail -2
fi
if ! command -v claude &>/dev/null; then
    sudo npm install -g @anthropic-ai/claude-code 2>&1 | tail -2
fi
echo "Node $(node --version), Claude Code $(claude --version 2>&1 | head -1)"
'

# --- User Config ---
echo "Configuring user and auto-login..."
orbctl run -m "$VM_NAME" bash -c '
echo "waqr:password" | sudo chpasswd

sudo mkdir -p /etc/lightdm/lightdm.conf.d
echo "[Seat:*]
autologin-user=waqr
autologin-user-timeout=0" | sudo tee /etc/lightdm/lightdm.conf.d/autologin.conf > /dev/null

echo "[Desktop Entry]
Hidden=true" | sudo tee /etc/xdg/autostart/xfce4-screensaver.desktop > /dev/null
'

# --- Shared Mailroom ---
echo "Configuring shared mailroom..."
mkdir -p "$SCRIPT_DIR/shared/mailbox" "$SCRIPT_DIR/shared/artifacts" "$SCRIPT_DIR/shared/state"
orbctl run -m "$VM_NAME" bash -c "
sudo ln -sfn '$SCRIPT_DIR/shared' /shared
"

# --- Build AT-SPI tool from C source ---
echo "Building atspi tool from C source..."
orbctl run -m "$VM_NAME" bash -c "
export DEBIAN_FRONTEND=noninteractive
sudo apt-get install -y -qq gcc libdbus-1-dev libatspi2.0-dev 2>&1 | tail -2

gcc -O2 -o /tmp/atspi-tool '$SCRIPT_DIR/atspi-tool.c' -ldbus-1 -latspi -lm 2>&1 | head -5
sudo install -m 755 /tmp/atspi-tool /opt/atspi-tool

echo 'atspi tool built and installed.'
"

# --- AT-SPI wrapper script ---
echo "Installing atspi wrapper..."
orbctl run -m "$VM_NAME" bash -c "
sudo cp '$SCRIPT_DIR/atspi-wrapper.sh' /usr/local/bin/atspi
sudo chmod +x /usr/local/bin/atspi
"

# --- Desktop config ---
echo "Installing MIM desktop config..."
orbctl run -m "$VM_NAME" bash -c "
cd '$SCRIPT_DIR'
./scripts/install-desktop.sh
"

# --- Start Desktop ---
echo "Starting desktop..."
orbctl run -m "$VM_NAME" bash -c '
killall Xvfb x11vnc websockify xfce4-session xfwm4 xfce4-panel xfdesktop bspwm sxhkd polybar xfsettingsd at-spi2-registryd 2>/dev/null || true
sudo systemctl stop ttyd 2>/dev/null || true
killall ttyd 2>/dev/null || true
sleep 1
'
orbctl run -m "$VM_NAME" bash -c "
cp '$SCRIPT_DIR/start-desktop.sh' /tmp/start-desktop.sh
chmod +x /tmp/start-desktop.sh
MIM_REPO_DIR='$SCRIPT_DIR' nohup /tmp/start-desktop.sh > /tmp/desktop.log 2>&1 &
"
echo "Waiting for desktop to start..."
sleep 8

# --- Verify ---
DBUS_ADDR=$(orbctl run -m "$VM_NAME" bash -c 'grep "D-Bus:" /tmp/desktop.log | sed "s/.*D-Bus: //"')
if [ -z "$DBUS_ADDR" ]; then
    echo "ERROR: Desktop failed to start."
    orbctl run -m "$VM_NAME" bash -c 'tail -20 /tmp/desktop.log'
    exit 1
fi

echo "Verifying services..."
orbctl run -m "$VM_NAME" bash -c '
ss -tlnp | grep -q 5900 && echo "  VNC:    OK" || echo "  VNC:    FAILED"
ss -tlnp | grep -q 6080 && echo "  noVNC:  OK" || echo "  noVNC:  FAILED"
ss -tlnp | grep -q 7681 && echo "  ttyd:   OK" || echo "  ttyd:   FAILED"
tmux has-session -t claude 2>/dev/null && echo "  tmux:   OK" || echo "  tmux:   PENDING"
ps aux | grep -q "[a]t-spi2-registryd" && echo "  AT-SPI: OK" || echo "  AT-SPI: FAILED"
ps aux | grep -q "[b]spwm" && echo "  bspwm:  OK" || echo "  bspwm:  FAILED"
atspi apps > /dev/null 2>&1 && echo "  atspi:  OK" || echo "  atspi:  FAILED"
'

echo "Starting agent server..."
orbctl run -m "$VM_NAME" bash -c "
export DISPLAY=:99
export DBUS_SESSION_BUS_ADDRESS='$DBUS_ADDR'
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0
ps -eo pid=,args= | awk 'index(\$0, \"tsx src/\" \"server.ts\") && \$0 !~ /awk/ { print \$1 }' | xargs -r kill -TERM 2>/dev/null || true
sleep 1
cd '$SCRIPT_DIR'
SERVER_ENTRY=src/server.ts
nohup setsid npx tsx \"\$SERVER_ENTRY\" > /tmp/mim-server.log 2>&1 < /dev/null &
sleep 1
ss -tlnp | grep -q 7080 && echo '  Agent server: OK' || echo '  Agent server: FAILED'
"

echo ""
echo "=== Ready ==="
echo ""
echo "  Desktop:     http://localhost:6080/vnc.html?autoconnect=true"
echo "  Command:     http://agent-desktop.orb.local:7080"
echo "  Claude Code: http://agent-desktop.orb.local:7681"
echo "  VM password: password"
echo ""
echo "  In the command center, use the Chat | Claude Code panel toggle."
echo ""
