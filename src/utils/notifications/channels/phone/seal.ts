import { SafeJSON } from "@genesiscz/utils/json";
import { Storage } from "@genesiscz/utils/storage/storage";
import nacl from "tweetnacl";
import type { PushSecrets, SealedBox } from "../../phone-wire";

/** The Mac's push key pair, base64. The public half goes to every device at registration. */
export interface PushKeyPair {
    publicKey: string;
    secretKey: string;
}

const KEYS_FILE = "phone-push-keys.json";

function base64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64");
}

function bytes(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * The Mac's push key pair, made on first use and kept owner-only (0600) in
 * `~/.genesis-tools/notify/cache/phone-push-keys.json`. It is not the dev-dashboard's E2E key: a push is sealed to a
 * device, whatever tier that device connects over.
 */
export async function loadPushKeys(storage = new Storage("notify")): Promise<PushKeyPair> {
    return storage.atomicUpdate<PushKeyPair>(
        KEYS_FILE,
        (current) => {
            if (current?.publicKey && current.secretKey) {
                return current;
            }

            const pair = nacl.box.keyPair();
            return { publicKey: base64(pair.publicKey), secretKey: base64(pair.secretKey) };
        },
        { mode: 0o600 }
    );
}

/**
 * Seals the answer tokens of one notice to one device (the same NaCl box the dev-dashboard E2E layer uses): Apple and
 * any relay see ciphertext, and only that device's key opens it.
 */
export function sealForDevice(secrets: PushSecrets, devicePublicKey: string, keys: PushKeyPair): SealedBox {
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box(
        new TextEncoder().encode(SafeJSON.stringify(secrets)),
        nonce,
        bytes(devicePublicKey),
        bytes(keys.secretKey)
    );
    return { nonce: base64(nonce), box: base64(box) };
}

/** The device side, here for the round-trip test; the phone has its own copy over tweetnacl. */
export function openOnDevice(sealed: SealedBox, macPublicKey: string, deviceSecretKey: string): PushSecrets | null {
    const opened = nacl.box.open(bytes(sealed.box), bytes(sealed.nonce), bytes(macPublicKey), bytes(deviceSecretKey));
    return opened ? (SafeJSON.parse(new TextDecoder().decode(opened), { strict: true }) as PushSecrets) : null;
}
