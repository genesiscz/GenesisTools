import { getWatchlist } from "@app/shops/lib/watchlist-api";
import { authedApiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/watchlist")({
    server: {
        handlers: {
            GET: authedApiHandler(async (_request, userId) => {
                const rows = await getWatchlist(userId);
                return Response.json(rows);
            }),
        },
    },
});
