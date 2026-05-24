#!/usr/bin/env bash
# Run all isolated microbenchmarks against all three target datasets.
# Appends one JSONL line per (bench, dataset, variant) run to results.
#
# Usage: ./run-microbenches.sh <label> [--skip-projects]
#   label         appended to each JSON record so we can filter (e.g. "phase-0-baseline")
#   --skip-projects  don't run on ~/Tresors/Projects/ (the 117GB tree)

set -euo pipefail

LABEL="${1:-unlabeled}"
SKIP_PROJECTS=0
if [[ "${2:-}" == "--skip-projects" ]]; then
    SKIP_PROJECTS=1
fi

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
RESULTS="$REPO/scripts/benchmarks/clones/microbench-results.jsonl"
mkdir -p "$(dirname "$RESULTS")"

DATASETS=(
    "small:$HOME/Tresors/Projects/GenesisTools"
    "med:$HOME/Tresors/Projects/CEZ/col-fe"
)
if [[ "$SKIP_PROJECTS" -eq 0 ]]; then
    DATASETS+=("big:$HOME/Tresors/Projects")
fi

run_bench() {
    local bench="$1" variant="$2" dataset_key="$3" root="$4"
    local extra_flags="$5"
    local kind="$bench-$variant"
    local full_label="${LABEL}-${dataset_key}-${kind}"

    if [[ ! -d "$root" ]]; then
        echo "[run-microbenches] SKIP $full_label (root does not exist: $root)" >&2
        return 0
    fi

    echo "[run-microbenches] >>> $full_label" >&2
    local start
    start=$(date +%s)
    # shellcheck disable=SC2086
    bun "$REPO/scripts/benchmarks/clones/microbenches/apfs-bench-${bench}-isolated.ts" \
        --root "$root" \
        --variant "$variant" \
        --label "$full_label" \
        --jsonl "$RESULTS" \
        $extra_flags \
        > /dev/null \
        || { echo "[run-microbenches] FAIL $full_label" >&2; return 1; }
    local end
    end=$(date +%s)
    echo "[run-microbenches]     done in $((end - start))s" >&2
}

# Prefix-hash bench has its own script name (no "-isolated" suffix to match)
run_prefix_bench() {
    local variant="$1" dataset_key="$2" root="$3" extra_flags="$4"
    local kind="prefix-hash-$variant"
    local full_label="${LABEL}-${dataset_key}-${kind}"

    if [[ ! -d "$root" ]]; then
        echo "[run-microbenches] SKIP $full_label (root does not exist: $root)" >&2
        return 0
    fi

    echo "[run-microbenches] >>> $full_label" >&2
    local start
    start=$(date +%s)
    # shellcheck disable=SC2086
    bun "$REPO/scripts/benchmarks/clones/microbenches/apfs-bench-prefix-hash.ts" \
        --root "$root" \
        --variant "$variant" \
        --label "$full_label" \
        --jsonl "$RESULTS" \
        $extra_flags \
        > /dev/null \
        || { echo "[run-microbenches] FAIL $full_label" >&2; return 1; }
    local end
    end=$(date +%s)
    echo "[run-microbenches]     done in $((end - start))s" >&2
}

for entry in "${DATASETS[@]}"; do
    KEY="${entry%%:*}"
    ROOT="${entry#*:}"

    # 1. Walk benchmarks (both base variants)
    run_bench walk readdir-only "$KEY" "$ROOT" "--iterations 3" || true
    run_bench walk readdir-stat "$KEY" "$ROOT" "--iterations 3" || true

    # 2. Hash benchmarks (sha256 node + bun built-in)
    run_bench hash sha256-node "$KEY" "$ROOT" "--iterations 4 --max-files 300 --max-mb 512" || true
    run_bench hash sha256-bun "$KEY" "$ROOT" "--iterations 4 --max-files 300 --max-mb 512" || true

    # 3. Prefix-hash benchmarks (full vs prefix)
    # max-mb=512 for small/med, 1024 for big (more dup buckets to find)
    PH_MB=512
    if [[ "$KEY" == "big" ]]; then
        PH_MB=1024
    fi
    run_prefix_bench full "$KEY" "$ROOT" "--iterations 3 --min-size 1048576 --max-mb $PH_MB" || true
    run_prefix_bench prefix "$KEY" "$ROOT" "--iterations 3 --min-size 1048576 --max-mb $PH_MB" || true
done

echo ""
echo "[run-microbenches] Results appended to $RESULTS"
echo "[run-microbenches] To inspect: jq -c \"select(.label | startswith(\\\"$LABEL\\\"))\" $RESULTS"
