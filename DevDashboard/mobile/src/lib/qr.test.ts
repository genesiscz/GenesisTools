import { parseScannedPairing } from "@/lib/qr";
import { describe, expect, it } from "bun:test";

describe("parseScannedPairing", () => {
    it("accepts a self-cloudflared pairing URI", () => {
        const r = parseScannedPairing(
            "devdashboard://pair?tier=cloudflared-self&baseUrl=https%3A%2F%2Fmac.example.com&username=martin",
        );
        expect(r?.tier).toBe("cloudflared-self");
        expect(r?.baseUrl).toBe("https://mac.example.com");
    });

    it("accepts a managed pairing URI with an agent public key", () => {
        const r = parseScannedPairing(
            "devdashboard://pair?tier=managed&baseUrl=https%3A%2F%2Frelay.v.com%2Fa&username=m&pk=AAAA",
        );
        expect(r?.agentPublicKey).toBe("AAAA");
    });

    it("rejects a non-pairing QR (e.g. a random URL)", () => {
        expect(parseScannedPairing("https://google.com")).toBeNull();
    });
});
