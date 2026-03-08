import { loadConfig } from "@app/azure-devops/config";
import { getWorkItemTypeColors } from "@app/azure-devops/lib/work-item-enrichment";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/workitem-type-colors")({
    server: {
        handlers: {
            GET: apiHandler(async () => {
                const config = loadConfig();

                if (!config) {
                    return Response.json(
                        {
                            error: "Azure DevOps not configured. Run the dev server from a project with .claude/azure/config.json, or set CLARITY_PROJECT_CWD.",
                            types: {},
                        },
                        { status: 404 }
                    );
                }

                const colorMap = await getWorkItemTypeColors(config);
                const types: Record<string, { color: string; name: string; icon: { id: string; url: string } }> = {};

                for (const [name, info] of colorMap) {
                    types[name] = info;
                }

                return Response.json({ types });
            }),
        },
    },
});
