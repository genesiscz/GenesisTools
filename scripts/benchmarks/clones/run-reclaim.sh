#!/usr/bin/env bash
# Usage: ./scripts/benchmarks/clones/run-reclaim.sh <label> <dir> [reclaim plan flags...]
#
# Runs `tools macos clones reclaim plan --dir <dir>` twice (cold, then warm on
# the same file-meta cache) with PROFILE=clones, and appends one JSONL row to
# reclaim-results.jsonl carrying: wall time per run, the plan totals (roots,
# skipped, sets, bytes), the collapse stats the run log recorded (walkMs,
# hashMs, sha256Calls, cache hits) and the profiler's per-phase summary.
#
# Nothing is wiped. "cold" here means "the first run of this invocation";
# run it under an empty HOME (HOME=/tmp/x) for a truly cold file-meta cache.
#
# Example:
#   ./scripts/benchmarks/clones/run-reclaim.sh fleet-baseline ~/Projects --worktrees-of acme
set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "usage: $0 <label> <dir> [reclaim plan flags...]" >&2
    exit 2
fi

LABEL="$1"
DIR="$2"
shift 2

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RESULTS="${REPO_ROOT}/scripts/benchmarks/clones/reclaim-results.jsonl"
TOOLS_HOME="${GENESIS_TOOLS_HOME:-$HOME}"
PROFILE_FILE="$(mktemp -t gt-reclaim-profile)"

echo "[reclaim-bench] label=${LABEL} dir=${DIR} flags=$*" >&2
echo "[reclaim-bench] profile : ${PROFILE_FILE}" >&2
echo "[reclaim-bench] results : ${RESULTS}" >&2

cd "$REPO_ROOT"

# One plan run. Prints a JSON object: {name, totalSec, plan, stats}.
run_once() {
    local name="$1"
    shift
    SECONDS=0
    local out
    # --no-daemon: a timing run must not register the 03:00 scan and the 04:00
    # VACUUM on the developer's machine, and --silent hides the line that says so.
    out="$(PROFILE=clones PROFILE_TO_FILE="$PROFILE_FILE" \
        bun run src/macos/index.ts clones reclaim plan --dir "$DIR" --format json --silent --no-daemon "$@")"
    local total=$SECONDS
    echo "[reclaim-bench] ${name} finished in ${total}s" >&2

    local run_id
    run_id="$(echo "$out" | jq -r '.runId')"
    local run_log="${TOOLS_HOME}/.genesis-tools/macos-clones/reclaim/${run_id}.jsonl"
    # `rg` with no match exits 1, which under `set -e` kills the whole script
    # and discards both completed runs before the row is written.
    local stats="{}"
    if [[ -f "$run_log" ]]; then
        stats="$(rg --color=never -F '"phase":"collapse"' "$run_log" | tail -1 | jq -c '.stats // {}' || true)"
    fi

    local plan
    plan="$(echo "$out" | jq -c '{roots: (.roots | length), skipped: (.skipped | length), sets: (.sets | length), totalReclaimable, fromSnapshot, runId}')"
    if [[ -z "$stats" ]]; then
        stats="{}"
    fi

    jq -nc --arg name "$name" --argjson total "$total" --argjson plan "$plan" --argjson stats "$stats" \
        '{name: $name, totalSec: $total, plan: $plan, stats: $stats}'
}

COLD="$(run_once cold "$@")"
WARM="$(run_once warm "$@")"

# The profiler appends a summary table per run; keep every clones line so the
# row is self-contained (labels + n + total + avg + max).
PROFILE_JSON="$(rg --color=never -F '[profile:clones]' "$PROFILE_FILE" | jq -R . | jq -sc . || true)"
if [[ -z "$PROFILE_JSON" ]]; then
    echo "[reclaim-bench] no [profile:clones] lines in ${PROFILE_FILE}" >&2
    PROFILE_JSON="[]"
fi

mkdir -p "$(dirname "$RESULTS")"
DIR_ANON="${DIR/#$HOME/~}"

jq -nc \
    --arg label "$LABEL" \
    --arg dir "$DIR_ANON" \
    --arg flags "$*" \
    --argjson cold "$COLD" \
    --argjson warm "$WARM" \
    --argjson profile "$PROFILE_JSON" \
    '{label: $label, dir: $dir, flags: $flags, ts: (now | todate), cold: $cold, warm: $warm, profile: $profile}' \
    >> "$RESULTS"

echo "[reclaim-bench] appended → ${RESULTS}" >&2
tail -1 "$RESULTS" | jq -c '{label, cold: {totalSec: .cold.totalSec, sets: .cold.plan.sets, sha256Calls: .cold.stats.sha256Calls}, warm: {totalSec: .warm.totalSec, sets: .warm.plan.sets, sha256Calls: .warm.stats.sha256Calls, cacheHits: .warm.stats.cacheHits}}' >&2
