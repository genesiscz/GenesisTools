import { removeFavorite } from "@app/shops/lib/watchlist-api";
import { authedApiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/watchlist/$id/delete")({
    server: {
        handlers: {
            POST: authedApiHandler(async (request, userId) => {
                const url = new URL(request.url);
                const idStr = url.pathname.split("/").at(-2);
                const id = Number(idStr);
                if (!Number.isFinite(id)) {
                    return Response.json({ error: "Invalid id" }, { status: 400 });
                }

                await removeFavorite(userId, id);
                return Response.json({ ok: true });
            }),
        },
    },
});
