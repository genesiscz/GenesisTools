import { createHash, timingSafeEqual } from "node:crypto";
import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";

/**
 * Optional per-user service-key auth for the YouTube API server.
 *
 * Enabled only when at least one key is configured (via `YOUTUBE_SERVICE_KEY`,
 * a comma-separated list — one key per user). When no key is configured the
 * server stays open, so localhost development is unaffected.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket handshake, so
 * the key may also be supplied as an `access_token` (or `key`) query
 * parameter. Both the HTTP routes and the `/api/v1/events` WS upgrade run
 * through `requireServiceKey`.
 */

/** Split the comma-separated key list into individual keys, dropping blanks. */
export function parseServiceKeys(raw: string | undefined): string[] {
    if (!raw) {
        return [];
    }

    return raw
        .split(",")
        .map((key) => key.trim())
        .filter((key) => key.length > 0);
}

export function extractBearerToken(req: Request): string | null {
    const header = req.headers.get("Authorization");

    if (!header) {
        return null;
    }

    const match = header.match(/^Bearer\s+(.+)$/i);
    return match?.[1] ?? null;
}

/** Bearer header first, then `?access_token=` / `?key=` (for WebSocket handshakes). */
export function extractServiceToken(req: Request): string | null {
    const bearer = extractBearerToken(req);

    if (bearer) {
        return bearer;
    }

    const url = new URL(req.url);
    return url.searchParams.get("access_token") ?? url.searchParams.get("key");
}

function tokenMatchesAny(presented: string, keys: string[]): boolean {
    // Hash both sides to fixed 32-byte SHA-256 digests before comparing: a raw
    // length guard before timingSafeEqual would leak the configured keys' lengths
    // via loop timing. Digests are always equal length, so the compare never
    // varies with the presented token's length. No early-exit so a valid key
    // later in the list is not distinguishable by timing from one earlier.
    const presentedHash = createHash("sha256").update(presented).digest();
    let matched = false;

    for (const key of keys) {
        const keyHash = createHash("sha256").update(key).digest();

        if (timingSafeEqual(presentedHash, keyHash)) {
            matched = true;
        }
    }

    return matched;
}

/**
 * Returns a 401 `Response` when auth is enabled and the request lacks a valid
 * key, or `null` when the request may proceed. With no keys configured every
 * request proceeds (open mode).
 */
export function requireServiceKey(req: Request, keys: string[]): Response | null {
    if (keys.length === 0) {
        return null;
    }

    const token = extractServiceToken(req);

    if (!token || !tokenMatchesAny(token, keys)) {
        return new Response(
            SafeJSON.stringify({ error: { message: "Invalid or missing service key", type: "auth_error" } }),
            {
                status: 401,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
            }
        );
    }

    return null;
}
