import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, Storage } from "@genesiscz/utils/storage/storage";
import { masterKey } from "./MasterKey";
import { isSecretPath, isSecureRef, type MaybeSecret, secureRef, type SecureRef } from "./SecureRef";
import { emptyVault, VAULT_HKDF_SALT, VAULT_VERSION, type VaultEntry, type VaultFile } from "./vault-format";

const KEY_BYTES = 32;
const IV_BYTES = 12;

export interface SecretStore {
    get(path: string): Promise<string | undefined>;
    set(path: string, value: string): Promise<SecureRef>;
    delete(path: string): Promise<boolean>;
    list(prefix?: string): Promise<string[]>;
    has(path: string): Promise<boolean>;
}

/**
 * Per-entry key derived from the master key with the entry path as HKDF info,
 * and the same path bound as GCM additional data. Both together mean a
 * ciphertext copied from one entry to another fails to decrypt, so an attacker
 * with write access to the vault file cannot swap one account's key into
 * another account's slot.
 */
function entryKey(master: Buffer, path: string): Buffer {
    return Buffer.from(hkdfSync("sha256", master, Buffer.from(VAULT_HKDF_SALT), Buffer.from(path), KEY_BYTES));
}

class FileSecretStore implements SecretStore {
    private readonly storage = new Storage("security");

    private vaultPath(): string {
        return `${this.storage.getBaseDir()}/vault.json`;
    }

    private read(): VaultFile {
        const path = this.vaultPath();
        if (!existsSync(path)) {
            return emptyVault();
        }

        const parsed: VaultFile = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        if (!parsed || typeof parsed !== "object" || !parsed.entries) {
            throw new Error(`Vault at ${path} is unreadable. Restore it from a backup or re-import an export.`);
        }

        if (parsed.version !== VAULT_VERSION) {
            throw new Error(`Vault version ${parsed.version} is not supported by this build (expected ${VAULT_VERSION}).`);
        }

        return parsed;
    }

    private write(vault: VaultFile): void {
        const path = this.vaultPath();
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        atomicWriteFileSync(path, SafeJSON.stringify(vault, null, 2));
        // atomicWriteFileSync has no mode option and lands 0644, so tighten after
        // the rename. Only ciphertext is ever exposed in that window, and the
        // containing directory is already 0700.
        chmodSync(path, 0o600);
    }

    async get(path: string): Promise<string | undefined> {
        const entry = this.read().entries[path];
        if (!entry) {
            return undefined;
        }

        const key = entryKey(await masterKey(), path);
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"));
        decipher.setAAD(Buffer.from(path, "utf8"));
        decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
        const plain = Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]);
        return plain.toString("utf8");
    }

    async set(path: string, value: string): Promise<SecureRef> {
        const ref = secureRef(path);
        const key = entryKey(await masterKey(), path);
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(Buffer.from(path, "utf8"));
        const ct = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
        const entry: VaultEntry = {
            iv: iv.toString("base64"),
            ct: ct.toString("base64"),
            tag: cipher.getAuthTag().toString("base64"),
            updatedAt: Date.now(),
        };

        await this.storage.withFileLock({
            file: this.vaultPath(),
            fn: async () => {
                const vault = this.read();
                vault.entries[path] = entry;
                this.write(vault);
            },
        });

        logger.debug({ path }, "stored secret in vault");
        return ref;
    }

    async delete(path: string): Promise<boolean> {
        return this.storage.withFileLock({
            file: this.vaultPath(),
            fn: async () => {
                const vault = this.read();
                if (!vault.entries[path]) {
                    return false;
                }

                delete vault.entries[path];
                this.write(vault);
                logger.debug({ path }, "deleted secret from vault");
                return true;
            },
        });
    }

    async list(prefix?: string): Promise<string[]> {
        const paths = Object.keys(this.read().entries).sort();
        if (!prefix) {
            return paths;
        }

        return paths.filter((p) => p.startsWith(prefix));
    }

    async has(path: string): Promise<boolean> {
        return this.read().entries[path] !== undefined;
    }
}

let instance: SecretStore | null = null;

export async function secrets(): Promise<SecretStore> {
    if (!instance) {
        instance = new FileSecretStore();
    }

    return instance;
}

export function _resetSecretsForTest(): void {
    instance = null;
}

/** Resolve a config field that may be a literal or a vault pointer. */
export async function resolveSecret(value: MaybeSecret | undefined): Promise<string | undefined> {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value === "string") {
        return value;
    }

    if (!isSecureRef(value)) {
        logger.warn({ value }, "ignoring malformed secure reference");
        return undefined;
    }

    const store = await secrets();
    return store.get(value.path);
}

const SECRET_KEY_PATTERN = /^(apiKey|accessToken|refreshToken|longLivedToken|password|secret|token|key)$/i;
const REDACTED = "•••";

/**
 * Deep copy with secret-looking values masked, for config dumps and logs.
 * SecureRefs are left intact: a vault path is not sensitive, and seeing it is
 * how a user learns where a credential actually lives.
 */
export function redactSecrets<T>(value: T): T {
    return redactValue(value, undefined) as T;
}

function redactValue(value: unknown, keyName: string | undefined): unknown {
    if (Array.isArray(value)) {
        return value.map((item) => redactValue(item, keyName));
    }

    if (value && typeof value === "object") {
        if (isSecureRef(value)) {
            return { ...value };
        }

        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = redactValue(v, k);
        }

        return out;
    }

    if (typeof value === "string" && keyName && SECRET_KEY_PATTERN.test(keyName) && value.length > 0) {
        return REDACTED;
    }

    return value;
}

export { isSecretPath, isSecureRef, secureRef };
export type { MaybeSecret, SecureRef };
