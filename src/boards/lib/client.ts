import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

// Canonical HTTP client for the dev-dashboard boards API — a thin fetch wrapper.
// `src/claude/mcp/tools/boards/http.ts` is a deliberately separate client with a different
// contract: it throws BoardsHttpError on any non-2xx response and only parses 2xx bodies.
// This client never throws on non-2xx — `watch.ts` depends on that to read the 409
// ConflictBody — so the two are intentionally not unified.

export const DEFAULT_BASE_URL = "http://127.0.0.1:3042";

/** `--base` flag > `BOARDS_BASE_URL` env override > loopback default. */
export function resolveBaseUrl(explicit?: string): string {
    return explicit ?? env.boards.getBaseUrl() ?? DEFAULT_BASE_URL;
}

export class BoardsHttpError extends Error {
    readonly status: number;
    readonly body: unknown;

    constructor(status: number, body: unknown) {
        super(`boards request failed: ${status}`);
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
    const res = await fetch(`${base}${path}`, init);
    const text = await res.text();
    let body: T | undefined;
    if (text.length > 0) {
        try {
            body = SafeJSON.parse(text, { strict: true }) as T;
        } catch {
            body = undefined;
        }
    }
    return { status: res.status, body: body as T };
}

export async function getJson<T>(base: string, path: string, signal?: AbortSignal): Promise<T> {
    const { status, body } = await rawRequest<T>(base, path, { signal });
    if (status < 200 || status >= 300) {
        throw new BoardsHttpError(status, body);
    }
    return body;
}

export async function postJson<T>(
    base: string,
    path: string,
    options?: { payload?: unknown; method?: string; signal?: AbortSignal }
): Promise<T> {
    const { payload, method = "POST", signal } = options ?? {};
    const { status, body } = await rawRequest<T>(base, path, {
        method,
        headers: { "content-type": "application/json" },
        body: SafeJSON.stringify(payload ?? {}),
        signal,
    });
    if (status < 200 || status >= 300) {
        throw new BoardsHttpError(status, body);
    }
    return body;
}

export async function putRaw<T>(
    base: string,
    path: string,
    data: Uint8Array,
    contentType: string,
    signal?: AbortSignal
): Promise<T> {
    const { status, body } = await rawRequest<T>(base, path, {
        method: "PUT",
        headers: { "content-type": contentType },
        // A bare `Uint8Array` parameter type-widens to Uint8Array<ArrayBufferLike>, which isn't
        // assignable to fetch's BodyInit under TS 5.7 typed-array generics (same quirk as
        // dev-dashboard/lib/boards/tar.ts); copy into a concrete ArrayBuffer-backed view.
        body: new Uint8Array(data),
        signal,
    });
    if (status < 200 || status >= 300) {
        throw new BoardsHttpError(status, body);
    }
    return body;
}
