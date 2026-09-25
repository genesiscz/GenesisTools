import type { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { probeTokenOrg } from "@genesiscz/utils/claude/account-fingerprint";
import { fetchOAuthProfile } from "@genesiscz/utils/claude/auth";
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";

/**
 * `organization.subscription_created_at` is when the subscription was first
 * created. It is not the current charge date: a plan change moves Stripe's
 * billing anchor and this field stays put. Observed on one account, 2026-09-24 —
 * created 2024-09-24, Pro invoices on the 24th, Max invoices on the 7th, and
 * the billing page says the next charge is 2026-10-07. The OAuth profile has
 * no period end, so a countdown from the created day is a guess.
 */

/**
 * When each account's profile fetch last failed, NOT a permanent blocklist.
 *
 * A `Set` here suppressed the account for the life of the process, so in a long-running
 * poller one transient network blip disabled the six-hourly plan re-read forever — and
 * `config refresh` could not undo it either, because clearing `subscriptionCheckedAt`
 * does not touch this. Failures now expire.
 */
const anchorFailures = new Map<string, number>();

/** How long a failed profile read suppresses retries. Short: the recheck window is 6h. */
const ANCHOR_RETRY_BACKOFF_MS = 30 * 60 * 1000;

function markAnchorFailure(name: string, now: number = Date.now()): void {
    anchorFailures.set(name, now);
}

/** Drop the backoff so the next poll retries immediately (a login/refresh changed the facts). */
export function clearAnchorFailure(name: string): void {
    anchorFailures.delete(name);
}

function anchorFailureIsFresh(name: string, now: number): boolean {
    const failedAt = anchorFailures.get(name);

    return failedAt !== undefined && now - failedAt < ANCHOR_RETRY_BACKOFF_MS;
}

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
export function planAllowsClaudeCode(entry: {
    subscriptionPlan?: string;
    subscriptionStatus?: string;
    subscriptionCheckedAt?: number;
    planContradictedAt?: number;
}): boolean {
    // Evidence beats a stale reading. A live probe that saw the org still
    // permitting OAuth contradicts a stored "free/canceled", and an account whose
    // OAuth grant is dead can NEVER refresh that reading — so without this the
    // stale verdict is self-sustaining and survives a renewal forever.
    if (entry.planContradictedAt && entry.planContradictedAt > (entry.subscriptionCheckedAt ?? 0)) {
        return true;
    }

    if (entry.subscriptionPlan && UNUSABLE_PLANS.has(entry.subscriptionPlan)) {
        return false;
    }

    return entry.subscriptionStatus !== "canceled";
}

/**
 * Whether this account's stored profile reading is old enough to re-read. An account
 * that failed RECENTLY is not due — retrying a broken login on every poll is what the
 * backoff exists to avoid — but the suppression expires, so a transient failure costs
 * one backoff window rather than the rest of the process's life.
 */
export function isAnchorDue(
    account: Pick<AIAccountEntry, "name" | "subscriptionCreatedAt" | "subscriptionCheckedAt">,
    now: number = Date.now()
): boolean {
    if (anchorFailureIsFresh(account.name, now)) {
        return false;
    }

    if (!account.subscriptionCreatedAt || !account.subscriptionCheckedAt) {
        return true;
    }

    return now - account.subscriptionCheckedAt > SUBSCRIPTION_RECHECK_MS;
}

/**
 * Read the OAuth profile with a token the caller ALREADY resolved, and persist
 * the anchor plus the plan fields. Taking the token as an argument is the whole
 * point: the poller resolves each account's token exactly once per run, and a
 * second independent `resolveAccountToken` here used to double every refresh
 * attempt (2,162 refresh initiations for two dead-grant accounts on
 * 2026-08-08, against 1,082 polls).
 *
 * Never throws — a failed read only costs the renewal line and leaves the
 * previous plan reading in place. Returns whether the account was updated.
 */
export async function refreshSubscriptionProfile(
    config: AIConfig,
    account: AIAccountEntry,
    token: string,
    now: number = Date.now()
): Promise<boolean> {
    const profile = await fetchOAuthProfile(token);

    if (!profile) {
        markAnchorFailure(account.name, now);
        logger.debug(`[subscription:${account.name}] profile unavailable`);
        return false;
    }

    const status = profile.organization.subscription_status;
    const patch = {
        // A missing anchor must not erase the stored one.
        subscriptionCreatedAt: profile.organization.subscription_created_at || account.subscriptionCreatedAt,
        subscriptionPlan: profile.organization.organization_type,
        subscriptionStatus: status,
        subscriptionCheckedAt: now,
        // The profile stamp never moves when a lapsed sub is bought again.
        // The flip we just watched is the only new cycle the API will admit.
        ...(reactivated(account.subscriptionStatus, status)
            ? { subscriptionReactivatedAt: new Date(now).toISOString() }
            : {}),
        // Backfill the identity fingerprint on every profile read. Without this an
        // account keeps no org uuid until its next full re-login, and `login-long`
        // has nothing to compare a pasted setup token against.
        accountUuid: profile.account.uuid || account.accountUuid,
        organizationUuid: profile.organization.uuid || account.organizationUuid,
    };

    try {
        await config.updateAccount(account.name, patch);
        logger.info(
            `[subscription:${account.name}] plan ${patch.subscriptionPlan ?? "unknown"} (${patch.subscriptionStatus ?? "unknown"}), anchor ${patch.subscriptionCreatedAt ?? "unknown"}`
        );
    } catch (err) {
        markAnchorFailure(account.name, now);
        logger.warn(
            `[subscription:${account.name}] could not persist profile: ${err instanceof Error ? err.message : err}`
        );
        return false;
    }

    // Mirror into the in-memory entry the caller is still holding.
    Object.assign(account, patch);
    clearAnchorFailure(account.name);
    return true;
}

/**
 * Retire a dead-plan reading that the evidence contradicts.
 *
 * The trap this closes: a stored "claude_free (canceled)" is only ever refreshed
 * by a profile read, and a profile read needs a live OAuth grant. So an account
 * whose refresh token died keeps asserting "plan expired" FOREVER — straight
 * through a renewal — because the one mechanism that could correct it is the very
 * thing that is broken. Observed on a live account 2026-08-29: renewed hours
 * earlier, still rendered as an expired free account.
 *
 * The long-lived setup token is the way out. It cannot read the profile (inference
 * scope only), but `probeTokenOrg` proves whether the ORG still permits OAuth,
 * and a live org cannot be the dead free org the stored fields describe. That is
 * not enough to NAME the new plan, so the reading is not overwritten with a guess:
 * `planContradictedAt` records that evidence was seen against it, and
 * `planAllowsClaudeCode` stops trusting it from then on.
 *
 * Never throws — a failed probe leaves the stored reading exactly as it was.
 */
export async function revalidateStalePlan(
    config: AIConfig,
    account: AIAccountEntry,
    now: number = Date.now()
): Promise<"alive" | "dead" | "unknown"> {
    const token = account.tokens.longLivedToken;

    if (!token) {
        return "unknown";
    }

    const print = await probeTokenOrg(token);

    if (print.verdict === "org-dead") {
        logger.debug(`[subscription:${account.name}] long-lived probe confirms the org is dead`);
        return "dead";
    }

    if (print.verdict !== "ok") {
        logger.debug(`[subscription:${account.name}] long-lived probe inconclusive (${print.verdict})`);
        return "unknown";
    }

    const patch = {
        planContradictedAt: now,
        organizationUuid: print.organizationUuid ?? account.organizationUuid,
    };

    try {
        await config.updateAccount(account.name, patch);
    } catch (err) {
        logger.warn(
            `[subscription:${account.name}] could not record the plan contradiction: ${err instanceof Error ? err.message : err}`
        );
        return "unknown";
    }

    Object.assign(account, patch);
    clearAnchorFailure(account.name);
    logger.info(
        `[subscription:${account.name}] org ${print.organizationUuid ?? "unknown"} is ALIVE — the stored ` +
            `"${account.subscriptionPlan ?? "unknown"} (${account.subscriptionStatus ?? "unknown"})" reading is ` +
            `contradicted; re-login to read the real plan (tools claude login ${account.name})`
    );
    return "alive";
}

/**
 * Backfill the billing anchor and the plan fields for a whole set of accounts,
 * resolving each token here. Used by `tools claude config refresh`; the poller
 * calls `refreshSubscriptionProfile` with its own token instead.
 */
export async function ensureSubscriptionAnchors(
    config: AIConfig,
    accounts: AIAccountEntry[],
    opts: { force?: boolean } = {}
): Promise<void> {
    const now = Date.now();

    // `config refresh` is a deliberate user action: it re-reads even an account whose
    // last attempt failed, which is exactly when someone reaches for it.
    if (opts.force) {
        for (const account of accounts) {
            clearAnchorFailure(account.name);
        }
    }

    const due = accounts.filter((a) => isAnchorDue(a, now));

    if (due.length === 0) {
        return;
    }

    await Promise.allSettled(
        due.map(async (account) => {
            try {
                const { token } = await resolveAccountToken(account.name, {
                    staleAccessToken: account.tokens.accessToken,
                });
                await refreshSubscriptionProfile(config, account, token, now);
            } catch (err) {
                markAnchorFailure(account.name, now);
                logger.debug(`[subscription:${account.name}] token unavailable for profile read: ${err}`);
            }
        })
    );
}

/** A profile check that watched a subscription come back to life. */
export function reactivated(previousStatus: string | undefined, nextStatus: string | undefined): boolean {
    return nextStatus === "active" && previousStatus !== undefined && previousStatus !== "active";
}

/**
 * The day the current cycle is anchored to. A hand-set override wins, then a
 * reactivation we watched, then the profile's original signup. Same precedence
 * as claude-switcheroo: the profile endpoint has no period end, so a plan
 * change that moved the charge day can only be corrected by hand.
 */
export function billingAnchor(account: {
    subscriptionAnchorOverride?: string;
    subscriptionCreatedAt?: string;
    subscriptionReactivatedAt?: string;
}): string | undefined {
    if (account.subscriptionAnchorOverride) {
        return account.subscriptionAnchorOverride;
    }

    const created = account.subscriptionCreatedAt;
    const cameBack = account.subscriptionReactivatedAt;

    if (!created || !cameBack) {
        return created ?? cameBack;
    }

    return Date.parse(cameBack) > Date.parse(created) ? cameBack : created;
}

/**
 * Next monthly renewal derived from the billing anchor: the subscription's
 * created day-of-month, first occurrence after `now`. Approximate (~) for
 * anchors past the 28th — Stripe clamps short months the same way.
 */
export function nextRenewalDate(subscriptionCreatedAt: string, now: Date = new Date()): Date | null {
    // A date-only value (`2026-07-07`: what `tools claude anchor` stores, and the projected
    // `renewsAt`) is a calendar day, read in THIS machine's zone and lasting until its end. An
    // instant would be the 7th in Tokyo and the 6th in California; the day is the 7th everywhere,
    // and a charge due today is still today's, not next month's, in the afternoon.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(subscriptionCreatedAt);
    const created = dateOnly
        ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59, 999)
        : new Date(subscriptionCreatedAt);

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

/**
 * A date as the calendar day it is HERE (`2026-10-07`). The projected renewal is stored in this
 * form, so a snapshot written in Tokyo does not read as the day before in Los Angeles.
 */
export function calendarDay(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

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

/** Shown once the projected charge is inside a week. Farther out stays the dim `ends ~dd.mm`. */
export const PLAN_RENEWAL_WARNING_MS = 7 * 24 * 3_600_000;

function czechDayMonth(date: Date): string {
    const day = String(date.getDate()).padStart(2, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `${day}.${month}`;
}

/**
 * "⚠ plan ends ~07.10 (in ~6d)" during the last week of the projected cycle.
 * The `~` is load-bearing: this is a day-of-month projection, not a date the
 * API returned. Null when there is no anchor or the charge is farther out.
 */
export function planRenewalWarning(anchor: string | undefined, now: Date = new Date()): string | null {
    if (!anchor) {
        return null;
    }

    const next = nextRenewalDate(anchor, now);

    if (!next) {
        return null;
    }

    const ms = next.getTime() - now.getTime();

    if (ms <= 0 || ms > PLAN_RENEWAL_WARNING_MS) {
        return null;
    }

    return `⚠ plan ends ~${czechDayMonth(next)} (in ~${formatCoarseSpan(now, next)})`;
}

/** "ends ~07.10" — the compact projection. Null when no anchor is stored. */
export function formatRenewsAt(anchor: string | undefined, now: Date = new Date()): string | null {
    if (!anchor) {
        return null;
    }

    const next = nextRenewalDate(anchor, now);

    if (!next) {
        return null;
    }

    return `ends ~${czechDayMonth(next)}`;
}

/** "ends ~07.10.2026 (in ~13d)" — the full projection for a detail line. */
export function formatRenewsAtFull(anchor: string | undefined, now: Date = new Date()): string | null {
    if (!anchor) {
        return null;
    }

    const next = nextRenewalDate(anchor, now);

    if (!next) {
        return null;
    }

    return `ends ~${czechDayMonth(next)}.${next.getFullYear()} (in ~${formatCoarseSpan(now, next)})`;
}
