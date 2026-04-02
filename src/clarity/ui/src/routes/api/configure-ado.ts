import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";
import { configureAdo } from "../../server/settings";

export const Route = createFileRoute("/api/configure-ado")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (typeof body.url !== "string" || body.url.trim() === "") {
                    return Response.json({ error: "Field 'url' must be a non-empty string" }, { status: 400 });
                }

                const result = await configureAdo(body.url);
                return Response.json(result);
            }),
        },
    },
});
