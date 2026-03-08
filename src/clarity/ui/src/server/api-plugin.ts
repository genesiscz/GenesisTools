import type { Plugin } from "vite";

type ApiHandler = (body: Record<string, unknown>) => Promise<unknown>;

export function apiPlugin(): Plugin {
    return {
        name: "clarity-api",
        configureServer(server) {
            const routes: Record<string, ApiHandler> = {
                "GET /api/mappings": async () => {
                    const { getMappings } = await import("./mappings");
                    return getMappings();
                },
                "POST /api/mappings": async (body) => {
                    const { addMapping } = await import("./mappings");
                    return addMapping(body);
                },
                "DELETE /api/mappings": async (body) => {
                    const { removeMapping } = await import("./mappings");
                    return removeMapping(body.adoWorkItemId as number);
                },
                "POST /api/move-mapping": async (body) => {
                    const { moveMapping } = await import("./mappings");
                    return moveMapping(
                        body.adoWorkItemId as number,
                        body.target as {
                            clarityTaskId: number;
                            clarityTaskName: string;
                            clarityTaskCode: string;
                            clarityInvestmentName: string;
                            clarityInvestmentCode: string;
                        }
                    );
                },
                "POST /api/export": async (body) => {
                    const { getExportData } = await import("./export");
                    return getExportData(body.month as number, body.year as number, { force: !!body.force });
                },
                "POST /api/fill/preview": async (body) => {
                    const { getFillPreview } = await import("./fill");
                    return getFillPreview(body.month as number, body.year as number);
                },
                "POST /api/fill/execute": async (body) => {
                    const { executeFill } = await import("./fill");
                    return executeFill(body.month as number, body.year as number, body.weekIds as number[]);
                },
                "POST /api/clarity-weeks": async (body) => {
                    const { getTimesheetWeeks } = await import("./mappings");
                    return getTimesheetWeeks(body.month as number | undefined, body.year as number | undefined);
                },
                "POST /api/clarity-tasks": async (body) => {
                    const { getClarityTasks } = await import("./mappings");
                    return getClarityTasks(body.timesheetId as number);
                },
                "GET /api/ado-config": async () => {
                    const { getAdoConfig } = await import("./settings");
                    return getAdoConfig();
                },
                "POST /api/ado-workitems": async (body) => {
                    const { searchAdoWorkItems } = await import("./settings");
                    return searchAdoWorkItems(body.query as string);
                },
                "GET /api/status": async () => {
                    const { getStatus } = await import("./settings");
                    return getStatus();
                },
                "POST /api/test-connection": async () => {
                    const { testConnection } = await import("./settings");
                    return testConnection();
                },
                "POST /api/update-auth": async (body) => {
                    const { updateAuth } = await import("./settings");
                    return updateAuth(body.curl as string);
                },
                "GET /api/workitem-type-colors": async () => {
                    const { loadConfig } = await import("@app/azure-devops/config");
                    const { getWorkItemTypeColors } = await import("@app/azure-devops/lib/work-item-enrichment");
                    const config = loadConfig();

                    if (!config) {
                        throw new Error("Azure DevOps not configured");
                    }

                    const colorMap = await getWorkItemTypeColors(config);
                    const types: Record<string, { color: string; name: string; icon: { id: string; url: string } }> =
                        {};

                    for (const [name, info] of colorMap) {
                        types[name] = info;
                    }

                    return { types };
                },
                "POST /api/timelog-entries": async (body) => {
                    const { getTimelogEntries } = await import("./export");
                    return getTimelogEntries(body.month as number, body.year as number);
                },
            };

            server.middlewares.use(async (req, res, next) => {
                const url = req.url;

                if (!url?.startsWith("/api/")) {
                    return next();
                }

                const method = req.method ?? "GET";
                const routeKey = `${method} ${url.split("?")[0]}`;
                const handler = routes[routeKey];

                if (!handler) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: "Not found" }));
                    return;
                }

                try {
                    let body: Record<string, unknown> = {};

                    if (method !== "GET") {
                        const chunks: Buffer[] = [];
                        for await (const chunk of req) {
                            chunks.push(chunk as Buffer);
                        }

                        const raw = Buffer.concat(chunks).toString();

                        if (raw) {
                            body = JSON.parse(raw);
                        }
                    }

                    const result = await handler(body);
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify(result));
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    const stack = err instanceof Error ? err.stack : undefined;
                    console.error(`[clarity-api] ${routeKey} failed:`, message);

                    if (stack) {
                        console.error(stack);
                    }

                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: message }));
                }
            });
        },
    };
}
