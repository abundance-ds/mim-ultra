#!/bin/bash
# Start the agent-native Linux desktop environment.
# Launches Xvfb, D-Bus, AT-SPI, bspwm, VNC, and noVNC.
set -e

export DISPLAY=:99
export DBUS_SESSION_BUS_ADDRESS=""
export GTK_MODULES=gail:atk-bridge
export NO_AT_BRIDGE=0

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIM_APP_DIR="${MIM_APP_DIR:-$REPO_DIR}"
if [ -z "${MIM_AGENT_DIR:-}" ]; then
  if [ -f /agent/src/server.ts ]; then
    MIM_AGENT_DIR="/agent"
  elif [ -f "$REPO_DIR/agent/src/server.ts" ]; then
    MIM_AGENT_DIR="$REPO_DIR/agent"
  else
    MIM_AGENT_DIR="/agent"
  fi
fi
export MIM_APP_DIR MIM_AGENT_DIR MIM_AGENT_HOME="${MIM_AGENT_HOME:-$MIM_AGENT_DIR}"

CONFIG_DIR="/usr/local/share/mim/desktop"
WALLPAPER="/usr/local/share/mim/wallpaper.png"

# Make this script safe to re-run inside a live container.
killall Xvfb x11vnc websockify bspwm sxhkd polybar xfsettingsd at-spi2-registryd xwallpaper 2>/dev/null || true
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 /tmp/mim-desktop.env

# Start virtual framebuffer
Xvfb :99 -screen 0 1280x800x24 &
XVFB_PID=$!
sleep 1
if ! kill -0 "$XVFB_PID" 2>/dev/null || ! xset -display :99 q >/dev/null 2>&1; then
  echo "ERROR: Xvfb failed to start on :99"
  exit 1
fi

# Start D-Bus session bus
eval $(dbus-launch --sh-syntax)
export DBUS_SESSION_BUS_ADDRESS
cat > /tmp/mim-desktop.env <<EOF
DISPLAY=$DISPLAY
DBUS_SESSION_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
GTK_MODULES=$GTK_MODULES
NO_AT_BRIDGE=$NO_AT_BRIDGE
EOF
chmod 644 /tmp/mim-desktop.env

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
  CLAUDE_USER="${MIM_CLAUDE_USER:-agent}"
  CLAUDE_HOME="${MIM_CLAUDE_HOME:-$MIM_AGENT_DIR/home}"
  mkdir -p "$CLAUDE_HOME"
  chmod a+rwx "$CLAUDE_HOME" 2>/dev/null || true
  cat > /tmp/mim-start-claude-session <<EOF
#!/bin/bash
export HOME="$CLAUDE_HOME"
export USER="$CLAUDE_USER"
export LOGNAME="$CLAUDE_USER"
export MIM_AGENT_DIR="$MIM_AGENT_DIR"
export MIM_AGENT_HOME="$MIM_AGENT_HOME"
export MIM_APP_DIR="$MIM_APP_DIR"
exec bash "$MIM_APP_DIR/scripts/claude-code-session.sh"
EOF
  chmod 755 /tmp/mim-start-claude-session
  if id "$CLAUDE_USER" >/dev/null 2>&1 && command -v setpriv >/dev/null 2>&1; then
    CLAUDE_UID="$(id -u "$CLAUDE_USER")"
    CLAUDE_GID="$(id -g "$CLAUDE_USER")"
    CLAUDE_SESSION_CMD="setpriv --reuid=$CLAUDE_UID --regid=$CLAUDE_GID --init-groups /tmp/mim-start-claude-session"
  elif id "$CLAUDE_USER" >/dev/null 2>&1; then
    CLAUDE_SESSION_CMD="su -p -s /bin/bash '$CLAUDE_USER' -c /tmp/mim-start-claude-session"
  else
    CLAUDE_SESSION_CMD="bash '$MIM_APP_DIR/scripts/claude-code-session.sh'"
  fi
  tmux has-session -t claude 2>/dev/null ||
    tmux new-session -d -s claude "$CLAUDE_SESSION_CMD"
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
