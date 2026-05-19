#!/usr/bin/env bash
# Golden capture for the logger+out overhaul. Captures stdout/stderr/exit per
# representative tool so we can prove STDOUT byte-parity across every phase
# (stderr/styling change is the intended deliverable; stdout must not change).
# NOTE: deliberately NOT `set -e` — a non-zero tool exit is data we want to
# record, not a reason to abort the whole capture.
set -uo pipefail

OUT="${1:?usage: capture-goldens.sh <label>}"
DIR="/tmp/logger-goldens/$OUT"
mkdir -p "$DIR"

run() { # <golden-name> <tool-dir> [argv...]
  local name="$1"; shift
  local tool="$1"; shift
  bun run "src/$tool/index.ts" "$@" >"$DIR/$name.out" 2>"$DIR/$name.err"
  echo $? >"$DIR/$name.code"
}

run t3chat_json     t3chat-length    --format json
run gitcommit_help  git-commit       --help
run npmdiff_help    npm-package-diff  --help
run macos_mail_help macos             mail search --help
run indexer_json    indexer           search x --format json

echo "captured → $DIR"
