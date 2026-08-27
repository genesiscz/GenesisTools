import { loadPins } from "@app/claude/lib/cmux/pins";
import { loadAllSessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import { cleanPromptText } from "@app/claude/lib/cmux/sessions";
import { getSessionListing, type SessionMetadataRecord } from "@app/claude/lib/history/search";
import { readTailBytes } from "@genesiscz/utils/claude/session.utils";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { collapsePath } from "@genesiscz/utils/paths";
import { profiler } from "@genesiscz/utils/profile";

export const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes (CC 1-hour prompt-cache TTL)
export const COOLING_THRESHOLD_MS = 50 * 60 * 1000; // 50 min idle = 10 min left
export const CRITICAL_THRESHOLD_MS = 55 * 60 * 1000; // 55 min idle = 5 min left

const TAIL_BATCH_SIZE = 20;
/** First slice. Grows up to TAIL_MAX_BYTES until a user/assistant timestamp is found. */
const TAIL_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 1024 * 1024;

export type CacheStatus = "HOT" | "COOLING" | "CRITICAL" | "COLD";

export interface SessionRow {
    sessionId: string;
    title: string | null;
    cwd: string;
    cwdShort: string;
    project: string | null;
    mtime: number;
    /** Last main-thread user/assistant timestamp (statusline @HH:MM:SS). Falls back to mtime. */
    lastCacheAt: number;
    model: string | null;
    modelSwitched: boolean;
    cacheStatus: CacheStatus;
    cacheTtlSec: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    /**
     * Context-window size: last real turn's input + cache tokens (output excluded — it
     * never sits in the window). After a compaction with no turn yet, this is the exact
     * `compactMetadata.postTokens` from the compact_boundary record instead.
     */
    contextTokens: number;
    /** True when a compact_boundary follows the last real model turn (contextTokens = postTokens). */
    compacted: boolean;
    /** Timestamp of the last real typed user message (not tool results, not compact summaries). */
    lastUserAt: number | null;
    /**
     * Account this session bills, from the SessionStart pin journal. `null` covers
     * both "no pin recorded" and a plain keychain launch (pin with account null).
     */
    account: string | null;
    /** Recorded cmux location from the refs journal — where the session started, unverified. */
    cmux: SessionCmuxLocation | null;
    filePath: string;
}

export interface SessionCmuxLocation {
    workspaceId: string | null;
    workspaceRef: string | null;
    paneRef: string | null;
    surfaceId: string | null;
    surfaceRef: string | null;
    windowRef: string | null;
    /** When the location was journaled; staleness is the consumer's call. */
    at: number;
}

interface TailUsage {
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    inputTokens: number;
    model: string | null;
    prevModel: string | null;
    lastCacheAt: number | null;
    lastUserAt: number | null;
    /** `compactMetadata.postTokens` when compaction happened after the last real turn. */
    compactedPostTokens: number | null;
}

export interface ListSessionRowsOptions {
    /** Keep rows with mtime within this many hours. Omitted = no time filter. */
    hours?: number;
    /** If the hours window has fewer rows, append older sessions by mtime. */
    minRows?: number;
    excludeSubagents?: boolean;
    now?: number;
}

export function computeCacheStatus(cacheAt: number, now: number): { status: CacheStatus; ttlSec: number } {
    const elapsed = now - cacheAt;
    const ttlRemaining = Math.max(0, CACHE_TTL_MS - elapsed);
    const ttlSec = Math.ceil(ttlRemaining / 1000);

    if (elapsed >= CACHE_TTL_MS) {
        return { status: "COLD", ttlSec: 0 };
    }

    if (elapsed >= CRITICAL_THRESHOLD_MS) {
        return { status: "CRITICAL", ttlSec };
    }

    if (elapsed >= COOLING_THRESHOLD_MS) {
        return { status: "COOLING", ttlSec };
    }

    return { status: "HOT", ttlSec };
}

function simplifyModel(model: string): string {
    if (model.includes("fable")) {
        return "fable";
    }

    if (model.includes("opus")) {
        return "opus";
    }

    if (model.includes("sonnet")) {
        return "sonnet";
    }

    if (model.includes("haiku")) {
        return "haiku";
    }

    return model.split("-").pop() ?? model;
}

function emptyTailUsage(): TailUsage {
    return {
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        inputTokens: 0,
        model: null,
        prevModel: null,
        lastCacheAt: null,
        lastUserAt: null,
        compactedPostTokens: null,
    };
}

function cacheAtFromLine(obj: { type?: unknown; timestamp?: unknown; isSidechain?: unknown }): number | null {
    if (obj.type !== "user" && obj.type !== "assistant") {
        return null;
    }

    if (obj.isSidechain === true) {
        return null;
    }

    if (typeof obj.timestamp !== "string") {
        return null;
    }

    const parsed = Date.parse(obj.timestamp);

    if (!Number.isFinite(parsed)) {
        return null;
    }

    return parsed;
}

/**
 * A real typed user message: main-thread, not a tool result, not the injected
 * compaction summary, not a meta record. Content is a string, or an array with a
 * text part (tool results are arrays of tool_result parts only).
 */
function userAtFromLine(obj: {
    type?: unknown;
    timestamp?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    isCompactSummary?: unknown;
    message?: { content?: unknown };
}): number | null {
    if (obj.type !== "user" || obj.isSidechain === true || obj.isMeta === true || obj.isCompactSummary === true) {
        return null;
    }

    const content = obj.message?.content;
    const isTyped =
        typeof content === "string" ||
        (Array.isArray(content) && content.some((part) => (part as { type?: unknown })?.type === "text"));

    if (!isTyped || typeof obj.timestamp !== "string") {
        return null;
    }

    const parsed = Date.parse(obj.timestamp);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseTailLines(lines: string[], filePath: string): TailUsage {
    const usage = emptyTailUsage();
    let lastModel: string | null = null;
    let prevModel: string | null = null;
    let foundUsage = false;
    let foundPrev = false;

    for (let i = lines.length - 1; i >= 0; i--) {
        // Everything is found — the rest of the tail can only be older.
        if (foundPrev && usage.lastUserAt !== null && usage.lastCacheAt !== null) {
            break;
        }

        try {
            const obj = SafeJSON.parse(lines[i], { strict: true });

            if (usage.lastCacheAt === null) {
                usage.lastCacheAt = cacheAtFromLine(obj);
            }

            if (usage.lastUserAt === null) {
                usage.lastUserAt = userAtFromLine(obj);
            }

            // A compaction after the last real turn states the exact post-compact
            // context in compactMetadata.postTokens — no assistant usage carries it yet.
            if (!foundUsage && usage.compactedPostTokens === null && obj.type === "system") {
                if (obj.subtype === "compact_boundary") {
                    const post = obj.compactMetadata?.postTokens;
                    usage.compactedPostTokens = typeof post === "number" ? post : 0;
                }

                continue;
            }

            if (obj.type !== "assistant" || !obj.message?.usage) {
                continue;
            }

            // Claude Code writes local notices (API errors, "No response.") as assistant
            // records with model "<synthetic>". They are not model turns: no real usage,
            // and surfacing the model string as-is is the "<synthetic>" bug.
            if (obj.message.model === "<synthetic>") {
                continue;
            }

            if (!foundUsage) {
                const u = obj.message.usage;
                usage.totalTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
                usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
                usage.cacheCreateTokens = u.cache_creation_input_tokens ?? 0;
                usage.inputTokens = u.input_tokens ?? 0;
                lastModel = obj.message.model ? simplifyModel(obj.message.model) : null;
                foundUsage = true;
                continue;
            }

            if (!foundPrev) {
                prevModel = obj.message.model ? simplifyModel(obj.message.model) : null;
                foundPrev = true;
            }
        } catch (err) {
            logger.debug({ err, filePath }, "skip malformed session tail line");
        }
    }

    usage.model = lastModel;
    usage.prevModel = prevModel;
    return usage;
}

async function extractTailUsage(filePath: string): Promise<TailUsage> {
    const fallback = emptyTailUsage();

    try {
        const size = Number(Bun.file(filePath).size) || 0;
        let bytes = TAIL_BYTES;
        let parsed = fallback;

        for (;;) {
            const lines = await readTailBytes(filePath, bytes);
            parsed = parseTailLines(lines, filePath);

            const haveClock = parsed.lastCacheAt != null;
            const haveUsage = parsed.model != null;
            const haveUser = parsed.lastUserAt != null;

            if ((haveClock && haveUsage && haveUser) || size <= 0 || bytes >= size || bytes >= TAIL_MAX_BYTES) {
                return parsed;
            }

            const next = Math.min(TAIL_MAX_BYTES, bytes * 2, size);

            if (next <= bytes) {
                return parsed;
            }

            bytes = next;
        }
    } catch (err) {
        logger.debug({ err, filePath }, "session tail read failed");
        return fallback;
    }
}

interface RowJoins {
    accounts: Map<string, string | null>;
    cmux: Map<string, SessionCmuxLocation>;
}

function buildRow(record: SessionMetadataRecord, usage: TailUsage, now: number, joins: RowJoins): SessionRow {
    const cwd = record.cwd ?? "(unknown)";
    const lastCacheAt = usage.lastCacheAt ?? record.mtime;
    const { status, ttlSec } = computeCacheStatus(lastCacheAt, now);
    const sessionId = record.sessionId ?? record.filePath.split("/").pop()?.replace(".jsonl", "") ?? "";

    return {
        sessionId,
        title:
            cleanPromptText(record.customTitle) ??
            cleanPromptText(record.summary) ??
            cleanPromptText(record.firstPrompt) ??
            null,
        cwd,
        cwdShort: collapsePath(cwd),
        project: record.project,
        mtime: record.mtime,
        lastCacheAt,
        model: usage.model,
        modelSwitched: usage.model !== null && usage.prevModel !== null && usage.model !== usage.prevModel,
        cacheStatus: status,
        cacheTtlSec: ttlSec,
        totalTokens: usage.totalTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreateTokens: usage.cacheCreateTokens,
        contextTokens: usage.compactedPostTokens ?? usage.inputTokens + usage.cacheReadTokens + usage.cacheCreateTokens,
        compacted: usage.compactedPostTokens !== null,
        lastUserAt: usage.lastUserAt,
        account: joins.accounts.get(sessionId.toLowerCase()) ?? null,
        cmux: joins.cmux.get(sessionId.toLowerCase()) ?? null,
        filePath: record.filePath,
    };
}

/**
 * Same row math as the usage TUI Sessions tab. `hours` is applied here because
 * `getSessionListing` has no time parameter. COLD rows inside the window stay.
 */
export interface SessionRowTimings {
    listingMs: number;
    tailMs: number;
    /** Pin + cmux-refs journal reads. */
    joinMs: number;
    totalMs: number;
    records: number;
}

export async function listSessionRowsWithTimings(
    opts: ListSessionRowsOptions = {}
): Promise<{ rows: SessionRow[]; timings: SessionRowTimings }> {
    const prof = profiler.scope("claude-sessions");
    const started = performance.now();
    const now = opts.now ?? Date.now();
    const result = await prof.measureAsync("listing", () =>
        getSessionListing({ excludeSubagents: opts.excludeSubagents ?? true })
    );
    const listingMs = performance.now() - started;
    const cutoff = opts.hours === undefined ? Number.NEGATIVE_INFINITY : now - opts.hours * 60 * 60 * 1000;
    const inWindow = result.sessions.filter((r) => r.mtime >= cutoff);
    const need = opts.minRows !== undefined ? Math.max(0, opts.minRows - inWindow.length) : 0;
    const extra =
        need === 0
            ? []
            : result.sessions
                  .filter((r) => r.mtime < cutoff)
                  .sort((a, b) => b.mtime - a.mtime)
                  .slice(0, need);
    const records = inWindow.concat(extra);
    const usages: TailUsage[] = [];
    const tailStarted = performance.now();

    await prof.measureAsync("tail", async () => {
        for (let i = 0; i < records.length; i += TAIL_BATCH_SIZE) {
            const batch = records.slice(i, i + TAIL_BATCH_SIZE);
            const batchUsages = await Promise.all(batch.map((r) => extractTailUsage(r.filePath)));
            usages.push(...batchUsages);
        }
    });

    const tailMs = performance.now() - tailStarted;
    const joinStarted = performance.now();
    const joins = await prof.measureAsync("journals", async () => {
        const pins = await loadPins({ readOnly: true }).catch(() => new Map());
        const accounts = new Map<string, string | null>();

        for (const [sessionId, pin] of pins) {
            accounts.set(sessionId.toLowerCase(), pin.account ?? null);
        }

        const cmux = new Map<string, SessionCmuxLocation>();

        for (const [sessionId, entry] of loadAllSessionCmuxRefs()) {
            // buildRow looks this up with sessionId.toLowerCase(); storing the raw
            // journal id meant any uppercase character silently dropped the cmux
            // location while the account join still resolved.
            cmux.set(sessionId.toLowerCase(), {
                workspaceId: entry.workspaceId ?? null,
                workspaceRef: entry.workspaceRef ?? null,
                paneRef: entry.paneRef ?? null,
                surfaceId: entry.surfaceId ?? null,
                surfaceRef: entry.surfaceRef ?? null,
                windowRef: entry.windowRef ?? null,
                at: entry.at ?? 0,
            });
        }

        return { accounts, cmux };
    });
    const joinMs = performance.now() - joinStarted;
    const rank: Record<CacheStatus, number> = { HOT: 0, COOLING: 1, CRITICAL: 2, COLD: 3 };
    const rows = records
        .map((r, i) => buildRow(r, usages[i], now, joins))
        .sort(
            (a, b) =>
                rank[a.cacheStatus] - rank[b.cacheStatus] ||
                b.lastCacheAt - a.lastCacheAt ||
                // Deterministic tie-break so equal-clock rows never shuffle between polls.
                a.sessionId.localeCompare(b.sessionId)
        );

    return {
        rows,
        timings: {
            listingMs,
            tailMs,
            joinMs,
            totalMs: performance.now() - started,
            records: records.length,
        },
    };
}

/** Same row math as the usage TUI Sessions tab. */
export async function listSessionRows(opts: ListSessionRowsOptions = {}): Promise<SessionRow[]> {
    return (await listSessionRowsWithTimings(opts)).rows;
}
