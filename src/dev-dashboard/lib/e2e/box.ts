import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BoxCipher, KeyPair } from "@app/dev-dashboard/contract/box-types";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

export type { BoxCipher, KeyPair } from "@app/dev-dashboard/contract/box-types";

// The `tweetnacl` impl behind the `BoxCipher` seam (D29). X25519 + XSalsa20-Poly1305.
// A native libsodium binding can replace this one file later without touching callers.
export const naclBoxCipher: BoxCipher = {
    seal: ({ plaintext, nonce, recipientPublicKey, senderSecretKey }) =>
        nacl.box(plaintext, nonce, recipientPublicKey, senderSecretKey),
    open: ({ ciphertext, nonce, senderPublicKey, recipientSecretKey }) =>
        nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey),
    randomNonce: () => nacl.randomBytes(nacl.box.nonceLength),
    keyPair: () => {
        const kp = nacl.box.keyPair();
        return { publicKey: kp.publicKey, secretKey: kp.secretKey };
    },
};

export const toBase64 = naclUtil.encodeBase64;
export const fromBase64 = naclUtil.decodeBase64;

const DEFAULT_KEY_PATH = join(homedir(), ".genesis-tools", "dev-dashboard", "e2e-keys.json");

interface StoredKeys {
    publicKey: string;
    secretKey: string;
}

/**
 * Load the Agent's long-term X25519 keypair, generating + persisting it (0600) on first use.
 * The secret key never leaves this machine — it is the Agent half of the E2E key custody
 * (the phone holds its own; the vendor relay sees neither). `keyPath` is injectable for tests.
 */
export async function loadOrCreateAgentKeys(
    cipher: BoxCipher = naclBoxCipher,
    keyPath: string = DEFAULT_KEY_PATH
): Promise<KeyPair> {
    const file = Bun.file(keyPath);

    if (await file.exists()) {
        const stored = SafeJSON.parse(await file.text(), { strict: true }) as StoredKeys;
        return { publicKey: fromBase64(stored.publicKey), secretKey: fromBase64(stored.secretKey) };
    }

    const kp = cipher.keyPair();
    const serialized = SafeJSON.stringify({
        publicKey: toBase64(kp.publicKey),
        secretKey: toBase64(kp.secretKey),
    } satisfies StoredKeys);
    await Bun.write(keyPath, serialized);
    chmodSync(keyPath, 0o600);
    logger.info({ path: keyPath }, "dev-dashboard: generated Agent E2E keypair (0600)");

    return kp;
}
