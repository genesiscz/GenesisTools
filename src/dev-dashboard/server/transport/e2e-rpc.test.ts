import { describe, expect, it } from "bun:test";
import { decodeE2eResponse, encodeE2eRequest, type E2eRequest } from "@app/dev-dashboard/contract/e2e-request";
import { encodeEnvelope } from "@app/dev-dashboard/contract/e2e-envelope";
import { fromBase64, naclBoxCipher, toBase64 } from "@app/dev-dashboard/lib/e2e/box";
import type { KeyPair } from "@app/dev-dashboard/lib/e2e/box";
import type { PulseSnapshot } from "@app/dev-dashboard/lib/system/types";
import type { SystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";
import { Router } from "@app/dev-dashboard/server/router";
import { handleE2eRpc, type E2eRpcDeps } from "@app/dev-dashboard/server/transport/e2e-rpc";
import { SafeJSON } from "@app/utils/json";

const fakeCollector: SystemCollector = {
    platform: "macos",
    collect: () => Promise.resolve({ capturedAt: null } as unknown as PulseSnapshot),
};
const services = { collector: fakeCollector };

function buildRouter(): Router {
    return new Router()
        .add({
            method: "GET",
            pattern: "/api/system/pulse",
            handler: (ctx) => ({ kind: "json", status: 200, body: { ok: true, q: ctx.query.get("n") } }),
        })
        .add({
            method: "POST",
            pattern: "/api/echo",
            handler: async (ctx) => {
                const body = await ctx.readJson<{ msg?: string }>();
                return { kind: "json", status: 201, body: { echoed: body.msg } };
            },
        })
        .add({
            method: "GET",
            pattern: "/api/qa/stream",
            longLived: true,
            handler: () => ({
                kind: "sse",
                start: (emit) => {
                    emit.data("hi");
                    return { close: () => {} };
                },
            }),
        });
}

/** Seal an E2eRequest from `phone` to `agent` and wrap it in the wire envelope. */
function sealRequest(req: E2eRequest, agent: KeyPair, phone: KeyPair): string {
    const nonce = naclBoxCipher.randomNonce();
    const ct = naclBoxCipher.seal({
        plaintext: new TextEncoder().encode(encodeE2eRequest(req)),
        nonce,
        recipientPublicKey: agent.publicKey,
        senderSecretKey: phone.secretKey,
    });

    return encodeEnvelope({ v: 1, epk: toBase64(phone.publicKey), n: toBase64(nonce), ct: toBase64(ct) });
}

/** Open the response envelope back into an E2eResponse using the phone's keys. */
function openResponse(responseEnvelope: string, agent: KeyPair, phone: KeyPair) {
    const env = SafeJSON.parse(responseEnvelope, { strict: true }) as { n: string; ct: string };
    const plain = naclBoxCipher.open({
        ciphertext: fromBase64(env.ct),
        nonce: fromBase64(env.n),
        senderPublicKey: agent.publicKey,
        recipientSecretKey: phone.secretKey,
    });

    if (!plain) {
        throw new Error("test: failed to open response envelope");
    }

    return decodeE2eResponse(new TextDecoder().decode(plain));
}

function depsFor(agent: KeyPair, phone: KeyPair): E2eRpcDeps {
    return {
        cipher: naclBoxCipher,
        agentKeys: agent,
        resolvePeerKey: (epk) => (epk === toBase64(phone.publicKey) ? phone.publicKey : null),
        router: buildRouter(),
        services,
    };
}

describe("handleE2eRpc", () => {
    it("decrypts a GET, replays it through the router, and returns an encrypted response", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();

        const envelope = sealRequest({ method: "GET", path: "/api/system/pulse?n=7" }, agent, phone);
        const responseEnvelope = await handleE2eRpc(envelope, depsFor(agent, phone));
        const res = openResponse(responseEnvelope, agent, phone);

        expect(res.status).toBe(200);
        expect(SafeJSON.parse(res.body, { strict: true })).toEqual({ ok: true, q: "7" });
    });

    it("carries a POST body through to the handler", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();

        const envelope = sealRequest(
            { method: "POST", path: "/api/echo", body: SafeJSON.stringify({ msg: "hello" }) },
            agent,
            phone
        );
        const responseEnvelope = await handleE2eRpc(envelope, depsFor(agent, phone));
        const res = openResponse(responseEnvelope, agent, phone);

        expect(res.status).toBe(201);
        expect(SafeJSON.parse(res.body, { strict: true })).toEqual({ echoed: "hello" });
    });

    it("returns an encrypted 404 when no route matches (not an error)", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();

        const envelope = sealRequest({ method: "GET", path: "/api/nope" }, agent, phone);
        const responseEnvelope = await handleE2eRpc(envelope, depsFor(agent, phone));
        const res = openResponse(responseEnvelope, agent, phone);

        expect(res.status).toBe(404);
    });

    it("returns an encrypted 501 for an SSE route (streaming out of scope)", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();

        const envelope = sealRequest({ method: "GET", path: "/api/qa/stream" }, agent, phone);
        const responseEnvelope = await handleE2eRpc(envelope, depsFor(agent, phone));
        const res = openResponse(responseEnvelope, agent, phone);

        expect(res.status).toBe(501);
    });

    it("throws when the sender's epk is not in the paired allowlist", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();
        const attacker = naclBoxCipher.keyPair();

        // The attacker seals with its own key — its epk is not paired, so resolvePeerKey returns null.
        const envelope = sealRequest({ method: "GET", path: "/api/system/pulse" }, agent, attacker);
        await expect(handleE2eRpc(envelope, depsFor(agent, phone))).rejects.toThrow();
    });

    it("throws on a malformed envelope", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();

        await expect(handleE2eRpc("not-json", depsFor(agent, phone))).rejects.toThrow();
    });

    it("throws when the ciphertext fails the MAC check (tampered)", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();

        // A paired epk but garbage ciphertext → open() returns null → throw.
        const envelope = encodeEnvelope({
            v: 1,
            epk: toBase64(phone.publicKey),
            n: toBase64(naclBoxCipher.randomNonce()),
            ct: toBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])),
        });
        await expect(handleE2eRpc(envelope, depsFor(agent, phone))).rejects.toThrow();
    });
});
