import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { fetchTeamMembers } from "../../server/settings";

export const Route = createFileRoute("/api/team-members")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const result = await fetchTeamMembers();
                return Response.json(result);
            }),
        },
    },
});
