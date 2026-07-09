#!/bin/bash
# Polybar status adapter for the file-based agent state feed.
set -euo pipefail

MODE="${1:-status}"
STATE_JSON="${MIM_STATE_JSON:-/tmp/mim/state.json}"
STATE_LINE="${MIM_STATE_LINE:-/tmp/mim/state.line}"
STALE_AFTER="${MIM_STATE_STALE_AFTER:-15}"
ACCENT="#FF4D00"
MUTED="#6E6E76"

json_value() {
  local key="$1"
  [ -f "$STATE_JSON" ] || return 1
  sed -n "s/.*\"$key\":\([^,}]*\).*/\1/p" "$STATE_JSON" \
    | head -n 1 \
    | sed 's/^"//; s/"$//'
}

compact_number() {
  awk -v n="${1:-0}" 'BEGIN {
    n += 0
    if (n >= 1000000) printf "%.1fm", n / 1000000
    else if (n >= 1000) printf "%.1fk", n / 1000
    else printf "%d", n
  }'
}

state_age() {
  [ -f "$STATE_JSON" ] || {
    echo 999999
    return
  }
  local mtime
  mtime="$(stat -c %Y "$STATE_JSON" 2>/dev/null || echo 0)"
  echo "$(( $(date +%s) - mtime ))"
}

case "$MODE" in
  status)
    if [ ! -f "$STATE_LINE" ]; then
      echo "%{F$MUTED}●%{F-} offline"
      exit 0
    fi

    status="$(json_value status || echo offline)"
    line="$(head -c 180 "$STATE_LINE" 2>/dev/null || echo offline)"
    age="$(state_age)"

    if [ "$status" != "idle" ] && [ "$status" != "offline" ] && [ "$age" -gt "$STALE_AFTER" ]; then
      echo "%{F$MUTED}●%{F-} stale"
    elif [ "$status" = "idle" ] || [ "$status" = "offline" ]; then
      echo "%{F$MUTED}●%{F-} $line"
    else
      echo "%{F$ACCENT}●%{F-} $line"
    fi
    ;;
  model)
    model="$(json_value model || true)"
    echo "${model:-model unknown}"
    ;;
  tokens)
    in_tokens="$(json_value tokensIn || echo 0)"
    out_tokens="$(json_value tokensOut || echo 0)"
    echo "$(compact_number "$in_tokens") in $(compact_number "$out_tokens") out"
    ;;
  *)
    echo "unknown mode"
    exit 1
    ;;
esac
