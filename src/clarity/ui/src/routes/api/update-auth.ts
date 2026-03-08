import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { updateAuth } from "../../server/settings";

export const Route = createFileRoute("/api/update-auth")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await updateAuth(body.curl as string);
                return Response.json(result);
            }),
        },
    },
});
