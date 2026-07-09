#!/usr/bin/env bash
set -u

# Clean desktop/eval state between agent trials. Run inside the container.

export DISPLAY="${DISPLAY:-:99}"

xset s off s noblank >/dev/null 2>&1 || true
xfce4-screensaver-command --deactivate >/dev/null 2>&1 || true

for pattern in "node .*agent/scripts/trace-agent.ts"; do
  ps -eo pid=,args= | awk -v pat="$pattern" '$0 ~ pat { print $1 }' | xargs -r kill -TERM 2>/dev/null || true
done

sleep 0.5

ps -eo pid=,args= | awk '/python3 .*circle/ { print $1 }' | xargs -r kill -TERM 2>/dev/null || true

for name in surf mousepad gnome-calculator epiphany epiphany-browser xfce4-terminal xfce4-screensaver; do
  pkill -TERM -x "$name" 2>/dev/null || true
done

sleep 0.5

ps -eo pid=,args= | awk '/python3 .*circle/ { print $1 }' | xargs -r kill -KILL 2>/dev/null || true

for name in surf mousepad gnome-calculator epiphany epiphany-browser xfce4-terminal xfce4-screensaver; do
  pkill -KILL -x "$name" 2>/dev/null || true
done

rm -f /tmp/atspi-last-snap*.json
rm -f /tmp/mim-atspi-eval-* /tmp/mim-atspi-circle-* /tmp/kreis_show.html /tmp/circle*.py /tmp/circle*.html
rm -f "$HOME"/.local/share/Mousepad/autosave-* 2>/dev/null || true

echo "desktop eval state reset"
