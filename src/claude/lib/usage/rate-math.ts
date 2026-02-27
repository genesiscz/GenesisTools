export interface TimestampedValue {
    timestamp: string;
    value: number;
}

export interface RollingRates {
    "1min": number | null;
    "5min": number | null;
    "10min": number | null;
    "30min": number | null;
}

export function calculateRate(older: TimestampedValue, newer: TimestampedValue): number {
    const olderTime = new Date(older.timestamp).getTime();
    const newerTime = new Date(newer.timestamp).getTime();
    const diffMs = newerTime - olderTime;

    if (diffMs <= 0) {
        return 0;
    }

    const diffMinutes = diffMs / 60000;
    return (newer.value - older.value) / diffMinutes;
}

export function calculateRollingRates(data: TimestampedValue[], now: Date): RollingRates {
    const windows = [1, 5, 10, 30] as const;
    const result: RollingRates = {
        "1min": null,
        "5min": null,
        "10min": null,
        "30min": null,
    };

    if (data.length < 2) {
        return result;
    }

    const latest = data[data.length - 1];
    const nowMs = now.getTime();

    for (const minutes of windows) {
        const windowStart = nowMs - minutes * 60000;
        let closest: TimestampedValue | null = null;

        for (const point of data) {
            const pointMs = new Date(point.timestamp).getTime();
            if (pointMs <= windowStart) {
                closest = point;
            }
        }

        if (closest) {
            const key = `${minutes}min` as keyof RollingRates;
            result[key] = calculateRate(closest, latest);
        }
    }

    return result;
}

export function projectTimeToLimit(currentPct: number, ratePerMinute: number): number | null {
    if (currentPct >= 100) {
        return 0;
    }

    if (ratePerMinute <= 0) {
        return null;
    }

    return Math.round((100 - currentPct) / ratePerMinute);
}

export function formatDuration(minutes: number): string {
    if (minutes < 1) {
        return "<1m";
    }

    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = Math.round(minutes % 60);

    const parts: string[] = [];

    if (days > 0) {
        parts.push(`${days}d`);
    }

    if (hours > 0) {
        parts.push(`${hours}h`);
    }

    if (mins > 0 || parts.length === 0) {
        parts.push(`${mins}m`);
    }

    return `~${parts.join(" ")}`;
}
