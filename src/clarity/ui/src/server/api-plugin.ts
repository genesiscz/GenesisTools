import type { Plugin } from "vite";
import { getExportData } from "./export";
import { executeFill, getFillPreview } from "./fill";
import { addMapping, getMappings, removeMapping } from "./mappings";
import { getStatus, testConnection, updateAuth } from "./settings";

type ApiHandler = (body: Record<string, unknown>) => Promise<unknown>;

const routes: Record<string, ApiHandler> = {
    "GET /api/mappings": () => getMappings(),
    "POST /api/mappings": (body) => addMapping(body),
    "DELETE /api/mappings": (body) => removeMapping(body.adoWorkItemId as number),
    "POST /api/export": (body) => getExportData(body.month as number, body.year as number),
    "POST /api/fill/preview": (body) => getFillPreview(body.month as number, body.year as number),
    "POST /api/fill/execute": (body) =>
        executeFill(body.month as number, body.year as number, body.weekIds as number[]),
    "GET /api/status": () => getStatus(),
    "POST /api/test-connection": () => testConnection(),
    "POST /api/update-auth": (body) => updateAuth(body.curl as string),
};

export function apiPlugin(): Plugin {
    return {
        name: "clarity-api",
        configureServer(server) {
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
