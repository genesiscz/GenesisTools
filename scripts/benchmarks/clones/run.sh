#!/usr/bin/env bash
# Usage: ./scripts/benchmarks/clones/run.sh <label> <root>
#
# Runs `tools macos clones duplicates <root>` twice — cold (cache wiped) then
# warm (cache populated). Extracts the `findDuplicateFiles.complete` JSON
# lines from the day-stamped pino log file (~/.genesis-tools/logs/YYYY-MM-DD.log),
# and appends one summary line per cold/warm pair to results.jsonl.
#
# For the 148GB scenario also set up `Monitor` on the pino log file with grep
# `walk\.progress|hash\.progress|findDuplicateFiles complete|aborted` so the
# scan can be watched mid-flight.
set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "usage: $0 <label> <root>" >&2
    exit 2
fi

LABEL="$1"
ROOT="$2"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RESULTS="${REPO_ROOT}/scripts/benchmarks/clones/results.jsonl"
DB="${HOME}/.genesis-tools/macos-clones/cache/file-meta.db"
LOG_FILE="${HOME}/.genesis-tools/logs/$(date +%Y-%m-%d).log"

echo "[bench] label=${LABEL} root=${ROOT}" >&2
echo "[bench] pino log : ${LOG_FILE}" >&2
echo "[bench] results  : ${RESULTS}" >&2

rm -f "$DB" "$DB-wal" "$DB-shm" 2>/dev/null || true

cd "$REPO_ROOT"

count_lines() {
    [[ -f "$LOG_FILE" ]] && wc -l < "$LOG_FILE" || echo 0
}

# Pull the LAST `findDuplicateFiles.complete` JSON line from the given line
# range. Line-based, not byte-based — line count is stable even when pino is
# still flushing.
extract_complete() {
    local from_line="$1"
    local to_line="$2"
    if [[ ! -f "$LOG_FILE" ]] || [[ "$to_line" -le "$from_line" ]]; then
        echo "{}"
        return
    fi
    local count=$((to_line - from_line))
    tail -n +$((from_line + 1)) "$LOG_FILE" \
        | head -n "$count" \
        | rg --color=never -F '"event":"findDuplicateFiles.complete"' \
        | tail -1 \
        || true
}

COLD_START=$(count_lines)
echo "[bench] === COLD run ===" >&2
SECONDS=0
bun run src/macos/index.ts clones duplicates "$ROOT" --verbose --format json >/dev/null 2>/dev/null
COLD_TOTAL=$SECONDS
echo "[bench] cold finished in ${COLD_TOTAL}s" >&2

WARM_START=$(count_lines)
echo "[bench] === WARM run (1st warm) ===" >&2
SECONDS=0
bun run src/macos/index.ts clones duplicates "$ROOT" --verbose --format json >/dev/null 2>/dev/null
WARM_TOTAL=$SECONDS
echo "[bench] warm1 finished in ${WARM_TOTAL}s" >&2

WARM2_START=$(count_lines)
# 3rd run regression check: detects the P0 "cache suicide" bug — if the
# second warm has the same speed as the first warm, the cache truly persists.
# If it's anywhere near cold time, the prune is nuking hits.
echo "[bench] === WARM run (2nd warm — P0 regression check) ===" >&2
SECONDS=0
bun run src/macos/index.ts clones duplicates "$ROOT" --verbose --format json >/dev/null 2>/dev/null
WARM2_TOTAL=$SECONDS
echo "[bench] warm2 finished in ${WARM2_TOTAL}s" >&2

WARM2_END=$(count_lines)

COLD_JSON=$(extract_complete "$COLD_START" "$WARM_START")
WARM_JSON=$(extract_complete "$WARM_START" "$WARM2_START")
WARM2_JSON=$(extract_complete "$WARM2_START" "$WARM2_END")

# Sentinel for empty captures so jq doesn't choke.
COLD_JSON="${COLD_JSON:-}"
WARM_JSON="${WARM_JSON:-}"
WARM2_JSON="${WARM2_JSON:-}"
[[ -z "$COLD_JSON" ]] && COLD_JSON="{}"
[[ -z "$WARM_JSON" ]] && WARM_JSON="{}"
[[ -z "$WARM2_JSON" ]] && WARM2_JSON="{}"

mkdir -p "$(dirname "$RESULTS")"

jq -nc \
    --arg label "$LABEL" \
    --arg root "$ROOT" \
    --argjson coldTotal "$COLD_TOTAL" \
    --argjson warmTotal "$WARM_TOTAL" \
    --argjson warm2Total "$WARM2_TOTAL" \
    --argjson cold "$COLD_JSON" \
    --argjson warm "$WARM_JSON" \
    --argjson warm2 "$WARM2_JSON" \
    '{label:$label, root:$root, ts:(now|todate),
      coldTotalSec:$coldTotal, warmTotalSec:$warmTotal, warm2TotalSec:$warm2Total,
      cold:$cold, warm:$warm, warm2:$warm2}' \
    | tee -a "$RESULTS"

# P0 regression assertion: warm2.sha256Calls must be ≤ 1% of cold.sha256Calls
# (allowing for trivial edits during the bench). If warm2 hashes nearly as
# many files as cold, the cache is being nuked between runs.
COLD_SHA=$(jq -r '.sha256Calls // 0' <<<"$COLD_JSON")
WARM2_SHA=$(jq -r '.sha256Calls // 0' <<<"$WARM2_JSON")
if [[ "$COLD_SHA" -gt 100 ]]; then
    THRESHOLD=$((COLD_SHA / 100))
    if [[ "$WARM2_SHA" -gt "$THRESHOLD" ]]; then
        echo "[bench] FAIL: P0 cache-suicide regression — warm2 sha256Calls=${WARM2_SHA} > 1% of cold=${COLD_SHA}" >&2
        exit 3
    fi
    echo "[bench] PASS: warm2 sha256Calls=${WARM2_SHA} / cold=${COLD_SHA} (cache persists across runs)" >&2
fi
