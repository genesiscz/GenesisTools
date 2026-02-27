export const BUCKET_LABELS: Record<string, string> = {
    five_hour: "Session (5h)",
    seven_day: "Weekly (all)",
    seven_day_opus: "Weekly (Opus)",
    seven_day_sonnet: "Weekly (Sonnet)",
    seven_day_oauth_apps: "Weekly (OAuth)",
};

export const BUCKET_PERIODS_MS: Record<string, number> = {
    five_hour: 5 * 60 * 60 * 1000,
    seven_day: 7 * 24 * 60 * 60 * 1000,
    seven_day_opus: 7 * 24 * 60 * 60 * 1000,
    seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
    seven_day_oauth_apps: 7 * 24 * 60 * 60 * 1000,
};

export const BUCKET_THRESHOLD_MAP: Record<string, "session" | "weekly"> = {
    five_hour: "session",
    seven_day: "weekly",
    seven_day_opus: "weekly",
    seven_day_sonnet: "weekly",
    seven_day_oauth_apps: "weekly",
};

export const VISIBLE_BUCKETS = [
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_oauth_apps",
];

export function colorForPct(pct: number): "red" | "yellow" | "green" {
    if (pct >= 80) {
        return "red";
    }

    if (pct >= 50) {
        return "yellow";
    }

    return "green";
}
