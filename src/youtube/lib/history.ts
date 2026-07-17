import type { YoutubeDatabase } from "@app/youtube/lib/db";

export interface HistoryEntry {
    ts: string;
    /** "watch" | VideoLogKind | "ask" | `job:<firstStage>` */
    action: string;
    videoId: string;
    meta?: Record<string, unknown> | null;
}

export interface VideoHistoryGroup {
    videoId: string;
    lastTs: string;
    counts: Record<string, number>;
    entries: HistoryEntry[];
}

export interface ActionHistoryGroup {
    action: string;
    count: number;
    entries: HistoryEntry[];
}

const DEFAULT_HISTORY_LIMIT = 500;

/** Merges the four user-scoped activity sources into one newest-first stream. */
export function buildHistoryEntries(
    db: YoutubeDatabase,
    userId: number,
    limit = DEFAULT_HISTORY_LIMIT
): HistoryEntry[] {
    const entries: HistoryEntry[] = [];

    for (const watch of db.listWatchesByUser(userId, limit)) {
        entries.push({ ts: watch.createdAt, action: "watch", videoId: watch.videoId });
    }

    for (const log of db.listVideoLogs({ userId, limit })) {
        entries.push({ ts: log.createdAt, action: log.kind, videoId: log.videoId, meta: log.meta });
    }

    for (const qa of db.listQaHistory(userId, undefined, limit)) {
        entries.push({ ts: qa.createdAt, action: "ask", videoId: qa.videoId, meta: { question: qa.question } });
    }

    for (const job of db.listJobs({ userId, limit })) {
        if (job.targetKind === "video") {
            entries.push({ ts: job.createdAt, action: `job:${job.stages[0] ?? "unknown"}`, videoId: job.target });
        }
    }

    entries.sort((a, b) => b.ts.localeCompare(a.ts));

    return entries.slice(0, limit);
}

export function groupHistoryByVideo(entries: HistoryEntry[]): VideoHistoryGroup[] {
    const byVideo = new Map<string, VideoHistoryGroup>();

    for (const entry of entries) {
        const group = byVideo.get(entry.videoId) ?? {
            videoId: entry.videoId,
            lastTs: entry.ts,
            counts: {},
            entries: [],
        };
        group.counts[entry.action] = (group.counts[entry.action] ?? 0) + 1;

        if (entry.ts > group.lastTs) {
            group.lastTs = entry.ts;
        }

        group.entries.push(entry);
        byVideo.set(entry.videoId, group);
    }

    return [...byVideo.values()].sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

export function groupHistoryByAction(entries: HistoryEntry[]): ActionHistoryGroup[] {
    const byAction = new Map<string, ActionHistoryGroup>();

    for (const entry of entries) {
        const group = byAction.get(entry.action) ?? { action: entry.action, count: 0, entries: [] };
        group.count += 1;
        group.entries.push(entry);
        byAction.set(entry.action, group);
    }

    return [...byAction.values()].sort((a, b) => b.count - a.count);
}
