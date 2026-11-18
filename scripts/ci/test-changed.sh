#!/usr/bin/env bash
# Bun follows imports for --changed. Hooks and workflow steps are read as files by their tests.
set -euo pipefail
base=${1:-}
full() {
    echo "[ci] full test suite: $1"
    exec bun run test
}
[[ -n "$base" && "$base" != "0000000000000000000000000000000000000000" ]] || full "no comparison base"
if ! git cat-file -e "$base^{commit}" && ! git fetch --depth=1 origin "$base"; then
    full "comparison base unavailable"
fi
changed=$(git diff --name-only "$base" HEAD) || full "cannot read changed paths"
if ! git diff --quiet --diff-filter=D "$base" HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mts' '*.cts' '*.mjs' '*.cjs'; then
    full "a removed module may have lost its import edges"
fi
if grep -Eq '(^|/)(bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json)$|^scripts/test[^/]*\.ts$|^src/utils/(test/|bun/preload-test)' <<< "$changed"; then
    full "test infrastructure or dependency graph changed"
fi
if grep -Eq '(^|/)package\.json$' <<< "$changed"; then
    while IFS= read -r manifest; do
        [[ "$manifest" == package.json || "$manifest" == */package.json ]] || continue
        # Script edits do not change module resolution. Added or unreadable manifests require full discovery.
        if ! git show "$base:$manifest" | bun -e '
            const before = await Bun.stdin.json(), after = await Bun.file(process.argv[1]).json();
            delete before.scripts; delete after.scripts;
            process.exit(Bun.deepEquals(before, after) ? 0 : 1);
        ' "$manifest"; then
            full "package manifest changed: $manifest"
        fi
    done <<< "$changed"
fi

extra=()
if grep -Eq '^\.githooks/|^scripts/git/install-hooks\.ts$' <<< "$changed"; then
    extra+=(scripts/ci/pre-commit-hook.test.ts)
fi
if grep -Eq '^\.github/workflows/ci\.yml$|^scripts/ci/test-changed\.sh$' <<< "$changed"; then
    extra+=(scripts/ci/typecheck.test.ts scripts/ci/summarize-tests.test.ts)
fi
if grep -Fxq 'scripts/ci/lint-changed.sh' <<< "$changed"; then
    extra+=(scripts/ci/lint-rules.test.ts)
fi
if grep -Eq '(^|/)(__fixtures__|fixtures|__snapshots__)/|(^|/)\.env\.test' <<< "$changed"; then
    full "test fixtures changed"
fi

status=0
ignore=()
if (( ${#extra[@]} )); then
    # A missing completion marker in either run must still reach the workflow's hang guard.
    log=$(mktemp)
    bun scripts/test.ts --parallel "${extra[@]}" > "$log" 2>&1 || status=$?
    sed 's/^\[test\] suite complete/[ci] file-reader tests complete/' "$log"
    grep -q '^\[test\] suite complete' "$log" || exit 1
    for file in "${extra[@]}"; do ignore+=("--path-ignore-patterns=$file"); done
fi
echo "[ci] testing imports affected since $base"
bun run test "--changed=$base" --pass-with-no-tests "${ignore[@]}" || exit $?
exit "$status"
