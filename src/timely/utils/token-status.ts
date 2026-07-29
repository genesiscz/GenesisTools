import type { TimelyConfig } from "@app/timely/types";
import { formatDuration } from "@genesiscz/utils/format";

/**
 * Doorkeeper's default access-token lifetime (Timely runs Doorkeeper). Timely's
 * token response carries no expires_in, so this is the conservative assumption
 * used in two places: how long a token may be presumed usable, and how long ago a
 * login still counts as "just now" when reporting status.
 */
export const ASSUMED_TOKEN_LIFETIME_SECONDS = 2 * 60 * 60;

export type TokenLifetime =
    | { kind: "absent" }
    | { kind: "known"; expiresAt: Date; expired: boolean }
    | { kind: "fresh-login"; age: string }
    | { kind: "unknown" };

/** Refresh a little before the deadline, so a token cannot expire mid-request. */
const REFRESH_BUFFER_SECONDS = 5 * 60;

/**
 * Whether a stored token has to be refreshed before it is used.
 *
 * When Timely omits expires_in the lifetime is genuinely unknown, but treating
 * unknown as "always expired" means a token-endpoint POST before every single
 * call — once per page of a paginated fetch, and several in parallel when
 * commands load memories and events together. Assuming Doorkeeper's default
 * lifetime from `created_at` refreshes once every couple of hours instead, and
 * `created_at` is rewritten by each refresh, so the clock restarts each time.
 */
export function tokenNeedsRefresh(
    tokens: { created_at?: number; expires_in?: number } | null | undefined,
    nowMs: number = Date.now()
): boolean {
    if (!tokens?.created_at) {
        return false;
    }

    const lifetime = tokens.expires_in ?? ASSUMED_TOKEN_LIFETIME_SECONDS;
    const expiresAtMs = (tokens.created_at + lifetime - REFRESH_BUFFER_SECONDS) * 1000;

    return nowMs > expiresAtMs;
}

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

    if (authenticatedAt && nowSeconds - authenticatedAt < ASSUMED_TOKEN_LIFETIME_SECONDS) {
        const age = Math.max(0, nowSeconds - authenticatedAt);
        return { kind: "fresh-login", age: formatDuration(age, "s", "hm-smart") };
    }

    return { kind: "unknown" };
}
