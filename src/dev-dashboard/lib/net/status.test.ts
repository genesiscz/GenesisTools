import { describe, expect, it } from "bun:test";
import { deriveNetStatus, LATENCY_DEGRADED_MS, LATENCY_HEALTHY_MS } from "@app/dev-dashboard/lib/net/status";

const PULSE = { wifiSsid: "Foltyn-5G", publicIp: "203.0.113.7" };

describe("deriveNetStatus", () => {
    it("low latency on a live transport = healthy, passes SSID + IP through", () => {
        const s = deriveNetStatus({ pulse: PULSE, pingMs: 40, activeTransport: "lan" });
        expect(s).toEqual({
            transport: "lan",
            latencyMs: 40,
            quality: "healthy",
            ssid: "Foltyn-5G",
            publicIp: "203.0.113.7",
        });
    });

    it("mid latency = degraded", () => {
        expect(
            deriveNetStatus({ pulse: PULSE, pingMs: LATENCY_HEALTHY_MS + 1, activeTransport: "tailscale" }).quality
        ).toBe("degraded");
        expect(
            deriveNetStatus({ pulse: PULSE, pingMs: LATENCY_DEGRADED_MS, activeTransport: "tailscale" }).quality
        ).toBe("degraded");
    });

    it("very high latency stays degraded (a slow link still works)", () => {
        expect(
            deriveNetStatus({ pulse: PULSE, pingMs: LATENCY_DEGRADED_MS + 500, activeTransport: "cloudflared-self" })
                .quality
        ).toBe("degraded");
    });

    it("failed ping (null) on a live transport = down, latency null", () => {
        const s = deriveNetStatus({ pulse: PULSE, pingMs: null, activeTransport: "managed" });
        expect(s.quality).toBe("down");
        expect(s.latencyMs).toBeNull();
        expect(s.transport).toBe("managed");
    });

    it("no active transport = down + transport 'none', still surfaces pulse fields", () => {
        const s = deriveNetStatus({ pulse: PULSE, pingMs: 40, activeTransport: null });
        expect(s.transport).toBe("none");
        expect(s.quality).toBe("down");
        expect(s.latencyMs).toBeNull();
        expect(s.ssid).toBe("Foltyn-5G");
    });

    it("missing pulse → null ssid + ip without throwing", () => {
        const s = deriveNetStatus({ pulse: null, pingMs: 40, activeTransport: "lan" });
        expect(s.ssid).toBeNull();
        expect(s.publicIp).toBeNull();
        expect(s.quality).toBe("healthy");
    });
});
