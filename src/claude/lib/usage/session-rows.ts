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
    filePath: string;
}

interface TailUsage {
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    model: string | null;
    prevModel: string | null;
    lastCacheAt: number | null;
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
        model: null,
        prevModel: null,
        lastCacheAt: null,
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

function parseTailLines(lines: string[], filePath: string): TailUsage {
    const usage = emptyTailUsage();
    let lastModel: string | null = null;
    let prevModel: string | null = null;
    let foundUsage = false;

    for (let i = lines.length - 1; i >= 0; i--) {
        try {
            const obj = SafeJSON.parse(lines[i], { strict: true });

            if (usage.lastCacheAt === null) {
                usage.lastCacheAt = cacheAtFromLine(obj);
            }

            if (obj.type !== "assistant" || !obj.message?.usage) {
                continue;
            }

            if (!foundUsage) {
                const u = obj.message.usage;
                usage.totalTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
                usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
                usage.cacheCreateTokens = u.cache_creation_input_tokens ?? 0;
                lastModel = obj.message.model ? simplifyModel(obj.message.model) : null;
                foundUsage = true;
                continue;
            }

            prevModel = obj.message.model ? simplifyModel(obj.message.model) : null;
            break;
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

            if ((haveClock && haveUsage) || size <= 0 || bytes >= size || bytes >= TAIL_MAX_BYTES) {
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

function buildRow(record: SessionMetadataRecord, usage: TailUsage, now: number): SessionRow {
    const cwd = record.cwd ?? "(unknown)";
    const lastCacheAt = usage.lastCacheAt ?? record.mtime;
    const { status, ttlSec } = computeCacheStatus(lastCacheAt, now);

    return {
        sessionId: record.sessionId ?? record.filePath.split("/").pop()?.replace(".jsonl", "") ?? "",
        title: record.customTitle ?? record.summary ?? record.firstPrompt?.slice(0, 60) ?? null,
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
    const rank: Record<CacheStatus, number> = { HOT: 0, COOLING: 1, CRITICAL: 2, COLD: 3 };
    const rows = records
        .map((r, i) => buildRow(r, usages[i], now))
        .sort((a, b) => rank[a.cacheStatus] - rank[b.cacheStatus] || b.lastCacheAt - a.lastCacheAt);

    return {
        rows,
        timings: {
            listingMs,
            tailMs,
            totalMs: performance.now() - started,
            records: records.length,
        },
    };
}

/** Same row math as the usage TUI Sessions tab. */
export async function listSessionRows(opts: ListSessionRowsOptions = {}): Promise<SessionRow[]> {
    return (await listSessionRowsWithTimings(opts)).rows;
}
