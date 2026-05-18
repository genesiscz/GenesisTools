import { apiHandler, jsonBody } from "@app/clarity/ui/src/server/api-utils";
import { getExportData } from "@app/clarity/ui/src/server/export";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/export")({
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

                const result = await getExportData(body.month, body.year, { force: !!body.force });
                return Response.json(result);
            }),
        },
    },
});
