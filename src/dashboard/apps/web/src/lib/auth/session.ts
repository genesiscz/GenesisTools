import { getAuthkit } from "@workos/authkit-tanstack-react-start";
import type { AuthenticationResponse } from "@workos-inc/node";
import { encryptSession, type Session } from "../auth-server";

/**
 * Persist a WorkOS password/email-verification auth result as the AuthKit
 * httpOnly session cookie.
 *
 * The session is sealed with iron-session (`encryptSession`) — Iron-format
 * compatible with AuthKit's iron-webcrypto encryption and the same
 * WORKOS_COOKIE_PASSWORD — then handed to AuthKit's `saveSession`, which
 * writes it under AuthKit's configured cookie name via the active
 * `authkitMiddleware`. This is what makes `getAuth()` / `useAuth()` recognise
 * email/password logins, so there is exactly ONE session system and nothing
 * is ever stored in localStorage.
 */
export async function establishAuthSession(authResponse: AuthenticationResponse): Promise<void> {
    const session: Session = {
        accessToken: authResponse.accessToken,
        refreshToken: authResponse.refreshToken,
        user: authResponse.user,
        impersonator: authResponse.impersonator ?? undefined,
    };

    const encrypted = await encryptSession(session);
    const authkit = await getAuthkit();
    await authkit.saveSession(undefined, encrypted);
}
