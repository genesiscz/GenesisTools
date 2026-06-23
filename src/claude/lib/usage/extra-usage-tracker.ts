import { formatDuration } from "@app/utils/format";
import type { ExtraUsageBucket } from "./api";

export type { ExtraUsageBucket };

export const EXTRA_USAGE_BUCKET = "extra_usage";
export const EXTRA_USAGE_NOTIFICATION_GROUP = "claude-extra-usage";
export const EXTRA_USAGE_SPEND_INCREMENT = 5;

export type ExtraUsageNotifyReason = "EXTRA_ENABLED" | "EXTRA_DISABLED" | "EXTRA_SPEND";

export interface ExtraUsageTrackerState {
    lastKnownEnabled: boolean | null;
    lastKnownSpent: number | null;
    lastKnownLimit: number | null;
    lastKnownCurrency: string | null;
    lastKnownDecimalPlaces: number | null;
    lastNotifiedSpent: number | null;
    lastNotifiedAt: number | null;
}

export interface ExtraUsageNotifyEvent {
    reason: ExtraUsageNotifyReason;
    fromSpent: number | null;
    toSpent: number | null;
    limit: number | null;
    currency: string | null;
    decimalPlaces: number;
    elapsedMs: number | null;
}

/** API amounts are minor units (e.g. cents); normalize to major for tracking/display. */
export function toMajorAmount(amount: number | null, decimalPlaces: number): number | null {
    if (amount === null) {
        return null;
    }

    return amount / 10 ** decimalPlaces;
}

export function formatExtraUsageMoney(amount: number | null, currency: string | null, decimalPlaces: number): string {
    if (amount === null) {
        return "?";
    }

    const symbol = currencySymbol(currency);
    return `${symbol}${amount.toFixed(decimalPlaces)}`;
}

export function resolveExtraUsageOverview(bucket: ExtraUsageBucket): {
    enabled: boolean;
    utilization: number;
    balance: string | null;
    spentMajor: number | null;
    limitMajor: number | null;
} {
    const decimalPlaces = bucket.decimal_places ?? 2;
    const spentMajor = toMajorAmount(bucket.used_credits, decimalPlaces);
    const limitMajor = toMajorAmount(bucket.monthly_limit, decimalPlaces);
    const currency = bucket.currency ?? null;

    if (!bucket.is_enabled) {
        return {
            enabled: false,
            utilization: 0,
            balance: null,
            spentMajor,
            limitMajor,
        };
    }

    const utilization =
        bucket.utilization ??
        (spentMajor !== null && limitMajor !== null && limitMajor > 0 ? (spentMajor / limitMajor) * 100 : 0);

    const balance =
        spentMajor !== null || limitMajor !== null
            ? formatExtraUsageBalance({
                  spent: spentMajor,
                  limit: limitMajor,
                  currency,
                  decimalPlaces,
              })
            : null;

    return {
        enabled: true,
        utilization,
        balance,
        spentMajor,
        limitMajor,
    };
}

export function formatExtraUsageBalance({
    spent,
    limit,
    currency,
    decimalPlaces,
}: {
    spent: number | null;
    limit: number | null;
    currency: string | null;
    decimalPlaces: number;
}): string {
    const spentLabel = formatExtraUsageMoney(spent, currency, decimalPlaces);
    const limitLabel = formatExtraUsageMoney(limit, currency, decimalPlaces);

    return `${spentLabel}/${limitLabel}`;
}

function currencySymbol(currency: string | null): string {
    if (!currency) {
        return "€";
    }

    const code = currency.toUpperCase();

    if (code === "EUR") {
        return "€";
    }

    if (code === "USD") {
        return "$";
    }

    if (code === "GBP") {
        return "£";
    }

    return `${code} `;
}

function buildMeta(bucket: ExtraUsageBucket): {
    limit: number | null;
    currency: string | null;
    decimalPlaces: number;
    spentMajor: number | null;
    limitMajor: number | null;
} {
    const decimalPlaces = bucket.decimal_places ?? 2;
    const spentMajor = toMajorAmount(bucket.used_credits, decimalPlaces);
    const limitMajor = toMajorAmount(bucket.monthly_limit, decimalPlaces);

    return {
        limit: limitMajor,
        currency: bucket.currency ?? null,
        decimalPlaces,
        spentMajor,
        limitMajor,
    };
}

export function formatExtraUsageMessage({
    accountName,
    event,
}: {
    accountName: string;
    event: ExtraUsageNotifyEvent;
}): string {
    const balance = formatExtraUsageBalance({
        spent: event.toSpent,
        limit: event.limit,
        currency: event.currency,
        decimalPlaces: event.decimalPlaces,
    });

    if (event.reason === "EXTRA_ENABLED") {
        return `${accountName}: Extra usage enabled — ${balance}`;
    }

    if (event.reason === "EXTRA_DISABLED") {
        return `${accountName}: Extra usage disabled — ${balance}`;
    }

    const fromLabel = formatExtraUsageMoney(event.fromSpent, event.currency, event.decimalPlaces);
    const toLabel = formatExtraUsageMoney(event.toSpent, event.currency, event.decimalPlaces);
    const limitLabel = formatExtraUsageMoney(event.limit, event.currency, event.decimalPlaces);
    const elapsed =
        event.elapsedMs !== null && event.elapsedMs > 0
            ? ` (in ${formatDuration(event.elapsedMs, "ms", "hm-smart")})`
            : "";

    return `${accountName}: Extra usage ${fromLabel} -> ${toLabel}/${limitLabel}${elapsed}`;
}

export class ExtraUsageBucketTracker {
    private lastKnownEnabled: boolean | null = null;
    private lastKnownSpent: number | null = null;
    private lastKnownLimit: number | null = null;
    private lastKnownCurrency: string | null = null;
    private lastKnownDecimalPlaces: number | null = null;
    private lastNotifiedSpent: number | null = null;
    private lastNotifiedAt: number | null = null;

    private rememberActiveSnapshot(
        spentMajor: number | null,
        limitMajor: number | null,
        currency: string | null,
        decimalPlaces: number
    ): void {
        this.lastKnownSpent = spentMajor;
        this.lastKnownLimit = limitMajor;
        this.lastKnownCurrency = currency;
        this.lastKnownDecimalPlaces = decimalPlaces;
    }

    shouldNotify(bucket: ExtraUsageBucket, now = Date.now()): ExtraUsageNotifyEvent | null {
        const enabled = bucket.is_enabled;
        const { spentMajor, limitMajor, currency, decimalPlaces } = buildMeta(bucket);

        const prevEnabled = this.lastKnownEnabled;

        if (prevEnabled === true && !enabled) {
            const event: ExtraUsageNotifyEvent = {
                reason: "EXTRA_DISABLED",
                fromSpent: this.lastKnownSpent,
                toSpent: spentMajor ?? this.lastKnownSpent,
                limit: limitMajor ?? this.lastKnownLimit,
                currency: currency ?? this.lastKnownCurrency,
                decimalPlaces: decimalPlaces ?? this.lastKnownDecimalPlaces ?? 2,
                elapsedMs: null,
            };
            this.lastKnownEnabled = false;
            this.lastNotifiedSpent = null;
            this.lastNotifiedAt = null;
            return event;
        }

        if (prevEnabled === false && enabled) {
            this.lastKnownEnabled = true;
            this.rememberActiveSnapshot(spentMajor, limitMajor, currency, decimalPlaces);
            this.lastNotifiedSpent = spentMajor ?? 0;
            this.lastNotifiedAt = now;

            return {
                reason: "EXTRA_ENABLED",
                fromSpent: null,
                toSpent: spentMajor,
                limit: limitMajor,
                currency,
                decimalPlaces,
                elapsedMs: null,
            };
        }

        if (prevEnabled === null) {
            this.lastKnownEnabled = enabled;

            if (enabled) {
                this.rememberActiveSnapshot(spentMajor, limitMajor, currency, decimalPlaces);
                this.lastNotifiedSpent = spentMajor ?? 0;
                this.lastNotifiedAt = now;

                return {
                    reason: "EXTRA_ENABLED",
                    fromSpent: null,
                    toSpent: spentMajor,
                    limit: limitMajor,
                    currency,
                    decimalPlaces,
                    elapsedMs: null,
                };
            }

            return null;
        }

        if (!enabled) {
            return null;
        }

        if (spentMajor === null) {
            return null;
        }

        this.rememberActiveSnapshot(spentMajor, limitMajor, currency, decimalPlaces);

        if (this.lastNotifiedSpent === null) {
            this.lastNotifiedSpent = spentMajor;
            this.lastNotifiedAt = now;
            return null;
        }

        if (spentMajor >= this.lastNotifiedSpent + EXTRA_USAGE_SPEND_INCREMENT) {
            const event: ExtraUsageNotifyEvent = {
                reason: "EXTRA_SPEND",
                fromSpent: this.lastNotifiedSpent,
                toSpent: spentMajor,
                limit: limitMajor,
                currency,
                decimalPlaces,
                elapsedMs: this.lastNotifiedAt !== null ? now - this.lastNotifiedAt : null,
            };
            this.lastNotifiedSpent = spentMajor;
            this.lastNotifiedAt = now;
            return event;
        }

        return null;
    }

    restoreState(state: ExtraUsageTrackerState & { lastNotifiedPct?: number | null }): void {
        this.lastKnownEnabled = state.lastKnownEnabled ?? null;
        this.lastKnownSpent = state.lastKnownSpent ?? null;
        this.lastKnownLimit = state.lastKnownLimit ?? null;
        this.lastKnownCurrency = state.lastKnownCurrency ?? null;
        this.lastKnownDecimalPlaces = state.lastKnownDecimalPlaces ?? null;
        this.lastNotifiedSpent = state.lastNotifiedSpent ?? null;
        this.lastNotifiedAt = state.lastNotifiedAt ?? null;
    }

    getState(): ExtraUsageTrackerState {
        return {
            lastKnownEnabled: this.lastKnownEnabled,
            lastKnownSpent: this.lastKnownSpent,
            lastKnownLimit: this.lastKnownLimit,
            lastKnownCurrency: this.lastKnownCurrency,
            lastKnownDecimalPlaces: this.lastKnownDecimalPlaces,
            lastNotifiedSpent: this.lastNotifiedSpent,
            lastNotifiedAt: this.lastNotifiedAt,
        };
    }
}
