import { apiHandler, jsonBody } from "@app/clarity/ui/src/server/api-utils";
import { getAssignmentView } from "@app/clarity/ui/src/server/assignments";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/assignment-view")({
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
                    body.month < 1 ||
                    body.month > 12
                ) {
                    return Response.json(
                        { error: "Field 'month' must be 1-12 and 'year' must be a number" },
                        { status: 400 }
                    );
                }

                const result = await getAssignmentView({
                    month: body.month,
                    year: body.year,
                    refresh: body.refresh === true,
                });

                return Response.json(result);
            }),
        },
    },
});
