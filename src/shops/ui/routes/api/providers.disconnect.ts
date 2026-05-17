import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { authedApiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/providers/disconnect")({
    server: {
        handlers: {
            POST: authedApiHandler(async (request, userId) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                if (typeof body.shop_origin !== "string") {
                    return Response.json({ error: "shop_origin is required" }, { status: 400 });
                }

                const repo = new UserProvidersRepository(getShopsDatabase());
                const row = await repo.getByShop(userId, body.shop_origin);
                if (!row) {
                    return Response.json({ ok: true });
                }

                await repo.disconnect(row.id);
                return Response.json({ ok: true });
            }),
        },
    },
});
