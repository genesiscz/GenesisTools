#!/usr/bin/env bash
# check-hardcoded-paths.sh — Block hardcoded /tmp/ and /Users/ string literals
# in src/. Replaces what would be biome GritQL plugins; biome's GritQL doesn't
# expose JS string literals as queryable nodes outside specific contexts
# (import-from, etc.), so a quick rg pass is the cleaner enforcement.
#
# Lessons learned: PR #179 t2/t3/t4/t13 caught 4 hardcoded /tmp paths that
# would crash on Windows. The dev-dashboard's obsidianVault default was
# hardcoded to /Users/Martin/... for months.
#
# Run from repo root. Returns exit 1 on any violation outside the allowlist.

set -euo pipefail

cd "$(dirname "$0")/../.."

EXIT=0

# Common ripgrep flags: ts/tsx only, skip the legitimate-fixture allowlist.
RG_FLAGS=(
    -n
    --type ts
    -g '!**/*.test.ts'
    -g '!**/*.test.tsx'
    -g '!**/*.data.ts'
    -g '!**/__tests__/**'
    -g '!scripts/ci/check-hardcoded-paths.sh'
    -g '!scripts/biome/**'
)

# Filter out lines that are clearly inside JSDoc/line-comment contexts.
# Pattern: after `file:lineno:`, the next non-space chars are `*`, `* `, or
# `//` → comment line, drop. JSDoc code-block backtick references like
# `* ` + "/tmp/example" + ` ` are false positives.
strip_comments() {
    rg -v ':\s*\*\s' | rg -v ':\s*\*$' | rg -v ':\s*//' || true
}

echo "→ Checking for hardcoded /tmp/ paths in src/..."
# Match "/tmp/, '/tmp/, `/tmp/ string-literal starts.
RAW_TMP=$(rg "${RG_FLAGS[@]}" -e "[\"'\\\`]/tmp/" src 2>/dev/null || true)
TMP_HITS=$(echo "$RAW_TMP" | strip_comments)
if [ -n "$TMP_HITS" ]; then
    echo "✗ Hardcoded /tmp/ paths found — not Windows-portable."
    echo "  Use \`join(tmpdir(), '...')\` from node:os + node:path."
    echo "  PR #179 review t2/t3/t4/t13 for context."
    echo
    echo "$TMP_HITS" | sed 's/^/    /'
    echo
    EXIT=1
fi

echo "→ Checking for hardcoded /Users/<name>/ paths in src/..."
RAW_USER=$(rg "${RG_FLAGS[@]}" -e "[\"'\\\`]/Users/[^/]+/" src 2>/dev/null || true)
USER_HITS=$(echo "$RAW_USER" | strip_comments)
if [ -n "$USER_HITS" ]; then
    echo "⚠ Hardcoded user-specific paths found — break on other dev machines."
    echo "  Use \`homedir()\` from node:os, \`process.env.HOME\`, or relative paths."
    echo
    echo "$USER_HITS" | sed 's/^/    /'
    echo
    # User paths are warn-level (test fixtures often have them). Don't fail CI.
fi

if [ "$EXIT" -eq 0 ]; then
    echo "✓ No hardcoded paths"
fi

exit "$EXIT"
