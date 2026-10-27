import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * One line per thing that happened to a Claude Code compaction on the proxy, in `ai-proxy/usage/compaction-events.jsonl`.
 * `tools ai-proxy monitor --compaction` prints them live. Two bugs of 2026-10-27 hid for hours because nothing said
 * them out loud: Claude Code asked for every native compaction twice (`retry`), and Claude Code 2.1.312's trailing
 * system message hid the compaction turn (`missed`). Each kind below names one thing to look at.
 */
export type CompactionEventKind =
    /** A compaction turn reached the provider (`mode` says which path will answer it). */
    | "turn"
    /** A compaction turn was answered; `durationMs` is the client's whole wait. */
    | "done"
    /** Claude Code asked again because the last reply had no `<summary>` tag: the earlier answer was wasted. */
    | "retry"
    /** A request carried Claude Code's compaction prompt but was not treated as a compaction turn. */
    | "missed"
    /** A background compaction started, finished, failed, answered a turn, or could not be used. */
    | "background-start"
    | "background-ready"
    | "background-failed"
    | "background-used"
    | "background-wasted"
    /** Another login compacted a saved history again, or a lost record blocked the session. */
    | "recompacted"
    | "blocked";

export interface CompactionEvent {
    ts: string;
    kind: CompactionEventKind;
    /** The proxy session record (`gts_` key), when the request had one. */
    session?: string;
    /** Claude Code's own session id (metadata.user_id). */
    claudeSession?: string;
    /** The `gtc1.` compaction id. */
    id?: string;
    model?: string;
    /** "native", "summary" (written summary), "background" (answered from a background run). */
    mode?: string;
    reason?: string;
    durationMs?: number;
    inputTokens?: number;
    cachedTokens?: number;
    outputTokens?: number;
    /** Responses input items kept verbatim after a background item. */
    tailItems?: number;
    /** The client's user-agent (`claude-cli/2.1.312 …`). */
    client?: string;
}

/** Kinds worth a warning in the proxy log: each one cost time or tokens, or means a detection gap. */
const WARN_KINDS = new Set<CompactionEventKind>([
    "retry",
    "missed",
    "background-wasted",
    "background-failed",
    "blocked",
]);

let pathOverride: string | undefined;

export function compactionEventsPath(): string {
    return pathOverride ?? join(getAiProxyStorage().getBaseDir(), "usage", "compaction-events.jsonl");
}

/** Tests write elsewhere. */
export function setCompactionEventsPathForTests(path: string | undefined): void {
    pathOverride = path;
}

export function recordCompactionEvent(event: Omit<CompactionEvent, "ts">): CompactionEvent {
    const full: CompactionEvent = { ts: new Date().toISOString(), ...event };
    const path = compactionEventsPath();

    try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${SafeJSON.stringify(full)}\n`);
    } catch (error) {
        logger.warn({ error, path }, "ai-proxy: could not write a compaction event");
    }

    const log = WARN_KINDS.has(full.kind) ? logger.warn.bind(logger) : logger.info.bind(logger);
    log({ ...full }, `ai-proxy: compaction ${full.kind}${full.reason ? ` (${full.reason})` : ""}`);

    return full;
}
