import type { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { resolveAccountToken } from "@genesiscz/utils/claude/subscription-auth";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger } from "@genesiscz/utils/logger";
import {
    blockedEntry,
    loadPollGate,
    type PollGate,
    applyPollGateOutcomes,
    pruneGate,
} from "./poll-gate";
import { isAnchorDue, planAllowsClaudeCode, refreshSubscriptionProfile } from "./subscription";

export type { AccountInfo, KeychainCredentials } from "@genesiscz/utils/claude/auth";

export class RetryableApiError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.name = "RetryableApiError";
        this.statusCode = statusCode;
    }
}

/**
 * The account was not polled at all: its plan cannot run Claude Code, or it is
 * inside a failure backoff. Distinct from a fetch failure because it must NOT
 * count as one — counting a skip as a failure would ratchet the backoff up
 * forever without a single request ever being sent.
 */
export class PollSuppressedError extends Error {
    /** Epoch ms of the next attempt, or 0 when recovery is plan-driven. */
    readonly retryAt: number;

    constructor(reason: string, retryAt = 0) {
        super(reason);
        this.name = "PollSuppressedError";
        this.retryAt = retryAt;
    }
}

/** The usage API's org-level 403 — the subscription behind this login is gone. */
const SUBSCRIPTION_EXPIRED_ERROR_RE = /not allowed for this org/i;

export function isSubscriptionExpiredError(error: string | undefined): boolean {
    return error !== undefined && SUBSCRIPTION_EXPIRED_ERROR_RE.test(error);
}

/**
 * Accounts a cached poll found org-blocked, by name. Checks the sticky flag
 * first, then both places an error string can hide: the live error and the
 * stale-backfill reason (shared-cache replays the last good usage and moves
 * the error into `stale.reason`).
 */
export function orgBlockedAccounts(accounts: AccountUsage[] | undefined): Set<string> {
    const blocked = new Set<string>();

    for (const account of accounts ?? []) {
        if (
            account.orgBlocked ||
            isSubscriptionExpiredError(account.error) ||
            isSubscriptionExpiredError(account.stale?.reason)
        ) {
            blocked.add(account.accountName);
        }
    }

    return blocked;
}

export interface UsageBucket {
    utilization: number;
    resets_at: string | null;
}

export interface ExtraUsageBucket {
    is_enabled: boolean;
    monthly_limit: number | null;
    used_credits: number | null;
    utilization: number | null;
    currency?: string | null;
    decimal_places?: number | null;
    disabled_reason?: string | null;
}

export interface ApiLimitScope {
    model: { id: string | null; display_name: string | null } | null;
    surface: string | null;
}

export interface ApiLimit {
    kind: string;
    group?: string;
    percent: number;
    severity: string;
    resets_at: string | null;
    scope: ApiLimitScope | null;
    is_active: boolean;
}

export interface ApiSpendMoney {
    amount_minor: number;
    currency: string;
    exponent: number;
}

export interface ApiSpend {
    used: ApiSpendMoney | null;
    limit: ApiSpendMoney | null;
    percent: number;
    severity: string;
    enabled: boolean;
    disabled_reason?: string | null;
    cap: { money: ApiSpendMoney | null; credits: unknown | null } | null;
    balance?: unknown | null;
    auto_reload?: unknown | null;
}

export interface UsageResponse {
    five_hour: UsageBucket;
    seven_day: UsageBucket;
    seven_day_opus?: UsageBucket | null;
    seven_day_sonnet?: UsageBucket | null;
    seven_day_oauth_apps?: UsageBucket | null;
    extra_usage?: ExtraUsageBucket | null;
    limits?: ApiLimit[];
    spend?: ApiSpend | null;
    member_dashboard_available?: boolean;
    [key: string]: unknown;
}

export interface AccountStaleInfo {
    /** Epoch ms of the successful fetch that produced the attached `usage`. */
    lastSuccessAt: number;
    /** Why live data is unavailable (per-account fetch error, lock timeout, …). */
    reason: string;
}

export interface AccountUsage {
    accountName: string;
    label?: string;
    /** Stripe billing-cycle anchor (ISO) — renders as the next renewal date. */
    subscriptionCreatedAt?: string;
    /**
     * `organization_type` from the OAuth profile. A free org cannot run Claude
     * Code even while its usage buckets look healthy, so this is carried into
     * scoring alongside the buckets.
     */
    subscriptionPlan?: string;
    /** `subscription_status` from the OAuth profile ("active", "canceled", …). */
    subscriptionStatus?: string;
    /** Refresh-grant expiry (Unix ms) — past this the account needs a browser re-login. */
    refreshExpiresAt?: number;
    usage?: UsageResponse;
    error?: string;
    /**
     * Present when `usage` is served from an older successful fetch because the
     * live fetch failed. Consumers should render the data with a staleness
     * indicator instead of hiding it; writers (history DB, notifications) must
     * skip stale entries.
     */
    stale?: AccountStaleInfo;
    /**
     * The usage API answered with the org-level 403 for this account: the
     * subscription behind the login is gone. STICKY across polls that end in
     * 401/429, because a dead org answers inconsistently and inferring the
     * block from the last error alone would let a single 429 erase it (and
     * re-arm the force-refresh below). Cleared by a successful fetch.
     */
    orgBlocked?: boolean;
}

export function isUsageBucket(value: unknown): value is UsageBucket {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    return "resets_at" in value;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export async function fetchUsage(
    accessToken: string,
    signal?: AbortSignal,
    accountHint?: string
): Promise<UsageResponse> {
    const tag = accountHint ? `[usage:${accountHint}]` : "[usage]";

    logger.debug(`${tag} fetching ${USAGE_URL}`);

    const res = await fetch(USAGE_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "anthropic-beta": "oauth-2025-04-20",
            Accept: "application/json",
        },
        signal,
    });

    if (res.status === 401 || res.status === 429) {
        const body = await res.text().catch(() => "");

        // 429 is routine under shared polling — debug keeps it out of consoles.
        if (res.status === 429) {
            logger.debug(`${tag} 429 rate-limited: ${body.slice(0, 200)}`);
        } else {
            logger.warn(`${tag} 401 auth failed: ${body.slice(0, 200)}`);
        }

        throw new RetryableApiError(res.status, `Usage API ${res.status}: ${body.slice(0, 200)}`);
    }

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        logger.error(`${tag} HTTP ${res.status}: ${body.slice(0, 200)}`);
        throw new Error(`Usage API ${res.status}: ${body.slice(0, 200)}`);
    }

    logger.debug(`${tag} OK (${res.status})`);
    return res.json() as Promise<UsageResponse>;
}

export interface FetchAllAccountsOptions {
    accountFilter?: string | string[];
    signal?: AbortSignal;
    /**
     * Accounts the last poll found org-blocked. Their 403 is a subscription
     * fact, not a token fact: a freshly minted token draws the identical 403,
     * so the 401/429 force-refresh retry must be skipped for them. Otherwise
     * every poll that happens to draw a 429 burns a single-use refresh token.
     * A plain fetch is still attempted, so a renewed subscription recovers on
     * the next poll with no intervention.
     */
    orgBlocked?: ReadonlySet<string>;
}

/** The account fields every result row carries, fetched or not. */
function identityOf(account: AIAccountEntry) {
    return {
        accountName: account.name,
        label: account.label,
        subscriptionCreatedAt: account.subscriptionCreatedAt,
        subscriptionPlan: account.subscriptionPlan,
        subscriptionStatus: account.subscriptionStatus,
        refreshExpiresAt: account.tokens.refreshExpiresAt,
    };
}

function planReason(account: AIAccountEntry): string {
    return `plan is ${account.subscriptionPlan ?? "unknown"} (${account.subscriptionStatus ?? "unknown"}) — Claude Code needs a paid subscription`;
}

interface PollAccountArgs {
    account: AIAccountEntry;
    config: AIConfig;
    gate: PollGate;
    now: number;
    signal?: AbortSignal;
    orgBlocked?: ReadonlySet<string>;
}

/**
 * One account's poll, including the two gates that decide whether it is polled
 * at all:
 *
 *  1. a failure backoff (persisted, so it survives the per-minute daemon
 *     process) skips EVERYTHING — no token resolve, no profile read, no usage
 *     request;
 *  2. a plan the OAuth profile says cannot run Claude Code skips the usage
 *     request but still allows the 6-hourly profile re-read, because that read
 *     is the only way a renewed subscription is ever noticed.
 */
async function pollAccount(args: PollAccountArgs): Promise<AccountUsage> {
    const { account, config, gate, now, signal } = args;
    const tag = `[usage:${account.name}]`;

    const blocked = blockedEntry(gate, account.name, now);

    if (blocked) {
        throw new PollSuppressedError(blocked.reason, blocked.blockedUntil);
    }

    const anchorDue = isAnchorDue(account, now);

    if (!planAllowsClaudeCode(account) && !anchorDue) {
        throw new PollSuppressedError(planReason(account));
    }

    // ONE token resolve per account per poll. The profile read used to resolve
    // its own, which doubled every refresh attempt for dead-grant accounts.
    const { token, refreshed: tokenRefreshed } = await resolveAccountToken(account.name, {
        staleAccessToken: account.tokens.accessToken,
    });

    if (tokenRefreshed) {
        logger.debug(`${tag} token was refreshed before fetch`);
    }

    if (anchorDue) {
        // Mutates `account` in place on success, so the plan check below sees
        // the fresh reading — this is the recovery path for a renewed plan.
        await refreshSubscriptionProfile(config, account, token, now);
    }

    if (!planAllowsClaudeCode(account)) {
        throw new PollSuppressedError(planReason(account));
    }

    try {
        const usage = await fetchUsage(token, signal, account.name);
        return { ...identityOf(account), usage } satisfies AccountUsage;
    } catch (err) {
        if (!(err instanceof RetryableApiError) || args.orgBlocked?.has(account.name)) {
            logger.debug(`${tag} fetch failed: ${err instanceof Error ? err.message : err}`);
            throw err;
        }

        // The usage endpoint allows exactly 5 requests per access token
        // (verified empirically 2026-07-11: fresh token = 5x 200 then 429,
        // no refill, strictly per-token). Rotating the token on 429 is the
        // intended unlock — resolveAccountToken's on-disk staleAccessToken
        // check keeps concurrent consumers to one rotation per exhausted
        // token. 401 (token rejected) takes the same path.
        logger.debug(`${tag} got ${err.statusCode}, attempting force-refresh`);

        let freshToken: string;
        let refreshed: boolean;

        try {
            ({ token: freshToken, refreshed } = await resolveAccountToken(account.name, {
                staleAccessToken: token,
                forceRefresh: true,
            }));
        } catch (refreshErr) {
            // A dead refresh token (invalid_grant / cooldown) must not
            // upgrade a routine 429 into a hard auth error — the access
            // token can still land requests once another consumer rotates
            // it. Keep the original status as the account error and carry
            // the refresh failure as context.
            const detail = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
            logger.debug(`${tag} token refresh after ${err.statusCode} failed: ${detail}`);
            throw new RetryableApiError(err.statusCode, `${err.message} (token refresh failed: ${detail})`);
        }

        if (!refreshed) {
            logger.debug(`${tag} force-refresh did not produce a new token, re-throwing ${err.statusCode}`);
            throw err;
        }

        logger.debug(`${tag} retrying with refreshed token`);
        const usage = await fetchUsage(freshToken, signal, account.name);
        return { ...identityOf(account), usage } satisfies AccountUsage;
    }
}

export async function fetchAllAccountsUsage(opts: FetchAllAccountsOptions = {}): Promise<AccountUsage[]> {
    const { accountFilter, signal } = opts;
    const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");
    const config = await AIConfig.load();
    let accounts = config.getAccountsByProvider("anthropic-sub");

    if (typeof accountFilter === "string") {
        accounts = accounts.filter((a) => a.name === accountFilter);
    } else if (Array.isArray(accountFilter)) {
        const filterSet = new Set(accountFilter);
        accounts = accounts.filter((a) => filterSet.has(a.name));
    }

    // Logged-out accounts (no OAuth pair — e.g. after `tools claude logout`)
    // are invisible to polling: they can't fetch usage and would only render
    // permanent error rows.
    const loggedOut = accounts.filter((a) => !a.tokens.accessToken && !a.tokens.refreshToken);
    if (loggedOut.length > 0) {
        logger.debug(`[usage] skipping logged-out account(s): ${loggedOut.map((a) => a.name).join(", ")}`);
        accounts = accounts.filter((a) => a.tokens.accessToken || a.tokens.refreshToken);
    }

    if (accounts.length === 0) {
        return [];
    }

    logger.debug(`[usage] polling ${accounts.length} account(s): ${accounts.map((a) => a.name).join(", ")}`);

    const now = Date.now();
    const storedGate = await loadPollGate();
    // Pruning is only safe on an UNFILTERED poll: a filtered one knows nothing
    // about the accounts it excluded and would wipe their backoff.
    const gate =
        accountFilter === undefined
            ? pruneGate(
                  storedGate,
                  accounts.map((a) => a.name)
              )
            : storedGate;
    // A prune that dropped entries is itself a reason to rewrite the file.
    let gateDirty = Object.keys(gate).length !== Object.keys(storedGate).length;

    const results = await Promise.allSettled(
        accounts.map((account: AIAccountEntry) =>
            pollAccount({ account, config, gate, now, signal, orgBlocked: opts.orgBlocked })
        )
    );

    const gateSuccesses: string[] = [];
    const gateFailures: Array<{ account: string; reason: string }> = [];

    const usages = results.map((r, i) => {
        const account = accounts[i];

        if (r.status === "fulfilled") {
            if (gate[account.name]) {
                gateSuccesses.push(account.name);
                gateDirty = true;
            }

            return r.value;
        }

        const suppressed = r.reason instanceof PollSuppressedError;
        const reason = suppressed ? suppressedReason(r.reason) : String(r.reason);

        if (suppressed) {
            logger.debug(`[usage:${account.name}] not polled: ${reason}`);
        } else {
            gateFailures.push({ account: account.name, reason: String(r.reason) });
            gateDirty = true;

            // Only the FIRST failure in a streak is worth a console line. After
            // that the backoff is doing its job and repeating the same error
            // every minute just pollutes whatever TUI happens to be running.
            const repeat = (gate[account.name]?.failures ?? 0) > 0;
            const line = `[usage:${account.name}] fetch failed: ${reason}`;

            if (repeat) {
                logger.debug(line);
            } else {
                logger.error(line);
            }
        }

        return {
            ...identityOf(account),
            error: reason,
            orgBlocked: isSubscriptionExpiredError(reason) || opts.orgBlocked?.has(account.name),
        } satisfies AccountUsage;
    });

    if (gateDirty) {
        await applyPollGateOutcomes({
            successes: gateSuccesses,
            failures: gateFailures,
            now,
            knownAccounts: accountFilter === undefined ? accounts.map((a) => a.name) : undefined,
        });
    }

    return usages;
}

function suppressedReason(err: PollSuppressedError): string {
    if (err.retryAt <= 0) {
        return err.message;
    }

    return `${err.message} (paused until ${new Date(err.retryAt).toISOString()})`;
}
