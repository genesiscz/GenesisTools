import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";

import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MASTER_KEY_BYTES } from "./keyring/types";
import { invalidateMasterKeyCache, masterKey, masterKeySource, writeMasterKey } from "./MasterKey";
import { decryptEntry, encryptEntry, rotationBackupPath, TAG_BYTES, vaultAdmin } from "./SecretStore";
import type { VaultFile } from "./vault-format";

export { rotationBackupPath };

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
 *
 * The old key is escrowed to a 0600 file for the duration: storing the new key
 * and rewriting the vault cannot be atomic together, and a crash between the
 * two used to destroy the ONLY copy of the old key while the vault still
 * needed it. On success the escrow is deleted; if it survives a crash it is
 * exactly the recovery material. After a COMPLETED rotation the old key can
 * decrypt nothing anyway — but a failure BEFORE the key transition leaves the
 * escrow holding the still-live key, which is why the catch below names the
 * file and when it is safe to delete instead of failing silently.
 */
export async function rotateMasterKey(): Promise<{ rotated: number }> {
    // The env rung is read-only (writeMasterKey skips it) AND outranks every
    // other rung on read. Rotating from it therefore stores the new key on the
    // keychain, where the unchanged variable permanently shadows it, and every
    // re-encrypted entry becomes undecryptable — the exact "vault nothing can
    // read" outcome this function's abort-on-failure logic exists to prevent.
    // Exception: when the rotation escrow exists, the env variable IS the
    // documented recovery path (`describeDecryptFailure` tells the user to
    // export the escrowed key and re-run rotate), so refusing here would make
    // that recovery impossible. The rotation below re-escrows, re-keys and
    // rewrites the vault; the user then unsets the variable as instructed.
    if ((await masterKeySource()) === "env" && !existsSync(rotationBackupPath())) {
        const variable = env.security.getMasterKeyEnvKey();
        throw new Error(
            `The master key currently comes from ${variable}, which cannot be written back to. ` +
                `A rotated key would land on the keychain rung, ${variable} would keep outranking it, and every vault entry would stop decrypting. ` +
                `Unset ${variable} and re-run: the new key is then stored on the keychain (or key file) rung.`
        );
    }

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

        const escrow = rotationBackupPath();
        writeFileSync(escrow, current.toString("base64"), { mode: 0o600 });

        try {
            await writeMasterKey(next);
        } catch (err) {
            // Do NOT delete the escrow here: a key-store failure is
            // indistinguishable from a crash that stored the new key before
            // throwing, and in that case the escrow is the ONLY copy of the key
            // the vault still needs. But a silent leftover is a plaintext copy
            // of a possibly still-live master key, so say all of this loudly.
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Master-key rotation failed while storing the new key (${message}), ` +
                    `and the outgoing key stays escrowed at ${escrow}. ` +
                    "If vault reads still work, the old key is still active: delete that file. " +
                    `If they fail to decrypt, recover with: export ${env.security.getMasterKeyEnvKey()}=$(cat ${escrow}) ` +
                    "then re-run 'tools ai config secret rotate' and delete the file once it succeeds.",
                { cause: err }
            );
        }

        vaultAdmin.write(rotated);
        invalidateMasterKeyCache();

        unlinkSync(escrow);

        if ((await masterKeySource()) === "env") {
            logger.warn(
                `Rotation complete, but ${env.security.getMasterKeyEnvKey()} still outranks the newly stored key. ` +
                    "Unset it now, or every vault read keeps using the OLD key and fails to decrypt."
            );
        }

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

    const tag = Buffer.from(parsed.tag, "base64");
    if (tag.length !== TAG_BYTES) {
        throw new Error(`Vault export has a ${tag.length}-byte auth tag (expected ${TAG_BYTES}); refusing.`);
    }

    // The blob names its own KDF cost, and it arrives from a file the caller
    // chose. `maxmem` bounds MEMORY (node enforces 128*r*N + 128*r*p <= maxmem)
    // but nothing bounds TIME: N=2^14, r=8, p=2^15 fits in ~50 MiB and still
    // costs ~4.3e9 operations, blocking the event loop for minutes inside a
    // synchronous scrypt. Only the parameters we actually write are accepted.
    if (parsed.N !== SCRYPT_N || parsed.r !== SCRYPT_r || parsed.p !== SCRYPT_p) {
        throw new Error(
            `Vault export uses unsupported scrypt parameters (N=${parsed.N}, r=${parsed.r}, p=${parsed.p}); expected N=${SCRYPT_N}, r=${SCRYPT_r}, p=${SCRYPT_p}.`
        );
    }

    const salt = Buffer.from(parsed.salt, "base64");
    const iv = Buffer.from(parsed.iv, "base64");

    if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) {
        throw new Error(
            `Vault export has a ${salt.length}-byte salt and a ${iv.length}-byte IV, expected ${SALT_BYTES} and ${IV_BYTES}.`
        );
    }

    const key = passphraseKey(passphrase, salt, parsed.N, parsed.r, parsed.p);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

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
