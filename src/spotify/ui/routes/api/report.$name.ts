/**
 * One route for every report. The names and the query parameters are exactly the CLI's
 * commands and flags, so `/api/report/top?kind=artists&year=2025` answers what
 * `tools spotify top artists --year 2025 --json` prints. Each parameter answers to both
 * spellings: `?min-ms=1000` as the CLI writes it, and `?minMs=1000` as the client does.
 *
 * The behaviour lives in `server/report-read.ts` so it can be tested without a server.
 */
import { apiHandler } from "@app/spotify/ui/server/api-utils";
import { reportRead } from "@app/spotify/ui/server/report-read";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/report/$name")({
    server: {
        handlers: {
            GET: apiHandler(({ request, params }) => {
                const name = params?.name ?? new URL(request.url).pathname.split("/").pop() ?? "";

                return reportRead(request, name);
            }),
        },
    },
});
