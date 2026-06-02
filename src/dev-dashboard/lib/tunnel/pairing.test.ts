import { describe, expect, it } from "bun:test";
import { buildPairingPayload, parsePairingPayload } from "@app/dev-dashboard/lib/tunnel/pairing";

describe("pairing payload (re-exported contract codec)", () => {
    it("round-trips a self-cloudflared pairing payload", () => {
        const payload = buildPairingPayload({
            tier: "cloudflared-self",
            baseUrl: "https://mac.example.com",
            username: "martin",
        });
        const parsed = parsePairingPayload(payload);
        expect(parsed).toEqual({
            tier: "cloudflared-self",
            baseUrl: "https://mac.example.com",
            username: "martin",
        });
    });

    it("round-trips a managed payload with the agent public key", () => {
        const payload = buildPairingPayload({
            tier: "managed",
            baseUrl: "https://martin.devdashboard.app",
            username: "martin",
            agentPublicKey: "QUJDREVGR0g=",
        });
        const parsed = parsePairingPayload(payload);
        expect(parsed).toEqual({
            tier: "managed",
            baseUrl: "https://martin.devdashboard.app",
            username: "martin",
            agentPublicKey: "QUJDREVGR0g=",
        });
    });

    it("rejects a malformed payload", () => {
        expect(parsePairingPayload("not-a-dd-pairing-uri")).toBeNull();
    });

    it("rejects a wrong scheme", () => {
        expect(parsePairingPayload("https://example.com")).toBeNull();
    });
});
