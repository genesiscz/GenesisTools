import { Skeleton } from "@app/utils/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { redirect, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useEffect } from "react";

export interface AuthUser {
    id: number;
    email: string;
    display_name: string | null;
}

export function useAuthMe() {
    return useQuery<AuthUser | null>({
        queryKey: ["auth", "me"],
        queryFn: async () => {
            const res = await fetch("/api/auth/me");
            if (res.status === 401) {
                return null;
            }

            if (!res.ok) {
                throw new Error(`me failed: ${res.status}`);
            }

            return (await res.json()) as AuthUser;
        },
        staleTime: 60_000,
        retry: false,
    });
}

/**
 * TanStack Router beforeLoad gate — throws redirect to /login when unauth'd.
 * Skips the check during SSR (no usable cookies on the server fetch); the
 * client-side `<RequireAuth>` boundary handles the unauth case after hydration.
 */
export async function requireAuthBeforeLoad(): Promise<void> {
    if (typeof window === "undefined") {
        return;
    }

    const res = await fetch("/api/auth/me");
    if (res.status === 401) {
        throw redirect({ to: "/login" });
    }
}

/**
 * Wrap a protected page's content. Renders nothing while auth loads, sends
 * the user to /login if unauth'd, otherwise renders the children. Pair with
 * `beforeLoad: requireAuthBeforeLoad` for the (faster) client-side gate.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
    const me = useAuthMe();
    const navigate = useNavigate();
    const unauthed = !me.isLoading && !me.data;
    useEffect(() => {
        if (unauthed) {
            navigate({ to: "/login" });
        }
    }, [unauthed, navigate]);

    if (me.isLoading) {
        return (
            <div className="px-6 py-6 space-y-4">
                <Skeleton className="h-10 w-full max-w-md" />
                <Skeleton className="h-44 w-full" />
                <Skeleton className="h-72 w-full" />
            </div>
        );
    }

    if (unauthed) {
        return null;
    }

    return children;
}
