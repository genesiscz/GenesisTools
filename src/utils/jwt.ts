import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export type JwtObject = Record<string, unknown>;

export type DecodeResult =
    | { ok: true; header: JwtObject; payload: JwtObject; signature: string }
    | { ok: false; error: string };

type SegmentResult = { ok: true; value: JwtObject } | { ok: false; error: string };

function decodeSegment(segment: string, label: "header" | "payload"): SegmentResult {
    let decoded: string;
    try {
        decoded = Buffer.from(segment, "base64url").toString("utf-8");
    } catch (err) {
        logger.debug({ err, label }, "jwt: base64url decode failed");
        return { ok: false, error: `failed to base64url-decode the ${label} segment.` };
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(decoded, { strict: true });
    } catch (err) {
        logger.debug({ err, label }, "jwt: JSON parse failed");
        return { ok: false, error: `the ${label} segment is not valid JSON.` };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: `the ${label} segment is not a JSON object.` };
    }

    return { ok: true, value: parsed as JwtObject };
}

export function decodeJwt(token: string): DecodeResult {
    const segments = token.trim().split(".");

    if (segments.length !== 3 || segments.some((s) => s.length === 0)) {
        return {
            ok: false,
            error: `not a valid JWT — expected 3 dot-separated segments, got ${segments.length}.`,
        };
    }

    const [headerSeg, payloadSeg, signature] = segments;

    const header = decodeSegment(headerSeg, "header");
    if (!header.ok) {
        return { ok: false, error: header.error };
    }

    const payload = decodeSegment(payloadSeg, "payload");
    if (!payload.ok) {
        return { ok: false, error: payload.error };
    }

    return { ok: true, header: header.value, payload: payload.value, signature };
}

export type TimeClaim = "exp" | "iat" | "nbf";

export function humanizeDelta(absMs: number): string {
    const seconds = Math.floor(absMs / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h`;
    }

    const days = Math.floor(hours / 24);
    return `${days}d`;
}

// NumericDate claims are unix SECONDS → ×1000 to compare against nowMs.
export function describeClaimTime(claim: TimeClaim, valueSeconds: number, nowMs: number): string {
    const targetMs = valueSeconds * 1000;
    const deltaMs = targetMs - nowMs;
    const isPast = deltaMs < 0;
    const phrase = humanizeDelta(Math.abs(deltaMs));

    if (claim === "exp") {
        return isPast ? `EXPIRED ${phrase} ago` : `expires in ${phrase}`;
    }

    return isPast ? `${phrase} ago` : `in ${phrase}`;
}

const WRAPPING_QUOTES = new Set(['"', "'", "`"]);
const BEARER_PREFIX = /^bearer\s+/i;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const JWT_CANDIDATES = /(?<![A-Za-z0-9_-])(?=([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+))/g;
const BRACED_TEXT = /^[ \t\n\r]*\{[\s\S]*\}[ \t\n\r]*$/;

/**
 * A JWT header is a JSON object, which is what tells a token from other dotted text such as `example.com.au`.
 * Pretty-printed headers are valid JSON that does not encode to an `ey` prefix, so the decoded header is checked.
 * The braces test comes first so that ordinary words never reach the JSON parse and its debug log.
 */
function hasJsonObjectHeader(token: string): boolean {
    const headerSegment = token.slice(0, token.indexOf("."));
    const decoded = Buffer.from(headerSegment, "base64url").toString("utf-8");
    return BRACED_TEXT.test(decoded) && decodeSegment(headerSegment, "header").ok;
}

function isJwtShaped(text: string): boolean {
    return JWT_SHAPE.test(text) && hasJsonObjectHeader(text);
}

function stripWrappingQuotes(text: string): string {
    let result = text;
    while (result.length >= 2 && WRAPPING_QUOTES.has(result[0]) && result.at(-1) === result[0]) {
        result = result.slice(1, -1).trim();
    }

    return result;
}

/** Strips the whitespace, quotes and `Bearer ` prefix that surround a token copied from a header or a shell. */
export function normalizeTokenText(raw: string): string {
    const unquoted = stripWrappingQuotes(raw.trim());
    return stripWrappingQuotes(unquoted.replace(BEARER_PREFIX, "").trim());
}

/**
 * Finds the JWT in text a user copied. A whole value that is a token (after `normalizeTokenText`, and after
 * removing line breaks a chat or an email put inside it) wins; otherwise the first token inside the text. Returns
 * null when nothing has the three-part JWT shape with a JSON object header. This checks the shape only;
 * `decodeJwt` decides validity.
 */
export function extractJwt(raw: string): string | null {
    const normalized = normalizeTokenText(raw);
    if (isJwtShaped(normalized)) {
        return normalized;
    }

    const unwrapped = normalized.replace(/\s+/g, "");
    if (isJwtShaped(unwrapped)) {
        return unwrapped;
    }

    for (const match of normalized.matchAll(JWT_CANDIDATES)) {
        if (hasJsonObjectHeader(match[1])) {
            return match[1];
        }
    }

    return null;
}
