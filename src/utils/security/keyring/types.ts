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
 * True inside any test process, by two independent signals so a single hole
 * (an unset variable, a bypassed wrapper) never exposes the real keychain:
 *
 * - NODE_ENV=test — `bun test` sets it when unset and `scripts/test.ts`
 *   forces it (inherited by subprocesses tests spawn);
 * - `Bun.main` naming a test file — the runner's entrypoint IS the test file,
 *   and bun itself refuses to collect files without the .test/.spec infix, so
 *   the pattern holds even when a caller exported NODE_ENV=production. A false
 *   positive (`bun run foo.test.ts`) fails SAFE: it blocks the keychain.
 */
export function isTestProcess(): boolean {
    if (env.get("NODE_ENV") === "test") {
        return true;
    }

    return /\.(test|spec)\.[cm]?[jt]sx?$/.test(globalThis.Bun?.main ?? "");
}

/**
 * Effective keychain service name. In a test process this diverges to a
 * sandboxed item name, so even a test that reaches the keyring API — the
 * availability gate deleted, RUN_KEYCHAIN=1 set, whatever — reads and writes
 * a throwaway `genesis-tools-test` item and can never touch the real master
 * key. Deliberately an independent mechanism next to the os-keyring rung's
 * under-test block, the @napi-rs/keyring preload mock and the non-interactive
 * write barrier: any one alone is sufficient.
 */
export function keychainService(): string {
    return isTestProcess() ? `${KEYCHAIN_SERVICE}-test` : KEYCHAIN_SERVICE;
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
