import { getSessionListing, type SessionMetadataRecord } from "@app/claude/lib/history/search";
import { readTailBytes } from "@genesiscz/utils/claude/session.utils";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { collapsePath } from "@genesiscz/utils/paths";
import { profiler } from "@genesiscz/utils/profile";

export const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes (CC uses 1-hour TTL tier)
export const COOLING_THRESHOLD_MS = 50 * 60 * 1000; // 50 min idle = 10 min left
export const CRITICAL_THRESHOLD_MS = 55 * 60 * 1000; // 55 min idle = 5 min left

const TAIL_BATCH_SIZE = 20;
const TAIL_BYTES = 16384;

export type CacheStatus = "HOT" | "COOLING" | "CRITICAL" | "COLD";

export interface SessionRow {
    sessionId: string;
    title: string | null;
    cwd: string;
    cwdShort: string;
    project: string | null;
    mtime: number;
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
}

export interface ListSessionRowsOptions {
    /** Keep rows with mtime within this many hours. Omitted = no time filter. */
    hours?: number;
    excludeSubagents?: boolean;
    now?: number;
}

export function computeCacheStatus(mtime: number, now: number): { status: CacheStatus; ttlSec: number } {
    const elapsed = now - mtime;
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

async function extractTailUsage(filePath: string): Promise<TailUsage> {
    const fallback: TailUsage = {
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        model: null,
        prevModel: null,
    };

    try {
        const lines = await readTailBytes(filePath, TAIL_BYTES);
        let lastModel: string | null = null;
        let prevModel: string | null = null;
        let found = false;

        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const obj = SafeJSON.parse(lines[i], { strict: true });

                if (obj.type !== "assistant" || !obj.message?.usage) {
                    continue;
                }

                if (!found) {
                    const u = obj.message.usage;
                    fallback.totalTokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
                    fallback.cacheReadTokens = u.cache_read_input_tokens ?? 0;
                    fallback.cacheCreateTokens = u.cache_creation_input_tokens ?? 0;
                    lastModel = obj.message.model ? simplifyModel(obj.message.model) : null;
                    found = true;
                    continue;
                }

                prevModel = obj.message.model ? simplifyModel(obj.message.model) : null;
                break;
            } catch (err) {
                logger.debug({ err, filePath, line: lines[i]?.slice(0, 80) }, "skip malformed session tail line");
            }
        }

        return {
            ...fallback,
            model: lastModel,
            prevModel,
        };
    } catch (err) {
        logger.debug({ err, filePath }, "session tail read failed");
        return fallback;
    }
}

function buildRow(record: SessionMetadataRecord, usage: TailUsage, now: number): SessionRow {
    const cwd = record.cwd ?? "(unknown)";
    const { status, ttlSec } = computeCacheStatus(record.mtime, now);

    return {
        sessionId: record.sessionId ?? record.filePath.split("/").pop()?.replace(".jsonl", "") ?? "",
        title: record.customTitle ?? record.summary ?? record.firstPrompt?.slice(0, 60) ?? null,
        cwd,
        cwdShort: collapsePath(cwd),
        project: record.project,
        mtime: record.mtime,
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
    const records = result.sessions.filter((r) => r.mtime >= cutoff);
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
        .sort((a, b) => rank[a.cacheStatus] - rank[b.cacheStatus] || b.mtime - a.mtime);

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
