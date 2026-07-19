import type { TokenUsage } from "@app/ai-proxy/lib/usage/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

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

            if (!parsed) {
                continue;
            }

            // Responses SSE (WHAM included) nests usage on `response.completed`
            // events as `response.usage`; chat SSE carries it at the event root.
            const usage =
                normalizeUsage(parsed.usage) ??
                (isObject(parsed.response) ? normalizeUsage(parsed.response.usage) : undefined);

            if (usage) {
                latest = usage;
            }
        } catch (err) {
            logger.debug({ err, payloadPreview: payload.slice(0, 120) }, "ai-proxy usage: skipped SSE usage payload");
        }
    }

    return latest;
}

function collectTextFromContent(content: unknown, sink: string[]): void {
    if (typeof content === "string") {
        sink.push(content);
        return;
    }

    if (!Array.isArray(content)) {
        return;
    }

    for (const part of content) {
        if (isObject(part) && typeof part.text === "string") {
            sink.push(part.text);
        }
    }
}

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

/** Prompt-side text from a chat or Responses request body (messages/input/instructions). */
function promptTextFromRequestBody(bodyText: string): string {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true }) as JsonObject;

        if (!parsed) {
            return bodyText;
        }

        const sink: string[] = [];

        if (typeof parsed.instructions === "string") {
            sink.push(parsed.instructions);
        }

        for (const entry of [
            ...(Array.isArray(parsed.messages) ? parsed.messages : []),
            ...(Array.isArray(parsed.input) ? parsed.input : []),
        ]) {
            if (isObject(entry)) {
                collectTextFromContent(entry.content, sink);
            }
        }

        if (sink.length > 0) {
            return sink.join("\n");
        }

        return bodyText;
    } catch (err) {
        logger.debug({ err }, "ai-proxy usage: prompt estimate fell back to raw body");
        return bodyText;
    }
}

/** Completion-side text from the outbound response (chat SSE, Responses SSE, or JSON). */
function completionTextFromResponseBody(responseBody: string, stream: boolean): string {
    if (!stream) {
        try {
            const parsed = SafeJSON.parse(responseBody, { strict: true }) as JsonObject;

            if (!parsed) {
                return responseBody;
            }

            const sink: string[] = [];

            if (Array.isArray(parsed.choices)) {
                for (const choice of parsed.choices) {
                    if (isObject(choice) && isObject(choice.message)) {
                        collectTextFromContent(choice.message.content, sink);
                    }
                }
            }

            if (Array.isArray(parsed.output)) {
                for (const item of parsed.output) {
                    if (isObject(item)) {
                        collectTextFromContent(item.content, sink);
                    }
                }
            }

            if (sink.length > 0) {
                return sink.join("");
            }

            return responseBody;
        } catch (err) {
            logger.debug({ err }, "ai-proxy usage: completion estimate fell back to raw body");
            return responseBody;
        }
    }

    const sink: string[] = [];

    for (const line of responseBody.split("\n")) {
        if (!line.startsWith("data:")) {
            continue;
        }

        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") {
            continue;
        }

        try {
            const parsed = SafeJSON.parse(payload, { strict: true }) as JsonObject;

            if (!parsed) {
                continue;
            }

            // Responses SSE text deltas.
            if (typeof parsed.delta === "string") {
                sink.push(parsed.delta);
                continue;
            }

            // Chat completion chunks.
            if (Array.isArray(parsed.choices)) {
                for (const choice of parsed.choices) {
                    if (!isObject(choice) || !isObject(choice.delta)) {
                        continue;
                    }

                    if (typeof choice.delta.content === "string") {
                        sink.push(choice.delta.content);
                    }

                    if (typeof choice.delta.reasoning_content === "string") {
                        sink.push(choice.delta.reasoning_content);
                    }
                }
            }
        } catch (err) {
            logger.debug({ err }, "ai-proxy usage: skipped SSE line in completion estimate");
        }
    }

    return sink.length > 0 ? sink.join("") : responseBody;
}

/**
 * Char-heuristic (~4 chars/token) usage estimate for successful exchanges where
 * upstream sent no usage. Always tagged `source: "estimated"` — never presented
 * as upstream-reported numbers.
 */
export function estimateUsageFromExchange({
    bodyText,
    responseBody,
    stream,
}: {
    bodyText: string;
    responseBody: string;
    stream: boolean;
}): TokenUsage {
    const promptTokens = estimateTokens(promptTextFromRequestBody(bodyText));
    const completionTokens = estimateTokens(completionTextFromResponseBody(responseBody, stream));

    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        source: "estimated",
    };
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
