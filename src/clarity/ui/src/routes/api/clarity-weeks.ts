import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { getTimesheetWeeks } from "../../server/mappings";

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
