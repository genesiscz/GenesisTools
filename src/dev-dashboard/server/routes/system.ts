import { ENDPOINTS } from "@app/dev-dashboard/contract/endpoint-table";
import { getCachedPulse, getSeries, markPulseClientSeen } from "@app/dev-dashboard/lib/system/poller";
import { bindHandler } from "@app/dev-dashboard/server/bind";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function systemRoutes(): RouteDef[] {
    return [
        bindHandler(ENDPOINTS.pulse, () => {
            markPulseClientSeen();
            return { kind: "json", status: 200, body: getCachedPulse() ?? { capturedAt: null } };
        }),
        bindHandler(ENDPOINTS.pulseHistory, (ctx) => {
            const metric = ctx.query.get("metric") ?? "cpu";
            const minutes = Number.parseInt(ctx.query.get("minutes") ?? "30", 10);

            return {
                kind: "json",
                status: 200,
                body: getSeries(metric, Number.isFinite(minutes) ? minutes : 30),
            };
        }),
    ];
}
