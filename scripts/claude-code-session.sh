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

# The AI SDK server uses Docker's .env. Claude Code should use its
# persistent browser/subscription auth in /agent/home instead.
unset ANTHROPIC_API_KEY

if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is not installed."
  exec bash -l
fi

if [ -n "${MIM_CLAUDE_FLAGS:-}" ]; then
  # shellcheck disable=SC2206
  CLAUDE_ARGS=($MIM_CLAUDE_FLAGS)
else
  CLAUDE_ARGS=(--dangerously-skip-permissions --permission-mode bypassPermissions --add-dir "$AGENT_DIR")
fi

PROMPT_FILE="${MIM_CLAUDE_PROMPT_FILE:-$AGENT_DIR/AGENTS.md}"
if [ -f "$PROMPT_FILE" ]; then
  CLAUDE_ARGS+=(--append-system-prompt "$(cat "$PROMPT_FILE")")
fi

set +e
claude "${CLAUDE_ARGS[@]}"
status=$?
set -e

echo
echo "Claude Code exited with status $status. Dropping to bash."
exec bash -l
