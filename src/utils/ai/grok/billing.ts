import type { GrokBillingConfig } from "./types";

export function formatBillingSummary(config: GrokBillingConfig): string {
    const used = (config.used.val ?? 0) / 100;
    const limit = (config.monthlyLimit.val ?? 0) / 100;
    const pct = limit > 0 ? ((used / limit) * 100).toFixed(1) : "0.0";

    return `$${used.toFixed(2)} / $${limit.toFixed(2)} (${pct}%)`;
}

export function billingPeriodRemaining(endIso: string, now = new Date()): number {
    const end = new Date(endIso);
    const endMs = end.getTime();

    if (!Number.isFinite(endMs)) {
        return 0;
    }

    const diffMs = endMs - now.getTime();

    if (diffMs <= 0) {
        return 0;
    }

    return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}
