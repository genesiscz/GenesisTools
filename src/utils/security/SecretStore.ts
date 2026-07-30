import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync, Storage } from "@genesiscz/utils/storage/storage";
import { masterKey, masterKeySync } from "./MasterKey";
import { isSecretPath, isSecureRef, type MaybeSecret, type SecureRef, secureRef } from "./SecureRef";
import { emptyVault, VAULT_HKDF_SALT, VAULT_VERSION, type VaultEntry, type VaultFile } from "./vault-format";

const KEY_BYTES = 32;
const IV_BYTES = 12;
export const TAG_BYTES = 16;

export interface SecretStore {
    get(path: string): Promise<string | undefined>;
    /** Sync read for callers whose signature cannot become async. */
    getSync(path: string): string | undefined;
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
export function entryKey(master: Buffer, path: string): Buffer {
    return Buffer.from(hkdfSync("sha256", master, Buffer.from(VAULT_HKDF_SALT), Buffer.from(path), KEY_BYTES));
}

export function encryptEntry(master: Buffer, path: string, value: string): VaultEntry {
    const key = entryKey(master, path);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(path, "utf8"));
    const ct = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);

    return {
        iv: iv.toString("base64"),
        ct: ct.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        updatedAt: Date.now(),
    };
}

export function decryptEntry(master: Buffer, path: string, entry: VaultEntry): string {
    const tag = Buffer.from(entry.tag, "base64");

    // Node's GCM decipher accepts NIST-truncated tags (down to 32 bits) when no
    // authTagLength is pinned, which would let an attacker with write access to
    // the vault file shrink the forgery space from 2^128 to 2^32. Every tag this
    // store ever wrote is 16 bytes, so anything else is tampering.
    if (tag.length !== TAG_BYTES) {
        throw new Error(`Vault entry "${path}" has a ${tag.length}-byte auth tag (expected ${TAG_BYTES}); refusing.`);
    }

    const decipher = createDecipheriv("aes-256-gcm", entryKey(master, path), Buffer.from(entry.iv, "base64"));
    decipher.setAAD(Buffer.from(path, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(entry.ct, "base64")), decipher.final()]).toString("utf8");
}

class FileSecretStore implements SecretStore {
    private readonly storage = new Storage("security");

    private vaultPath(): string {
        return `${this.storage.getBaseDir()}/vault.json`;
    }

    vaultFilePath(): string {
        return this.vaultPath();
    }

    readVault(): VaultFile {
        return this.read();
    }

    writeVault(vault: VaultFile): void {
        this.write(vault);
    }

    lockVault<T>(fn: () => Promise<T>): Promise<T> {
        return this.storage.withFileLock({ file: this.vaultPath(), fn });
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
            throw new Error(
                `Vault version ${parsed.version} is not supported by this build (expected ${VAULT_VERSION}).`
            );
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

        return decryptEntry(await masterKey(), path, entry);
    }

    getSync(path: string): string | undefined {
        const entry = this.read().entries[path];
        if (!entry) {
            return undefined;
        }

        const key = masterKeySync();
        if (!key) {
            logger.warn({ path }, "vault secret needs the master key but no rung could supply it synchronously");
            return undefined;
        }

        return decryptEntry(key, path, entry);
    }

    async set(path: string, value: string): Promise<SecureRef> {
        const ref = secureRef(path);
        const entry = encryptEntry(await masterKey(), path, value);

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

/**
 * Raw vault access for administrative operations (rotation, export, import).
 * Kept internal to this module's exports so ordinary callers can only reach
 * secrets through the get/set API, which always goes through the master key.
 */
export const vaultAdmin = {
    path(): string {
        return new FileSecretStore().vaultFilePath();
    },
    read(): VaultFile {
        return new FileSecretStore().readVault();
    },
    async withLock<T>(fn: () => Promise<T>): Promise<T> {
        const store = new FileSecretStore();
        return store.lockVault(fn);
    },
    write(vault: VaultFile): void {
        new FileSecretStore().writeVault(vault);
    },
};

let instance: FileSecretStore | null = null;

/**
 * Store bound to the CURRENT vault path. Memoised, but rebinds when the
 * resolved path changes (GENESIS_TOOLS_HOME moves between tests): a singleton
 * pinned to the first home of the process made migrations write one home's
 * vault while sync reads consulted another's, which read back as "entry
 * missing" rather than any error.
 */
function fileStore(): FileSecretStore {
    const fresh = new FileSecretStore();

    if (!instance || instance.vaultFilePath() !== fresh.vaultFilePath()) {
        instance = fresh;
    }

    return instance;
}

export async function secrets(): Promise<SecretStore> {
    return fileStore();
}

export function _resetSecretsForTest(): void {
    instance = null;
}

/** Resolve a config field that may be a literal or a vault pointer. */
export function resolveSecretSync(value: MaybeSecret | undefined): string | undefined {
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

    return fileStore().getSync(value.path);
}

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

export type { MaybeSecret, SecureRef };
export { isSecretPath, isSecureRef, secureRef };
