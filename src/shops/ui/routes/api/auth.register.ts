import { SessionsRepository } from "@app/shops/db/SessionsRepository";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import type { User } from "@app/shops/db/types";
import { UsersRepository } from "@app/shops/db/UsersRepository";
import { apiHandler, jsonBody, setSessionCookie } from "@app/shops/ui/server/api-utils";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/register")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const email = typeof body.email === "string" ? body.email : "";
                const password = typeof body.password === "string" ? body.password : "";
                const displayName = typeof body.display_name === "string" ? body.display_name : null;
                if (email.length === 0 || password.length < 6) {
                    return Response.json({ error: "Email and password (min 6 chars) required" }, { status: 400 });
                }

                const db = getShopsDatabase();
                const users = new UsersRepository(db);
                const sessions = new SessionsRepository(db);

                let user: User;
                try {
                    user = await users.register({ email, password, displayName });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : "register failed";
                    return Response.json({ error: msg, code: "register_failed" }, { status: 400 });
                }

                const session = await sessions.create({ userId: user.id, ttlDays: 30 });
                const headers = new Headers({ "Content-Type": "application/json" });
                setSessionCookie(headers, session.token, 30);
                return new Response(
                    SafeJSON.stringify({
                        ok: true,
                        user: { id: user.id, email: user.email, display_name: user.display_name },
                    }),
                    { status: 200, headers }
                );
            }),
        },
    },
});
