import { env } from "@genesiscz/utils/env";

export type MasterKeySource = "keychain" | "env" | "file";

export interface MasterKeyProvider {
    readonly id: MasterKeySource;
    /** Whether this rung can be used at all in the current environment. */
    available(): Promise<boolean>;
    get(): Promise<Buffer | undefined>;
    set(key: Buffer): Promise<void>;
    /**
     * Synchronous read, when the rung supports one. Every current rung does
     * (keyring reads, file reads and env reads are all sync underneath), and
     * this is what lets sync credential accessors keep working after their
     * values move into the vault.
     */
    getSync?(): Buffer | undefined;
}

/** Service/account pair for the OS keychain entry holding the vault master key. */
export const KEYCHAIN_SERVICE = "genesis-tools";
export const KEYCHAIN_ACCOUNT = "master-key";

/**
 * Effective keychain service name. Under a test process (NODE_ENV=test, which
 * `bun test` sets and `scripts/test.ts` forces) this diverges to a sandboxed
 * item name, so even a test that reaches the keyring API — the availability
 * gate deleted, RUN_KEYCHAIN=1 set, whatever — reads and writes a throwaway
 * `genesis-tools-test` item and can never touch the real master key. This is
 * deliberately a SECOND, independent mechanism next to the os-keyring rung's
 * under-test block and the @napi-rs/keyring preload mock: any one of the three
 * alone is sufficient.
 */
export function keychainService(): string {
    return env.get("NODE_ENV") === "test" ? `${KEYCHAIN_SERVICE}-test` : KEYCHAIN_SERVICE;
}

export const MASTER_KEY_BYTES = 32;

export function decodeMasterKey(encoded: string | undefined | null, source: MasterKeySource): Buffer | undefined {
    if (!encoded) {
        return undefined;
    }

    const key = Buffer.from(encoded.trim(), "base64");
    if (key.length !== MASTER_KEY_BYTES) {
        throw new Error(
            `Master key from ${source} is ${key.length} bytes, expected ${MASTER_KEY_BYTES} (base64 of 32 random bytes).`
        );
    }

    return key;
}
