import { abortableSleep } from "@genesiscz/utils/async";
import { logger } from "@genesiscz/utils/logger";

/**
 * One place for "authenticate this request, and cope when the token was rotated".
 *
 * Every subscription provider had grown its own copy of the same dance: resolve
 * the token per REQUEST rather than at detection time (a long-running process
 * otherwise keeps serving a token another process already rotated away, which
 * upstream answers with a 401), then on a 401 force a refresh and try once more.
 * Written once here, the resolvers stop drifting apart on the details.
 */

export interface AuthFetchOptions {
    /** Called before EVERY attempt, so a token rotated mid-process is picked up. */
    getToken: () => Promise<string>;
    /** Force-refresh path, tried exactly once per request after a 401. */
    refresh?: () => Promise<string>;
    /**
     * Retries on 429 and 5xx. Defaults to 0 ON PURPOSE.
     *
     * Every current caller sits underneath the ai-sdk, which already retries the
     * whole call (`maxRetries: 2`). Retrying here as well multiplies the attempts
     * against exactly the rate limit you most want to back off from, so retrying
     * is opt-in and belongs to callers that own the only retry layer.
     */
    maxRetries?: number;
    /** Transport underneath. Defaults to the global fetch. */
    fetch?: typeof fetch;
    baseDelayMs?: number;
    maxDelayMs?: number;
}

function isRetryable(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
}

/** `Retry-After` in seconds when the server sent one, else capped exponential. */
function backoffMs(response: Response, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
    const header = response.headers.get("retry-after");
    const seconds = header ? Number(header) : Number.NaN;

    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, maxDelayMs);
    }

    return Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
}

/**
 * A retry re-sends `init.body`, so a streaming request body cannot be retried.
 * Every caller here sends a JSON string; keep it that way or pass maxRetries: 0.
 */
export function composeAuthFetch(options: AuthFetchOptions): typeof fetch {
    const { getToken, refresh, maxRetries = 0, baseDelayMs = 500, maxDelayMs = 30_000 } = options;
    const transport = options.fetch ?? fetch;
    const { log } = logger.scoped("ai-core");

    const authFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const send = (bearer: string): Promise<Response> => {
            const headers = new Headers(init?.headers);
            headers.set("Authorization", `Bearer ${bearer}`);
            return transport(input, { ...init, headers });
        };

        for (let attempt = 0; ; attempt++) {
            let response = await send(await getToken());

            if (response.status === 401 && refresh) {
                log.debug({ url: String(input) }, "upstream rejected the token; forcing a refresh and retrying once");
                await discard(response);
                response = await send(await refresh());
            }

            if (!isRetryable(response.status) || attempt >= maxRetries) {
                return response;
            }

            const delay = backoffMs(response, attempt, baseDelayMs, maxDelayMs);
            log.warn(
                { status: response.status, attempt: attempt + 1, maxRetries, delayMs: delay },
                "upstream is rate limited or unavailable; backing off"
            );
            await discard(response);
            await abortableSleep(delay, init?.signal ?? undefined);
        }
    };

    // `typeof fetch` also carries `preconnect`, which no caller here uses.
    return authFetch as typeof fetch;
}

/** Release the body of a response we are about to throw away, so the socket is freed. */
async function discard(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch (err) {
        logger.scoped("ai-core").log.debug({ err }, "could not cancel a discarded response body");
    }
}
