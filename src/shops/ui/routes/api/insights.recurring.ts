import { getShopsDatabase } from "@app/shops/db/ShopsDatabase";
import { detectRecurring } from "@app/shops/lib/analytics/recurring";
import { authedApiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/insights/recurring")({
    server: {
        handlers: {
            GET: authedApiHandler(async (_request, userId) => {
                const rows = await detectRecurring(getShopsDatabase(), userId);
                return Response.json(rows);
            }),
        },
    },
});
