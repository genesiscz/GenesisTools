import { apiHandler, jsonBody } from "@app/clarity/ui/src/server/api-utils";
import { listUnaskedSignIns, signInUnasked } from "@app/clarity/ui/src/server/settings";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/sign-in-unasked")({
    server: {
        handlers: {
            GET: apiHandler(async () => Response.json(await listUnaskedSignIns())),
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (typeof body.driver !== "string" || body.driver === "") {
                    return Response.json({ error: "Field 'driver' must be a non-empty string" }, { status: 400 });
                }

                return Response.json(await signInUnasked(body.driver));
            }),
        },
    },
});
