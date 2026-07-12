import { randomBytes } from "node:crypto";
import { env } from "@app/utils/env";
import { formatTokens } from "@app/utils/format";
import type { LanguageModelUsage } from "ai";
import pc from "picocolors";

export { debounce, retry, throttle, withTimeout } from "@app/utils/async";
export { formatBytes as formatFileSize, formatCost, formatDuration, formatTokens } from "@app/utils/format";
export { parseJSON } from "@app/utils/json";
export { deepMerge, isObject } from "@app/utils/object";
export { sanitizeOutput, truncateText } from "@app/utils/string";
// Re-exported shared utilities
export { estimateTokens } from "@app/utils/tokens";

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
    if (inputPer1M == null) {
        return pc.dim(text);
    }
    if (inputPer1M === 0) {
        return pc.green(text);
    }
    if (inputPer1M < 1) {
        return pc.green(text);
    }
    if (inputPer1M < 5) {
        return pc.cyan(text);
    }
    if (inputPer1M < 15) {
        return pc.yellow(text);
    }
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

/**
 * Flat usage shape written by ai@5 (persisted sessions, ask's own message
 * records). ai@7 moved cached tokens into `inputTokenDetails`.
 */
export interface LegacyFlatUsage {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
}

/**
 * Cached (prompt-cache read) input tokens from a v7 usage object, falling
 * back to the flat ai@5 field for data persisted before the upgrade.
 */
export function usageCacheReadTokens(usage?: LanguageModelUsage | LegacyFlatUsage): number {
    if (!usage) {
        return 0;
    }

    if ("inputTokenDetails" in usage) {
        return usage.inputTokenDetails?.cacheReadTokens ?? 0;
    }

    return usage.cachedInputTokens ?? 0;
}

/** Cache-write (prompt-cache creation) input tokens; ai@5 had no such field. */
export function usageCacheWriteTokens(usage?: LanguageModelUsage | LegacyFlatUsage): number {
    if (!usage) {
        return 0;
    }

    if ("inputTokenDetails" in usage) {
        return usage.inputTokenDetails?.cacheWriteTokens ?? 0;
    }

    return 0;
}

/**
 * Non-cached input tokens — the ones billed at the full input rate.
 *
 * IMPORTANT: in ai@7 the `@ai-sdk/anthropic@4` provider maps top-level
 * `inputTokens` to `input_tokens + cacheCreation + cacheRead` (it INCLUDES
 * cache tokens), whereas ai@5 excluded them. Billing base input on
 * `inputTokens` would double-charge cache tokens (once at full rate here, once
 * at the cache rate). Always price the base input on this value, then add
 * cache-read / cache-write costs separately. For legacy flat usage (ai@5),
 * `inputTokens` already excluded cache, so it is returned as-is.
 */
export function usageInputNoCacheTokens(usage?: LanguageModelUsage | LegacyFlatUsage): number {
    if (!usage) {
        return 0;
    }

    if ("inputTokenDetails" in usage) {
        const noCache = usage.inputTokenDetails?.noCacheTokens;
        if (noCache != null) {
            return noCache;
        }

        // Provider didn't break it down: derive from the total minus cache parts.
        const total = usage.inputTokens ?? 0;
        const derived = total - usageCacheReadTokens(usage) - usageCacheWriteTokens(usage);
        return Math.max(0, derived);
    }

    // ai@5 flat usage: inputTokens already excluded cache tokens.
    return usage.inputTokens ?? 0;
}

/**
 * Build a full v7 `LanguageModelUsage` from flat token counts (legacy shape
 * used by persisted sessions, tests, and ask's own message records).
 *
 * The flat `inputTokens` is the ai@5 value, which EXCLUDED cache tokens — so
 * it maps to `noCacheTokens`, and the v7 total `inputTokens` is rebuilt as
 * `input + cachedRead` to match the invariant real providers report
 * (`total = noCache + cacheRead + cacheWrite`). This keeps
 * `usageInputNoCacheTokens` correct on converted objects.
 */
export function toLanguageModelUsage(flat: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
}): LanguageModelUsage {
    const noCache = flat.inputTokens;
    const cacheRead = flat.cachedInputTokens;
    const inputTotal = noCache == null && cacheRead == null ? undefined : (noCache ?? 0) + (cacheRead ?? 0);

    return {
        inputTokens: inputTotal,
        inputTokenDetails: {
            noCacheTokens: noCache,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: flat.cacheWriteTokens,
        },
        outputTokens: flat.outputTokens,
        outputTokenDetails: {
            textTokens: undefined,
            reasoningTokens: undefined,
        },
        totalTokens: flat.totalTokens,
    };
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

    const cachedTokens = usageCacheReadTokens(usage);
    if (cachedTokens > 0) {
        parts.push(`Cached Read: ${formatTokens(cachedTokens)}`);
    }

    const cacheWriteTokens = usageCacheWriteTokens(usage);
    if (cacheWriteTokens > 0) {
        parts.push(`Cached Write: ${formatTokens(cacheWriteTokens)}`);
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
    const value = env.get(name);

    if (required && !value) {
        throw new Error(`Required environment variable ${name} is not set`);
    }

    return value;
}
