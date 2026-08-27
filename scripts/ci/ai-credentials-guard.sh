#!/usr/bin/env bash
# AI credential-resolution guard (AI overhaul Phase 2, 2026-07-29).
#
# The rule this enforces: a credential must be resolved somewhere a human can
# see. Three patterns break that, and all three existed in this repo:
#
#   1. `createOpenAI()` with no arguments — the SDK then reads OPENAI_API_KEY
#      itself, so nothing in the config or the logs can tell you which key was
#      spent. For openai-compatible providers it was worse than opaque: with no
#      key resolved, the SDK sent OPENAI_API_KEY to openrouter.ai / api.x.ai.
#   2. Bare SDK singletons (`import { openai } from "@ai-sdk/openai"`) — same
#      hidden env read, one import away from any file.
#   3. `new Storage("ai")` outside the config layer — the AI config has a lock
#      discipline and a migration chain; a second writer bypasses both.
#
# Environment variables still resolve keys (see the grandfather policy). They now
# do it through `resolveCredential` / `resolveProviderApiKey`, which name the
# variable, log the source, and can be pointed at an account.
set -euo pipefail

# Reach the repo root first. `git grep -- src apps scripts` is resolved relative
# to the cwd, so running this from a subdirectory scanned nothing, and
# require-grep.sh below refuses to run outside a work tree at all.
cd "$(dirname "$0")/../.."

# A missing grep would make every `if … ; then` below read as "no matches" and pass silently.
source "$(dirname "${BASH_SOURCE[0]}")/require-grep.sh"

fail=0

# Roots default to the repo's own trees. Passing them in is what lets the guard's
# own test point it at a fixture directory of known violations.
roots=("$@")
external_roots=1
if [ ${#roots[@]} -eq 0 ]; then
    roots=(src apps scripts)
    external_roots=0
fi

# Run one PCRE over the configured roots. Prints matching lines; returns 0 when
# something matched and 1 when nothing did.
#
# Two modes on purpose. `git grep` searches TRACKED files relative to the work
# tree, which is exactly right for the repo's own scan, and it flatly refuses a
# path outside the repository ("is outside repository", exit 128). The guard's
# own test passes an absolute /tmp fixture directory, so the repo-mode call
# errored on every fixture — and because the callers were written as
# `if git grep …`, exit 128 read as "no matches" and the guard exited 0 while
# the test expected 1. That is the same silent-pass shape this guard was just
# converted to eliminate, reintroduced one layer up. Caught by review t27 on
# PR #330; 7 of the 9 tests in ai-credentials-guard.test.ts were failing.
#
# For an external root the fix is `git grep --no-index` run from INSIDE it. It
# keeps the PCRE dialect identical in both modes, which a plain-grep fallback
# would not: BSD grep on macOS has no -P at all, so the patterns would have to
# be rewritten as POSIX ERE and the two modes could drift apart silently.
scan() {
    pattern="$1"
    shift
    matched=1

    for root in "${roots[@]}"; do
        if [ "$external_roots" -eq 1 ]; then
            out=$(cd "$root" && git grep --no-index -nP -e "$pattern" -- . "$@") && rc=0 || rc=$?
        else
            out=$(git grep -nP -e "$pattern" -- "$root" "$@") && rc=0 || rc=$?
        fi

        # 0 = matched, 1 = no match. Anything else is a broken scan, and a broken
        # scan must never be reported as a clean one.
        if [ "$rc" -gt 1 ]; then
            echo "::error:: scanning '${root}' failed (git grep exit ${rc}) — refusing to report a clean result from a scan that did not run."
            exit 1
        fi

        if [ "$rc" -eq 0 ]; then
            printf '%s\n' "$out"
            matched=0
        fi
    done

    return "$matched"
}

# 1. No argless provider factories. Matches `createOpenAI()` and friends with an
#    empty argument list only; an explicit `createOpenAI({ apiKey })` is the whole
#    point and must pass.
#
#    The match is position-independent. It used to require a `=` or `return`
#    immediately before the call, which let `consume(createOpenAI())`,
#    `const p = (createOpenAI())` and a bare `createOpenAI();` statement through
#    while they performed exactly the same hidden env read. That prefix was really
#    there to skip prose that NAMES the pattern, so prose is now skipped directly:
#    comment lines and backticked mentions are dropped from the results.
argless=$(scan '(await\s+)?create(OpenAI|Groq|Anthropic|GoogleGenerativeAI|OpenAICompatible)\(\s*\)' \
        ':(exclude)**/*.md' ':(exclude)scripts/ci/ai-credentials-guard.sh' ':(exclude)scripts/ci/ai-credentials-guard.test.ts' \
        | grep -Ev ':[[:space:]]*(//|\*|#)' | grep -Fv '`create' || true)
if [ -n "$argless" ]; then
    echo "$argless"
    echo "::error:: argless provider factory — the SDK would read the API key from its own env var, unauditably. Pass an explicit apiKey from resolveCredential()/resolveProviderApiKey()."
    fail=1
fi

# 2. No bare SDK singletons outside the provider layer. The singletons only ever
#    read their own environment variables, which is the pickup this phase made
#    explicit.
singleton_re='^\s*import\s+\{[^}]*\b(openai|groq|anthropic|google)\b[^}]*\}\s+from\s+["'"'"']@ai-sdk/'
if scan "$singleton_re" \
        ':(exclude)**/*.md' ':(exclude)src/utils/ai/providers/**' \
        ':(exclude)scripts/ci/ai-credentials-guard.sh' ':(exclude)scripts/ci/ai-credentials-guard.test.ts' ; then
    echo "::error:: bare @ai-sdk singleton imported outside src/utils/ai/providers/ — use a provider plugin (registry.ts) so the credential is resolved through one auditable path."
    fail=1
fi

# 3. The AI config has exactly one writer. `Storage("ai")` elsewhere sidesteps
#    the config lock, the migration chain and the worktree write guard.
#    Two files are excluded on purpose, both scheduled to go:
#      - `2026-04-07-migrateAI.ts`, the pre-v4 migration that must write the old
#        shape before the v4 one can convert it.
#      - `AIConfig.ts`, the deprecated v3 facade, deleted once its last consumer
#        moves to AiConfigStore (Phase 8).
if scan 'new Storage\(\s*["'"'"']ai["'"'"']\s*\)' \
        ':(exclude)**/*.md' ':(exclude)src/utils/ai/config/**' \
        ':(exclude)scripts/ci/ai-credentials-guard.sh' ':(exclude)scripts/ci/ai-credentials-guard.test.ts' \
        ':(exclude)src/utils/config/migrations/2026-04-07-migrateAI.ts' ':(exclude)src/utils/ai/AIConfig.ts' ; then
    echo "::error:: new Storage(\"ai\") outside src/utils/ai/config/ — go through AiConfigStore, which owns the lock order (config first, vault second) and the migration chain."
    fail=1
fi

if [ "$fail" -eq 0 ]; then
    echo "ai-credentials-guard: OK (no argless factories / no bare singletons / one ai-config writer)"
fi

exit "$fail"
