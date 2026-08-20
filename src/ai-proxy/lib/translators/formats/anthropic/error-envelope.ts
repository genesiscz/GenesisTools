import { relayHeaders } from "@app/ai-proxy/lib/providers/http-relay";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/** Anthropic's documented error `type` for a status, as its own API returns them. */
function anthropicErrorType(status: number): string {
    switch (status) {
        case 400:
            return "invalid_request_error";
        case 401:
            return "authentication_error";
        case 403:
            return "permission_error";
        case 404:
            return "not_found_error";
        case 413:
            return "request_too_large";
        case 429:
            return "rate_limit_error";
        case 529:
            return "overloaded_error";
        default:
            return status >= 500 ? "api_error" : "invalid_request_error";
    }
}

/**
 * Re-wrap an OpenAI-shaped `{error:{message,…}}` body as Anthropic's
 * `{type:"error", error:{type,message}}`.
 *
 * A native `/v1/messages` passthrough answers an Anthropic client, and those
 * clients read `body.error.message` only after checking `body.type === "error"`.
 * Handing them the OpenAI envelope surfaced a blank failure instead of the real
 * upstream message. Headers and status are preserved.
 */
export async function toAnthropicErrorResponse(response: Response): Promise<Response> {
    const raw = await response.text();
    let message = raw;

    try {
        const parsed = SafeJSON.parse(raw, { strict: true });

        // Already Anthropic-shaped (the upstream's own error): pass it through.
        if (isObject(parsed) && parsed.type === "error" && isObject(parsed.error)) {
            return new Response(raw, {
                status: response.status,
                headers: relayHeaders(response),
            });
        }

        if (isObject(parsed) && isObject(parsed.error) && typeof parsed.error.message === "string") {
            message = parsed.error.message;
        }
    } catch (err) {
        logger.debug({ err }, "ai-proxy: upstream error body was not JSON — kept verbatim as the message");
    }

    const headers = relayHeaders(response);
    headers.set("Content-Type", "application/json");

    return new Response(
        SafeJSON.stringify({
            type: "error",
            error: { type: anthropicErrorType(response.status), message },
        }),
        { status: response.status, headers }
    );
}
