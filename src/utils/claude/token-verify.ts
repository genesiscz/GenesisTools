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

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** A blackholed connection must not hang an interactive login forever. */
const VERIFY_TIMEOUT_MS = 15_000;

/** One-token call: proves the token authenticates. 429 means authenticated but rate-limited. */
export async function verifyLongLivedToken(token: string): Promise<TokenVerdict> {
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
