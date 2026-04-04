import type { AccountUsage, UsageResponse } from "@app/claude/lib/usage/api";
import logger from "@app/logger";

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
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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

export async function sendWarmupMessage(accountName: string): Promise<boolean> {
    try {
        const { AIAccount } = await import("@app/utils/ai/AIAccount");
        const { ChatEngine } = await import("@ask/chat/ChatEngine");
        const { AnthropicModelCategory } = await import("@ask/providers/ModelResolver");

        const account = AIAccount.chooseClaude(accountName);
        await ChatEngine.oneShot({
            account,
            model: AnthropicModelCategory.Haiku,
            message: "hi",
            maxTokens: 5,
        });
        return true;
    } catch (err) {
        logger.warn(`Warmup message failed for "${accountName}": ${err}`);
        return false;
    }
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
                const success = await sendWarmupMessage(accountName);

                warmup.todayLog.events.push({
                    account: accountName,
                    type: "session",
                    time: formatTime(new Date()),
                    success,
                });
                configChanged = true;

                if (success && warmup.session.notify) {
                    const shouldNotify = !warmup.session.notifyOnlyIfUnused || wasUnused;

                    if (shouldNotify) {
                        const { dispatchNotification } = await import("@app/utils/notifications");
                        await dispatchNotification({
                            app: "claude",
                            title: "Claude Warmup",
                            message: `Session started for ${accountName}`,
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
                const success = await sendWarmupMessage(accountName);

                warmup.todayLog.events.push({
                    account: accountName,
                    type: "weekly",
                    time: formatTime(new Date()),
                    success,
                });
                configChanged = true;

                if (success && warmup.weekly.notify) {
                    const { dispatchNotification } = await import("@app/utils/notifications");
                    await dispatchNotification({
                        app: "claude",
                        title: "Claude Warmup",
                        message: `Weekly session started for ${accountName}`,
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
