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

export function parseTimecode(value: string): number | null {
    const parts = value.split(":").map((part) => Number.parseInt(part, 10));

    if (parts.some((part) => Number.isNaN(part))) {
        return null;
    }

    if (parts.length === 2) {
        return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    }

    if (parts.length === 3) {
        return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
    }

    return null;
}
