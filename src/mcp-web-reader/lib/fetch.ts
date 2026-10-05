import { logger } from "@genesiscz/utils/logger";

const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchedPage {
    body: string;
    /** The address after redirects; relative links resolve against it. */
    url: string;
}

/** The caller's headers may go to `to` when it is the origin they were meant for, or that host upgraded to https. */
export function keepsHeaders(from: URL, to: URL): boolean {
    if (to.origin === from.origin) {
        return true;
    }

    return (
        from.protocol === "http:" &&
        to.protocol === "https:" &&
        to.hostname === from.hostname &&
        from.port === "" &&
        to.port === ""
    );
}

/** Where a redirect response points, or null for any other response. Only http and https addresses are followed. */
function redirectTarget(response: Response, from: URL): URL | null {
    const location = response.headers.get("location");

    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
        return null;
    }

    const target = URL.parse(location, from);

    if (target === null || (target.protocol !== "http:" && target.protocol !== "https:")) {
        throw new Error(`Refusing the redirect from ${from.href} to ${location}: it is not an http or https address`);
    }

    return target;
}

/**
 * GET a page as text. Up to 5 redirects are followed by hand, so the caller's headers go only to the origin they
 * were meant for and never to a `file:` or other non-http address. A non-2xx status throws, and the request is cut
 * after 30 s or when `signal` aborts (an MCP client cancelling the call). Header values never reach the log.
 */
export async function fetchPage(
    url: string,
    options: { headers?: Record<string, string>; signal?: AbortSignal } = {}
): Promise<FetchedPage> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const start = new URL(url);
    let current = start;
    let response: Response;

    logger.debug({ url, headerNames: Object.keys(options.headers ?? {}) }, "mcp-web-reader fetch");

    for (let redirects = 0; ; redirects++) {
        response = await fetch(current, {
            headers: {
                "User-Agent": USER_AGENT,
                Accept: "*/*",
                ...(keepsHeaders(start, current) ? options.headers : {}),
            },
            redirect: "manual",
            signal,
        });
        const next = redirectTarget(response, current);

        if (next === null) {
            break;
        }

        await response.body?.cancel();

        if (redirects >= MAX_REDIRECTS) {
            throw new Error(`More than ${MAX_REDIRECTS} redirects for ${url}`);
        }

        if (!keepsHeaders(start, next)) {
            logger.debug({ from: current.origin, to: next.origin }, "mcp-web-reader redirected to another origin");
        }

        current = next;
    }

    if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const body = await response.text();
    logger.debug(
        { url, finalUrl: current.href, status: response.status, chars: body.length },
        "mcp-web-reader fetched"
    );

    return { body, url: current.href };
}
