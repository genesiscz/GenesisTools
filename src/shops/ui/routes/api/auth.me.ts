import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UsersRepository } from "@app/shops/db/UsersRepository";
import { authedApiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/auth/me")({
    server: {
        handlers: {
            GET: authedApiHandler(async (_request, userId) => {
                const u = await new UsersRepository(getShopsDatabase()).getById(userId);
                if (!u) {
                    return Response.json({ error: "User missing" }, { status: 404 });
                }

                return Response.json({ id: u.id, email: u.email, display_name: u.display_name });
            }),
        },
    },
});
