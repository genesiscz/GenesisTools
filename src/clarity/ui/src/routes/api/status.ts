import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { getStatus } from "../../server/settings";

export const Route = createFileRoute("/api/status")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const result = await getStatus();
                return Response.json(result);
            }),
        },
    },
});
