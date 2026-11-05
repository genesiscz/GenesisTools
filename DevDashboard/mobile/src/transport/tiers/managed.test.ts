import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";

// Set before importing the Agent route, which captures its peers path at module initialization.
const pairingHome = mkdtempSync(join(tmpdir(), "mobile-managed-pair-"));
env.testing.set("GENESIS_TOOLS_HOME", pairingHome);
afterAll(() => {
    env.testing.unset("GENESIS_TOOLS_HOME");
    rmSync(pairingHome, { recursive: true, force: true });
});

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
const { toBase64 } = await import("@/transport/e2e/box-cipher");
const { createE2eTransport } = await import("@/transport/e2e-transport");
// The REAL Agent shim — this is the cross-stack proof: a request the phone encrypts is
// decrypted + handled + re-encrypted by the actual Agent code, then decrypted by the phone.
const { createE2eShim } = await import("@app/dev-dashboard/server/transport/e2e-shim");
const { decodeE2eRequest, decodeEnvelope, encodeE2eResponse, encodeEnvelope } = await import("@dd/contract");
const { sealPairAdmission } = await import("@/transport/tiers/managed");
const { e2eRoutes, loadPeers } = await import("@app/dev-dashboard/server/routes/e2e");
const { savePairingCode } = await import("@app/dev-dashboard/lib/e2e/pairing-code");
const { SafeJSON } = await import("@genesiscz/utils/json");

describe("managed tier idempotency (real Agent rpc, real bound route)", () => {
    it("a retried keyed write over the relay returns its first answer and runs once", async () => {
        const { Router } = await import("@app/dev-dashboard/server/router");
        const { ReceiptCache, withTableIdempotency } = await import("@app/dev-dashboard/server/bind");
        const { handleE2eRpc } = await import("@app/dev-dashboard/server/transport/e2e-rpc");
        const { ENDPOINTS } = await import("@dd/contract");
        const agent = naclBoxCipher.keyPair();
        const device = naclBoxCipher.keyPair();
        let runs = 0;
        // A keyed-write row of the table, keyed by the same receipt cache the Mac's routes use.
        const [dismiss] = withTableIdempotency(
            [
                {
                    method: "POST",
                    pattern: ENDPOINTS.qaDecisionsDismiss.path,
                    handler: async () => ({ kind: "json", status: 200, body: { run: ++runs } }),
                },
            ],
            new ReceiptCache()
        );
        const router = new Router().add(dismiss);
        const relayFetch = (async (_url: string, init?: RequestInit) => {
            const responseEnvelope = await handleE2eRpc(String(init?.body), {
                cipher: naclBoxCipher,
                agentKeys: agent,
                resolvePeerKey: () => device.publicKey,
                router,
                services: {} as never,
            });
            return new Response(responseEnvelope, { status: 200 });
        }) as unknown as typeof fetch;
        const client = createE2eTransport({
            relayBaseUrl: "https://relay.vendor.com/agent/abc",
            cipher: naclBoxCipher,
            deviceKeys: device,
            agentPublicKey: agent.publicKey,
            fetchImpl: relayFetch,
        }).client();
        const input = { session: "s-one", number: 1 } as never;

        const first = await client.call(ENDPOINTS.qaDecisionsDismiss, input, { idempotencyKey: "retry-1" });
        const retry = await client.call(ENDPOINTS.qaDecisionsDismiss, input, { idempotencyKey: "retry-1" });

        expect(retry).toEqual(first);
        expect(runs).toBe(1);
    });
});

describe("managed pairing admission (real Agent pair route)", () => {
    async function post(body: string, agent: { publicKey: Uint8Array; secretKey: Uint8Array }) {
        const [route] = e2eRoutes({ cipher: naclBoxCipher, agentKeys: async () => agent });
        const result = await route.handler({
            method: "POST",
            pathname: "/api/e2e/pair",
            query: new URLSearchParams(),
            params: {},
            headers: {},
            readJson: async <T>() => SafeJSON.parse(body, { strict: true }) as T,
            readRawBody: async () => new Uint8Array(),
            services: {} as never,
        });
        return result.kind === "json" ? result.status : 0;
    }

    it("admits the phone's key with the sealed code, and refuses a relay that swaps in its own key", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();
        const relay = naclBoxCipher.keyPair();
        await savePairingCode("K7P2M9QX");
        const sealed = sealPairAdmission({ deviceCode: "K7P2M9QX", agentPublicKey: agent.publicKey, deviceKeys: phone });

        // An active relay forwards the same sealed box but names its own key: the box no longer opens.
        const { envelope } = SafeJSON.parse(sealed, { strict: true }) as { envelope: string };
        const swapped = encodeEnvelope({ ...decodeEnvelope(envelope), epk: toBase64(relay.publicKey) });
        expect(await post(SafeJSON.stringify({ envelope: swapped }, { strict: true }), agent)).toBe(403);
        expect(sealed).not.toContain("K7P2M9QX");

        expect(await post(sealed, agent)).toBe(200);
        const peers = await loadPeers();
        expect(Object.keys(peers)).toContain(toBase64(phone.publicKey));
        expect(Object.keys(peers)).not.toContain(toBase64(relay.publicKey));
    });
});

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

    it("reachable() is false when the Mac answers the sealed pulse with an error status", async () => {
        const agent = naclBoxCipher.keyPair();
        const device = naclBoxCipher.keyPair();
        const shim = createE2eShim({
            cipher: naclBoxCipher,
            agentKeys: agent,
            resolvePeerKey: () => device.publicKey,
            handle: async () =>
                new TextEncoder().encode(encodeE2eResponse({ status: 500, body: '{"error":"collector failed"}' })),
        });
        const relayFetch = (async (_url: string, init?: RequestInit) =>
            new Response(await shim.handleEncrypted(String(init?.body)), { status: 200 })) as unknown as typeof fetch;
        const t = createE2eTransport({
            relayBaseUrl: "https://relay.vendor.com/agent/abc",
            cipher: naclBoxCipher,
            deviceKeys: device,
            agentPublicKey: agent.publicKey,
            fetchImpl: relayFetch,
        });

        expect(await t.reachable()).toBe(false);
    });

    it("reachable() gives up at the probe deadline when the relay never answers", async () => {
        const agent = naclBoxCipher.keyPair();
        const device = naclBoxCipher.keyPair();
        // A relay that holds the request open until the caller aborts it.
        const hangingFetch = ((_url: string, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })) as unknown as typeof fetch;
        const t = createE2eTransport({
            relayBaseUrl: "https://relay.vendor.com/agent/abc",
            cipher: naclBoxCipher,
            deviceKeys: device,
            agentPublicKey: agent.publicKey,
            fetchImpl: hangingFetch,
            probeTimeoutMs: 30,
        });

        expect(await t.reachable()).toBe(false);
    });

    it("adapts encrypted relay SSE into the real client QA subscription", async () => {
        const agent = naclBoxCipher.keyPair();
        const device = naclBoxCipher.keyPair();
        let streamOptions: Parameters<NonNullable<Parameters<typeof createE2eTransport>[0]["streamSseImpl"]>>[0] | undefined;
        let closed = false;
        const transport = createE2eTransport({
            relayBaseUrl: "https://relay.vendor.com/agent/abc",
            cipher: naclBoxCipher,
            deviceKeys: device,
            agentPublicKey: agent.publicKey,
            streamSseImpl: (options) => {
                streamOptions = options;
                return {
                    close() {
                        closed = true;
                    },
                };
            },
        });
        const received: string[] = [];
        const subscription = transport
            .client()
            .qa.subscribe((entry) => received.push((entry as unknown as { id: string }).id));
        await Promise.resolve();

        const nonce = naclBoxCipher.randomNonce();
        const plaintext = new TextEncoder().encode('{"type":"qa","id":"encrypted-row"}');
        const ciphertext = naclBoxCipher.seal({
            plaintext,
            nonce,
            recipientPublicKey: device.publicKey,
            senderSecretKey: agent.secretKey,
        });
        const encryptedFrame = encodeEnvelope({
            v: 1,
            epk: toBase64(agent.publicKey),
            n: toBase64(nonce),
            ct: toBase64(ciphertext),
        });

        streamOptions?.onEvent({ data: encryptedFrame });
        streamOptions?.onEvent({ data: '{"type":"qa","id":"plaintext-leak"}' });
        expect(received).toEqual(["encrypted-row"]);

        subscription.close();
        expect(closed).toBe(true);
    });
});
