import type { WatcherKind, WatcherStatus } from "@app/monitor/lib/types";
import { parseSqliteOrIsoDate } from "@genesiscz/utils/sql-time";

export function formatAgo(value: string | null | undefined, now: number = Date.now()): string {
    const date = parseSqliteOrIsoDate(value);

    if (!date) {
        return "never";
    }

    const delta = Math.max(0, now - date.getTime());
    const seconds = Math.round(delta / 1000);

    if (seconds < 5) {
        return "just now";
    }

    if (seconds < 60) {
        return `${seconds}s ago`;
    }

    const minutes = Math.round(seconds / 60);

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.round(minutes / 60);

    if (hours < 48) {
        return `${hours}h ago`;
    }

    return `${Math.round(hours / 24)}d ago`;
}

export function formatDateTime(value: string | null | undefined): string {
    const date = parseSqliteOrIsoDate(value);

    if (!date) {
        return "—";
    }

    return new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).format(date);
}

export function formatTime(value: string | null | undefined): string {
    const date = parseSqliteOrIsoDate(value);

    if (!date) {
        return "—";
    }

    return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatLatency(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "—";
    }

    if (value >= 1000) {
        return `${(value / 1000).toFixed(2)} s`;
    }

    return `${Math.round(value)} ms`;
}

export function formatUptime(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "—";
    }

    const percent = value * 100;

    return `${percent >= 99.95 && percent < 100 ? "99.9" : percent.toFixed(percent < 99 ? 1 : 2)}%`;
}

export function formatInterval(seconds: number): string {
    if (seconds % 3600 === 0) {
        return `${seconds / 3600}h`;
    }

    if (seconds % 60 === 0) {
        return `${seconds / 60}m`;
    }

    return `${seconds}s`;
}

export function formatSpan(startIso: string, endIso: string | null, now: number = Date.now()): string {
    const start = parseSqliteOrIsoDate(startIso)?.getTime();
    const end = endIso ? parseSqliteOrIsoDate(endIso)?.getTime() : now;

    if (start === undefined || end === undefined) {
        return "—";
    }

    const minutes = Math.max(0, Math.round((end - start) / 60_000));

    if (minutes < 1) {
        return "< 1 min";
    }

    if (minutes < 60) {
        return `${minutes} min`;
    }

    const hours = Math.floor(minutes / 60);

    return `${hours}h ${minutes % 60}m`;
}

export const KIND_LABEL: Record<WatcherKind, string> = {
    website: "Website",
    statuspage: "Status page",
    "ai-provider": "AI provider",
    rss: "RSS feed",
};

export const STATUS_LABEL: Record<WatcherStatus, string> = {
    up: "Operational",
    degraded: "Degraded",
    down: "Down",
    unknown: "Unknown",
};

export function displayTarget(kind: WatcherKind, target: string): string {
    if (kind === "ai-provider") {
        return target;
    }

    return target.replace(/^https?:\/\//, "").replace(/\/$/, "");
}
