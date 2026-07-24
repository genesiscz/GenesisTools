import type { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { fetchOAuthProfile } from "@genesiscz/utils/claude/auth";
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";

/**
 * When a subscription's month rolls over. The anchor is the Stripe billing-cycle
 * start (`organization.subscription_created_at` from the OAuth profile), fetched
 * once per account and persisted forever — every later render is pure math.
 */

/** Accounts whose profile fetch failed this process; don't retry them every poll. */
const failedAnchors = new Set<string>();

/**
 * Backfill `subscriptionCreatedAt` for accounts that don't have it yet. One
 * profile fetch per missing account, persisted to the AI config; subsequent
 * calls are free. Never throws — a missing anchor only costs the renewal line.
 */
export async function ensureSubscriptionAnchors(config: AIConfig, accounts: AIAccountEntry[]): Promise<void> {
    const missing = accounts.filter((a) => !a.subscriptionCreatedAt && !failedAnchors.has(a.name));

    if (missing.length === 0) {
        return;
    }

    const fetched = await Promise.allSettled(
        missing.map(async (account) => {
            const { token } = await resolveAccountToken(account.name, {
                staleAccessToken: account.tokens.accessToken,
            });
            const profile = await fetchOAuthProfile(token);
            const createdAt = profile?.organization.subscription_created_at;

            if (!createdAt) {
                throw new Error("profile has no subscription_created_at");
            }

            return { name: account.name, createdAt };
        })
    );

    for (const [i, result] of fetched.entries()) {
        const account = missing[i];

        if (result.status === "rejected") {
            failedAnchors.add(account.name);
            logger.debug(`[subscription:${account.name}] anchor unavailable: ${result.reason}`);
            continue;
        }

        try {
            await config.updateAccount(account.name, { subscriptionCreatedAt: result.value.createdAt });
            logger.info(`[subscription:${account.name}] billing anchor stored (${result.value.createdAt})`);
        } catch (err) {
            failedAnchors.add(account.name);
            logger.warn(
                `[subscription:${account.name}] could not persist anchor: ${err instanceof Error ? err.message : err}`
            );
            continue;
        }

        // Mirror into the in-memory entry the caller is still holding.
        account.subscriptionCreatedAt = result.value.createdAt;
    }
}

/**
 * Next monthly renewal derived from the billing anchor: the subscription's
 * created day-of-month, first occurrence after `now`. Approximate (~) for
 * anchors past the 28th — Stripe clamps short months the same way.
 */
export function nextRenewalDate(subscriptionCreatedAt: string, now: Date = new Date()): Date | null {
    const created = new Date(subscriptionCreatedAt);

    if (!Number.isFinite(created.getTime())) {
        return null;
    }

    const anchorDay = created.getDate();

    // Seconds and milliseconds are preserved: truncating them makes a renewal
    // that is still seconds away look already-passed, which rolls the date to
    // next month.
    const candidate = (year: number, month: number): Date => {
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        return new Date(
            year,
            month,
            Math.min(anchorDay, daysInMonth),
            created.getHours(),
            created.getMinutes(),
            created.getSeconds(),
            created.getMilliseconds()
        );
    };

    const thisMonth = candidate(now.getFullYear(), now.getMonth());

    return thisMonth.getTime() > now.getTime() ? thisMonth : candidate(now.getFullYear(), now.getMonth() + 1);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Czech datetime: "16.08.2026 09:44". */
export function formatCzechDateTime(date: Date): string {
    return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Compact forward distance: "28d 21h", "5h 20m", "12m". */
export function formatRelativeSpan(from: Date, to: Date): string {
    const totalMinutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${Math.max(1, minutes)}m`;
}

/** Single-unit countdown: "28d" above a day, "7h" below it, "12m" in the last hour. */
export function formatCoarseSpan(from: Date, to: Date): string {
    const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));

    if (minutes >= 1440) {
        return `${Math.floor(minutes / 1440)}d`;
    }

    if (minutes >= 60) {
        return `${Math.floor(minutes / 60)}h`;
    }

    return `${Math.max(1, minutes)}m`;
}

/** "renews in 28d" — the compact form for headers. Null when no anchor is stored. */
export function formatRenewsAt(subscriptionCreatedAt: string | undefined, now: Date = new Date()): string | null {
    if (!subscriptionCreatedAt) {
        return null;
    }

    const next = nextRenewalDate(subscriptionCreatedAt, now);

    if (!next) {
        return null;
    }

    return `renews in ${formatCoarseSpan(now, next)}`;
}

/** "renews 16.08.2026 09:44 (in 28d 21h)" — the full form for detail zones. */
export function formatRenewsAtFull(subscriptionCreatedAt: string | undefined, now: Date = new Date()): string | null {
    if (!subscriptionCreatedAt) {
        return null;
    }

    const next = nextRenewalDate(subscriptionCreatedAt, now);

    if (!next) {
        return null;
    }

    return `renews ${formatCzechDateTime(next)} (in ${formatRelativeSpan(now, next)})`;
}
