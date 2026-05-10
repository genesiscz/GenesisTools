import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { apiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/providers/update")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                if (typeof body.shop_origin !== "string") {
                    return Response.json({ error: "shop_origin is required" }, { status: 400 });
                }

                const repo = new UserProvidersRepository(getShopsDatabase());
                const row = await repo.getByShop(1, body.shop_origin);
                if (!row) {
                    return Response.json({ error: "provider not connected" }, { status: 404 });
                }

                await repo.updateAutoWatchlist(row.id, {
                    auto_watchlist: body.auto_watchlist === true,
                    watchlist_defaults:
                        typeof body.watchlist_defaults === "object" && body.watchlist_defaults !== null
                            ? (body.watchlist_defaults as Record<string, unknown>)
                            : undefined,
                });
                return Response.json({ ok: true });
            }),
        },
    },
});
