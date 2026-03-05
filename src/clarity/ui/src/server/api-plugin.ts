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
                "POST /api/export": async (body) => {
                    const { getExportData } = await import("./export");
                    return getExportData(body.month as number, body.year as number);
                },
                "POST /api/fill/preview": async (body) => {
                    const { getFillPreview } = await import("./fill");
                    return getFillPreview(body.month as number, body.year as number);
                },
                "POST /api/fill/execute": async (body) => {
                    const { executeFill } = await import("./fill");
                    return executeFill(body.month as number, body.year as number, body.weekIds as number[]);
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
                    res.statusCode = 500;
                    res.end(
                        JSON.stringify({
                            error: err instanceof Error ? err.message : String(err),
                        })
                    );
                }
            });
        },
    };
}
