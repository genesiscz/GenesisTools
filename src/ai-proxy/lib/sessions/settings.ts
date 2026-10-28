import type {
    ClaudeCodeProviderSettings,
    CodexInClaudeCodeSettings,
    GrokInClaudeCodeSettings,
    ReasoningEffort,
    SessionsInConfig,
    SystemNoteConfig,
} from "@app/ai-proxy/lib/types";

/** A provider of a Claude Code session's models that has its own block under `sessionsIn.claude.providers`. */
export type ClaudeCodeProvider = keyof ClaudeCodeProviderSettings;

export interface BackgroundCompactionSettings {
    enabled: boolean;
    startAt: number;
    refreshFraction: number;
    maxTailFraction: number;
}

/**
 * What a provider does with Claude Code's compaction turn, with the defaults filled in. The server reads the config
 * on every request and hands `sessionsIn` over in the provider's request context, so an edit of config.json applies
 * to the next request without a restart.
 */
export interface CompactionPolicy {
    /** "native": the provider compacts on its own side; "summary": the model writes Claude Code's summary. */
    mode: "native" | "summary";
    /** The effort of the compaction turn; undefined: the session's own, which keeps its prompt cache. */
    effort: ReasoningEffort | undefined;
    /** The summary length the model is asked to stay under, in words; undefined: Claude Code's own prompt. */
    words: number | undefined;
    /** Compaction before Claude Code asks for it; never on unless the mode is native. */
    background: BackgroundCompactionSettings;
}

function summaryWords(words: number | undefined): number | undefined {
    return words !== undefined && Number.isFinite(words) && words > 0 ? Math.round(words) : undefined;
}

function codexCompactionPolicy(settings: CodexInClaudeCodeSettings | undefined): CompactionPolicy {
    const compaction = settings?.compaction;
    // The session's own effort by default: each effort level has its own prompt cache, so another effort re-reads
    // the whole context uncached (probe 2026-10-27: high, high, low, high, low read 0, 25.8K, 0, 25.8K, 25.8K).
    const effort = compaction?.effort ?? "session";
    const mode = compaction?.mode ?? "native";
    const fraction = (value: number | undefined, fallback: number) =>
        typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1 ? value : fallback;

    return {
        mode,
        effort: effort === "session" ? undefined : effort,
        words: summaryWords(compaction?.words ?? 5000),
        background: {
            enabled: (compaction?.background?.enabled ?? true) && mode === "native",
            startAt: fraction(compaction?.background?.startAt, 0.8),
            refreshFraction: fraction(compaction?.background?.refreshFraction, 0.15),
            maxTailFraction: fraction(compaction?.background?.maxTailFraction, 0.4),
        },
    };
}

/** Grok has no server-side compaction: its model writes the summary, under a length only when one is set. */
function grokCompactionPolicy(settings: GrokInClaudeCodeSettings | undefined): CompactionPolicy {
    return {
        mode: "summary",
        effort: undefined,
        words: summaryWords(settings?.compaction?.words),
        background: { enabled: false, startAt: 0.8, refreshFraction: 0.15, maxTailFraction: 0.4 },
    };
}

/** One policy per provider: a provider added to `ClaudeCodeProviderSettings` without an entry here does not compile. */
const COMPACTION_POLICIES: {
    [P in ClaudeCodeProvider]-?: (settings: ClaudeCodeProviderSettings[P]) => CompactionPolicy;
} = {
    codex: codexCompactionPolicy,
    grok: grokCompactionPolicy,
};

/** The compaction policy of `provider`'s models in a Claude Code session, from `sessionsIn` of the proxy config. */
export function compactionPolicy<P extends ClaudeCodeProvider>(
    provider: P,
    sessionsIn: SessionsInConfig | undefined
): CompactionPolicy {
    const resolve: (settings: ClaudeCodeProviderSettings[P]) => CompactionPolicy = COMPACTION_POLICIES[provider];

    return resolve(sessionsIn?.claude?.providers?.[provider]);
}

/** A built-in note with the configured text around it, or in its place. */
export function withSystemNote(builtIn: string, note: SystemNoteConfig | undefined): string {
    const body = note?.replace ?? builtIn;

    return [note?.prepend, body, note?.append].filter((part): part is string => Boolean(part?.trim())).join("\n\n");
}
