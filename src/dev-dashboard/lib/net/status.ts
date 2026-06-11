import type { DeriveNetStatusInput, NetStatus } from "@app/dev-dashboard/lib/net/types";

export const LATENCY_HEALTHY_MS = 150;
export const LATENCY_DEGRADED_MS = 600;

/** Pure classification of the active link into a health DTO. No I/O — unit-tested in status.test.ts. */
export function deriveNetStatus({ pulse, pingMs, activeTransport }: DeriveNetStatusInput): NetStatus {
    const ssid = pulse?.wifiSsid ?? null;
    const publicIp = pulse?.publicIp ?? null;

    if (activeTransport === null) {
        return { transport: "none", latencyMs: null, quality: "down", ssid, publicIp };
    }

    if (pingMs === null) {
        return { transport: activeTransport, latencyMs: null, quality: "down", ssid, publicIp };
    }

    const quality = pingMs <= LATENCY_HEALTHY_MS ? "healthy" : pingMs <= LATENCY_DEGRADED_MS ? "degraded" : "down";
    return { transport: activeTransport, latencyMs: pingMs, quality, ssid, publicIp };
}
