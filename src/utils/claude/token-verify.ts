import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

/**
 * Live verification of long-lived setup tokens (`sk-ant-oat…`).
 *
 * The failure this exists to catch: a paste box that truncates the token, plus
 * Claude Code SILENTLY falling back to the keychain login when
 * CLAUDE_CODE_OAUTH_TOKEN gets a 401. The session then runs as the wrong
 * account with no error anywhere. A length gate plus one live call at capture
 * turns that silent misroute into a loud failure.
 *
 * The `user-agent` header is REQUIRED — without a claude-cli UA the inference
 * endpoint rejects even valid oat tokens with 401.
 */

/** Real oat tokens are ~108 chars; materially shorter means a truncated paste. */
export const LONG_TOKEN_MIN_LENGTH = 100;

export type TokenVerdict = "ok" | "limited" | "invalid" | "unreachable";

/** A stored token that exists but is short is a truncated paste — treat it as absent. */
export function hasValidLongLivedToken(tokens: { longLivedToken?: string }): boolean {
    return Boolean(tokens.longLivedToken && tokens.longLivedToken.length >= LONG_TOKEN_MIN_LENGTH);
}

/** Length-valid and not past a known mint expiry. Pasted tokens have no expiry, so they stay usable. */
export function longLivedTokenUsable(tokens: { longLivedToken?: string; longLivedTokenExpiresAt?: number }): boolean {
    if (!hasValidLongLivedToken(tokens)) {
        return false;
    }

    if (tokens.longLivedTokenExpiresAt !== undefined && tokens.longLivedTokenExpiresAt <= Date.now()) {
        return false;
    }

    return true;
}

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** A blackholed connection must not hang an interactive login forever. */
const VERIFY_TIMEOUT_MS = 15_000;

/**
 * Read-only liveness probe: a GET that spends nothing.
 *
 * `verifyLongLivedToken` below proves the token by making a real inference request. That
 * is right at CAPTURE time — the user just pasted a token and asked "is it good?" — but
 * wrong for a DIAGNOSTIC, which must not consume quota, create provider-side history, or
 * perturb the rate-limit state it was invoked to report on. `tools claude doctor` uses
 * this one; nothing here writes.
 */
/**
 * A 403 whose body says the SCOPE was insufficient, not that the caller was
 * unknown. Setup tokens (`sk-ant-oat…`) are minted for inference and never
 * carry `user:profile`, so the profile endpoint answers every healthy oat token
 * with `permission_error: OAuth token does not meet scope requirement
 * any_of(user:profile, user:office)`.
 *
 * Reaching a scope check PROVES authentication: the server resolved the token
 * to a live grant before evaluating what that grant may do. An expired or
 * revoked token never gets that far — it answers 401 `authentication_error`.
 */
export function isScopeRefusal(status: number, body: string): boolean {
    if (status !== 403) {
        return false;
    }

    return /permission_error/.test(body) && /scope/i.test(body);
}

/**
 * Auth verdict for one probe response. Split out from the request so the
 * status/body mapping is unit-testable — the bug it exists to prevent shipped
 * for months because only the live call could exercise it.
 */
export function verdictFromProbeResponse(status: number, body: string): TokenVerdict {
    if (isScopeRefusal(status, body)) {
        return "ok";
    }

    if (status === 401 || status === 403) {
        return "invalid";
    }

    if (status === 429) {
        return "limited";
    }

    if (status < 200 || status >= 300) {
        // Not an auth verdict — say so rather than inventing one.
        return "unreachable";
    }

    return "ok";
}

export async function probeLongLivedToken(token: string): Promise<TokenVerdict> {
    try {
        const res = await fetch(PROFILE_URL, {
            method: "GET",
            headers: {
                authorization: `Bearer ${token}`,
                "anthropic-beta": "oauth-2025-04-20",
                accept: "application/json",
                "user-agent": "claude-cli/2.1.214 (external, cli)",
            },
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });

        const body = res.ok ? "" : await res.text().catch(() => "");
        const verdict = verdictFromProbeResponse(res.status, body);

        if (verdict === "unreachable") {
            logger.warn(`[token-verify] probe returned ${res.status}, treating as unreachable: ${body.slice(0, 200)}`);
        } else if (verdict === "invalid") {
            logger.debug(`[token-verify] probe: token rejected with ${res.status}`);
        } else if (res.status === 403) {
            logger.debug("[token-verify] probe: token authenticated but lacks user:profile scope (expected for oat)");
        }

        return verdict;
    } catch (error) {
        logger.debug({ error }, "[token-verify] probe request failed");
        return "unreachable";
    }
}

/**
 * POST /v1/messages with the oat-required claude-cli user-agent.
 *
 * Capture-time verify and warmup fallback share this: oat tokens reject 401
 * without that UA, and ChatEngine does not send it.
 */
export async function sendLongLivedInferencePing(token: string): Promise<TokenVerdict> {
    try {
        const res = await fetch(MESSAGES_URL, {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "anthropic-beta": "oauth-2025-04-20",
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
                "user-agent": "claude-cli/2.1.214 (external, cli)",
            },
            body: SafeJSON.stringify({
                model: "claude-haiku-4-5-20251001",
                max_tokens: 1,
                messages: [{ role: "user", content: "hi" }],
            }),
            signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        });

        if (res.status === 401 || res.status === 403) {
            logger.debug(`[token-verify] token rejected with ${res.status}`);
            return "invalid";
        }

        if (res.status === 429) {
            logger.debug("[token-verify] token authenticated but rate-limited (429)");
            return "limited";
        }

        if (!res.ok) {
            // A retired probe model or a rejected UA answers 4xx here. That is
            // NOT an auth verdict, so it degrades to "unreachable" — but log the
            // body so a silently-degraded probe is diagnosable from the log.
            const body = await res.text().catch(() => "");
            logger.warn(`[token-verify] probe returned ${res.status}, treating as unreachable: ${body.slice(0, 200)}`);
            return "unreachable";
        }

        return "ok";
    } catch (error) {
        logger.debug({ error }, "[token-verify] verification request failed");
        return "unreachable";
    }
}

/** One-token call: proves the token authenticates. 429 means authenticated but rate-limited. */
export async function verifyLongLivedToken(token: string): Promise<TokenVerdict> {
    return sendLongLivedInferencePing(token);
}
