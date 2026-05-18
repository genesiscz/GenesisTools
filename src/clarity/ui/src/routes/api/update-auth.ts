import { apiHandler, jsonBody } from "@app/clarity/ui/src/server/api-utils";
import { updateAuth } from "@app/clarity/ui/src/server/settings";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/update-auth")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (typeof body.curl !== "string" || body.curl.trim() === "") {
                    return Response.json({ error: "Field 'curl' must be a non-empty string" }, { status: 400 });
                }

                const result = await updateAuth(body.curl);
                return Response.json(result);
            }),
        },
    },
});
