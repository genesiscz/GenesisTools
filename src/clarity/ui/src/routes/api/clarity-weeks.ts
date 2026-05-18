import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { getTimesheetWeeks } from "@app/clarity/ui/src/server/mappings";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/clarity-weeks")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await getTimesheetWeeks(
                    body.month as number | undefined,
                    body.year as number | undefined
                );
                return Response.json(result);
            }),
        },
    },
});
