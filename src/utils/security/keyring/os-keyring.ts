import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { Entry } from "@napi-rs/keyring";
import { decodeMasterKey, KEYCHAIN_ACCOUNT, keychainService, type MasterKeyProvider } from "./types";

/**
 * The OS keychain is MACHINE-GLOBAL state: it ignores GENESIS_TOOLS_HOME, so a
 * master key stored by any process changes what every later test observes (the
 * secretsToVault migration stops deferring the moment a key is reachable).
 * Under `bun test` (NODE_ENV=test) the rung is therefore unavailable unless
 * RUN_KEYCHAIN=1 opts in; tests that need a key fake the ladder with
 * `_setMasterKeyProvidersForTest`, and CLI smokes in agent runs should set
 * GENESIS_TOOLS_MASTER_KEY instead of writing the real keychain.
 */
function blockedUnderTest(): boolean {
    return env.get("NODE_ENV") === "test" && !env.isFlag("RUN_KEYCHAIN");
}

/**
 * OS keychain rung, via `@napi-rs/keyring` on every platform (macOS Keychain,
 * Windows Credential Manager, Linux Secret Service).
 *
 * Uniform-binary access is the whole point: macOS grants silent reads by CODE
 * SIGNATURE, so the same `bun` that wrote the item reads it back without a GUI
 * prompt, while a different binary (`security`, another app) gets prompted.
 * Mixing in the `security` CLI here would reintroduce exactly that prompt.
 * Verified empirically 2026-07-29: napi write then fresh-process napi read
 * returned in 0.049s with no prompt, while `security find-generic-password` for
 * the same item returned nothing.
 */
class OsKeyring implements MasterKeyProvider {
    readonly id = "keychain" as const;

    async available(): Promise<boolean> {
        if (blockedUnderTest()) {
            return false;
        }

        try {
            this.entry();
            return true;
        } catch (err) {
            logger.debug({ err }, "OS keyring unavailable");
            return false;
        }
    }

    async get(): Promise<Buffer | undefined> {
        return this.getSync();
    }

    getSync(): Buffer | undefined {
        if (blockedUnderTest()) {
            return undefined;
        }

        try {
            return decodeMasterKey(this.entry().getPassword(), "keychain");
        } catch (err) {
            logger.debug({ err }, "no master key in OS keyring");
            return undefined;
        }
    }

    async set(key: Buffer): Promise<void> {
        if (blockedUnderTest()) {
            throw new Error("Refusing to write the real OS keychain under bun test. Set RUN_KEYCHAIN=1 to allow.");
        }

        this.entry().setPassword(key.toString("base64"));
        logger.info({ service: keychainService(), account: KEYCHAIN_ACCOUNT }, "stored vault master key in OS keyring");
    }

    private entry(): Entry {
        return new Entry(keychainService(), KEYCHAIN_ACCOUNT);
    }
}

export const osKeyring: MasterKeyProvider = new OsKeyring();
