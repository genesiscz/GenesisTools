import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";
import { updateAuth } from "../../server/settings";

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
