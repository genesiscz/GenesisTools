import type { BoxCipher, KeyPair } from "@dd/contract";
import * as SecureStore from "expo-secure-store";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

/**
 * The mobile `BoxCipher` impl. Pure-JS NaCl (`nacl.box` = X25519 + XSalsa20-Poly1305),
 * byte-identical to the Agent's `naclBoxCipher` (`src/dev-dashboard/lib/e2e/box.ts`) — the
 * `box-cipher.test.ts` locks both to the frozen `E2E_TEST_VECTORS` (`@dd/lib/e2e/test-vectors`).
 * D29: pure-JS NaCl, no native module, runs on Hermes.
 */
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

const SECRET_KEY_ITEM = "dd_e2e_secret_key";
const PUBLIC_KEY_ITEM = "dd_e2e_public_key";

/**
 * Loads the device's X25519 keypair from the Secure Enclave/Keystore, generating it on
 * first use. The PRIVATE key never leaves SecureStore — the vendor never sees it
 * (key-custody invariant, D9/D11). Stored WHEN_UNLOCKED_THIS_DEVICE_ONLY.
 */
export async function loadOrCreateDeviceKeys(cipher: BoxCipher = naclBoxCipher): Promise<KeyPair> {
    const storedSecret = await SecureStore.getItemAsync(SECRET_KEY_ITEM);
    const storedPublic = await SecureStore.getItemAsync(PUBLIC_KEY_ITEM);

    if (storedSecret && storedPublic) {
        return { publicKey: fromBase64(storedPublic), secretKey: fromBase64(storedSecret) };
    }

    const kp = cipher.keyPair();
    await SecureStore.setItemAsync(SECRET_KEY_ITEM, toBase64(kp.secretKey), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(PUBLIC_KEY_ITEM, toBase64(kp.publicKey));

    return kp;
}
