import { CODEX_CACHE_TTL_MS } from "@app/claude/lib/usage/session-rows";
import { nativeRows } from "../agent-session-rows";

/**
 * Codex's rows, off the shared history index. Codex cannot name the account on its own, so it falls back to the
 * SessionStart pin its launcher's `TOOLS_CODEX_ACCOUNT` produced.
 */
export const rowPart = nativeRows("codex", {
    cacheTtlMs: CODEX_CACHE_TTL_MS,
    accountOf: async (pins) => (record) => (record.sessionId ? pins.get(record.sessionId)?.account : null) ?? null,
});
