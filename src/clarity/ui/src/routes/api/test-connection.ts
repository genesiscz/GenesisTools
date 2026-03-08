import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { testConnection } from "../../server/settings";

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
