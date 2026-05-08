import { createFileRoute } from "@tanstack/react-router";
import { getWatchlist } from "../../../lib/watchlist-api";
import { apiHandler } from "../../server/api-utils";

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
