import type { TimelyConfig } from "@app/timely/types";
import { formatDuration } from "@genesiscz/utils/format";

/**
 * Timely's token response carries no expires_in, so a stored token has no known
 * lifetime and the client refreshes it on every request. Saying only that is
 * useless right after a login, so a recent authorization-code exchange is
 * reported as its own state.
 *
 * The window is Doorkeeper's default access-token lifetime (Timely runs
 * Doorkeeper); past it, a login is no longer plausibly the live session and the
 * honest "lifetime unknown" answer is the whole answer.
 */
const FRESH_LOGIN_SECONDS = 2 * 60 * 60;

export type TokenLifetime =
    | { kind: "absent" }
    | { kind: "known"; expiresAt: Date; expired: boolean }
    | { kind: "fresh-login"; age: string }
    | { kind: "unknown" };

export function describeTokenLifetime(
    config: TimelyConfig | null | undefined,
    nowMs: number = Date.now()
): TokenLifetime {
    const tokens = config?.tokens;
    if (!tokens?.created_at) {
        return { kind: "absent" };
    }

    if (tokens.expires_in) {
        const expiresAt = new Date((tokens.created_at + tokens.expires_in) * 1000);
        return { kind: "known", expiresAt, expired: nowMs > expiresAt.getTime() };
    }

    const nowSeconds = Math.floor(nowMs / 1000);
    const authenticatedAt = config?.authenticatedAt;

    if (authenticatedAt && nowSeconds - authenticatedAt < FRESH_LOGIN_SECONDS) {
        const age = Math.max(0, nowSeconds - authenticatedAt);
        return { kind: "fresh-login", age: formatDuration(age, "s", "hm-smart") };
    }

    return { kind: "unknown" };
}
