/**
 * Moved into the anthropic-sub plugin beside `api.ts`, whose types it normalises:
 * `src/utils/**` may not import `@app/*` (scripts/ci/check-package-boundaries.ts rule 1).
 * This door keeps the claude TUI and the dev-dashboard on the old specifier.
 */
export type {
    NormalizedLimit,
    NormalizedSpend,
    Severity,
} from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/limits";
export { normalizeLimits, normalizeSpend } from "@genesiscz/utils/ai/providers/plugins/anthropic-sub/limits";
