import { collectProcesses, killProcess, sortProcesses } from "@app/dev-dashboard/lib/system/processes";
import type { ProcessSort } from "@app/dev-dashboard/lib/system/types";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function parseSort(value: string | null): ProcessSort {
    return value === "name" ? "name" : "rss";
}

function parseLimit(value: string | null): number {
    const raw = Number.parseInt(value ?? String(DEFAULT_LIMIT), 10);

    if (!Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_LIMIT;
    }

    return Math.min(raw, MAX_LIMIT);
}

export function processesRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/processes",
            handler: async (ctx) => {
                try {
                    const sort = parseSort(ctx.query.get("sort"));
                    const limit = parseLimit(ctx.query.get("limit"));
                    const processes = sortProcesses(await collectProcesses(), sort).slice(0, limit);

                    return { kind: "json", status: 200, body: { sort, processes } };
                } catch (err) {
                    logger.warn({ error: err, route: "GET /api/processes" }, "process list collection failed");
                    return errorResult(err);
                }
            },
        },
        {
            method: "POST",
            pattern: "/api/processes/kill",
            handler: async (ctx) => {
                try {
                    const { pid } = await ctx.readJson<{ pid?: number }>();

                    if (typeof pid !== "number") {
                        return { kind: "json", status: 400, body: { ok: false, error: "missing numeric pid" } };
                    }

                    return { kind: "json", status: 200, body: { ok: killProcess(pid) } };
                } catch (err) {
                    logger.warn({ error: err, route: "POST /api/processes/kill" }, "process kill failed");
                    return errorResult(err);
                }
            },
        },
    ];
}
