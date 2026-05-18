import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { getTimelogEntries } from "@app/clarity/ui/src/server/export";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/timelog-entries")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await getTimelogEntries(body.month as number, body.year as number);
                return Response.json(result);
            }),
        },
    },
});
