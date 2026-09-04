import type { LimitKind } from "../../account-features";

/**
 * The anthropic bucket vocabulary: which windows exist, what they are called, how long
 * they run and which provider-neutral `LimitWindow.kind` each maps to.
 *
 * It lives here rather than in `src/claude/lib/usage/constants.ts` because the usage
 * mapper below it is inside `src/utils/**`, which may not import `@app/*`
 * (scripts/ci/check-package-boundaries.ts rule 1). The claude TUI re-exports these names
 * from `constants.ts`, which keeps its own Ink colours and reset-imminence helpers.
 */

export const BUCKET_LABELS: Record<string, string> = {
    five_hour: "Session (5h)",
    seven_day: "Weekly (all)",
    seven_day_opus: "Weekly (Opus)",
    seven_day_sonnet: "Weekly (Sonnet)",
    seven_day_oauth_apps: "Weekly (OAuth)",
    extra_usage: "Extra usage",
};

export const BUCKET_PERIODS_MS: Record<string, number> = {
    five_hour: 5 * 60 * 60 * 1000,
    seven_day: 7 * 24 * 60 * 60 * 1000,
    seven_day_opus: 7 * 24 * 60 * 60 * 1000,
    seven_day_sonnet: 7 * 24 * 60 * 60 * 1000,
    seven_day_oauth_apps: 7 * 24 * 60 * 60 * 1000,
};

/**
 * `LimitWindow.kind` per bucket (spec 2026-09-04, orchestrator amendment 3). The API's
 * own `weekly_all` / `weekly_scoped` kinds and the `five_hour` bucket name survive only in
 * the legacy `usage-shared` projection the Genesis app still reads.
 */
export const BUCKET_KIND_MAP: Record<string, LimitKind> = {
    five_hour: "session",
    seven_day: "weekly",
    seven_day_opus: "scoped",
    seven_day_sonnet: "scoped",
    seven_day_oauth_apps: "weekly",
    extra_usage: "credit",
};

export function bucketKind(bucket: string): LimitKind {
    return BUCKET_KIND_MAP[bucket] ?? "weekly";
}

export const VISIBLE_BUCKETS = ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps"];

/** Windows in display order, plus the spend bucket the usage mapper appends. */
export const LIMIT_ORDER = [...VISIBLE_BUCKETS, "extra_usage"];

/** Windows the compact views (TUI overview, menubar, dashboard cards) show by default. */
export const PROMINENT_LIMITS = ["five_hour", "seven_day", "seven_day_sonnet"];
