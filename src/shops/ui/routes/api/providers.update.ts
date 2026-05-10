import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { UserProvidersRepository } from "@app/shops/db/UserProvidersRepository";
import { type BackfillResult, backfillWatchlist } from "@app/shops/lib/order-sync-backfill";
import { authedApiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/providers/update")({
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
                    return Response.json({ error: "provider not connected" }, { status: 404 });
                }

                const wasOff = (row.auto_watchlist ?? 0) === 0;
                const willBeOn = body.auto_watchlist === true;

                await repo.updateAutoWatchlist(row.id, {
                    auto_watchlist: willBeOn,
                    watchlist_defaults:
                        typeof body.watchlist_defaults === "object" && body.watchlist_defaults !== null
                            ? (body.watchlist_defaults as Record<string, unknown>)
                            : undefined,
                });

                let backfill: BackfillResult | null = null;
                if (wasOff && willBeOn) {
                    backfill = await backfillWatchlist({ userId, userProviderId: row.id });
                }

                return Response.json({ ok: true, backfill });
            }),
        },
    },
});
