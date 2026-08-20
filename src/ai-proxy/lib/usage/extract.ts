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
    // OpenRouter reports the charge for the route it actually took. An exchange
    // that carries ONLY a cost is still a usage record, so `cost` joins the
    // all-null bail guard — otherwise the most authoritative number available is
    // dropped for want of a token count.
    const cost = raw.cost;

    if (prompt == null && completion == null && total == null && costTicks == null && cost == null) {
        return undefined;
    }

    const usage: TokenUsage = {};

    if (prompt != null) {
        usage.prompt_tokens = Number(prompt);
    }

    // Grok's CLI proxy keeps reasoning OUT of completion_tokens and reports it
    // in completion_tokens_details. Booking completion_tokens alone hid
    // 63,694 output tokens from the ledger between 2026-06-26 and 2026-08-19
    // (117 rows where prompt+completion != total). But the OpenAI API and
    // OpenRouter report reasoning INSIDE completion_tokens with the details as
    // a breakdown, so an unconditional fold double-books their output. Fold
    // only when the totals prove reasoning was excluded: prompt+completion
    // falling short of total is exactly the ledger signal above. Anthropic-
    // shaped usage (output_tokens) already includes thinking; nothing is added.
    const completionDetails = isObject(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined;
    const reasoningTokens =
        raw.completion_tokens != null && completionDetails && typeof completionDetails.reasoning_tokens === "number"
            ? completionDetails.reasoning_tokens
            : 0;

    if (completion != null) {
        const reasoningExcluded =
            reasoningTokens > 0 && total != null && Number(prompt ?? 0) + Number(completion) < Number(total);
        usage.completion_tokens = Number(completion) + (reasoningExcluded ? reasoningTokens : 0);
    }

    if (total != null) {
        usage.total_tokens = Number(total);
    } else if (usage.prompt_tokens != null || usage.completion_tokens != null) {
        usage.total_tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
    }

    // Anthropic-shaped usage reports cache traffic OUTSIDE input_tokens; the
    // passthrough would otherwise book ~500 prompt tokens for a Claude Code
    // turn that shipped ~20k through the cache. Kept separate from
    // prompt_tokens because cache reads price differently.
    if (typeof raw.cache_read_input_tokens === "number") {
        usage.cache_read_input_tokens = raw.cache_read_input_tokens;
    }

    if (typeof raw.cache_creation_input_tokens === "number") {
        usage.cache_creation_input_tokens = raw.cache_creation_input_tokens;
    }

    // Recorded verbatim but never booked as cost: two measured samples on
    // differently-priced grok models (grok-4.3 vs grok-4-fast, 2026-08-19)
    // returned near-identical tick counts for similar token totals, so the tick
    // rate basis contradicts the per-model rate table and its unit cannot be
    // pinned. An opaque number must not enter an invoice.
    if (costTicks != null) {
        usage.cost_in_usd_ticks = Number(costTicks);
    }

    // Finite numbers only: a string, a null or a NaN reaching the ledger would be
    // added to a running total and turn the whole month's invoice into NaN.
    const costUsd = Number(cost);

    if (cost != null && Number.isFinite(costUsd)) {
        usage.cost_usd = costUsd;
    }

    const upstreamCost = isObject(raw.cost_details) ? Number(raw.cost_details.upstream_inference_cost) : Number.NaN;

    if (Number.isFinite(upstreamCost)) {
        usage.upstream_cost_usd = upstreamCost;
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
    // Anthropic splits one call's usage across TWO frames: `message_start`
    // carries the input/cache counts under `message.usage`, `message_delta`
    // carries only `output_tokens`. Keeping just the last frame therefore booked
    // streamed native-Anthropic calls (the passthrough path, i.e. Claude Code's
    // default) with zero prompt tokens. Raw objects are merged and normalized
    // ONCE at the end so `total_tokens` is derived from the merged pair rather
    // than from the output-only frame.
    let merged: JsonObject | undefined;

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
            // events as `response.usage`; chat SSE carries it at the event root;
            // Anthropic's `message_start` nests it under `message.usage`.
            const raw = isObject(parsed.usage)
                ? parsed.usage
                : isObject(parsed.response) && isObject(parsed.response.usage)
                  ? parsed.response.usage
                  : isObject(parsed.message) && isObject(parsed.message.usage)
                    ? parsed.message.usage
                    : undefined;

            if (raw) {
                merged = { ...merged, ...raw };
            }
        } catch (err) {
            logger.debug({ err, payloadPreview: payload.slice(0, 120) }, "ai-proxy usage: skipped SSE usage payload");
        }
    }

    return normalizeUsage(merged);
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
