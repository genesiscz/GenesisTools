import type { TransportTier } from "@/transport/Transport";

const TIER_LABELS: Record<TransportTier, string> = {
    lan: "LAN",
    tailscale: "TAILSCALE",
    "cloudflared-self": "CLOUDFLARE",
    managed: "MANAGED",
};

export function tierLabel(tier: TransportTier): string {
    return TIER_LABELS[tier];
}

/** Compact "last used" relative string for the connection rows. */
export function relativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;

    if (diff < 60_000) {
        return "just now";
    }

    const minutes = Math.floor(diff / 60_000);

    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return `${hours}h ago`;
    }

    const days = Math.floor(hours / 24);

    if (days < 30) {
        return `${days}d ago`;
    }

    const months = Math.floor(days / 30);
    return `${months}mo ago`;
}
