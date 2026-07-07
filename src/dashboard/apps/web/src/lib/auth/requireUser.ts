import { redirect } from "@tanstack/react-router";
import { getAuth, getAuthkit } from "@workos/authkit-tanstack-react-start";

/**
 * Server-side identity boundary. Every data server function must derive the
 * user id from HERE — never from client input — or any authenticated member
 * can read/mutate another member's data by passing a different userId.
 *
 * Throws a 401 Response when there is no authenticated session.
 */
export async function requireUserId(): Promise<string> {
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
    const authkit = await getAuthkit();
    const { auth } = await authkit.withAuth(request);
    return auth.user ? auth.user.id : null;
}

// isSameOrigin lives in @/lib/auth-server: it needs the node-only env module,
// and this file is shared with the client via route beforeLoad guards.
