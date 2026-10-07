#!/usr/bin/env bash
# Lint the PR diff instead of the whole tree.
#
# Every rule in play is per-file and syntactic, so restricting to changed files
# cannot hide a violation the branch introduced. That is NOT true of the
# typecheck, which stays whole-tree.
#
# Why the file list is computed here rather than with `biome check --changed`:
# biome's own VCS integration returned zero files under CI's shallow checkout
# (run 32252357471), and biome exits 1 on "No files were processed", so the step
# failed instead of doing nothing. Passing an explicit list avoids both.
#
# With no base argument, or when the diff cannot be computed, this runs the full
# scan. A changed-file optimisation that silently checks NOTHING is worse than a
# slow one.
set -euo pipefail

BASE="${1:-}"

run_full() {
    bun run lint:biome
    bun run lint:rules
}

if [ -z "$BASE" ]; then
    echo "lint-changed: no base given, scanning everything"
    run_full
    exit 0
fi

if ! diff_output=$(git diff --name-only --diff-filter=ACMR "$BASE" HEAD -- \
    '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' 'biome.json' 'biome.jsonc' 2>&1); then
    echo "lint-changed: cannot diff against ${BASE}, scanning everything"
    echo "  git said: ${diff_output}"
    run_full
    exit 0
fi

# Filter to files that still exist. A rename reports its old path too, and
# biome errors on a path it cannot read.
# A changed Biome config can turn an untouched file into a violation, so it
# rescans every file rather than only the changed ones.
files=()
biome_config_changed=false
while IFS= read -r file; do
    # An `if` rather than an `a && b && c` chain, for legibility only. I expected
    # `set -e` to abort here on a missing file and tested it: bash exits 0 either
    # way, so both forms are safe.
    if [ "$file" = "biome.json" ] || [ "$file" = "biome.jsonc" ]; then
        biome_config_changed=true
    elif [ -n "$file" ] && [ -f "$file" ]; then
        files+=("$file")
    fi
done <<<"$diff_output"

if [ "$biome_config_changed" = true ]; then
    echo "lint-changed: Biome config changed against ${BASE}, running Biome on everything"
    bun run lint:biome
elif [ ${#files[@]} -eq 0 ]; then
    echo "lint-changed: no changed Biome files against ${BASE}"
else
    echo "lint-changed: ${#files[@]} changed Biome file(s) against ${BASE}"
    ./node_modules/.bin/biome check "${files[@]}"
fi

# Repo rules own a wider source set than Biome, including Swift. They must run
# even when the TypeScript/JavaScript list above is empty.
bun scripts/ci/lint-rules.ts --changed "$BASE"
