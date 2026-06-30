import { env } from "@app/utils/env";
import { redirect } from "@tanstack/react-router";
import { getAuth, getAuthkit } from "@workos/authkit-tanstack-react-start";

/**
 * E2E auth bypass. When `VITE_E2E_AUTH_BYPASS=1` (or server-only
 * `E2E_AUTH_BYPASS=1`), the server identity boundary short-circuits to a fixed
 * user WITHOUT contacting WorkOS — so Playwright can drive every protected page
 * without a real WorkOS session (AuthKit verifies the access-token JWT against
 * the live JWKS, so a synthetic cookie can't work).
 *
 * The id is exactly `"dev-user"` to match the client `DEV_USER_ID` fallback
 * used across the app, so SSR (server id) and client TanStack Query (client id)
 * resolve to the SAME user and never diverge. NEVER enabled in production
 * (neither flag is ever set there).
 *
 * `import.meta.env.VITE_*` is the isomorphic flag (inlined for the client where
 * `requireAuthBeforeLoad` runs during client-side navigation); `process.env`
 * covers the pure-server raw handlers.
 */
const E2E_BYPASS_USER_ID = "dev-user";

function e2eAuthBypass(): boolean {
    return (
        import.meta.env.VITE_E2E_AUTH_BYPASS === "1" ||
        (typeof process !== "undefined" && process.env.E2E_AUTH_BYPASS === "1")
    );
}

/**
 * Server-side identity boundary. Every data server function must derive the
 * user id from HERE — never from client input — or any authenticated member
 * can read/mutate another member's data by passing a different userId.
 *
 * Throws a 401 Response when there is no authenticated session.
 */
export async function requireUserId(): Promise<string> {
    if (e2eAuthBypass()) {
        return E2E_BYPASS_USER_ID;
    }

    const auth = await getAuth();
    if (!auth.user) {
        throw new Response("Unauthorized", { status: 401 });
    }

    return auth.user.id;
}

/**
 * Route-tree guard for `beforeLoad`. Redirects unauthenticated requests to
 * sign-in so the protected shell never renders (SSR or client). This is UX;
 * the real isolation guarantee is `requireUserId()` inside every server fn.
 */
export async function requireAuthBeforeLoad(currentHref: string): Promise<void> {
    if (e2eAuthBypass()) {
        return;
    }

    const auth = await getAuth();
    if (!auth.user) {
        throw redirect({ to: "/auth/signin", search: { returnTo: currentHref } });
    }
}

/**
 * Resolve the authenticated user id from a raw Request (for file-route
 * handlers like SSE / ai-chat / avatar that don't run as server functions).
 * Returns null when unauthenticated — caller decides the response.
 */
export async function getUserIdFromRequest(request: Request): Promise<string | null> {
    if (e2eAuthBypass()) {
        return E2E_BYPASS_USER_ID;
    }

    const authkit = await getAuthkit();
    const { auth } = await authkit.withAuth(request);
    return auth.user ? auth.user.id : null;
}

/**
 * CSRF defence for state-changing raw POST endpoints: the request Origin (or
 * Referer) must match the configured app origin. The session cookie is
 * sameSite=lax, so this closes the residual cross-site POST vector.
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
