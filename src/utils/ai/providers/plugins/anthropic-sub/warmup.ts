import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import {
    snapshotOfAccount,
    type WarmupContext,
    WarmupFailure,
    type WarmupOutcome,
} from "@genesiscz/utils/ai/providers/account-features";
import type { Cached } from "@genesiscz/utils/ai/usage-poll/shared-cache";
import { snapshotsCacheKey, USAGE_CACHE_TTL, usagePollStorage } from "@genesiscz/utils/ai/usage-poll/storage";
import type { AccountUsageSnapshot } from "@genesiscz/utils/ai/usage-poll/types";
import {
    longLivedTokenUsable,
    sendLongLivedInferencePing,
    type TokenVerdict,
} from "@genesiscz/utils/claude/token-verify";
import { claudeLoginCommand, claudeLoginLongCommand } from "@genesiscz/utils/genesis-tools/tools/ai";
import { logger } from "@genesiscz/utils/logger";
import { ANTHROPIC_SUB, type UsageResponse } from "./api";
import { describeAnthropicFailure } from "./failure";
import { fiveHourState } from "./limits";
import { previousUsageOf } from "./usage";

export interface LongLivedTokens {
    longLivedToken?: string;
    longLivedTokenExpiresAt?: number;
}

export interface AnthropicWarmupDeps {
    /** Plaintext long-lived token for the account (the vault read), or nothing. */
    loadLongLived?: (accountName: string) => Promise<LongLivedTokens | undefined>;
    sendLongLived?: (token: string) => Promise<TokenVerdict>;
    /** The account's last cached reading (read-only), to skip a warmup that has nothing to start. */
    lastUsage?: (account: AccountEntry) => Promise<UsageResponse | undefined>;
}

/**
 * Matched by the account's id, never by its name alone: a replacement account that reused the name of a
 * deleted one would inherit its absent 5-hour window and running weekly reset, and send nothing for days.
 */
async function defaultLastUsage(account: AccountEntry): Promise<UsageResponse | undefined> {
    const cached = await usagePollStorage().getCacheFile<Cached<AccountUsageSnapshot>>(
        snapshotsCacheKey(ANTHROPIC_SUB),
        USAGE_CACHE_TTL
    );
    return previousUsageOf(snapshotOfAccount(cached?.accounts, account));
}

/**
 * Why a warmup would start nothing: the account has no 5-hour limit, so there is no session timer, and its
 * weekly window already runs. An idle weekly window still gets the request, which starts it.
 */
export function nothingToWarm(usage: UsageResponse | undefined, now: number = Date.now()): string | undefined {
    if (fiveHourState(usage) !== "absent") {
        return undefined;
    }

    const weeklyReset = usage?.seven_day?.resets_at ? Date.parse(usage.seven_day.resets_at) : Number.NaN;

    if (!Number.isFinite(weeklyReset) || weeklyReset <= now) {
        return undefined;
    }

    return `no 5-hour limit on this account, and its weekly window already runs (resets ${new Date(weeklyReset).toISOString()})`;
}

function isOAuthAuthFailure(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /invalid_grant|Token expired|Invalid bearer token|unauthorized|\b401\b/i.test(msg);
}

function hasOAuthPair(account: AccountEntry): boolean {
    const c = account.credentials;
    return Boolean(c.accessToken || c.refreshToken || c.authFile);
}

/**
 * A refusal no token change fixes (the organization blocks OAuth, the terms need accepting, the
 * quota is used up) is reported as what it is. A used-up quota is a skip: nothing is wrong, there
 * is no session to start. Any other error is rethrown unchanged.
 */
function explainRefusal(err: unknown): WarmupOutcome {
    const failure = describeAnthropicFailure(err);

    if (!failure) {
        throw err;
    }

    if (failure.kind === "weekly-limit" || failure.kind === "session-limit") {
        return { via: "oauth", skipped: failure.message };
    }

    throw new WarmupFailure(failure.message, failure.action);
}

async function defaultLoadLongLived(accountName: string): Promise<LongLivedTokens | undefined> {
    const config = await AIConfig.load();
    return config.getAccount(accountName)?.tokens;
}

async function pingLongLived(
    account: AccountEntry,
    token: string,
    sendLongLived: NonNullable<AnthropicWarmupDeps["sendLongLived"]>,
    oauthErr?: unknown
): Promise<WarmupOutcome> {
    const verdict = await sendLongLived(token);

    if (verdict === "ok" || verdict === "limited") {
        logger.info({ account: account.name }, "[warmup] sent on the login-long token");
        return { via: "login-long" };
    }

    const oauthPart = oauthErr ? `oauth: ${oauthErr instanceof Error ? oauthErr.message : String(oauthErr)}; ` : "";
    throw new Error(`${oauthPart}login-long: ${verdict}`);
}

/**
 * Anthropic's warmup: the shared chat turn on the OAuth pair, and the inference ping on a
 * usable long-lived (`tools claude login-long`) token when there is no pair or the pair is
 * dead. A refusal the account cannot fix by logging in again is named (`explainRefusal`), any
 * other non-auth failure surfaces unchanged, and an account with no credential at all fails
 * before any request.
 */
export async function anthropicWarmup(
    account: AccountEntry,
    ctx: WarmupContext,
    deps: AnthropicWarmupDeps = {}
): Promise<WarmupOutcome> {
    const loadLongLived = deps.loadLongLived ?? defaultLoadLongLived;
    const sendLongLived = deps.sendLongLived ?? sendLongLivedInferencePing;
    const last = await (deps.lastUsage ?? defaultLastUsage)(account).catch((error: unknown) => {
        logger.debug({ account: account.name, error }, "[warmup] usage cache unreadable; warming up anyway");
        return undefined;
    });
    const idle = nothingToWarm(last);

    if (idle) {
        logger.info({ account: account.name, reason: idle }, "[warmup] nothing to start; no request sent");
        return { via: "none", skipped: idle };
    }

    const tokens = await loadLongLived(account.name);
    const longLived = tokens?.longLivedToken && longLivedTokenUsable(tokens) ? tokens.longLivedToken : undefined;

    if (!hasOAuthPair(account)) {
        if (!longLived) {
            throw new Error(`no credentials stored. Run: ${claudeLoginCommand(account.name)}`);
        }

        logger.info({ account: account.name }, "[warmup] no OAuth pair, using the login-long token");
        return pingLongLived(account, longLived, sendLongLived);
    }

    try {
        await ctx.generic();
        return { via: "oauth" };
    } catch (err) {
        if (!isOAuthAuthFailure(err)) {
            return explainRefusal(err);
        }

        if (!longLived) {
            throw new Error(
                `${err instanceof Error ? err.message : String(err)}. Or attach a long-lived token: ${claudeLoginLongCommand(account.name)}`
            );
        }

        logger.info({ account: account.name, err }, "[warmup] OAuth failed; trying the login-long token");
        return pingLongLived(account, longLived, sendLongLived, err);
    }
}
