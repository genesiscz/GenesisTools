import type { ApiLimit, ApiSpend, UsageResponse } from "./api";

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

function scopedBucketKey(modelDisplayName: string): string {
    return `seven_day_${modelDisplayName.toLowerCase()}`;
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

export function normalizeLimits(usage: UsageResponse): NormalizedLimit[] {
    if (Array.isArray(usage.limits)) {
        const out: NormalizedLimit[] = [];

        for (const limit of usage.limits) {
            const normalized = fromApiLimit(limit);

            if (normalized) {
                out.push(normalized);
            }
        }

        return out;
    }

    return fromLegacyFlat(usage);
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
        percent: raw.percent,
        severity: normalizeSeverity(raw.severity),
        enabled: raw.enabled,
        cap_minor: raw.cap?.money?.amount_minor ?? null,
        cap_currency: raw.cap?.money?.currency ?? null,
    };
}
