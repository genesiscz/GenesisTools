import { describe, expect, it } from "bun:test";
import {
    DASH,
    deriveNetStatus,
    latencyText,
    LATENCY_DEGRADED_MS,
    LATENCY_HEALTHY_MS,
    qualityLabel,
    qualityTone,
    transportLabel,
} from "@/features/network-status/units";

const PULSE = { wifiSsid: "Foltyn-5G", publicIp: "203.0.113.7" };

describe("network-status units — deriveNetStatus", () => {
    it("classifies latency bands + null ping + no transport", () => {
        expect(deriveNetStatus({ pulse: PULSE, pingMs: 40, activeTransport: "lan" }).quality).toBe("healthy");
        expect(deriveNetStatus({ pulse: PULSE, pingMs: LATENCY_HEALTHY_MS + 1, activeTransport: "lan" }).quality).toBe("degraded");
        expect(deriveNetStatus({ pulse: PULSE, pingMs: LATENCY_DEGRADED_MS + 9, activeTransport: "lan" }).quality).toBe("degraded");
        expect(deriveNetStatus({ pulse: PULSE, pingMs: null, activeTransport: "lan" }).quality).toBe("down");
        expect(deriveNetStatus({ pulse: PULSE, pingMs: 40, activeTransport: null }).transport).toBe("none");
    });

    it("passes ssid + publicIp through, tolerates null pulse", () => {
        expect(deriveNetStatus({ pulse: PULSE, pingMs: 40, activeTransport: "lan" }).ssid).toBe("Foltyn-5G");
        expect(deriveNetStatus({ pulse: null, pingMs: 40, activeTransport: "lan" }).publicIp).toBeNull();
    });
});

describe("network-status units — formatters", () => {
    it("qualityLabel maps each quality", () => {
        expect(qualityLabel("healthy")).toBe("Healthy");
        expect(qualityLabel("degraded")).toBe("Degraded");
        expect(qualityLabel("down")).toBe("Down");
    });

    it("qualityTone maps quality → pill tone", () => {
        expect(qualityTone("healthy")).toBe("accent");
        expect(qualityTone("degraded")).toBe("muted");
        expect(qualityTone("down")).toBe("danger");
    });

    it("transportLabel humanizes each tier", () => {
        expect(transportLabel("lan")).toBe("LAN");
        expect(transportLabel("tailscale")).toBe("Tailscale");
        expect(transportLabel("cloudflared-self")).toBe("Cloudflare Tunnel");
        expect(transportLabel("managed")).toBe("Managed Relay");
        expect(transportLabel("none")).toBe("Not connected");
    });

    it("latencyText formats ms / em-dash on null", () => {
        expect(latencyText(42)).toBe("42 ms");
        expect(latencyText(null)).toBe(DASH);
    });
});
