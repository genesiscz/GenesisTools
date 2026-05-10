import { getWatchlist } from "@app/shops/lib/watchlist-api";
import { apiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/watchlist")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const rows = await getWatchlist();
                return Response.json(rows);
            }),
        },
    },
});
