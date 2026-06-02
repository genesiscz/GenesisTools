import { SafeJSON } from "@app/utils/json";

// The E2E wire envelope the vendor relay forwards OPAQUELY (managed tier). The relay
// terminates TLS, so confidentiality lives here, above the transport. `SafeJSON` is
// RN-bundle-safe (its only dep, `comment-json`, is pure JS — no node:/bun:), so this
// leaf stays clean and still obeys the repo's "always SafeJSON" rule.
//
// SECURITY — `epk` is a CLAIMED sender public key, not a trust anchor. Opening a box
// with the epk handed in the request proves only message integrity, NOT sender
// identity (any attacker can mint a keypair and put its public half here). The
// recipient (e2e-shim, Task 10) MUST reject any `epk` that is not in its paired-key
// allowlist BEFORE opening — that allowlist (TOFU from QR pairing) is the trust gate.

export interface E2eEnvelope {
    v: 1;
    /** Claimed sender public key, base64. NOT trusted until checked against the paired allowlist. */
    epk: string;
    /** Nonce, base64 (24 bytes — must be fresh-random per message). */
    n: string;
    /** Ciphertext (crypto_box output, includes the Poly1305 tag), base64. */
    ct: string;
}

export function encodeEnvelope(env: E2eEnvelope): string {
    // strict = native JSON (no comment-preservation). The envelope is machine wire data,
    // and the mobile RN-safe SafeJSON shim implements strict-mode only — keep both sides strict.
    return SafeJSON.stringify(env, { strict: true });
}

export function decodeEnvelope(raw: string): E2eEnvelope {
    const env = SafeJSON.parse(raw, { strict: true }) as E2eEnvelope;

    if (env.v !== 1 || typeof env.epk !== "string" || typeof env.n !== "string" || typeof env.ct !== "string") {
        throw new Error("invalid E2eEnvelope");
    }

    return env;
}
