import { SessionsRepository } from "@app/shops/db/SessionsRepository";
import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UsersRepository } from "@app/shops/db/UsersRepository";
import { apiHandler, jsonBody, setSessionCookie } from "@app/shops/ui/server/api-utils";
import { SafeJSON } from "@app/utils/json";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/login")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const email = typeof body.email === "string" ? body.email : "";
                const password = typeof body.password === "string" ? body.password : "";
                if (!email || !password) {
                    return Response.json({ error: "email + password required" }, { status: 400 });
                }

                const db = getShopsDatabase();
                const users = new UsersRepository(db);
                const sessions = new SessionsRepository(db);
                const user = await users.verifyPassword(email, password);
                if (!user) {
                    return Response.json({ error: "Invalid credentials" }, { status: 401 });
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
