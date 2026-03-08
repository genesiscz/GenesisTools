import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { getExportData } from "../../server/export";

export const Route = createFileRoute("/api/export")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await getExportData(body.month as number, body.year as number, { force: !!body.force });
                return Response.json(result);
            }),
        },
    },
});
