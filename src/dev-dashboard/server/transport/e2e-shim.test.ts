import { describe, expect, it } from "bun:test";
import { fromBase64, naclBoxCipher, toBase64 } from "@app/dev-dashboard/lib/e2e/box";
import { encodeEnvelope } from "@app/dev-dashboard/lib/e2e/envelope";
import { createE2eShim } from "@app/dev-dashboard/server/transport/e2e-shim";
import { SafeJSON } from "@app/utils/json";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

function sealRequest(args: {
    plaintext: string;
    agentPublicKey: Uint8Array;
    phoneSecretKey: Uint8Array;
    phonePublicKey: Uint8Array;
}): string {
    const nonce = naclBoxCipher.randomNonce();
    const ct = naclBoxCipher.seal({
        plaintext: encode(args.plaintext),
        nonce,
        recipientPublicKey: args.agentPublicKey,
        senderSecretKey: args.phoneSecretKey,
    });

    return encodeEnvelope({ v: 1, epk: toBase64(args.phonePublicKey), n: toBase64(nonce), ct: toBase64(ct) });
}

describe("createE2eShim", () => {
    it("decrypts a request, runs the handler, and returns an encrypted envelope", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();
        const shim = createE2eShim({
            cipher: naclBoxCipher,
            agentKeys: agent,
            resolvePeerKey: (epk) => (epk === toBase64(phone.publicKey) ? phone.publicKey : null),
            handle: async (plaintext) => encode(SafeJSON.stringify({ echoed: decode(plaintext) })),
        });

        const reqEnvelope = sealRequest({
            plaintext: "GET /api/system/pulse",
            agentPublicKey: agent.publicKey,
            phoneSecretKey: phone.secretKey,
            phonePublicKey: phone.publicKey,
        });

        const resEnvelope = await shim.handleEncrypted(reqEnvelope);
        const parsed = SafeJSON.parse(resEnvelope, { strict: true }) as { n: string; ct: string };
        const plain = naclBoxCipher.open({
            ciphertext: fromBase64(parsed.ct),
            nonce: fromBase64(parsed.n),
            senderPublicKey: agent.publicKey,
            recipientSecretKey: phone.secretKey,
        });

        expect(plain).not.toBeNull();
        expect(SafeJSON.parse(decode(plain as Uint8Array), { strict: true })).toEqual({
            echoed: "GET /api/system/pulse",
        });
    });

    it("rejects an envelope whose epk is NOT in the paired allowlist (the trust gate)", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();
        const attacker = naclBoxCipher.keyPair();
        let handled = false;
        const shim = createE2eShim({
            cipher: naclBoxCipher,
            agentKeys: agent,
            // only `phone` is paired; the attacker's freshly-minted, validly-sealed envelope must be refused
            resolvePeerKey: (epk) => (epk === toBase64(phone.publicKey) ? phone.publicKey : null),
            handle: async () => {
                handled = true;
                return new Uint8Array();
            },
        });

        const forged = sealRequest({
            plaintext: "GET /api/system/pulse",
            agentPublicKey: agent.publicKey,
            phoneSecretKey: attacker.secretKey,
            phonePublicKey: attacker.publicKey,
        });

        await expect(shim.handleEncrypted(forged)).rejects.toThrow(/not paired/);
        expect(handled).toBe(false);
    });

    it("rejects a paired envelope whose ciphertext fails the auth tag", async () => {
        const agent = naclBoxCipher.keyPair();
        const phone = naclBoxCipher.keyPair();
        const shim = createE2eShim({
            cipher: naclBoxCipher,
            agentKeys: agent,
            resolvePeerKey: (epk) => (epk === toBase64(phone.publicKey) ? phone.publicKey : null),
            handle: async () => new Uint8Array(),
        });

        const nonce = naclBoxCipher.randomNonce();
        const ct = naclBoxCipher.seal({
            plaintext: encode("GET /api/system/pulse"),
            nonce,
            recipientPublicKey: agent.publicKey,
            senderSecretKey: phone.secretKey,
        });
        ct[0] ^= 0xff;
        const tampered = encodeEnvelope({ v: 1, epk: toBase64(phone.publicKey), n: toBase64(nonce), ct: toBase64(ct) });

        await expect(shim.handleEncrypted(tampered)).rejects.toThrow(/auth tag/);
    });
});
