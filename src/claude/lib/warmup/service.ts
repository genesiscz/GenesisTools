import type { AccountUsage, UsageResponse } from "@app/claude/lib/usage/api";
import {
    longLivedTokenUsable,
    sendLongLivedInferencePing,
    type TokenVerdict,
} from "@genesiscz/utils/claude/token-verify";
import type { AIAccountTokens } from "@genesiscz/utils/config/ai.types";
import { formatLocalDate } from "@genesiscz/utils/date";
import { logger } from "@genesiscz/utils/logger";

function currentHour(): number {
    return new Date().getHours();
}

function formatTime(date: Date): string {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isWithinSchedule(hour: number, startHour: number, endHour: number): boolean {
    return hour >= startHour && hour < endHour;
}

function todayDateString(): string {
    return formatLocalDate(new Date());
}

function shouldWarmSession(usage: UsageResponse, startHour: number, endHour: number): boolean {
    const hour = currentHour();

    if (!isWithinSchedule(hour, startHour, endHour)) {
        return false;
    }

    const fiveHour = usage.five_hour;

    if (!fiveHour.resets_at) {
        return true;
    }

    return new Date(fiveHour.resets_at).getTime() < Date.now();
}

function shouldWarmWeekly(usage: UsageResponse): boolean {
    const sevenDay = usage.seven_day;

    if (!sevenDay.resets_at) {
        return true;
    }

    return new Date(sevenDay.resets_at).getTime() < Date.now();
}

export type WarmupVia = "oauth" | "login-long";

export type WarmupSendResult = {
    success: boolean;
    via?: WarmupVia;
};

export type SendWarmupOptions = {
    loadTokens?: (accountName: string) => Promise<AIAccountTokens | undefined>;
    sendOAuth?: (accountName: string) => Promise<void>;
    sendLongLived?: (token: string) => Promise<TokenVerdict>;
};

export function formatWarmupViaHint(via?: WarmupVia): string {
    if (via !== "login-long") {
        return "";
    }

    return " used login-long token";
}

function isOAuthAuthFailure(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);

    return /invalid_grant|Token expired|Invalid bearer token|unauthorized|\b401\b/i.test(msg);
}

function hasOAuthCredentials(tokens: AIAccountTokens | undefined): boolean {
    if (!tokens) {
        // Unknown account: let the OAuth path raise the not-found error.
        return true;
    }

    return Boolean(tokens.accessToken || tokens.refreshToken || tokens.authFile);
}

function hasNoCredentials(tokens: AIAccountTokens): boolean {
    return !tokens.accessToken && !tokens.refreshToken && !tokens.longLivedToken && !tokens.authFile;
}

function longLivedSucceeded(verdict: TokenVerdict): boolean {
    return verdict === "ok" || verdict === "limited";
}

async function defaultLoadTokens(accountName: string): Promise<AIAccountTokens | undefined> {
    const { AIConfig } = await import("@genesiscz/utils/ai/AIConfig");
    const aiConfig = await AIConfig.load();
    return aiConfig.getAccount(accountName)?.tokens;
}

async function defaultSendOAuth(accountName: string): Promise<void> {
    const { AIAccount } = await import("@genesiscz/utils/ai/AIAccount");
    const { ChatEngine } = await import("@ask/chat/ChatEngine");
    const { AnthropicModelCategory } = await import("@genesiscz/utils/ask/providers/ModelResolver");

    const account = AIAccount.chooseClaude(accountName);
    await ChatEngine.oneShot({
        account,
        model: AnthropicModelCategory.Haiku,
        message: "hi",
        maxTokens: 5,
    });
}

async function warmupViaLongLived(
    accountName: string,
    token: string,
    sendLongLived: (token: string) => Promise<TokenVerdict>,
    oauthErr?: unknown
): Promise<WarmupSendResult> {
    const verdict = await sendLongLived(token);

    if (longLivedSucceeded(verdict)) {
        logger.info(`Warmup for "${accountName}" used login-long token`);
        return { success: true, via: "login-long" };
    }

    const oauthPart = oauthErr ? `oauth: ${oauthErr}; ` : "";
    logger.warn(`Warmup message failed for "${accountName}": ${oauthPart}login-long: ${verdict}`);
    return { success: false };
}

export async function sendWarmupMessage(
    accountName: string,
    options: SendWarmupOptions = {}
): Promise<WarmupSendResult> {
    const loadTokens = options.loadTokens ?? defaultLoadTokens;
    const sendOAuth = options.sendOAuth ?? defaultSendOAuth;
    const sendLongLived = options.sendLongLived ?? sendLongLivedInferencePing;

    let tokens: Awaited<ReturnType<typeof loadTokens>>;
    try {
        tokens = await loadTokens(accountName);
    } catch (err) {
        logger.warn(`Warmup message failed for "${accountName}": ${err}`);
        return { success: false };
    }

    // Fail fast on credential-less entries (e.g. an aborted login left an
    // account with empty tokens) instead of spinning through token-refresh
    // retries and an API call that can only return "Invalid bearer token".
    if (tokens && hasNoCredentials(tokens)) {
        logger.warn(
            `Warmup skipped for "${accountName}": no credentials stored. Run: tools claude login ${accountName}`
        );
        return { success: false };
    }

    const canLongLived = tokens ? longLivedTokenUsable(tokens) : false;

    if (hasOAuthCredentials(tokens)) {
        try {
            await sendOAuth(accountName);
            return { success: true, via: "oauth" };
        } catch (err) {
            if (isOAuthAuthFailure(err) && canLongLived && tokens?.longLivedToken) {
                logger.info(`Warmup OAuth failed for "${accountName}" (${err}); trying login-long token`);
                return warmupViaLongLived(accountName, tokens.longLivedToken, sendLongLived, err);
            }

            const loginLongHint =
                isOAuthAuthFailure(err) && !canLongLived
                    ? `. Or attach a long-lived token: tools claude login-long ${accountName}`
                    : "";
            logger.warn(`Warmup message failed for "${accountName}": ${err}${loginLongHint}`);
            return { success: false };
        }
    }

    if (canLongLived && tokens?.longLivedToken) {
        logger.info(`Warmup for "${accountName}": no OAuth pair, using login-long token`);
        return warmupViaLongLived(accountName, tokens.longLivedToken, sendLongLived);
    }

    logger.warn(`Warmup skipped for "${accountName}": no credentials stored. Run: tools claude login ${accountName}`);
    return { success: false };
}

/**
 * Process warmup rules against current usage data.
 * Called by poll-daemon after each usage refresh.
 */
export async function processWarmupRules(usageResults: AccountUsage[]): Promise<void> {
    const { loadConfig, updateConfig } = await import("@app/claude/lib/config");
    const config = await loadConfig();
    const warmup = config.warmup;

    if (!warmup) {
        return;
    }

    let configChanged = false;
    const today = todayDateString();

    if (warmup.todayLog.date !== today) {
        warmup.todayLog = { date: today, events: [] };
        configChanged = true;
    }

    // ── Session warmups ──
    if (warmup.session.enabled) {
        const { startHour, endHour } = warmup.session.schedule;

        for (const accountName of warmup.session.accounts) {
            const result = usageResults.find((r) => r.accountName === accountName);

            if (!result?.usage) {
                continue;
            }

            if (shouldWarmSession(result.usage, startHour, endHour)) {
                const wasUnused = !result.usage.five_hour.resets_at || result.usage.five_hour.utilization === 0;

                logger.info(`Session warmup: sending to ${accountName}`);
                const sent = await sendWarmupMessage(accountName);

                warmup.todayLog.events.push({
                    account: accountName,
                    type: "session",
                    time: formatTime(new Date()),
                    success: sent.success,
                    ...(sent.via === "login-long" ? { via: "login-long" as const } : {}),
                });
                configChanged = true;

                if (sent.success && warmup.session.notify) {
                    const shouldNotify = !warmup.session.notifyOnlyIfUnused || wasUnused;

                    if (shouldNotify) {
                        const { dispatchNotification } = await import("@genesiscz/utils/notifications");
                        await dispatchNotification({
                            app: "claude",
                            title: "Claude Warmup",
                            message:
                                sent.via === "login-long"
                                    ? `Session started for ${accountName} (login-long token)`
                                    : `Session started for ${accountName}`,
                        });
                    }
                }
            }
        }
    }

    // ── Weekly warmups ──
    if (warmup.weekly.enabled) {
        for (const accountName of warmup.weekly.accounts) {
            const result = usageResults.find((r) => r.accountName === accountName);

            if (!result?.usage) {
                continue;
            }

            if (shouldWarmWeekly(result.usage)) {
                logger.info(`Weekly warmup: sending to ${accountName}`);
                const sent = await sendWarmupMessage(accountName);

                warmup.todayLog.events.push({
                    account: accountName,
                    type: "weekly",
                    time: formatTime(new Date()),
                    success: sent.success,
                    ...(sent.via === "login-long" ? { via: "login-long" as const } : {}),
                });
                configChanged = true;

                if (sent.success && warmup.weekly.notify) {
                    const { dispatchNotification } = await import("@genesiscz/utils/notifications");
                    await dispatchNotification({
                        app: "claude",
                        title: "Claude Warmup",
                        message:
                            sent.via === "login-long"
                                ? `Weekly session started for ${accountName} (login-long token)`
                                : `Weekly session started for ${accountName}`,
                    });
                }
            }
        }
    }

    if (configChanged) {
        await updateConfig((cfg) => {
            cfg.warmup = warmup;
        });
    }
}
