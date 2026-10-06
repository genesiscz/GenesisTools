import { webSessionHeaders } from "@app/timely/utils/cookie";
import { abortableSleep } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isSessionRedirect, TimelyHttpError, type TimelyRequestScope } from "./errors";

/** Without a deadline a stalled app.timelyapp.com leaves the CLI waiting forever with no output. */
const WEB_REQUEST_TIMEOUT_MS = 30_000;

export interface TimelyWebRequestOptions {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
}

function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
    const abortSignalWithAny = AbortSignal as typeof AbortSignal & {
        any?: (signals: AbortSignal[]) => AbortSignal;
    };

    if (abortSignalWithAny.any) {
        return abortSignalWithAny.any(signals);
    }

    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const cleanup = () => {
        for (const [signal, listener] of listeners) {
            signal.removeEventListener("abort", listener);
        }
        listeners.clear();
    };

    for (const signal of signals) {
        const listener = () => {
            controller.abort(signal.reason);
            cleanup();
        };
        listeners.set(signal, listener);

        if (signal.aborted) {
            listener();
            break;
        }

        signal.addEventListener("abort", listener, { once: true });
    }

    return controller.signal;
}

/**
 * Every request to a Timely web host goes through here, so the redirect policy is
 * decided once. Following redirects is what turns a rejected session into a 200
 * sign-in page, which then reads as an ordinary (empty, or malformed) result. Both
 * the login probe and the runtime fetches need that not to happen, and a rule that
 * has to be remembered at two call sites is a rule that gets remembered at one.
 */
export function fetchTimelyWebResponse(options: TimelyWebRequestOptions): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? combineAbortSignals([options.signal, timeoutSignal]) : timeoutSignal;

    return fetch(options.url, {
        method: "GET",
        headers: options.headers,
        redirect: "manual",
        signal,
    });
}

export interface TimelyWebJsonOptions {
    url: string;
    accessToken: string;
    cookie?: string;
    scope: TimelyRequestScope;
    /** Prefix of the thrown message, e.g. "Memories request for 2026-07-24". */
    label: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}

const rateLimitUntil = new Map<string, number>();

export function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
    if (!value) {
        return undefined;
    }

    const seconds = Number(value);

    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.ceil(seconds * 1000);
    }

    const dateMs = Date.parse(value);

    if (Number.isNaN(dateMs)) {
        return undefined;
    }

    return Math.max(0, dateMs - nowMs);
}

function limiterKey(url: string): string {
    const parsed = new URL(url);
    const account = parsed.pathname.split("/").filter(Boolean)[0] ?? "global";

    return `${parsed.origin}/${account}`;
}

async function waitForRateLimit(key: string, signal?: AbortSignal): Promise<void> {
    const remaining = (rateLimitUntil.get(key) ?? 0) - Date.now();

    if (remaining > 0) {
        await abortableSleep(remaining, signal);
    }
}

/**
 * One GET against a Timely web host (app.timelyapp.com), which authenticates
 * with the browser session cookie rather than the OAuth bearer.
 *
 * Every caller needs the same three things on failure (the status code, which
 * surface failed, and whether a cookie was sent), because those decide which
 * remedy `reportTimelyFailure` prints. Keeping that in one place is why memories,
 * entries and suggested_entries no longer each build their own TimelyHttpError.
 */
export async function fetchTimelyWebJson(options: TimelyWebJsonOptions): Promise<unknown> {
    const { url, accessToken, cookie, scope, label } = options;
    const key = limiterKey(url);

    for (let attempt = 0; attempt < 2; attempt++) {
        await waitForRateLimit(key, options.signal);

        const response = await fetchTimelyWebResponse({
            url,
            headers: webSessionHeaders({ accessToken, cookie }),
            timeoutMs: options.timeoutMs ?? WEB_REQUEST_TIMEOUT_MS,
            signal: options.signal,
        });
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));

        if (response.status === 429 && retryAfterMs !== undefined && attempt === 0) {
            rateLimitUntil.set(key, Math.max(rateLimitUntil.get(key) ?? 0, Date.now() + retryAfterMs));
            await response.text();
            continue;
        }

        if (isSessionRedirect(response.status)) {
            // Kept as the real 3xx rather than a fabricated 401, because isTimelyAuthFailure
            // now treats it as a refused session either way: the loop aborts on the first
            // date and reportTimelyFailure names the cookie, instead of thirty empty days.
            throw new TimelyHttpError(
                `${label} was redirected to a sign-in page (${response.status}), so the session was not accepted`,
                { status: response.status, scope, usedCookie: Boolean(cookie) }
            );
        }

        const body = await response.text();

        if (!response.ok) {
            throw new TimelyHttpError(`${label} failed (${response.status}): ${body.slice(0, 200)}`, {
                status: response.status,
                scope,
                usedCookie: Boolean(cookie),
                retryAfterMs,
            });
        }

        try {
            // Strict, so a remote body is held to real JSON rather than this repo's
            // comment/trailing-comma tolerance.
            return SafeJSON.parse(body, { strict: true });
        } catch (err) {
            // A 200 carrying HTML is how a web host serves a sign-in page, so the body is
            // the only clue the caller gets. Keep the real status rather than inventing a
            // 401: this stays a plain request failure, but one that names the surface and
            // shows the body, instead of a bare SyntaxError from deep inside fetch.
            logger.debug({ err, url, scope }, "Timely returned a body that is not JSON");
            throw new TimelyHttpError(`${label} returned a non-JSON body (${response.status}): ${body.slice(0, 200)}`, {
                status: response.status,
                scope,
                usedCookie: Boolean(cookie),
            });
        }
    }

    throw new Error("Timely request retry loop ended unexpectedly");
}
