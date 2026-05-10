import { editFavorite } from "@app/shops/lib/watchlist-api";
import { authedApiHandler, jsonBody } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/watchlist/$id/edit")({
    server: {
        handlers: {
            POST: authedApiHandler(async (request, userId) => {
                const url = new URL(request.url);
                const idStr = url.pathname.split("/").at(-2);
                const id = Number(idStr);
                if (!Number.isFinite(id)) {
                    return Response.json({ error: "Invalid id" }, { status: 400 });
                }

                const body = await jsonBody(request);
                if (body instanceof Response) {
                    return body;
                }

                const updated = await editFavorite(userId, id, {
                    target_price: typeof body.target_price === "number" ? body.target_price : undefined,
                    drop_percent: typeof body.drop_percent === "number" ? body.drop_percent : undefined,
                    drop_absolute: typeof body.drop_absolute === "number" ? body.drop_absolute : undefined,
                    label: typeof body.label === "string" ? body.label : undefined,
                    cooldown_hours: typeof body.cooldown_hours === "number" ? body.cooldown_hours : undefined,
                    active: typeof body.active === "boolean" ? body.active : undefined,
                });
                return Response.json(updated ?? null);
            }),
        },
    },
});
