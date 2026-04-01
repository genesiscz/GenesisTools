#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Fix & Paste Command
# @raycast.mode silent

# Optional parameters:
# @raycast.icon 🔧
# @raycast.packageName Developer Utils
# @raycast.argument1 { "type": "text", "placeholder": "Options (--no-pretty)", "optional": true }

# Documentation:
# @raycast.description Fix broken bash commands from clipboard and paste. Strips Bash() wrapper, fixes broken \ continuations, rejoins terminal-wrapped paths, re-formats with proper \ per --long-flag.
# @raycast.author genesiscz
# @raycast.authorURL https://github.com/genesiscz

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GENESIS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="$GENESIS_ROOT/src/utils/shell/fix/cli.ts"

ARGS=""
if [[ "$1" == *"--no-pretty"* ]]; then
    ARGS="--no-pretty"
fi

CLIPBOARD=$(pbpaste)
[[ -z "$CLIPBOARD" ]] && exit 0

# Delegate to the TypeScript implementation (preprocess.ts)
if ! FIXED=$(printf '%s' "$CLIPBOARD" | bun "$CLI" $ARGS 2>/dev/null); then
    FIXED="$CLIPBOARD"
fi

# Only update clipboard if we got content back — never clobber with empty
if [[ -z "$FIXED" ]]; then
    exit 0
fi

printf '%s' "$FIXED" | pbcopy
osascript -e 'tell application "System Events" to keystroke "v" using command down'
