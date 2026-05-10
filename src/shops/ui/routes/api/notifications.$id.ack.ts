import { createFileRoute } from "@tanstack/react-router";
import { ackAllNotifications, ackNotification } from "@app/shops/lib/watchlist-api";
import { apiHandler } from "@app/shops/ui/server/api-utils";

export const Route = createFileRoute("/api/notifications/$id/ack")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const url = new URL(request.url);
                const idStr = url.pathname.split("/").at(-2);
                if (idStr === "all") {
                    await ackAllNotifications();
                    return Response.json({ ok: true, scope: "all" });
                }

                const id = Number(idStr);
                if (!Number.isFinite(id)) {
                    return Response.json({ error: "Invalid id" }, { status: 400 });
                }

                await ackNotification(id);
                return Response.json({ ok: true, id });
            }),
        },
    },
});
