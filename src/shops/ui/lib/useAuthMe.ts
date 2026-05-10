import { useQuery } from "@tanstack/react-query";
import { redirect } from "@tanstack/react-router";

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

/** TanStack Router beforeLoad gate — throws redirect to /login when unauth'd. */
export async function requireAuthBeforeLoad(): Promise<void> {
    const res = await fetch("/api/auth/me");
    if (res.status === 401) {
        throw redirect({ to: "/login" });
    }
}
