import type { AccountUsageSnapshot, UsagePresenters } from "@genesiscz/utils/ai/providers/account-features";
import type { UsageDashboardConfig } from "@genesiscz/utils/ai/usage-poll/dashboard-config";
import type { UsageLimitsDb } from "@genesiscz/utils/ai/usage-poll/limits-db";
import type { ComponentType } from "react";

export interface TabDefinition {
    id: string;
    label: string;
    /** Digit or letter shown in the tab bar and accepted by the tab navigation hook. */
    shortcut: string;
}

/** The minimum an account row needs before its first poll lands. */
export interface UsageAccountRef {
    id: string;
    name: string;
    provider: string;
    label?: string;
}

/**
 * Everything the dashboard shell needs, and nothing provider-specific (spec 7.2).
 * `tools ai usage` builds it from every provider; `tools claude usage` pins
 * `providers: ["anthropic-sub"]` and adds the Sessions tab.
 */
export interface UsageDataSource {
    /** Plugin ids the dashboard is pinned to. Empty means every provider. */
    providers: string[];
    poll(opts: { force?: boolean; accountFilter?: string[] }): Promise<AccountUsageSnapshot[]>;
    /** Re-read on every poll, so an account renamed in another terminal shows up. */
    accounts(): Promise<UsageAccountRef[]>;
    limitsDb: UsageLimitsDb | null;
    config: UsageDashboardConfig;
    /** By plugin id. A provider without a presenter renders the generic bars. */
    presenters: Record<string, UsagePresenters | undefined>;
    extraTabs?: Array<TabDefinition & { View: ComponentType<Record<string, never>> }>;
}

/** One completed poll round, as the views consume it. */
export interface PollState {
    accounts: AccountUsageSnapshot[];
    timestamp: Date;
    /** Set when the whole round failed; the previous accounts stay on screen. */
    error?: string;
}

/** Time ranges the History tab and the filter bar cycle through, in minutes. */
export const TIME_RANGES = [60, 360, 1440, 10_080] as const;

export type TimeRange = (typeof TIME_RANGES)[number];

export function formatTimeRange(minutes: number): string {
    if (minutes <= 60) {
        return `${minutes}m`;
    }

    if (minutes <= 1440) {
        return `${minutes / 60}h`;
    }

    return `${minutes / 1440}d`;
}
