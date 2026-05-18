import { apiHandler, jsonBody } from "@app/clarity/ui/src/server/api-utils";
import { getFillPreview } from "@app/clarity/ui/src/server/fill";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/fill/preview")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (typeof body.month !== "number" || typeof body.year !== "number") {
                    return Response.json({ error: "Fields 'month' and 'year' must be numbers" }, { status: 400 });
                }

                const result = await getFillPreview(body.month, body.year);
                return Response.json(result);
            }),
        },
    },
});
