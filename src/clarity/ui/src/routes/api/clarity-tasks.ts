import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { getClarityTasks } from "../../server/mappings";

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
