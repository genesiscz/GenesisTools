#!/usr/bin/env bash
# Golden capture for the logger+out overhaul. Captures stdout/stderr/exit per
# representative tool so we can prove STDOUT byte-parity across every phase
# (stderr/styling change is the intended deliverable; stdout must not change).
# NOTE: deliberately NOT `set -e` — a non-zero tool exit is data we want to
# record, not a reason to abort the whole capture.
set -uo pipefail

OUT="${1:?usage: capture-goldens.sh <label>}"
# Restrict the label to a safe charset so it can't escape /tmp/logger-goldens
# via "/" or ".." before it's used to build a path we then -delete from.
if [[ ! "$OUT" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "capture-goldens: invalid label '$OUT' (allowed: A-Z a-z 0-9 . _ -)" >&2
  exit 2
fi
DIR="/tmp/logger-goldens/$OUT"
mkdir -p "$DIR"
# Idempotent: drop this label's prior captures so a changed matrix never
# leaves a stale golden behind (Task 5's verify loop globs $DIR/*.out — a
# lingering golden from an old matrix would false-positive every phase).
find "$DIR" -maxdepth 1 -type f \( -name '*.out' -o -name '*.err' -o -name '*.code' \) -delete

run() { # <golden-name> <tool-dir> [argv...]
  local name="$1"; shift
  local tool="$1"; shift
  bun run "src/$tool/index.ts" "$@" >"$DIR/$name.out" 2>"$DIR/$name.err"
  echo $? >"$DIR/$name.code"
}

# Golden-selection criterion (do NOT add a tool that fails it):
# Each golden's stdout must reach the terminal via a writer the logger+out
# overhaul does NOT relocate, so a byte diff is a TRUE regression signal:
#   (a) commander's built-in --help writer (untouched by the overhaul)
#   (b) direct console.log / process.stdout.write / writeStdout NOT gated
#       behind a clack/logger short-circuit (the machine result)
# REJECTED (c): stdout emitted via logger.* or clack p.log.* — Phases 1–3
# move those to stderr by design, so it would false-positive the §6.1 gate
# every phase. (`indexer search x --format json` hit a clack "Multiple
# indexes found" guard BEFORE its JSON path = category (c); replaced with
# `json` on a tracked fixture = a pure category-(b) transform.)
run t3chat_json     t3chat-length    --format json                       # (b) writeStdout(asResult) — Task 0c; stdout = "[]\n"
run gitcommit_help  git-commit       --help                              # (a) commander help
run npmdiff_help    npm-package-diff  --help                             # (a) commander help
run macos_mail_help macos             mail search --help                 # (a) commander help
run json_toon       json             scripts/codemod/golden-fixture.json # (b) pure console.log transform, codemod-untouched

echo "captured → $DIR"
