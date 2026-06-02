import { describe, expect, it } from "bun:test";
import { fromBase64, naclBoxCipher, toBase64 } from "@app/dev-dashboard/lib/e2e/box";
import { E2E_TEST_VECTORS as vectors } from "@app/dev-dashboard/lib/e2e/test-vectors";

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

describe("naclBoxCipher", () => {
    it("seal then open round-trips with a fresh keypair", () => {
        const nonce = naclBoxCipher.randomNonce();
        const alice = naclBoxCipher.keyPair();
        const bob = naclBoxCipher.keyPair();
        const ct = naclBoxCipher.seal({
            plaintext: encode("hello e2e"),
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
        expect(decode(opened as Uint8Array)).toBe("hello e2e");
    });

    it("matches the frozen wire vector (byte-identical with mobile)", () => {
        const ct = naclBoxCipher.seal({
            plaintext: encode(vectors.plaintext),
            nonce: fromBase64(vectors.nonce),
            recipientPublicKey: fromBase64(vectors.bobPublicKey),
            senderSecretKey: fromBase64(vectors.alicePrivateKey),
        });

        expect(toBase64(ct)).toBe(vectors.ciphertextBase64);
    });

    it("opens the frozen vector back to the original plaintext", () => {
        const opened = naclBoxCipher.open({
            ciphertext: fromBase64(vectors.ciphertextBase64),
            nonce: fromBase64(vectors.nonce),
            senderPublicKey: fromBase64(vectors.alicePublicKey),
            recipientSecretKey: fromBase64(vectors.bobPrivateKey),
        });

        expect(opened).not.toBeNull();
        expect(decode(opened as Uint8Array)).toBe(vectors.plaintext);
    });

    it("rejects a tampered ciphertext even with the correct keys (Poly1305 MAC)", () => {
        const nonce = naclBoxCipher.randomNonce();
        const alice = naclBoxCipher.keyPair();
        const bob = naclBoxCipher.keyPair();
        const ct = naclBoxCipher.seal({
            plaintext: encode("integrity matters"),
            nonce,
            recipientPublicKey: bob.publicKey,
            senderSecretKey: alice.secretKey,
        });
        ct[0] ^= 0xff;

        const opened = naclBoxCipher.open({
            ciphertext: ct,
            nonce,
            senderPublicKey: alice.publicKey,
            recipientSecretKey: bob.secretKey,
        });

        expect(opened).toBeNull();
    });

    it("rejects a valid ciphertext opened with the WRONG recipient key", () => {
        const nonce = naclBoxCipher.randomNonce();
        const alice = naclBoxCipher.keyPair();
        const bob = naclBoxCipher.keyPair();
        const eve = naclBoxCipher.keyPair();
        const ct = naclBoxCipher.seal({
            plaintext: encode("for bob only"),
            nonce,
            recipientPublicKey: bob.publicKey,
            senderSecretKey: alice.secretKey,
        });

        const opened = naclBoxCipher.open({
            ciphertext: ct,
            nonce,
            senderPublicKey: alice.publicKey,
            recipientSecretKey: eve.secretKey,
        });

        expect(opened).toBeNull();
    });

    it("produces a fresh 24-byte nonce on every call (no reuse)", () => {
        const a = naclBoxCipher.randomNonce();
        const b = naclBoxCipher.randomNonce();

        expect(a.length).toBe(24);
        expect(b.length).toBe(24);
        expect(toBase64(a)).not.toBe(toBase64(b));
    });
});
