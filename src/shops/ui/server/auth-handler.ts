import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { getSessionUser, SESSION_COOKIE_NAME } from "@app/shops/lib/auth";

type ServerCtx = { request: Request };

export type AuthedHandler = (request: Request, userId: number) => Promise<Response>;

export function authedApiHandler(fn: AuthedHandler): (ctx: ServerCtx) => Promise<Response> {
    return async ({ request }) => {
        try {
            const user = await getSessionUser(request, getShopsDatabase());
            if (!user) {
                return Response.json({ error: "Unauthorized" }, { status: 401 });
            }

            return await fn(request, user.id);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Internal server error";
            const status = (err as { statusCode?: number }).statusCode ?? 500;
            return Response.json({ error: message }, { status });
        }
    };
}

export function setSessionCookie(headers: Headers, token: string, ttlDays: number): void {
    const maxAgeSec = ttlDays * 86_400;
    headers.append(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
    );
}

export function clearSessionCookie(headers: Headers): void {
    headers.append(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
    );
}
