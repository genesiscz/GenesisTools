import { createRunLogTail } from "@app/dev-dashboard/lib/daemon-run-tail";
import {
    getAllRecentRuns,
    getDaemonOverview,
    getRecentRuns,
    getRunLog,
} from "@app/dev-dashboard/lib/daemon-view/aggregator";
import { classifyLogLine } from "@app/dev-dashboard/lib/daemon-view/classify";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";

export function daemonRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/daemon/status",
            handler: async () => {
                try {
                    return { kind: "json", status: 200, body: await getDaemonOverview() };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/daemon/runs",
            handler: (ctx) => {
                const task = ctx.query.get("task");
                const limit = Number.parseInt(ctx.query.get("limit") ?? "20", 10);
                const safeLimit = Number.isFinite(limit) ? limit : 20;

                try {
                    const runs = task ? getRecentRuns({ task, limit: safeLimit }) : getAllRecentRuns(safeLimit);

                    return { kind: "json", status: 200, body: runs };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/daemon/runs/log",
            handler: (ctx) => {
                const logFile = ctx.query.get("logFile");

                if (!logFile) {
                    return { kind: "json", status: 400, body: { error: "missing ?logFile=" } };
                }

                try {
                    return { kind: "json", status: 200, body: getRunLog(logFile) };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
        {
            method: "GET",
            pattern: "/api/daemon/runs/tail",
            longLived: true,
            handler: (ctx) => {
                const logFile = ctx.query.get("logFile");

                if (!logFile) {
                    return { kind: "json", status: 400, body: { error: "missing ?logFile=" } };
                }

                return {
                    kind: "sse",
                    start: (emit) => {
                        emit.comment(" build-log tail open");
                        let tail: ReturnType<typeof createRunLogTail> | null = null;

                        try {
                            tail = createRunLogTail(logFile, (entry) =>
                                emit.data(SafeJSON.stringify({ ...entry, cls: classifyLogLine(entry) })),
                            );
                        } catch (err) {
                            // Containment guard rejected the path — surface one error frame, keep the SSE
                            // open so the client sees it, then it'll close on disconnect.
                            emit.data(
                                SafeJSON.stringify({
                                    type: "error",
                                    message: err instanceof Error ? err.message : String(err),
                                }),
                            );
                        }

                        const keepAlive = setInterval(() => emit.comment(" ping"), 12_000);

                        return {
                            close: () => {
                                clearInterval(keepAlive);
                                tail?.close();
                            },
                        };
                    },
                };
            },
        },
    ];
}
