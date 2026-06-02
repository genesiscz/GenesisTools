import { describe, expect, it, mock } from "bun:test";

// The decorator's module graph pulls native packages (`expo/fetch`, `partysocket`,
// `react-native`, `expo-secure-store`). Stub them so the pure crypto path loads under bun;
// the test injects its own loopback `fetchImpl`, so the real fetch is never called.
mock.module("expo/fetch", () => ({ fetch: async () => new Response("") }));
mock.module("partysocket", () => ({ WebSocket: class {} }));
mock.module("react-native", () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }));
mock.module("expo-secure-store", () => ({
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
}));

const { naclBoxCipher } = await import("@/transport/e2e/box-cipher");
const { createE2eTransport } = await import("@/transport/e2e-transport");
// The REAL Agent shim — this is the cross-stack proof: a request the phone encrypts is
// decrypted + handled + re-encrypted by the actual Agent code, then decrypted by the phone.
const { createE2eShim } = await import("@app/dev-dashboard/server/transport/e2e-shim");
const { decodeE2eRequest, encodeE2eResponse } = await import("@dd/contract");

describe("createE2eTransport (managed tier, real Agent shim loopback)", () => {
    it("encrypts an outbound request and decrypts the agent's response", async () => {
        const agent = naclBoxCipher.keyPair();
        const device = naclBoxCipher.keyPair();

        const shim = createE2eShim({
            cipher: naclBoxCipher,
            agentKeys: agent,
            resolvePeerKey: () => device.publicKey,
            // The "server": decode the inner E2eRequest, echo its method+path back as an E2eResponse.
            handle: async (plaintext) => {
                const req = decodeE2eRequest(new TextDecoder().decode(plaintext));
                const responseBody = JSON.stringify({ echoed: `${req.method} ${req.path}` });
                return new TextEncoder().encode(encodeE2eResponse({ status: 200, body: responseBody }));
            },
        });

        // The relay just forwards the request envelope to the shim and returns the response envelope.
        const relayFetch = (async (_url: string, init?: RequestInit) => {
            const responseEnvelope = await shim.handleEncrypted(String(init?.body));
            return new Response(responseEnvelope, { status: 200 });
        }) as unknown as typeof fetch;

        const t = createE2eTransport({
            relayBaseUrl: "https://relay.vendor.com/agent/abc",
            cipher: naclBoxCipher,
            deviceKeys: device,
            agentPublicKey: agent.publicKey,
            fetchImpl: relayFetch,
        });

        expect(t.tier).toBe("managed");
        expect(t.baseUrl()).toBe("https://relay.vendor.com/agent/abc");

        const pulse = await t.client().system.pulse();
        expect((pulse as unknown as { echoed: string }).echoed).toBe("GET /api/system/pulse");
    });

    it("reachable() returns false when the relay decryption fails", async () => {
        const agent = naclBoxCipher.keyPair();
        const device = naclBoxCipher.keyPair();
        const wrongAgent = naclBoxCipher.keyPair();

        const shim = createE2eShim({
            cipher: naclBoxCipher,
            agentKeys: agent,
            resolvePeerKey: () => device.publicKey,
            handle: async () => new TextEncoder().encode(encodeE2eResponse({ status: 200, body: "{}" })),
        });
        const relayFetch = (async (_url: string, init?: RequestInit) => {
            const responseEnvelope = await shim.handleEncrypted(String(init?.body));
            return new Response(responseEnvelope, { status: 200 });
        }) as unknown as typeof fetch;

        // The device seals to the WRONG agent key, so the shim cannot open the box -> throws -> false.
        const t = createE2eTransport({
            relayBaseUrl: "https://relay.vendor.com/agent/abc",
            cipher: naclBoxCipher,
            deviceKeys: device,
            agentPublicKey: wrongAgent.publicKey,
            fetchImpl: relayFetch,
        });
        expect(await t.reachable()).toBe(false);
    });
});
