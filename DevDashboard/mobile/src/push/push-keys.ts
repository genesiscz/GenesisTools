import type { PushSecrets, SealedBox } from "@dd/contract";
import { SafeJSON } from "@genesiscz/utils/json";
import * as SecureStore from "expo-secure-store";
import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

/**
 * The push identity of this install: a stable id and a box key pair the Mac seals answer tokens to. Kept apart from the
 * E2E keys on purpose: those are readable only while the phone is unlocked, and a lock-screen answer runs while it is
 * locked, so these are readable after the first unlock since boot.
 */
interface PushIdentity {
    id: string;
    publicKey: string;
    secretKey: string;
    /** The Mac's push public key, from the last registration. */
    macPublicKey?: string;
    /** Verification keys are owned by the saved connection that registered them. */
    macPublicKeys?: Record<string, string>;
}

const ITEM = "dd_push_identity";
const ACCESS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

let identity: Promise<PushIdentity> | null = null;

async function load(): Promise<PushIdentity> {
    const stored = await SecureStore.getItemAsync(ITEM, ACCESS);

    if (stored) {
        return SafeJSON.parse(stored, { strict: true }) as PushIdentity;
    }

    const pair = nacl.box.keyPair();
    const created: PushIdentity = {
        id: naclUtil.encodeBase64(nacl.randomBytes(18)).replace(/[+/=]/g, ""),
        publicKey: naclUtil.encodeBase64(pair.publicKey),
        secretKey: naclUtil.encodeBase64(pair.secretKey),
    };
    await SecureStore.setItemAsync(ITEM, SafeJSON.stringify(created), ACCESS);
    return created;
}

/** The identity, made once; a failed read clears the memo so the next call retries. */
export function pushIdentity(): Promise<PushIdentity> {
    identity ??= load().catch((err: unknown) => {
        identity = null;
        throw err;
    });
    return identity;
}

let keyWrites: Promise<void> = Promise.resolve();

export function rememberMacKey(macPublicKey: string, connectionId: string): Promise<void> {
    const write = async () => {
        const current = await pushIdentity();
        const next = { ...current, macPublicKeys: { ...current.macPublicKeys, [connectionId]: macPublicKey } };
        await SecureStore.setItemAsync(ITEM, SafeJSON.stringify(next), ACCESS);
        identity = Promise.resolve(next);
    };
    keyWrites = keyWrites.then(write, write);
    return keyWrites;
}

export type OpenedPush = PushSecrets & { connectionId: string };

/** An unowned legacy key is never guessed to belong to the active connection. */
export async function openSealed(sealed: SealedBox): Promise<OpenedPush | null> {
    const { secretKey, macPublicKeys } = await pushIdentity();
    for (const [connectionId, macPublicKey] of Object.entries(macPublicKeys ?? {})) {
        const opened = nacl.box.open(
            naclUtil.decodeBase64(sealed.box), naclUtil.decodeBase64(sealed.nonce),
            naclUtil.decodeBase64(macPublicKey), naclUtil.decodeBase64(secretKey)
        );
        if (opened) {
            return { ...(SafeJSON.parse(naclUtil.encodeUTF8(opened), { strict: true }) as PushSecrets), connectionId };
        }
    }
    return null;
}
