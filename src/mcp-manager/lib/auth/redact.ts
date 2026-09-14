import { GATEWAY_HEADER, REDACTED } from "./constants.ts";

const HEADER_KEYS = new Set(["authorization", GATEWAY_HEADER.toLowerCase(), "x-api-key", "proxy-authorization"]);

export function redactMcpValue<T>(value: T): T {
    return walk(value, undefined) as T;
}

/**
 * Redact every value of a connection's headers, regardless of key name.
 *
 * `redactMcpValue`'s key-pattern heuristic (`authorization`, `x-api-key`, `/token|secret/`,
 * ...) is a good default for a whole config object, but a server's own `headers` block can
 * name a credential under any header a remote API happens to require. A caller printing a
 * connection to a PUBLIC surface (`list --json` without `internal`) must not gamble on the
 * key naming convention: every header value is a secret until a caller proves it is about to
 * dial the connection and needs the real thing.
 */
export function redactHeaderValues(headers: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.keys(headers).map((key) => [key, REDACTED]));
}

/** RFC 6749 §5.2 plus the RFC 8628 additions. Nothing else is a safe thing to echo. */
const OAUTH_ERROR_CODES = new Set([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "invalid_target",
    "access_denied",
    "expired_token",
    "authorization_pending",
    "slow_down",
    "server_error",
    "temporarily_unavailable",
]);

/**
 * A bounded, non-secret label for a failed token-endpoint response.
 *
 * The raw body is never it. That body is persisted into auth-status.json and printed to
 * the terminal, and a server that answers a token request with something unexpected —
 * an echoed Authorization header, a debug dump, a signed assertion — puts a credential
 * in both places. A registered error code is a closed vocabulary, so it is safe; a
 * status line is safe; anything else collapses to the status alone.
 */
export function safeTokenErrorCode(error: unknown, status: number): string {
    if (typeof error === "string" && OAUTH_ERROR_CODES.has(error)) {
        return error;
    }

    return `HTTP ${status}`;
}

function walk(value: unknown, key: string | undefined): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => walk(item, key));
    }

    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};

        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = walk(v, k);
        }

        return out;
    }

    if (typeof value === "string" && value.length > 0 && key && HEADER_KEYS.has(key.toLowerCase())) {
        return REDACTED;
    }

    if (typeof value === "string" && value.length > 0 && key && /token|secret|password|api[-_]?key/i.test(key)) {
        return REDACTED;
    }

    return value;
}
