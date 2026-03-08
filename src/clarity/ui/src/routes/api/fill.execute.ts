import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { executeFill } from "../../server/fill";

export const Route = createFileRoute("/api/fill/execute")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await executeFill(body.month as number, body.year as number, body.weekIds as number[]);
                return Response.json(result);
            }),
        },
    },
});
