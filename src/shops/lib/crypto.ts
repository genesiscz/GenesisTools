import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync } from "node:fs";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/atomic-file";

import { genesisToolsDir } from "@genesiscz/utils/storage/root";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function defaultKeyPath(): string {
    return env.shops.getSecretKeyPath() ?? genesisToolsDir("shops", ".secret-key");
}

function readKey(path: string): Buffer {
    const raw = readFileSync(path);
    if (raw.length !== KEY_BYTES) {
        throw new Error(`Secret key at ${path} has wrong length (${raw.length}); expected ${KEY_BYTES}`);
    }

    return raw;
}

function isEexist(err: unknown): boolean {
    return err instanceof Error && "code" in err && err.code === "EEXIST";
}

/**
 * Create the key so that no process ever sees a short key or a second key. The full key is written and
 * fsync'd under a temp name first, then hard-linked to the real name: `link` never replaces an existing
 * file, so when a concurrent first run got there first it fails with EEXIST and that run's key is kept.
 */
function createKeyFile(path: string): void {
    const tmp = `${path}.${process.pid}.${Date.now()}.new`;
    atomicWriteFileSync(tmp, randomBytes(KEY_BYTES), { mode: 0o600 });

    try {
        linkSync(tmp, path);
        logger.info({ path }, "shops: created the credentials key");
    } catch (err) {
        if (!isEexist(err)) {
            throw err;
        }

        logger.debug({ path }, "shops: another run created the credentials key first; using that one");
    } finally {
        try {
            unlinkSync(tmp);
        } catch (cleanupErr) {
            logger.debug({ err: cleanupErr, tmp }, "shops: could not remove the temp key name");
        }
    }
}

function loadOrCreateKey(): Buffer {
    if (cachedKey) {
        return cachedKey;
    }

    const path = defaultKeyPath();

    if (!existsSync(path)) {
        createKeyFile(path);
    }

    cachedKey = readKey(path);
    return cachedKey;
}

export function encryptCredentials(plaintext: string): string {
    const key = loadOrCreateKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptCredentials(blob: string): string {
    const key = loadOrCreateKey();
    const buf = Buffer.from(blob, "base64");
    if (buf.length < IV_BYTES + TAG_BYTES) {
        throw new Error("Ciphertext too short");
    }

    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

export function resetCryptoForTest(): void {
    cachedKey = null;
}
