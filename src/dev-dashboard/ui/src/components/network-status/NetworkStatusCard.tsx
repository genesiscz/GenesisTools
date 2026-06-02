import type { NetQuality, NetStatus, NetTransport } from "@app/dev-dashboard/lib/net/types";

interface NetworkStatusCardProps {
    status: NetStatus;
}

const DASH = "—";

function qualityLabel(quality: NetQuality): string {
    if (quality === "healthy") {
        return "Healthy";
    }

    if (quality === "degraded") {
        return "Degraded";
    }

    return "Down";
}

function qualityColor(quality: NetQuality): string {
    if (quality === "healthy") {
        return "var(--dd-accent-from)";
    }

    if (quality === "degraded") {
        return "#fbbf24";
    }

    return "#f87171";
}

function transportLabel(transport: NetTransport): string {
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

function latencyText(ms: number | null): string {
    if (ms === null || Number.isNaN(ms)) {
        return DASH;
    }

    return `${Math.round(ms)} ms`;
}

interface FactRowProps {
    label: string;
    value: string;
}

function FactRow({ label, value }: FactRowProps) {
    return (
        <div className="flex items-center justify-between border-t border-[var(--dd-border)] px-1 py-2.5 text-sm first:border-t-0">
            <span className="text-[var(--dd-text-secondary)]">{label}</span>
            <span className="font-mono text-[var(--dd-text-primary)]">{value}</span>
        </div>
    );
}

/**
 * At-a-glance health card for the active link — mirrors the mobile `StatusCard`. A quality pill
 * (Healthy/Degraded/Down) + a key/value summary (transport, latency, SSID, public IP). The backend
 * `/api/net/status` already classified the link via `deriveNetStatus`; this just renders the DTO.
 */
export function NetworkStatusCard({ status }: NetworkStatusCardProps) {
    const color = qualityColor(status.quality);

    return (
        <div className="dd-panel flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
                <h3 className="dd-accent-text text-lg font-semibold">Active link</h3>
                <div className="flex items-center gap-2 text-sm">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                    <span style={{ color }}>{qualityLabel(status.quality)}</span>
                </div>
            </div>
            <div className="flex flex-col">
                <FactRow label="Transport" value={transportLabel(status.transport)} />
                <FactRow label="Latency" value={latencyText(status.latencyMs)} />
                <FactRow label="Wi-Fi" value={status.ssid ?? DASH} />
                <FactRow label="Public IP" value={status.publicIp ?? DASH} />
            </div>
        </div>
    );
}
