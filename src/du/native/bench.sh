#!/usr/bin/env bash
# Fixed benchmark harness for the clonesize native core.
#
# Every feature added to clonesize.c must be measured with THIS script, before
# and after, and the numbers appended to .claude/docs/benchmarks-du.md. The point
# is a like-for-like comparison across commits: same targets, same modes, same
# hyperfine settings.
#
# Usage:  src/du/native/bench.sh [label]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
BIN="$HERE/clonesize"
LABEL="${1:-unlabeled}"

# Rebuild from source so the measurement always matches the working tree.
clang -O2 -pthread -o "$BIN" "$HERE/clonesize.c"

T1="$REPO"
T2="$REPO/node_modules"

# benchmarks-du.md requires the load average next to every number: wall time on
# this machine swings hard with it, so a run without it cannot be interpreted.
# Printed before AND after, because a long run can start quiet and end loaded.
show_load() {
    echo "load ($1): $(uptime)"
}

echo "clonesize bench — label: $LABEL"
echo "binary:  $BIN"
echo "targets: T1=$T1"
echo "         T2=$T2"
show_load "start"
echo

hyperfine --warmup 1 --runs 5 --style basic \
    -n "T1 flat"      "'$BIN' --quiet '$T1'" \
    -n "T1 depth2"    "'$BIN' --quiet --depth 2 '$T1'" \
    -n "T2 flat"      "'$BIN' --quiet '$T2'" \
    -n "T2 depth2"    "'$BIN' --quiet --depth 2 '$T2'"

echo
show_load "after matrix"
echo
echo "--- byte totals (T1 flat, for correctness diffing) ---"
# Captured, never piped. Piping the scan straight into `head` lets head close the
# pipe first, which kills clonesize with SIGPIPE (141) and, under
# `set -o pipefail -e`, aborts the script before the cache section below.
T1_JSON="$("$BIN" --json "$T1")"
# Print the scalar totals benchmarks-du.md actually diffs across commits. A fixed
# byte prefix of the JSON was arbitrary — the groups[] array can push any field
# past the cut, so a "correctness diff" could silently compare nothing.
grep -oE '"(files_scanned|files_listed|files_opened|files_cached|extents|threads|naive_bytes|unique_bytes|unique_allocated_bytes|apparent_bytes|sparse_bytes|sparse_files|shared_bytes|cross_group_shared_bytes|private_sum_bytes|outside_shared_bytes)": [0-9]+' <<<"$T1_JSON"

# --- extent cache (added 2026-07-27) -----------------------------------------
# Two phases, in order, because the cache is a stateful feature:
#   1. --no-cache : writes the cache, never reads it (the honest "cold" number)
#   2. warm       : same scan, extents served from the cache
# The plain matrix above runs WITHOUT --cache-dir, so it stays comparable to
# every pre-cache measurement in benchmarks-du.md.
# The label is NEVER interpolated into a path. It is caller-supplied ($1) and the
# cache dir is pasted into the single-quoted hyperfine command strings below, so a
# label containing a quote would break out of the quoting and run arbitrary
# commands. mktemp keeps the path generated and quote-free; the label stays in the
# human header, where it is only ever echoed.
CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/clonesize-bench-cache.XXXXXX")"

echo
echo "--- extent cache ---"
echo "cache dir: $CACHE_DIR"
hyperfine --warmup 1 --runs 3 --style basic \
    -n "T1 cache-cold" "'$BIN' --quiet --cache-dir '$CACHE_DIR' --no-cache '$T1'" \
    -n "T1 cache-warm" "'$BIN' --quiet --cache-dir '$CACHE_DIR' '$T1'"

echo
echo "cache file:"
ls -la "$CACHE_DIR"
WARM_OUT="$("$BIN" --quiet --cache-dir "$CACHE_DIR" "$T1")"
head -2 <<<"$WARM_OUT"
echo
show_load "end"
