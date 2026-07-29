import { webSessionHeaders } from "@app/timely/utils/cookie";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { TimelyHttpError, type TimelyRequestScope } from "./errors";

/** Without a deadline a stalled app.timelyapp.com leaves the CLI waiting forever with no output. */
const WEB_REQUEST_TIMEOUT_MS = 30_000;

export interface TimelyWebJsonOptions {
    url: string;
    accessToken: string;
    cookie?: string;
    scope: TimelyRequestScope;
    /** Prefix of the thrown message, e.g. "Memories request for 2026-07-24". */
    label: string;
    timeoutMs?: number;
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

    const response = await fetch(url, {
        method: "GET",
        headers: webSessionHeaders({ accessToken, cookie }),
        signal: AbortSignal.timeout(options.timeoutMs ?? WEB_REQUEST_TIMEOUT_MS),
    });

    const body = await response.text();

    if (!response.ok) {
        throw new TimelyHttpError(`${label} failed (${response.status}): ${body.slice(0, 200)}`, {
            status: response.status,
            scope,
            usedCookie: Boolean(cookie),
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
