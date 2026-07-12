export function formatTimecode(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
        return "0:00";
    }

    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    }

    return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

const RELATIVE_UNITS: Array<{ limitSec: number; divisorSec: number; unit: string }> = [
    { limitSec: 60, divisorSec: 1, unit: "second" },
    { limitSec: 3600, divisorSec: 60, unit: "minute" },
    { limitSec: 86_400, divisorSec: 3600, unit: "hour" },
    { limitSec: 2_592_000, divisorSec: 86_400, unit: "day" },
    { limitSec: 31_536_000, divisorSec: 2_592_000, unit: "month" },
    { limitSec: Number.POSITIVE_INFINITY, divisorSec: 31_536_000, unit: "year" },
];

export function formatRelativeTime(iso: string | null | undefined): string {
    if (!iso) {
        return "";
    }

    const then = Date.parse(iso);

    if (Number.isNaN(then)) {
        return "";
    }

    const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));

    if (diffSec < 5) {
        return "just now";
    }

    for (const { limitSec, divisorSec, unit } of RELATIVE_UNITS) {
        if (diffSec < limitSec) {
            const value = Math.floor(diffSec / divisorSec);
            return `${value} ${unit}${value === 1 ? "" : "s"} ago`;
        }
    }

    return "";
}
