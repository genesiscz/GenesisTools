import type { AccountUsage, UsageResponse } from "@app/claude/lib/usage/api";
import { warmupAccounts } from "@genesiscz/utils/ai/warmup";
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

export function formatWarmupViaHint(via?: WarmupVia): string {
    if (via !== "login-long") {
        return "";
    }

    return " used login-long token";
}

/**
 * The daemon's per-account send, now the shared warmup in `@genesiscz/utils/ai/warmup`:
 * the same chat turn `tools ai|claude|codex|grok warmup` send, with anthropic's
 * long-lived fallback living on the plugin. Never throws: the rule loop records
 * success or failure per account and moves on.
 */
export async function sendWarmupMessage(accountName: string): Promise<WarmupSendResult> {
    const [result] = await warmupAccounts({ provider: "anthropic-sub", names: [accountName] }).catch((err: unknown) => {
        logger.warn({ account: accountName, err }, "[warmup] account lookup failed");
        return [];
    });

    if (!result?.ok) {
        return { success: false };
    }

    return { success: true, ...(result.via === "login-long" ? { via: "login-long" as const } : {}) };
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
