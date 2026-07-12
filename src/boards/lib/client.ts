import { logger } from "@app/logger";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

// Canonical HTTP client for the dev-dashboard boards API — a thin fetch wrapper.
// `src/claude/mcp/tools/boards/http.ts` is a deliberately separate client with a different
// contract: it throws BoardsHttpError on any non-2xx response and only parses 2xx bodies.
// This client never throws on non-2xx — `watch.ts` depends on that to read the 409
// ConflictBody — so the two are intentionally not unified.

export const DEFAULT_BASE_URL = "http://127.0.0.1:3042";

/** Fallback abort timeout for requests that don't supply their own signal. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** `--base` flag > `BOARDS_BASE_URL` env override > loopback default. */
export function resolveBaseUrl(explicit?: string): string {
    return explicit ?? env.boards.getBaseUrl() ?? DEFAULT_BASE_URL;
}

/** Best-effort extraction of the server's `{error}` message from a non-2xx JSON body. */
function serverErrorText(body: unknown): string | undefined {
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
        return body.error;
    }

    return undefined;
}

export class BoardsHttpError extends Error {
    readonly status: number;
    readonly body: unknown;

    constructor(status: number, body: unknown, requestPath?: string) {
        const detail = serverErrorText(body);
        super(
            `boards request failed: ${status}` +
                (requestPath ? ` (${requestPath})` : "") +
                (detail ? ` — ${detail}` : "")
        );
        this.status = status;
        this.body = body;
    }
}

export interface HttpResult<T> {
    status: number;
    body: T;
}

/** Low-level request — never throws on a non-2xx status, so callers that need to
 *  branch on the status code (409 conflicts, transport-error backoff) can inspect it. */
export async function rawRequest<T>(base: string, path: string, init?: RequestInit): Promise<HttpResult<T>> {
    let res: Response;
    try {
        res = await fetch(`${base}${path}`, {
            ...init,
            signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `boards: cannot reach dev-dashboard at ${base} (${init?.method ?? "GET"} ${path}: ${msg}). ` +
                "Is it running? Start it with `tools dev-dashboard`, or point at another instance " +
                "via --base / BOARDS_BASE_URL."
        );
    }
    const text = await res.text();
    let body: T | undefined;
    if (text.length > 0) {
        try {
            body = SafeJSON.parse(text, { strict: true }) as T;
        } catch (err) {
            logger.debug({ err, status: res.status, path }, "boards: non-JSON response body");
            body = undefined;
        }
    }
    return { status: res.status, body: body as T };
}

export async function getJson<T>(base: string, path: string, signal?: AbortSignal): Promise<T> {
    const { status, body } = await rawRequest<T>(base, path, { signal });
    if (status < 200 || status >= 300) {
        throw new BoardsHttpError(status, body, `GET ${base}${path}`);
    }
    return body;
}

/** Bun's fetch UTF-8-encodes header values (unlike Go's latin1 net/http), so — unlike vitrinka's
 *  latin1 pre-encode — the actor is sent RAW: pre-encoding would double-encode under Bun. Operator
 *  names are sanitized to printable, ≤40-char strings, so they carry as-is; ASCII round-trips exactly. */
function actorHeader(actor: string): Record<string, string> {
    return { "x-board-actor": actor };
}

export async function postJson<T>(
    base: string,
    path: string,
    options?: { payload?: unknown; method?: string; signal?: AbortSignal; actor?: string }
): Promise<T> {
    const { payload, method = "POST", signal, actor } = options ?? {};
    const { status, body } = await rawRequest<T>(base, path, {
        method,
        headers: { "content-type": "application/json", ...(actor ? actorHeader(actor) : {}) },
        body: SafeJSON.stringify(payload ?? {}),
        signal,
    });
    if (status < 200 || status >= 300) {
        throw new BoardsHttpError(status, body, `${method} ${base}${path}`);
    }
    return body;
}

export async function putRaw<T>(
    base: string,
    path: string,
    data: Uint8Array,
    options: { contentType: string; signal?: AbortSignal; actor?: string }
): Promise<T> {
    const { contentType, signal, actor } = options;
    const { status, body } = await rawRequest<T>(base, path, {
        method: "PUT",
        headers: { "content-type": contentType, ...(actor ? actorHeader(actor) : {}) },
        // A bare `Uint8Array` parameter type-widens to Uint8Array<ArrayBufferLike>, which isn't
        // assignable to fetch's BodyInit under TS 5.7 typed-array generics (same quirk as
        // dev-dashboard/lib/boards/tar.ts); copy into a concrete ArrayBuffer-backed view.
        body: new Uint8Array(data),
        signal,
    });
    if (status < 200 || status >= 300) {
        throw new BoardsHttpError(status, body, `PUT ${base}${path}`);
    }
    return body;
}
