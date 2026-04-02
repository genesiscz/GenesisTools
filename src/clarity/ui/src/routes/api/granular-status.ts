import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { getGranularStatus } from "../../server/settings";

export const Route = createFileRoute("/api/granular-status")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const result = await getGranularStatus();
                return Response.json(result);
            }),
        },
    },
});
