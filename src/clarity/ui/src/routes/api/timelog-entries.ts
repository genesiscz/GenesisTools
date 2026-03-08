import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { getTimelogEntries } from "../../server/export";

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
