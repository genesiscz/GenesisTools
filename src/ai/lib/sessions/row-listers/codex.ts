import { nativeRows } from "../agent-session-rows";

/** The Codex prompt-cache clock: the documented minimum for GPT-5.6+ on a Codex subscription. */
export const CODEX_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Codex's rows, off the shared history index. Codex cannot name the account on its own, so it falls back to the
 * SessionStart pin its launcher's `TOOLS_CODEX_ACCOUNT` produced.
 */
export const rowPart = nativeRows("codex", {
    cacheTtlMs: CODEX_CACHE_TTL_MS,
    accountOf: async (pins) => (record) => (record.sessionId ? pins.get(record.sessionId)?.account : null) ?? null,
});
