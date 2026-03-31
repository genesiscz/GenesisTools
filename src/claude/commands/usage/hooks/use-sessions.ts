import { getSessionListing, type SessionMetadataRecord } from "@app/claude/lib/history/search";
import { readTailBytes } from "@app/utils/claude/session.utils";
import { SafeJSON } from "@app/utils/json";
import { collapsePath } from "@app/utils/paths";
import { useCallback, useEffect, useRef, useState } from "react";

// --- Constants ---

const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes (CC uses 1-hour TTL tier)
const COOLING_THRESHOLD_MS = 50 * 60 * 1000; // 50 min idle = 10 min left
const CRITICAL_THRESHOLD_MS = 55 * 60 * 1000; // 55 min idle = 5 min left

const REFRESH_INTERVAL_MS = 30_000; // re-fetch session data every 30s
const TICK_INTERVAL_MS = 1_000; // update countdowns every 1s

type TimeFilter = "1h" | "6h" | "24h" | "7d" | "all";
const TIME_FILTER_ORDER: TimeFilter[] = ["1h", "6h", "24h", "7d", "all"];
const TIME_FILTER_MS: Record<TimeFilter, number> = {
    "1h": 60 * 60 * 1000,
    "6h": 6 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    all: Number.MAX_SAFE_INTEGER,
};

// --- Types ---

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

export interface SessionGroup {
    cwdShort: string;
    cwd: string;
    sessions: SessionRow[];
}

interface TailUsage {
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
    model: string | null;
    prevModel: string | null;
}

// --- Helpers ---

function computeCacheStatus(mtime: number, now: number): { status: CacheStatus; ttlSec: number } {
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
        const lines = await readTailBytes(filePath, 16384);
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

                // Second assistant message — get previous model for switch detection
                prevModel = obj.message.model ? simplifyModel(obj.message.model) : null;
                break;
            } catch {
                // skip malformed lines
            }
        }

        return {
            ...fallback,
            model: lastModel,
            prevModel,
        };
    } catch {
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

function groupByCwd(rows: SessionRow[]): SessionGroup[] {
    const map = new Map<string, SessionRow[]>();

    for (const row of rows) {
        const key = row.cwd;
        const group = map.get(key) ?? [];
        group.push(row);
        map.set(key, group);
    }

    // Sort groups by most-recent mtime first
    const groups: SessionGroup[] = [];

    for (const [cwd, sessions] of map) {
        sessions.sort((a, b) => b.mtime - a.mtime);
        groups.push({ cwd, cwdShort: sessions[0].cwdShort, sessions });
    }

    groups.sort((a, b) => b.sessions[0].mtime - a.sessions[0].mtime);
    return groups;
}

// --- Hook ---

interface SessionsOptions {
    active: boolean;
    notifications?: {
        processCacheSessions(
            sessions: {
                sessionId: string;
                title: string | null;
                cwdShort: string;
                mtime: number;
                cacheStatus: CacheStatus;
            }[]
        ): void;
    } | null;
}

export function useSessions({ active, notifications }: SessionsOptions) {
    const [allRows, setAllRows] = useState<SessionRow[]>([]);
    const [loading, setLoading] = useState(false);
    const [timeFilter, setTimeFilter] = useState<TimeFilter>("24h");
    const [tick, setTick] = useState(0);
    const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const loadingRef = useRef(false);
    const notificationsRef = useRef(notifications);
    notificationsRef.current = notifications;

    const loadSessions = useCallback(async () => {
        if (loadingRef.current) {
            return;
        }

        loadingRef.current = true;
        setLoading(true);

        try {
            const result = await getSessionListing({ excludeSubagents: true });
            const now = Date.now();

            // Extract token/model data in parallel batches (max 20 concurrent)
            const records = result.sessions;
            const usages: TailUsage[] = [];
            const batchSize = 20;

            for (let i = 0; i < records.length; i += batchSize) {
                const batch = records.slice(i, i + batchSize);
                const batchUsages = await Promise.all(batch.map((r) => extractTailUsage(r.filePath)));
                usages.push(...batchUsages);
            }

            const rows = records.map((r, i) => buildRow(r, usages[i], now));
            setAllRows(rows);

            try {
                notificationsRef.current?.processCacheSessions(rows);
            } catch {
                // Notification failure should not interrupt session loading
            }
        } catch {
            // silent failure — keep existing data
        } finally {
            loadingRef.current = false;
            setLoading(false);
        }
    }, []);

    const forceRefresh = useCallback(() => {
        loadSessions();
    }, [loadSessions]);

    const cycleTimeFilter = useCallback(() => {
        setTimeFilter((current) => {
            const idx = TIME_FILTER_ORDER.indexOf(current);
            return TIME_FILTER_ORDER[(idx + 1) % TIME_FILTER_ORDER.length];
        });
    }, []);

    // Load on activation, refresh every 30s
    useEffect(() => {
        if (!active) {
            if (refreshTimerRef.current) {
                clearInterval(refreshTimerRef.current);
                refreshTimerRef.current = null;
            }

            if (tickTimerRef.current) {
                clearInterval(tickTimerRef.current);
                tickTimerRef.current = null;
            }

            return;
        }

        loadSessions();
        refreshTimerRef.current = setInterval(loadSessions, REFRESH_INTERVAL_MS);
        tickTimerRef.current = setInterval(() => setTick((t) => t + 1), TICK_INTERVAL_MS);

        return () => {
            if (refreshTimerRef.current) {
                clearInterval(refreshTimerRef.current);
            }

            if (tickTimerRef.current) {
                clearInterval(tickTimerRef.current);
            }
        };
    }, [active, loadSessions]);

    // Recompute cache statuses on each tick (no I/O, just recalc from mtime)
    const now = Date.now();
    const filteredRows = allRows
        .filter((r) => now - r.mtime < TIME_FILTER_MS[timeFilter])
        .map((r) => {
            const { status, ttlSec } = computeCacheStatus(r.mtime, now);
            return { ...r, cacheStatus: status, cacheTtlSec: ttlSec };
        });

    const groups = groupByCwd(filteredRows);

    // Flatten for scroll calculation
    const flatRows: SessionRow[] = [];

    for (const g of groups) {
        for (const s of g.sessions) {
            flatRows.push(s);
        }
    }

    return {
        groups,
        flatRows,
        loading,
        timeFilter,
        cycleTimeFilter,
        forceRefresh,
        tick,
    };
}

export { CACHE_TTL_MS, COOLING_THRESHOLD_MS, CRITICAL_THRESHOLD_MS };
export type { TimeFilter };
