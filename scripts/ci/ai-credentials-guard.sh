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

fail=0

# 1. No argless provider factories. Matches `createOpenAI()` and friends with an
#    empty argument list only — an explicit `createOpenAI({ apiKey })` is the
#    whole point and must pass. The `=`/`return` prefix keeps prose that NAMES the
#    banned pattern (this file, and the comments explaining why) out of the match.
if rg -n --glob '!node_modules' --glob '!**/*.md' --glob '!scripts/ci/ai-credentials-guard.sh' \
        '(=|return)\s*(await\s+)?create(OpenAI|Groq|Anthropic|GoogleGenerativeAI|OpenAICompatible)\(\s*\)' \
        src apps scripts ; then
    echo "::error:: argless provider factory — the SDK would read the API key from its own env var, unauditably. Pass an explicit apiKey from resolveCredential()/resolveProviderApiKey()."
    fail=1
fi

# 2. No bare SDK singletons outside the provider layer. The singletons only ever
#    read their own environment variables, which is the pickup this phase made
#    explicit.
singleton_re='^\s*import\s+\{[^}]*\b(openai|groq|anthropic|google)\b[^}]*\}\s+from\s+["'"'"']@ai-sdk/'
if rg -n --glob '!node_modules' --glob '!**/*.md' \
        --glob '!src/utils/ai/providers/**' --glob '!scripts/ci/ai-credentials-guard.sh' \
        "$singleton_re" src apps scripts ; then
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
if rg -n --glob '!node_modules' --glob '!**/*.md' \
        --glob '!src/utils/ai/config/**' --glob '!scripts/ci/ai-credentials-guard.sh' \
        --glob '!src/utils/config/migrations/2026-04-07-migrateAI.ts' \
        --glob '!src/utils/ai/AIConfig.ts' \
        'new Storage\(\s*["'"'"']ai["'"'"']\s*\)' src apps scripts ; then
    echo "::error:: new Storage(\"ai\") outside src/utils/ai/config/ — go through AiConfigStore, which owns the lock order (config first, vault second) and the migration chain."
    fail=1
fi

if [ "$fail" -eq 0 ]; then
    echo "ai-credentials-guard: OK (no argless factories / no bare singletons / one ai-config writer)"
fi

exit "$fail"
