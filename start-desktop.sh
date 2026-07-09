#!/bin/bash
# Start the agent-native Linux desktop environment.
# Launches Xvfb, D-Bus, AT-SPI, bspwm, VNC, and noVNC.
set -e

export DISPLAY=:99
export DBUS_SESSION_BUS_ADDRESS=""
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "${MIM_REPO_DIR:-}" ]; then
  if [ -f "$SCRIPT_DIR/src/server.ts" ]; then
    MIM_REPO_DIR="$SCRIPT_DIR"
  else
    MIM_REPO_DIR="/Users/waqr/Desktop/mims/mim-ubuntu"
  fi
fi
export MIM_REPO_DIR

CONFIG_DIR="/usr/local/share/mim/desktop"
WALLPAPER="/usr/local/share/mim/wallpaper.png"

# Start virtual framebuffer
Xvfb :99 -screen 0 1280x800x24 &
sleep 1

# Start D-Bus session bus
eval $(dbus-launch --sh-syntax)
export DBUS_SESSION_BUS_ADDRESS
cat > /tmp/mim-desktop.env <<EOF
DISPLAY=$DISPLAY
DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
GTK_MODULES=$GTK_MODULES
NO_AT_BRIDGE=$NO_AT_BRIDGE
EOF
chmod 600 /tmp/mim-desktop.env

# Start AT-SPI registry daemon
/usr/libexec/at-spi2-registryd &
sleep 1

# Disable blanking for pixel-based verification and VNC viewing
xset -display :99 -dpms s off s noblank 2>/dev/null || true
killall xfce4-screensaver 2>/dev/null || true

# GTK appearance. xfsettingsd reads the persisted xsettings channel values.
xfsettingsd --replace &
sleep 1

if [ -f "$WALLPAPER" ]; then
  xwallpaper --zoom "$WALLPAPER" &
else
  xsetroot -solid "#000000"
fi

sxhkd -c "$CONFIG_DIR/sxhkdrc" &
bspwm -c "$CONFIG_DIR/bspwmrc" &
sleep 1
if [ "${MIM_DESKTOP_BAR:-0}" = "1" ]; then
  polybar -q -c "$CONFIG_DIR/polybar.ini" mim &
  sleep 1
fi

# Start VNC server
x11vnc -display :99 -forever -nopw -rfbport 5900 -shared -noxdamage -cursor arrow -noscr &
sleep 1

# Start noVNC web viewer
/usr/share/novnc/utils/launch.sh --vnc localhost:5900 --listen 6080 &
sleep 1

# Start browser terminal for Claude Code
if command -v ttyd >/dev/null 2>&1 && command -v tmux >/dev/null 2>&1; then
  pkill -f "ttyd .*7681" 2>/dev/null || true
  tmux has-session -t claude 2>/dev/null ||
    tmux new-session -d -s claude "bash '$MIM_REPO_DIR/scripts/claude-code-session.sh'"
  ttyd -p 7681 -t titleFixed="claude code" \
    tmux attach-session -t claude &
  sleep 1
else
  echo "Skipping Claude Code terminal: ttyd or tmux is not installed"
fi

echo "Desktop ready!"
echo "  noVNC: http://localhost:6080/vnc.html?autoconnect=true"
echo "  Claude Code: http://localhost:7681"
echo "  D-Bus: $DBUS_SESSION_BUS_ADDRESS"

# Keep running
wait
