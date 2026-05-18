import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { testConnection } from "@app/clarity/ui/src/server/settings";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/test-connection")({
    server: {
        handlers: {
            POST: apiHandler(async () => {
                const result = await testConnection();
                return Response.json(result);
            }),
        },
    },
});
