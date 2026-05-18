import { apiHandler } from "@app/clarity/ui/src/server/api-utils";
import { fetchTeamMembers } from "@app/clarity/ui/src/server/settings";
import { createFileRoute } from "@tanstack/react-router";

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
