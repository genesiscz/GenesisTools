import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { configureTimeLogKey } from "@app/clarity/ui/src/server/settings";
import { createFileRoute } from "@tanstack/react-router";

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
