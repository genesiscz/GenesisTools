import { listPendingCandidates } from "@app/shops/lib/match-api";
import { apiHandler } from "@app/shops/ui/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/match/candidates")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const pairs = await listPendingCandidates();
                return Response.json(pairs);
            }),
        },
    },
});
