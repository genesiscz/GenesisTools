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

                if (typeof body.userId !== "string" || body.userId.trim() === "") {
                    return Response.json({ error: "Field 'userId' must be a non-empty string" }, { status: 400 });
                }

                if (typeof body.userName !== "string" || body.userName.trim() === "") {
                    return Response.json({ error: "Field 'userName' must be a non-empty string" }, { status: 400 });
                }

                if (typeof body.userEmail !== "string" || body.userEmail.trim() === "") {
                    return Response.json({ error: "Field 'userEmail' must be a non-empty string" }, { status: 400 });
                }

                const result = await setTimeLogDefaultUser({
                    userId: body.userId,
                    userName: body.userName,
                    userEmail: body.userEmail,
                });
                return Response.json(result);
            }),
        },
    },
});
