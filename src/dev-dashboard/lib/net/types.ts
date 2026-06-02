export type NetTransport = "lan" | "tailscale" | "cloudflared-self" | "managed" | "none";
export type NetQuality = "healthy" | "degraded" | "down";

export interface NetStatus {
    transport: NetTransport;
    latencyMs: number | null;
    quality: NetQuality;
    ssid: string | null;
    publicIp: string | null;
}

export interface DeriveNetStatusInput {
    pulse: { wifiSsid: string | null; publicIp: string | null } | null;
    pingMs: number | null;
    activeTransport: NetTransport | null;
}
