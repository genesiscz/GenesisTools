import { redirect } from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";

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
