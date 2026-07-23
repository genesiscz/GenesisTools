import { describe, expect, it, mock } from "bun:test";

// `box-cipher.ts` statically imports `expo-secure-store` (native). Stub it so the pure
// tweetnacl path (the wire-compat proof) loads under bun. The vectors use a FIXED nonce, so
// no PRNG seeding is needed here.
mock.module("expo-secure-store", () => ({
    getItemAsync: async () => null,
    setItemAsync: async () => {},
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
}));

const { fromBase64, naclBoxCipher, toBase64 } = await import("@/transport/e2e/box-cipher");
const { E2E_TEST_VECTORS } = await import("@dd/lib/e2e/test-vectors");

describe("mobile naclBoxCipher wire-compat", () => {
    it("produces the shared ciphertext vector (byte-identical to the Agent)", () => {
        const ct = naclBoxCipher.seal({
            plaintext: new TextEncoder().encode(E2E_TEST_VECTORS.plaintext),
            nonce: fromBase64(E2E_TEST_VECTORS.nonce),
            recipientPublicKey: fromBase64(E2E_TEST_VECTORS.bobPublicKey),
            senderSecretKey: fromBase64(E2E_TEST_VECTORS.alicePrivateKey),
        });
        expect(toBase64(ct)).toBe(E2E_TEST_VECTORS.ciphertextBase64);
    });

    it("opens the shared vector back to the plaintext (recipient = bob)", () => {
        const plain = naclBoxCipher.open({
            ciphertext: fromBase64(E2E_TEST_VECTORS.ciphertextBase64),
            nonce: fromBase64(E2E_TEST_VECTORS.nonce),
            senderPublicKey: fromBase64(E2E_TEST_VECTORS.alicePublicKey),
            recipientSecretKey: fromBase64(E2E_TEST_VECTORS.bobPrivateKey),
        });
        expect(plain).not.toBeNull();
        expect(new TextDecoder().decode(plain as Uint8Array)).toBe(E2E_TEST_VECTORS.plaintext);
    });

    it("seal then open round-trips with fresh keys", () => {
        const nonce = naclBoxCipher.randomNonce();
        const alice = naclBoxCipher.keyPair();
        const bob = naclBoxCipher.keyPair();
        const msg = new TextEncoder().encode("hello e2e");
        const ct = naclBoxCipher.seal({
            plaintext: msg,
            nonce,
            recipientPublicKey: bob.publicKey,
            senderSecretKey: alice.secretKey,
        });
        const opened = naclBoxCipher.open({
            ciphertext: ct,
            nonce,
            senderPublicKey: alice.publicKey,
            recipientSecretKey: bob.secretKey,
        });
        expect(opened).not.toBeNull();
        expect(new TextDecoder().decode(opened as Uint8Array)).toBe("hello e2e");
    });

    it("open returns null on a tampered ciphertext", () => {
        const ct = fromBase64(E2E_TEST_VECTORS.ciphertextBase64);
        ct[0] ^= 0xff;
        const opened = naclBoxCipher.open({
            ciphertext: ct,
            nonce: fromBase64(E2E_TEST_VECTORS.nonce),
            senderPublicKey: fromBase64(E2E_TEST_VECTORS.alicePublicKey),
            recipientSecretKey: fromBase64(E2E_TEST_VECTORS.bobPrivateKey),
        });
        expect(opened).toBeNull();
    });
});
