import { buildAttentionItems } from "@app/dev-dashboard/lib/attention/aggregator";
import { listTtyd } from "@app/dev-dashboard/lib/ttyd/manager";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";
import { defaultDbPath } from "@app/question/commands/log";
import { openReadModel, queryEntries } from "@app/question/lib/read-model";

export function attentionRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/attention",
            handler: async () => {
                let db: ReturnType<typeof openReadModel> | undefined;

                try {
                    db = openReadModel(defaultDbPath());
                    // tag+unread pushed down in SQL; the aggregator owns the "today" window.
                    const qaEntries = queryEntries(db, { tag: "action", unread: true, limit: 200 });
                    const ttydSessions = await listTtyd();
                    const items = buildAttentionItems({ qaEntries, ttydSessions });

                    return { kind: "json", status: 200, body: { items, count: items.length } };
                } catch (err) {
                    return errorResult(err);
                } finally {
                    db?.close(); // bun:sqlite has no GC finalizer — close every request or leak an FD
                }
            },
        },
    ];
}
