import { OutboundUrlPolicyError } from "./url-policy.ts";

/**
 * Whether a failed token refresh means "sign in again" or "try again later".
 *
 * Only the authorization server can say that a grant is dead. A refresh that never reached it (no DNS, no route, a
 * refused or timed-out connection) or that reached it during an outage says nothing about the stored login, and a
 * gateway that answered either with a browser login opened a window that failed on the same network
 * (2026-10-30, rohlik: `getaddrinfo ENOTFOUND` on the token endpoint, then again on discovery).
 */
export type RefreshVerdict = { kind: "retry-later"; reason: string } | { kind: "login" };

/**
 * Transport codes that mean no answer came back. Node's `http` and `dns` use the `E*` codes; Bun's `fetch` uses the
 * camel-case ones (Bun 1.3.13 reports an unresolvable host as `ConnectionRefused` on some paths, `ENOTFOUND` on
 * others).
 */
const NETWORK_CODES = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ECONNREFUSED",
    "ECONNRESET",
    "ECONNABORTED",
    "ETIMEDOUT",
    "ENETUNREACH",
    "ENETDOWN",
    "EHOSTUNREACH",
    "EHOSTDOWN",
    "EPIPE",
    "ConnectionRefused",
    "ConnectionClosed",
    "FailedToOpenSocket",
]);

/** `OutboundUrlPolicyError` keeps only the lookup's message, so its code is read back out of the text. */
const DNS_POLICY_RE = /DNS resolution (?:failed|returned no addresses)/;
const CODE_IN_TEXT_RE = /\b(ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/;

/** How many `cause` links are followed; a deadline abort wraps its TimeoutError one level down. */
const MAX_CAUSE_DEPTH = 4;

function networkReason(error: unknown, depth: number): string | undefined {
    if (depth > MAX_CAUSE_DEPTH || typeof error !== "object" || error === null) {
        return undefined;
    }

    if (error instanceof OutboundUrlPolicyError) {
        if (!DNS_POLICY_RE.test(error.message)) {
            return undefined;
        }

        return error.message.match(CODE_IN_TEXT_RE)?.[1] ?? "DNS resolution failed";
    }

    const code = "code" in error ? error.code : undefined;

    if (typeof code === "string" && NETWORK_CODES.has(code)) {
        return code;
    }

    // `AbortSignal.timeout()`: a DOMException whose `code` is the NUMBER 23, so only the name says it.
    const name = "name" in error ? error.name : undefined;

    if (name === "TimeoutError") {
        return "timed out";
    }

    return networkReason("cause" in error ? error.cause : undefined, depth + 1);
}

/** A refresh that threw before the token endpoint answered. */
export function classifyRefreshError(error: unknown): RefreshVerdict {
    const reason = networkReason(error, 0);

    return reason ? { kind: "retry-later", reason } : { kind: "login" };
}

/** OAuth codes (RFC 6749 §5.2) with which the server itself says "not now". */
const TRANSIENT_OAUTH_CODES = new Set(["server_error", "temporarily_unavailable"]);

/**
 * A token endpoint that answered without a token. `code` is the bounded label from `safeTokenErrorCode` (a registered
 * OAuth code or `HTTP <status>`).
 */
export function classifyRefreshResponse(status: number, code: string): RefreshVerdict {
    if (status >= 500 || status === 429 || TRANSIENT_OAUTH_CODES.has(code)) {
        return { kind: "retry-later", reason: code };
    }

    return { kind: "login" };
}

/** The refresh could not reach a verdict. The stored login is kept; the caller retries later instead of logging in. */
export class TokenRefreshUnavailableError extends Error {
    readonly server: string;
    readonly reason: string;

    constructor(server: string, reason: string, cause?: unknown) {
        super(`Could not refresh the ${server} token (${reason}). The stored login is kept; retry in a moment.`, {
            cause,
        });
        this.name = "TokenRefreshUnavailableError";
        this.server = server;
        this.reason = reason;
    }
}
