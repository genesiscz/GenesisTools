#!/usr/bin/env zsh
# with-hidden-instructions.sh — run a command with a SET of agent-instruction files
# hidden from the harness, then restore them with a trap-guaranteed restore.
#
# This is the safety-critical core of the improve-agents-md clean-run protocol.
# It is factored out as a bundled script (instead of retyped inline) BECAUSE the
# restore-on-kill logic is exactly what is easy to get wrong: a foreground battery
# that gets SIGTERM'd mid-run must NEVER leave any instruction file hidden.
#
# Usage:
#   with-hidden-instructions.sh <file1> [file2 ...] -- <command> [args...]
#
# Options (must come BEFORE the file list):
#   --done-marker <path>   Write this marker file ONLY after a successful restore.
#                          Poll it from the parent to know the run finished clean.
#
# Contract:
#   * Only files that actually EXIST are hidden (missing paths are skipped, noted).
#   * Each hidden file X moves to X.iamh-hidden.<pid>.
#   * trap on EXIT/INT/TERM/HUP restores every file that WAS hidden, even on kill.
#   * After restore, every original path is re-checked; a missing one is a LOUD
#     failure on stderr (exit 3) so the caller never silently loses a file.
#   * The command's own exit code is preserved and returned (unless restore fails).
#
# NEVER echo file contents or tokens. This script only moves files by path.

set -u

emit() { print -r -- "[with-hidden] $*" >&2; }

done_marker=""
# --- parse leading options ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --done-marker) done_marker="$2"; shift 2 ;;
    --) shift; break ;;   # no files, straight to command (unusual but allowed)
    -*) emit "unknown option: $1"; exit 2 ;;
    *) break ;;           # first non-option => start of file list
  esac
done

# --- collect files to hide (everything up to the -- separator) ---
typeset -a files
files=()
while [[ $# -gt 0 && "$1" != "--" ]]; do
  files+=("$1"); shift
done
if [[ "${1:-}" != "--" ]]; then
  emit "missing '--' separator between file list and command"
  emit "usage: with-hidden-instructions.sh <file...> -- <command...>"
  exit 2
fi
shift  # drop the --

if [[ $# -eq 0 ]]; then
  emit "no command given after '--'"
  exit 2
fi

# --- hide phase (record ONLY what we actually moved) ---
typeset -a hidden_src hidden_dst
hidden_src=(); hidden_dst=()
suffix=".iamh-hidden.$$"

restore_failed=0

restore() {
  local i src dst
  for (( i = 1; i <= ${#hidden_src[@]}; i++ )); do
    src="${hidden_src[$i]}"; dst="${hidden_dst[$i]}"
    if [[ -e "$dst" ]]; then
      if ! mv "$dst" "$src" 2>/dev/null; then
        emit "WARN failed to restore $src"
        restore_failed=1
      fi
    fi
  done
}

# trap must be armed BEFORE any mv so a kill during hide still restores.
trap 'restore' EXIT INT TERM HUP

# A hide failure is FATAL, not a warning: running the command with an instruction
# file still in place would break the "physical exclusion" contamination proof the
# companion SKILL.md documents — a completed run must PROVABLY have run without
# these files.
hide_failed=0

for f in "${files[@]}"; do
  if [[ -f "$f" ]]; then
    dst="${f}${suffix}"
    if mv "$f" "$dst" 2>/dev/null; then
      hidden_src+=("$f"); hidden_dst+=("$dst")
      emit "hid $f"
    else
      emit "FATAL could not hide $f (left in place) — aborting before running the command"
      hide_failed=1
    fi
  else
    emit "skip (absent) $f"
  fi
done

if (( hide_failed )); then
  restore
  trap - EXIT INT TERM HUP
  exit 4
fi

# --- run the command with the files hidden ---
"$@"
cmd_status=$?

# --- explicit restore, then disarm the trap so EXIT does not double-run it ---
restore
trap - EXIT INT TERM HUP

# --- verify every original path is back ---
typeset -i missing=0
for f in "${files[@]}"; do
  # only assert files we actually hid
  for (( i = 1; i <= ${#hidden_src[@]}; i++ )); do
    if [[ "${hidden_src[$i]}" == "$f" ]]; then
      if [[ ! -e "$f" ]]; then
        emit "FATAL: $f was hidden but is NOT restored — recover from ${hidden_dst[$i]}"
        (( missing++ ))
      elif [[ -e "${hidden_dst[$i]}" ]]; then
        emit "FATAL: stray hidden copy ${hidden_dst[$i]} left behind even though $f exists — inspect both"
        (( missing++ ))
      fi
    fi
  done
done
if (( missing > 0 || restore_failed > 0 )); then
  exit 3
fi

# --- done marker only after a clean restore ---
if [[ -n "$done_marker" ]]; then
  print -r -- "done status=$cmd_status" > "$done_marker"
fi

exit $cmd_status
