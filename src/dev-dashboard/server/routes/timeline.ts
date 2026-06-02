import { getAllRecentRuns } from "@app/dev-dashboard/lib/daemon-view/aggregator";
import { mergeTimeline } from "@app/dev-dashboard/lib/timeline/merge";
import { listTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { logger } from "@app/logger";
import { defaultDbPath } from "@app/question/commands/log";
import { openReadModel, queryEntries } from "@app/question/lib/read-model";

/** Local midnight today, epoch ms — the default "today on this machine" lower bound. */
function startOfTodayMs(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

const MERGE_SOURCE_LIMIT = 200;

export function timelineRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/timeline",
            handler: async (ctx) => {
                const sinceParam = Number.parseInt(ctx.query.get("since") ?? "", 10);
                const since = Number.isFinite(sinceParam) ? sinceParam : startOfTodayMs();

                let db: ReturnType<typeof openReadModel> | undefined;
                try {
                    const runs = getAllRecentRuns(MERGE_SOURCE_LIMIT);
                    const ttydSessions = await listTtyd();

                    db = openReadModel(defaultDbPath());
                    const qaEntries = queryEntries(db, { limit: MERGE_SOURCE_LIMIT });

                    const events = mergeTimeline({ runs, qaEntries, ttydSessions, since });
                    logger.debug(
                        {
                            route: "GET /api/timeline",
                            since,
                            runs: runs.length,
                            qa: qaEntries.length,
                            ttyd: ttydSessions.length,
                            events: events.length,
                        },
                        "dev-dashboard: timeline merged",
                    );

                    return { kind: "json", status: 200, body: events };
                } catch (err) {
                    return errorResult(err);
                } finally {
                    db?.close();
                }
            },
        },
    ];
}
