import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";
import { postTimesheetNote } from "../../server/fill";

export const Route = createFileRoute("/api/post-note")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                if (
                    typeof body.timesheetId !== "number" ||
                    typeof body.noteText !== "string" ||
                    typeof body.userId !== "number" ||
                    !(body.noteText as string).trim()
                ) {
                    return Response.json(
                        {
                            error: "'timesheetId' and 'userId' must be numbers, 'noteText' must be a non-empty string",
                        },
                        { status: 400 }
                    );
                }

                await postTimesheetNote(body.timesheetId, body.noteText, body.userId);
                return Response.json({ success: true });
            }),
        },
    },
});
