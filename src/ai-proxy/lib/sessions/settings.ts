import type { ClaudeSessionsConfig, ReasoningEffort, SystemNoteConfig } from "@app/ai-proxy/lib/types";

/**
 * `claudeSessions` of the proxy config, handed over by `server.ts` on every request (the same hot reload as
 * `codexModels`), so an edit of config.json applies to the next request without a restart.
 */
let current: ClaudeSessionsConfig = {};

export function setClaudeSessionSettings(next: ClaudeSessionsConfig | undefined): void {
    current = next ?? {};
}

/** Claude Code's compaction turn on a Codex model: the effort to run it at (undefined: the session's) and the length. */
export function compactionSettings(config: ClaudeSessionsConfig = current): {
    mode: "native" | "summary";
    effort: ReasoningEffort | undefined;
    words: number | undefined;
} {
    // The session's own effort by default: each effort level has its own prompt cache, so another effort re-reads
    // the whole context uncached (probe 2026-10-27: high, high, low, high, low read 0, 25.8K, 0, 25.8K, 25.8K).
    const effort = config.compaction?.effort ?? "session";
    const words = config.compaction?.words ?? 5000;

    return {
        mode: config.compaction?.mode ?? "native",
        effort: effort === "session" ? undefined : effort,
        words: Number.isFinite(words) && words > 0 ? Math.round(words) : undefined,
    };
}

/** A built-in note with the configured text around it, or in its place. */
export function withSystemNote(builtIn: string, note: SystemNoteConfig | undefined): string {
    const body = note?.replace ?? builtIn;

    return [note?.prepend, body, note?.append].filter((part): part is string => Boolean(part?.trim())).join("\n\n");
}
