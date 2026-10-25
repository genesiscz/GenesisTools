import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

export interface OpenAiErrorEnvelope {
    error: {
        message: string;
        type: string;
        code?: string;
    };
}

/** Pull message/type/code out of a WHAM error body when it is JSON; else use the raw text. */
function parseUpstreamError(bodyText: string): { message?: string; type?: string; code?: string } {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return {};
        }

        const error = isObject(parsed.error) ? parsed.error : parsed;

        return {
            message: typeof error.message === "string" ? error.message : undefined,
            type: typeof error.type === "string" ? error.type : undefined,
            code: typeof error.code === "string" ? error.code : undefined,
        };
    } catch (err) {
        logger.debug({ err, bodyPreview: bodyText.slice(0, 200) }, "ai-proxy: WHAM error body is not JSON");
        return {};
    }
}

/**
 * Map a non-OK WHAM response that is not about the account to an OpenAI-shaped error envelope, keeping the upstream
 * message when parseable. Account failures (401, 429, a plan refusal, an overload) are `upstream-failure.ts`.
 */
export function mapWhamError({ status, bodyText }: { status: number; bodyText: string }): OpenAiErrorEnvelope {
    const upstream = parseUpstreamError(bodyText);

    return {
        error: {
            message: upstream.message ?? `ChatGPT upstream returned ${status}`,
            type: upstream.type ?? (status >= 500 ? "upstream_error" : "invalid_request_error"),
            code: upstream.code,
        },
    };
}

export function parseRetryAfterSeconds(headers: Headers): number | undefined {
    const raw = headers.get("retry-after");

    if (!raw) {
        return undefined;
    }

    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds;
    }

    const dateMs = Date.parse(raw);
    if (Number.isFinite(dateMs)) {
        return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
    }

    return undefined;
}
