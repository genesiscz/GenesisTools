import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

export type JwtObject = Record<string, unknown>;

export type DecodeResult =
    | { ok: true; header: JwtObject; payload: JwtObject; signature: string }
    | { ok: false; error: string };

function decodeSegment(segment: string, label: "header" | "payload"): JwtObject | { error: string } {
    let decoded: string;
    try {
        decoded = Buffer.from(segment, "base64url").toString("utf-8");
    } catch (err) {
        logger.debug({ err, label }, "jwt: base64url decode failed");
        return { error: `failed to base64url-decode the ${label} segment.` };
    }

    let parsed: unknown;
    try {
        parsed = SafeJSON.parse(decoded, { strict: true });
    } catch (err) {
        logger.debug({ err, label }, "jwt: JSON parse failed");
        return { error: `the ${label} segment is not valid JSON.` };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { error: `the ${label} segment is not a JSON object.` };
    }

    return parsed as JwtObject;
}

function isErrorResult(result: JwtObject | { error: string }): result is { error: string } {
    return typeof (result as { error?: unknown }).error === "string";
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
    if (isErrorResult(header)) {
        return { ok: false, error: header.error };
    }

    const payload = decodeSegment(payloadSeg, "payload");
    if (isErrorResult(payload)) {
        return { ok: false, error: payload.error };
    }

    return { ok: true, header, payload, signature };
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
