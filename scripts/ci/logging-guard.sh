#!/usr/bin/env bash
# Logging & output convention guard (logger+out overhaul, 2026-05-19).
#
# WHY THIS IS REPO-WIDE AND NOT THE PLAN'S `rg ... src` ONE-LINER:
# Task 21 proved the src-scoped, exact-`@app/logger`-match gate is unsafe —
# it missed (a) `@app/logger.ts` (extension variant), (b) the ROOT `./tools`
# dispatcher (outside src/, outside tsconfig → tsgo blind too). Removing the
# transitional default export then broke all 39 e2e tests because `./tools`
# still default-imported it. So this guard scans the whole repo and matches
# the extension + relative-path + any-local-name variants.
set -euo pipefail

fail=0

# 1. No DEFAULT import of the logger module anywhere (the named
#    `import { logger } from "@app/logger"` is the only sanctioned form).
#    Matches: `import X from "@app/logger"`, `"@app/logger.ts"`,
#    relative `../logger` / `./logger(.ts)`, and `import X, { … } from …`.
#    Does NOT match `import { … }` (named) or `import type` or `import * as`.
default_re='^\s*import\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(,\s*\{[^}]*\})?\s+from\s+["'"'"'](@app/logger(\.ts)?|(\.{1,2}/)+([^"'"'"']*/)?logger(\.ts)?)["'"'"']'
if rg -n --glob '!node_modules' --glob '!**/*.md' \
        --glob '!scripts/codemod/**' --glob '!scripts/ci/logging-guard.sh' \
        --glob '!src/logger.ts' --glob '!src/logger.test.ts' \
        "$default_re" . ; then
    echo "::error:: default import of the logger module reintroduced — use \`import { logger } from \"@app/logger\"\` (named). Includes the @app/logger.ts and relative ../logger variants; the root ./tools dispatcher counts."
    fail=1
fi

# 2. logger.* must NOT be used as the machine-result payload channel.
#    Diagnostics → file/stderr; results → out.result()/out.print() (stdout).
#    TIGHTENED vs the plan's literal regex (faithful deviation): match ONLY a
#    BARE serialized dump as the logger call's first/sole arg
#    (`logger.info(SafeJSON.stringify(x))`) — an unambiguous misplaced result.
#    The plan's `[^)]*` form false-positived ~10 idiomatic DIAGNOSTIC lines
#    (`logger.debug(\`…${SafeJSON.stringify(ctx)}\`)`, context-object logging)
#    that the overhaul never intended to ban; failing CI on those is wrong.
if rg -n 'logger\.(info|warn|error|debug|trace)\(\s*(SafeJSON|JSON)\.stringify\(' src ; then
    echo "::error:: logger used to emit a serialized result payload — that is stdout's job: use out.result()/out.print(). logger.* is diagnostics only (file + gated stderr)."
    fail=1
fi

# 3. The transitional shims must stay gone.
if rg -n '^export default |^export const consoleLog\b' src/logger.ts ; then
    echo "::error:: transitional \`export default logger\` / \`export const consoleLog\` reintroduced in src/logger.ts — removed in Task 21, the named \`logger\` (+ \`out\`) is the only API."
    fail=1
fi

# 4. Browser-client isolation: AUTHORITATIVELY enforced by the bun test
#    `src/logger/client-isolation.test.ts` (it owns the per-Vite-app client
#    roots + server/route exclusion lattice; it runs in `bun run test`).
#    Folded here (not duplicated) only as a fast fail-early reference so a CI
#    run that skips the suite still flags the gross case.
if [ ! -f src/logger/client-isolation.test.ts ]; then
    echo "::error:: src/logger/client-isolation.test.ts missing — the browser-client @app/logger isolation guard (Phase-2 deviation, handoff §5) must exist and run in the suite."
    fail=1
fi

if [ "$fail" -eq 0 ]; then
    echo "logging-guard: OK (no default import / no logger-as-result / shims gone / client-isolation test present)"
fi
exit "$fail"
