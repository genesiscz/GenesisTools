import { randomBytes } from "node:crypto";
import type { LanguageModelUsage } from "ai";
import pc from "picocolors";
import { formatTokens } from "@app/utils/format";

// Re-exported shared utilities
export { estimateTokens } from "@app/utils/tokens";
export { formatTokens, formatCost, formatBytes as formatFileSize, formatDuration } from "@app/utils/format";
export { truncateText, sanitizeOutput } from "@app/utils/string";
export { parseJSON } from "@app/utils/json";
export { isObject, deepMerge } from "@app/utils/object";
export { retry, debounce, throttle, withTimeout } from "@app/utils/async";

export function generateSessionId(): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").split("Z")[0];
    const random = randomBytes(3).toString("hex");
    return `${timestamp}_${random}`;
}

export function colorizeRole(role: string): string {
    switch (role.toLowerCase()) {
        case "user":
            return pc.blue("User");
        case "assistant":
            return pc.green("Assistant");
        case "system":
            return pc.magenta("System");
        default:
            return pc.dim(role);
    }
}

export function colorizeProvider(provider: string): string {
    const colors = [pc.cyan, pc.magenta, pc.yellow, pc.blue, pc.green];

    const colorIndex = provider.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
    return colors[colorIndex](provider);
}

/** Colorize text by price tier based on input cost per 1M tokens */
export function colorizeByPriceTier(text: string, inputPer1M?: number): string {
    if (inputPer1M == null) return pc.dim(text);
    if (inputPer1M === 0) return pc.green(text);
    if (inputPer1M < 1) return pc.green(text);
    if (inputPer1M < 5) return pc.cyan(text);
    if (inputPer1M < 15) return pc.yellow(text);
    return pc.red(text);
}

export function createProgressBar(current: number, total: number, width: number = 40): string {
    const percentage = Math.min(1, Math.max(0, current / total));
    const filled = Math.round(width * percentage);
    const empty = width - filled;

    const filledBar = "█".repeat(filled);
    const emptyBar = "░".repeat(empty);
    const percentageText = `${Math.round(percentage * 100)}%`;

    return `[${filledBar}${emptyBar}] ${percentageText}`;
}

export function formatUsage(usage?: LanguageModelUsage): string {
    if (!usage) {
        return "";
    }

    const parts: string[] = [];

    if (usage.inputTokens) {
        parts.push(`Input: ${formatTokens(usage.inputTokens)}`);
    }

    if (usage.outputTokens) {
        parts.push(`Output: ${formatTokens(usage.outputTokens)}`);
    }

    if (usage.totalTokens) {
        parts.push(`Total: ${formatTokens(usage.totalTokens)}`);
    }

    if (usage.cachedInputTokens && usage.cachedInputTokens > 0) {
        parts.push(`Cached: ${formatTokens(usage.cachedInputTokens)}`);
    }

    return parts.join(", ");
}

export function validateAPIKey(key: string, provider: string): boolean {
    // Basic validation - these are simple heuristics and not foolproof
    const minLengths: Record<string, number> = {
        openai: 20,
        anthropic: 20,
        google: 20,
        groq: 20,
        openrouter: 20,
        xai: 20,
        jinaai: 20,
    };

    const minLength = minLengths[provider] || 20;

    if (key.length < minLength) {
        return false;
    }

    // Check for common patterns that indicate invalid keys
    const invalidPatterns = [
        /^your_api_key_here$/i,
        /^sk-test-/i, // OpenAI test keys (usually not for production)
        /^placeholder$/i,
        /^xxx+/i,
    ];

    if (invalidPatterns.some((pattern) => pattern.test(key))) {
        return false;
    }

    return true;
}

export function getEnvVar(name: string, required: boolean = false): string | undefined {
    const value = process.env[name];

    if (required && !value) {
        throw new Error(`Required environment variable ${name} is not set`);
    }

    return value;
}
