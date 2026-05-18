import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { getClarityTasks } from "@app/clarity/ui/src/server/mappings";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/clarity-tasks")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await getClarityTasks(body.timesheetId as number);
                return Response.json(result);
            }),
        },
    },
});
