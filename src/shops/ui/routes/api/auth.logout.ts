import { SessionsRepository } from "@app/shops/db/SessionsRepository";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { parseCookies, SESSION_COOKIE_NAME } from "@app/shops/lib/auth";
import { apiHandler, clearSessionCookie } from "@app/shops/ui/server/api-utils";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/logout")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const cookies = parseCookies(request.headers.get("Cookie"));
                const tok = cookies[SESSION_COOKIE_NAME];
                if (tok) {
                    await new SessionsRepository(getShopsDatabase()).delete(tok);
                }

                const headers = new Headers({ "Content-Type": "application/json" });
                clearSessionCookie(headers);
                return new Response(SafeJSON.stringify({ ok: true }), { status: 200, headers });
            }),
        },
    },
});
