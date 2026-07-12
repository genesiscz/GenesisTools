import { logger } from "@app/logger";

/**
 * When a proxy client hangs up, the `req.signal` we forward to the upstream
 * fetch (or SSE read) rejects with an `AbortError`. That is not an upstream
 * failure — logging it as warn + returning 502 is noise. Detect the client
 * abort, log it at debug, and return a 499 ("Client Closed Request"); callers
 * fall through to their real warn + 502 handling when this returns `null`.
 */
export function clientAbortResponse(err: unknown, context: Record<string, unknown>): Response | null {
    if (err instanceof Error && err.name === "AbortError") {
        logger.debug(context, "ai-proxy: upstream request aborted by client");
        return new Response("Aborted", { status: 499 });
    }

    return null;
}
