import { selfPingMs } from "@app/dev-dashboard/lib/net/ping";
import { deriveNetStatus } from "@app/dev-dashboard/lib/net/status";
import type { NetStatus, NetTransport } from "@app/dev-dashboard/lib/net/types";
import { getCachedPulse } from "@app/dev-dashboard/lib/system/poller";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

let boundDashboardPort: number | null = null;

/** Called at server boot so self-ping targets the actually-bound port. */
export function setDashboardBoundPort(port: number): void {
    boundDashboardPort = port;
}

function getDashboardBoundPort(): number {
    return boundDashboardPort ?? 3042;
}

export async function checkNetStatusForPort(port: number): Promise<NetStatus> {
    const baseUrl = `http://127.0.0.1:${port}`;
    const pingMs = await selfPingMs(baseUrl);
    const pulse = getCachedPulse();
    const activeTransport: NetTransport = "lan";
    return deriveNetStatus({ pulse, pingMs, activeTransport });
}

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
                    const body = await checkNetStatusForPort(getDashboardBoundPort());

                    return { kind: "json", status: 200, body };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
