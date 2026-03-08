import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";
import { moveMapping } from "../../server/mappings";

export const Route = createFileRoute("/api/move-mapping")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await request.json();
                const result = await moveMapping(
                    body.adoWorkItemId as number,
                    body.target as {
                        clarityTaskId: number;
                        clarityTaskName: string;
                        clarityTaskCode: string;
                        clarityInvestmentName: string;
                        clarityInvestmentCode: string;
                    }
                );
                return Response.json(result);
            }),
        },
    },
});
