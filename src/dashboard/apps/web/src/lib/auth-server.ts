import { env } from "@app/utils/env";
import type { User } from "@workos-inc/node";
import { WorkOS } from "@workos-inc/node";
import { sealData } from "iron-session";

// WorkOS client singleton
const workos = new WorkOS(env.workos.getApiKey());

export { workos };

// Session types — shape matches AuthKit's Session (and WorkOS
// AuthenticationResponse), so a session sealed here roundtrips through
// AuthKit's middleware.
export interface Impersonator {
    email: string;
    reason: string | null;
}

export interface Session {
    accessToken: string;
    refreshToken: string;
    user: User;
    impersonator?: Impersonator;
}

/**
 * Seal a session with iron-session. Iron-format compatible with AuthKit's
 * iron-webcrypto encryption (same WORKOS_COOKIE_PASSWORD); the sealed string
 * is handed to AuthKit's `saveSession` so AuthKit owns the cookie.
 */
export async function encryptSession(session: Session): Promise<string> {
    const password = env.workos.getCookiePassword();
    if (!password || password.length < 32) {
        throw new Error("WORKOS_COOKIE_PASSWORD must be set and at least 32 characters long");
    }

    return await sealData(session, { password });
}

/**
 * CSRF defence for state-changing raw POST endpoints: the request Origin (or
 * Referer) must match the configured app origin. The session cookie is
 * sameSite=lax, so this closes the residual cross-site POST vector.
 *
 * Lives here (not in auth/requireUser.ts) because it reads the node-only env
 * module and requireUser.ts is shared with the client via beforeLoad guards.
 */
export function isSameOrigin(request: Request): boolean {
    const redirectUri = env.workos.getRedirectUri();
    const appOrigin = redirectUri ? new URL(redirectUri).origin : new URL(request.url).origin;

    const origin = request.headers.get("origin");
    if (origin) {
        return origin === appOrigin;
    }

    // Some legitimate clients omit Origin on same-origin requests; fall back to Referer.
    const referer = request.headers.get("referer");
    if (referer) {
        try {
            return new URL(referer).origin === appOrigin;
        } catch {
            return false;
        }
    }

    // No Origin and no Referer: only safe for same-origin fetch (browsers send
    // Origin on cross-site POST), so allow — the session cookie still gates it.
    return true;
}
