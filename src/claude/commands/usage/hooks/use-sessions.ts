import {
    type CacheStatus,
    computeCacheStatus,
    listSessionRows,
    type SessionRow,
} from "@app/claude/lib/usage/session-rows";
import { useCallback, useEffect, useRef, useState } from "react";

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

export type { CacheStatus, SessionRow };

export interface SessionGroup {
    cwdShort: string;
    cwd: string;
    sessions: SessionRow[];
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
        sessions.sort((a, b) => b.lastCacheAt - a.lastCacheAt);
        groups.push({ cwd, cwdShort: sessions[0].cwdShort, sessions });
    }

    groups.sort((a, b) => b.sessions[0].lastCacheAt - a.sessions[0].lastCacheAt);
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
            const rows = await listSessionRows({ excludeSubagents: true });
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
            const { status, ttlSec } = computeCacheStatus(r.lastCacheAt, now);
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

export {
    CACHE_TTL_MS,
    COOLING_THRESHOLD_MS,
    CRITICAL_THRESHOLD_MS,
} from "@app/claude/lib/usage/session-rows";
export type { TimeFilter };
