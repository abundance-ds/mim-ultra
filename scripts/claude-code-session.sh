#!/bin/bash
# Browser terminal entrypoint for Claude Code.
set -e

if [ -f /tmp/mim-desktop.env ]; then
  set -a
  . /tmp/mim-desktop.env
  set +a
fi

export DISPLAY="${DISPLAY:-:99}"
export GTK_MODULES="${GTK_MODULES:-gail:atk-bridge}"
export NO_AT_BRIDGE="${NO_AT_BRIDGE:-0}"

AGENT_DIR="${MIM_AGENT_DIR:-${MIM_AGENT_HOME:-/agent}}"
if ! cd "$AGENT_DIR" 2>/dev/null; then
  echo "Could not cd to agent home: $AGENT_DIR"
  exec bash -l
fi

load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  set -a
  . "$file"
  set +a
}

load_env_var() {
  local name="$1"
  local line value
  line="$(grep -E "^${name}=" .env 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 0
  value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  export "$name=$value"
}

load_env_file "/app/.env"
load_env_file "$AGENT_DIR/.env"
load_env_file "$AGENT_DIR/config/env"
[ -n "${ANTHROPIC_API_KEY:-}" ] || load_env_var ANTHROPIC_API_KEY

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is not installed."
  exec bash -l
fi

CLAUDE_FLAGS="${MIM_CLAUDE_FLAGS:---dangerously-skip-permissions}"
echo "Starting Claude Code in $PWD"
echo "Flags: ${CLAUDE_FLAGS:-none}"

set +e
claude $CLAUDE_FLAGS
status=$?
set -e

echo
echo "Claude Code exited with status $status. Dropping to bash."
exec bash -l
