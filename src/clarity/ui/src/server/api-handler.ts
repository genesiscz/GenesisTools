import type { IncomingMessage, ServerResponse } from "node:http";
import { loadConfig } from "@app/azure-devops/config";
import { getWorkItemTypeColors } from "@app/azure-devops/lib/work-item-enrichment";
import { getExportData, getTimelogEntries } from "./export";
import { executeFill, getFillPreview } from "./fill";
import { addMapping, getClarityTasks, getMappings, getTimesheetWeeks, moveMapping, removeMapping } from "./mappings";
import { getAdoConfig, getStatus, searchAdoWorkItems, testConnection, updateAuth } from "./settings";

type ApiHandler = (body: Record<string, unknown>) => Promise<unknown>;

const routes: Record<string, ApiHandler> = {
    "GET /api/mappings": async () => getMappings(),
    "POST /api/mappings": async (body) => addMapping(body),
    "DELETE /api/mappings": async (body) => removeMapping(body.adoWorkItemId as number),
    "POST /api/move-mapping": async (body) =>
        moveMapping(
            body.adoWorkItemId as number,
            body.target as {
                clarityTaskId: number;
                clarityTaskName: string;
                clarityTaskCode: string;
                clarityInvestmentName: string;
                clarityInvestmentCode: string;
            }
        ),
    "POST /api/export": async (body) =>
        getExportData(body.month as number, body.year as number, { force: !!body.force }),
    "POST /api/fill/preview": async (body) => getFillPreview(body.month as number, body.year as number),
    "POST /api/fill/execute": async (body) =>
        executeFill(body.month as number, body.year as number, body.weekIds as number[]),
    "POST /api/clarity-weeks": async (body) =>
        getTimesheetWeeks(body.month as number | undefined, body.year as number | undefined),
    "POST /api/clarity-tasks": async (body) => getClarityTasks(body.timesheetId as number),
    "GET /api/ado-config": async () => getAdoConfig(),
    "POST /api/ado-workitems": async (body) => searchAdoWorkItems(body.query as string),
    "GET /api/status": async () => getStatus(),
    "POST /api/test-connection": async () => testConnection(),
    "POST /api/update-auth": async (body) => updateAuth(body.curl as string),
    "GET /api/workitem-type-colors": async () => {
        const config = loadConfig();

        if (!config) {
            throw new Error("Azure DevOps not configured");
        }
        const colorMap = await getWorkItemTypeColors(config);
        const types: Record<string, { color: string; name: string; icon: { id: string; url: string } }> = {};

        for (const [name, info] of colorMap) {
            types[name] = info;
        }

        return { types };
    },
    "POST /api/timelog-entries": async (body) => getTimelogEntries(body.month as number, body.year as number),
};

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown> = {}) {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    const routeKey = `${method} ${url.split("?")[0]}`;
    const handler = routes[routeKey];

    if (!handler) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not found" }));
        return;
    }

    const result = await handler(body);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
}
