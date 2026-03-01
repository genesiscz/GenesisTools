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

export const VISIBLE_BUCKETS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"];

export const BUCKET_COLORS: Record<string, string> = {
    five_hour: "\x1b[36m", // cyan
    seven_day: "\x1b[33m", // yellow
    seven_day_opus: "\x1b[35m", // magenta
    seven_day_sonnet: "\x1b[32m", // green
    seven_day_oauth_apps: "\x1b[34m", // blue
};

export const BUCKET_INK_COLORS: Record<string, string> = {
    five_hour: "cyan",
    seven_day: "yellow",
    seven_day_opus: "magenta",
    seven_day_sonnet: "green",
    seven_day_oauth_apps: "blue",
};

export const POLL_INTERVALS = [5, 10, 15, 30, 60] as const;
export type PollInterval = (typeof POLL_INTERVALS)[number];

export function colorForPct(pct: number): "red" | "yellow" | "green" {
    if (pct >= 80) {
        return "red";
    }

    if (pct >= 50) {
        return "yellow";
    }

    return "green";
}
