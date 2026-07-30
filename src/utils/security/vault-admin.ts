import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MASTER_KEY_BYTES } from "./keyring/types";
import { invalidateMasterKeyCache, masterKey, writeMasterKey } from "./MasterKey";
import { decryptEntry, encryptEntry, vaultAdmin } from "./SecretStore";
import type { VaultFile } from "./vault-format";

const EXPORT_VERSION = 1;
const SCRYPT_N = 2 ** 15;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface VaultExportBlob {
    version: number;
    kdf: "scrypt";
    N: number;
    r: number;
    p: number;
    salt: string;
    iv: string;
    ct: string;
    tag: string;
}

function passphraseKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Buffer {
    return scryptSync(passphrase, salt, MASTER_KEY_BYTES, { N, r, p, maxmem: 512 * 1024 * 1024 });
}

/**
 * Re-encrypt every entry under a freshly generated master key, then store the
 * new key. Aborts before writing anything if a single entry fails to decrypt,
 * because a partial rotation would leave a vault whose entries need two
 * different keys, which nothing can read.
 */
export async function rotateMasterKey(): Promise<{ rotated: number }> {
    const current = await masterKey();

    return vaultAdmin.withLock(async () => {
        const vault = vaultAdmin.read();
        const paths = Object.keys(vault.entries);
        const plaintext = new Map<string, string>();

        for (const path of paths) {
            plaintext.set(path, decryptEntry(current, path, vault.entries[path]));
        }

        const next = randomBytes(MASTER_KEY_BYTES);
        const rotated: VaultFile = { ...vault, entries: {} };
        for (const [path, value] of plaintext) {
            rotated.entries[path] = encryptEntry(next, path, value);
        }

        await writeMasterKey(next);
        vaultAdmin.write(rotated);
        invalidateMasterKeyCache();
        logger.info({ entries: paths.length }, "rotated vault master key");
        return { rotated: paths.length };
    });
}

/**
 * Passphrase-protected copy of every secret. This is the answer to "the
 * keychain entry is gone", which is otherwise unrecoverable, so it exists from
 * day one rather than as a later convenience.
 */
export async function exportVault(passphrase: string): Promise<string> {
    if (passphrase.length < 8) {
        throw new Error("Export passphrase must be at least 8 characters.");
    }

    const key = await masterKey();
    const vault = vaultAdmin.read();
    const secrets: Record<string, string> = {};
    for (const path of Object.keys(vault.entries)) {
        secrets[path] = decryptEntry(key, path, vault.entries[path]);
    }

    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", passphraseKey(passphrase, salt, SCRYPT_N, SCRYPT_r, SCRYPT_p), iv);
    const ct = Buffer.concat([
        cipher.update(Buffer.from(SafeJSON.stringify({ exportedAt: Date.now(), secrets }), "utf8")),
        cipher.final(),
    ]);

    const blob: VaultExportBlob = {
        version: EXPORT_VERSION,
        kdf: "scrypt",
        N: SCRYPT_N,
        r: SCRYPT_r,
        p: SCRYPT_p,
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        ct: ct.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
    };

    logger.info({ entries: Object.keys(secrets).length }, "exported vault");
    return SafeJSON.stringify(blob, null, 2);
}

/**
 * Restore an export into the current vault, re-encrypting under whatever master
 * key this machine has. Existing entries with the same path are overwritten.
 */
export async function importVault(blob: string, passphrase: string): Promise<{ imported: number }> {
    const parsed: VaultExportBlob = SafeJSON.parse(blob, { strict: true });
    if (!parsed || parsed.version !== EXPORT_VERSION || parsed.kdf !== "scrypt") {
        throw new Error("Unrecognised vault export. Expected a version 1 scrypt blob.");
    }

    const key = passphraseKey(passphrase, Buffer.from(parsed.salt, "base64"), parsed.N, parsed.r, parsed.p);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));

    let payload: { exportedAt: number; secrets: Record<string, string> };
    try {
        const plain = Buffer.concat([decipher.update(Buffer.from(parsed.ct, "base64")), decipher.final()]);
        payload = SafeJSON.parse(plain.toString("utf8"), { strict: true });
    } catch (err) {
        logger.debug({ err }, "vault import failed to decrypt");
        throw new Error("Wrong passphrase, or the export is corrupt.");
    }

    const master = await masterKey();

    return vaultAdmin.withLock(async () => {
        const vault = vaultAdmin.read();
        for (const [path, value] of Object.entries(payload.secrets)) {
            vault.entries[path] = encryptEntry(master, path, value);
        }

        vaultAdmin.write(vault);
        const imported = Object.keys(payload.secrets).length;
        logger.info({ imported }, "imported vault export");
        return { imported };
    });
}
