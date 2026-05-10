import { createFileRoute } from "@tanstack/react-router";
import { removeFavorite } from "@app/shops/lib/watchlist-api";
import { apiHandler } from "@app/shops/ui/server/api-utils";

export const Route = createFileRoute("/api/watchlist/$id/delete")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const url = new URL(request.url);
                const idStr = url.pathname.split("/").at(-2);
                const id = Number(idStr);
                if (!Number.isFinite(id)) {
                    return Response.json({ error: "Invalid id" }, { status: 400 });
                }

                await removeFavorite(id);
                return Response.json({ ok: true });
            }),
        },
    },
});
