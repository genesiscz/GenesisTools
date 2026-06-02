import type { NetQuality, NetStatus, NetTransport } from "@dd/contract";
import type { PillTone } from "@/ui/StatusPill";

/**
 * Pure logic for the network-status screen. Reimplemented locally (NOT imported from `@app/*`) so the
 * RN bundle never drags server code in — same rule as `features/daemon/units.ts`. `deriveNetStatus`
 * is byte-for-byte the same classification as the backend `lib/net/status.ts`; the cross-copy parity
 * is guarded by identical fixtures in both *.test.ts files. Pure logic only — runs under `bun:test`.
 */

export const DASH = "—";
export const LATENCY_HEALTHY_MS = 150;
export const LATENCY_DEGRADED_MS = 600;

interface DeriveInput {
    pulse: { wifiSsid: string | null; publicIp: string | null } | null;
    pingMs: number | null;
    activeTransport: NetTransport | null;
}

export function deriveNetStatus({ pulse, pingMs, activeTransport }: DeriveInput): NetStatus {
    const ssid = pulse?.wifiSsid ?? null;
    const publicIp = pulse?.publicIp ?? null;

    if (activeTransport === null) {
        return { transport: "none", latencyMs: null, quality: "down", ssid, publicIp };
    }

    if (pingMs === null) {
        return { transport: activeTransport, latencyMs: null, quality: "down", ssid, publicIp };
    }

    const quality: NetQuality = pingMs <= LATENCY_HEALTHY_MS ? "healthy" : "degraded";
    return { transport: activeTransport, latencyMs: pingMs, quality, ssid, publicIp };
}

export function qualityLabel(quality: NetQuality): string {
    if (quality === "healthy") {
        return "Healthy";
    }

    if (quality === "degraded") {
        return "Degraded";
    }

    return "Down";
}

export function qualityTone(quality: NetQuality): PillTone {
    if (quality === "healthy") {
        return "accent";
    }

    if (quality === "degraded") {
        return "muted";
    }

    return "danger";
}

export function transportLabel(transport: NetTransport): string {
    switch (transport) {
        case "lan":
            return "LAN";
        case "tailscale":
            return "Tailscale";
        case "cloudflared-self":
            return "Cloudflare Tunnel";
        case "managed":
            return "Managed Relay";
        default:
            return "Not connected";
    }
}

export function latencyText(ms: number | null): string {
    if (ms === null || Number.isNaN(ms)) {
        return DASH;
    }

    return `${Math.round(ms)} ms`;
}
