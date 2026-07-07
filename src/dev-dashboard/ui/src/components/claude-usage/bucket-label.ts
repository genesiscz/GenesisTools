/**
 * Bucket labels for the dev-dashboard Claude UI. Mirrors the CLI's fallback
 * (src/claude/commands/usage/components/overview/account-section.tsx) so both
 * surfaces auto-adapt when the API introduces a new weekly-scoped model
 * (Fable today, whatever tomorrow) without hardcoding.
 *
 * Strategy:
 *   1. Well-known bucket keys get a curated label.
 *   2. Scoped weekly buckets (`seven_day_*`) get `7-day (<ScopeModel>)` — using
 *      the API's proper casing when `scopeModel` is provided, otherwise
 *      Title-Cased from the suffix.
 *   3. Session-scoped buckets (`five_hour_*`) get `5-hour (<ScopeModel>)`.
 *   4. Anything else falls back to a humanised `snake_case` → `space case`.
 */

const BASE_LABELS: Record<string, string> = {
    five_hour: "5-hour",
    seven_day: "7-day",
    seven_day_sonnet: "7-day (Sonnet)",
    seven_day_opus: "7-day (Opus)",
    seven_day_oauth_apps: "7-day (OAuth apps)",
};

function titleCase(value: string): string {
    return value
        .replace(/_/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(" ")
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
}

export function formatBucketLabel(bucket: string, scopeModel: string | null | undefined): string {
    const known = BASE_LABELS[bucket];

    if (known) {
        return known;
    }

    if (bucket.startsWith("seven_day_")) {
        const suffix = bucket.slice("seven_day_".length);
        return `7-day (${scopeModel ?? titleCase(suffix)})`;
    }

    if (bucket.startsWith("five_hour_")) {
        const suffix = bucket.slice("five_hour_".length);
        return `5-hour (${scopeModel ?? titleCase(suffix)})`;
    }

    if (scopeModel) {
        return `${titleCase(bucket)} (${scopeModel})`;
    }

    return titleCase(bucket);
}
