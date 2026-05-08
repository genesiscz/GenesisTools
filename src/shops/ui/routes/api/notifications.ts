import { createFileRoute } from "@tanstack/react-router";
import type { NotificationReason } from "../../../db/NotificationsRepository";
import { getRecentNotifications } from "../../../lib/watchlist-api";
import { apiHandler } from "../../server/api-utils";

const VALID_REASONS = new Set<NotificationReason>([
    "target-price",
    "drop-percent",
    "drop-absolute",
    "back-in-stock",
]);

export const Route = createFileRoute("/api/notifications")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const reasonParam = url.searchParams.get("reason");
                const reason =
                    reasonParam && VALID_REASONS.has(reasonParam as NotificationReason)
                        ? (reasonParam as NotificationReason)
                        : undefined;
                const rows = await getRecentNotifications({
                    onlyUnacked: url.searchParams.get("only_unacked") === "1",
                    reason,
                    shop_origin: url.searchParams.get("shop") ?? undefined,
                    limit: url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 100,
                });
                return Response.json(rows);
            }),
        },
    },
});
