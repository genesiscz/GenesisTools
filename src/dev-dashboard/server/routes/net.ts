import { selfPingMs } from "@app/dev-dashboard/lib/net/ping";
import { deriveNetStatus } from "@app/dev-dashboard/lib/net/status";
import type { NetTransport } from "@app/dev-dashboard/lib/net/types";
import { getCachedPulse } from "@app/dev-dashboard/lib/system/poller";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

const DASHBOARD_PORT = 3042;

/**
 * GET /api/net/status — at-a-glance health of the active link. Composes the cached PulseSnapshot
 * (wifiSsid + publicIp, already polled by the system poller) with a fresh self-ping, classified by
 * the pure deriveNetStatus. The server's own surface is reachable at loopback, so the ping measures
 * the agent's serve latency (the floor); the mobile client recomputes quality against ITS round-trip
 * over the active transport, so the device's number reflects the real network path.
 */
export function netRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/net/status",
            handler: async () => {
                try {
                    const pulse = getCachedPulse();
                    const baseUrl = `http://127.0.0.1:${DASHBOARD_PORT}`;
                    const pingMs = await selfPingMs(baseUrl);
                    // Server-side the transport is always loopback ("lan" from the agent's view); the
                    // device overrides this with its real tier client-side (units.ts deriveNetStatus).
                    const activeTransport: NetTransport = "lan";
                    const body = deriveNetStatus({ pulse, pingMs, activeTransport });

                    return { kind: "json", status: 200, body };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
