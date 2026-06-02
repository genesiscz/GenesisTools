// The swap seam for the E2E cipher: `tweetnacl` (D29, pure-JS NaCl) now, a native
// libsodium binding later — same API, no call-site churn. TYPES ONLY: the `nacl`
// impl stays per-platform (`lib/e2e/box.ts` on the Agent, mobile `box-cipher.ts`)
// because each pulls a platform-specific CSPRNG. Keeping the interface in the
// contract is what lets the Agent and mobile share one wire format + test vectors.

export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export interface SealArgs {
    plaintext: Uint8Array;
    nonce: Uint8Array;
    recipientPublicKey: Uint8Array;
    senderSecretKey: Uint8Array;
}

export interface OpenArgs {
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    senderPublicKey: Uint8Array;
    recipientSecretKey: Uint8Array;
}

/** X25519 + XSalsa20-Poly1305 box primitive. `open` returns null on auth failure (tamper / wrong key). */
export interface BoxCipher {
    seal(args: SealArgs): Uint8Array;
    open(args: OpenArgs): Uint8Array | null;
    /** Fresh CSPRNG nonce — MUST be unique per message (24 bytes). Never reuse / never counter-derive. */
    randomNonce(): Uint8Array;
    keyPair(): KeyPair;
}
