import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function defaultKeyPath(): string {
    return process.env.SHOPS_SECRET_KEY_PATH ?? join(homedir(), ".genesis-tools", "shops", ".secret-key");
}

function loadOrCreateKey(): Buffer {
    if (cachedKey) {
        return cachedKey;
    }

    const path = defaultKeyPath();
    if (existsSync(path)) {
        const raw = readFileSync(path);
        if (raw.length !== KEY_BYTES) {
            throw new Error(`Secret key at ${path} has wrong length (${raw.length}); expected ${KEY_BYTES}`);
        }

        cachedKey = raw;
        return cachedKey;
    }

    mkdirSync(dirname(path), { recursive: true });
    const fresh = randomBytes(KEY_BYTES);
    writeFileSync(path, fresh, { mode: 0o600 });
    chmodSync(path, 0o600);
    cachedKey = fresh;
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
