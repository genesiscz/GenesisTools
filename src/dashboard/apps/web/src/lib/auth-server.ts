import type { User } from "@workos-inc/node";
import { WorkOS } from "@workos-inc/node";
import { sealData } from "iron-session";

// WorkOS client singleton
const workos = new WorkOS(process.env.WORKOS_API_KEY);

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
    const password = process.env.WORKOS_COOKIE_PASSWORD;
    if (!password || password.length < 32) {
        throw new Error("WORKOS_COOKIE_PASSWORD must be set and at least 32 characters long");
    }

    return await sealData(session, { password });
}
