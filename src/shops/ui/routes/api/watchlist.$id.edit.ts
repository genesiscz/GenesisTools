import { createFileRoute } from "@tanstack/react-router";
import { editFavorite } from "@app/shops/lib/watchlist-api";
import { apiHandler, jsonBody } from "@app/shops/ui/server/api-utils";

export const Route = createFileRoute("/api/watchlist/$id/edit")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
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

                const updated = await editFavorite(id, {
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
