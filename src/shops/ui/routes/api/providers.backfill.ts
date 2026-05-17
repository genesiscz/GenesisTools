import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { backfillWatchlist } from "@app/shops/lib/order-sync-backfill";
import { authedApiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/providers/backfill")({
    server: {
        handlers: {
            POST: authedApiHandler(async (request, userId) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const shop = typeof body.shop_origin === "string" ? body.shop_origin : null;
                if (!shop) {
                    return Response.json({ error: "shop_origin required" }, { status: 400 });
                }

                const repo = new UserProvidersRepository(getShopsDatabase());
                const provider = await repo.getByShop(userId, shop);
                if (!provider) {
                    return Response.json({ error: "provider not connected" }, { status: 404 });
                }

                const result = await backfillWatchlist({ userId, userProviderId: provider.id });
                return Response.json(result);
            }),
        },
    },
});
