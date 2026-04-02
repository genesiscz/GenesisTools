import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { configureTimeLogKey } from "../../server/settings";

export const Route = createFileRoute("/api/configure-timelog-key")({
    server: {
        handlers: {
            POST: apiHandler(async () => {
                const result = await configureTimeLogKey();
                return Response.json(result);
            }),
        },
    },
});
