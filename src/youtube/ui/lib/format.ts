import { parseSqliteOrIsoDate } from "@app/utils/sql-time";

export { parseSqliteOrIsoDate as parseSqliteDate } from "@app/utils/sql-time";

export function formatNumber(value: number | null | undefined): string {
    if (value === null || value === undefined) {
        return "—";
    }

    return new Intl.NumberFormat("en", {
        notation: value >= 10_000 ? "compact" : "standard",
        maximumFractionDigits: 1,
    }).format(value);
}

export function formatDate(value: string | null | undefined): string {
    if (!value) {
        return "Never";
    }

    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

export function formatDateTime(value: string | null | undefined): string {
    const parsed = parseSqliteOrIsoDate(value);

    if (!parsed) {
        return "—";
    }

    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
        parsed
    );
}

export function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) {
        return "—";
    }

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }

    return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

export function formatBytes(value: number | { n: number } | null | undefined): string {
    const bytes = typeof value === "object" && value !== null ? value.n : value;

    if (!bytes) {
        return "0 B";
    }

    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const scaled = bytes / 1024 ** index;

    return `${scaled.toFixed(scaled >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
