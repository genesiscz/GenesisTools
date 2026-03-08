import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { getFillPreview } from "../../server/fill";

export const Route = createFileRoute("/api/fill/preview")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await getFillPreview(body.month as number, body.year as number);
                return Response.json(result);
            }),
        },
    },
});
