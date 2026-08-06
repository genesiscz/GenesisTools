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
 * How long a stored plan reading stays trusted. A subscription can lapse at any
 * time and nothing else reports it: a free org keeps serving healthy-looking
 * usage buckets while every inference call answers 403
 * `oauth_not_allowed_for_organization` (observed on 5 accounts, 2026-08-06).
 */
export const SUBSCRIPTION_RECHECK_MS = 6 * 60 * 60 * 1000;

/** Org types that cannot run Claude Code — inference is blocked at the org level. */
const UNUSABLE_PLANS = new Set(["claude_free"]);

/**
 * Whether the account's plan still permits Claude Code. Unknown plans (never
 * checked, profile unreachable) count as usable: a launch gate must never
 * block on missing data.
 */
export function planAllowsClaudeCode(entry: { subscriptionPlan?: string; subscriptionStatus?: string }): boolean {
    if (entry.subscriptionPlan && UNUSABLE_PLANS.has(entry.subscriptionPlan)) {
        return false;
    }

    return entry.subscriptionStatus !== "canceled";
}

/**
 * Backfill the billing anchor and the plan fields from the OAuth profile. The
 * anchor is fetched once and kept forever; the plan is re-read every
 * SUBSCRIPTION_RECHECK_MS, because a lapsed subscription is otherwise invisible
 * until an inference call fails. Never throws — a failed read only costs the
 * renewal line and leaves the previous plan reading in place.
 */
export async function ensureSubscriptionAnchors(config: AIConfig, accounts: AIAccountEntry[]): Promise<void> {
    const now = Date.now();
    const due = accounts.filter(
        (a) =>
            !failedAnchors.has(a.name) &&
            (!a.subscriptionCreatedAt ||
                !a.subscriptionCheckedAt ||
                now - a.subscriptionCheckedAt > SUBSCRIPTION_RECHECK_MS)
    );

    if (due.length === 0) {
        return;
    }

    const fetched = await Promise.allSettled(
        due.map(async (account) => {
            const { token } = await resolveAccountToken(account.name, {
                staleAccessToken: account.tokens.accessToken,
            });
            const profile = await fetchOAuthProfile(token);

            if (!profile) {
                throw new Error("profile unavailable");
            }

            return {
                name: account.name,
                createdAt: profile.organization.subscription_created_at,
                plan: profile.organization.organization_type,
                status: profile.organization.subscription_status,
            };
        })
    );

    for (const [i, result] of fetched.entries()) {
        const account = due[i];

        if (result.status === "rejected") {
            failedAnchors.add(account.name);
            logger.debug(`[subscription:${account.name}] profile unavailable: ${result.reason}`);
            continue;
        }

        const patch = {
            // A missing anchor must not erase the stored one.
            subscriptionCreatedAt: result.value.createdAt || account.subscriptionCreatedAt,
            subscriptionPlan: result.value.plan,
            subscriptionStatus: result.value.status,
            subscriptionCheckedAt: now,
        };

        try {
            await config.updateAccount(account.name, patch);
            logger.info(
                `[subscription:${account.name}] plan ${patch.subscriptionPlan ?? "unknown"} (${patch.subscriptionStatus ?? "unknown"}), anchor ${patch.subscriptionCreatedAt ?? "unknown"}`
            );
        } catch (err) {
            failedAnchors.add(account.name);
            logger.warn(
                `[subscription:${account.name}] could not persist profile: ${err instanceof Error ? err.message : err}`
            );
            continue;
        }

        // Mirror into the in-memory entry the caller is still holding.
        Object.assign(account, patch);
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
