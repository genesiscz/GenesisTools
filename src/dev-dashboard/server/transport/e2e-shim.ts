import type { BoxCipher, KeyPair } from "@app/dev-dashboard/lib/e2e/box";
import { fromBase64, toBase64 } from "@app/dev-dashboard/lib/e2e/box";
import { decodeEnvelope, encodeEnvelope } from "@app/dev-dashboard/lib/e2e/envelope";

export interface E2eShimOptions {
    cipher: BoxCipher;
    agentKeys: KeyPair;
    /**
     * Resolve the paired phone's public key from the pairing store, keyed by the
     * claimed `epk`. Returns null if that key is NOT paired — which is the trust
     * gate: an `epk` proves message integrity, not sender identity, so an unpaired
     * key MUST be rejected before we open the box. The returned bytes (== the paired
     * key) are what we open with — never a key the request could otherwise inject.
     */
    resolvePeerKey: (peerPublicKeyB64: string) => Uint8Array | null;
    /** Run the decrypted request through the real route registry; returns the plaintext result bytes. */
    handle: (plaintext: Uint8Array) => Promise<Uint8Array>;
}

export interface E2eShim {
    /** Decrypt an inbound envelope, run the handler, return an encrypted response envelope. */
    handleEncrypted(rawEnvelope: string): Promise<string>;
}

export function createE2eShim(opts: E2eShimOptions): E2eShim {
    return {
        async handleEncrypted(rawEnvelope: string): Promise<string> {
            const env = decodeEnvelope(rawEnvelope);
            const peerKey = opts.resolvePeerKey(env.epk);

            if (!peerKey) {
                throw new Error("e2e: unknown peer public key (not paired)");
            }

            const plaintext = opts.cipher.open({
                ciphertext: fromBase64(env.ct),
                nonce: fromBase64(env.n),
                senderPublicKey: peerKey,
                recipientSecretKey: opts.agentKeys.secretKey,
            });

            if (!plaintext) {
                throw new Error("e2e: request decryption failed (auth tag mismatch)");
            }

            const resultBytes = await opts.handle(plaintext);
            const nonce = opts.cipher.randomNonce();
            const ct = opts.cipher.seal({
                plaintext: resultBytes,
                nonce,
                recipientPublicKey: peerKey,
                senderSecretKey: opts.agentKeys.secretKey,
            });

            return encodeEnvelope({
                v: 1,
                epk: toBase64(opts.agentKeys.publicKey),
                n: toBase64(nonce),
                ct: toBase64(ct),
            });
        },
    };
}
