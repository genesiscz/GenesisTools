import logger from "@app/logger";
import { dynamicPricingManager } from "@ask/providers/DynamicPricing";
import type { CostBreakdown } from "@ask/types";
import type { LanguageModelUsage } from "ai";
import { usageDatabase } from "./UsageDatabase";

export interface SessionCost {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    cost: number;
    messageCount: number;
    timestamp: Date;
}

export interface CostAlert {
    type: "warning" | "limit" | "daily";
    amount: number;
    threshold: number;
    message: string;
}

export class CostTracker {
    private sessionCosts = new Map<string, SessionCost>();
    private dailyCosts = new Map<string, number>(); // date -> cost
    private costAlerts: CostAlert[] = [];
    private dailyLimit?: number;
    private sessionLimit?: number;

    constructor(dailyLimit?: number, sessionLimit?: number) {
        this.dailyLimit = dailyLimit;
        this.sessionLimit = sessionLimit;
    }

    async trackUsage(
        provider: string,
        model: string,
        usage: LanguageModelUsage,
        sessionId: string = "default",
        messageIndex?: number,
    ): Promise<void> {
        // DEBUG: Log the usage object received
        logger.debug(`[CostTracker] trackUsage called for ${provider}/${model}, sessionId: ${sessionId}`);
        logger.debug({ usage: JSON.stringify(usage, null, 2) }, `[CostTracker] usage object`);
        logger.debug({ usageType: typeof usage }, `[CostTracker] usage type`);
        logger.debug({ keys: Object.keys(usage || {}) }, `[CostTracker] usage keys`);
        logger.debug({ inputTokens: usage.inputTokens }, `[CostTracker] usage.inputTokens`);
        logger.debug({ outputTokens: usage.outputTokens }, `[CostTracker] usage.outputTokens`);
        logger.debug({ totalTokens: usage.totalTokens }, `[CostTracker] usage.totalTokens`);
        logger.debug({ cachedInputTokens: usage.cachedInputTokens }, `[CostTracker] usage.cachedInputTokens`);

        const key = `${provider}/${model}`;
        const cost = await dynamicPricingManager.calculateCost(provider, model, usage);

        // Update session costs
        const existing = this.sessionCosts.get(key) || {
            provider,
            model,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
            cost: 0,
            messageCount: 0,
            timestamp: new Date(),
        };

        // Extract tokens using new API naming
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        const cachedInputTokens = usage.cachedInputTokens ?? 0;
        const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;

        existing.inputTokens += inputTokens;
        existing.outputTokens += outputTokens;
        existing.cachedInputTokens += cachedInputTokens;
        existing.totalTokens += totalTokens;
        existing.cost += cost;
        existing.messageCount += 1;
        existing.timestamp = new Date();

        this.sessionCosts.set(key, existing);

        // Update daily costs
        const today = new Date().toISOString().split("T")[0];
        const currentDailyCost = this.dailyCosts.get(today) || 0;
        this.dailyCosts.set(today, currentDailyCost + cost);

        // Persist to database
        try {
            await usageDatabase.recordUsage(sessionId, provider, model, usage, cost, messageIndex);
        } catch (error) {
            logger.warn(`Failed to persist usage to database: ${error}`);
        }

        // Check for alerts
        await this.checkCostAlerts(existing, currentDailyCost);

        logger.debug(
            `Tracked usage: ${provider}/${model} - ${dynamicPricingManager.formatTokens(
                totalTokens,
            )} tokens, ${dynamicPricingManager.formatCost(cost)}`,
        );
    }

    private async checkCostAlerts(sessionCost: SessionCost, dailyCost: number): Promise<void> {
        // Check daily limit
        if (this.dailyLimit && dailyCost > this.dailyLimit) {
            const alert: CostAlert = {
                type: "daily",
                amount: dailyCost,
                threshold: this.dailyLimit,
                message: `Daily cost limit exceeded: ${dynamicPricingManager.formatCost(
                    dailyCost,
                )} > ${dynamicPricingManager.formatCost(this.dailyLimit)}`,
            };
            this.costAlerts.push(alert);
            logger.warn(alert.message);
        }

        // Check session limit
        if (this.sessionLimit && sessionCost.cost > this.sessionLimit) {
            const alert: CostAlert = {
                type: "limit",
                amount: sessionCost.cost,
                threshold: this.sessionLimit,
                message: `Session cost limit exceeded: ${dynamicPricingManager.formatCost(
                    sessionCost.cost,
                )} > ${dynamicPricingManager.formatCost(this.sessionLimit)}`,
            };
            this.costAlerts.push(alert);
            logger.warn(alert.message);
        }

        // Check warning thresholds
        const warningThresholds = [0.01, 0.05, 0.1, 0.5, 1.0, 5.0];
        for (const threshold of warningThresholds) {
            if (sessionCost.cost > threshold && sessionCost.cost < threshold + 0.01) {
                const alert: CostAlert = {
                    type: "warning",
                    amount: sessionCost.cost,
                    threshold,
                    message: `Cost warning: ${dynamicPricingManager.formatCost(sessionCost.cost)} spent on ${
                        sessionCost.provider
                    }/${sessionCost.model}`,
                };
                this.costAlerts.push(alert);
                logger.info(alert.message);
                break;
            }
        }
    }

    getBreakdown(): CostBreakdown[] {
        return Array.from(this.sessionCosts.values()).map((session) => ({
            provider: session.provider,
            model: session.model,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
            cachedInputTokens: session.cachedInputTokens,
            totalTokens: session.totalTokens,
            cost: session.cost,
            currency: "USD",
        }));
    }

    getTotalSessionCost(): number {
        return Array.from(this.sessionCosts.values()).reduce((total, session) => total + session.cost, 0);
    }

    getDailyCost(date?: string): number {
        const targetDate = date || new Date().toISOString().split("T")[0];
        return this.dailyCosts.get(targetDate) || 0;
    }

    getTotalTokens(): number {
        return Array.from(this.sessionCosts.values()).reduce((total, session) => total + session.totalTokens, 0);
    }

    getCostByProvider(): Record<string, { cost: number; tokens: number; messages: number }> {
        const providerStats: Record<string, { cost: number; tokens: number; messages: number }> = {};

        for (const session of this.sessionCosts.values()) {
            if (!providerStats[session.provider]) {
                providerStats[session.provider] = { cost: 0, tokens: 0, messages: 0 };
            }
            providerStats[session.provider].cost += session.cost;
            providerStats[session.provider].tokens += session.totalTokens;
            providerStats[session.provider].messages += session.messageCount;
        }

        return providerStats;
    }

    getCostByModel(): Record<string, { cost: number; tokens: number; messages: number }> {
        const modelStats: Record<string, { cost: number; tokens: number; messages: number }> = {};

        for (const session of this.sessionCosts.values()) {
            const key = `${session.provider}/${session.model}`;
            if (!modelStats[key]) {
                modelStats[key] = { cost: 0, tokens: 0, messages: 0 };
            }
            modelStats[key].cost += session.cost;
            modelStats[key].tokens += session.totalTokens;
            modelStats[key].messages += session.messageCount;
        }

        return modelStats;
    }

    getCostHistory(days: number = 7): Array<{ date: string; cost: number }> {
        const history: Array<{ date: string; cost: number }> = [];
        const today = new Date();

        for (let i = days - 1; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const dateStr = date.toISOString().split("T")[0];

            history.push({
                date: dateStr,
                cost: this.dailyCosts.get(dateStr) || 0,
            });
        }

        return history;
    }

    getRecentAlerts(limit: number = 10): CostAlert[] {
        return this.costAlerts.slice(-limit);
    }

    clearAlerts(): void {
        this.costAlerts = [];
    }

    setDailyLimit(limit: number): void {
        this.dailyLimit = limit;
        logger.info(`Daily cost limit set to ${dynamicPricingManager.formatCost(limit)}`);
    }

    setSessionLimit(limit: number): void {
        this.sessionLimit = limit;
        logger.info(`Session cost limit set to ${dynamicPricingManager.formatCost(limit)}`);
    }

    getLimits(): { daily?: number; session?: number } {
        return {
            daily: this.dailyLimit,
            session: this.sessionLimit,
        };
    }

    reset(): void {
        this.sessionCosts.clear();
        this.costAlerts = [];
        logger.info("Cost tracker reset for new session");
    }

    exportCostData(): {
        session: SessionCost[];
        daily: Record<string, number>;
        alerts: CostAlert[];
        limits: { daily?: number; session?: number };
    } {
        return {
            session: Array.from(this.sessionCosts.values()),
            daily: Object.fromEntries(this.dailyCosts),
            alerts: this.costAlerts,
            limits: this.getLimits(),
        };
    }

    importCostData(data: {
        session?: SessionCost[];
        daily?: Record<string, number>;
        alerts?: CostAlert[];
        limits?: { daily?: number; session?: number };
    }): void {
        if (data.session) {
            this.sessionCosts.clear();
            for (const session of data.session) {
                this.sessionCosts.set(`${session.provider}/${session.model}`, {
                    ...session,
                    timestamp: new Date(session.timestamp),
                });
            }
        }

        if (data.daily) {
            this.dailyCosts.clear();
            for (const [date, cost] of Object.entries(data.daily)) {
                this.dailyCosts.set(date, cost);
            }
        }

        if (data.alerts) {
            this.costAlerts = data.alerts;
        }

        if (data.limits) {
            this.dailyLimit = data.limits.daily;
            this.sessionLimit = data.limits.session;
        }

        logger.info("Cost tracker data imported successfully");
    }

    generateCostReport(): string {
        const totalCost = this.getTotalSessionCost();
        const totalTokens = this.getTotalTokens();
        const breakdown = this.getBreakdown();
        const providerStats = this.getCostByProvider();
        const dailyCost = this.getDailyCost();

        let report = `\n${"=".repeat(60)}\n`;
        report += "💰 COST ANALYSIS REPORT\n";
        report += `${"=".repeat(60)}\n\n`;

        // Summary
        report += `Session Total: ${dynamicPricingManager.formatCost(totalCost)}\n`;
        report += `Total Tokens: ${dynamicPricingManager.formatTokens(totalTokens)}\n`;
        report += `Daily Cost: ${dynamicPricingManager.formatCost(dailyCost)}\n\n`;

        // Provider breakdown
        if (Object.keys(providerStats).length > 0) {
            report += "By Provider:\n";
            for (const [provider, stats] of Object.entries(providerStats)) {
                report += `  ${provider}: ${dynamicPricingManager.formatCost(
                    stats.cost,
                )} (${dynamicPricingManager.formatTokens(stats.tokens)} tokens, ${stats.messages} messages)\n`;
            }
            report += "\n";
        }

        // Model breakdown
        if (breakdown.length > 0) {
            report += "By Model:\n";
            for (const item of breakdown) {
                const avgCostPerToken = item.totalTokens > 0 ? (item.cost / item.totalTokens) * 1000 : 0;
                report += `  ${item.provider}/${item.model}: ${dynamicPricingManager.formatCost(
                    item.cost,
                )} (${dynamicPricingManager.formatTokens(item.totalTokens)} tokens, ${dynamicPricingManager.formatCost(
                    avgCostPerToken,
                )}/1K tokens)\n`;
            }
            report += "\n";
        }

        // Recent alerts
        const recentAlerts = this.getRecentAlerts(3);
        if (recentAlerts.length > 0) {
            report += "Recent Alerts:\n";
            for (const alert of recentAlerts) {
                report += `  ${alert.message}\n`;
            }
            report += "\n";
        }

        // Limits
        const limits = this.getLimits();
        if (limits.daily || limits.session) {
            report += "Limits:\n";
            if (limits.daily) {
                report += `  Daily: ${dynamicPricingManager.formatCost(limits.daily)}\n`;
            }
            if (limits.session) {
                report += `  Session: ${dynamicPricingManager.formatCost(limits.session)}\n`;
            }
        }

        report += `${"=".repeat(60)}\n`;

        return report;
    }
}

// Singleton instance
export const costTracker = new CostTracker();
