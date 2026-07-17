import { createHash, timingSafeEqual } from "node:crypto";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import type { YoutubeDatabase } from "@app/youtube/lib/db";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import type { YtUser } from "@app/youtube/lib/users.types";

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

/**
 * Resolve the configured service keys, failing closed when the value is present
 * but yields no usable keys. A missing value (`undefined` — env normalizes an
 * unset, empty, or whitespace-only var to `undefined`) keeps the server open so
 * localhost development is unaffected. A value that is present but parses to zero
 * keys (e.g. `",,,"`) throws instead of silently falling back to open mode, so a
 * typo'd `YOUTUBE_SERVICE_KEY` can't quietly expose the whole API.
 */
export function resolveServiceKeys(raw: string | undefined): string[] {
    const keys = parseServiceKeys(raw);

    if (raw && keys.length === 0) {
        throw new Error("YOUTUBE_SERVICE_KEY is set but contains no valid service keys (check for stray commas)");
    }

    return keys;
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

export const USER_TOKEN_PREFIX = "ytu_";

/**
 * Returns a 401 `Response` when auth is enabled and the request lacks a valid
 * key, or `null` when the request may proceed. With no keys configured every
 * request proceeds (open mode).
 */
export function requireServiceKey(req: Request, keys: string[], db?: YoutubeDatabase): Response | null {
    if (keys.length === 0) {
        return null;
    }

    const token = extractServiceToken(req);
    const method = req.method;
    const path = new URL(req.url).pathname;

    // A valid per-user token satisfies the top-level gate too: user routes
    // re-check identity via requireUser/resolveUser, and browser surfaces
    // (<audio> tags, WS handshakes) can only present the ytu_ token.
    if (token?.startsWith(USER_TOKEN_PREFIX) && db?.getUserByToken(token)) {
        logger.debug({ method, path }, "youtube API: accepted request with valid user token");

        return null;
    }

    if (!token || !tokenMatchesAny(token, keys)) {
        // Log the decision — never the presented key — so auth failures are
        // triageable from the logs alone, distinguishing a missing key from a
        // wrong one.
        logger.warn({ method, path, reason: token ? "invalid-key" : "no-key" }, "youtube API: rejected request");

        return new Response(
            SafeJSON.stringify({ error: { message: "Invalid or missing service key", type: "auth_error" } }),
            {
                status: 401,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS },
            }
        );
    }

    logger.debug({ method, path }, "youtube API: accepted request with valid service key");

    return null;
}

/**
 * Returns the authenticated user, or a ready 401 JSON Response. Never throws.
 *
 * Token source: `Authorization: Bearer ytu_…` header first, then
 * `?access_token=` query param (WS-style fallback). Tokens without the `ytu_`
 * prefix are ignored here — they may be service keys handled elsewhere.
 */
/**
 * Best-effort user resolution for routes that stay open without a login
 * (locked-artifact GETs, estimates). Same token sources as `requireUser`,
 * but a missing/invalid token yields `null` instead of a 401.
 */
export function resolveUser(req: Request, url: URL, db: YoutubeDatabase): YtUser | null {
    const presented = extractBearerToken(req) ?? url.searchParams.get("access_token");
    const token = presented?.startsWith(USER_TOKEN_PREFIX) ? presented : null;

    return token ? db.getUserByToken(token) : null;
}

export function requireUser(req: Request, url: URL, db: YoutubeDatabase): YtUser | Response {
    const presented = extractBearerToken(req) ?? url.searchParams.get("access_token");
    const token = presented?.startsWith(USER_TOKEN_PREFIX) ? presented : null;
    const user = token ? db.getUserByToken(token) : null;

    if (user) {
        return user;
    }

    logger.warn(
        {
            method: req.method,
            path: url.pathname,
            reason: token ? "invalid-token" : "no-token",
            tokenPrefix: token?.slice(0, 8),
        },
        "youtube API: user auth required"
    );

    return new Response(SafeJSON.stringify({ error: "login required", code: "login_required" }, { strict: true }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
