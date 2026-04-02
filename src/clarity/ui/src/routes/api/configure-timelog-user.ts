import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";
import { setTimeLogDefaultUser } from "../../server/settings";

export const Route = createFileRoute("/api/configure-timelog-user")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const userId = typeof body.userId === "string" ? body.userId.trim() : "";
                const userName = typeof body.userName === "string" ? body.userName.trim() : "";
                const userEmail = typeof body.userEmail === "string" ? body.userEmail.trim() : "";

                if (userId === "") {
                    return Response.json({ error: "Field 'userId' must be a non-empty string" }, { status: 400 });
                }

                if (userName === "") {
                    return Response.json({ error: "Field 'userName' must be a non-empty string" }, { status: 400 });
                }

                if (userEmail === "") {
                    return Response.json({ error: "Field 'userEmail' must be a non-empty string" }, { status: 400 });
                }

                const result = await setTimeLogDefaultUser({ userId, userName, userEmail });

                if (!result.success) {
                    return Response.json(result, { status: 400 });
                }

                return Response.json(result);
            }),
        },
    },
});
