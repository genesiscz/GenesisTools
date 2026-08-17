/**
 * The HTTP door's plumbing. Routes stay thin: parse, call a `lib/reports/*` function,
 * serialize. Any thrown Error becomes a 400 with its message, because every error these
 * reports raise is already written for a human ("no profile \"kaja\". Known: me").
 */
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:api" });

export interface ApiContext {
    request: Request;
    /** Path parameters for routes that declare them (`/api/report/$name`). */
    params?: Record<string, string>;
}

/**
 * Whether a thrown error is about the request or about the machine.
 *
 * The reports throw sentences written for a person ("no profile \"kaja\". Known: me"), and those
 * are the caller's problem: 400, message included. A missing file, an unreadable cache or a
 * programming error is not, and answering 500 for it says so plainly instead of blaming the
 * caller and handing them an internal message to puzzle over.
 */
function isClientError(err: unknown): boolean {
    if (err instanceof SyntaxError || err instanceof TypeError || err instanceof RangeError) {
        return false;
    }

    return !(err && typeof err === "object" && "code" in err && typeof err.code === "string");
}

export function apiHandler(
    fn: (ctx: ApiContext) => Promise<Response> | Response
): (ctx: ApiContext) => Promise<Response> {
    return async (ctx) => {
        try {
            return await fn(ctx);
        } catch (err) {
            log.warn({ url: ctx.request.url, err }, "api request failed");

            if (!isClientError(err)) {
                return Response.json({ error: "the server could not complete that request" }, { status: 500 });
            }

            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
        }
    };
}

/**
 * Same-origin guard for the write routes.
 *
 * A cross-site form POST is a "simple request": no preflight, response unreadable, but the
 * mutation still happens. Since the only write endpoint here edits the profile registry, any
 * page the user has open could otherwise delete a profile. Two checks, because either alone
 * has a gap: a JSON content type cannot be sent by a simple request at all, and the Origin
 * header covers clients that do send one.
 *
 * 🛑 What this is NOT: authentication. There is no session and no CSRF token, so anything that
 * can reach the port with a same-origin-looking request can edit the registry. That is
 * acceptable only because the server is bound to loopback (`DASHBOARDS.spotify.bindHost` is
 * "127.0.0.1", and the vite config passes it through). This API is trusted-local, single-user;
 * exposing it on another interface would need real authentication first.
 */
export function requireSameOrigin(request: Request): void {
    const type = request.headers.get("content-type") ?? "";
    if (!type.toLowerCase().includes("application/json")) {
        throw new Error("this endpoint requires a JSON request body (content-type: application/json)");
    }

    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) {
        throw new Error(`cross-origin request from ${origin} refused`);
    }
}

export async function jsonBody<T>(request: Request): Promise<T> {
    try {
        return (await request.json()) as T;
    } catch (err) {
        throw new Error(`could not parse the request body: ${err instanceof Error ? err.message : String(err)}`);
    }
}

const TRUE = new Set(["", "1", "true", "yes", "on"]);

/**
 * Query parameters answer to the CLI's own spelling as well as the camelCase one, so
 * `?min-ms=1000` and `?minMs=1000` are the same parameter. The promise these routes make is
 * that a URL is the command line, and a reader who knows `--all-plays` should not have to
 * discover that the HTTP door spells it differently.
 */
function readParam(params: URLSearchParams, key: string): string | null {
    const direct = params.get(key);
    if (direct !== null) {
        return direct;
    }

    const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

    return flag === key ? null : params.get(flag);
}

/**
 * A CLI flag carries no value, so `?trend` is the natural form and must read as true, not as
 * the empty string that `TRUE` would otherwise reject.
 */
export function boolParam(params: URLSearchParams, key: string): boolean | undefined {
    const raw = readParam(params, key);
    if (raw === null) {
        return undefined;
    }

    return TRUE.has(raw.toLowerCase());
}

export function strParam(params: URLSearchParams, key: string): string | undefined {
    const raw = readParam(params, key);

    return raw === null || raw === "" ? undefined : raw;
}
