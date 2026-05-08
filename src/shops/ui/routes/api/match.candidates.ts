import { createFileRoute } from "@tanstack/react-router";
import { listPendingCandidates } from "../../../lib/match-api";
import { apiHandler } from "../../server/api-utils";

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
