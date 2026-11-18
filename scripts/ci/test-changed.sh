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
if grep -Eq '(^|/)(bun\.lockb?|bunfig\.toml|tsconfig[^/]*\.json)$|^scripts/test[^/]*\.ts$|^scripts/ci/test-changed\.sh$|^src/utils/(test/|bun/preload-test)' <<< "$changed"; then
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
if grep -Fxq '.github/workflows/ci.yml' <<< "$changed"; then
    extra+=(scripts/ci/typecheck.test.ts scripts/ci/summarize-tests.test.ts)
fi
if grep -Fxq 'scripts/ci/lint-changed.sh' <<< "$changed"; then
    extra+=(scripts/ci/lint-rules.test.ts)
fi
# A shell script's own suite runs it with bash, so Bun's import graph never connects the two
# (scripts/ci/ai-credentials-guard.sh and its planted-violation cases).
while IFS= read -r script; do
    [[ "$script" == *.sh && -f "${script%.sh}.test.ts" ]] || continue
    suite="${script%.sh}.test.ts"
    [[ " ${extra[*]-} " == *" $suite "* ]] || extra+=("$suite")
done <<< "$changed"
if grep -Eq '(^|/)(__fixtures__|fixtures|__snapshots__)/|(^|/)\.env\.test' <<< "$changed"; then
    full "test fixtures changed"
fi

status=0
ignore=()
file_readers() {
    # A missing completion marker in either run must still reach the workflow's hang guard.
    local log
    log=$(mktemp)
    bun scripts/test.ts --parallel "$@" 2>&1 | tee "$log" |
        awk '{ sub(/^\[test\] suite complete/, "[ci] file-reader tests complete"); print; fflush() }' || status=$?
    grep -q '^\[test\] suite complete' "$log" || exit 1
}
if grep -Eq '^\.githooks/pre-push$|^\.claude/skills/babysit/scripts/(integrate|scripts.test)\.ts$' <<< "$changed"; then
    file_readers --test-name-pattern 'integrate.s gates|integration gates read the captured commit|integration uses the same dashboard lint' \
        ./.claude/skills/babysit/scripts/scripts.test.ts
fi
if (( ${#extra[@]} )); then
    file_readers "${extra[@]}"
    for file in "${extra[@]}"; do ignore+=("--path-ignore-patterns=$file"); done
fi
echo "[ci] testing imports affected since $base"
bun run test "--changed=$base" --pass-with-no-tests "${ignore[@]}" || exit $?
exit "$status"
