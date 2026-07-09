#!/bin/bash
# AT-SPI wrapper — sets environment and calls the compiled C binary
export DISPLAY="${DISPLAY:-:99}"
export GTK_MODULES="${GTK_MODULES:-gail:atk-bridge}"
export NO_AT_BRIDGE=0

read_dbus_env_file() {
  awk -F= '$1 == "DBUS_SESSION_BUS_ADDRESS" {
    print substr($0, index($0, "=") + 1)
    exit
  }' "$1" 2>/dev/null
}

read_dbus_from_process() {
  for name in bspwm xfsettingsd sxhkd at-spi2-registryd; do
    pid="$(pgrep -n -x "$name" 2>/dev/null || true)"
    [ -n "$pid" ] || continue
    tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null |
      sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' |
      head -n 1
    return
  done
}

DBUS_ADDR="$(read_dbus_env_file /tmp/mim-desktop.env)"
if [ -z "$DBUS_ADDR" ]; then
  DBUS_ADDR="$(grep "D-Bus:" /tmp/desktop.log 2>/dev/null | sed "s/.*D-Bus: //" | tail -n 1)"
fi
if [ -z "$DBUS_ADDR" ]; then
  DBUS_ADDR="$(read_dbus_from_process)"
fi
if [ -z "$DBUS_ADDR" ] && [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  DBUS_ADDR="$DBUS_SESSION_BUS_ADDRESS"
fi
if [ -z "$DBUS_ADDR" ] && [ -S "/run/user/$(id -u)/bus" ]; then
  DBUS_ADDR="unix:path=/run/user/$(id -u)/bus"
fi

if [ -n "$DBUS_ADDR" ]; then
  export DBUS_SESSION_BUS_ADDRESS="$DBUS_ADDR"
else
  unset DBUS_SESSION_BUS_ADDRESS
fi
exec /opt/atspi-tool "$@"
