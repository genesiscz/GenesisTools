#!/usr/bin/env bash
# Usage: ./scripts/benchmarks/clones/run-measure.sh <label> <root>
#
# Runs `tools macos clones measure <root>` three times (cold/warm/warm2) and
# captures one summary line per pair into measure-results.jsonl.
#
# Phase 7+ benches the measure path (NOT duplicates) because the plumbing
# fixes target gatherEnrichedRecords / measureTree / findCloneFamilies /
# findCrossTreePartners — all consumed by buildMeasureReport, not the
# duplicate-detector.
#
# Cache: the FileMetaCache used by `clones duplicates` is NOT loaded by the
# measure command today, so there's no DB to wipe — measure is always
# effectively cold against its own state (the OS page cache is the only
# thing that warms between runs).
set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "usage: $0 <label> <root>" >&2
    exit 2
fi

LABEL="$1"
ROOT="$2"

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
RESULTS="${REPO_ROOT}/scripts/benchmarks/clones/measure-results.jsonl"
LOG_FILE="${HOME}/.genesis-tools/logs/$(date +%Y-%m-%d).log"

echo "[measure-bench] label=${LABEL} root=${ROOT}" >&2
echo "[measure-bench] pino log : ${LOG_FILE}" >&2
echo "[measure-bench] results  : ${RESULTS}" >&2

cd "$REPO_ROOT"

count_lines() {
    [[ -f "$LOG_FILE" ]] && wc -l < "$LOG_FILE" || echo 0
}

# Extract the LAST buildMeasureReport.complete line emitted between
# from_line+1 and to_line.
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
        | rg --color=never -F '"msg":"buildMeasureReport complete"' \
        | tail -1 \
        || true
}

COLD_START=$(count_lines)
echo "[measure-bench] === COLD run ===" >&2
SECONDS=0
bun run src/macos/index.ts clones measure "$ROOT" --verbose --format json >/dev/null 2>/dev/null
COLD_TOTAL=$SECONDS
echo "[measure-bench] cold finished in ${COLD_TOTAL}s" >&2

WARM_START=$(count_lines)
echo "[measure-bench] === WARM run (1st warm) ===" >&2
SECONDS=0
bun run src/macos/index.ts clones measure "$ROOT" --verbose --format json >/dev/null 2>/dev/null
WARM_TOTAL=$SECONDS
echo "[measure-bench] warm1 finished in ${WARM_TOTAL}s" >&2

WARM2_START=$(count_lines)
echo "[measure-bench] === WARM run (2nd) ===" >&2
SECONDS=0
bun run src/macos/index.ts clones measure "$ROOT" --verbose --format json >/dev/null 2>/dev/null
WARM2_TOTAL=$SECONDS
echo "[measure-bench] warm2 finished in ${WARM2_TOTAL}s" >&2

WARM2_END=$(count_lines)

COLD_JSON=$(extract_complete "$COLD_START" "$WARM_START")
WARM_JSON=$(extract_complete "$WARM_START" "$WARM2_START")
WARM2_JSON=$(extract_complete "$WARM2_START" "$WARM2_END")

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
