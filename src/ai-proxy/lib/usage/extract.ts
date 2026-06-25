import type { TokenUsage } from "@app/ai-proxy/lib/usage/types";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { isObject } from "@app/utils/object";

type JsonObject = Record<string, unknown>;

function normalizeUsage(raw: unknown): TokenUsage | undefined {
    if (!isObject(raw)) {
        return undefined;
    }

    const prompt = raw.prompt_tokens ?? raw.input_tokens;
    const completion = raw.completion_tokens ?? raw.output_tokens;
    const total = raw.total_tokens;
    const costTicks = raw.cost_in_usd_ticks;

    if (prompt == null && completion == null && total == null && costTicks == null) {
        return undefined;
    }

    const usage: TokenUsage = {};

    if (prompt != null) {
        usage.prompt_tokens = Number(prompt);
    }

    if (completion != null) {
        usage.completion_tokens = Number(completion);
    }

    if (total != null) {
        usage.total_tokens = Number(total);
    } else if (usage.prompt_tokens != null || usage.completion_tokens != null) {
        usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    }

    if (costTicks != null) {
        usage.cost_in_usd_ticks = Number(costTicks);
    }

    return usage;
}

export function extractUsageFromJsonBody(bodyText: string): TokenUsage | undefined {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true }) as JsonObject;

        if (isObject(parsed.usage)) {
            return normalizeUsage(parsed.usage);
        }

        if (Array.isArray(parsed.choices)) {
            for (const choice of parsed.choices) {
                if (!isObject(choice)) {
                    continue;
                }

                const fromChoice = normalizeUsage(choice.usage);
                if (fromChoice) {
                    return fromChoice;
                }
            }
        }

        return undefined;
    } catch (err) {
        logger.debug({ err }, "ai-proxy usage: failed to extract usage from JSON body");
        return undefined;
    }
}

export function extractLatestUsageFromSse(buffer: string): TokenUsage | undefined {
    let latest: TokenUsage | undefined;

    for (const line of buffer.split("\n")) {
        if (!line.startsWith("data:")) {
            continue;
        }

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
            continue;
        }

        try {
            const parsed = SafeJSON.parse(payload, { strict: true }) as JsonObject;
            const usage = normalizeUsage(parsed.usage);

            if (usage) {
                latest = usage;
            }
        } catch (err) {
            logger.debug({ err, payloadPreview: payload.slice(0, 120) }, "ai-proxy usage: skipped SSE usage payload");
        }
    }

    return latest;
}

export function bodyWantsStream(bodyText: string): boolean {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true }) as { stream?: boolean };
        return parsed.stream === true;
    } catch (err) {
        logger.debug({ err }, "ai-proxy usage: bodyWantsStream parse failed");
        return false;
    }
}
