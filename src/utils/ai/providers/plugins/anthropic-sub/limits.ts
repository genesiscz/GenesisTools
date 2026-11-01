import type { AbsentLimit } from "../../account-features";
import type { ApiLimit, ApiSpend, UsageResponse } from "./api";
import { bucketKind } from "./buckets";
import type { QuotaHeaderStatus } from "./quota-headers";

export type Severity = "normal" | "warning" | "critical";

export interface NormalizedLimit {
    bucket: string;
    percent: number;
    severity: Severity;
    resets_at: string | null;
    is_active: boolean;
    scope_model: string | null;
}

export interface NormalizedSpend {
    used_minor: number;
    used_currency: string;
    used_exponent: number;
    limit_minor: number | null;
    limit_exponent: number | null;
    percent: number;
    severity: Severity;
    enabled: boolean;
    cap_minor: number | null;
    cap_currency: string | null;
}

const KIND_TO_BUCKET: Record<string, string> = {
    session: "five_hour",
    weekly_all: "seven_day",
};

/**
 * Model families that have canonical bucket metadata (a label, a period, a kind) in
 * `buckets.ts`. The live API answers a bare `"Sonnet"`, which already lowercases onto the
 * canonical key, but the field is a DISPLAY name: a fuller `"Claude Opus 4.1"` would key
 * a bucket nothing knows, so the window would lose its period and its configured place in
 * `prominentBuckets` while still rendering.
 */
const SCOPED_MODEL_FAMILIES = ["opus", "sonnet"] as const;

function scopedBucketKey(modelDisplayName: string): string {
    const lowered = modelDisplayName.toLowerCase();
    const family = SCOPED_MODEL_FAMILIES.find((name) => lowered.includes(name));

    return `seven_day_${family ?? lowered}`;
}

function normalizeSeverity(s: string): Severity {
    if (s === "warning" || s === "critical") {
        return s;
    }

    return "normal";
}

function severityFromPercent(percent: number): Severity {
    if (percent >= 100) {
        return "critical";
    }

    if (percent >= 80) {
        return "warning";
    }

    return "normal";
}

function fromApiLimit(limit: ApiLimit): NormalizedLimit | null {
    let bucket: string | null = null;
    let scope_model: string | null = null;

    if (limit.kind === "weekly_scoped") {
        const model = limit.scope?.model?.display_name ?? null;

        if (!model) {
            return null;
        }

        bucket = scopedBucketKey(model);
        scope_model = model;
    } else {
        bucket = KIND_TO_BUCKET[limit.kind] ?? null;
    }

    if (!bucket) {
        return null;
    }

    return {
        bucket,
        percent: limit.percent,
        severity: normalizeSeverity(limit.severity),
        resets_at: limit.resets_at,
        is_active: limit.is_active,
        scope_model,
    };
}

function fromLegacyFlat(usage: UsageResponse): NormalizedLimit[] {
    const out: NormalizedLimit[] = [];
    const flat: Array<[string, string | null]> = [
        ["five_hour", null],
        ["seven_day", null],
        ["seven_day_sonnet", "Sonnet"],
        ["seven_day_opus", "Opus"],
        ["seven_day_oauth_apps", null],
    ];

    for (const [bucket, scope_model] of flat) {
        const value = (usage as Record<string, unknown>)[bucket];

        if (!value || typeof value !== "object" || !("utilization" in value)) {
            continue;
        }

        const b = value as { utilization: number; resets_at: string | null };

        if (typeof b.utilization !== "number" || !Number.isFinite(b.utilization)) {
            continue;
        }

        out.push({
            bucket,
            percent: b.utilization,
            severity: severityFromPercent(b.utilization),
            resets_at: b.resets_at,
            is_active: b.utilization > 0,
            scope_model,
        });
    }

    return out;
}

/**
 * What a reading says about the account's 5-hour window: it has one ("present"), the account has no
 * 5-hour limit ("absent"), or the reading cannot tell ("unknown", a row from an old file without the window).
 *
 * The one rule every reader asks, so no display infers absence from a 0 % window: an idle window on an
 * account with a 5-hour limit also reads 0 % with no reset. Absent means:
 * - `five_hour: null`, which a header reading without the 5h headers writes (since 2026-10-31 some
 *   accounts have no 5-hour limit, and their answers carry only the weekly headers);
 * - a `limits[]` with the weekly entry and no `session` entry (the usage endpoint's shape; no sample of it yet);
 * - a header reading from a build before 2026-11-01, which wrote such a reading as `{ 0, null }` with no
 *   5h status, until a fresh reading replaces it.
 */
export type FiveHourState = "present" | "absent" | "unknown";

function isOldHeaderReadingWithoutFiveHour(usage: UsageResponse): boolean {
    const quota = usage.quota as Partial<QuotaHeaderStatus> | undefined;
    const window = usage.five_hour;

    return (
        quota?.source === "headers" &&
        quota.fiveHourStatus === null &&
        typeof quota.sevenDayStatus === "string" &&
        window?.utilization === 0 &&
        window.resets_at === null
    );
}

export function fiveHourState(usage: UsageResponse | null | undefined): FiveHourState {
    if (!usage || typeof usage !== "object") {
        return "unknown";
    }

    if (usage.five_hour === null || isOldHeaderReadingWithoutFiveHour(usage)) {
        return "absent";
    }

    const kinds = Array.isArray(usage.limits) ? new Set(usage.limits.map((limit) => limit?.kind)) : new Set();

    if (kinds.has("session")) {
        return "present";
    }

    // `unknown` on purpose: a row from an old file may lack the key the type promises.
    const window: unknown = usage.five_hour;
    const utilization =
        typeof window === "object" &&
        window !== null &&
        "utilization" in window &&
        typeof window.utilization === "number"
            ? window.utilization
            : undefined;
    const resetsAt = typeof window === "object" && window !== null && "resets_at" in window ? window.resets_at : null;

    // A list that names the weekly window but no session: the endpoint left the window out, unless the flat
    // window itself shows a live one (used, or with a reset), which a list of an older shape may not repeat.
    if (kinds.has("weekly_all") && !(utilization !== undefined && (utilization > 0 || resetsAt))) {
        return "absent";
    }

    return utilization === undefined ? "unknown" : "present";
}

/**
 * The windows this reading says the account does not have, in the provider-neutral shape
 * (`AccountUsageSnapshot.absentLimits`); `normalizeLimits` and `toLimitWindows` leave them out.
 */
export function absentLimitsOf(usage: UsageResponse | null | undefined): AbsentLimit[] {
    return fiveHourState(usage) === "absent" ? [{ key: "five_hour", kind: bucketKind("five_hour") }] : [];
}

export function normalizeLimits(usage: UsageResponse): NormalizedLimit[] {
    const all = Array.isArray(usage.limits) ? fromApiLimits(usage.limits) : fromLegacyFlat(usage);

    // An old header reading still carries a `session` entry for the window the account does not have.
    return fiveHourState(usage) === "absent" ? all.filter((limit) => limit.bucket !== "five_hour") : all;
}

function fromApiLimits(limits: readonly ApiLimit[]): NormalizedLimit[] {
    const out: NormalizedLimit[] = [];

    for (const limit of limits) {
        const normalized = fromApiLimit(limit);

        if (normalized) {
            out.push(normalized);
        }
    }

    return out;
}

export function normalizeSpend(usage: UsageResponse): NormalizedSpend | null {
    const raw: ApiSpend | null | undefined = usage.spend;

    if (!raw?.used) {
        return null;
    }

    return {
        used_minor: raw.used.amount_minor,
        used_currency: raw.used.currency,
        used_exponent: raw.used.exponent,
        limit_minor: raw.limit?.amount_minor ?? null,
        limit_exponent: raw.limit?.exponent ?? null,
        // Guarded like `utilization` above it: `ApiSpend` is a cast over `res.json()`, so an
        // absent `percent` arrives as `undefined` and every renderer calls `.toFixed` on it.
        percent: typeof raw.percent === "number" && Number.isFinite(raw.percent) ? raw.percent : 0,
        severity: normalizeSeverity(raw.severity),
        enabled: raw.enabled,
        cap_minor: raw.cap?.money?.amount_minor ?? null,
        cap_currency: raw.cap?.money?.currency ?? null,
    };
}
