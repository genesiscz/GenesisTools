import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";
import { executeFill } from "../../server/fill";

export const Route = createFileRoute("/api/fill/execute")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (
                    typeof body.month !== "number" ||
                    typeof body.year !== "number" ||
                    !Array.isArray(body.weekIds) ||
                    !body.weekIds.every((id: unknown) => typeof id === "number")
                ) {
                    return Response.json(
                        { error: "Fields 'month' and 'year' must be numbers, 'weekIds' must be number[]" },
                        { status: 400 }
                    );
                }

                const result = await executeFill(body.month, body.year, body.weekIds as number[]);
                return Response.json(result);
            }),
        },
    },
});
