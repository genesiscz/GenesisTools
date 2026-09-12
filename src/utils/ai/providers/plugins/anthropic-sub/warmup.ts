import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { WarmupContext, WarmupOutcome } from "@genesiscz/utils/ai/providers/account-features";
import {
    longLivedTokenUsable,
    sendLongLivedInferencePing,
    type TokenVerdict,
} from "@genesiscz/utils/claude/token-verify";
import { logger } from "@genesiscz/utils/logger";

export interface LongLivedTokens {
    longLivedToken?: string;
    longLivedTokenExpiresAt?: number;
}

export interface AnthropicWarmupDeps {
    /** Plaintext long-lived token for the account (the vault read), or nothing. */
    loadLongLived?: (accountName: string) => Promise<LongLivedTokens | undefined>;
    sendLongLived?: (token: string) => Promise<TokenVerdict>;
}

function isOAuthAuthFailure(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /invalid_grant|Token expired|Invalid bearer token|unauthorized|\b401\b/i.test(msg);
}

function hasOAuthPair(account: AccountEntry): boolean {
    const c = account.credentials;
    return Boolean(c.accessToken || c.refreshToken || c.authFile);
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
 * dead. A non-auth failure surfaces unchanged; an account with no credential at all fails
 * before any request.
 */
export async function anthropicWarmup(
    account: AccountEntry,
    ctx: WarmupContext,
    deps: AnthropicWarmupDeps = {}
): Promise<WarmupOutcome> {
    const loadLongLived = deps.loadLongLived ?? defaultLoadLongLived;
    const sendLongLived = deps.sendLongLived ?? sendLongLivedInferencePing;
    const tokens = await loadLongLived(account.name);
    const longLived = tokens?.longLivedToken && longLivedTokenUsable(tokens) ? tokens.longLivedToken : undefined;

    if (!hasOAuthPair(account)) {
        if (!longLived) {
            throw new Error(`no credentials stored. Run: tools claude login ${account.name}`);
        }

        logger.info({ account: account.name }, "[warmup] no OAuth pair, using the login-long token");
        return pingLongLived(account, longLived, sendLongLived);
    }

    try {
        await ctx.generic();
        return { via: "oauth" };
    } catch (err) {
        if (!isOAuthAuthFailure(err)) {
            throw err;
        }

        if (!longLived) {
            throw new Error(
                `${err instanceof Error ? err.message : String(err)}. Or attach a long-lived token: tools claude login-long ${account.name}`
            );
        }

        logger.info({ account: account.name, err }, "[warmup] OAuth failed; trying the login-long token");
        return pingLongLived(account, longLived, sendLongLived, err);
    }
}
