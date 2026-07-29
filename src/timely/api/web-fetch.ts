import { webSessionHeaders } from "@app/timely/utils/cookie";
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

    if (!response.ok) {
        const body = (await response.text()).slice(0, 200);
        throw new TimelyHttpError(`${label} failed (${response.status}): ${body}`, {
            status: response.status,
            scope,
            usedCookie: Boolean(cookie),
        });
    }

    return response.json();
}
