import { getCachedPulse, getSeries, markPulseClientSeen } from "@app/dev-dashboard/lib/system/poller";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function systemRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/system/pulse",
            handler: () => {
                markPulseClientSeen();
                return { kind: "json", status: 200, body: getCachedPulse() ?? { capturedAt: null } };
            },
        },
        {
            method: "GET",
            pattern: "/api/system/pulse/history",
            handler: (ctx) => {
                const metric = ctx.query.get("metric") ?? "cpu";
                const minutes = Number.parseInt(ctx.query.get("minutes") ?? "30", 10);

                return {
                    kind: "json",
                    status: 200,
                    body: getSeries(metric, Number.isFinite(minutes) ? minutes : 30),
                };
            },
        },
    ];
}
