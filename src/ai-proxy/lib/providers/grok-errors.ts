import type { OpenAiErrorEnvelope } from "@app/ai-proxy/lib/providers/wham-errors";
import { SafeJSON } from "@genesiscz/utils/json";
import { isObject } from "@genesiscz/utils/object";

/**
 * Grok's chat proxy reports errors as `{"code":"invalid-argument","error":"…"}`
 * — the message is a STRING `error` field, not the OpenAI `{error:{message}}`
 * envelope. OpenAI SDK clients that can't parse the envelope fall back to the
 * bare statusText ("Bad Request"), hiding the actual reason.
 */
function parseGrokUpstreamError(bodyText: string): { message?: string; type?: string; code?: string } {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true });

        if (!isObject(parsed)) {
            return {};
        }

        if (typeof parsed.error === "string") {
            return {
                message: parsed.error,
                code: typeof parsed.code === "string" ? parsed.code : undefined,
            };
        }

        const error = isObject(parsed.error) ? parsed.error : parsed;

        return {
            message: typeof error.message === "string" ? error.message : undefined,
            type: typeof error.type === "string" ? error.type : undefined,
            code: typeof error.code === "string" ? error.code : undefined,
        };
    } catch {
        const trimmed = bodyText.trim();
        return trimmed ? { message: trimmed.slice(0, 500) } : {};
    }
}

/** Map a non-OK Grok upstream response to an OpenAI-shaped error envelope. */
export function mapGrokError({
    status,
    bodyText,
    retryAfterSec,
}: {
    status: number;
    bodyText: string;
    retryAfterSec?: number;
}): OpenAiErrorEnvelope {
    const upstream = parseGrokUpstreamError(bodyText);

    if (status === 429) {
        const hint = retryAfterSec != null ? ` Retry after ${retryAfterSec}s.` : " Retry later.";

        return {
            error: {
                message: `${upstream.message ?? "Grok rate limit hit."}${hint}`,
                type: "rate_limit_error",
                code: upstream.code ?? "rate_limit_exceeded",
            },
        };
    }

    return {
        error: {
            message: upstream.message ?? `Grok upstream returned ${status}`,
            type: upstream.type ?? (status >= 500 ? "upstream_error" : "invalid_request_error"),
            code: upstream.code,
        },
    };
}
