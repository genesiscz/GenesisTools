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

                const url = typeof body.url === "string" ? body.url.trim() : "";

                if (url === "") {
                    return Response.json({ error: "Field 'url' must be a non-empty string" }, { status: 400 });
                }

                const result = await configureAdo(url);

                if (!result.success) {
                    return Response.json(result, { status: 400 });
                }

                return Response.json(result);
            }),
        },
    },
});
